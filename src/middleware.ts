import type { RequestHandler, Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { AppError } from './errors.js';
import { verifyToken, ACCESS_COOKIE } from './security.js';
import type { Store, User, UserRole } from './store.js';

export type AdminPermission = 'dashboard:view' | 'bookings:view' | 'bookings:manage' | 'payments:view' | 'payments:manage' | 'customers:view' | 'content:manage' | 'services:manage' | 'notifications:send' | 'support:manage' | 'settings:manage' | 'users:manage' | 'audit:view' | 'navigation:manage';
const ALL_ADMIN_ROLES: UserRole[] = ['admin', 'manager', 'super_admin', 'support', 'content_manager', 'finance'];
const ROLE_PERMISSIONS: Record<UserRole, AdminPermission[]> = {
  customer: [],
  super_admin: ['dashboard:view','bookings:view','bookings:manage','payments:view','payments:manage','customers:view','content:manage','services:manage','notifications:send','support:manage','settings:manage','users:manage','audit:view','navigation:manage'],
  admin: ['dashboard:view','bookings:view','bookings:manage','payments:view','payments:manage','customers:view','content:manage','services:manage','notifications:send','support:manage','settings:manage','users:manage','audit:view','navigation:manage'],
  manager: ['dashboard:view','bookings:view','bookings:manage','customers:view','notifications:send','support:manage'],
  support: ['dashboard:view','bookings:view','customers:view','notifications:send','support:manage'],
  content_manager: ['dashboard:view','content:manage','services:manage'],
  finance: ['dashboard:view','bookings:view','payments:view','payments:manage','customers:view']
};

export function hasPermission(user: User | undefined, permission: AdminPermission) { return Boolean(user && ROLE_PERMISSIONS[user.role]?.includes(permission)); }
export function permissionsFor(user: User | undefined) { return user ? ROLE_PERMISSIONS[user.role] ?? [] : []; }

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

export function requireAuth(store: Store): RequestHandler {
  return async (req, _res, next) => { try { await authenticate(store, req, false); next(); } catch (error) { next(error); } };
}

export function notFound(_req: Request, _res: Response, next: NextFunction) { next(new AppError(404, 'NOT_FOUND', 'The requested resource was not found')); }
