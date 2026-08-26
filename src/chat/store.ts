/**
 * Live chat storage adapters.
 *
 * - `RtdbChatStore` persists conversations and transcripts in Firebase
 *   Realtime Database through the Admin SDK (bypasses security rules; browsers
 *   access the same nodes through the rules in `database.rules.json`).
 * - `MongoChatStore` keeps the same documents in MongoDB for local development
 *   and test environments without Firebase credentials. Real-time delivery in
 *   that mode is fan-out over Socket.IO (still event-driven, never polling).
 */
import { randomUUID } from 'node:crypto';
import mongoose, { Schema } from 'mongoose';
import type { DataSnapshot, Database, Reference } from 'firebase-admin/database';
import { firebaseRealtimeDatabase, isFirebaseDatabaseConfigured } from '../firebase.js';
import { encodeDedupKey, stripUndefined } from './keys.js';
import type { ChatConversation, ChatIdentity, ChatMessage, ChatParticipantProfile } from './types.js';

export type ChatStoreBackend = 'firebase-realtime-db' | 'mongodb';

export type ConversationEvent = 'created' | 'changed' | 'removed';

export interface ChatStore {
  readonly backend: ChatStoreBackend;
  saveIdentity(identity: ChatIdentity): Promise<void>;
  findIdentity(uid: string): Promise<ChatIdentity | undefined>;
  createConversation(conversation: ChatConversation): Promise<void>;
  findConversation(id: string): Promise<ChatConversation | undefined>;
  findConversationIdByDedupKey(dedupKey: string): Promise<string | undefined>;
  listConversationsForUser(uid: string): Promise<ChatConversation[]>;
  listAllConversations(): Promise<ChatConversation[]>;
  listConversationsForContextIds(contextIds: string[]): Promise<ChatConversation[]>;
  /** Appends the message and updates conversation lastMessage/updatedAt/unread atomically per store. */
  appendMessage(message: ChatMessage, unreadUids: string[]): Promise<void>;
  listMessages(conversationId: string): Promise<ChatMessage[]>;
  markRead(conversationId: string, uid: string, at: number): Promise<void>;
  ensureParticipant(conversationId: string, profile: ChatParticipantProfile): Promise<void>;
  /** Refreshes the per-user inbox index (no-op in MongoDB mode, which queries directly). */
  ensureUserConversationIndex(uids: string[], conversationId: string, updatedAt: number): Promise<void>;
  /** Live subscriptions used for server-side fan-out; return unsubscribe functions. */
  watchConversations(callback: (conversation: ChatConversation, event: ConversationEvent) => void): () => void;
  watchMessages(conversationId: string, callback: (message: ChatMessage) => void): () => void;
}

const now = () => Date.now();

function normalizeConversation(value: Record<string, unknown> | null | undefined): ChatConversation | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const id = String((value as any).id || '');
  if (!id) return undefined;
  const reads = (value as any).reads || {};
  const unread = (value as any).unread || {};
  return {
    id,
    type: (['hotel', 'tour', 'home_stay', 'travel_agent', 'support'].includes(String((value as any).type)) ? String((value as any).type) : 'support') as ChatConversation['type'],
    contextId: (value as any).contextId ? String((value as any).contextId) : undefined,
    hotelId: (value as any).hotelId ? String((value as any).hotelId) : undefined,
    dedupKey: (value as any).dedupKey ? String((value as any).dedupKey) : undefined,
    label: (value as any).label ? String((value as any).label) : undefined,
    imageUrl: (value as any).imageUrl ? String((value as any).imageUrl) : undefined,
    participants: Object.fromEntries(Object.keys((value as any).participants || {}).map(uid => [uid, true as const])),
    profiles: ((value as any).profiles || {}) as Record<string, ChatParticipantProfile>,
    lastMessage: (value as any).lastMessage ? { ...(value as any).lastMessage } : undefined,
    reads: Object.fromEntries(Object.entries(reads).map(([uid, at]) => [uid, Number(at) || 0])),
    unread: Object.fromEntries(Object.entries(unread).map(([uid, count]) => [uid, Math.max(0, Number(count) || 0)])),
    createdAt: Number((value as any).createdAt) || now(),
    updatedAt: Number((value as any).updatedAt) || Number((value as any).createdAt) || now()
  };
}

function normalizeMessage(value: Record<string, unknown> | null | undefined): ChatMessage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const id = String((value as any).id || '');
  if (!id) return undefined;
  return {
    id,
    conversationId: String((value as any).conversationId || ''),
    senderId: String((value as any).senderId || ''),
    senderRole: (['customer', 'guest', 'hotel_owner', 'home_owner', 'travel_agent', 'support', 'system'].includes(String((value as any).senderRole)) ? String((value as any).senderRole) : 'customer') as ChatMessage['senderRole'],
    text: String((value as any).text || ''),
    type: 'text',
    sentAt: Number((value as any).sentAt) || now()
  };
}

function sortConversations(list: ChatConversation[]): ChatConversation[] {
  return list.sort((a, b) => (b.lastMessage?.sentAt || b.updatedAt) - (a.lastMessage?.sentAt || a.updatedAt));
}

function sortMessages(list: ChatMessage[]): ChatMessage[] {
  return list.sort((a, b) => a.sentAt - b.sentAt || a.id.localeCompare(b.id));
}

function subscribe(ref: Reference, event: 'child_added' | 'child_changed' | 'child_removed', handler: (snapshot: DataSnapshot) => void): () => void {
  const unsubscribe = ref.on(event, handler, (error: Error) => console.error('chat watcher failed', error)) as unknown as () => void;
  return unsubscribe;
}

export class RtdbChatStore implements ChatStore {
  readonly backend: ChatStoreBackend = 'firebase-realtime-db';
  private dbHandle?: Database;

  /** Injectable so the adapter can be exercised without live credentials. */
  constructor(private readonly injectedDb?: Database) {}

  private get db(): Database {
    if (this.injectedDb) return this.injectedDb;
    if (!this.dbHandle) this.dbHandle = firebaseRealtimeDatabase();
    return this.dbHandle;
  }

  private conversationRef(id: string): Reference {
    return this.db.ref(`conversations/${id}`);
  }

  private messagesRef(conversationId: string): Reference {
    return this.db.ref(`messages/${conversationId}`);
  }

  async saveIdentity(identity: ChatIdentity): Promise<void> {
    await this.db.ref(`chatIdentities/${identity.uid}`).set(stripUndefined(identity));
  }

  async findIdentity(uid: string): Promise<ChatIdentity | undefined> {
    const snapshot = await this.db.ref(`chatIdentities/${uid}`).get();
    return snapshot.exists() ? (snapshot.val() as ChatIdentity) : undefined;
  }

  async createConversation(conversation: ChatConversation): Promise<void> {
    const updates: Record<string, unknown> = {
      [`conversations/${conversation.id}`]: stripUndefined(conversation)
    };
    if (conversation.dedupKey) updates[`conversationKeys/${encodeDedupKey(conversation.dedupKey)}`] = conversation.id;
    for (const uid of Object.keys(conversation.participants || {})) {
      updates[`userConversations/${uid}/${conversation.id}`] = conversation.updatedAt;
    }
    await this.db.ref('/').update(updates);
  }

  async findConversation(id: string): Promise<ChatConversation | undefined> {
    const snapshot = await this.conversationRef(id).get();
    return snapshot.exists() ? normalizeConversation(snapshot.val()) : undefined;
  }

  async findConversationIdByDedupKey(dedupKey: string): Promise<string | undefined> {
    const snapshot = await this.db.ref(`conversationKeys/${encodeDedupKey(dedupKey)}`).get();
    return snapshot.exists() ? String(snapshot.val()) : undefined;
  }

  async listConversationsForUser(uid: string): Promise<ChatConversation[]> {
    const indexSnapshot = await this.db.ref(`userConversations/${uid}`).get();
    if (!indexSnapshot.exists()) return [];
    const ids = Object.keys(indexSnapshot.val() as Record<string, unknown>);
    const conversations = await Promise.all(ids.map(id => this.findConversation(id)));
    return sortConversations(conversations.filter((conversation): conversation is ChatConversation => Boolean(conversation)));
  }

  async listAllConversations(): Promise<ChatConversation[]> {
    const snapshot = await this.db.ref('conversations').get();
    const value = snapshot.val();
    if (!value) return [];
    return sortConversations(Object.values(value as Record<string, Record<string, unknown>>)
      .map(normalizeConversation)
      .filter((conversation): conversation is ChatConversation => Boolean(conversation)));
  }

  async listConversationsForContextIds(contextIds: string[]): Promise<ChatConversation[]> {
    if (!contextIds.length) return [];
    const wanted = new Set(contextIds);
    const all = await this.listAllConversations();
    return all.filter(conversation => conversation.contextId && wanted.has(conversation.contextId));
  }

  async appendMessage(message: ChatMessage, unreadUids: string[]): Promise<void> {
    const updates: Record<string, unknown> = {
      [`messages/${message.conversationId}/${message.id}`]: stripUndefined({ ...message }),
      [`conversations/${message.conversationId}/lastMessage`]: stripUndefined({ text: message.text, senderId: message.senderId, senderRole: message.senderRole, sentAt: message.sentAt }),
      [`conversations/${message.conversationId}/updatedAt`]: message.sentAt
    };
    await this.db.ref('/').update(updates);
    // unread counters must increment, not overwrite: use a transaction per counter.
    await Promise.all(unreadUids.map(uid => this.db.ref(`conversations/${message.conversationId}/unread/${uid}`).transaction((current: unknown) => Number(current || 0) + 1)));
  }

  async listMessages(conversationId: string): Promise<ChatMessage[]> {
    const snapshot = await this.messagesRef(conversationId).get();
    const value = snapshot.val();
    if (!value) return [];
    return sortMessages(Object.values(value as Record<string, Record<string, unknown>>)
      .map(normalizeMessage)
      .filter((message): message is ChatMessage => Boolean(message)));
  }

  async markRead(conversationId: string, uid: string, at: number): Promise<void> {
    await this.db.ref(`conversations/${conversationId}`).update({ [`reads/${uid}`]: at, [`unread/${uid}`]: 0 });
  }

  async ensureParticipant(conversationId: string, profile: ChatParticipantProfile): Promise<void> {
    await this.db.ref(`conversations/${conversationId}`).update({
      [`participants/${profile.uid}`]: true,
      [`profiles/${profile.uid}`]: stripUndefined(profile)
    });
    await this.db.ref(`userConversations/${profile.uid}/${conversationId}`).set(now());
  }

  async ensureUserConversationIndex(uids: string[], conversationId: string, updatedAt: number): Promise<void> {
    const updates: Record<string, unknown> = {};
    for (const uid of uids) updates[`userConversations/${uid}/${conversationId}`] = updatedAt;
    if (Object.keys(updates).length) await this.db.ref('/').update(updates);
  }

  watchConversations(callback: (conversation: ChatConversation, event: ConversationEvent) => void): () => void {
    const root = this.db.ref('conversations');
    const handle = (event: ConversationEvent) => (snapshot: DataSnapshot) => {
      const conversation = normalizeConversation(snapshot.val() as Record<string, unknown>);
      if (conversation) callback(conversation, event);
    };
    const listeners = [
      subscribe(root, 'child_added', handle('created')),
      subscribe(root, 'child_changed', handle('changed')),
      subscribe(root, 'child_removed', (snapshot: DataSnapshot) => {
        callback({ id: snapshot.key || '' } as ChatConversation, 'removed');
      })
    ];
    return () => listeners.forEach(stop => stop());
  }

  watchMessages(conversationId: string, callback: (message: ChatMessage) => void): () => void {
    return subscribe(this.messagesRef(conversationId), 'child_added', snapshot => {
      const message = normalizeMessage(snapshot.val() as Record<string, unknown>);
      if (message) callback(message);
    });
  }
}

/* ------------------------------------------------------------------ */
/* MongoDB fallback                                                    */
/* ------------------------------------------------------------------ */

const ConversationModel = mongoose.models.SadikChatConversation
  || mongoose.model('SadikChatConversation', new Schema({
    id: { type: String, required: true, unique: true, index: true },
    type: { type: String, index: true },
    contextId: { type: String, index: true },
    hotelId: { type: String, index: true },
    dedupKey: { type: String, unique: true, sparse: true, index: true },
    label: String,
    imageUrl: String,
    participants: Schema.Types.Mixed,
    profiles: Schema.Types.Mixed,
    lastMessage: Schema.Types.Mixed,
    reads: Schema.Types.Mixed,
    unread: Schema.Types.Mixed,
    createdAt: Number,
    updatedAt: { type: Number, index: true }
  }, { versionKey: false, strict: false, collection: 'chat_conversations' }));

const MessageModel = mongoose.models.SadikChatMessage
  || mongoose.model('SadikChatMessage', new Schema({
    id: { type: String, required: true, unique: true, index: true },
    conversationId: { type: String, index: true },
    senderId: String,
    senderRole: String,
    text: String,
    type: String,
    sentAt: Number,
    clientRef: String
  }, { versionKey: false, strict: false, collection: 'chat_messages' }));

const IdentityModel = mongoose.models.SadikChatIdentity
  || mongoose.model('SadikChatIdentity', new Schema({
    uid: { type: String, required: true, unique: true, index: true },
    kind: String,
    name: String,
    photoUrl: String,
    role: String,
    roleLabel: String,
    userId: { type: String, index: true },
    contact: String,
    secretHash: String,
    createdAt: Number
  }, { versionKey: false, strict: false, collection: 'chat_identities' }));

function mongoToConversation(doc: Record<string, unknown> | null): ChatConversation | undefined {
  if (!doc) return undefined;
  const { _id, __v, ...value } = doc as Record<string, unknown>;
  return normalizeConversation(value as Record<string, unknown>);
}

export class MongoChatStore implements ChatStore {
  readonly backend: ChatStoreBackend = 'mongodb';

  async saveIdentity(identity: ChatIdentity): Promise<void> {
    await IdentityModel.findOneAndUpdate({ uid: identity.uid }, { $set: { ...identity } }, { upsert: true, overwrite: true });
  }

  async findIdentity(uid: string): Promise<ChatIdentity | undefined> {
    const doc = await IdentityModel.findOne({ uid }).lean();
    if (!doc) return undefined;
    const { _id, __v, ...value } = doc as Record<string, unknown>;
    return value as ChatIdentity;
  }

  async createConversation(conversation: ChatConversation): Promise<void> {
    await ConversationModel.findOneAndUpdate({ id: conversation.id }, { $set: { ...conversation } as any }, { upsert: true, overwrite: true });
  }

  async findConversation(id: string): Promise<ChatConversation | undefined> {
    return mongoToConversation((await ConversationModel.findOne({ id }).lean()) as Record<string, unknown> | null);
  }

  async findConversationIdByDedupKey(dedupKey: string): Promise<string | undefined> {
    const doc = await ConversationModel.findOne({ dedupKey }).lean();
    return doc ? String((doc as any).id) : undefined;
  }

  async listConversationsForUser(uid: string): Promise<ChatConversation[]> {
    const docs = await ConversationModel.find({ [`participants.${uid}`]: true }).lean();
    return sortConversations(docs.map(doc => mongoToConversation(doc as Record<string, unknown>)).filter((c): c is ChatConversation => Boolean(c)));
  }

  async listAllConversations(): Promise<ChatConversation[]> {
    const docs = await ConversationModel.find({}).lean();
    return sortConversations(docs.map(doc => mongoToConversation(doc as Record<string, unknown>)).filter((c): c is ChatConversation => Boolean(c)));
  }

  async listConversationsForContextIds(contextIds: string[]): Promise<ChatConversation[]> {
    if (!contextIds.length) return [];
    const docs = await ConversationModel.find({ contextId: { $in: contextIds } }).lean();
    return sortConversations(docs.map(doc => mongoToConversation(doc as Record<string, unknown>)).filter((c): c is ChatConversation => Boolean(c)));
  }

  async appendMessage(message: ChatMessage, unreadUids: string[]): Promise<void> {
    await MessageModel.create({ ...message });
    const unreadInc: Record<string, number> = {};
    for (const uid of unreadUids) unreadInc[`unread.${uid}`] = 1;
    await ConversationModel.findOneAndUpdate(
      { id: message.conversationId },
      { $set: { lastMessage: { text: message.text, senderId: message.senderId, senderRole: message.senderRole, sentAt: message.sentAt }, updatedAt: message.sentAt }, $inc: unreadInc }
    );
  }

  async listMessages(conversationId: string): Promise<ChatMessage[]> {
    const docs = await MessageModel.find({ conversationId }).lean();
    return sortMessages(docs.map(doc => normalizeMessage(doc as Record<string, unknown>)).filter((m): m is ChatMessage => Boolean(m)));
  }

  async markRead(conversationId: string, uid: string, at: number): Promise<void> {
    await ConversationModel.findOneAndUpdate({ id: conversationId }, { $set: { [`reads.${uid}`]: at, [`unread.${uid}`]: 0 } });
  }

  async ensureParticipant(conversationId: string, profile: ChatParticipantProfile): Promise<void> {
    await ConversationModel.findOneAndUpdate(
      { id: conversationId },
      { $set: { [`participants.${profile.uid}`]: true, [`profiles.${profile.uid}`]: profile, updatedAt: now() } }
    );
  }

  async ensureUserConversationIndex(): Promise<void> {
    // MongoDB queries conversations directly; the index is RTDB-only.
  }

  watchConversations(): () => void {
    // Cross-process fan-out requires change streams; single-process deployments
    // use the hub's explicit broadcasts. Firebase is the production realtime path.
    return () => undefined;
  }

  watchMessages(): () => void {
    return () => undefined;
  }
}

export function createChatStore(): ChatStore {
  if (isFirebaseDatabaseConfigured()) return new RtdbChatStore();
  return new MongoChatStore();
}
