/**
 * REST endpoints for the live chat.
 *
 * The browser's real-time message stream comes from Firebase Realtime Database
 * listeners (or the Socket.IO hub in deployments without Firebase). These
 * endpoints handle what must always be server-authorized: identity
 * bootstrap, custom-token minting, conversation creation (hotel-owner
 * resolution), scoped inbox listing, history and fallback writes.
 */
import type { Express, RequestHandler } from 'express';
import { z, ZodError } from 'zod';
import { AppError } from '../errors.js';
import { rateLimit } from '../rate-limit.js';
import type { ChatRealtimeHub } from './realtime.js';
import type { ChatService } from './service.js';
import type { ChatConversationType } from './types.js';

const GUEST_IDENTITY_HEADER = 'x-chat-identity';

const sessionInput = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  contact: z.string().trim().max(120).optional()
});
const conversationInput = z.object({
  type: z.enum(['hotel', 'tour', 'home_stay', 'travel_agent', 'support']),
  contextId: z.string().trim().min(1).max(128).optional()
});
const messageInput = z.object({ text: z.string().trim().min(1).max(4000) });
const idInput = z.string().trim().min(8).max(128);

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  try { return schema.parse(value); }
  catch (error) {
    if (error instanceof ZodError) throw new AppError(400, 'VALIDATION_ERROR', 'Please check the submitted fields', error.flatten());
    throw error;
  }
}

export type ChatRouteDeps = {
  service: ChatService;
  hub: ChatRealtimeHub;
  auth: { optional: RequestHandler };
};

export function guestIdentityHeader(req: { header(name: string): string | undefined }): string | undefined {
  return req.header(GUEST_IDENTITY_HEADER) || undefined;
}

export function registerChatRoutes(app: Express, deps: ChatRouteDeps) {
  const { service, hub, auth } = deps;

  /** Bootstrap the chat identity for this browser (account session or guest). */
  app.post('/api/v1/chat/session', auth.optional, rateLimit('chat-session', 30, 60), async (req, res, next) => {
    try {
      const input = parse(sessionInput, req.body || {});
      const user = (req as any).user;
      const result = await service.bootstrap({ user, guestHeader: guestIdentityHeader(req), profile: input });
      res.json({
        identity: { uid: result.identity.uid, kind: result.identity.kind, name: result.identity.name, photoUrl: result.identity.photoUrl, ...(result.identity.role ? { role: result.identity.role, roleLabel: result.identity.roleLabel } : {}) },
        ...(result.credentials ? { credentials: result.credentials } : {}),
        realtime: result.realtime,
        ...(result.firebase ? { firebase: result.firebase } : {}),
        supportStaff: result.supportStaff,
        vendor: result.vendor
      });
    } catch (error) { next(error); }
  });

  /** Refresh the Firebase custom token (re-authentication for long sessions). */
  app.post('/api/v1/chat/token', auth.optional, rateLimit('chat-token', 30, 60), async (req, res, next) => {
    try {
      const viewer = await service.resolveViewer({ user: (req as any).user, guestHeader: guestIdentityHeader(req) });
      const result = await service.bootstrap({ user: (req as any).user, guestHeader: guestIdentityHeader(req) });
      if (!result.firebase) return res.json({ realtime: 'socket' });
      res.json({ realtime: 'firebase', firebase: result.firebase, identity: { uid: viewer.identity.uid, kind: viewer.identity.kind, name: viewer.identity.name } });
    } catch (error) { next(error); }
  });

  /** Scoped conversation inbox: customers see theirs, owners their hotels, support staff all. */
  app.get('/api/v1/chat/conversations', auth.optional, rateLimit('chat-list', 120, 60), async (req, res, next) => {
    try {
      const viewer = await service.resolveViewer({ user: (req as any).user, guestHeader: guestIdentityHeader(req) });
      const conversations = await service.listConversations(viewer);
      const views = await Promise.all(conversations.map(conversation => service.conversationView(viewer, conversation)));
      res.json({
        viewer: { uid: viewer.identity.uid, kind: viewer.identity.kind, name: viewer.identity.name, supportStaff: viewer.supportStaff, vendor: viewer.vendor },
        conversations: views
      });
    } catch (error) { next(error); }
  });

  /** Find-or-create a context conversation (hotel id → hotel owner participant). */
  app.post('/api/v1/chat/conversations', auth.optional, rateLimit('chat-create', 30, 60), async (req, res, next) => {
    try {
      const input = parse(conversationInput, req.body || {});
      const viewer = await service.resolveViewer({ user: (req as any).user, guestHeader: guestIdentityHeader(req) });
      const conversation = await service.findOrCreateConversation(viewer, { type: input.type as ChatConversationType, contextId: input.contextId });
      res.status(201).json({ conversation: await service.conversationView(viewer, conversation) });
    } catch (error) { next(error); }
  });

  /** Open a conversation: staff join as participants, the opener's messages are marked read. */
  app.get('/api/v1/chat/conversations/:id', auth.optional, rateLimit('chat-open', 240, 60), async (req, res, next) => {
    try {
      const id = parse(idInput, req.params.id);
      const viewer = await service.resolveViewer({ user: (req as any).user, guestHeader: guestIdentityHeader(req) });
      const conversation = await service.getConversation(viewer, id);
      await service.joinAsStaff(viewer, conversation);
      await service.markRead(viewer, conversation);
      res.json({ conversation: await service.conversationView(viewer, conversation), messages: await service.listMessages(viewer, conversation) });
    } catch (error) { next(error); }
  });

  /** Conversation history (used by the fallback transport and initial hydration). */
  app.get('/api/v1/chat/conversations/:id/messages', auth.optional, rateLimit('chat-history', 240, 60), async (req, res, next) => {
    try {
      const id = parse(idInput, req.params.id);
      const viewer = await service.resolveViewer({ user: (req as any).user, guestHeader: guestIdentityHeader(req) });
      const conversation = await service.getConversation(viewer, id);
      res.json({ messages: await service.listMessages(viewer, conversation) });
    } catch (error) { next(error); }
  });

  /** Server-validated message send (fallback write path; Firebase mode prefers direct RTDB writes). */
  app.post('/api/v1/chat/conversations/:id/messages', auth.optional, rateLimit('chat-send', 60, 60), async (req, res, next) => {
    try {
      const id = parse(idInput, req.params.id);
      const input = parse(messageInput, req.body || {});
      const viewer = await service.resolveViewer({ user: (req as any).user, guestHeader: guestIdentityHeader(req) });
      const conversation = await service.getConversation(viewer, id);
      const message = await service.sendMessage(viewer, conversation, input.text);
      const fresh = await service.getConversation(viewer, id);
      hub.emitMessage(message);
      hub.emitConversation(fresh);
      res.status(201).json({ message });
    } catch (error) { next(error); }
  });

  /** Mark the conversation read for the current viewer. */
  app.post('/api/v1/chat/conversations/:id/read', auth.optional, rateLimit('chat-read', 240, 60), async (req, res, next) => {
    try {
      const id = parse(idInput, req.params.id);
      const viewer = await service.resolveViewer({ user: (req as any).user, guestHeader: guestIdentityHeader(req) });
      const conversation = await service.getConversation(viewer, id);
      const at = Date.now();
      await service.markRead(viewer, conversation, at);
      hub.emitRead(id, viewer.identity.uid, at);
      res.json({ ok: true, at });
    } catch (error) { next(error); }
  });
}
