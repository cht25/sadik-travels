import type { User } from './store.js';

/**
 * Granular permission engine (add-on to the existing role-based RBAC).
 *
 * - SUPER_ADMIN always has every permission and cannot be restricted.
 * - Other admin roles receive a default permission set derived from their role,
 *   UNLESS a Super Admin has configured a custom permission list on the user
 *   document (`user.permissions`). When that array exists it is authoritative.
 * - Fine-grained keys (hotel.create, booking.refund, ...) are enforced directly
 *   on dedicated endpoints. Keys that map to a coarse permission also unlock the
 *   legacy coarse-gated endpoints, so backward compatibility is preserved.
 */

export type CoarsePerm = 'dashboard:view' | 'bookings:view' | 'bookings:manage' | 'payments:view' | 'payments:manage' | 'customers:view' | 'content:manage' | 'services:manage' | 'notifications:send' | 'support:manage' | 'settings:manage' | 'users:manage' | 'audit:view' | 'navigation:manage';

/** Fine-grained permission -> coarse permission(s) it grants for legacy endpoints. */
export const FINE_TO_COARSE: Record<string, CoarsePerm[]> = {
  'dashboard.view': ['dashboard:view'],
  'reports.view': ['dashboard:view'],
  'content.view': ['content:manage'],
  'media.view': ['content:manage'], 'media.upload': ['content:manage'], 'media.delete': ['content:manage'],
  'offer.view': ['content:manage'], 'offer.create': ['content:manage'], 'offer.update': ['content:manage'], 'offer.delete': ['content:manage'],
  'service.manage': ['services:manage'],
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
  { group: 'Content & Offers', permissions: [
    { key: 'content.view', label: 'View content', description: 'Visa, Umrah, holiday and medical content' },
    { key: 'offer.view', label: 'View offers', description: 'Browse card and airline offers' },
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
    { key: 'navigation.manage', label: 'Manage navigation', description: 'Edit the admin sidebar' } ] }
];

export const ALL_FINE_PERMISSIONS = PERMISSION_CATALOG.flatMap(group => group.permissions.map(item => item.key));
/** Super-admin only capabilities — never granted to non-super admins. */
export const SUPER_ONLY_PERMISSIONS = ['admin.manage', 'system.settings', 'system.audit', 'system.backup'];
export const ALL_PERMISSIONS_INCL_SUPER = [...ALL_FINE_PERMISSIONS, ...SUPER_ONLY_PERMISSIONS];

const ROLE_DEFAULT_FINE: Record<string, string[]> = {
  super_admin: ALL_PERMISSIONS_INCL_SUPER,
  admin: ALL_FINE_PERMISSIONS,
  manager: ['dashboard.view', 'reports.view', 'booking.view', 'booking.create', 'booking.update', 'booking.cancel', 'customer.view', 'support.view', 'support.reply', 'notifications.send'],
  support: ['dashboard.view', 'booking.view', 'customer.view', 'support.view', 'support.reply', 'notifications.send'],
  content_manager: ['dashboard.view', 'reports.view', 'hotel.view', 'hotel.create', 'hotel.update', 'hotel.delete', 'room.view', 'room.create', 'room.update', 'room.delete', 'agent.view', 'agent.create', 'agent.update', 'agent.delete', 'tour.view', 'tour.create', 'tour.update', 'tour.delete', 'content.view', 'offer.view', 'offer.create', 'offer.update', 'offer.delete', 'media.view', 'media.upload', 'media.delete', 'service.manage'],
  finance: ['dashboard.view', 'reports.view', 'booking.view', 'payment.view', 'payment.manage', 'customer.view'],
  staff: ['dashboard.view', 'booking.view', 'customer.view', 'support.view'],
  customer: []
};

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
