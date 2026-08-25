import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import type { Express, Request } from 'express';
import { Server as SocketServer, type Socket } from 'socket.io';
import { z, ZodError } from 'zod';
import { AppError } from './errors.js';
import { config } from './config.js';
import { optionalAuth, requireFinePermission } from './middleware.js';
import { hasFinePermission } from './permissions.js';
import { rateLimit } from './rate-limit.js';
import { ACCESS_COOKIE, verifyToken } from './security.js';
import type { LiveChatDb } from './live-chat-db.js';
import type { Store, SupportMessage, SupportTicket, User } from './store.js';

const CHAT_ADMIN_ROOM = 'support:admins';
const roomName = (sessionId: string) => `chat:${sessionId}`;
const now = () => new Date().toISOString();

const sessionInput = z.object({
  name: z.string().trim().min(2).max(120),
  mobile: z.string().trim().max(40).default(''),
  email: z.string().trim().email().or(z.literal('')).default(''),
  subject: z.string().trim().min(2).max(180)
}).refine(input => Boolean(input.mobile || input.email), { message: 'Enter a phone number or email address', path: ['mobile'] });
const messageInput = z.object({ message: z.string().trim().min(1).max(4000) });
const roomInput = z.object({ sessionId: z.string().uuid(), token: z.string().min(32).max(256).optional() });

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  try { return schema.parse(value); }
  catch (error) {
    if (error instanceof ZodError) throw new AppError(400, 'VALIDATION_ERROR', 'Please check the submitted fields', error.flatten());
    throw error;
  }
}

export function hashChatToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function verifyChatToken(token: string, expectedHash: string | undefined): boolean {
  if (!token || !expectedHash) return false;
  const actual = Buffer.from(hashChatToken(token), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function publicTicket(ticket: SupportTicket) {
  const { chatAccessHash: _secret, ...safe } = ticket;
  return safe;
}

function readCookies(header = ''): Record<string, string> {
  return Object.fromEntries(header.split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const index = part.indexOf('=');
    const key = index >= 0 ? part.slice(0, index) : part;
    const raw = index >= 0 ? part.slice(index + 1) : '';
    try { return [key, decodeURIComponent(raw)]; } catch { return [key, raw]; }
  }));
}

function chatTokenFromRequest(req: Request): string {
  return String(req.header('x-chat-token') || req.query.token || '');
}

function socketError(error: unknown) {
  if (error instanceof AppError) return { code: error.code, message: error.message };
  return { code: 'CHAT_ERROR', message: 'Unable to complete the chat request' };
}

function acknowledge(callback: unknown, payload: unknown) {
  if (typeof callback === 'function') callback(payload);
}

export class LiveChatHub {
  private io?: SocketServer;
  private sessionWatcher?: () => void;
  private sessionWatchActive = false;
  private messageWatches = new Map<string, { stop: () => void; refs: number }>();
  private visitorCounts = new Map<string, number>();

  constructor(private readonly store: Store, private readonly db: LiveChatDb) {}

  attach(server: HttpServer) {
    if (this.io) return this.io;
    this.io = new SocketServer(server, {
      path: '/socket.io',
      serveClient: true,
      maxHttpBufferSize: 64 * 1024,
      pingInterval: 25_000,
      pingTimeout: 20_000,
      cors: {
        origin: (origin, callback) => {
          if (!origin || config.corsOrigins.includes(origin) || /^https:\/\/[^/]+\.e2b\.app$/i.test(origin)) return callback(null, true);
          callback(new Error('Origin is not allowed'));
        },
        credentials: true,
        methods: ['GET', 'POST']
      }
    });
    this.io.on('connection', socket => this.bindSocket(socket));
    if (this.db.backend === 'firebase-realtime-db') {
      // Realtime Database is the event source: every conversation change made
      // anywhere (this process, another instance, the Firebase console) is
      // relayed to connected admin sockets. If the database cannot be reached
      // yet, the app keeps serving and the explicit broadcasts below take over.
      try {
        this.sessionWatcher = this.db.watchSessions((session, event, previous) => {
          if (!this.io) return;
          if (event === 'created') {
            this.io.to(CHAT_ADMIN_ROOM).emit('conversation_created', publicTicket(session));
            return;
          }
          if (event === 'removed') {
            this.io.to(CHAT_ADMIN_ROOM).emit('conversation_updated', { id: session.id, deleted: true });
            return;
          }
          // The explicit emit paths only fire on unread/status/assignment changes, so
          // mirror those and skip cosmetic updates (e.g. visitor read receipts).
          const meaningful = (previous?.adminUnread ?? 0) !== (session.adminUnread ?? 0)
            || (previous?.status ?? 'open') !== session.status
            || (previous?.assignedTo ?? null) !== (session.assignedTo ?? null);
          if (meaningful) this.io.to(CHAT_ADMIN_ROOM).emit('conversation_updated', publicTicket(session));
        });
        this.sessionWatchActive = true;
        console.log('Live chat storage: Firebase Realtime Database');
      } catch (error) {
        console.error('live-chat Realtime Database subscription failed; inbox updates fall back to explicit broadcasts', error);
      }
    } else {
      console.log('Live chat storage: MongoDB (Firebase Realtime Database not configured)');
    }
    return this.io;
  }

  /**
   * Explicit inbox broadcast. While the Realtime Database session watcher is
   * live it already relays every conversation change, so this is a no-op to
   * avoid duplicate toasts/sounds; otherwise (MongoDB mode, or a database that
   * is temporarily unreachable) the explicit broadcast is the inbox's source.
   */
  emitInbox(ticket: SupportTicket, event: 'conversation_created' | 'conversation_updated' = 'conversation_updated') {
    if (this.sessionWatchActive) return;
    this.io?.to(CHAT_ADMIN_ROOM).emit(event, publicTicket(ticket));
  }

  emitMessage(ticketId: string, message: SupportMessage) {
    this.io?.to(roomName(ticketId)).emit('chat_message', message);
  }

  /** Reference-counted per-conversation Realtime Database subscriptions. */
  private ensureMessageWatch(ticketId: string) {
    const existing = this.messageWatches.get(ticketId);
    if (existing) {
      existing.refs += 1;
      return;
    }
    const stop = this.db.watchMessages(ticketId, message => this.io?.to(roomName(ticketId)).emit('chat_message', message));
    this.messageWatches.set(ticketId, { stop, refs: 1 });
  }

  private releaseMessageWatch(ticketId: string) {
    const entry = this.messageWatches.get(ticketId);
    if (!entry) return;
    entry.refs -= 1;
    if (entry.refs <= 0) {
      entry.stop();
      this.messageWatches.delete(ticketId);
    }
  }

  private trackChatRoom(socket: Socket, ticketId: string) {
    const rooms = new Set(socket.data.chatRooms as Set<string> | undefined);
    rooms.add(ticketId);
    socket.data.chatRooms = rooms;
    this.ensureMessageWatch(ticketId);
  }

  /** Visitor presence counts per conversation; persisted to Realtime Database in Firebase mode. */
  private async noteVisitorPresence(sessionId: string, online: boolean) {
    const next = Math.max(0, (this.visitorCounts.get(sessionId) || 0) + (online ? 1 : -1));
    if (next === 0) this.visitorCounts.delete(sessionId);
    else this.visitorCounts.set(sessionId, next);
    try {
      await this.db.setPresence(sessionId, next > 0);
    } catch (error) {
      console.error('live-chat presence update failed', error instanceof Error ? error : undefined);
    }
  }

  private async withAssigneeName(ticket: SupportTicket): Promise<SupportTicket> {
    if (!ticket.assignedTo || ticket.assignedToName) return ticket;
    const user = await this.store.findUserById(ticket.assignedTo);
    return user ? { ...ticket, assignedToName: user.fullName } : ticket;
  }

  private async authenticateAdmin(socket: Socket, permission: 'support.view' | 'support.reply'): Promise<User> {
    let sessionId = socket.data.adminSessionId as string | undefined;
    let userId = socket.data.adminUserId as string | undefined;
    if (!sessionId || !userId) {
      const supplied = typeof socket.handshake.auth?.accessToken === 'string' ? socket.handshake.auth.accessToken : '';
      const token = supplied || readCookies(socket.handshake.headers.cookie)[ACCESS_COOKIE];
      if (!token) throw new AppError(401, 'AUTH_REQUIRED', 'Admin login is required');
      const claims = await verifyToken(token, 'access');
      sessionId = claims.sid;
      userId = claims.sub;
    }
    const [session, user] = await Promise.all([this.store.findSessionById(sessionId), this.store.findUserById(userId)]);
    if (!session || session.userId !== userId || session.revokedAt || new Date(session.expiresAt) <= new Date() || !user || user.status !== 'active') throw new AppError(401, 'SESSION_INVALID', 'Your admin session has expired');
    if (!hasFinePermission(user, permission)) throw new AppError(403, 'PERMISSION_DENIED', `Permission required: ${permission}`);
    socket.data.admin = user;
    socket.data.adminSessionId = sessionId;
    socket.data.adminUserId = userId;
    return user;
  }

  private async verifyVisitorRoom(sessionId: string, token: string | undefined) {
    const ticket = await this.db.findSession(sessionId);
    if (!ticket || ticket.source !== 'live_chat' || !verifyChatToken(token || '', ticket.chatAccessHash)) throw new AppError(403, 'CHAT_ACCESS_DENIED', 'This chat session is not available');
    return ticket;
  }

  private bindSocket(socket: Socket) {
    socket.on('admin_join_inbox', async (_payload, callback) => {
      try {
        await this.authenticateAdmin(socket, 'support.view');
        await socket.join(CHAT_ADMIN_ROOM);
        const conversations = await this.db.listSessions();
        acknowledge(callback, { ok: true, conversations: conversations.map(publicTicket) });
      } catch (error) { acknowledge(callback, { ok: false, error: socketError(error) }); }
    });

    socket.on('join_chat_room', async (raw, callback) => {
      try {
        const input = parse(roomInput, raw);
        let ticket: SupportTicket;
        if (socket.data.admin) {
          await this.authenticateAdmin(socket, 'support.view');
          const found = await this.db.findSession(input.sessionId);
          if (!found) throw new AppError(404, 'CHAT_NOT_FOUND', 'Chat session not found');
          ticket = (await this.db.markRead(found.id, 'admin')) || found;
        } else {
          ticket = await this.verifyVisitorRoom(input.sessionId, input.token);
          socket.data.visitor = { sessionId: ticket.id, token: input.token };
          ticket = (await this.db.markRead(ticket.id, 'customer')) || ticket;
        }
        await socket.join(roomName(ticket.id));
        const messages = await this.db.listMessages(ticket.id);
        this.trackChatRoom(socket, ticket.id);
        acknowledge(callback, { ok: true, ticket: publicTicket(await this.withAssigneeName(ticket)), messages });
        if (!socket.data.admin) {
          void this.noteVisitorPresence(ticket.id, true);
          this.io?.to(CHAT_ADMIN_ROOM).emit('chat_presence', { sessionId: ticket.id, online: true });
        }
      } catch (error) { acknowledge(callback, { ok: false, error: socketError(error) }); }
    });

    socket.on('send_chat_message', async (raw, callback) => {
      try {
        const visitor = socket.data.visitor as { sessionId?: string; token?: string } | undefined;
        if (!visitor?.sessionId) throw new AppError(403, 'CHAT_JOIN_REQUIRED', 'Join the chat before sending a message');
        const ticket = await this.verifyVisitorRoom(visitor.sessionId, visitor.token);
        const input = parse(messageInput, raw);
        const message = await this.db.createMessage({ ticketId: ticket.id, authorId: ticket.userId, authorType: 'customer', message: input.message, internal: false });
        const updated = (await this.db.incrementUnread(ticket.id, 'admin')) || ticket;
        await this.db.updateSession(ticket.id, { status: 'pending', lastMessageAt: message.createdAt });
        this.emitMessage(ticket.id, message);
        this.emitInbox({ ...updated, status: 'pending', lastMessageAt: message.createdAt });
        acknowledge(callback, { ok: true, message });
      } catch (error) { acknowledge(callback, { ok: false, error: socketError(error) }); }
    });

    socket.on('admin_reply', async (raw, callback) => {
      try {
        const admin = await this.authenticateAdmin(socket, 'support.reply');
        const joined = parse(roomInput.pick({ sessionId: true }), raw);
        const input = parse(messageInput, raw);
        const ticket = await this.db.findSession(joined.sessionId);
        if (!ticket) throw new AppError(404, 'CHAT_NOT_FOUND', 'Chat session not found');
        const message = await this.db.createMessage({ ticketId: ticket.id, authorId: admin.id, authorType: 'admin', message: input.message, internal: false });
        const updated = (await this.db.incrementUnread(ticket.id, 'customer')) || ticket;
        await this.db.updateSession(ticket.id, { status: 'waiting_customer', assignedTo: ticket.assignedTo || admin.id, lastMessageAt: message.createdAt });
        this.emitMessage(ticket.id, message);
        this.emitInbox({ ...updated, status: 'waiting_customer', assignedTo: ticket.assignedTo || admin.id, lastMessageAt: message.createdAt });
        acknowledge(callback, { ok: true, message });
      } catch (error) { acknowledge(callback, { ok: false, error: socketError(error) }); }
    });

    socket.on('disconnect', () => {
      const rooms = socket.data.chatRooms as Set<string> | undefined;
      if (rooms) for (const ticketId of rooms) this.releaseMessageWatch(ticketId);
      const visitor = socket.data.visitor as { sessionId?: string } | undefined;
      if (visitor?.sessionId) {
        void this.noteVisitorPresence(visitor.sessionId, false);
        this.io?.to(CHAT_ADMIN_ROOM).emit('chat_presence', { sessionId: visitor.sessionId, online: false });
      }
    });
  }
}

export function registerLiveChatRoutes(app: Express, deps: { store: Store; db: LiveChatDb; hub: LiveChatHub }) {
  const { store, db, hub } = deps;

  app.post('/api/v1/live-chat/sessions', optionalAuth(store), rateLimit('live-chat-session', 8, 300), async (req, res, next) => {
    try {
      const input = parse(sessionInput, req.body);
      const token = randomBytes(32).toString('base64url');
      const time = now();
      const ticket: SupportTicket = {
        id: randomUUID(),
        name: input.name,
        mobile: input.mobile || '',
        email: input.email || '',
        subject: input.subject,
        userId: req.user?.id,
        source: 'live_chat',
        chatAccessHash: hashChatToken(token),
        status: 'open',
        priority: 'normal',
        adminUnread: 1,
        customerUnread: 0,
        lastMessageAt: time,
        createdAt: time,
        updatedAt: time
      };
      await db.createSession(ticket);
      await store.audit('live_chat.session_created', { userId: req.user?.id, ip: req.ip, userAgent: req.get('user-agent')?.slice(0, 500), metadata: { ticketId: ticket.id } });
      hub.emitInbox(ticket, 'conversation_created');
      res.status(201).json({ session: publicTicket(ticket), token });
    } catch (error) { next(error); }
  });

  app.get('/api/v1/live-chat/sessions/:id/messages', rateLimit('live-chat-history', 60, 60), async (req, res, next) => {
    try {
      const ticket = await db.findSession(String(req.params.id));
      if (!ticket || ticket.source !== 'live_chat' || !verifyChatToken(chatTokenFromRequest(req), ticket.chatAccessHash)) throw new AppError(403, 'CHAT_ACCESS_DENIED', 'This chat session is not available');
      await db.markRead(ticket.id, 'customer');
      res.json({ session: publicTicket(ticket), messages: await db.listMessages(ticket.id) });
    } catch (error) { next(error); }
  });

  app.post('/api/v1/live-chat/sessions/:id/messages', rateLimit('live-chat-message', 30, 60), async (req, res, next) => {
    try {
      const ticket = await db.findSession(String(req.params.id));
      if (!ticket || ticket.source !== 'live_chat' || !verifyChatToken(chatTokenFromRequest(req), ticket.chatAccessHash)) throw new AppError(403, 'CHAT_ACCESS_DENIED', 'This chat session is not available');
      const input = parse(messageInput, req.body);
      const message = await db.createMessage({ ticketId: ticket.id, authorId: ticket.userId, authorType: 'customer', message: input.message, internal: false });
      const updated = (await db.incrementUnread(ticket.id, 'admin')) || ticket;
      await db.updateSession(ticket.id, { status: 'pending', lastMessageAt: message.createdAt });
      hub.emitMessage(ticket.id, message);
      hub.emitInbox({ ...updated, status: 'pending', lastMessageAt: message.createdAt });
      res.status(201).json({ message });
    } catch (error) { next(error); }
  });

  app.get('/api/v1/admin/live-chat', requireFinePermission(store, 'support.view'), async (_req, res) => {
    const conversations = await db.listSessions();
    res.json({ conversations: conversations.map(publicTicket), unread: conversations.reduce((sum, ticket) => sum + Number(ticket.adminUnread || 0), 0) });
  });

  app.get('/api/v1/admin/live-chat/:id', requireFinePermission(store, 'support.view'), async (req, res, next) => {
    try {
      const ticket = await db.findSession(String(req.params.id));
      if (!ticket) throw new AppError(404, 'CHAT_NOT_FOUND', 'Chat session not found');
      const updated = (await db.markRead(ticket.id, 'admin')) || ticket;
      const named = updated.assignedTo && !updated.assignedToName
        ? { ...updated, assignedToName: (await store.findUserById(updated.assignedTo))?.fullName }
        : updated;
      res.json({ conversation: publicTicket(named), messages: await db.listMessages(ticket.id) });
    } catch (error) { next(error); }
  });

  app.post('/api/v1/admin/live-chat/:id/messages', requireFinePermission(store, 'support.reply'), async (req, res, next) => {
    try {
      const ticket = await db.findSession(String(req.params.id));
      if (!ticket) throw new AppError(404, 'CHAT_NOT_FOUND', 'Chat session not found');
      const input = parse(messageInput, req.body);
      const message = await db.createMessage({ ticketId: ticket.id, authorId: req.user!.id, authorType: 'admin', message: input.message, internal: false });
      const updated = (await db.incrementUnread(ticket.id, 'customer')) || ticket;
      await db.updateSession(ticket.id, { status: 'waiting_customer', assignedTo: ticket.assignedTo || req.user!.id, lastMessageAt: message.createdAt });
      hub.emitMessage(ticket.id, message);
      hub.emitInbox({ ...updated, status: 'waiting_customer', assignedTo: ticket.assignedTo || req.user!.id, lastMessageAt: message.createdAt });
      await store.audit('live_chat.admin_replied', { userId: req.user!.id, ip: req.ip, userAgent: req.get('user-agent')?.slice(0, 500), metadata: { ticketId: ticket.id, messageId: message.id } });
      res.status(201).json({ message });
    } catch (error) { next(error); }
  });
}
