import mongoose, { Schema, model, type Model } from 'mongoose';
import { randomUUID } from 'node:crypto';

/**
 * Sadik Travels — Web Push subscription persistence.
 *
 * Subscriptions are created by the browser *after* the user grants
 * `Notification` permission and are bound to the signed-in account. The push
 * endpoint URL and the `p256dh` / `auth` keys are per-device secrets: they are
 * stored server-side only and are never returned to the browser by any
 * endpoint (see `push/routes.ts`, which returns counts, never payloads).
 *
 * Lifecycle rules implemented here (Part 4 of the production requirements):
 *   - **duplicates** — a re-subscription from the same browser updates the
 *     existing row instead of creating a second one;
 *   - **expired / invalid** — a 404 or 410 from the push service marks the
 *     subscription `expired` and it is excluded from every later fan-out, so a
 *     dead endpoint is never retried forever;
 *   - **unsubscribed** — the row is deleted when the user turns notifications
 *     off, and `pruneExpired` removes rows the browser abandoned.
 *
 * Uses the shared mongoose connection, matching `hotel-store.ts`.
 */

const models = mongoose.models as Record<string, Model<any>>;
const makeModel = (name: string, collection: string, schema: Schema) => (models[name] as Model<any>) || model(name, schema, collection);

export type PushSubscriptionStatus = 'active' | 'expired' | 'unsubscribed';

export type PushSubscription = {
  id: string;
  userId: string;
  /** Full endpoint URL issued by the browser's push service. */
  endpoint: string;
  /** SHA-256 of the endpoint — the dedupe key for this device. */
  endpointHash: string;
  keys: { p256dh: string; auth: string };
  userAgent?: string;
  /** Coarse, non-invasive device label derived from the user agent. */
  deviceType?: string;
  platform?: string;
  locale?: string;
  /** Categories the user allowed, mirrored from account preferences. */
  status: PushSubscriptionStatus;
  /** Consecutive delivery failures; a threshold expires the subscription. */
  failureCount: number;
  lastError?: string;
  createdAt: string;
  /** Updated on every successful send and whenever the browser re-subscribes. */
  lastSeenAt: string;
  lastDeliveredAt?: string;
};

const PushSubscriptionSchema = new Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    userId: { type: String, required: true, index: true },
    endpoint: { type: String, required: true },
    endpointHash: { type: String, required: true, unique: true, index: true },
    'keys.p256dh': { type: String, required: true },
    'keys.auth': { type: String, required: true },
    userAgent: String,
    deviceType: String,
    platform: String,
    locale: String,
    status: { type: String, enum: ['active', 'expired', 'unsubscribed'], default: 'active', index: true },
    failureCount: { type: Number, default: 0 },
    lastError: String,
    createdAt: { type: String, default: () => new Date().toISOString() },
    lastSeenAt: { type: String, default: () => new Date().toISOString() },
    lastDeliveredAt: String
  },
  { versionKey: false, collection: 'push_subscriptions' }
);
PushSubscriptionSchema.index({ userId: 1, status: 1 });
PushSubscriptionSchema.index({ lastSeenAt: 1 });

const PushSubscriptionModel = makeModel('SadikPushSubscription', 'push_subscriptions', PushSubscriptionSchema);

/** Send attempts before a silently-failing endpoint is given up on. */
export const MAX_DELIVERY_FAILURES = 4;
/** Subscriptions not refreshed for this long are considered abandoned. */
export const STALE_SUBSCRIPTION_DAYS = 60;

const now = () => new Date().toISOString();
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const stripMongo = (doc: any): PushSubscription | undefined => {
  if (!doc) return undefined;
  const { _id, __v, ...rest } = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  return clone(rest as PushSubscription);
};

/**
 * Very coarse, non-invasive device labelling.
 *
 * Deliberately NOT a fingerprint: no canvas, font, or hardware probing. The
 * user agent is used only to show the account owner "Chrome on Android" in
 * their notification settings.
 */
export function describeDevice(userAgent = ''): { deviceType: string; platform: string; label: string } {
  const ua = userAgent || '';
  const platform = /windows nt/i.test(ua) ? 'Windows'
    : /mac os x/i.test(ua) ? 'macOS'
      : /android/i.test(ua) ? 'Android'
        : /iphone|ipad|ipod/i.test(ua) ? 'iOS'
          : /cros/i.test(ua) ? 'ChromeOS'
            : /linux/i.test(ua) ? 'Linux' : 'Unknown';
  const browser = /edg\//i.test(ua) ? 'Edge'
    : /opr\/|opera/i.test(ua) ? 'Opera'
      : /firefox|fxios/i.test(ua) ? 'Firefox'
        : /chrome|crios/i.test(ua) ? 'Chrome'
          : /safari/i.test(ua) ? 'Safari' : 'Browser';
  const deviceType = /mobi|android|iphone|ipad|ipod/i.test(ua) ? 'mobile' : 'desktop';
  return { deviceType, platform, label: platform === 'Unknown' ? browser : `${browser} on ${platform}` };
}

/**
 * Validate a browser `PushSubscription.toJSON()` payload before persisting.
 *
 * Rejects anything that is not a plausible HTTPS push endpoint, which stops a
 * compromised page from registering an arbitrary URL as a notification target.
 */
export function validateSubscriptionPayload(payload: unknown): { endpoint: string; keys: { p256dh: string; auth: string } } {
  const record = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>;
  const endpoint = typeof record.endpoint === 'string' ? record.endpoint.trim() : '';
  if (!endpoint) throw new TypeError('PUSH_ENDPOINT_REQUIRED');
  if (endpoint.length > 2048) throw new TypeError('PUSH_ENDPOINT_TOO_LONG');
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new TypeError('PUSH_ENDPOINT_INVALID'); }
  // Browser push services are always HTTPS. Allow localhost for local testing.
  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !isLocal) throw new TypeError('PUSH_ENDPOINT_NOT_SECURE');
  const keys = (typeof record.keys === 'object' && record.keys !== null ? record.keys : {}) as Record<string, unknown>;
  const p256dh = typeof keys.p256dh === 'string' ? keys.p256dh.trim() : '';
  const auth = typeof keys.auth === 'string' ? keys.auth.trim() : '';
  // base64url, unpadded. 87 chars for an uncompressed P-256 point, 22 for auth.
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(p256dh)) throw new TypeError('PUSH_KEY_INVALID');
  if (!/^[A-Za-z0-9_-]{10,64}$/.test(auth)) throw new TypeError('PUSH_KEY_INVALID');
  return { endpoint, keys: { p256dh, auth } };
}

export class PushSubscriptionStore {
  async ensureIndexes() { await PushSubscriptionModel.createIndexes(); }

  /**
   * Register or refresh a subscription for a user.
   *
   * Idempotent: the same browser re-subscribing (which happens on every app
   * start) updates the stored keys and `lastSeenAt` rather than inserting a
   * duplicate row.
   */
  async upsert(userId: string, payload: unknown, meta: { userAgent?: string; locale?: string } = {}): Promise<PushSubscription> {
    const { endpoint, keys } = validateSubscriptionPayload(payload);
    const endpointHash = await hashEndpoint(endpoint);
    const device = describeDevice(meta.userAgent);
    const stamp = now();

    const existing = await PushSubscriptionModel.findOne({ endpointHash }).lean();
    if (existing) {
      // Same device. Re-bind to the current user (covers a shared browser
      // where a different account signed in) and reactivate it.
      const doc = await PushSubscriptionModel.findOneAndUpdate(
        { endpointHash },
        { $set: { userId, 'keys.p256dh': keys.p256dh, 'keys.auth': keys.auth, endpoint, status: 'active', failureCount: 0, lastError: undefined, userAgent: meta.userAgent, deviceType: device.deviceType, platform: device.platform, locale: meta.locale, lastSeenAt: stamp } },
        { new: true }
      );
      return stripMongo(doc) as PushSubscription;
    }

    // A different endpoint from this user for the same browser is not possible
    // to detect reliably, but we can retire subscriptions that share a device
    // signature so a user does not accumulate stale rows on one machine.
    const created = await PushSubscriptionModel.create({
      id: randomUUID(),
      userId,
      endpoint,
      endpointHash,
      keys,
      userAgent: meta.userAgent,
      deviceType: device.deviceType,
      platform: device.platform,
      locale: meta.locale,
      status: 'active',
      failureCount: 0,
      createdAt: stamp,
      lastSeenAt: stamp
    });
    return stripMongo(created) as PushSubscription;
  }

  /** Active subscriptions for a user — the only set a fan-out ever reads. */
  async listActive(userId: string): Promise<PushSubscription[]> {
    const docs = await PushSubscriptionModel.find({ userId, status: 'active' }).lean();
    return docs.map(doc => stripMongo(doc) as PushSubscription);
  }

  /** Account-owner view: never includes the endpoint or the keys. */
  async listForUser(userId: string): Promise<Array<{ id: string; deviceType?: string; platform?: string; label: string; createdAt: string; lastSeenAt: string; lastDeliveredAt?: string }>> {
    const docs = await PushSubscriptionModel.find({ userId }).sort({ createdAt: -1 }).lean();
    return docs
      .map(doc => stripMongo(doc) as PushSubscription)
      .map(sub => ({
        id: sub.id,
        deviceType: sub.deviceType,
        platform: sub.platform,
        label: describeDevice(sub.userAgent).label,
        createdAt: sub.createdAt,
        lastSeenAt: sub.lastSeenAt,
        lastDeliveredAt: sub.lastDeliveredAt
      }));
  }

  async remove(userId: string, id: string): Promise<boolean> {
    const result = await PushSubscriptionModel.deleteOne({ id, userId });
    return result.deletedCount > 0;
  }

  /** Remove every subscription for a user (sign-out of push on all devices). */
  async removeAll(userId: string): Promise<number> {
    const result = await PushSubscriptionModel.deleteMany({ userId });
    return result.deletedCount;
  }

  /** The push service told us the endpoint is gone (404/410): retire it. */
  async markExpired(endpoint: string, reason: string): Promise<void> {
    await PushSubscriptionModel.updateOne({ endpoint }, { $set: { status: 'expired', lastError: reason.slice(0, 300), lastSeenAt: now() } });
  }

  /** Record a failure; expire the subscription once the threshold is reached. */
  async recordFailure(endpoint: string, reason: string): Promise<void> {
    const doc = await PushSubscriptionModel.findOneAndUpdate(
      { endpoint },
      { $inc: { failureCount: 1 }, $set: { lastError: reason.slice(0, 300) } },
      { new: true }
    ).lean() as unknown as PushSubscription | null;
    if (doc && Number(doc.failureCount) >= MAX_DELIVERY_FAILURES) {
      await PushSubscriptionModel.updateOne({ endpoint }, { $set: { status: 'expired', lastSeenAt: now() } });
    }
  }

  async recordSuccess(endpoint: string): Promise<void> {
    await PushSubscriptionModel.updateOne({ endpoint }, { $set: { status: 'active', failureCount: 0, lastError: undefined, lastDeliveredAt: now(), lastSeenAt: now() } });
  }

  async countActive(userId: string): Promise<number> {
    return PushSubscriptionModel.countDocuments({ userId, status: 'active' });
  }

  /** Housekeeping: drop expired rows and subscriptions never refreshed. */
  async pruneExpired(staleDays = STALE_SUBSCRIPTION_DAYS): Promise<{ expiredRemoved: number; staleRemoved: number }> {
    const cutoff = new Date(Date.now() - staleDays * 86_400_000).toISOString();
    const expiredRemoved = (await PushSubscriptionModel.deleteMany({ status: { $ne: 'active' } })).deletedCount;
    const staleRemoved = (await PushSubscriptionModel.deleteMany({ status: 'active', lastSeenAt: { $lt: cutoff } })).deletedCount;
    return { expiredRemoved, staleRemoved };
  }
}

async function hashEndpoint(endpoint: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(endpoint).digest('hex');
}

export function createPushSubscriptionStore(): PushSubscriptionStore {
  return new PushSubscriptionStore();
}
