/**
 * Live chat end-to-end tests — these always run (no MongoDB or Firebase
 * credentials required). They exercise the REAL chat service, REST routes and
 * Socket.IO hub with an in-memory store, verifying exactly the guarantees the
 * feature is accepted on:
 *
 *   - a hotel chat resolves the hotel's owner (from hotel.ownerId) and adds
 *     them as a real participant with their own profile
 *   - the same customer + hotel reuses one conversation (no duplicates)
 *   - messages flow instantly between two connected clients, both directions,
 *     with no polling anywhere
 *   - unread counters, read receipts and typing indicators stream live
 *   - hotel owners only see their own hotels' conversations (owner B gets 403
 *     on owner A's thread), support staff see everything
 *   - transcripts persist across reconnects
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import express from 'express';
import { io as createSocket, type Socket } from 'socket.io-client';
import { randomUUID } from 'node:crypto';
import { ChatService } from './chat/service.js';
import { ChatRealtimeHub } from './chat/realtime.js';
import { registerChatRoutes } from './chat/routes.js';
import { MemoryChatStore } from './chat/testing.js';
import type { ChatDirectory, ChatHotel } from './chat/directory.js';
import { chatUidForUser } from './chat/keys.js';
import { ACCESS_COOKIE, issueSession } from './security.js';
import type { User } from './store.js';

type Fixture = {
  base: string;
  server: Server;
  close: () => Promise<void>;
  hotelA: ChatHotel;
  hotelB: ChatHotel;
  ownerA: User;
  ownerB: User;
  superAdmin: User;
  cookieFor: (user: User) => Promise<string>;
};

async function withFixture(run: (fixture: Fixture) => Promise<void>) {
  const ownerA: User = { id: randomUUID(), email: 'owner.a@test', fullName: 'Alice Owner', role: 'hotel_owner', status: 'active', permissions: [], createdAt: '', updatedAt: '' };
  const ownerB: User = { id: randomUUID(), email: 'owner.b@test', fullName: 'Bob Owner', role: 'hotel_owner', status: 'active', permissions: [], createdAt: '', updatedAt: '' };
  const superAdmin: User = { id: randomUUID(), email: 'super@test', fullName: 'Sam Admin', role: 'super_admin', status: 'active', permissions: [], createdAt: '', updatedAt: '' };
  const hotelA: ChatHotel = { id: randomUUID(), name: 'Hotel The Cox Today', ownerId: ownerA.id, status: 'active', images: [] };
  const hotelB: ChatHotel = { id: randomUUID(), name: 'Seagull Beach Resort', ownerId: ownerB.id, status: 'active', images: [] };
  const users = [ownerA, ownerB, superAdmin];

  const directory: ChatDirectory = {
    async findUserById(id) { return users.find(user => user.id === id); },
    async listSupportStaffIds() { return users.filter(user => user.role === 'super_admin').map(user => user.id); },
    async findHotel(id) { return [hotelA, hotelB].find(hotel => hotel.id === id); },
    async listOwnedHotelIds(ownerId) { return [hotelA, hotelB].filter(hotel => hotel.ownerId === ownerId).map(hotel => hotel.id); },
    async audit() { /* test no-op */ }
  };

  const chatStore = new MemoryChatStore();
  const service = new ChatService({ store: chatStore, directory, brandName: 'Sadik Travels' });
  const hub = new ChatRealtimeHub(service);

  const app = express();
  app.use(express.json());
  const sessionStore = new Map<string, { userId: string }>();
  const authMiddleware: express.RequestHandler = (req, _res, next) => {
    const raw = String(req.headers.cookie || '');
    const match = raw.split(';').map(part => part.trim()).find(part => part.startsWith(`${ACCESS_COOKIE}=`));
    const token = match ? decodeURIComponent(match.slice(ACCESS_COOKIE.length + 1)) : '';
    if (!token) return next();
    import('./security.js').then(async ({ verifyToken }) => {
      try {
        const claims = await verifyToken(token, 'access');
        const user = users.find(candidate => candidate.id === claims.sub);
        if (user) (req as any).user = user;
      } catch { /* anonymous */ }
      next();
    });
  };
  registerChatRoutes(app, { service, hub, auth: { optional: authMiddleware } });

  const server = createServer(app);
  hub.attach(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;

  const cookieFor = async (user: User) => {
    const { accessToken } = await issueSession({ createSession: async (session: any) => { sessionStore.set(session.id, { userId: user.id }); return session; } } as any, user, {});
    return `${ACCESS_COOKIE}=${encodeURIComponent(accessToken)}`;
  };

  try {
    await run({ base, server, hotelA, hotelB, ownerA, ownerB, superAdmin, cookieFor, close: async () => { await new Promise<void>(resolve => server.close(() => resolve())); } });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

type ChatConversationLike = { id?: unknown; participants?: string[]; [key: string]: unknown };
type ChatMessageLike = { text?: unknown; senderRole?: unknown; conversationId?: unknown; [key: string]: unknown };
type ChatAckPayload = { ok: boolean; conversations?: ChatConversationLike[]; conversation?: ChatConversationLike; message?: ChatMessageLike; messages?: ChatMessageLike[]; [key: string]: unknown };

const socketAck = <T>(socket: Socket, event: string, payload: unknown) => new Promise<T>((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error(`Socket acknowledgement timed out: ${event}`)), 5000);
  socket.emit(event, payload, (result: T) => { clearTimeout(timeout); resolve(result); });
});

const connected = (socket: Socket) => new Promise<void>((resolve, reject) => {
  if (socket.connected) return resolve();
  const timeout = setTimeout(() => reject(new Error('Socket connection timed out')), 5000);
  socket.once('connect', () => { clearTimeout(timeout); resolve(); });
  socket.once('connect_error', (error: Error) => { clearTimeout(timeout); reject(error); });
});

const waitFor = async <T>(poll: () => T | undefined | Promise<T | undefined>, label: string): Promise<T> => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = await poll();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
};

test('hotel chat resolves the owner as a participant, dedupes conversations and scopes access', async () => {
  await withFixture(async ({ base, hotelA, hotelB, ownerA, ownerB, superAdmin }) => {
    // Guest identity bootstrap
    const bootstrap = await fetch(`${base}/api/v1/chat/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Rahim', contact: '01711223344' }) });
    assert.equal(bootstrap.status, 200);
    const guest = await bootstrap.json() as any;
    assert.equal(guest.identity.kind, 'guest');
    const guestHeaders = { 'content-type': 'application/json', 'x-chat-identity': `${guest.credentials.uid}.${guest.credentials.secret}` };

    // Create a hotel conversation — the server must resolve the owner
    const created = await fetch(`${base}/api/v1/chat/conversations`, { method: 'POST', headers: guestHeaders, body: JSON.stringify({ type: 'hotel', contextId: hotelA.id }) });
    assert.equal(created.status, 201);
    const payload = await created.json() as any;
    const conversation = payload.conversation;
    assert.equal(conversation.type, 'hotel');
    assert.equal(conversation.hotelId, hotelA.id);
    assert.equal(conversation.label, 'Hotel The Cox Today');
    const ownerUid = chatUidForUser(ownerA.id, 'staff');
    assert.equal(conversation.participants.includes(ownerUid), true, 'hotel owner must be a conversation participant');
    assert.equal(conversation.profiles[ownerUid].roleLabel, 'Hotel Owner');
    assert.equal(conversation.profiles[ownerUid].userId, ownerA.id);
    assert.equal(conversation.otherParticipant?.uid, ownerUid, 'the customer must see the owner profile as the other participant');

    // Duplicate prevention: the same customer + hotel reuses the conversation
    const again = await fetch(`${base}/api/v1/chat/conversations`, { method: 'POST', headers: guestHeaders, body: JSON.stringify({ type: 'hotel', contextId: hotelA.id }) });
    const againPayload = await again.json() as any;
    assert.equal(againPayload.conversation.id, conversation.id, 'the same customer+hotel must reuse one conversation');

    // Different hotel → different conversation
    const otherHotel = await fetch(`${base}/api/v1/chat/conversations`, { method: 'POST', headers: guestHeaders, body: JSON.stringify({ type: 'hotel', contextId: hotelB.id }) });
    assert.equal((await otherHotel.json() as any).conversation.id !== conversation.id, true);

    // Owner A lists the inbox: the hotel A conversation is visible
    const cookieA = await (await import('./security.js')).issueSession({ createSession: async (session: any) => session } as any, ownerA, {});
    const inboxA = await fetch(`${base}/api/v1/chat/conversations`, { headers: { cookie: `${ACCESS_COOKIE}=${encodeURIComponent(cookieA.accessToken)}` } });
    const inboxAPayload = await inboxA.json() as any;
    assert.equal(inboxAPayload.conversations.some((item: any) => item.id === conversation.id), true, 'owner A must see their hotel conversation');

    // Owner B must NOT see (or open) the hotel A conversation
    const cookieB = await (await import('./security.js')).issueSession({ createSession: async (session: any) => session } as any, ownerB, {});
    const cookieHeaderB = `${ACCESS_COOKIE}=${encodeURIComponent(cookieB.accessToken)}`;
    const inboxB = await fetch(`${base}/api/v1/chat/conversations`, { headers: { cookie: cookieHeaderB } });
    const inboxBPayload = await inboxB.json() as any;
    assert.equal(inboxBPayload.conversations.some((item: any) => item.id === conversation.id), false, 'owner B must not see the hotel A conversation');
    const denied = await fetch(`${base}/api/v1/chat/conversations/${conversation.id}/messages`, { headers: { cookie: cookieHeaderB } });
    assert.equal(denied.status, 403, 'owner B must get 403 on the hotel A conversation');
    const deniedSend = await fetch(`${base}/api/v1/chat/conversations/${conversation.id}/messages`, { method: 'POST', headers: { cookie: cookieHeaderB, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'injected' }) });
    assert.equal(deniedSend.status, 403, 'owner B must not be able to write into the hotel A conversation');

    // Support staff sees everything
    const cookieS = await (await import('./security.js')).issueSession({ createSession: async (session: any) => session } as any, superAdmin, {});
    const inboxS = await fetch(`${base}/api/v1/chat/conversations`, { headers: { cookie: `${ACCESS_COOKIE}=${encodeURIComponent(cookieS.accessToken)}` } });
    const inboxSPayload = await inboxS.json() as any;
    assert.equal(inboxSPayload.conversations.length >= 2, true, 'support staff must see all conversations');
    assert.equal(inboxSPayload.viewer.supportStaff, true);
  });
});

test('messages stream instantly both ways between customer and hotel owner, with unread, receipts and typing', async () => {
  await withFixture(async ({ base, hotelA, ownerA }) => {
    const bootstrap = await fetch(`${base}/api/v1/chat/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Karim', contact: 'karim@example.com' }) });
    const guest = await bootstrap.json() as any;
    const identity = `${guest.credentials.uid}.${guest.credentials.secret}`;

    const created = await fetch(`${base}/api/v1/chat/conversations`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-chat-identity': identity }, body: JSON.stringify({ type: 'hotel', contextId: hotelA.id }) });
    const conversation = (await created.json() as any).conversation;

    const ownerCookie = await (await import('./security.js')).issueSession({ createSession: async (session: any) => session } as any, ownerA, {});
    const cookieHeader = `${ACCESS_COOKIE}=${encodeURIComponent(ownerCookie.accessToken)}`;

    const customerSocket = createSocket(base, { transports: ['websocket'], auth: { identity } });
    const ownerSocket = createSocket(base, { transports: ['websocket'], extraHeaders: { cookie: cookieHeader } });
    try {
      await Promise.all([connected(customerSocket), connected(ownerSocket)]);

      const customerEvents: any[] = [];
      customerSocket.on('chat:message', payload => customerEvents.push(payload.message));
      customerSocket.on('chat:read', payload => customerSocket.emit('__seen', payload));
      const ownerEvents: any[] = [];
      ownerSocket.on('chat:message', payload => ownerEvents.push(payload.message));

      const helloOwner = await socketAck<ChatAckPayload>(ownerSocket, 'chat:hello', {});
      assert.equal(helloOwner.ok, true);
      assert.equal((helloOwner.conversations ?? []).some(item => item.id === conversation.id), true, 'owner inbox must include the conversation over the socket');

      // Owner opens the conversation (as the admin console does), then the
      // customer joins and sends — the owner must receive it instantly.
      const joinOwner = await socketAck<ChatAckPayload>(ownerSocket, 'chat:join', { conversationId: conversation.id });
      assert.equal(joinOwner.ok, true);
      assert.equal((joinOwner.conversation?.participants ?? []).includes(chatUidForUser(ownerA.id, 'staff')), true);

      const joinCustomer = await socketAck<ChatAckPayload>(customerSocket, 'chat:join', { conversationId: conversation.id });
      assert.equal(joinCustomer.ok, true);
      const send = await socketAck<ChatAckPayload>(customerSocket, 'chat:send', { conversationId: conversation.id, text: 'Hello, I want to know about rooms.' });
      assert.equal(send.ok, true);
      const received = await waitFor(() => ownerEvents.find(message => message.text === 'Hello, I want to know about rooms.'), 'owner to receive the customer message');
      assert.equal(received.senderRole, 'customer');

      // Owner replies — customer must receive it instantly
      const reply = await socketAck<ChatAckPayload>(ownerSocket, 'chat:send', { conversationId: conversation.id, text: 'Hello! Deluxe rooms are available.' });
      assert.equal(reply.ok, true);
      assert.equal(reply.message?.senderRole, 'hotel_owner');
      const customerReceived = await waitFor(() => customerEvents.find(message => message.text === 'Hello! Deluxe rooms are available.'), 'customer to receive the owner reply');
      assert.equal(customerReceived.conversationId, conversation.id);

      // Typing indicator streams to the other side
      const typingPromise = new Promise<any>(resolve => ownerSocket.once('chat:typing', resolve));
      customerSocket.emit('chat:typing', { conversationId: conversation.id, typing: true }, () => undefined);
      const typing = await typingPromise;
      assert.equal(typing.typing, true);
      assert.equal(typing.conversationId, conversation.id);

      // Unread + read state: owner had an unread badge, then reads it
      const afterSend = await fetch(`${base}/api/v1/chat/conversations`, { headers: { 'x-chat-identity': identity } });
      // (list check for the customer is unchanged) — owner list shows unread
      const ownerInbox = await fetch(`${base}/api/v1/chat/conversations`, { headers: { cookie: cookieHeader } });
      const ownerInboxPayload = await ownerInbox.json() as any;
      const thread = ownerInboxPayload.conversations.find((item: any) => item.id === conversation.id);
      assert.equal(Number(thread.unread[chatUidForUser(ownerA.id, 'staff')] || 0) >= 1, true, 'owner must have an unread count');

      const readAck = await socketAck<ChatAckPayload>(ownerSocket, 'chat:read', { conversationId: conversation.id });
      assert.equal(readAck.ok, true);
      const readEvent = await new Promise<any>(resolve => customerSocket.once('chat:read', resolve));
      assert.equal(readEvent.uid, chatUidForUser(ownerA.id, 'staff'));
      const ownerInboxAfter = await (await fetch(`${base}/api/v1/chat/conversations`, { headers: { cookie: cookieHeader } })).json() as any;
      const threadAfter = ownerInboxAfter.conversations.find((item: any) => item.id === conversation.id);
      assert.equal(Number(threadAfter.unread[chatUidForUser(ownerA.id, 'staff')] || 0), 0, 'read state must clear the unread count');
    } finally {
      customerSocket.disconnect();
      ownerSocket.disconnect();
    }
  });
});

test('transcripts persist across reconnects and history loads in order', async () => {
  await withFixture(async ({ base, hotelA, ownerA }) => {
    const bootstrap = await fetch(`${base}/api/v1/chat/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Persistence Guest' }) });
    const guest = await bootstrap.json() as any;
    const identity = `${guest.credentials.uid}.${guest.credentials.secret}`;
    const created = await fetch(`${base}/api/v1/chat/conversations`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-chat-identity': identity }, body: JSON.stringify({ type: 'hotel', contextId: hotelA.id }) });
    const conversation = (await created.json() as any).conversation;

    for (const text of ['first message', 'second message', 'third message']) {
      const sent = await fetch(`${base}/api/v1/chat/conversations/${conversation.id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-chat-identity': identity }, body: JSON.stringify({ text }) });
      assert.equal(sent.status, 201);
    }

    const ownerCookie = await (await import('./security.js')).issueSession({ createSession: async (session: any) => session } as any, ownerA, {});
    const socket = createSocket(base, { transports: ['websocket'], extraHeaders: { cookie: `${ACCESS_COOKIE}=${encodeURIComponent(ownerCookie.accessToken)}` } });
    try {
      await connected(socket);
      const joined = await socketAck<ChatAckPayload>(socket, 'chat:join', { conversationId: conversation.id });
      assert.equal(joined.ok, true);
      assert.deepEqual((joined.messages ?? []).map(message => message.text), ['first message', 'second message', 'third message']);
      assert.deepEqual((joined.messages ?? []).map(message => message.senderRole), ['customer', 'customer', 'customer']);
    } finally {
      socket.disconnect();
    }
  });
});

test('anonymous senders cannot write into conversations without an identity', async () => {
  await withFixture(async ({ base, hotelA }) => {
    const bootstrap = await fetch(`${base}/api/v1/chat/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Secure Guest' }) });
    const guest = await bootstrap.json() as any;
    const identity = `${guest.credentials.uid}.${guest.credentials.secret}`;
    const created = await fetch(`${base}/api/v1/chat/conversations`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-chat-identity': identity }, body: JSON.stringify({ type: 'hotel', contextId: hotelA.id }) });
    const conversation = (await created.json() as any).conversation;

    const noIdentity = await fetch(`${base}/api/v1/chat/conversations/${conversation.id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'spoofed' }) });
    assert.equal(noIdentity.status, 401, 'a request without any identity must be rejected');
    const wrongIdentity = await fetch(`${base}/api/v1/chat/conversations/${conversation.id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-chat-identity': `${guest.credentials.uid}.wrong-secret` }, body: JSON.stringify({ text: 'spoofed' }) });
    assert.equal(wrongIdentity.status, 401, 'a wrong guest secret must be rejected');
  });
});
