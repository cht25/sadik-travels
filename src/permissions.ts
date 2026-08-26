import type { User, Store } from './store.js';

/**
 * Granular permission engine (add-on to the existing role-based RBAC).
 *
 * - SUPER_ADMIN always has every permission and cannot be restricted.
 * - Other admin roles receive a default permission preset derived from their role,
 *   UNLESS a Super Admin has configured a custom permission list on the user
 *   document (`user.permissions`). When that array exists it is authoritative.
 * - Fine-grained keys (hotel.create, booking.refund, ...) are enforced directly
 *   on dedicated endpoints.
 */

export type CoarsePerm = 'dashboard:view' | 'bookings:view' | 'bookings:manage' | 'payments:view' | 'payments:manage' | 'customers:view' | 'content:manage' | 'services:manage' | 'notifications:send' | 'support:manage' | 'settings:manage' | 'users:manage' | 'audit:view' | 'navigation:manage';

/** Fine-grained permission -> coarse permission(s) it grants for legacy endpoints. */
export const FINE_TO_COARSE: Record<string, CoarsePerm[]> = {
  'dashboard.view': ['dashboard:view'],
  'reports.view': ['dashboard:view'],
  'hotel.view': ['services:manage'],
  'hotel.create': ['services:manage'],
  'hotel.update': ['services:manage'],
  'hotel.delete': ['services:manage'],
  'room.view': ['services:manage'],
  'room.create': ['services:manage'],
  'room.update': ['services:manage'],
  'room.delete': ['services:manage'],
  'home.view': ['content:manage'],
  'home.create': ['content:manage'],
  'home.update': ['content:manage'],
  'home.delete': ['content:manage'],
  'tour.view': ['content:manage'],
  'tour.create': ['content:manage'],
  'tour.update': ['content:manage'],
  'tour.delete': ['content:manage'],
  'agent.view': ['content:manage'],
  'agent.create': ['content:manage'],
  'agent.update': ['content:manage'],
  'agent.delete': ['content:manage'],
  'content.view': ['content:manage'],
  'media.view': ['content:manage'], 'media.upload': ['content:manage'], 'media.delete': ['content:manage'],
  'offer.view': ['content:manage'], 'offer.create': ['content:manage'], 'offer.update': ['content:manage'], 'offer.delete': ['content:manage'],
  'service.manage': ['services:manage'],
  'catalog.view': ['content:manage'], 'catalog.create': ['content:manage'], 'catalog.update': ['content:manage'], 'catalog.delete': ['content:manage'],
  'booking.view': ['bookings:view'],
  'booking.create': ['bookings:manage'],
  'booking.update': ['bookings:manage'],
  'booking.cancel': ['bookings:manage'],
  'booking.refund': ['payments:manage'],
  'order.view': ['bookings:view'], 'order.update': ['bookings:manage'], 'order.cancel': ['bookings:manage'], 'order.refund': ['payments:manage'],
  'invoice.view': ['payments:view'],
  'coupon.view': ['content:manage'], 'coupon.create': ['content:manage'], 'coupon.update': ['content:manage'], 'coupon.delete': ['content:manage'],
  'review.view': ['content:manage'], 'review.moderate': ['content:manage'], 'review.delete': ['content:manage'],
  'payment.view': ['payments:view'], 'payment.manage': ['payments:manage'],
  'customer.view': ['customers:view'],
  'user.manage': ['users:manage'],
  'support.view': ['support:manage'], 'support.reply': ['support:manage'],
  'settings.view': ['settings:manage'], 'settings.edit': ['settings:manage'],
  'notifications.send': ['notifications:send'],
  'navigation.manage': ['navigation:manage'],
  'audit.view': ['audit:view']
};

export type PermissionItem = { key: string; label: string; description: string };
export type PermissionGroup = { group: string; permissions: PermissionItem[] };

export const PERMISSION_CATALOG: PermissionGroup[] = [
  { group: 'Dashboard & Reports', permissions: [
    { key: 'dashboard.view', label: 'View dashboard', description: 'Access the operations overview' },
    { key: 'reports.view', label: 'View reports', description: 'View analytics and reports' } ] },
  { group: 'Home & Villa Management', permissions: [
    { key: 'home.view', label: 'View owned homes', description: 'Browse assigned home and villa listings' },
    { key: 'home.create', label: 'Create homes', description: 'Add home and villa listings' },
    { key: 'home.update', label: 'Edit owned homes', description: 'Update owned home and villa listings' },
    { key: 'home.delete', label: 'Delete owned homes', description: 'Archive owned home and villa listings' } ] },
  { group: 'Hotel Management', permissions: [
    { key: 'hotel.view', label: 'View hotels', description: 'Browse and open hotels' },
    { key: 'hotel.create', label: 'Create hotels', description: 'Add new hotels' },
    { key: 'hotel.update', label: 'Edit hotels', description: 'Update hotel details, pricing and images' },
    { key: 'hotel.delete', label: 'Delete hotels', description: 'Archive or remove hotels' } ] },
  { group: 'Room Management', permissions: [
    { key: 'room.view', label: 'View rooms', description: 'Browse room types and inventory' },
    { key: 'room.create', label: 'Create rooms', description: 'Add room types' },
    { key: 'room.update', label: 'Edit rooms', description: 'Update rooms and inventory' },
    { key: 'room.delete', label: 'Delete rooms', description: 'Archive rooms' } ] },
  { group: 'Booking Management', permissions: [
    { key: 'booking.view', label: 'View bookings', description: 'Browse hotel bookings' },
    { key: 'booking.create', label: 'Create bookings', description: 'Create bookings for customers' },
    { key: 'booking.update', label: 'Edit bookings', description: 'Update booking status' },
    { key: 'booking.cancel', label: 'Cancel bookings', description: 'Cancel bookings and release inventory' },
    { key: 'booking.refund', label: 'Refund bookings', description: 'Issue refunds' } ] },
  { group: 'Travel Agent Management', permissions: [
    { key: 'agent.view', label: 'View agents', description: 'Browse travel agents' },
    { key: 'agent.create', label: 'Add agents', description: 'Create agent profiles' },
    { key: 'agent.update', label: 'Edit agents', description: 'Update agent profiles' },
    { key: 'agent.delete', label: 'Delete agents', description: 'Archive agents' } ] },
  { group: 'Tour Management', permissions: [
    { key: 'tour.view', label: 'View tours', description: 'Browse tour packages' },
    { key: 'tour.create', label: 'Add tours', description: 'Create tour packages' },
    { key: 'tour.update', label: 'Edit tours', description: 'Update tour packages' },
    { key: 'tour.delete', label: 'Delete tours', description: 'Archive tours' } ] },
  { group: 'Marketplace Catalogue', permissions: [
    { key: 'catalog.view', label: 'View catalogue', description: 'Browse every catalogue product' },
    { key: 'catalog.create', label: 'Create catalogue products', description: 'Add holiday packages, homes & villas and destinations' },
    { key: 'catalog.update', label: 'Edit catalogue products', description: 'Update catalogue content, pricing and availability' },
    { key: 'catalog.delete', label: 'Delete catalogue products', description: 'Archive or permanently remove catalogue products' } ] },
  { group: 'Orders & E-commerce', permissions: [
    { key: 'order.view', label: 'View orders', description: 'Browse orders and bookings' },
    { key: 'order.update', label: 'Edit orders', description: 'Change order and payment status' },
    { key: 'order.cancel', label: 'Cancel orders', description: 'Cancel customer orders' },
    { key: 'order.refund', label: 'Refund orders', description: 'Mark orders as refunded' },
    { key: 'invoice.view', label: 'View invoices', description: 'Open customer invoices' } ] },
  { group: 'Coupons & Promotions', permissions: [
    { key: 'coupon.view', label: 'View coupons', description: 'Browse discount coupons' },
    { key: 'coupon.create', label: 'Create coupons', description: 'Create discount coupons' },
    { key: 'coupon.update', label: 'Edit coupons', description: 'Update coupon rules and limits' },
    { key: 'coupon.delete', label: 'Delete coupons', description: 'Remove coupons' } ] },
  { group: 'Reviews & Ratings', permissions: [
    { key: 'review.view', label: 'View reviews', description: 'Browse customer reviews' },
    { key: 'review.moderate', label: 'Moderate reviews', description: 'Approve, reject and reply to reviews' },
    { key: 'review.delete', label: 'Delete reviews', description: 'Remove reviews' } ] },
  { group: 'Content & Offers', permissions: [
    { key: 'content.view', label: 'View content', description: 'Website, destination and holiday content' },
    { key: 'offer.view', label: 'View offers', description: 'Browse published promotional offers' },
    { key: 'offer.create', label: 'Create offers', description: 'Add offers' },
    { key: 'offer.update', label: 'Edit offers', description: 'Update offers' },
    { key: 'offer.delete', label: 'Delete offers', description: 'Remove offers' } ] },
  { group: 'Media Management', permissions: [
    { key: 'media.view', label: 'View media', description: 'Browse the Cloudinary library' },
    { key: 'media.upload', label: 'Upload media', description: 'Upload images' },
    { key: 'media.delete', label: 'Delete media', description: 'Archive media assets' } ] },
  { group: 'Customer Management', permissions: [
    { key: 'customer.view', label: 'View customers', description: 'Browse customer accounts' },
    { key: 'user.manage', label: 'Manage users', description: 'Change customer roles' } ] },
  { group: 'Payments', permissions: [
    { key: 'payment.view', label: 'View payments', description: 'Browse transactions' },
    { key: 'payment.manage', label: 'Manage payments', description: 'Update payment status' } ] },
  { group: 'Customer Support', permissions: [
    { key: 'support.view', label: 'View tickets', description: 'Browse support tickets' },
    { key: 'support.reply', label: 'Reply tickets', description: 'Respond to support tickets' } ] },
  { group: 'Notifications', permissions: [
    { key: 'notifications.send', label: 'Send notifications', description: 'Send and manage campaigns' } ] },
  { group: 'Settings', permissions: [
    { key: 'settings.view', label: 'View settings', description: 'View configuration' },
    { key: 'settings.edit', label: 'Edit settings', description: 'Update integrations and brand' },
    { key: 'service.manage', label: 'Manage services', description: 'Control public visibility of hotels, homes and tours' },
    { key: 'navigation.manage', label: 'Manage navigation', description: 'Edit the admin sidebar' } ] }
];

export const ALL_FINE_PERMISSIONS = PERMISSION_CATALOG.flatMap(group => group.permissions.map(item => item.key));
/** Super-admin only capabilities — never granted to non-super admins. */
export const SUPER_ONLY_PERMISSIONS = ['admin.manage', 'system.settings', 'system.audit', 'system.backup'];
export const ALL_PERMISSIONS_INCL_SUPER = [...ALL_FINE_PERMISSIONS, ...SUPER_ONLY_PERMISSIONS];

export const PLATFORM_ROLES = Object.freeze({
  SUPER_ADMIN: 'super_admin',
  HOTEL_OWNER: 'hotel_owner',
  HOME_OWNER: 'home_owner',
  TRAVEL_AGENT: 'travel_agent'
} as const);
export const VENDOR_ROLES = [PLATFORM_ROLES.HOTEL_OWNER, PLATFORM_ROLES.HOME_OWNER, PLATFORM_ROLES.TRAVEL_AGENT] as const;
export type VendorRole = typeof VENDOR_ROLES[number];

export const ROLE_PERMISSION_PRESETS: Record<string, string[]> = {
  super_admin: ALL_PERMISSIONS_INCL_SUPER,
  admin: ALL_FINE_PERMISSIONS,
  hotel_owner: [
    'dashboard.view',
    'reports.view',
    'hotel.view',
    'hotel.create',
    'hotel.update',
    'hotel.delete',
    'room.view',
    'room.create',
    'room.update',
    'room.delete',
    'booking.view',
    'booking.create',
    'booking.update',
    'booking.cancel',
    'booking.refund',
    'media.view',
    'media.upload',
    'media.delete',
    'review.view',
    'review.moderate',
    'review.delete'
  ],
  home_owner: [
    'dashboard.view',
    'reports.view',
    'home.view',
    'home.create',
    'home.update',
    'home.delete',
    'media.view',
    'media.upload',
    'media.delete',
    'review.view',
    'review.moderate'
  ],
  travel_agent: [
    'dashboard.view',
    'reports.view',
    'agent.view',
    'agent.create',
    'agent.update',
    'agent.delete',
    'tour.view',
    'media.view',
    'media.upload'
  ],
  manager: [
    'catalog.view', 'order.view', 'order.update', 'order.cancel',
    'coupon.view', 'review.view', 'review.moderate', 'invoice.view',
    'dashboard.view', 'reports.view', 'booking.view', 'booking.create',
    'booking.update', 'booking.cancel', 'customer.view', 'support.view',
    'support.reply', 'notifications.send'
  ],
  support: [
    'catalog.view', 'order.view', 'review.view', 'dashboard.view',
    'booking.view', 'customer.view', 'support.view', 'support.reply',
    'notifications.send'
  ],
  content_manager: [
    'catalog.view', 'catalog.create', 'catalog.update', 'catalog.delete',
    'coupon.view', 'coupon.create', 'coupon.update', 'review.view',
    'review.moderate', 'dashboard.view', 'reports.view', 'agent.view',
    'agent.create', 'agent.update', 'agent.delete', 'tour.view',
    'tour.create', 'tour.update', 'tour.delete', 'content.view',
    'offer.view', 'offer.create', 'offer.update', 'offer.delete',
    'media.view', 'media.upload', 'media.delete', 'service.manage'
  ],
  finance: [
    'order.view', 'order.refund', 'invoice.view', 'catalog.view',
    'dashboard.view', 'reports.view', 'booking.view', 'payment.view',
    'payment.manage', 'customer.view'
  ],
  staff: [
    'catalog.view', 'order.view', 'dashboard.view', 'reports.view',
    'booking.view', 'customer.view', 'support.view'
  ],
  customer: []
};

export const ROLE_DEFAULT_FINE: Record<string, string[]> = ROLE_PERMISSION_PRESETS;

export function getRolePreset(role: string): string[] {
  return ROLE_PERMISSION_PRESETS[role] ? [...ROLE_PERMISSION_PRESETS[role]] : [];
}

type PermUser = Pick<User, 'role'> & { permissions?: string[] };

export function effectiveFinePermissions(user: PermUser | undefined): string[] {
  if (!user) return [];
  if (user.role === 'super_admin') return ALL_PERMISSIONS_INCL_SUPER;
  if (Array.isArray(user.permissions)) return user.permissions.filter(key => !SUPER_ONLY_PERMISSIONS.includes(key));
  return ROLE_DEFAULT_FINE[user.role] || [];
}

export function effectiveCoarsePermissions(user: PermUser | undefined): CoarsePerm[] {
  const fine = effectiveFinePermissions(user);
  const set = new Set<CoarsePerm>();
  for (const key of fine) for (const coarse of (FINE_TO_COARSE[key] || [])) set.add(coarse);
  return [...set];
}

export function hasFinePermission(user: PermUser | undefined, key: string): boolean {
  if (user?.role === 'super_admin') return true;
  return effectiveFinePermissions(user).includes(key);
}

export function hasCoarsePermission(user: PermUser | undefined, coarse: string): boolean {
  if (user?.role === 'super_admin') return true;
  return effectiveCoarsePermissions(user).includes(coarse as CoarsePerm);
}

/** Normalize an incoming permission list, stripping super-only keys for non-super targets. */
export function sanitizePermissions(input: unknown, isSuperTarget: boolean): string[] {
  const allowed = new Set(isSuperTarget ? ALL_PERMISSIONS_INCL_SUPER : ALL_FINE_PERMISSIONS);
  return [...new Set((Array.isArray(input) ? input : []).map(value => String(value)).filter(key => allowed.has(key)))];
}

/**
 * Safely audit existing vendor accounts (Hotel Owners, Home Owners, Travel Agents)
 * and strip unrelated permissions while guaranteeing their correct role preset permissions.
 */
export async function auditAndMigrateVendorPermissions(store: Store): Promise<{ audited: number; updated: number }> {
  try {
    const users = await store.listAdmins();
    let updated = 0;
    let audited = 0;

    for (const user of users) {
      if (user.role === 'hotel_owner') {
        audited += 1;
        const currentPerms: string[] | undefined = Array.isArray(user.permissions) ? user.permissions : undefined;
        const hotelPreset = ROLE_PERMISSION_PRESETS.hotel_owner;
        const unrelatedKeys = ['home.', 'tour.', 'agent.', 'catalog.', 'order.', 'coupon.', 'settings.', 'navigation.', 'payment.', 'customer.', 'user.manage', 'service.manage'];
        
        if (!currentPerms || currentPerms.length === 0) {
          await store.updateAdmin(user.id, { permissions: [...hotelPreset] });
          updated += 1;
        } else {
          const hasUnrelated = currentPerms.some((k: string) => unrelatedKeys.some(u => k.startsWith(u) || k === u));
          if (hasUnrelated) {
            const cleaned = currentPerms.filter((k: string) => !unrelatedKeys.some(u => k.startsWith(u) || k === u));
            const merged = [...new Set([...hotelPreset, ...cleaned])].filter((k: string) => !unrelatedKeys.some(u => k.startsWith(u) || k === u));
            await store.updateAdmin(user.id, { permissions: merged });
            updated += 1;
          }
        }
      } else if (user.role === 'home_owner') {
        audited += 1;
        const currentPerms: string[] | undefined = Array.isArray(user.permissions) ? user.permissions : undefined;
        if (!currentPerms || currentPerms.length === 0) {
          await store.updateAdmin(user.id, { permissions: [...ROLE_PERMISSION_PRESETS.home_owner] });
          updated += 1;
        }
      } else if (user.role === 'travel_agent') {
        audited += 1;
        const currentPerms: string[] | undefined = Array.isArray(user.permissions) ? user.permissions : undefined;
        if (!currentPerms || currentPerms.length === 0) {
          await store.updateAdmin(user.id, { permissions: [...ROLE_PERMISSION_PRESETS.travel_agent] });
          updated += 1;
        }
      }
    }
    return { audited, updated };
  } catch {
    return { audited: 0, updated: 0 };
  }
}
