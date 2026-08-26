import type { RequestHandler, Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { AppError } from './errors.js';
import { verifyToken, ACCESS_COOKIE } from './security.js';
import type { Store, User, UserRole } from './store.js';
import { hasFinePermission, hasCoarsePermission, effectiveCoarsePermissions } from './permissions.js';

export type AdminPermission = 'dashboard:view' | 'bookings:view' | 'bookings:manage' | 'payments:view' | 'payments:manage' | 'customers:view' | 'content:manage' | 'services:manage' | 'notifications:send' | 'support:manage' | 'settings:manage' | 'users:manage' | 'audit:view' | 'navigation:manage';
const ALL_ADMIN_ROLES: UserRole[] = ['admin', 'manager', 'super_admin', 'support', 'content_manager', 'finance', 'staff', 'hotel_owner', 'home_owner', 'travel_agent'];

// Backward-compatible exports (now delegated to the granular permission engine).
export const hasPermission = (user: User | undefined, permission: AdminPermission) => hasCoarsePermission(user, permission);
export const permissionsFor = (user: User | undefined) => effectiveCoarsePermissions(user);
export const hasFine = (user: User | undefined, key: string) => hasFinePermission(user, key);

export function requestContext(): RequestHandler {
  return (req, res, next) => {
    req.requestId = req.header('x-request-id') || randomUUID();
    res.setHeader('x-request-id', req.requestId);
    next();
  };
}

function getAccessToken(req: Request) {
  const authorization = req.header('authorization');
  if (authorization?.startsWith('Bearer ')) return authorization.slice(7);
  return req.cookies?.[ACCESS_COOKIE] as string | undefined;
}

async function authenticate(store: Store, req: Request, requireAdminAccess = false) {
  const token = getAccessToken(req);
  if (!token) throw new AppError(401, 'AUTH_REQUIRED', requireAdminAccess ? 'Admin login is required' : 'Login is required');
  const claims = await verifyToken(token, 'access');
  const session = await store.findSessionById(claims.sid);
  if (!session || session.revokedAt || new Date(session.expiresAt) <= new Date() || session.userId !== claims.sub) throw new AppError(401, 'SESSION_INVALID', 'Your session has expired. Please login again.');
  const user = await store.findUserById(claims.sub);
  if (!user || user.status !== 'active') throw new AppError(403, 'ACCOUNT_UNAVAILABLE', 'This account is not available');
  if (requireAdminAccess && !ALL_ADMIN_ROLES.includes(user.role)) throw new AppError(403, 'ADMIN_REQUIRED', 'Admin access is required');
  req.auth = claims; req.user = user;
  return user;
}

export function optionalAuth(store: Store): RequestHandler {
  return async (req, _res, next) => {
    try { const token = getAccessToken(req); if (!token) return next(); const user = await authenticate(store, req); if (!user) return next(); next(); } catch { next(); }
  };
}

export function requireAdmin(store: Store): RequestHandler {
  return async (req, _res, next) => { try { await authenticate(store, req, true); next(); } catch (error) { next(error); } };
}

export function requirePermission(store: Store, permission: AdminPermission): RequestHandler {
  return async (req, _res, next) => { try { const user = await authenticate(store, req, true); if (!hasPermission(user, permission)) throw new AppError(403, 'PERMISSION_DENIED', `Permission required: ${permission}`); next(); } catch (error) { next(error); } };
}

/** Granular permission guard (e.g. hotel.create, booking.refund). SUPER_ADMIN always passes. */
export function requireFinePermission(store: Store, key: string): RequestHandler {
  return async (req, _res, next) => { try { const user = await authenticate(store, req, true); if (!hasFinePermission(user, key)) throw new AppError(403, 'PERMISSION_DENIED', `Permission required: ${key}`); next(); } catch (error) { next(error); } };
}

export function requireAnyFinePermission(store: Store, keys: string[]): RequestHandler {
  return async (req, _res, next) => {
    try {
      const user = await authenticate(store, req, true);
      if (!keys.some(key => hasFinePermission(user, key))) throw new AppError(403, 'PERMISSION_DENIED', `One of these permissions is required: ${keys.join(', ')}`);
      next();
    } catch (error) { next(error); }
  };
}

export function requireInternalOperator(store: Store, key: string): RequestHandler {
  return async (req, _res, next) => {
    try {
      const user = await authenticate(store, req, true);
      if (['hotel_owner', 'home_owner', 'travel_agent'].includes(user.role)) throw new AppError(403, 'INTERNAL_OPERATOR_REQUIRED', 'This operations module is not available to vendor accounts');
      if (!hasFinePermission(user, key)) throw new AppError(403, 'PERMISSION_DENIED', `Permission required: ${key}`);
      next();
    } catch (error) { next(error); }
  };
}

/** Hotel inventory is restricted to platform operators and hotel owners. */
export function requireHotelManager(store: Store, key: string): RequestHandler {
  return async (req, _res, next) => {
    try {
      const user = await authenticate(store, req, true);
      if (['home_owner', 'travel_agent'].includes(user.role)) throw new AppError(403, 'HOTEL_ROLE_REQUIRED', 'Hotel management is not available to this vendor account');
      if (!hasFinePermission(user, key)) throw new AppError(403, 'PERMISSION_DENIED', `Permission required: ${key}`);
      next();
    } catch (error) { next(error); }
  };
}

/** SUPER_ADMIN-only guard for admin management, role/permission changes and system config. */
export function requireSuperAdmin(store: Store): RequestHandler {
  return async (req, _res, next) => { try { const user = await authenticate(store, req, true); if (user.role !== 'super_admin') throw new AppError(403, 'SUPER_ADMIN_REQUIRED', 'Only a Super Admin can perform this action'); next(); } catch (error) { next(error); } };
}

export function requireAuth(store: Store): RequestHandler {
  return async (req, _res, next) => { try { await authenticate(store, req, false); next(); } catch (error) { next(error); } };
}

export function notFound(_req: Request, _res: Response, next: NextFunction) { next(new AppError(404, 'NOT_FOUND', 'The requested resource was not found')); }
