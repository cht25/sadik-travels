/**
 * Live chat storage.
 *
 * When Firebase is configured, conversations and transcripts live in Firebase
 * Realtime Database (written through the Admin SDK). The server subscribes to
 * the same nodes and relays changes to Socket.IO rooms, so Realtime Database
 * is the real-time event source: messages or session updates written by any
 * process — or even in the Firebase console — reach connected clients.
 *
 * Without Firebase configuration the adapter falls back to the MongoDB
 * `support_tickets`/`support_messages` collections so local development and
 * the integration suite keep working unchanged.
 */
import { randomUUID } from 'node:crypto';
import type { DataSnapshot, Database, Reference } from 'firebase-admin/database';
import { firebaseRealtimeDatabase, isFirebaseDatabaseConfigured } from './firebase.js';
import type { Store, SupportMessage, SupportTicket } from './store.js';

const now = () => new Date().toISOString();
const SESSIONS_ROOT = 'live-chat/sessions';
const MESSAGES_ROOT = 'live-chat/messages';

export type LiveChatBackend = 'firebase-realtime-db' | 'mongodb';
export type SessionPatch = { status?: SupportTicket['status']; priority?: SupportTicket['priority']; assignedTo?: string | null; adminUnread?: number; customerUnread?: number; lastMessageAt?: string };

export interface LiveChatDb {
  readonly backend: LiveChatBackend;
  createSession(ticket: SupportTicket): Promise<SupportTicket>;
  findSession(id: string): Promise<SupportTicket | undefined>;
  listSessions(): Promise<SupportTicket[]>;
  updateSession(id: string, patch: SessionPatch): Promise<SupportTicket | undefined>;
  incrementUnread(id: string, audience: 'admin' | 'customer'): Promise<SupportTicket | undefined>;
  markRead(id: string, audience: 'admin' | 'customer'): Promise<SupportTicket | undefined>;
  setPresence(id: string, online: boolean): Promise<void>;
  createMessage(input: { ticketId: string; authorId?: string; authorType: 'customer' | 'admin' | 'system'; message: string; internal: boolean }): Promise<SupportMessage>;
  listMessages(ticketId: string): Promise<SupportMessage[]>;
  /**
   * Live subscription to conversation-level changes. `created` fires for every
   * conversation added after the subscription started (the initial state never
   * replays — the join handshake carries it), `changed` fires with the
   * previously seen value when available, `removed` when a conversation is
   * deleted underneath us. Returns an unsubscribe function.
   */
  watchSessions(callback: (session: SupportTicket, event: 'created' | 'changed' | 'removed', previous?: SupportTicket) => void): () => void;
  /**
   * Live subscription to new transcript messages for one conversation. Only
   * messages added after the subscription started are delivered (the join
   * handshake already delivered the transcript); clients also de-duplicate by
   * message id. Returns an unsubscribe function.
   */
  watchMessages(ticketId: string, callback: (message: SupportMessage) => void): () => void;
}

/** Realtime Database rejects undefined fields (they become null) — strip them before writing. */
function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).map(([k, v]) => [k, stripUndefined(v)]));
  }
  return value;
}

function normalizeSession(value: Record<string, unknown>): SupportTicket {
  return {
    id: String(value.id || ''),
    userId: value.userId ? String(value.userId) : undefined,
    name: String(value.name || ''),
    mobile: String(value.mobile || ''),
    email: String(value.email || ''),
    subject: String(value.subject || ''),
    status: (['open', 'pending', 'in_progress', 'waiting_customer', 'resolved', 'closed'].includes(String(value.status)) ? String(value.status) : 'open') as SupportTicket['status'],
    priority: (['low', 'normal', 'high', 'urgent'].includes(String(value.priority)) ? String(value.priority) : 'normal') as SupportTicket['priority'],
    assignedTo: value.assignedTo ? String(value.assignedTo) : undefined,
    source: 'live_chat',
    chatAccessHash: value.chatAccessHash ? String(value.chatAccessHash) : undefined,
    adminUnread: Number(value.adminUnread || 0),
    customerUnread: Number(value.customerUnread || 0),
    lastMessageAt: value.lastMessageAt ? String(value.lastMessageAt) : undefined,
    createdAt: String(value.createdAt || ''),
    updatedAt: String(value.updatedAt || '')
  };
}

/**
 * Subscribe to a child event. The compat `on()` call actually returns an
 * unsubscribe function, but the published typings annotate the return with the
 * callback signature — the cast documents the real runtime type.
 */
function subscribe(ref: Reference, event: 'child_added' | 'child_changed' | 'child_removed', handler: (snapshot: DataSnapshot) => void): () => void {
  const unsubscribe = ref.on(event, handler, (error: Error) => console.error('live-chat watcher failed', error)) as unknown as () => void;
  return unsubscribe;
}

function normalizeMessage(value: Record<string, unknown>): SupportMessage {
  return {
    id: String(value.id || ''),
    ticketId: String(value.ticketId || ''),
    authorId: value.authorId ? String(value.authorId) : undefined,
    authorType: (['customer', 'admin', 'system'].includes(String(value.authorType)) ? String(value.authorType) : 'customer') as SupportMessage['authorType'],
    message: String(value.message || ''),
    internal: Boolean(value.internal),
    createdAt: String(value.createdAt || '')
  };
}

export class RtdbLiveChatDb implements LiveChatDb {
  readonly backend: LiveChatBackend = 'firebase-realtime-db';
  private dbHandle?: Database;

  /** The database handle is injectable so the adapter can be exercised without live credentials. */
  constructor(private readonly injectedDb?: Database) {}

  /** Resolved lazily so a bad credential degrades chat to a 503 instead of crashing startup. */
  private get db(): Database {
    if (this.injectedDb) return this.injectedDb;
    if (!this.dbHandle) this.dbHandle = firebaseRealtimeDatabase();
    return this.dbHandle;
  }

  private sessionRef(id: string): Reference {
    return this.db.ref(`${SESSIONS_ROOT}/${id}`);
  }

  private messagesRef(ticketId: string): Reference {
    return this.db.ref(`${MESSAGES_ROOT}/${ticketId}`);
  }

  private async readSession(id: string): Promise<SupportTicket | undefined> {
    const snapshot: DataSnapshot = await this.sessionRef(id).get();
    if (!snapshot.exists()) return undefined;
    return normalizeSession(snapshot.val() as Record<string, unknown>);
  }

  async createSession(ticket: SupportTicket): Promise<SupportTicket> {
    await this.sessionRef(ticket.id).set(stripUndefined(ticket));
    return ticket;
  }

  async findSession(id: string): Promise<SupportTicket | undefined> {
    return this.readSession(id);
  }

  async listSessions(): Promise<SupportTicket[]> {
    const snapshot: DataSnapshot = await this.db.ref(SESSIONS_ROOT).get();
    const value = snapshot.val();
    if (!value) return [];
    return Object.keys(value)
      .map(key => normalizeSession((value as Record<string, Record<string, unknown>>)[key]))
      .filter(session => Boolean(session.id))
      .sort((a, b) => (b.lastMessageAt || b.createdAt).localeCompare(a.lastMessageAt || a.createdAt));
  }

  async updateSession(id: string, patch: SessionPatch): Promise<SupportTicket | undefined> {
    const changes = stripUndefined(patch) as Record<string, unknown>;
    if (Object.keys(changes).length > 0) {
      changes.updatedAt = now();
      await this.sessionRef(id).update(changes);
    }
    return this.readSession(id);
  }

  async incrementUnread(id: string, audience: 'admin' | 'customer'): Promise<SupportTicket | undefined> {
    const field = audience === 'admin' ? 'adminUnread' : 'customerUnread';
    const result = await this.sessionRef(id).transaction(current => {
      if (!current) return null; // conversation disappeared mid-write; do nothing
      const time = now();
      return { ...(current as Record<string, unknown>), [field]: Number((current as Record<string, unknown>)[field] || 0) + 1, lastMessageAt: time, updatedAt: time };
    });
    if (!result.committed || !result.snapshot.exists()) return undefined;
    return normalizeSession(result.snapshot.val() as Record<string, unknown>);
  }

  async markRead(id: string, audience: 'admin' | 'customer'): Promise<SupportTicket | undefined> {
    return this.updateSession(id, audience === 'admin' ? { adminUnread: 0 } : { customerUnread: 0 });
  }

  async setPresence(id: string, online: boolean): Promise<void> {
    await this.sessionRef(id).update({ online });
  }

  async createMessage(input: { ticketId: string; authorId?: string; authorType: 'customer' | 'admin' | 'system'; message: string; internal: boolean }): Promise<SupportMessage> {
    const message: SupportMessage = {
      id: randomUUID(),
      ticketId: input.ticketId,
      authorId: input.authorId,
      authorType: input.authorType,
      message: input.message,
      internal: input.internal,
      createdAt: now()
    };
    const pushRef = this.messagesRef(input.ticketId).push();
    await pushRef.set(stripUndefined(message));
    return message;
  }

  async listMessages(ticketId: string): Promise<SupportMessage[]> {
    const snapshot: DataSnapshot = await this.messagesRef(ticketId).get();
    const value = snapshot.val();
    if (!value) return [];
    // Storage (push) keys are time-ordered by Realtime Database, so they break
    // ties between messages stamped in the same millisecond.
    return Object.entries(value as Record<string, Record<string, unknown>>)
      .map(([key, entry]) => ({ key, message: normalizeMessage(entry) }))
      .filter(entry => Boolean(entry.message.id))
      .sort((a, b) => a.message.createdAt.localeCompare(b.message.createdAt) || a.key.localeCompare(b.key))
      .map(entry => entry.message);
  }

  watchSessions(callback: (session: SupportTicket, event: 'created' | 'changed' | 'removed', previous?: SupportTicket) => void): () => void {
    const root = this.db.ref(SESSIONS_ROOT);
    const latest = new Map<string, SupportTicket>();
    const listeners = [
      subscribe(root, 'child_added', snapshot => {
        const session = normalizeSession(snapshot.val() as Record<string, unknown>);
        latest.set(session.id, session);
        callback(session, 'created', undefined);
      }),
      subscribe(root, 'child_changed', snapshot => {
        const session = normalizeSession(snapshot.val() as Record<string, unknown>);
        const previous = latest.get(session.id);
        latest.set(session.id, session);
        callback(session, 'changed', previous);
      }),
      subscribe(root, 'child_removed', snapshot => {
        const session = normalizeSession(snapshot.val() as Record<string, unknown>);
        latest.delete(session.id);
        callback(session, 'removed', undefined);
      })
    ];
    return () => {
      listeners.forEach(stop => stop());
      latest.clear();
    };
  }

  watchMessages(ticketId: string, callback: (message: SupportMessage) => void): () => void {
    return subscribe(this.messagesRef(ticketId), 'child_added', snapshot => {
      callback(normalizeMessage(snapshot.val() as Record<string, unknown>));
    });
  }
}

class MongoLiveChatDb implements LiveChatDb {
  readonly backend: LiveChatBackend = 'mongodb';

  constructor(private readonly store: Store) {}

  async createSession(ticket: SupportTicket): Promise<SupportTicket> {
    return this.store.createSupportTicket({ ...ticket, source: 'live_chat' });
  }

  async findSession(id: string): Promise<SupportTicket | undefined> {
    const ticket = await this.store.findSupportTicket(id);
    return ticket && ticket.source === 'live_chat' ? ticket : undefined;
  }

  async listSessions(): Promise<SupportTicket[]> {
    return this.store.listSupportTickets({ source: 'live_chat' });
  }

  async updateSession(id: string, patch: SessionPatch): Promise<SupportTicket | undefined> {
    return this.store.updateSupportTicket(id, patch);
  }

  async incrementUnread(id: string, audience: 'admin' | 'customer'): Promise<SupportTicket | undefined> {
    return this.store.incrementSupportUnread(id, audience);
  }

  async markRead(id: string, audience: 'admin' | 'customer'): Promise<SupportTicket | undefined> {
    return this.store.markSupportRead(id, audience);
  }

  async setPresence(): Promise<void> {
    // Presence is socket-driven in MongoDB mode; nothing to persist.
  }

  async createMessage(input: { ticketId: string; authorId?: string; authorType: 'customer' | 'admin' | 'system'; message: string; internal: boolean }): Promise<SupportMessage> {
    return this.store.createSupportMessage(input);
  }

  async listMessages(ticketId: string): Promise<SupportMessage[]> {
    return this.store.listSupportMessages(ticketId);
  }

  watchSessions(): () => void {
    // No cross-process fan-out in MongoDB mode; the hub emits explicitly.
    return () => undefined;
  }

  watchMessages(): () => void {
    return () => undefined;
  }
}

export function createLiveChatDb(store: Store): LiveChatDb {
  if (isFirebaseDatabaseConfigured()) return new RtdbLiveChatDb();
  return new MongoLiveChatDb(store);
}
