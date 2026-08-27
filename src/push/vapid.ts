import webpush from 'web-push';
import { AppError } from '../errors.js';
import { config } from '../config.js';
import type { PushSubscription, PushSubscriptionStore } from './store.js';

/**
 * Sadik Travels — VAPID Web Push sender.
 *
 * This is the *only* push path in the product. SMTP (`providers.ts`) sends
 * email; it is never used to deliver a notification to a device.
 *
 * Why VAPID rather than Firebase Cloud Messaging: the Firebase integration in
 * this repository is Authentication (Google sign-in) and Realtime Database
 * (live chat). Cloud Messaging is not provisioned — there is no sender ID, no
 * server key and no FCM web config in `.env.example`. VAPID Web Push is the
 * standards-compliant equivalent, works on Android Chrome and on supported
 * desktop browsers, and needs no third-party account.
 *
 * Key handling:
 *   - `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` environment variables win, so an
 *     operator can pin keys in the deployment secret store;
 *   - otherwise a key pair is generated once and persisted (encrypted) in the
 *     `settings` collection, so restarts and redeploys do not invalidate every
 *     stored subscription;
 *   - the private key never leaves the server. Only the public key is exposed,
 *     through `GET /api/v1/push/public-key`, because the browser needs it to
 *     subscribe.
 */

const PUBLIC_KEY_SETTING = 'push_vapid_public_key';
const PRIVATE_KEY_SETTING = 'push_vapid_private_key';

export type VapidKeys = { publicKey: string; privateKey: string };

export type PushPayload = {
  title: string;
  body?: string;
  /** Absolute path the notification opens, e.g. `/orders/abc123`. */
  url?: string;
  /** Logical type so the service worker can route clicks. */
  type?: string;
  tag?: string;
  icon?: string;
  badge?: string;
  /** Related identifiers, echoed back on click. */
  data?: Record<string, string>;
  /** ISO timestamp; the service worker uses it to drop stale notifications. */
  sentAt?: string;
};

export type PushDeliveryResult = {
  attempted: number;
  delivered: number;
  /** Endpoints the push service reported as gone (404/410). */
  expired: number;
  failed: number;
};

export type SettingsLike = {
  getSetting(key: string): Promise<string | undefined>;
  updateSettings(patch: Record<string, string | undefined>, updatedBy: string): Promise<void>;
};

let cachedKeys: VapidKeys | undefined;

/** Public key advertised to the browser. Empty string when push is not set up. */
export function vapidPublicKeyFromConfig(): string {
  return config.vapidPublicKey || cachedKeys?.publicKey || '';
}

export function isWebPushEnabled(): boolean {
  return Boolean(vapidPublicKeyFromConfig());
}

/**
 * Resolve the VAPID key pair: environment first, then a persisted pair, then a
 * freshly generated pair that is written back to settings.
 *
 * Safe to call concurrently: the first caller persists and later callers read
 * the same row. A duplicate-key race is harmless because both writers produce
 * valid keys and the last write wins.
 */
export async function ensureVapidKeys(store: SettingsLike): Promise<VapidKeys | undefined> {
  if (config.vapidPublicKey && config.vapidPrivateKey) {
    cachedKeys = { publicKey: config.vapidPublicKey, privateKey: config.vapidPrivateKey };
    return cachedKeys;
  }
  if (cachedKeys) return cachedKeys;

  try {
    const storedPublic = await store.getSetting(PUBLIC_KEY_SETTING);
    const storedPrivate = await store.getSetting(PRIVATE_KEY_SETTING);
    if (storedPublic && storedPrivate) {
      cachedKeys = { publicKey: storedPublic, privateKey: storedPrivate };
      return cachedKeys;
    }
    const generated = webpush.generateVAPIDKeys();
    await store.updateSettings({ [PUBLIC_KEY_SETTING]: generated.publicKey, [PRIVATE_KEY_SETTING]: generated.privateKey }, 'system:push-bootstrap');
    cachedKeys = { publicKey: generated.publicKey, privateKey: generated.privateKey };
    return cachedKeys;
  } catch (error) {
    // Push must never take the application down. Callers degrade to in-app and
    // email delivery, which is exactly what the requirements ask for.
    console.error('Web Push VAPID keys unavailable:', error instanceof Error ? error.message : error);
    return undefined;
  }
}

/** Test-only: forget the in-memory key pair. */
export function resetVapidKeyCache(): void { cachedKeys = undefined; }

function subscribeVapid(keys: VapidKeys): void {
  const subject = config.vapidSubject
    || (config.smtpFrom && config.smtpFrom.includes('@') ? `mailto:${config.smtpFrom.replace(/^.*<|>.*$/g, '')}` : `${config.appOrigin}`);
  webpush.setVapidDetails(subject, keys.publicKey, keys.privateKey);
}

export type WebPushError = Error & { statusCode?: number; body?: string; endpoint?: string };

/** True when the push service says the subscription no longer exists. */
export function isExpiredSubscriptionError(error: unknown): boolean {
  const status = (error as WebPushError)?.statusCode;
  return status === 404 || status === 410;
}

export class PushSender {
  constructor(private readonly store: SettingsLike, private readonly subscriptions: PushSubscriptionStore) {}

  async publicKey(): Promise<string> {
    const keys = await ensureVapidKeys(this.store);
    if (!keys) throw new AppError(503, 'PUSH_NOT_CONFIGURED', 'Web push is not configured on this deployment');
    return keys.publicKey;
  }

  /**
   * Send one notification to every active subscription of a user.
   *
   * Failures are per-subscription: a dead endpoint is retired and the others
   * still receive the message. The caller is never blocked by a push problem.
   */
  async sendToUser(userId: string, payload: PushPayload): Promise<PushDeliveryResult> {
    const keys = await ensureVapidKeys(this.store);
    if (!keys) return { attempted: 0, delivered: 0, expired: 0, failed: 0 };

    const targets = await this.subscriptions.listActive(userId);
    if (targets.length === 0) return { attempted: 0, delivered: 0, expired: 0, failed: 0 };
    subscribeVapid(keys);

    const result: PushDeliveryResult = { attempted: targets.length, delivered: 0, expired: 0, failed: 0 };
    const body = serializePayload(payload);

    await Promise.all(targets.map(async target => {
      try {
        await webpush.sendNotification(toWebPushSubscription(target), body, { TTL: 24 * 60 * 60, urgency: 'normal' });
        await this.subscriptions.recordSuccess(target.endpoint);
        result.delivered += 1;
      } catch (error) {
        if (isExpiredSubscriptionError(error)) {
          // The user uninstalled the app, cleared site data or the browser
          // rotated the endpoint. Stop sending here — permanently.
          await this.subscriptions.markExpired(target.endpoint, `Push service reported ${(error as WebPushError).statusCode}`);
          result.expired += 1;
          return;
        }
        const message = error instanceof Error ? error.message : 'Unknown push error';
        await this.subscriptions.recordFailure(target.endpoint, message);
        result.failed += 1;
      }
    }));

    return result;
  }

  /** Send to several users, deduplicated, without waiting on the slowest. */
  async sendToUsers(userIds: Iterable<string>, payload: PushPayload): Promise<PushDeliveryResult> {
    const unique = [...new Set([...userIds].filter(Boolean))];
    const totals: PushDeliveryResult = { attempted: 0, delivered: 0, expired: 0, failed: 0 };
    await Promise.all(unique.map(async userId => {
      const partial = await this.sendToUser(userId, payload);
      totals.attempted += partial.attempted;
      totals.delivered += partial.delivered;
      totals.expired += partial.expired;
      totals.failed += partial.failed;
    }));
    return totals;
  }

  /** Housekeeping task; safe to call on a schedule. */
  async prune(): Promise<{ expiredRemoved: number; staleRemoved: number }> {
    return this.subscriptions.pruneExpired();
  }
}

/** Keep the payload small: push services cap it around 4 KB. */
const MAX_BODY_LENGTH = 500;
const MAX_TITLE_LENGTH = 120;

export function serializePayload(payload: PushPayload): string {
  const data: Record<string, unknown> = { ...(payload.data || {}) };
  if (payload.url) data.url = payload.url;
  if (payload.type) data.type = payload.type;
  return JSON.stringify({
    title: String(payload.title || 'Sadik Travels').slice(0, MAX_TITLE_LENGTH),
    body: payload.body ? String(payload.body).slice(0, MAX_BODY_LENGTH) : undefined,
    icon: payload.icon || '/assets/pwa-icon-192.png',
    badge: payload.badge || '/assets/pwa-icon-192.png',
    tag: payload.tag,
    data,
    sentAt: payload.sentAt || new Date().toISOString()
  });
}

function toWebPushSubscription(subscription: PushSubscription): webpush.PushSubscription {
  return { endpoint: subscription.endpoint, keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth } };
}

export function createPushSender(store: SettingsLike, subscriptions: PushSubscriptionStore): PushSender {
  return new PushSender(store, subscriptions);
}
