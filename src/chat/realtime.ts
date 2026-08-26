/**
 * Chat realtime hub.
 *
 * This hub is the fan-out layer for deployments WITHOUT Firebase Realtime
 * Database credentials (local development, CI, demo mode). Delivery is still
 * event-driven: Socket.IO pushes — there is no polling anywhere.
 *
 * When Firebase is configured, the browser talks to Realtime Database
 * directly (onValue/onChildAdded listeners + custom-token auth) and this hub
 * stays idle for chat; the REST API remains the authorization path for
 * conversation creation.
 */
import type { Server as HttpServer } from 'node:http';
import { Server as SocketServer, type Socket } from 'socket.io';
import { z, ZodError } from 'zod';
import { AppError } from '../errors.js';
import { config } from '../config.js';
import { ACCESS_COOKIE, verifyToken } from '../security.js';
import type { ChatService } from './service.js';
import type { ChatConversation, ChatMessage } from './types.js';

const STAFF_ROOM = 'chat:staff';
const roomName = (conversationId: string) => `chat:c:${conversationId}`;

const sendInput = z.object({ conversationId: z.string().min(8).max(128), text: z.string().trim().min(1).max(4000), clientRef: z.string().max(64).optional() });
const joinInput = z.object({ conversationId: z.string().min(8).max(128) });
const typingInput = z.object({ conversationId: z.string().min(8).max(128), typing: z.boolean() });

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  try { return schema.parse(value); }
  catch (error) {
    if (error instanceof ZodError) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid chat payload');
    throw error;
  }
}

function socketError(error: unknown) {
  if (error instanceof AppError) return { code: error.code, message: error.message };
  return { code: 'CHAT_ERROR', message: 'Unable to complete the chat request' };
}

function acknowledge(callback: unknown, payload: unknown) {
  if (typeof callback === 'function') callback(payload);
}

function readCookies(header = ''): Record<string, string> {
  return Object.fromEntries(header.split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const index = part.indexOf('=');
    const key = index >= 0 ? part.slice(0, index) : part;
    const raw = index >= 0 ? part.slice(index + 1) : '';
    try { return [key, decodeURIComponent(raw)]; } catch { return [key, raw]; }
  }));
}

export class ChatRealtimeHub {
  private io?: SocketServer;
  /** Connected sockets per chat uid — powers presence and owner-targeted inbox events. */
  private uidSockets = new Map<string, Set<Socket>>();

  constructor(private readonly service: ChatService) {}

  attach(server: HttpServer): SocketServer {
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
    this.io.on('connection', socket => { void this.bindSocket(socket); });
    return this.io;
  }

  /** Broadcast a conversation create/update to everyone allowed to see it. */
  emitConversation(conversation: ChatConversation): void {
    if (!this.io) return;
    const payload = { conversation };
    this.io.to(roomName(conversation.id)).emit('chat:conversation', payload);
    for (const uid of Object.keys(conversation.participants || {})) {
      if (uid === 'support-team') continue;
      this.emitToUid(uid, 'chat:conversation', payload);
    }
    this.io.to(STAFF_ROOM).emit('chat:conversation', payload);
  }

  emitMessage(message: ChatMessage): void {
    this.io?.to(roomName(message.conversationId)).emit('chat:message', { message });
  }

  emitRead(conversationId: string, uid: string, at: number): void {
    this.io?.to(roomName(conversationId)).emit('chat:read', { conversationId, uid, at });
  }

  private emitToUid(uid: string, event: string, payload: unknown): void {
    const sockets = this.uidSockets.get(uid);
    if (!sockets) return;
    for (const socket of sockets) socket.emit(event, payload);
  }

  private registerSocket(socket: Socket, uid: string): void {
    socket.data.chatUid = uid;
    const set = this.uidSockets.get(uid) || new Set<Socket>();
    set.add(socket);
    this.uidSockets.set(uid, set);
  }

  private unregisterSocket(socket: Socket): void {
    const uid = socket.data.chatUid as string | undefined;
    if (!uid) return;
    const set = this.uidSockets.get(uid);
    if (set) {
      set.delete(socket);
      if (!set.size) {
        this.uidSockets.delete(uid);
        // Offline presence: notify every conversation the uid is part of.
        this.io?.emit('chat:presence', { uid, online: false, lastSeen: Date.now() });
      }
    }
  }

  private async resolveSocketViewer(socket: Socket) {
    if (socket.data.viewer) return socket.data.viewer;
    const supplied = typeof socket.handshake.auth?.identity === 'string' ? socket.handshake.auth.identity : '';
    const token = typeof socket.handshake.auth?.accessToken === 'string' ? socket.handshake.auth.accessToken : '';
    let user;
    if (token) {
      try {
        const claims = await verifyToken(token, 'access');
        user = await this.service.directory.findUserById(claims.sub);
      } catch { user = undefined; }
    } else {
      const cookieToken = readCookies(socket.handshake.headers.cookie || '')[ACCESS_COOKIE];
      if (cookieToken) {
        try {
          const claims = await verifyToken(cookieToken, 'access');
          user = await this.service.directory.findUserById(claims.sub);
        } catch { user = undefined; }
      }
    }
    const viewer = await this.service.resolveViewer({ user, guestHeader: supplied || undefined });
    socket.data.viewer = viewer;
    return viewer;
  }

  private async bindSocket(socket: Socket): Promise<void> {
    const guard = async (handler: () => Promise<unknown>, callback: unknown) => {
      try { acknowledge(callback, { ok: true, ...(await handler() as Record<string, unknown>) }); }
      catch (error) { acknowledge(callback, { ok: false, error: socketError(error) }); }
    };

    socket.on('chat:hello', (_payload, callback) => void guard(async () => {
      const viewer = await this.resolveSocketViewer(socket);
      this.registerSocket(socket, viewer.identity.uid);
      const conversations = await this.service.listConversations(viewer);
      const staffInbox = viewer.supportStaff;
      if (staffInbox) await socket.join(STAFF_ROOM);
      return { viewer: { uid: viewer.identity.uid, kind: viewer.identity.kind, name: viewer.identity.name, supportStaff: viewer.supportStaff, vendor: viewer.vendor }, conversations, supportStaff: staffInbox };
    }, callback));

    socket.on('chat:join', (raw, callback) => void guard(async () => {
      const input = parse(joinInput, raw);
      const viewer = await this.resolveSocketViewer(socket);
      this.registerSocket(socket, viewer.identity.uid);
      const conversation = await this.service.getConversation(viewer, input.conversationId);
      await this.service.joinAsStaff(viewer, conversation);
      await socket.join(roomName(conversation.id));
      const messages = await this.service.listMessages(viewer, conversation);
      // Presence snapshot for the other participants already connected.
      for (const uid of Object.keys(conversation.participants || {})) {
        if (uid === viewer.identity.uid || uid === 'support-team') continue;
        socket.emit('chat:presence', { uid, online: this.uidSockets.has(uid) });
      }
      this.io?.to(roomName(conversation.id)).emit('chat:presence', { uid: viewer.identity.uid, online: true });
      await this.service.markRead(viewer, conversation);
      this.emitRead(conversation.id, viewer.identity.uid, Date.now());
      return { conversation: await this.service.conversationView(viewer, conversation), messages };
    }, callback));

    socket.on('chat:send', (raw, callback) => void guard(async () => {
      const input = parse(sendInput, raw);
      const viewer = await this.resolveSocketViewer(socket);
      const conversation = await this.service.getConversation(viewer, input.conversationId);
      const message = await this.service.sendMessage(viewer, conversation, input.text);
      const fresh = await this.service.getConversation(viewer, conversation.id);
      this.emitMessage(message);
      this.emitConversation(fresh);
      return { message };
    }, callback));

    socket.on('chat:read', (raw, callback) => void guard(async () => {
      const input = parse(joinInput, raw);
      const viewer = await this.resolveSocketViewer(socket);
      const conversation = await this.service.getConversation(viewer, input.conversationId);
      const at = Date.now();
      await this.service.markRead(viewer, conversation, at);
      this.emitRead(conversation.id, viewer.identity.uid, at);
      const fresh = await this.service.getConversation(viewer, conversation.id);
      this.emitConversation(fresh);
      return {};
    }, callback));

    socket.on('chat:typing', (raw, callback) => void guard(async () => {
      const input = parse(typingInput, raw);
      const viewer = await this.resolveSocketViewer(socket);
      const conversation = await this.service.getConversation(viewer, input.conversationId);
      socket.to(roomName(conversation.id)).emit('chat:typing', { conversationId: conversation.id, uid: viewer.identity.uid, name: viewer.identity.name, typing: input.typing });
      return {};
    }, callback));

    socket.on('disconnecting', () => {
      const uid = socket.data.chatUid as string | undefined;
      if (!uid) return;
      for (const room of socket.rooms) {
        if (room !== socket.id && room !== STAFF_ROOM) {
          this.io?.to(room).emit('chat:presence', { uid, online: false, lastSeen: Date.now() });
        }
      }
    });

    socket.on('disconnect', () => this.unregisterSocket(socket));
  }
}
