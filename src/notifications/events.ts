/**
 * Sadik Travels — notification event catalogue.
 *
 * Every notification in the product is emitted through `NotificationService`
 * with one of these keys. The catalogue is the single place that decides
 *
 *   - who receives an event (`audience`),
 *   - which delivery channels each audience gets (`channels`),
 *   - which user preference category gates it (`category`).
 *
 * Adding a notification means adding an entry here and calling
 * `notifications.emit(EVENT.BOOKING_CREATED, …)`. Notification logic must not
 * be sprinkled through route handlers.
 */

export const NOTIFICATION_CHANNELS = ['in_app', 'push', 'email'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/**
 * Preference categories a user can switch off.
 * `security` is deliberately NOT in this list: sign-in and password alerts are
 * always delivered (see `isPreferenceGated`).
 */
export const PREFERENCE_CATEGORIES = ['booking', 'payment', 'message', 'promotion'] as const;
export type PreferenceCategory = (typeof PREFERENCE_CATEGORIES)[number];
export type PreferenceKey = PreferenceCategory | 'security';

/** Who an event fans out to. */
export type NotificationAudience = 'customer' | 'admin' | 'hotel_owner' | 'home_owner' | 'travel_agent';

export type NotificationEventDefinition = {
  key: string;
  /** Preference category that can silence it (absent = always on). */
  category?: PreferenceCategory;
  /** Human title used when the caller does not supply one. */
  defaultTitle: string;
  /** Where a notification click should go, when known. */
  defaultRoute: string;
  /** audience → channels */
  channels: Partial<Record<NotificationAudience, NotificationChannel[]>>;
};

/**
 * Canonical event keys. Use `NOTIFICATION_EVENT.X` rather than string literals
 * so a typo is a compile error.
 */
export const NOTIFICATION_EVENT = {
  BOOKING_CREATED: 'BOOKING_CREATED',
  BOOKING_CONFIRMED: 'BOOKING_CONFIRMED',
  BOOKING_CANCELLED: 'BOOKING_CANCELLED',
  BOOKING_UPDATED: 'BOOKING_UPDATED',
  HOTEL_BOOKING_CREATED: 'HOTEL_BOOKING_CREATED',
  HOTEL_BOOKING_UPDATED: 'HOTEL_BOOKING_UPDATED',
  TOUR_BOOKING_CREATED: 'TOUR_BOOKING_CREATED',
  PAYMENT_INITIATED: 'PAYMENT_INITIATED',
  PAYMENT_SUCCESS: 'PAYMENT_SUCCESS',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  PAYMENT_PENDING_COD: 'PAYMENT_PENDING_COD',
  PAYMENT_MANUALLY_CONFIRMED: 'PAYMENT_MANUALLY_CONFIRMED',
  PAYMENT_REJECTED: 'PAYMENT_REJECTED',
  REFUND_ISSUED: 'REFUND_ISSUED',
  CHAT_MESSAGE: 'CHAT_MESSAGE',
  ADMIN_ANNOUNCEMENT: 'ADMIN_ANNOUNCEMENT',
  ACCOUNT_CREATED: 'ACCOUNT_CREATED',
  PASSWORD_CHANGED: 'PASSWORD_CHANGED',
  PASSWORD_RESET_REQUESTED: 'PASSWORD_RESET_REQUESTED',
  NEW_DEVICE_LOGIN: 'NEW_DEVICE_LOGIN'
} as const;

export type NotificationEventKey = (typeof NOTIFICATION_EVENT)[keyof typeof NOTIFICATION_EVENT];

const CUSTOMER_ALL: NotificationChannel[] = ['in_app', 'push', 'email'];
const STAFF_ALL: NotificationChannel[] = ['in_app', 'push', 'email'];

export const NOTIFICATION_EVENTS: Record<NotificationEventKey, NotificationEventDefinition> = {
  BOOKING_CREATED: {
    key: NOTIFICATION_EVENT.BOOKING_CREATED,
    category: 'booking',
    defaultTitle: 'Booking received',
    defaultRoute: '/orders',
    channels: { customer: CUSTOMER_ALL, admin: STAFF_ALL }
  },
  BOOKING_CONFIRMED: {
    key: NOTIFICATION_EVENT.BOOKING_CONFIRMED,
    category: 'booking',
    defaultTitle: 'Booking confirmed',
    defaultRoute: '/orders',
    channels: { customer: CUSTOMER_ALL, admin: STAFF_ALL }
  },
  BOOKING_CANCELLED: {
    key: NOTIFICATION_EVENT.BOOKING_CANCELLED,
    category: 'booking',
    defaultTitle: 'Booking cancelled',
    defaultRoute: '/orders',
    channels: { customer: CUSTOMER_ALL, admin: STAFF_ALL, hotel_owner: STAFF_ALL }
  },
  BOOKING_UPDATED: {
    key: NOTIFICATION_EVENT.BOOKING_UPDATED,
    category: 'booking',
    defaultTitle: 'Booking update',
    defaultRoute: '/orders',
    channels: { customer: CUSTOMER_ALL, admin: STAFF_ALL, hotel_owner: STAFF_ALL, home_owner: STAFF_ALL, travel_agent: STAFF_ALL }
  },
  HOTEL_BOOKING_CREATED: {
    key: NOTIFICATION_EVENT.HOTEL_BOOKING_CREATED,
    category: 'booking',
    defaultTitle: 'Hotel booking received',
    defaultRoute: '/orders',
    // The owner receives it too, but the service resolves the owner from
    // `hotel.ownerId` — never from anything the browser sent.
    channels: { customer: CUSTOMER_ALL, admin: STAFF_ALL, hotel_owner: STAFF_ALL }
  },
  HOTEL_BOOKING_UPDATED: {
    key: NOTIFICATION_EVENT.HOTEL_BOOKING_UPDATED,
    category: 'booking',
    defaultTitle: 'Hotel booking update',
    defaultRoute: '/orders',
    channels: { customer: CUSTOMER_ALL, admin: STAFF_ALL, hotel_owner: STAFF_ALL }
  },
  TOUR_BOOKING_CREATED: {
    key: NOTIFICATION_EVENT.TOUR_BOOKING_CREATED,
    category: 'booking',
    defaultTitle: 'Tour booking received',
    defaultRoute: '/orders',
    channels: { customer: CUSTOMER_ALL, admin: STAFF_ALL }
  },
  PAYMENT_INITIATED: {
    key: NOTIFICATION_EVENT.PAYMENT_INITIATED,
    category: 'payment',
    defaultTitle: 'Payment started',
    defaultRoute: '/payments',
    channels: { customer: ['in_app'], admin: ['in_app'] }
  },
  PAYMENT_SUCCESS: {
    key: NOTIFICATION_EVENT.PAYMENT_SUCCESS,
    category: 'payment',
    defaultTitle: 'Payment received',
    defaultRoute: '/payments',
    channels: { customer: CUSTOMER_ALL, admin: STAFF_ALL, hotel_owner: ['in_app', 'email'] }
  },
  PAYMENT_FAILED: {
    key: NOTIFICATION_EVENT.PAYMENT_FAILED,
    category: 'payment',
    defaultTitle: 'Payment failed',
    defaultRoute: '/payments',
    channels: { customer: CUSTOMER_ALL, admin: ['in_app', 'push'] }
  },
  PAYMENT_PENDING_COD: {
    key: NOTIFICATION_EVENT.PAYMENT_PENDING_COD,
    category: 'payment',
    defaultTitle: 'Pay later booking created',
    defaultRoute: '/payments',
    channels: { customer: CUSTOMER_ALL, admin: STAFF_ALL, hotel_owner: STAFF_ALL }
  },
  PAYMENT_MANUALLY_CONFIRMED: {
    key: NOTIFICATION_EVENT.PAYMENT_MANUALLY_CONFIRMED,
    category: 'payment',
    defaultTitle: 'Payment confirmed',
    defaultRoute: '/payments',
    channels: { customer: CUSTOMER_ALL, admin: ['in_app'] }
  },
  PAYMENT_REJECTED: {
    key: NOTIFICATION_EVENT.PAYMENT_REJECTED,
    category: 'payment',
    defaultTitle: 'Payment could not be confirmed',
    defaultRoute: '/payments',
    channels: { customer: CUSTOMER_ALL, admin: ['in_app'] }
  },
  REFUND_ISSUED: {
    key: NOTIFICATION_EVENT.REFUND_ISSUED,
    category: 'payment',
    defaultTitle: 'Refund issued',
    defaultRoute: '/payments',
    channels: { customer: CUSTOMER_ALL, admin: ['in_app', 'email'] }
  },
  CHAT_MESSAGE: {
    key: NOTIFICATION_EVENT.CHAT_MESSAGE,
    category: 'message',
    defaultTitle: 'New message',
    defaultRoute: '/support',
    channels: { customer: ['in_app', 'push'], admin: ['in_app', 'push'], hotel_owner: ['in_app', 'push'] }
  },
  ADMIN_ANNOUNCEMENT: {
    key: NOTIFICATION_EVENT.ADMIN_ANNOUNCEMENT,
    category: 'promotion',
    defaultTitle: 'Announcement',
    defaultRoute: '/',
    channels: { customer: ['in_app', 'push', 'email'] }
  },
  ACCOUNT_CREATED: {
    key: NOTIFICATION_EVENT.ACCOUNT_CREATED,
    defaultTitle: 'Welcome to Sadik Travels',
    defaultRoute: '/',
    // No category: a welcome email is part of account creation, not marketing.
    channels: { customer: ['email'], admin: ['email'] }
  },
  PASSWORD_CHANGED: {
    key: NOTIFICATION_EVENT.PASSWORD_CHANGED,
    defaultTitle: 'Your password was changed',
    defaultRoute: '/account',
    channels: { customer: ['in_app', 'email'], admin: ['in_app', 'email'] }
  },
  PASSWORD_RESET_REQUESTED: {
    key: NOTIFICATION_EVENT.PASSWORD_RESET_REQUESTED,
    defaultTitle: 'Reset your Sadik Travels password',
    defaultRoute: '/reset-password',
    channels: { customer: ['email'], admin: ['email'] }
  },
  NEW_DEVICE_LOGIN: {
    key: NOTIFICATION_EVENT.NEW_DEVICE_LOGIN,
    defaultTitle: 'New sign-in detected',
    defaultRoute: '/account',
    channels: { customer: ['in_app', 'push', 'email'], admin: ['in_app', 'push', 'email'] }
  }
};

/** Security-critical events are never silenced by a user preference. */
export const ALWAYS_DELIVERED_EVENTS: ReadonlySet<NotificationEventKey> = new Set([
  NOTIFICATION_EVENT.NEW_DEVICE_LOGIN,
  NOTIFICATION_EVENT.PASSWORD_CHANGED,
  NOTIFICATION_EVENT.PASSWORD_RESET_REQUESTED,
  NOTIFICATION_EVENT.ACCOUNT_CREATED
]);

export function eventDefinition(key: string): NotificationEventDefinition | undefined {
  return (NOTIFICATION_EVENTS as Record<string, NotificationEventDefinition>)[key];
}

/**
 * Channels allowed for an audience on an event, before user preferences are
 * applied. An audience absent from `channels` receives nothing.
 */
export function channelsFor(key: string, audience: NotificationAudience): NotificationChannel[] {
  return eventDefinition(key)?.channels[audience] || [];
}

/** True when a user preference may switch the event off. */
export function isPreferenceGated(key: string): boolean {
  return !ALWAYS_DELIVERED_EVENTS.has(key as NotificationEventKey);
}
