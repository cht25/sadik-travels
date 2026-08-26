/**
 * Chat service — the authorization and orchestration core of the live chat.
 *
 * Security invariants (see database.rules.json for the mirrored RTDB rules):
 *  - Chat identities are derived from authenticated state, never trusted from
 *    the browser: registered accounts map to `u-<userId>`/`s-<userId>`, guests
 *    to server-issued `g-<uid>` credentials verified by hashed secret.
 *  - Conversation context (`type` + `contextId`) is resolved server-side. The
 *    hotel owner participant is looked up from `hotel.ownerId` — the stable
 *    database relationship — never from names, emails or phone numbers.
 *  - Hotel owners can list/open/message only conversations for hotels they
 *    own. Support staff (fine `support.view` permission) can act on all.
 *  - Duplicate prevention is deterministic: `type:contextId:customerUid`.
 */
import { randomUUID } from 'node:crypto';
import { AppError } from '../errors.js';
import type { User } from '../store.js';
import { chatUidForUser, conversationDedupKey, hashGuestSecret, newGuestSecret, newGuestUid, parseIdentityCredentials, verifyGuestSecret } from './keys.js';
import type { ChatDirectory } from './directory.js';
import type { ChatStore } from './store.js';
import type { ChatConversation, ChatConversationType, ChatConversationView, ChatIdentity, ChatMessage, ChatParticipantProfile, ChatViewer } from './types.js';

export const SUPPORT_TEAM_PROFILE_UID = 'support-team';

const CONVERSATION_TYPES: ChatConversationType[] = ['hotel', 'tour', 'home_stay', 'travel_agent', 'support'];

const MESSAGE_MIN = 1;
const MESSAGE_MAX = 4000;

/** Public web config + custom-token minting for the browser Firebase transport. */
export type FirebaseChatBridge = {
  webConfig: Record<string, string>;
  databaseUrl: string;
  mintToken(uid: string, claims: Record<string, string | boolean>): Promise<string>;
};

export type BootstrapResult = {
  identity: ChatIdentity;
  /** Present for guests so the browser can persist its chat credentials. */
  credentials?: { uid: string; secret: string };
  realtime: 'firebase' | 'socket';
  firebase?: { config: Record<string, string>; databaseUrl: string; authToken: string };
  supportStaff: boolean;
  vendor: boolean;
};

type Deps = {
  store: ChatStore;
  directory: ChatDirectory;
  firebase?: FirebaseChatBridge;
  brandName?: string;
};

type RoleBearing = { role: string; status?: string } | undefined;

export function supportStaffForUser(user: RoleBearing): boolean {
  return Boolean(user && (!user.status || user.status === 'active') && ['super_admin', 'admin', 'manager', 'support', 'staff'].includes(user.role));
}

export function vendorRoleForUser(user: RoleBearing): string | undefined {
  if (!user) return undefined;
  return ['hotel_owner', 'home_owner', 'travel_agent'].includes(user.role) ? user.role : undefined;
}

function senderRoleFor(viewer: ChatViewer): ChatMessage['senderRole'] {
  if (viewer.supportStaff) return 'support';
  const vendor = vendorRoleForUser(viewer.user);
  if (vendor === 'hotel_owner') return 'hotel_owner';
  if (vendor === 'home_owner') return 'home_owner';
  if (vendor === 'travel_agent') return 'travel_agent';
  return 'customer';
}

function profileForIdentity(identity: ChatIdentity): ChatParticipantProfile {
  return {
    uid: identity.uid,
    kind: identity.kind,
    name: identity.name,
    ...(identity.photoUrl ? { photoUrl: identity.photoUrl } : {}),
    ...(identity.role ? { role: identity.role } : {}),
    ...(identity.roleLabel ? { roleLabel: identity.roleLabel } : {}),
    ...(identity.userId ? { userId: identity.userId } : {}),
    ...(identity.contact ? { contact: identity.contact } : {})
  };
}

export class ChatService {
  readonly directory: ChatDirectory;

  constructor(private readonly deps: Deps) {
    this.directory = deps.directory;
  }

  /* ---------------- identity bootstrap ---------------- */

  /** Resolve (or create) the chat identity for a request and mint realtime credentials. */
  async bootstrap(input: { user?: User; guestHeader?: string; profile?: { name?: string; contact?: string } }): Promise<BootstrapResult> {
    const { store, firebase } = this.deps;
    let identity: ChatIdentity | undefined;
    let credentials: { uid: string; secret: string } | undefined;

    if (input.user) {
      const staff = input.user.role !== 'customer';
      const uid = chatUidForUser(input.user.id, staff ? 'staff' : 'customer');
      identity = await store.findIdentity(uid);
      const fresh: ChatIdentity = {
        uid,
        kind: staff ? 'staff' : 'customer',
        name: input.user.fullName || input.user.email || input.user.phone || (staff ? 'Team member' : 'Traveller'),
        ...(input.user.avatarUrl ? { photoUrl: input.user.avatarUrl } : {}),
        ...(staff ? { role: input.user.role, roleLabel: staffRoleLabel(input.user.role) } : {}),
        userId: input.user.id,
        ...(input.user.email || input.user.phone ? { contact: input.user.email || input.user.phone } : {}),
        createdAt: identity?.createdAt || Date.now()
      };
      if (!identity || identity.name !== fresh.name || identity.photoUrl !== fresh.photoUrl) await store.saveIdentity(fresh);
      identity = fresh;
    } else {
      const parsed = parseIdentityCredentials(input.guestHeader);
      if (parsed) {
        const existing = await store.findIdentity(parsed.uid);
        if (existing?.kind === 'guest' && verifyGuestSecret(parsed.secret, existing.secretHash)) {
          identity = existing;
          // Allow the intro form to enrich an existing guest profile.
          const name = input.profile?.name?.trim();
          const contact = input.profile?.contact?.trim();
          if ((name && name !== identity.name) || (contact && contact !== identity.contact)) {
            const updated: ChatIdentity = { ...identity, ...(name ? { name } : {}), ...(contact ? { contact } : {}) };
            await store.saveIdentity(updated);
            identity = updated;
          }
        }
      }
      if (!identity) {
        const uid = newGuestUid();
        const secret = newGuestSecret();
        identity = {
          uid,
          kind: 'guest',
          name: input.profile?.name?.trim() || 'Guest',
          ...(input.profile?.contact ? { contact: input.profile.contact.trim() } : {}),
          secretHash: hashGuestSecret(secret),
          createdAt: Date.now()
        };
        await store.saveIdentity(identity);
        credentials = { uid, secret };
      }
    }

    const supportStaff = supportStaffForUser(input.user);
    const vendor = Boolean(vendorRoleForUser(input.user));
    if (firebase) {
      const authToken = await firebase.mintToken(identity.uid, {
        role: identity.kind === 'staff' ? (identity.role || 'staff') : identity.kind,
        support: supportStaff
      });
      return { identity, credentials, realtime: 'firebase', firebase: { config: firebase.webConfig, databaseUrl: firebase.databaseUrl, authToken }, supportStaff, vendor };
    }
    return { identity, credentials, realtime: 'socket', supportStaff, vendor };
  }

  /** Resolve the viewer (identity + authorization flags) for a request. */
  async resolveViewer(input: { user?: User; guestHeader?: string }): Promise<ChatViewer> {
    const { store } = this.deps;
    if (input.user) {
      const staff = input.user.role !== 'customer';
      const uid = chatUidForUser(input.user.id, staff ? 'staff' : 'customer');
      const identity = (await store.findIdentity(uid)) || {
        uid,
        kind: staff ? 'staff' : 'customer',
        name: input.user.fullName || input.user.email || input.user.phone || 'Traveller',
        userId: input.user.id,
        createdAt: Date.now()
      };
      return {
        identity,
        user: { id: input.user.id, role: input.user.role, fullName: input.user.fullName, avatarUrl: input.user.avatarUrl, email: input.user.email, phone: input.user.phone, permissions: input.user.permissions },
        supportStaff: supportStaffForUser(input.user),
        vendor: Boolean(vendorRoleForUser(input.user))
      };
    }
    const parsed = parseIdentityCredentials(input.guestHeader);
    if (parsed) {
      const identity = await store.findIdentity(parsed.uid);
      if (identity?.kind === 'guest' && verifyGuestSecret(parsed.secret, identity.secretHash)) {
        return { identity, supportStaff: false, vendor: false };
      }
    }
    throw new AppError(401, 'CHAT_IDENTITY_REQUIRED', 'Start the chat session first');
  }

  /* ---------------- conversations ---------------- */

  /**
   * Resolve the conversation context server-side: find the hotel, find its
   * owner from the database relationship, add both as participants.
   */
  private async resolveContext(type: ChatConversationType, contextId: string | undefined): Promise<{
    label?: string; imageUrl?: string; hotelId?: string;
    staffProfiles: ChatParticipantProfile[];
    staffUserIds: string[];
  }> {
    if (!CONVERSATION_TYPES.includes(type)) throw new AppError(400, 'CHAT_CONTEXT_INVALID', 'Unknown conversation type');
    const brand = this.deps.brandName || 'Sadik Travels';
    if (type === 'hotel') {
      if (!contextId) throw new AppError(400, 'CHAT_CONTEXT_INVALID', 'A hotel id is required for hotel chats');
      const hotel = await this.deps.directory.findHotel(contextId);
      if (!hotel) throw new AppError(404, 'HOTEL_NOT_FOUND', 'This hotel is not available for chat');
      let ownerUser: User | undefined;
      if (hotel.ownerId) ownerUser = await this.deps.directory.findUserById(hotel.ownerId);
      if (ownerUser && ownerUser.status === 'active') {
        return {
          label: hotel.name,
          imageUrl: hotel.images?.[0]?.url,
          hotelId: hotel.id,
          staffProfiles: [{
            uid: chatUidForUser(ownerUser.id, 'staff'),
            kind: 'staff',
            name: ownerUser.fullName || hotel.name,
            ...(ownerUser.avatarUrl ? { photoUrl: ownerUser.avatarUrl } : {}),
            role: ownerUser.role,
            roleLabel: 'Hotel Owner',
            userId: ownerUser.id
          }],
          staffUserIds: [ownerUser.id]
        };
      }
      // No active owner account: route to the support team, keeping the hotel context visible.
      return {
        label: hotel.name,
        imageUrl: hotel.images?.[0]?.url,
        hotelId: hotel.id,
        staffProfiles: [{ uid: SUPPORT_TEAM_PROFILE_UID, kind: 'staff', name: `${brand} Support`, roleLabel: 'Support Team' }],
        staffUserIds: await this.deps.directory.listSupportStaffIds()
      };
    }
    // tour / home_stay / travel_agent / support — operator inbox until the
    // matching vendor modules expose owner relationships.
    return {
      staffProfiles: [{ uid: SUPPORT_TEAM_PROFILE_UID, kind: 'staff', name: `${brand} Support`, roleLabel: 'Support Team' }],
      staffUserIds: await this.deps.directory.listSupportStaffIds()
    };
  }

  async findOrCreateConversation(viewer: ChatViewer, input: { type: ChatConversationType; contextId?: string }): Promise<ChatConversation> {
    const customerProfile = profileForIdentity(viewer.identity);
    const context = await this.resolveContext(input.type, input.contextId);
    const dedupKey = conversationDedupKey(input.type, input.contextId || 'general', viewer.identity.uid);

    const existingId = await this.deps.store.findConversationIdByDedupKey(dedupKey);
    if (existingId) {
      const existing = await this.deps.store.findConversation(existingId);
      if (existing) {
        // Keep staff participation in sync (a hotel may be reassigned to a new owner).
        await this.syncStaffParticipation(existing, context);
        return existing;
      }
    }

    const time = Date.now();
    const participants: Record<string, true> = { [viewer.identity.uid]: true };
    const profiles: Record<string, ChatParticipantProfile> = { [viewer.identity.uid]: customerProfile };
    for (const profile of context.staffProfiles) {
      participants[profile.uid] = true;
      profiles[profile.uid] = profile;
    }
    const conversation: ChatConversation = {
      id: randomUUID(),
      type: input.type,
      ...(input.contextId ? { contextId: input.contextId } : {}),
      ...(context.hotelId ? { hotelId: context.hotelId } : {}),
      dedupKey,
      ...(context.label ? { label: context.label } : {}),
      ...(context.imageUrl ? { imageUrl: context.imageUrl } : {}),
      participants,
      profiles,
      reads: { [viewer.identity.uid]: time },
      unread: {},
      createdAt: time,
      updatedAt: time
    };
    await this.deps.store.createConversation(conversation);
    // Support-inbox provisioning: staff are indexed (and join as participants
    // on their first reply). Hotel conversations stay private to the owner.
    if (input.type !== 'hotel' && context.staffUserIds.length) {
      const staffUids: string[] = [];
      for (const userId of context.staffUserIds) {
        const staffUser = await this.deps.directory.findUserById(userId);
        if (staffUser) staffUids.push(chatUidForUser(staffUser.id, 'staff'));
      }
      if (staffUids.length) await this.deps.store.ensureUserConversationIndex([...new Set(staffUids)], conversation.id, time);
    }
    return conversation;
  }

  private async syncStaffParticipation(conversation: ChatConversation, context: Awaited<ReturnType<ChatService['resolveContext']>>): Promise<void> {
    if (conversation.type !== 'hotel') return;
    const existingStaff = Object.values(conversation.profiles || {}).filter(profile => profile.kind === 'staff' && profile.uid !== SUPPORT_TEAM_PROFILE_UID).map(profile => profile.uid);
    const expectedStaff = context.staffProfiles.map(profile => profile.uid);
    if (existingStaff.join(',') === [...expectedStaff].sort().join(',')) return;
    const mergedProfiles = { ...conversation.profiles };
    for (const uid of existingStaff) if (!expectedStaff.includes(uid)) delete mergedProfiles[uid];
    for (const profile of context.staffProfiles) mergedProfiles[profile.uid] = profile;
    const participants = { ...conversation.participants };
    for (const uid of expectedStaff) participants[uid] = true;
    await this.deps.store.createConversation({ ...conversation, participants, profiles: mergedProfiles });
    conversation.participants = participants;
    conversation.profiles = mergedProfiles;
  }

  async listConversations(viewer: ChatViewer): Promise<ChatConversation[]> {
    if (viewer.supportStaff) return this.deps.store.listAllConversations();
    const mine = await this.deps.store.listConversationsForUser(viewer.identity.uid);
    if (viewer.user && viewer.user.role === 'hotel_owner') {
      const hotelIds = await this.deps.directory.listOwnedHotelIds(viewer.user.id);
      const scoped = hotelIds.length ? await this.deps.store.listConversationsForContextIds(hotelIds) : [];
      const seen = new Set(mine.map(conversation => conversation.id));
      for (const conversation of scoped) if (!seen.has(conversation.id)) mine.push(conversation);
    }
    return mine;
  }

  /** Authorization: participants, support staff, or the owning hotel's owner. */
  async assertConversationAccess(viewer: ChatViewer, conversation: ChatConversation, options: { requireParticipant?: boolean } = {}): Promise<void> {
    if (viewer.supportStaff && !options.requireParticipant) return;
    if (conversation.participants?.[viewer.identity.uid]) return;
    if (!options.requireParticipant && viewer.user?.role === 'hotel_owner' && conversation.type === 'hotel' && conversation.hotelId) {
      const owned = await this.deps.directory.listOwnedHotelIds(viewer.user.id);
      if (owned.includes(conversation.hotelId)) return;
    }
    throw new AppError(403, 'CHAT_ACCESS_DENIED', 'This conversation is not available for your account');
  }

  async getConversation(viewer: ChatViewer, conversationId: string): Promise<ChatConversation> {
    const conversation = await this.deps.store.findConversation(conversationId);
    if (!conversation) throw new AppError(404, 'CHAT_NOT_FOUND', 'Conversation not found');
    await this.assertConversationAccess(viewer, conversation);
    return conversation;
  }

  /** Staff opening a conversation join it as a real participant (RTDB rules rely on this). */
  async joinAsStaff(viewer: ChatViewer, conversation: ChatConversation): Promise<void> {
    if (viewer.identity.kind !== 'staff' || conversation.participants?.[viewer.identity.uid]) return;
    const profile = profileForIdentity(viewer.identity);
    await this.deps.store.ensureParticipant(conversation.id, profile);
    conversation.participants = { ...conversation.participants, [viewer.identity.uid]: true };
    conversation.profiles = { ...(conversation.profiles || {}), [viewer.identity.uid]: profile };
  }

  async conversationView(viewer: ChatViewer, conversation: ChatConversation): Promise<ChatConversationView> {
    const profiles = conversation.profiles || {};
    const other = Object.values(profiles).find(profile => profile.uid !== viewer.identity.uid)
      || (conversation.type === 'hotel' ? undefined : { uid: SUPPORT_TEAM_PROFILE_UID, kind: 'staff' as const, name: `${this.deps.brandName || 'Sadik Travels'} Support`, roleLabel: 'Support Team' });
    // For staff viewers of support conversations prefer the customer profile.
    const otherForStaff = viewer.supportStaff || viewer.identity.kind === 'staff'
      ? Object.values(profiles).find(profile => profile.kind === 'customer' || profile.kind === 'guest') || other
      : other;
    return {
      id: conversation.id,
      type: conversation.type,
      ...(conversation.contextId ? { contextId: conversation.contextId } : {}),
      ...(conversation.hotelId ? { hotelId: conversation.hotelId } : {}),
      ...(conversation.label ? { label: conversation.label } : {}),
      ...(conversation.imageUrl ? { imageUrl: conversation.imageUrl } : {}),
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      participants: Object.keys(conversation.participants || {}),
      profiles,
      ...(conversation.lastMessage ? { lastMessage: conversation.lastMessage } : {}),
      ...(conversation.reads ? { reads: conversation.reads } : {}),
      unread: conversation.unread || {},
      unreadForViewer: Number(conversation.unread?.[viewer.identity.uid] || 0),
      otherParticipant: otherForStaff
    };
  }

  /* ---------------- messages ---------------- */

  async sendMessage(viewer: ChatViewer, conversation: ChatConversation, text: string): Promise<ChatMessage> {
    const clean = String(text || '').trim();
    if (clean.length < MESSAGE_MIN || clean.length > MESSAGE_MAX) throw new AppError(400, 'CHAT_MESSAGE_INVALID', `Messages must be ${MESSAGE_MIN}-${MESSAGE_MAX} characters`);
    // Sending requires actual participation (support staff join on first reply).
    await this.assertConversationAccess(viewer, conversation, { requireParticipant: true });
    const message: ChatMessage = {
      id: randomUUID(),
      conversationId: conversation.id,
      senderId: viewer.identity.uid,
      senderRole: senderRoleFor(viewer),
      text: clean,
      type: 'text',
      sentAt: Date.now()
    };
    const unreadUids = new Set(Object.keys(conversation.participants || {}).filter(uid => uid !== viewer.identity.uid && uid !== SUPPORT_TEAM_PROFILE_UID));
    // Support-inbox conversations are provisioned to staff who are not yet
    // participants (they join on first reply) — they still need unread badges.
    if (conversation.type !== 'hotel') {
      for (const userId of await this.deps.directory.listSupportStaffIds()) {
        const staffUid = chatUidForUser(userId, 'staff');
        if (staffUid !== viewer.identity.uid) unreadUids.add(staffUid);
      }
    }
    await this.deps.store.appendMessage(message, [...unreadUids]);
    if (viewer.supportStaff || viewer.vendor) await this.joinAsStaff(viewer, conversation);
    if (viewer.user && (viewer.supportStaff || viewer.vendor)) {
      await this.deps.directory.audit('chat.staff_reply', { userId: viewer.user.id, metadata: { conversationId: conversation.id, messageId: message.id, type: conversation.type } });
    }
    return message;
  }

  async listMessages(viewer: ChatViewer, conversation: ChatConversation): Promise<ChatMessage[]> {
    await this.assertConversationAccess(viewer, conversation);
    return this.deps.store.listMessages(conversation.id);
  }

  async markRead(viewer: ChatViewer, conversation: ChatConversation, at?: number): Promise<void> {
    await this.assertConversationAccess(viewer, conversation);
    await this.deps.store.markRead(conversation.id, viewer.identity.uid, at || Date.now());
  }
}

function staffRoleLabel(role: string): string {
  switch (role) {
    case 'hotel_owner': return 'Hotel Owner';
    case 'home_owner': return 'Home Stay Owner';
    case 'travel_agent': return 'Travel Agent';
    case 'super_admin': return 'Super Admin';
    default: return 'Support Team';
  }
}
