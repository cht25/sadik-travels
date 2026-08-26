import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Pure helpers shared by the chat service, the stores and the tests.
 * Kept free of I/O so the deterministic relationships (identity uids and the
 * duplicate-conversation key) are unit-testable without a database.
 */

/** Realtime Database keys may not contain ., #, $, /, [, or ]. */
const RTDB_KEY_FORBIDDEN = /[.#$/[\]]/g;

export function safeRtdbKey(value: string): string {
  return value.replace(RTDB_KEY_FORBIDDEN, '_');
}

/** Stable chat identity uid for a registered site account. */
export function chatUidForUser(userId: string, kind: 'customer' | 'staff'): string {
  const prefix = kind === 'staff' ? 's' : 'u';
  return `${prefix}-${safeRtdbKey(userId)}`;
}

/** Fresh chat identity uid for an unregistered visitor. */
export function newGuestUid(): string {
  return `g-${randomBytes(12).toString('hex')}`;
}

export function newGuestSecret(): string {
  return randomBytes(24).toString('base64url');
}

export function hashGuestSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** Constant-time comparison of a presented guest secret against the stored hash. */
export function verifyGuestSecret(secret: string, expectedHash: string | undefined): boolean {
  if (!secret || !expectedHash) return false;
  const actual = Buffer.from(hashGuestSecret(secret), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Deterministic duplicate-prevention key: one conversation per
 * (context, customer). The same customer returning to the same hotel always
 * reuses the existing conversation instead of creating a new one.
 */
export function conversationDedupKey(type: string, contextId: string, customerUid: string): string {
  return `${type}:${contextId}:${customerUid}`;
}

/**
 * Encode a dedup key for use as a Realtime Database lookup key
 * (`conversationKeys/$encoded`). A length-prefixed hash avoids ambiguity
 * between keys that contain `:` separators.
 */
export function encodeDedupKey(dedupKey: string): string {
  return createHash('sha256').update(dedupKey).digest('hex').slice(0, 40);
}

/** Parse a `x-chat-identity: <uid>.<secret>` header value. */
export function parseIdentityCredentials(header: string | undefined): { uid: string; secret: string } | undefined {
  if (!header) return undefined;
  const dot = header.indexOf('.');
  if (dot <= 0 || dot === header.length - 1) return undefined;
  const uid = header.slice(0, dot);
  const secret = header.slice(dot + 1);
  if (!/^[ugs]-[A-Za-z0-9_-]{1,128}$/.test(uid)) return undefined;
  return { uid, secret };
}

/** Firebase Realtime Database writes cannot contain `undefined`. */
export function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, stripUndefined(v)]));
  }
  return value;
}
