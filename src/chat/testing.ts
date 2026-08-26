/**
 * In-memory ChatStore used by the automated realtime tests and the sandbox
 * demo server (`npm run demo`). It implements exactly the same contract as the
 * Firebase Realtime Database and MongoDB adapters.
 */
import type { ConversationEvent, ChatStore } from './store.js';
import type { ChatConversation, ChatIdentity, ChatMessage, ChatParticipantProfile } from './types.js';
import { encodeDedupKey } from './keys.js';

type Listener = (conversation: ChatConversation, event: ConversationEvent) => void;

export class MemoryChatStore implements ChatStore {
  readonly backend = 'mongodb' as const;
  private identities = new Map<string, ChatIdentity>();
  private conversations = new Map<string, ChatConversation>();
  private messages = new Map<string, Map<string, ChatMessage>>();
  private inboxIndex = new Map<string, Map<string, number>>();
  private dedupIndex = new Map<string, string>();
  private conversationListeners = new Set<Listener>();

  async saveIdentity(identity: ChatIdentity): Promise<void> {
    this.identities.set(identity.uid, { ...identity });
  }

  async findIdentity(uid: string): Promise<ChatIdentity | undefined> {
    const identity = this.identities.get(uid);
    return identity ? { ...identity } : undefined;
  }

  async createConversation(conversation: ChatConversation): Promise<void> {
    this.conversations.set(conversation.id, JSON.parse(JSON.stringify(conversation)));
    if (conversation.dedupKey) this.dedupIndex.set(encodeDedupKey(conversation.dedupKey), conversation.id);
    for (const uid of Object.keys(conversation.participants || {})) {
      const index = this.inboxIndex.get(uid) || new Map<string, number>();
      index.set(conversation.id, conversation.updatedAt);
      this.inboxIndex.set(uid, index);
    }
    for (const listener of this.conversationListeners) listener(this.conversations.get(conversation.id)!, 'created');
  }

  async findConversation(id: string): Promise<ChatConversation | undefined> {
    const conversation = this.conversations.get(id);
    return conversation ? JSON.parse(JSON.stringify(conversation)) : undefined;
  }

  async findConversationIdByDedupKey(dedupKey: string): Promise<string | undefined> {
    return this.dedupIndex.get(encodeDedupKey(dedupKey));
  }

  private save(conversation: ChatConversation, event: ConversationEvent = 'changed'): void {
    this.conversations.set(conversation.id, JSON.parse(JSON.stringify(conversation)));
    for (const listener of this.conversationListeners) listener(conversation, event);
  }

  async listConversationsForUser(uid: string): Promise<ChatConversation[]> {
    const index = this.inboxIndex.get(uid);
    if (!index) return [];
    const list: ChatConversation[] = [];
    for (const id of index.keys()) {
      const conversation = await this.findConversation(id);
      if (conversation) list.push(conversation);
    }
    return list;
  }

  async listAllConversations(): Promise<ChatConversation[]> {
    const list: ChatConversation[] = [];
    for (const id of this.conversations.keys()) {
      const conversation = await this.findConversation(id);
      if (conversation) list.push(conversation);
    }
    return list;
  }

  async listConversationsForContextIds(contextIds: string[]): Promise<ChatConversation[]> {
    const wanted = new Set(contextIds);
    const list: ChatConversation[] = [];
    for (const conversation of await this.listAllConversations()) {
      if (conversation.contextId && wanted.has(conversation.contextId)) list.push(conversation);
    }
    return list;
  }

  async appendMessage(message: ChatMessage, unreadUids: string[]): Promise<void> {
    const bucket = this.messages.get(message.conversationId) || new Map<string, ChatMessage>();
    bucket.set(message.id, { ...message });
    this.messages.set(message.conversationId, bucket);
    const conversation = this.conversations.get(message.conversationId);
    if (conversation) {
      conversation.lastMessage = { text: message.text, senderId: message.senderId, senderRole: message.senderRole, sentAt: message.sentAt };
      conversation.updatedAt = message.sentAt;
      for (const uid of unreadUids) conversation.unread = { ...(conversation.unread || {}), [uid]: Number(conversation.unread?.[uid] || 0) + 1 };
      this.save(conversation);
    }
  }

  async listMessages(conversationId: string): Promise<ChatMessage[]> {
    const bucket = this.messages.get(conversationId);
    if (!bucket) return [];
    return [...bucket.values()].sort((a, b) => a.sentAt - b.sentAt || a.id.localeCompare(b.id)).map(message => ({ ...message }));
  }

  async markRead(conversationId: string, uid: string, at: number): Promise<void> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return;
    conversation.reads = { ...(conversation.reads || {}), [uid]: at };
    conversation.unread = { ...(conversation.unread || {}), [uid]: 0 };
    this.save(conversation);
  }

  async ensureParticipant(conversationId: string, profile: ChatParticipantProfile): Promise<void> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return;
    conversation.participants = { ...conversation.participants, [profile.uid]: true as const };
    conversation.profiles = { ...(conversation.profiles || {}), [profile.uid]: profile };
    const index = this.inboxIndex.get(profile.uid) || new Map<string, number>();
    index.set(conversationId, Date.now());
    this.inboxIndex.set(profile.uid, index);
    this.save(conversation);
  }

  async ensureUserConversationIndex(uids: string[], conversationId: string, updatedAt: number): Promise<void> {
    for (const uid of uids) {
      const index = this.inboxIndex.get(uid) || new Map<string, number>();
      index.set(conversationId, updatedAt);
      this.inboxIndex.set(uid, index);
    }
  }

  watchConversations(callback: Listener): () => void {
    this.conversationListeners.add(callback);
    return () => this.conversationListeners.delete(callback);
  }

  watchMessages(): () => void {
    return () => undefined;
  }
}
