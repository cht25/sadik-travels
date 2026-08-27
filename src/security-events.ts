import mongoose, { Schema, model, type Model } from 'mongoose';
import { createHash, randomUUID } from 'node:crypto';
import { config } from './config.js';

/**
 * Sadik Travels — device/session detection and security events.
 *
 * Purpose: tell an account owner when their account is used somewhere new, and
 * keep a record an operator can review.
 *
 * Detection is deliberately *not* fingerprinting. The only signals used are:
 *
 *   - the User-Agent string the browser already sends with every request,
 *   - the network (IP) address, used only for a coarse approximate location,
 *   - the user's own history of previously-seen devices.
 *
 * There is no canvas, font, WebGL, screen or hardware probing, and nothing is
 * read from the browser beyond the standard request headers.
 *
 * A device is "new" when its User-Agent signature has not been seen for that
 * account before. That is a reasonable, explainable signal; it is not
 * advertised as fraud detection and it never blocks a sign-in.
 */

const models = mongoose.models as Record<string, Model<any>>;
const makeModel = (name: string, collection: string, schema: Schema) => (models[name] as Model<any>) || model(name, schema, collection);

export type UserDevice = {
  id: string;
  userId: string;
  /** SHA-256 of the normalized User-Agent. Never stores a raw fingerprint. */
  deviceKey: string;
  userAgent?: string;
  deviceLabel: string;
  platform: string;
  firstSeenAt: string;
  lastSeenAt: string;
  /** Count of successful sign-ins from this device. */
  loginCount: number;
  lastIp?: string;
  lastApproximateLocation?: string;
};

export type SecurityEventType = 'new_device_login' | 'password_changed' | 'password_reset_requested' | 'account_created' | 'failed_login';

export type SecurityEvent = {
  id: string;
  userId: string;
  type: SecurityEventType;
  at: string;
  ip?: string;
  /** Approximate, network-derived. May be wrong; never presented as exact. */
  approximateLocation?: string;
  deviceLabel?: string;
  userAgent?: string;
  /** Whether the alert email was handed to SMTP successfully. */
  notifiedByEmail: boolean;
  emailError?: string;
};

const UserDeviceSchema = new Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    userId: { type: String, required: true, index: true },
    deviceKey: { type: String, required: true, index: true },
    userAgent: String,
    deviceLabel: String,
    platform: String,
    firstSeenAt: String,
    lastSeenAt: String,
    loginCount: { type: Number, default: 1 },
    lastIp: String,
    lastApproximateLocation: String
  },
  { versionKey: false, collection: 'user_devices' }
);
UserDeviceSchema.index({ userId: 1, deviceKey: 1 }, { unique: true });

const SecurityEventSchema = new Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    userId: { type: String, required: true, index: true },
    type: { type: String, required: true, index: true },
    at: { type: String, required: true, index: true },
    ip: String,
    approximateLocation: String,
    deviceLabel: String,
    userAgent: String,
    notifiedByEmail: { type: Boolean, default: false },
    emailError: String
  },
  { versionKey: false, collection: 'security_events' }
);
SecurityEventSchema.index({ userId: 1, at: -1 });

const UserDeviceModel = makeModel('SadikUserDevice', 'user_devices', UserDeviceSchema);
const SecurityEventModel = makeModel('SadikSecurityEvent', 'security_events', SecurityEventSchema);

const now = () => new Date().toISOString();
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const strip = <T>(doc: any): T | undefined => { if (!doc) return undefined; const { _id, __v, ...rest } = doc as any; return clone(rest) as T; };

/**
 * Strip volatile User-Agent tokens so the same device keeps one key.
 *
 * Every digit run is collapsed — not just dotted version numbers. Without that,
 * a routine Android 13 → 14 or Chrome 120 → 124 update would look like a brand
 * new device and send a spurious security alert. The resulting key is
 * effectively "browser + platform + form factor", which is exactly what the
 * alert tells the user, so the signal matches the claim.
 */
export function normalizeUserAgent(userAgent = ''): string {
  return (userAgent || 'unknown')
    .replace(/\d+/g, '#')               // every version/OS/model number
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function deviceKeyFor(userAgent = ''): string {
  return createHash('sha256').update(normalizeUserAgent(userAgent)).digest('hex');
}

/** Coarse, human-readable device label for the security email and settings UI. */
export function describeUserAgent(userAgent = ''): { label: string; platform: string } {
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
  const form = /mobi|android|iphone|ipad|ipod/i.test(ua) ? 'mobile' : 'desktop';
  return { label: platform === 'Unknown' ? `${browser} (${form})` : `${browser} on ${platform}`, platform };
}

/**
 * Addresses that carry no location signal and must never be sent to a
 * geolocation provider: loopback, RFC 1918 private ranges, link-local, and the
 * reserved documentation ranges (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24)
 * which are not routable in the first place.
 */
export function isPrivateAddress(ip = ''): boolean {
  const value = ip.replace(/^::ffff:/, '').trim();
  if (!value || value === '::1' || value.toLowerCase() === 'localhost') return true;
  if (/^(10\.|127\.|0\.|169\.254\.|192\.0\.0\.|192\.0\.2\.|198\.18\.|198\.51\.100\.|203\.0\.113\.)/.test(value)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(value)) return true;
  if (/^192\.168\./.test(value)) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(value)) return true;
  return false;
}

/**
 * Resolve an *approximate* location for an IP address.
 *
 * Only runs when the operator configured `IP_GEO_URL`. The result is always an
 * estimate derived from network information and is labelled that way wherever
 * it is shown. When no provider is configured — or the lookup fails — the
 * location is simply omitted; it is never guessed or fabricated.
 */
export async function approximateLocation(ip: string | undefined, timeoutMs = 4000): Promise<string | undefined> {
  if (!ip || isPrivateAddress(ip) || !config.ipGeoUrl) return undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = config.ipGeoUrl.replace('{ip}', encodeURIComponent(ip));
    const response = await fetch(url, {
      headers: {
        accept: 'application/json',
        ...(config.ipGeoToken ? { authorization: `Bearer ${config.ipGeoToken}` } : {})
      },
      signal: controller.signal
    });
    if (!response.ok) return undefined;
    const payload = (await response.json().catch(() => ({}))) as Record<string, any>;
    const parts = [
      typeof payload.city === 'string' ? payload.city : undefined,
      typeof payload.region === 'string' ? payload.region : (typeof payload.regionName === 'string' ? payload.regionName : undefined),
      typeof payload.country === 'string' ? payload.country : undefined
    ].filter((part): part is string => Boolean(part && part.trim()));
    return parts.length > 0 ? parts.join(', ') : undefined;
  } catch {
    // A geo lookup must never delay or fail a sign-in.
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export type LoginSignal = { userId: string; ip?: string; userAgent?: string };

export class SecurityEventService {
  async ensureIndexes() {
    await Promise.all([UserDeviceModel.createIndexes(), SecurityEventModel.createIndexes()]);
  }

  /**
   * Record a sign-in and report whether it came from a device the account has
   * not been used on before.
   *
   * The first ever sign-in for an account is *not* reported as a new device —
   * there is nothing to compare against and it would produce a spurious alert
   * on account creation.
   */
  async recordLogin(signal: LoginSignal): Promise<{ isNewDevice: boolean; device: UserDevice; knownDeviceCount: number; approximateLocation?: string }> {
    const deviceKey = deviceKeyFor(signal.userAgent);
    const { label, platform } = describeUserAgent(signal.userAgent);
    const stamp = now();

    const existing = await UserDeviceModel.findOne({ userId: signal.userId, deviceKey }).lean();
    const knownDeviceCount = await UserDeviceModel.countDocuments({ userId: signal.userId, deviceKey: { $ne: deviceKey } });

    if (existing) {
      const location = await approximateLocation(signal.ip);
      await UserDeviceModel.updateOne(
        { userId: signal.userId, deviceKey },
        { $inc: { loginCount: 1 }, $set: { lastSeenAt: stamp, lastIp: signal.ip, userAgent: signal.userAgent, deviceLabel: label, platform, ...(location ? { lastApproximateLocation: location } : {}) } }
      );
      const updated = await UserDeviceModel.findOne({ userId: signal.userId, deviceKey }).lean();
      return { isNewDevice: false, device: strip<UserDevice>(updated) as UserDevice, knownDeviceCount, approximateLocation: location };
    }

    const device = await UserDeviceModel.create({
      id: randomUUID(),
      userId: signal.userId,
      deviceKey,
      userAgent: signal.userAgent,
      deviceLabel: label,
      platform,
      firstSeenAt: stamp,
      lastSeenAt: stamp,
      loginCount: 1,
      lastIp: signal.ip
    });
    const location = await approximateLocation(signal.ip);
    if (location) await UserDeviceModel.updateOne({ userId: signal.userId, deviceKey }, { $set: { lastApproximateLocation: location } });

    return {
      // Only meaningful once the account already had at least one device.
      isNewDevice: knownDeviceCount > 0,
      device: strip<UserDevice>(device) as UserDevice,
      knownDeviceCount,
      approximateLocation: location
    };
  }

  async recordEvent(event: Omit<SecurityEvent, 'id' | 'at' | 'notifiedByEmail'> & { at?: string; notifiedByEmail?: boolean; emailError?: string }): Promise<SecurityEvent> {
    const created = await SecurityEventModel.create({
      id: randomUUID(),
      at: event.at || now(),
      notifiedByEmail: Boolean(event.notifiedByEmail),
      ...event
    });
    return strip<SecurityEvent>(created) as SecurityEvent;
  }

  async markNotified(eventId: string, notifiedByEmail: boolean, emailError?: string): Promise<void> {
    await SecurityEventModel.updateOne({ id: eventId }, { $set: { notifiedByEmail, ...(emailError ? { emailError } : {}) } });
  }

  async listEvents(userId: string, limit = 20): Promise<SecurityEvent[]> {
    const docs = await SecurityEventModel.find({ userId }).sort({ at: -1 }).limit(Math.min(100, Math.max(1, limit))).lean();
    return docs.map(doc => strip<SecurityEvent>(doc) as SecurityEvent);
  }

  async listDevices(userId: string): Promise<UserDevice[]> {
    const docs = await UserDeviceModel.find({ userId }).sort({ lastSeenAt: -1 }).lean();
    return docs.map(doc => strip<UserDevice>(doc) as UserDevice);
  }

  /** Account owner removes a remembered device (does not revoke sessions). */
  async forgetDevice(userId: string, id: string): Promise<boolean> {
    const result = await UserDeviceModel.deleteOne({ id, userId });
    return result.deletedCount > 0;
  }
}

export function createSecurityEventService(): SecurityEventService {
  return new SecurityEventService();
}
