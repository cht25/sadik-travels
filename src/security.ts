import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { config } from './config.js';
import { AppError, assert } from './errors.js';
import type { Store, User } from './store.js';

const scrypt = promisify(scryptCallback);
const secretKey = new TextEncoder().encode(config.jwtSecret);
export const ACCESS_COOKIE = 'sadik_access_token';
export const REFRESH_COOKIE = 'sadik_refresh_token';

export function normalizeIdentity(value: string): { identity: string; channel: 'sms' | 'email' } {
  const raw = value.trim();
  if (raw.includes('@')) {
    const email = raw.toLowerCase();
    assert(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), 400, 'INVALID_EMAIL', 'Enter a valid email address');
    return { identity: email, channel: 'email' };
  }
  const digits = raw.replace(/[\s()-]/g, '');
  let phone = digits;
  if (phone.startsWith('01') && phone.length === 11) phone = `+880${phone.slice(1)}`;
  else if (phone.startsWith('8801') && phone.length === 13) phone = `+${phone}`;
  assert(/^\+8801[3-9]\d{8}$/.test(phone), 400, 'INVALID_PHONE', 'Enter a valid Bangladesh mobile number');
  return { identity: phone, channel: 'sms' };
}

export async function hashOtp(code: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(code, salt, 64) as Buffer;
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

export async function verifyOtpHash(code: string, encoded: string): Promise<boolean> {
  const [saltHex, hashHex] = encoded.split(':');
  if (!saltHex || !hashHex) return false;
  const derived = await scrypt(code, Buffer.from(saltHex, 'hex'), 64) as Buffer;
  const expected = Buffer.from(hashHex, 'hex');
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}

function ttlMs(ttl: string): number {
  const match = /^(\d+)\s*(s|m|h|d)$/i.exec(ttl.trim());
  if (!match) throw new Error(`Unsupported TTL: ${ttl}`);
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  return amount * ({ s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as Record<string, number>)[unit];
}

export type AuthClaims = JWTPayload & { sub: string; sid: string; type: 'access' | 'refresh'; jti: string };

async function signToken(userId: string, sid: string, jti: string, type: 'access' | 'refresh', ttl: string) {
  return new SignJWT({ sub: userId, sid, jti, type })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(config.jwtIssuer)
    .setAudience(config.jwtAudience)
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(secretKey);
}

export async function issueSession(store: Store, user: User, meta: { ip?: string; userAgent?: string }) {
  const sessionId = randomUUID();
  const refreshJti = randomUUID();
  const session = await store.createSession({ id: sessionId, userId: user.id, refreshJti, ip: meta.ip, userAgent: meta.userAgent, expiresAt: new Date(Date.now() + ttlMs(config.refreshTokenTtl)).toISOString() });
  const accessToken = await signToken(user.id, sessionId, randomUUID(), 'access', config.accessTokenTtl);
  const refreshToken = await signToken(user.id, sessionId, refreshJti, 'refresh', config.refreshTokenTtl);
  return { session, accessToken, refreshToken };
}

export async function verifyToken(token: string, expectedType: 'access' | 'refresh'): Promise<AuthClaims> {
  try {
    const result = await jwtVerify(token, secretKey, { issuer: config.jwtIssuer, audience: config.jwtAudience, algorithms: ['HS256'] });
    const payload = result.payload as AuthClaims;
    assert(payload.type === expectedType && typeof payload.sub === 'string' && typeof payload.sid === 'string' && typeof payload.jti === 'string', 401, 'INVALID_TOKEN', 'Invalid authentication token');
    return payload;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(401, 'INVALID_TOKEN', 'Invalid or expired authentication token');
  }
}

export function cookieOptions(maxAge: number) {
  return { httpOnly: true, secure: config.cookieSecure, sameSite: config.cookieSameSite, domain: config.cookieDomain, path: '/', maxAge };
}
export const setAuthCookies = (res: any, accessToken: string, refreshToken: string) => {
  res.cookie(ACCESS_COOKIE, accessToken, cookieOptions(ttlMs(config.accessTokenTtl)));
  res.cookie(REFRESH_COOKIE, refreshToken, cookieOptions(ttlMs(config.refreshTokenTtl)));
};
export const clearAuthCookies = (res: any) => {
  const options = { httpOnly: true, secure: config.cookieSecure, sameSite: config.cookieSameSite, domain: config.cookieDomain, path: '/' };
  res.clearCookie(ACCESS_COOKIE, options); res.clearCookie(REFRESH_COOKIE, options);
};

export function hashForAudit(value: string) { return createHash('sha256').update(value).digest('hex').slice(0, 16); }
