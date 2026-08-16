import type { RequestHandler, Request, Response, NextFunction } from 'express';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { AppError } from './errors.js';
import { verifyToken, ACCESS_COOKIE } from './security.js';
import type { Store } from './store.js';

export const CSRF_COOKIE = 'sadik_csrf';

export function requestContext(): RequestHandler {
  return (req, res, next) => {
    req.requestId = req.header('x-request-id') || randomUUID();
    res.setHeader('x-request-id', req.requestId);
    next();
  };
}

export function issueCsrfToken(req: Request, res: Response) {
  const existing = req.cookies?.[CSRF_COOKIE] as string | undefined;
  const token = existing && /^[a-f0-9]{48}$/.test(existing) ? existing : randomBytes(24).toString('hex');
  res.cookie(CSRF_COOKIE, token, { httpOnly: false, secure: req.secure, sameSite: 'lax', path: '/' });
  return token;
}

/** Double-submit protection for cookie-authenticated browser writes. Bearer API clients are protected by possession of their token. */
export function csrfProtection(): RequestHandler {
  return (req, _res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.path === '/api/v1/payments/webhook') return next();
    if (req.header('authorization')?.startsWith('Bearer ')) return next();
    const cookie = req.cookies?.[CSRF_COOKIE] as string | undefined;
    const header = req.header('x-csrf-token');
    if (!cookie || !header) return next(new AppError(403, 'CSRF_REQUIRED', 'Refresh the page and try again.'));
    const a = Buffer.from(cookie); const b = Buffer.from(header);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return next(new AppError(403, 'CSRF_INVALID', 'Refresh the page and try again.'));
    next();
  };
}

function getAccessToken(req: Request) {
  const authorization = req.header('authorization');
  if (authorization?.startsWith('Bearer ')) return authorization.slice(7);
  return req.cookies?.[ACCESS_COOKIE] as string | undefined;
}

async function getAuthenticatedUser(req: Request, store: Store) {
  const token = getAccessToken(req);
  if (!token) throw new AppError(401, 'AUTH_REQUIRED', 'Login is required');
  const claims = await verifyToken(token, 'access');
  const session = await store.findSessionById(claims.sid);
  if (!session || session.revokedAt || new Date(session.expiresAt) <= new Date() || session.userId !== claims.sub) throw new AppError(401, 'SESSION_INVALID', 'Your session has expired. Please login again.');
  const user = await store.findUserById(claims.sub);
  if (!user || user.status !== 'active') throw new AppError(403, 'ACCOUNT_UNAVAILABLE', 'This account is not available');
  return { claims, user };
}

export function optionalAuth(store: Store): RequestHandler {
  return async (req, _res, next) => {
    try { const value = await getAuthenticatedUser(req, store); req.auth = value.claims; req.user = value.user; } catch { /* Public route: anonymous is valid. */ }
    next();
  };
}

export function requireAdmin(store: Store): RequestHandler {
  return async (req, _res, next) => {
    try {
      const value = await getAuthenticatedUser(req, store);
      if (!['admin', 'manager'].includes(value.user.role)) throw new AppError(403, 'ADMIN_REQUIRED', 'Admin access is required');
      req.auth = value.claims; req.user = value.user; next();
    } catch (error) { next(error); }
  };
}

export function requireSuperAdmin(req: Request, _res: Response, next: NextFunction) {
  if (req.user?.role !== 'admin') return next(new AppError(403, 'SUPER_ADMIN_REQUIRED', 'Only an administrator can perform this action'));
  next();
}

export function requireAuth(store: Store): RequestHandler {
  return async (req, _res, next) => {
    try { const value = await getAuthenticatedUser(req, store); req.auth = value.claims; req.user = value.user; next(); } catch (error) { next(error); }
  };
}

export function notFound(_req: Request, _res: Response, next: NextFunction) { next(new AppError(404, 'NOT_FOUND', 'The requested resource was not found')); }
