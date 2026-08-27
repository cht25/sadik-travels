/**
 * Sadik Travels — per-user notification preferences.
 *
 * Users control two things: *which channels* they receive (in-app, push,
 * email) and *which categories* they care about (booking, payment, message,
 * promotion).
 *
 * Two rules are enforced here rather than at each call site:
 *
 *   1. Security alerts (`NEW_DEVICE_LOGIN`, `PASSWORD_CHANGED`,
 *      `PASSWORD_RESET_REQUESTED`) are never switched off. A preference cannot
 *      hide the signal that an account may be compromised.
 *   2. The legacy `marketingEmailOptIn` / `marketingInAppOptIn` flags on the
 *      user record still govern the `promotion` category, so existing
 *      opt-outs keep working after this change.
 */

import { isPreferenceGated, PREFERENCE_CATEGORIES, type NotificationChannel, type PreferenceCategory, type PreferenceKey } from './events.js';

export type ChannelPreferences = { inApp: boolean; push: boolean; email: boolean };
export type NotificationPreferences = Record<PreferenceCategory, ChannelPreferences>;

export type PreferenceInput = Partial<Record<PreferenceCategory, Partial<ChannelPreferences>>>;

const DEFAULTS: NotificationPreferences = {
  booking: { inApp: true, push: true, email: true },
  payment: { inApp: true, push: true, email: true },
  message: { inApp: true, push: true, email: true },
  // Promotions start quiet: in-app only. Email/push require an explicit opt-in
  // (or the legacy marketing flags, handled in `resolvePreferences`).
  promotion: { inApp: true, push: false, email: false }
};

export const CHANNEL_TO_PREFERENCE: Record<NotificationChannel, keyof ChannelPreferences> = {
  in_app: 'inApp',
  push: 'push',
  email: 'email'
};

export function defaultPreferences(): NotificationPreferences {
  return JSON.parse(JSON.stringify(DEFAULTS)) as NotificationPreferences;
}

export type PreferenceBearingUser = {
  notificationPreferences?: unknown;
  marketingEmailOptIn?: boolean;
  marketingInAppOptIn?: boolean;
};

function asChannelPreferences(value: unknown, fallback: ChannelPreferences): ChannelPreferences {
  const record = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const flag = (key: keyof ChannelPreferences) => (typeof record[key] === 'boolean' ? (record[key] as boolean) : fallback[key]);
  return { inApp: flag('inApp'), push: flag('push'), email: flag('email') };
}

/**
 * Merge a stored (possibly partial or legacy) preference blob with defaults.
 * Unknown keys are ignored so an old document never produces `undefined`
 * channel flags.
 */
export function resolvePreferences(user: PreferenceBearingUser): NotificationPreferences {
  const stored = (typeof user.notificationPreferences === 'object' && user.notificationPreferences !== null
    ? user.notificationPreferences
    : {}) as Record<string, unknown>;
  const resolved = defaultPreferences();
  for (const category of PREFERENCE_CATEGORIES) {
    resolved[category] = asChannelPreferences(stored[category], DEFAULTS[category]);
  }
  // Legacy marketing flags still win for the promotion category, so a customer
  // who unsubscribed before preferences existed stays unsubscribed.
  if (user.marketingEmailOptIn === false) resolved.promotion.email = false;
  if (user.marketingInAppOptIn === false) resolved.promotion.inApp = false;
  return resolved;
}

/** The user-facing settings payload (includes the read-only security row). */
export function preferencesView(user: PreferenceBearingUser): Record<PreferenceKey, ChannelPreferences> & { securityLocked: true } {
  const resolved = resolvePreferences(user);
  return {
    ...resolved,
    // Security alerts are always on; surfaced so the UI can render them as
    // locked rather than pretending the toggle does something.
    security: { inApp: true, push: true, email: true },
    securityLocked: true
  };
}

/**
 * Validate and normalise a settings PATCH from the account page.
 * Returns `undefined` for categories/flags that were not supplied, so an
 * omitted key is left untouched.
 */
export function sanitizePreferenceInput(input: unknown): PreferenceInput {
  const source = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const result: PreferenceInput = {};
  for (const category of PREFERENCE_CATEGORIES) {
    const raw = source[category];
    if (typeof raw !== 'object' || raw === null) continue;
    const patch: Partial<ChannelPreferences> = {};
    const record = raw as Record<string, unknown>;
    for (const key of ['inApp', 'push', 'email'] as const) {
      if (typeof record[key] === 'boolean') patch[key] = record[key] as boolean;
    }
    if (Object.keys(patch).length > 0) result[category] = patch;
  }
  return result;
}

export function applyPreferencePatch(current: PreferenceBearingUser, patch: PreferenceInput): NotificationPreferences {
  const next = resolvePreferences(current);
  for (const [category, channels] of Object.entries(patch)) {
    if (!channels) continue;
    next[category as PreferenceCategory] = { ...next[category as PreferenceCategory], ...channels };
  }
  return next;
}

/**
 * Should this channel deliver this event to this user?
 *
 * @param eventKey  canonical event key
 * @param channel   delivery channel being considered
 * @param user      the recipient record
 * @param category  optional override (defaults to the event's category)
 */
export function shouldDeliver(
  eventKey: string,
  channel: NotificationChannel,
  user: PreferenceBearingUser,
  category?: PreferenceCategory
): boolean {
  // Security-critical events bypass preferences entirely.
  if (!isPreferenceGated(eventKey)) return true;
  const resolved = resolvePreferences(user);
  const resolvedCategory = category || undefined;
  if (!resolvedCategory) {
    // Event declares no category: deliver on every channel it lists.
    return true;
  }
  return resolved[resolvedCategory][CHANNEL_TO_PREFERENCE[channel]];
}

/**
 * Whether the recipient wants *any* delivery for this event. Used to decide if
 * an in-app row should still be written when push and email are off.
 */
export function wantsAnyDelivery(eventKey: string, user: PreferenceBearingUser, category?: PreferenceCategory): boolean {
  if (!isPreferenceGated(eventKey)) return true;
  if (!category) return true;
  const resolved = resolvePreferences(user);
  const prefs = resolved[category];
  return prefs.inApp || prefs.push || prefs.email;
}
