/**
 * Messenger-style live chat domain types.
 *
 * The Realtime Database is the real-time source of truth (when Firebase is
 * configured). Every conversation carries a stable context (`type` +
 * `contextId`, e.g. `hotel` + hotel UUID) so the owning hotel owner can be
 * resolved from the database relationship — never from names or emails.
 *
 * Realtime Database layout (see database.rules.json for the security rules):
 *
 *   conversations/$cid            — metadata; server-managed fields plus a few
 *     type, contextId, hotelId?     participant-writable children (reads,
 *     label, imageUrl, createdAt    lastMessage, unread, updatedAt).
 *     participants/{uid}=true
 *     profiles/{uid}={...}          — denormalized display profiles
 *     lastMessage/{text,senderId,senderRole,sentAt}
 *     reads/{uid}=timestamp         — own read receipts only
 *     unread/{uid}=count            — others may increment, only own may reset
 *   userConversations/$uid/$cid=updatedAt — per-user inbox index (server-managed)
 *   messages/$cid/$mid            — append-only messages (participant writes)
 *   typing/$cid/$uid=timestamp    — ephemeral typing indicator
 *   presence/$uid={online,lastSeen}
 *   chatIdentities/$uid           — server-only identity registry (guest secrets)
 *   conversationKeys/$dedupKey=$cid — server-only duplicate-prevention lookup
 */

export type ChatConversationType = 'hotel' | 'tour' | 'home_stay' | 'travel_agent' | 'support';

export type ChatSenderRole = 'customer' | 'guest' | 'hotel_owner' | 'home_owner' | 'travel_agent' | 'support' | 'system';

export type ChatIdentityKind = 'customer' | 'guest' | 'staff';

/** Display profile denormalized into the conversation so participants can render each other. */
export type ChatParticipantProfile = {
  uid: string;
  kind: ChatIdentityKind;
  name: string;
  photoUrl?: string;
  /** Platform role for staff accounts (e.g. `hotel_owner`). */
  role?: string;
  /** Display label shown in the chat header (e.g. `Hotel Owner`). */
  roleLabel?: string;
  /** Site account id, when the participant is registered. */
  userId?: string;
  /** Optional contact shown to staff only (customer email/phone). */
  contact?: string;
};

export type ChatConversation = {
  id: string;
  type: ChatConversationType;
  /** Stable resource id for the context (hotel id, tour id, ...). */
  contextId?: string;
  hotelId?: string;
  /** Deterministic `${type}:${contextId}:${customerUid}` duplicate guard. */
  dedupKey?: string;
  /** Human label for the context (hotel/tour name). */
  label?: string;
  imageUrl?: string;
  participants: Record<string, true>;
  profiles: Record<string, ChatParticipantProfile>;
  lastMessage?: { text: string; senderId: string; senderRole: ChatSenderRole; sentAt: number };
  reads?: Record<string, number>;
  unread?: Record<string, number>;
  createdAt: number;
  updatedAt: number;
};

export type ChatMessage = {
  id: string;
  conversationId: string;
  senderId: string;
  senderRole: ChatSenderRole;
  text: string;
  type: 'text';
  sentAt: number;
};

/** A chat identity: how a browser is known to the realtime layer. */
export type ChatIdentity = {
  uid: string;
  kind: ChatIdentityKind;
  name: string;
  photoUrl?: string;
  role?: string;
  roleLabel?: string;
  userId?: string;
  contact?: string;
  /** SHA-256 of the guest secret; never returned to clients after creation. */
  secretHash?: string;
  createdAt: number;
};

/** Viewer context resolved from the authenticated request / socket. */
export type ChatViewer = {
  identity: ChatIdentity;
  /** Platform account, when the viewer is signed in (customer, owner, staff). */
  user?: { id: string; role: string; fullName?: string; avatarUrl?: string; email?: string; phone?: string; permissions?: string[] };
  /** True for accounts allowed to moderate all chats (support.view permission). */
  supportStaff: boolean;
  /** True for vendor accounts (hotel_owner/home_owner/travel_agent). */
  vendor: boolean;
};

/** REST view of a conversation (never leaks secret hashes). */
export type ChatConversationView = {
  id: string;
  type: ChatConversationType;
  contextId?: string;
  hotelId?: string;
  label?: string;
  imageUrl?: string;
  createdAt: number;
  updatedAt: number;
  participants: string[];
  profiles: Record<string, ChatParticipantProfile>;
  lastMessage?: ChatConversation['lastMessage'];
  reads?: Record<string, number>;
  unread: Record<string, number>;
  /** Unread count for the requesting viewer. */
  unreadForViewer: number;
  otherParticipant?: ChatParticipantProfile;
};
