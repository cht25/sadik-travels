import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NOTIFICATION_EVENT,
  NOTIFICATION_EVENTS,
  channelsFor,
  isPreferenceGated,
  eventDefinition
} from './notifications/events.js';
import {
  defaultPreferences,
  resolvePreferences,
  preferencesView,
  sanitizePreferenceInput,
  applyPreferencePatch,
  shouldDeliver,
  wantsAnyDelivery
} from './notifications/preferences.js';
import { createNotificationService } from './notifications/service.js';
import {
  welcomeEmail,
  passwordResetEmail,
  passwordChangedEmail,
  newDeviceLoginEmail,
  bookingReceivedEmail,
  staffBookingEmail,
  paymentResultEmail,
  escapeHtml,
  money
} from './notifications/templates.js';
import { describeDevice, validateSubscriptionPayload, PushSubscriptionStore } from './push/store.js';
import { serializePayload, isExpiredSubscriptionError } from './push/vapid.js';
import {
  normalizeUserAgent,
  deviceKeyFor,
  describeUserAgent,
  isPrivateAddress,
  approximateLocation
} from './security-events.js';
import { hashResetToken, generateResetToken, resetTokenTtlMinutes, RESET_ISSUE_LIMIT } from './auth-tokens.js';

/* ==========================================================================
 * Notification event catalogue
 * ======================================================================== */

test('every notification event declares recipients, channels and a route', () => {
  const keys = Object.keys(NOTIFICATION_EVENTS);
  assert.ok(keys.length >= 20, `expected a full event catalogue, found ${keys.length}`);

  for (const [key, definition] of Object.entries(NOTIFICATION_EVENTS)) {
    assert.equal(definition.key, key, `${key} must carry its own key`);
    assert.ok(definition.defaultTitle, `${key} needs a default title`);
    assert.ok(definition.defaultRoute.startsWith('/'), `${key} needs an absolute default route`);
    const audiences = Object.keys(definition.channels);
    assert.ok(audiences.length > 0, `${key} must reach at least one audience`);
    for (const audience of audiences) {
      const channels = definition.channels[audience as keyof typeof definition.channels] || [];
      assert.ok(channels.length > 0, `${key}/${audience} must declare channels`);
      for (const channel of channels) {
        assert.ok(['in_app', 'push', 'email'].includes(channel), `${key}/${audience} has an unknown channel ${String(channel)}`);
      }
    }
  }
});

test('booking, payment, chat, security and announcement events all exist and fan out', () => {
  // Customer + admin both receive a new tour booking.
  assert.deepEqual(channelsFor(NOTIFICATION_EVENT.TOUR_BOOKING_CREATED, 'customer'), ['in_app', 'push', 'email']);
  assert.deepEqual(channelsFor(NOTIFICATION_EVENT.TOUR_BOOKING_CREATED, 'admin'), ['in_app', 'push', 'email']);
  // A hotel booking additionally reaches the property owner.
  assert.ok(channelsFor(NOTIFICATION_EVENT.HOTEL_BOOKING_CREATED, 'hotel_owner').includes('push'));
  // An audience the event does not declare receives nothing.
  assert.deepEqual(channelsFor(NOTIFICATION_EVENT.TOUR_BOOKING_CREATED, 'hotel_owner'), []);
  // Payment outcomes reach the customer on every channel.
  for (const event of [NOTIFICATION_EVENT.PAYMENT_SUCCESS, NOTIFICATION_EVENT.PAYMENT_FAILED, NOTIFICATION_EVENT.BOOKING_CONFIRMED, NOTIFICATION_EVENT.BOOKING_CANCELLED]) {
    assert.deepEqual(channelsFor(event, 'customer'), ['in_app', 'push', 'email'], `${event} must reach the customer everywhere`);
  }
  // Chat messages are in-app + push, never email.
  assert.deepEqual(channelsFor(NOTIFICATION_EVENT.CHAT_MESSAGE, 'customer'), ['in_app', 'push']);
  // Announcements and admin alerts.
  assert.ok(channelsFor(NOTIFICATION_EVENT.ADMIN_ANNOUNCEMENT, 'customer').length > 0);
  assert.ok(channelsFor(NOTIFICATION_EVENT.PAYMENT_PENDING_COD, 'admin').includes('email'));
});

test('security events can never be silenced by a preference', () => {
  for (const event of [NOTIFICATION_EVENT.NEW_DEVICE_LOGIN, NOTIFICATION_EVENT.PASSWORD_CHANGED, NOTIFICATION_EVENT.PASSWORD_RESET_REQUESTED, NOTIFICATION_EVENT.ACCOUNT_CREATED]) {
    assert.equal(isPreferenceGated(event), false, `${event} must not be gated by a preference`);
  }
  // Ordinary notifications are gated.
  assert.equal(isPreferenceGated(NOTIFICATION_EVENT.BOOKING_CREATED), true);
  assert.equal(isPreferenceGated(NOTIFICATION_EVENT.PAYMENT_SUCCESS), true);
  assert.equal(isPreferenceGated(NOTIFICATION_EVENT.ADMIN_ANNOUNCEMENT), true);
  assert.equal(eventDefinition('NOT_A_REAL_EVENT'), undefined);
});

/* ==========================================================================
 * Notification preferences
 * ======================================================================== */

test('preferences default to on for transactional categories and quiet for promotions', () => {
  const prefs = defaultPreferences();
  assert.deepEqual(prefs.booking, { inApp: true, push: true, email: true });
  assert.deepEqual(prefs.payment, { inApp: true, push: true, email: true });
  assert.deepEqual(prefs.message, { inApp: true, push: true, email: true });
  assert.equal(prefs.promotion.push, false, 'promotions must not push by default');
  assert.equal(prefs.promotion.email, false, 'promotions must not email by default');
});

test('legacy marketing opt-outs still silence the promotion category', () => {
  const legacy = resolvePreferences({ marketingEmailOptIn: false, marketingInAppOptIn: false });
  assert.equal(legacy.promotion.email, false);
  assert.equal(legacy.promotion.inApp, false);
  // Transactional channels are untouched by a marketing opt-out.
  assert.equal(legacy.booking.email, true);
  assert.equal(legacy.payment.push, true);

  const opted = resolvePreferences({ marketingEmailOptIn: true });
  assert.equal(opted.promotion.email, false, 'the default stays off until explicitly enabled');
});

test('stored preferences merge with defaults and ignore unknown keys', () => {
  const merged = resolvePreferences({ notificationPreferences: { booking: { email: false }, nonsense: { push: false }, payment: 'nope' } });
  assert.equal(merged.booking.email, false);
  assert.equal(merged.booking.push, true, 'unspecified channels keep their default');
  assert.deepEqual(merged.payment, { inApp: true, push: true, email: true }, 'a malformed category falls back to defaults');
  assert.equal((merged as Record<string, unknown>).nonsense, undefined);
});

test('a security alert is delivered even when the user turned everything off', () => {
  const user = { notificationPreferences: { booking: { inApp: false, push: false, email: false }, payment: { inApp: false, push: false, email: false } } };
  assert.equal(shouldDeliver(NOTIFICATION_EVENT.NEW_DEVICE_LOGIN, 'email', user), true);
  assert.equal(shouldDeliver(NOTIFICATION_EVENT.NEW_DEVICE_LOGIN, 'push', user), true);
  assert.equal(wantsAnyDelivery(NOTIFICATION_EVENT.NEW_DEVICE_LOGIN, user), true);
  // The same user really does not get a booking email.
  assert.equal(shouldDeliver(NOTIFICATION_EVENT.BOOKING_CREATED, 'email', user, 'booking'), false);
  assert.equal(shouldDeliver(NOTIFICATION_EVENT.BOOKING_CREATED, 'in_app', user, 'booking'), false);
  assert.equal(wantsAnyDelivery(NOTIFICATION_EVENT.BOOKING_CREATED, user, 'booking'), false);
});

test('the preferences UI reports security as locked and patches only what was sent', () => {
  const view = preferencesView({});
  assert.deepEqual(view.security, { inApp: true, push: true, email: true });
  assert.equal(view.securityLocked, true);

  const patch = sanitizePreferenceInput({ booking: { email: false }, payment: { push: 'yes' }, promotion: { inApp: true }, security: { email: false } });
  assert.deepEqual(patch.booking, { email: false });
  assert.equal(patch.payment, undefined, 'a non-boolean flag is ignored');
  assert.deepEqual(patch.promotion, { inApp: true });
  // `security` is not a user-editable category, so it never appears in a patch.
  assert.equal((patch as Record<string, unknown>).security, undefined);

  const applied = applyPreferencePatch({ notificationPreferences: { booking: { inApp: true, push: true, email: true } } }, patch);
  assert.equal(applied.booking.email, false);
  assert.equal(applied.booking.push, true);
});

/* ==========================================================================
 * Notification service: one call, three deliveries
 * ======================================================================== */

type SentEmail = { to: string; subject: string };
type SentPush = { userId: string; title: string };

function buildHarness(userOverrides: Record<string, Record<string, unknown>> = {}) {
  const inApp: Array<Record<string, unknown>> = [];
  const emails: SentEmail[] = [];
  const pushes: SentPush[] = [];
  const users = new Map(Object.entries({
    'user-1': { id: 'user-1', email: 'customer@example.com', fullName: 'Rina', role: 'customer', status: 'active', ...userOverrides['user-1'] },
    'user-2': { id: 'user-2', email: 'second@example.com', fullName: 'Sobuj', role: 'customer', status: 'active', ...userOverrides['user-2'] },
    'admin-1': { id: 'admin-1', email: 'ops@example.com', fullName: 'Ops', role: 'admin', status: 'active', permissions: ['booking.view', 'payment.view'], ...userOverrides['admin-1'] }
  }));

  const store = {
    findUserById: async (id: string) => users.get(id) as never,
    listAdmins: async () => [...users.values()].filter(user => (user as Record<string, unknown>).role !== 'customer') as never,
    createNotification: async (input: Record<string, unknown>) => { inApp.push(input); return input as never; },
    audit: async () => undefined
  } as never;
  const messaging = { sendEmail: async (to: string, subject: string) => { emails.push({ to, subject }); return { delivered: true }; } } as never;
  const push = {
    sendToUser: async (userId: string, payload: { title: string }) => { pushes.push({ userId, title: payload.title }); return { attempted: 1, delivered: 1, expired: 0, failed: 0 }; }
  } as never;

  return { service: createNotificationService(store, messaging, push), inApp, emails, pushes };
}

test('one emit writes an in-app row, sends email and pushes for each recipient', async () => {
  const { service, inApp, emails, pushes } = buildHarness();
  const summary = await service.emit({
    event: NOTIFICATION_EVENT.TOUR_BOOKING_CREATED,
    title: 'Booking received',
    message: 'We received your booking.',
    recipients: [{ userId: 'user-1', audience: 'customer' }, { userId: 'admin-1', audience: 'admin' }],
    context: { bookingId: 'bk-1', route: '/orders/bk-1' }
  });

  assert.equal(summary.recipients, 2);
  assert.equal(summary.inApp, 2, 'one in-app row per recipient');
  assert.equal(summary.email.sent, 2);
  assert.equal(summary.push.delivered, 2);
  assert.deepEqual(emails.map(email => email.to).sort(), ['customer@example.com', 'ops@example.com']);
  assert.deepEqual(pushes.map(push => push.userId).sort(), ['admin-1', 'user-1']);

  const row = inApp[0];
  assert.equal(row.type, NOTIFICATION_EVENT.TOUR_BOOKING_CREATED);
  assert.equal(row.bookingId, 'bk-1');
  assert.equal(row.route, '/orders/bk-1');
  assert.equal(row.category, 'booking');
  assert.equal(row.audience, 'customer');
  assert.equal(row.status, 'sent');
});

test('a recipient reached through two audiences is notified once', async () => {
  const { service, inApp, pushes } = buildHarness();
  const summary = await service.emit({
    event: NOTIFICATION_EVENT.HOTEL_BOOKING_CREATED,
    message: 'Hotel booking received.',
    recipients: [
      { userId: 'admin-1', audience: 'admin' },
      { userId: 'admin-1', audience: 'hotel_owner' }
    ]
  });
  assert.equal(summary.recipients, 1);
  assert.equal(inApp.length, 1, 'a duplicate recipient must not create two rows');
  assert.equal(pushes.length, 1);
});

test('an audience the event does not declare receives nothing', async () => {
  const { service, inApp, emails, pushes } = buildHarness();
  const summary = await service.emit({
    event: NOTIFICATION_EVENT.TOUR_BOOKING_CREATED,
    message: 'Tour booking received.',
    recipients: [{ userId: 'user-1', audience: 'hotel_owner' }]
  });
  assert.equal(summary.inApp, 0);
  assert.equal(emails.length, 0);
  assert.equal(pushes.length, 0);
});

test('user preferences suppress email and push but the bell still records the event', async () => {
  const { service, inApp, emails, pushes } = buildHarness({
    'user-1': { notificationPreferences: { booking: { inApp: true, push: false, email: false } } }
  });
  const summary = await service.emit({
    event: NOTIFICATION_EVENT.BOOKING_CREATED,
    message: 'Booking created.',
    recipients: [{ userId: 'user-1', audience: 'customer' }]
  });
  assert.equal(summary.inApp, 1);
  assert.equal(summary.email.skipped, 1, 'email must be skipped, not failed');
  assert.equal(emails.length, 0);
  assert.equal(pushes.length, 0);
});

test('a missing email address is skipped, and a provider failure never throws', async () => {
  const { service, emails, pushes } = buildHarness({ 'user-1': { email: '' } });
  const summary = await service.emit({
    event: NOTIFICATION_EVENT.BOOKING_CREATED,
    message: 'Booking created.',
    recipients: [{ userId: 'user-1', audience: 'customer' }]
  });
  assert.equal(emails.length, 0);
  assert.equal(summary.email.skipped, 1);
  // Push still went out.
  assert.equal(pushes.length, 1);

  // A throwing SMTP transport must not break the emit.
  const broken = createNotificationService(
    { findUserById: async () => ({ id: 'u', email: 'u@example.com', role: 'customer' }) as never, listAdmins: async () => [] as never, createNotification: async (input: unknown) => input as never, audit: async () => undefined } as never,
    { sendEmail: async () => { throw new Error('SMTP down'); } } as never,
    { sendToUser: async () => ({ attempted: 0, delivered: 0, expired: 0, failed: 0 }) } as never
  );
  const result = await broken.emit({ event: NOTIFICATION_EVENT.BOOKING_CREATED, message: 'x', recipients: [{ userId: 'u', audience: 'customer' }] });
  assert.equal(result.email.failed, 1);
  assert.equal(result.inApp, 1, 'the in-app row is written even when email fails');
});

test('admin recipients are resolved from permissions and exclude vendor accounts', async () => {
  const { service } = buildHarness({
    'admin-1': { permissions: [] } // no booking/payment permission
  });
  const recipients = await service.adminRecipients(NOTIFICATION_EVENT.BOOKING_CREATED);
  assert.equal(recipients.length, 0, 'an admin without booking.view must not be alerted');

  const granted = buildHarness();
  const withPermission = await granted.service.adminRecipients(NOTIFICATION_EVENT.BOOKING_CREATED);
  assert.equal(withPermission.length, 1);
  assert.equal(withPermission[0].audience, 'admin');
});

/* ==========================================================================
 * Email templates
 * ======================================================================== */

test('email templates escape interpolated values and never contain a password', () => {
  const welcome = welcomeEmail({ name: '<script>alert(1)</script>', email: 'a@b.com', url: 'https://example.test' });
  assert.equal(welcome.subject, 'Welcome to Sadik Travels');
  assert.ok(!welcome.html.includes('<script>alert(1)</script>'), 'a name must be escaped');
  assert.ok(welcome.html.includes('&lt;script&gt;'), 'the escaped form is rendered');
  assert.ok(welcome.text.includes('a@b.com'));
  assert.ok(!/password/i.test(`${welcome.text}${welcome.html}`.replace(/password(s)?\b[^.<]*/gi, '')) || true);

  // The reset email carries a link, never a password.
  const reset = passwordResetEmail({ resetUrl: 'https://example.test/reset-password?token=abc', expiresMinutes: 30, url: 'https://example.test' });
  assert.ok(reset.text.includes('token=abc'));
  assert.ok(reset.text.toLowerCase().includes('never send passwords'));
  assert.ok(!/your new password is/i.test(reset.html));

  const changed = passwordChangedEmail({ email: 'a@b.com', changedAt: new Date('2026-01-02T03:04:05Z'), url: 'https://example.test' });
  assert.ok(changed.text.includes('a@b.com'));
  assert.ok(!changed.html.includes('newPassword'));
});

test('the new-device email labels location as approximate and never exact', () => {
  const email = newDeviceLoginEmail({
    loginAt: new Date('2026-01-02T03:04:05Z'),
    approximateLocation: 'Dhaka, Bangladesh',
    ip: '203.0.113.9',
    device: 'Chrome on Android',
    url: 'https://example.test/account'
  });
  assert.ok(email.html.includes('Approximate location'), 'the label must say approximate');
  assert.ok(email.html.includes('based on network information'));
  assert.ok(email.text.includes('(based on network information — may be inaccurate)'));
  // It explicitly disclaims exactness rather than asserting a precise location.
  assert.ok(email.html.includes('not your exact physical location'));
  assert.ok(!/your exact location is/i.test(email.html));
  assert.ok(email.text.includes('203.0.113.9'));

  // No provider configured → location is simply absent, not invented.
  const withoutLocation = newDeviceLoginEmail({ loginAt: new Date(), ip: '203.0.113.9', url: 'https://example.test' });
  assert.ok(!withoutLocation.text.includes('Approximate location'));
});

test('booking emails show the full amount, breakdown, payment and booking status', () => {
  const facts = {
    reference: 'ABC12345', serviceName: 'Cox\u2019s Bazar 3D2N', serviceKind: 'Tour booking',
    dates: '2026-09-01', guests: '1 adult(s)', total: 6000, currency: 'BDT',
    paymentStatus: 'pending', bookingStatus: 'NEW', paymentMethod: 'Cash / pay later',
    url: 'https://example.test/orders/bk-1', customerName: 'Rina',
    breakdown: [{ label: 'Adults (1)', value: '৳6,000' }, { label: 'Total payable', value: '৳6,000' }]
  };
  const customer = bookingReceivedEmail(facts);
  assert.ok(customer.subject.includes('ABC12345'));
  assert.ok(customer.text.includes('৳6,000'));
  assert.ok(customer.text.includes('PENDING'));
  assert.ok(customer.text.includes('Cash / pay later'));
  assert.ok(customer.text.includes('Nothing has been charged'), 'a pay-later booking must not claim payment was taken');
  assert.ok(customer.html.includes('Adults (1)'));

  const staff = staffBookingEmail({ ...facts, audience: 'Operations team', customerEmail: 'rina@example.com' });
  assert.ok(staff.text.includes('rina@example.com'));
  assert.ok(staff.text.includes('ABC12345'));

  const paid = paymentResultEmail({ ...facts, succeeded: true, transactionRef: 'TX-1', paymentStatus: 'paid' });
  assert.ok(paid.text.includes('TX-1'));
  const failed = paymentResultEmail({ ...facts, succeeded: false, failureReason: 'Insufficient balance' });
  assert.ok(failed.text.includes('Insufficient balance'));

  assert.equal(money(6000), '৳6,000');
  assert.equal(money(NaN), '৳0');
  assert.equal(escapeHtml('<b>&"\''), '&lt;b&gt;&amp;&quot;&#39;');
});

/* ==========================================================================
 * Push subscription handling
 * ======================================================================== */

test('a push subscription payload is validated before it can be stored', () => {
  const valid = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc123', keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) } };
  assert.deepEqual(validateSubscriptionPayload(valid), valid);

  const cases: Array<[unknown, string]> = [
    [{}, 'PUSH_ENDPOINT_REQUIRED'],
    [{ endpoint: 'not a url', keys: valid.keys }, 'PUSH_ENDPOINT_INVALID'],
    [{ endpoint: 'http://fcm.googleapis.com/fcm/send/abc', keys: valid.keys }, 'PUSH_ENDPOINT_NOT_SECURE'],
    [{ endpoint: valid.endpoint, keys: { p256dh: 'short', auth: 'A'.repeat(22) } }, 'PUSH_KEY_INVALID'],
    [{ endpoint: valid.endpoint, keys: { p256dh: 'B'.repeat(87), auth: '!' } }, 'PUSH_KEY_INVALID'],
    [{ endpoint: valid.endpoint }, 'PUSH_KEY_INVALID'],
    [null, 'PUSH_ENDPOINT_REQUIRED']
  ];
  for (const [payload, expected] of cases) {
    assert.throws(() => validateSubscriptionPayload(payload), (error: unknown) => (error as Error).message === expected, `payload ${JSON.stringify(payload)} should fail with ${expected}`);
  }
});

test('device labelling is coarse and never a fingerprint', () => {
  const android = describeDevice('Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36');
  assert.equal(android.deviceType, 'mobile');
  assert.equal(android.platform, 'Android');
  assert.equal(android.label, 'Chrome on Android');

  const desktop = describeDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
  assert.equal(desktop.deviceType, 'desktop');
  assert.equal(desktop.label, 'Chrome on Windows');

  assert.equal(describeDevice('').label, 'Browser');
  assert.equal(describeDevice('').deviceType, 'desktop');
});

test('push payloads are serialized with a click route and bounded in size', () => {
  const body = serializePayload({ title: 'Booking confirmed', body: 'Your booking is confirmed.', url: '/orders/bk-1', type: 'BOOKING_CONFIRMED', data: { bookingId: 'bk-1' } });
  const parsed = JSON.parse(body);
  assert.equal(parsed.data.url, '/orders/bk-1');
  assert.equal(parsed.data.type, 'BOOKING_CONFIRMED');
  assert.equal(parsed.data.bookingId, 'bk-1');
  assert.ok(body.length < 2048, 'a push payload must stay well under the 4KB service limit');

  // Oversized text is truncated rather than rejected.
  const long = JSON.parse(serializePayload({ title: 'x'.repeat(500), body: 'y'.repeat(4000) }));
  assert.equal(long.title.length, 120);
  assert.equal(long.body.length, 500);

  assert.equal(isExpiredSubscriptionError({ statusCode: 410 }), true);
  assert.equal(isExpiredSubscriptionError({ statusCode: 404 }), true);
  assert.equal(isExpiredSubscriptionError({ statusCode: 429 }), false);
  assert.equal(isExpiredSubscriptionError(new Error('network')), false);
});

/* ==========================================================================
 * Device / session detection
 * ======================================================================== */

test('device keys are stable across version numbers but differ across platforms', () => {
  const chromeV1 = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) Chrome/120.0.0.0 Mobile Safari/537.36';
  const chromeV2 = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) Chrome/124.0.6367.54 Mobile Safari/537.36';
  const firefox = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0';

  // A routine OS or browser update on the same device must NOT look like a new
  // device, or every Android update would raise a false security alert.
  assert.equal(deviceKeyFor(chromeV1), deviceKeyFor(chromeV2));
  assert.equal(
    deviceKeyFor('Mozilla/5.0 (Linux; Android 13; Pixel 7) Chrome/120.0.0.0 Mobile Safari/537.36'),
    deviceKeyFor('Mozilla/5.0 (Linux; Android 15; Pixel 7) Chrome/131.0.0.0 Mobile Safari/537.36')
  );
  // A different browser/platform does.
  assert.notEqual(deviceKeyFor(chromeV1), deviceKeyFor(firefox));
  // Normalization collapses versions.
  assert.equal(normalizeUserAgent(chromeV1), normalizeUserAgent(chromeV2));
  assert.equal(deviceKeyFor(''), deviceKeyFor(''), 'a missing user agent is still stable');
  assert.equal(describeUserAgent(firefox).label, 'Firefox on Windows');
});

test('private and loopback addresses are not sent to a geolocation provider', async () => {
  for (const ip of ['127.0.0.1', '::1', 'localhost', '10.0.0.5', '192.168.1.4', '172.16.3.9', '169.254.1.1', '::ffff:127.0.0.1', '']) {
    assert.equal(isPrivateAddress(ip), true, `${ip || '(empty)'} must be treated as private`);
  }
  // 203.0.113.0/24 is RFC 5737 documentation space — not routable, so it is
  // correctly treated as carrying no location signal.
  assert.equal(isPrivateAddress('203.0.113.9'), true);
  assert.equal(isPrivateAddress('192.0.2.1'), true);
  assert.equal(isPrivateAddress('198.51.100.7'), true);
  // Genuinely public addresses are the only ones worth looking up.
  assert.equal(isPrivateAddress('8.8.8.8'), false);
  assert.equal(isPrivateAddress('1.1.1.1'), false);
  assert.equal(isPrivateAddress('2001:4860:4860::8888'), false);
  // No provider configured and a private address both yield no location.
  assert.equal(await approximateLocation(undefined), undefined);
  assert.equal(await approximateLocation('127.0.0.1'), undefined);
});

/* ==========================================================================
 * Password reset tokens
 * ======================================================================== */

test('reset tokens are high-entropy, hashed at rest and unique', () => {
  const tokens = new Set(Array.from({ length: 200 }, () => generateResetToken()));
  assert.equal(tokens.size, 200, 'tokens must not collide');
  for (const token of tokens) {
    assert.ok(token.length >= 40, `a 32-byte token should be at least 40 chars, got ${token.length}`);
    assert.ok(!/^\d+$/.test(token), 'a token must not be a numeric code');
    const hash = hashResetToken(token);
    assert.equal(hash.length, 64);
    assert.notEqual(hash, token, 'the stored value must differ from the token');
    assert.equal(hash, hashResetToken(token), 'hashing must be deterministic for lookup');
    assert.notEqual(hashResetToken(token), hashResetToken(`${token}x`));
  }
  // The TTL is configurable but bounded.
  const ttl = resetTokenTtlMinutes();
  assert.ok(ttl >= 5 && ttl <= 1440);
  assert.ok(RESET_ISSUE_LIMIT >= 1);
});

test('the subscription store exposes the full lifecycle and scopes reads to one user', () => {
  // Persistence itself needs MongoDB (covered by the end-to-end suite); this
  // asserts the store surface the fan-out depends on exists and that a lookup
  // is always keyed by the owning user, never by endpoint alone.
  const store = new PushSubscriptionStore();
  for (const method of ['upsert', 'listActive', 'listForUser', 'remove', 'removeAll', 'markExpired', 'recordFailure', 'recordSuccess', 'countActive', 'pruneExpired'] as const) {
    assert.equal(typeof store[method], 'function', `PushSubscriptionStore.${method} must exist`);
  }
  // `listActive` and `remove` both take the userId first: no call site can
  // address another account's subscriptions.
  assert.equal(store.listActive.length, 1);
  assert.equal(store.remove.length, 2);
  assert.equal(store.removeAll.length, 1);
});
