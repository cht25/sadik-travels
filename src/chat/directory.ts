/**
 * Chat directory: the minimal identity/hotel lookups the chat service needs.
 *
 * Implemented in production by the MongoDB-backed store + hotel store, and by
 * an in-memory fake in tests and the demo server. Keeping this narrow keeps
 * the chat module independent of mongoose and easy to reason about.
 */
import type { Store, User } from '../store.js';

/** Subset of the hotel record the chat service depends on. */
export type ChatHotel = {
  id: string;
  name: string;
  ownerId?: string;
  images?: Array<{ url?: string; alt?: string }>;
  city?: string;
  status?: string;
  available?: boolean;
  propertyType?: string;
};

export interface ChatDirectory {
  findUserById(id: string): Promise<User | undefined>;
  /** Active staff accounts (any role) used to provision the support inbox. */
  listSupportStaffIds(): Promise<string[]>;
  /** Resolve a hotel by stable UUID (never by name/email/phone). */
  findHotel(hotelId: string): Promise<ChatHotel | undefined>;
  /** All hotel ids owned by a user — the owner's chat scope. */
  listOwnedHotelIds(ownerId: string): Promise<string[]>;
  audit(action: string, entry: { userId?: string; ip?: string; userAgent?: string; metadata?: Record<string, unknown> }): Promise<void>;
}

export function createStoreDirectory(store: Store, hotelStore: {
  adminFindHotel(id: string): Promise<ChatHotel | undefined>;
  adminListHotels(filters?: { ownerId?: string; pageSize?: number }): Promise<{ hotels: ChatHotel[] }>;
}): ChatDirectory {
  const isSupportStaff = (user: User | undefined) => Boolean(user && user.status === 'active' && ['super_admin', 'admin', 'manager', 'support', 'staff'].includes(user.role));
  return {
    async findUserById(id) {
      const user = await store.findUserById(id);
      return user && user.status !== 'blocked' && user.status !== 'suspended' ? user : undefined;
    },
    async listSupportStaffIds() {
      const admins = await store.listAdmins();
      return admins.filter(isSupportStaff).map(user => user.id);
    },
    // Chat is customer-facing: only live, bookable hotels can be contacted.
    async findHotel(hotelId) {
      const hotel = await hotelStore.adminFindHotel(hotelId);
      return hotel && hotel.status === 'active' && hotel.available !== false ? hotel : undefined;
    },
    async listOwnedHotelIds(ownerId) {
      const result = await hotelStore.adminListHotels({ ownerId, pageSize: 1000 });
      return (result.hotels || []).map(hotel => hotel.id);
    },
    audit: (action, entry) => store.audit(action, { ...entry, userAgent: entry.userAgent?.slice(0, 500) })
  };
}
