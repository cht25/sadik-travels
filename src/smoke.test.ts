import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { io as createSocket, type Socket } from 'socket.io-client';
import { effectiveFinePermissions, hasFinePermission, ROLE_PERMISSION_PRESETS, getRolePreset, auditAndMigrateVendorPermissions, sanitizePermissions } from './permissions.js';
import { conversationDedupKey, encodeDedupKey, hashGuestSecret, parseIdentityCredentials, verifyGuestSecret } from './chat/keys.js';
import { ACTIVE_CATALOG_TYPES, RETIRED_VERTICAL_TYPES, isRetiredAdminNavItem } from './legacy-purge.js';
import { computeTourQuote, tourPricingFromRecord, normalizeTravellers, assertQuoteConsistent, BD_VAT_PCT, BD_AIT_PCT } from './pricing.js';

test('retired verticals such as the legacy Umrah fare entry are rejected everywhere', () => {
  // The persisted row behind "Special Umrah Fair": its base path (/admin/catalog)
  // is still live, so only the `?type=` discriminator identifies it.
  assert.equal(isRetiredAdminNavItem({ label: 'Special Umrah Fair', route: '/admin/catalog?type=umrah_fare' }), true);
  assert.equal(isRetiredAdminNavItem({ label: 'Umrah Fair', route: '/admin/catalog?type=umrah_package' }), true);
  assert.equal(isRetiredAdminNavItem({ label: 'special umrah fare', route: '/admin/catalog?type=holiday_package' }), true);
  assert.equal(isRetiredAdminNavItem({ label: 'Umrah', route: '/admin/umrah-fair' }), true);
  assert.equal(isRetiredAdminNavItem({ label: 'eSIM', route: '/admin/esim' }), true);

  // Preserved modules must keep working.
  for (const item of [
    { label: 'Hotels & Rooms', route: '/admin/hotels' },
    { label: 'Homes & Villas', route: '/admin/catalog?type=home' },
    { label: 'Tours', route: '/admin/tours' },
    { label: 'Holiday Packages', route: '/admin/catalog?type=holiday_package' },
    { label: 'Destinations (Explore)', route: '/admin/catalog?type=destination' },
    { label: 'Travel Agents', route: '/admin/travel-agents' },
    { label: 'Hotel Bookings', route: '/admin/hotel-bookings' }
  ]) assert.equal(isRetiredAdminNavItem(item), false, `${item.label} must be preserved`);

  // The retired and active catalogue type lists must never overlap.
  assert.equal(ACTIVE_CATALOG_TYPES.some((type) => (RETIRED_VERTICAL_TYPES as readonly string[]).includes(type)), false);
  assert.equal((RETIRED_VERTICAL_TYPES as readonly string[]).includes('umrah_fare'), true);
});

test('role-based permission presets: Hotel Owner receives complete hotel preset and unrelated modules remain disabled', () => {
  // 1. Hotel owner default role preset
  const hotelOwner = { role: 'hotel_owner' as const };
  const hotelPerms = effectiveFinePermissions(hotelOwner);
  assert.deepEqual(hotelPerms, ROLE_PERMISSION_PRESETS.hotel_owner);

  // Hotel features are enabled
  assert.equal(hasFinePermission(hotelOwner, 'dashboard.view'), true);
  assert.equal(hasFinePermission(hotelOwner, 'reports.view'), true);
  assert.equal(hasFinePermission(hotelOwner, 'hotel.view'), true);
  assert.equal(hasFinePermission(hotelOwner, 'hotel.create'), true);
  assert.equal(hasFinePermission(hotelOwner, 'hotel.update'), true);
  assert.equal(hasFinePermission(hotelOwner, 'hotel.delete'), true);
  assert.equal(hasFinePermission(hotelOwner, 'room.view'), true);
  assert.equal(hasFinePermission(hotelOwner, 'room.create'), true);
  assert.equal(hasFinePermission(hotelOwner, 'room.update'), true);
  assert.equal(hasFinePermission(hotelOwner, 'room.delete'), true);
  assert.equal(hasFinePermission(hotelOwner, 'booking.view'), true);
  assert.equal(hasFinePermission(hotelOwner, 'booking.create'), true);
  assert.equal(hasFinePermission(hotelOwner, 'booking.update'), true);
  assert.equal(hasFinePermission(hotelOwner, 'booking.cancel'), true);
  assert.equal(hasFinePermission(hotelOwner, 'booking.refund'), true);
  assert.equal(hasFinePermission(hotelOwner, 'media.view'), true);
  assert.equal(hasFinePermission(hotelOwner, 'media.upload'), true);
  assert.equal(hasFinePermission(hotelOwner, 'media.delete'), true);
  assert.equal(hasFinePermission(hotelOwner, 'review.view'), true);
  assert.equal(hasFinePermission(hotelOwner, 'review.moderate'), true);
  assert.equal(hasFinePermission(hotelOwner, 'review.delete'), true);

  // Unrelated marketplace features MUST remain disabled by default
  assert.equal(hasFinePermission(hotelOwner, 'home.view'), false);
  assert.equal(hasFinePermission(hotelOwner, 'home.create'), false);
  assert.equal(hasFinePermission(hotelOwner, 'tour.view'), false);
  assert.equal(hasFinePermission(hotelOwner, 'tour.create'), false);
  assert.equal(hasFinePermission(hotelOwner, 'agent.view'), false);
  assert.equal(hasFinePermission(hotelOwner, 'catalog.view'), false);
  assert.equal(hasFinePermission(hotelOwner, 'order.view'), false);
  assert.equal(hasFinePermission(hotelOwner, 'coupon.view'), false);
  assert.equal(hasFinePermission(hotelOwner, 'customer.view'), false);
  assert.equal(hasFinePermission(hotelOwner, 'user.manage'), false);
  assert.equal(hasFinePermission(hotelOwner, 'payment.view'), false);
  assert.equal(hasFinePermission(hotelOwner, 'support.view'), false);
  assert.equal(hasFinePermission(hotelOwner, 'settings.view'), false);
  assert.equal(hasFinePermission(hotelOwner, 'settings.edit'), false);
  assert.equal(hasFinePermission(hotelOwner, 'service.manage'), false);
  assert.equal(hasFinePermission(hotelOwner, 'navigation.manage'), false);
  assert.equal(hasFinePermission(hotelOwner, 'admin.manage'), false);

  // 2. Home Owner role preset
  const homeOwner = { role: 'home_owner' as const };
  assert.deepEqual(effectiveFinePermissions(homeOwner), ROLE_PERMISSION_PRESETS.home_owner);
  assert.equal(hasFinePermission(homeOwner, 'home.view'), true);
  assert.equal(hasFinePermission(homeOwner, 'hotel.view'), false);
  assert.equal(hasFinePermission(homeOwner, 'tour.view'), false);
  assert.equal(hasFinePermission(homeOwner, 'agent.view'), false);

  // 3. Travel Agent role preset
  const travelAgent = { role: 'travel_agent' as const };
  assert.deepEqual(effectiveFinePermissions(travelAgent), ROLE_PERMISSION_PRESETS.travel_agent);
  assert.equal(hasFinePermission(travelAgent, 'agent.view'), true);
  assert.equal(hasFinePermission(travelAgent, 'hotel.view'), false);
  assert.equal(hasFinePermission(travelAgent, 'home.view'), false);

  // 4. Super Admin has unrestricted access
  assert.equal(hasFinePermission({ role: 'super_admin' as const }, 'hotel.delete'), true);
  assert.equal(hasFinePermission({ role: 'super_admin' as const }, 'admin.manage'), true);

  // 5. Custom permission override: Super Admin can customize Hotel Owner permissions
  const customizedOwner = {
    role: 'hotel_owner' as const,
    permissions: ROLE_PERMISSION_PRESETS.hotel_owner.filter(p => p !== 'room.update')
  };
  assert.equal(hasFinePermission(customizedOwner, 'hotel.view'), true);
  assert.equal(hasFinePermission(customizedOwner, 'room.view'), true);
  assert.equal(hasFinePermission(customizedOwner, 'room.update'), false); // Removed permission is revoked

  // Explicitly granted additional permission works
  const extendedOwner = {
    role: 'hotel_owner' as const,
    permissions: [...ROLE_PERMISSION_PRESETS.hotel_owner, 'tour.view']
  };
  assert.equal(hasFinePermission(extendedOwner, 'tour.view'), true);
});

test('admin granular permissions enforce exact access and dynamic updates', () => {
  // 1. Admin created with Manage Tours, Manage Hotels, Manage Bookings
  const adminUser = {
    role: 'admin' as const,
    permissions: ['tour.view', 'tour.create', 'hotel.view', 'hotel.create', 'booking.view', 'booking.update']
  };
  assert.equal(hasFinePermission(adminUser, 'tour.view'), true);
  assert.equal(hasFinePermission(adminUser, 'hotel.view'), true);
  assert.equal(hasFinePermission(adminUser, 'booking.view'), true);
  assert.equal(hasFinePermission(adminUser, 'customer.view'), false);
  assert.equal(hasFinePermission(adminUser, 'settings.edit'), false);
  assert.equal(hasFinePermission(adminUser, 'admin.manage'), false);

  // 2. Permission revocation immediately removes access
  const revokedAdmin = {
    ...adminUser,
    permissions: adminUser.permissions.filter(p => p !== 'hotel.view' && p !== 'hotel.create')
  };
  assert.equal(hasFinePermission(revokedAdmin, 'hotel.view'), false);
  assert.equal(hasFinePermission(revokedAdmin, 'tour.view'), true);
  assert.equal(hasFinePermission(revokedAdmin, 'booking.view'), true);

  // 3. Permission re-grant immediately restores access
  const regrantedAdmin = {
    ...revokedAdmin,
    permissions: [...revokedAdmin.permissions, 'hotel.view']
  };
  assert.equal(hasFinePermission(regrantedAdmin, 'hotel.view'), true);

  // 4. Hotel owner with hotel permissions
  const hotelOwnerUser = {
    role: 'hotel_owner' as const,
    permissions: ['hotel.view', 'hotel.update', 'room.view', 'room.create', 'room.update', 'booking.view']
  };
  assert.equal(hasFinePermission(hotelOwnerUser, 'hotel.view'), true);
  assert.equal(hasFinePermission(hotelOwnerUser, 'room.view'), true);
  assert.equal(hasFinePermission(hotelOwnerUser, 'booking.view'), true);
  assert.equal(hasFinePermission(hotelOwnerUser, 'tour.view'), false);
  assert.equal(hasFinePermission(hotelOwnerUser, 'customer.view'), false);
  assert.equal(hasFinePermission(hotelOwnerUser, 'admin.manage'), false);
});

test('role presets helper returns correct default permissions for each role', () => {
  assert.deepEqual(getRolePreset('hotel_owner'), ROLE_PERMISSION_PRESETS.hotel_owner);
  assert.deepEqual(getRolePreset('home_owner'), ROLE_PERMISSION_PRESETS.home_owner);
  assert.deepEqual(getRolePreset('travel_agent'), ROLE_PERMISSION_PRESETS.travel_agent);
  assert.equal(getRolePreset('hotel_owner').includes('hotel.view'), true);
  assert.equal(getRolePreset('hotel_owner').includes('room.update'), true);
  assert.equal(getRolePreset('hotel_owner').includes('booking.view'), true);
  assert.equal(getRolePreset('hotel_owner').includes('home.view'), false);
  assert.equal(getRolePreset('hotel_owner').includes('tour.view'), false);
  assert.equal(getRolePreset('hotel_owner').includes('admin.manage'), false);
});

test('auditAndMigrateVendorPermissions migrates hotel owners with incorrect permissions', async () => {
  const users: any[] = [
    {
      id: 'ho-1',
      role: 'hotel_owner',
      permissions: ['home.view', 'tour.view', 'hotel.view', 'settings.view']
    },
    {
      id: 'ho-2',
      role: 'hotel_owner',
      permissions: []
    },
    {
      id: 'ta-1',
      role: 'travel_agent',
      permissions: []
    }
  ];
  const updatedAdmins: Record<string, any> = {};
  const mockStore: any = {
    listAdmins: async () => users,
    updateAdmin: async (id: string, patch: any) => {
      updatedAdmins[id] = patch;
      const user = users.find(u => u.id === id);
      if (user) Object.assign(user, patch);
      return user;
    }
  };

  const result = await auditAndMigrateVendorPermissions(mockStore);
  assert.equal(result.audited, 3);
  assert.equal(result.updated, 3);

  // ho-1 should have unrelated permissions stripped (home, tour, settings) and hotel preset applied
  assert.equal(updatedAdmins['ho-1'].permissions.includes('home.view'), false);
  assert.equal(updatedAdmins['ho-1'].permissions.includes('tour.view'), false);
  assert.equal(updatedAdmins['ho-1'].permissions.includes('settings.view'), false);
  assert.equal(updatedAdmins['ho-1'].permissions.includes('hotel.view'), true);
  assert.equal(updatedAdmins['ho-1'].permissions.includes('room.view'), true);
  assert.equal(updatedAdmins['ho-1'].permissions.includes('booking.view'), true);

  // ho-2 should have full hotel preset applied
  assert.deepEqual(updatedAdmins['ho-2'].permissions, ROLE_PERMISSION_PRESETS.hotel_owner);

  // ta-1 should have full travel agent preset applied
  assert.deepEqual(updatedAdmins['ta-1'].permissions, ROLE_PERMISSION_PRESETS.travel_agent);
});

test('sanitizePermissions strips super-only permissions for non-super targets and preserves valid fine keys', () => {
  const rawPerms = ['hotel.view', 'hotel.create', 'admin.manage', 'system.settings', 'tour.view', 'invalid.key'];
  const sanitizedForAdmin = sanitizePermissions(rawPerms, false);
  assert.equal(sanitizedForAdmin.includes('hotel.view'), true);
  assert.equal(sanitizedForAdmin.includes('hotel.create'), true);
  assert.equal(sanitizedForAdmin.includes('tour.view'), true);
  assert.equal(sanitizedForAdmin.includes('admin.manage'), false); // Stripped for non-super targets
  assert.equal(sanitizedForAdmin.includes('system.settings'), false); // Stripped for non-super targets
  assert.equal(sanitizedForAdmin.includes('invalid.key'), false); // Stripped invalid key

  const sanitizedForSuper = sanitizePermissions(rawPerms, true);
  assert.equal(sanitizedForSuper.includes('admin.manage'), true);
  assert.equal(sanitizedForSuper.includes('system.settings'), true);
});

test('role switching preserves clean role presets without accidental permission bleed', () => {
  // Switch from Admin to Hotel Owner
  const previousAdminRole = 'admin';
  const nextHotelOwnerRole = 'hotel_owner';
  const hotelOwnerPreset = getRolePreset(nextHotelOwnerRole);
  assert.equal(hotelOwnerPreset.includes('hotel.view'), true);
  assert.equal(hotelOwnerPreset.includes('room.view'), true);
  assert.equal(hotelOwnerPreset.includes('tour.view'), false);
  assert.equal(hotelOwnerPreset.includes('agent.view'), false);

  // Switch from Hotel Owner to Travel Agent
  const nextTravelAgentRole = 'travel_agent';
  const travelAgentPreset = getRolePreset(nextTravelAgentRole);
  assert.equal(travelAgentPreset.includes('agent.view'), true);
  assert.equal(travelAgentPreset.includes('hotel.view'), false);
  assert.equal(travelAgentPreset.includes('room.view'), false);
});

test('chat identity credentials and conversation dedup keys are stable and timing-safe', () => {
  const secret = 'guest-secret-value-with-length';
  const hash = hashGuestSecret(secret);
  assert.notEqual(hash, secret);
  assert.equal(verifyGuestSecret(secret, hash), true);
  assert.equal(verifyGuestSecret(`${secret}-wrong`, hash), false);
  assert.equal(verifyGuestSecret('', hash), false);
  const uid = 'g-abc123';
  const header = `${uid}.${secret}`;
  const parsed = parseIdentityCredentials(header);
  assert.deepEqual(parsed, { uid, secret });
  assert.equal(parseIdentityCredentials('invalid'), undefined);
  assert.equal(conversationDedupKey('hotel', 'hotel-uuid', 'u-user'), 'hotel:hotel-uuid:u-user');
  assert.equal(encodeDedupKey(conversationDedupKey('hotel', 'hotel-uuid', 'u-user')), encodeDedupKey('hotel:hotel-uuid:u-user'));
});

test('tour pricing is always computed on the server from the persisted adult price', () => {
  const quote = computeTourQuote({ adultPrice: 200 }, { adults: 3 });
  assert.equal(quote.baseFare, 600);
  // No tax or fee is applied unless an operator configured one. An implicit
  // 15% VAT + 5% AIT on every tour was one half of the 6,000 → 14,400 bug.
  assert.equal(quote.vat, 0);
  assert.equal(quote.ait, 0);
  assert.equal(quote.tax, 0);
  assert.equal(quote.serviceFee, 0);
  assert.equal(quote.total, 600);

  // Children default to 70% of adult fare; infants are free unless configured.
  const family = computeTourQuote({ adultPrice: 200 }, { adults: 2, children: 2, infants: 1 });
  assert.equal(family.baseFare, 400 + 280 + 0);
  assert.equal(family.total, family.baseFare + family.vat + family.ait);

  // A configured child price is used, not the default 70%.
  const explicit = computeTourQuote({ adultPrice: 200, childPrice: 120, infantPrice: 0 }, { adults: 1, children: 2 });
  assert.equal(explicit.baseFare, 200 + 240);

  // Taxes ARE applied when an operator opts in, and appear in the breakdown.
  const taxed = computeTourQuote({ adultPrice: 200, vatPct: BD_VAT_PCT, aitPct: BD_AIT_PCT }, { adults: 3 });
  assert.equal(taxed.vat, 90);
  assert.equal(taxed.ait, 30);
  assert.equal(taxed.tax, 120);
  assert.equal(taxed.total, 720);
  assert.equal(taxed.vatPct, 15);
});

/**
 * Regression test for the reported production defect: a BDT 6,000 tour package
 * was charged BDT 14,400 at checkout.
 *
 * The cause was two compounding defaults:
 *   1. the checkout form defaulted travellers to 2 instead of 1 (×2), and
 *   2. `computeTourQuote` hard-defaulted to VAT 15% + AIT 5% on every tour.
 *   6,000 × 2 = 12,000, then +1,800 +600 = 14,400.
 *
 * Both are fixed: the traveller count defaults to exactly 1 and surcharges are
 * opt-in. This test pins the exact reported figures.
 */
test('a BDT 6,000 tour for one traveller is charged BDT 6,000 — never BDT 14,400', () => {
  const single = computeTourQuote({ adultPrice: 6000 }, { adults: 1 });
  assert.equal(single.subtotal, 6000);
  assert.equal(single.discount, 0);
  assert.equal(single.tax, 0);
  assert.equal(single.serviceFee, 0);
  assert.equal(single.total, 6000, 'a 6,000 tour for one traveller must total 6,000');

  // The old result must never come back.
  assert.notEqual(single.total, 14400);

  // Omitted / invalid counts all resolve to exactly one adult — there is no
  // hidden quantity default anywhere in the chain.
  for (const pax of [{}, { adults: undefined }, { adults: 0 }, { adults: NaN }, { adults: -5 }]) {
    const result = computeTourQuote({ adultPrice: 6000 }, pax as { adults?: number });
    assert.equal(result.adults, 1, `pax ${JSON.stringify(pax)} must resolve to 1 adult`);
    assert.equal(result.total, 6000);
  }

  // Two travellers is an explicit, visible doubling — not a silent one.
  const two = computeTourQuote({ adultPrice: 6000 }, { adults: 2 });
  assert.equal(two.adults, 2);
  assert.equal(two.total, 12000);

  // With an operator-configured tax the charge is 6,000 + the disclosed tax,
  // and every component is a named, visible line.
  const taxed = computeTourQuote({ adultPrice: 6000, vatPct: 15, aitPct: 5 }, { adults: 1 });
  assert.equal(taxed.subtotal, 6000);
  assert.equal(taxed.vat, 900);
  assert.equal(taxed.ait, 300);
  assert.equal(taxed.total, 7200);
  assert.notEqual(taxed.total, 14400);
});

test('every price component is applied exactly once and the breakdown sums to the total', () => {
  const cfg = { adultPrice: 6000, childPrice: 4000, infantPrice: 500, seasonSurchargePct: 10, serviceFeePct: 3, vatPct: 15, aitPct: 5, promoCode: 'SAVE10', promoPct: 10 };
  const quote = computeTourQuote(cfg, { adults: 2, children: 1, infants: 1 }, 'save10');

  // Each component counted once — no double multiplication, no doubled fee.
  assert.equal(quote.baseFare, 12000 + 4000 + 500);
  assert.equal(quote.seasonSurcharge, Math.round(16500 * 0.10));
  const taxable = quote.baseFare + quote.seasonSurcharge;
  assert.equal(quote.vat, Math.round(taxable * 0.15));
  assert.equal(quote.ait, Math.round(taxable * 0.05));
  assert.equal(quote.serviceFee, Math.round(taxable * 0.03));
  assert.equal(quote.discount, Math.round(16500 * 0.10));
  assert.equal(quote.promoApplied, true);

  // The lines rendered at checkout add up to exactly what is charged.
  const lineSum = quote.lines.reduce((sum, line) => sum + line.amount, 0);
  assert.equal(lineSum, quote.total);
  assert.equal(quote.total, quote.baseFare + quote.seasonSurcharge + quote.tax + quote.serviceFee - quote.discount);

  // A non-matching promo code changes nothing.
  const noPromo = computeTourQuote(cfg, { adults: 2, children: 1, infants: 1 }, 'WRONG');
  assert.equal(noPromo.discount, 0);
  assert.equal(noPromo.promoApplied, false);
  assert.equal(noPromo.total, quote.total + quote.discount);

  // A discount can never exceed the subtotal or drive the total negative.
  const absurd = computeTourQuote({ adultPrice: 1000, promoCode: 'ALL', promoPct: 100 }, { adults: 1 }, 'ALL');
  assert.equal(absurd.discount, 1000);
  assert.equal(absurd.total, 0);
});

test('tour pricing maps database records and operator settings without implicit charges', () => {
  // No metadata, no settings: the listed price is the charged price.
  const bare = tourPricingFromRecord({ priceBdt: 6000, metadata: {} }, {});
  assert.equal(bare.vatPct, undefined);
  assert.equal(computeTourQuote(bare, { adults: 1 }).total, 6000);

  // Deployment defaults apply when the tour says nothing.
  const fromSettings = tourPricingFromRecord({ priceBdt: 6000, metadata: {} }, { vatPct: 15, aitPct: 5 });
  assert.equal(computeTourQuote(fromSettings, { adults: 1 }).total, 7200);

  // A tour-level value always overrides the deployment default.
  const overridden = tourPricingFromRecord({ priceBdt: 6000, metadata: { vatPct: 0, aitPct: 0 } }, { vatPct: 15, aitPct: 5 });
  assert.equal(computeTourQuote(overridden, { adults: 1 }).total, 6000);

  // Empty strings and nulls in metadata are not treated as configured values.
  const dirty = tourPricingFromRecord({ priceBdt: 6000, metadata: { vatPct: '', aitPct: null, childPrice: undefined } }, { vatPct: 10 });
  assert.equal(computeTourQuote(dirty, { adults: 1 }).total, 6600);
});

/**
 * Run this only against a disposable MongoDB database:
 * TEST_MONGODB_URI='mongodb+srv://…/sadik_travels_test' npm test
 *
 * CI/local environments without a database skip this integration suite rather than
 * substituting an in-memory persistence layer for the production MongoDB repository.
 */
const testMongoUri = process.env.TEST_MONGODB_URI;

if (!testMongoUri) {
  test('MongoDB end-to-end suite', { skip: 'Set TEST_MONGODB_URI to a disposable MongoDB database to run this suite.' }, () => undefined);
} else {
  process.env.NODE_ENV = 'development';
  process.env.MONGODB_URI = testMongoUri;
  process.env.SERVE_STATIC = 'true';
  process.env.LOG_LEVEL = 'silent';
  process.env.JWT_SECRET = 'test-only-jwt-secret-that-is-long-enough-to-sign-tokens';
  process.env.SETTINGS_MASTER_KEY = 'test-only-settings-secret-that-is-long-enough-to-encrypt';
  process.env.SUPER_ADMIN_EMAIL = 'admin@example.com';
  process.env.SUPER_ADMIN_PASSWORD = 'StrongAdminPassword123!';
  process.env.DEV_OTP_ECHO = 'true';

  const [{ buildApp }, { bootstrapSuperAdmin }] = await Promise.all([
    import('./app.js'),
    import('./admin-bootstrap.js')
  ]);

  const cookies = (response: Response) => response.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
  const responseJson = async (response: Response) => ({ response, body: await response.json() });

  async function runServer() {
    const built = buildApp();
    await built.connection;
    await bootstrapSuperAdmin(built.store);
    const server = createServer(built.app);
    built.liveChat.attach(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    assert(address && typeof address !== 'string');
    return { ...built, server, base: `http://127.0.0.1:${address.port}` };
  }

  const socketAck = <T>(socket: Socket, event: string, payload: unknown) => new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Socket acknowledgement timed out: ${event}`)), 5000);
    socket.emit(event, payload, (result: T) => { clearTimeout(timeout); resolve(result); });
  });
  type ChatAckPayload = { ok: boolean; supportStaff?: boolean; [key: string]: unknown };

  const connected = (socket: Socket) => new Promise<void>((resolve, reject) => {
    if (socket.connected) return resolve();
    const timeout = setTimeout(() => reject(new Error('Socket connection timed out')), 5000);
    socket.once('connect', () => { clearTimeout(timeout); resolve(); });
    socket.once('connect_error', (error: Error) => { clearTimeout(timeout); reject(error); });
  });

  test('admin authentication, MongoDB catalogue, travel agents, live chat, and notifications work end to end', async () => {
    const { store, server, base } = await runServer();
    let visitorSocket: Socket | undefined;
    let adminSocket: Socket | undefined;
    try {
      assert.equal((await fetch(`${base}/healthz`)).status, 200);
      const login = await fetch(`${base}/api/v1/auth/password-login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identity: 'admin@example.com', password: 'StrongAdminPassword123!' }) });
      const { body: adminLogin } = await responseJson(login);
      assert.equal(login.status, 200);
      assert.equal(adminLogin.user.role, 'super_admin');
      const adminCookie = cookies(login);

      // Live chat: guest identity bootstrap + support conversation over the Socket.IO fallback.
      const chatStart = await fetch(`${base}/api/v1/chat/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Live Chat Visitor', contact: '01700000000' }) });
      const { body: chat } = await responseJson(chatStart);
      assert.equal(chatStart.status, 200);
      assert.equal(chat.identity.kind, 'guest');
      const chatIdentity = `${chat.credentials.uid}.${chat.credentials.secret}`;
      const conversationStart = await fetch(`${base}/api/v1/chat/conversations`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-chat-identity': chatIdentity }, body: JSON.stringify({ type: 'support' }) });
      const { body: conversationPayload } = await responseJson(conversationStart);
      assert.equal(conversationStart.status, 201);
      const conversationId = conversationPayload.conversation.id;
      visitorSocket = createSocket(base, { transports: ['websocket'], auth: { identity: chatIdentity } });
      adminSocket = createSocket(base, { transports: ['websocket'], extraHeaders: { cookie: adminCookie }, auth: { identity: chatIdentity } });
      await Promise.all([connected(visitorSocket), connected(adminSocket)]);
      const visitorHello = await socketAck<ChatAckPayload>(visitorSocket, 'chat:hello', {});
      assert.equal(visitorHello.ok, true);
      const visitorJoin = await socketAck<ChatAckPayload>(visitorSocket, 'chat:join', { conversationId });
      assert.equal(visitorJoin.ok, true);
      const adminHello = await socketAck<ChatAckPayload>(adminSocket, 'chat:hello', {});
      assert.equal(adminHello.ok, true);
      assert.equal(adminHello.supportStaff, true, 'the super admin must receive the support inbox');
      const adminJoin = await socketAck<ChatAckPayload>(adminSocket, 'chat:join', { conversationId });
      assert.equal(adminJoin.ok, true);
      assert.equal((await socketAck<ChatAckPayload>(visitorSocket, 'chat:send', { conversationId, text: 'Is a room available this weekend?' })).ok, true);
      assert.equal((await socketAck<ChatAckPayload>(adminSocket, 'chat:send', { conversationId, text: 'Yes, we can help with current availability.' })).ok, true);
      const transcript = await (await fetch(`${base}/api/v1/chat/conversations/${conversationId}/messages`, { headers: { 'x-chat-identity': chatIdentity } })).json();
      assert.deepEqual(transcript.messages.map((message: any) => message.senderRole), ['customer', 'support']);

      // ---- Hotel marketplace: images, filters, pricing, availability, booking ----
      const hotelSlug = `smoke-hotel-${Date.now()}`;
      const createdHotel = await fetch(`${base}/api/v1/admin/hotels`, { method: 'POST', headers: { cookie: adminCookie, 'content-type': 'application/json' }, body: JSON.stringify({
        slug: hotelSlug, name: 'Test Hotel Kolatoli', propertyType: 'Hotel', city: "Cox's Bazar", area: 'Kolatoli Road', starRating: 4,
        amenities: ['Free Wi-Fi', 'Complimentary Breakfast'], shortDescription: 'Smoke-test property.',
        // Mixed legacy image shapes: plain string row, insecure http URL, canonical object — the API normalizes all of them.
        images: ['https://res.cloudinary.com/demo/image/upload/sample.jpg', { url: 'http://res.cloudinary.com/demo/image/upload/second.jpg' }, { url: 'https://res.cloudinary.com/demo/image/upload/third.jpg', publicId: 'demo/third', alt: 'Third' }],
        pricePerNight: 3500, checkInTime: '14:00', checkOutTime: '12:00', status: 'active'
      }) });
      const { body: hotelPayload } = await responseJson(createdHotel);
      assert.equal(createdHotel.status, 201);
      assert.equal(hotelPayload.hotel.images.length, 3, 'image normalization must keep exactly the valid entries');
      assert.equal(hotelPayload.hotel.images[0].url.startsWith('https://'), true, 'stored image URLs must be https');
      assert.equal(hotelPayload.hotel.images[1].url.startsWith('https://'), true, 'http image URLs must be upgraded to https');

      const roomCreated = await fetch(`${base}/api/v1/admin/hotels/${hotelPayload.hotel.id}/rooms`, { method: 'POST', headers: { cookie: adminCookie, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Deluxe Double', slug: `deluxe-${Date.now()}`, pricePerNight: 3500, originalPrice: 4200, maxAdults: 2, maxChildren: 1, maxGuests: 3, inventory: 5, taxesPct: 10, serviceFee: 200, status: 'active' }) });
      const { body: roomPayload } = await responseJson(roomCreated);
      assert.equal(roomCreated.status, 201);

      const searchResults = await (await fetch(`${base}/api/v1/hotels?q=Kolatoli`)).json();
      assert.equal(searchResults.hotels.some((hotel: any) => hotel.id === hotelPayload.hotel.id), true, 'search must find the persisted hotel');
      assert.equal(typeof searchResults.hotels.find((hotel: any) => hotel.id === hotelPayload.hotel.id)?.priceFrom, 'number', 'listing must carry the real lowest room price');
      assert.equal(searchResults.amenities.includes('Free Wi-Fi'), true, 'amenity facets must be derived from live data');
      assert.equal(searchResults.areas.includes('Kolatoli Road'), true, 'area facets must be derived from live data');

      const multiType = await (await fetch(`${base}/api/v1/hotels?propertyTypes=${encodeURIComponent('Hotel,Resort')}`)).json();
      assert.equal(multiType.hotels.some((hotel: any) => hotel.id === hotelPayload.hotel.id), true, 'multi property-type filter must match (was broken: comma value matched nothing)');
      const singleType = await (await fetch(`${base}/api/v1/hotels?propertyTypes=Resort`)).json();
      assert.equal(singleType.hotels.some((hotel: any) => hotel.id === hotelPayload.hotel.id), false, 'property-type filter must exclude non-matching types');
      const exactStars = await (await fetch(`${base}/api/v1/hotels?starRatings=4`)).json();
      assert.equal(exactStars.hotels.some((hotel: any) => hotel.id === hotelPayload.hotel.id), true, 'exact 4-star filter must include the hotel');
      assert.equal(exactStars.hotels.every((hotel: any) => Math.round(hotel.starRating) === 4), true, 'exact star filter must return only 4-star hotels');
      const areaOr = await (await fetch(`${base}/api/v1/hotels?areas=${encodeURIComponent('Kolatoli Road,Inani Beach')}`)).json();
      assert.equal(areaOr.hotels.some((hotel: any) => hotel.id === hotelPayload.hotel.id), true, 'multi-area OR filter must include the hotel');
      const amenityAnd = await (await fetch(`${base}/api/v1/hotels?amenities=${encodeURIComponent('Free Wi-Fi,Complimentary Breakfast')}`)).json();
      assert.equal(amenityAnd.hotels.some((hotel: any) => hotel.id === hotelPayload.hotel.id), true, 'amenity AND filter must include the hotel');
      const priceBand = await (await fetch(`${base}/api/v1/hotels?minPrice=3000&maxPrice=4000`)).json();
      assert.equal(priceBand.hotels.some((hotel: any) => hotel.id === hotelPayload.hotel.id), true, 'price band filter must include the hotel');

      const checkIn = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
      const checkOut = new Date(Date.now() + 9 * 86400000).toISOString().slice(0, 10);
      const quoteResponse = await fetch(`${base}/api/v1/hotels/price-quote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hotelId: hotelPayload.hotel.id, checkIn, checkOut, rooms: [{ roomId: roomPayload.room.id, quantity: 1, adults: 2, children: 0 }] }) });
      const { body: quote } = await responseJson(quoteResponse);
      assert.equal(quoteResponse.status, 200);
      assert.equal(quote.breakdown.nights, 2, 'nights must be the real date difference');
      const expectedRoomTotal = 3500 * 2;
      assert.equal(quote.breakdown.roomTotal, expectedRoomTotal, 'server must recalculate the room total from persisted prices');
      assert.equal(quote.breakdown.taxes, Math.round(expectedRoomTotal * 0.10), 'taxes must derive from the persisted tax rate');
      assert.equal(quote.breakdown.serviceFee, 400, 'service fee must follow the persisted room fee');

      const createdTour = await fetch(`${base}/api/v1/admin/tours`, { method: 'POST', headers: { cookie: adminCookie, 'content-type': 'application/json' }, body: JSON.stringify({ slug: `umrah-smoke-${Date.now()}`, title: 'Umrah Smoke Package', country: 'Saudi Arabia', tourType: 'Umrah', destinations: ['Makkah', 'Madinah'], durationDays: 10, durationNights: 9, description: 'Published package for the smoke test.', imageUrl: '', metadata: {}, priceBdt: 125000, status: 'published', featured: true }) });
      const { body: tourPayload } = await responseJson(createdTour);
      assert.equal(createdTour.status, 201);
      const publicTours = await fetch(`${base}/api/v1/tours`);
      assert.equal(publicTours.status, 200);
      assert.equal((await publicTours.json()).tours.some((tour: any) => tour.id === tourPayload.tour.id), true, 'a published admin tour must be visible in the public tour catalogue');

      const createdAgent = await fetch(`${base}/api/v1/admin/travel-agents`, { method: 'POST', headers: { cookie: adminCookie, 'content-type': 'application/json' }, body: JSON.stringify({ fullName: 'Sadik Travels Agent', jobTitle: 'Umrah Specialist', phone: '+8801700000000', email: `agent-${Date.now()}@example.com`, officeLocation: 'Dhaka', shortBio: 'Experienced travel consultant.', fullDescription: 'Full public agent profile.', languages: ['Bangla', 'English'], experienceYears: 8, status: 'active', featured: true, displayOrder: 0 }) });
      const { body: agentPayload } = await responseJson(createdAgent);
      assert.equal(createdAgent.status, 201);
      assert.equal((await fetch(`${base}/api/v1/site/agents/${agentPayload.agent.id}`)).status, 200);

      const otpRequest = await fetch(`${base}/api/v1/auth/request-otp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identity: '01700000000' }) });
      const { body: otp } = await responseJson(otpRequest);
      const verify = await fetch(`${base}/api/v1/auth/verify-otp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ challengeId: otp.challengeId, code: otp.devCode }) });
      const { body: customerLogin } = await responseJson(verify);
      assert.equal(verify.status, 200);
      const customerCookie = cookies(verify);

      const bookingRequest = await fetch(`${base}/api/v1/bookings`, { method: 'POST', headers: { cookie: customerCookie, 'content-type': 'application/json' }, body: JSON.stringify({ vertical: 'tour', payload: { tourId: tourPayload.tour.id, travellers: 2, travelDate: '2026-12-01' } }) });
      const { body: bookingPayload } = await responseJson(bookingRequest);
      assert.equal(bookingRequest.status, 201);
      assert.equal((await fetch(`${base}/api/v1/admin/bookings/${bookingPayload.booking.id}`, { method: 'PATCH', headers: { cookie: adminCookie, 'content-type': 'application/json' }, body: JSON.stringify({ status: 'accepted' }) })).status, 200);
      const paymentStart = await fetch(`${base}/api/v1/payments/intents`, { method: 'POST', headers: { cookie: customerCookie, 'content-type': 'application/json' }, body: JSON.stringify({ bookingId: bookingPayload.booking.id, amount: 1, currency: 'USD' }) });
      assert.equal(paymentStart.status, 503); // Provider is intentionally absent in test.
      assert.equal((await store.listAdminPayments({ q: bookingPayload.booking.id })).payments[0].amount, 250000);

      // Hotel booking end-to-end: server-derived amount (client price fields don't exist by design).
      const hotelBooking = await fetch(`${base}/api/v1/hotels/bookings`, { method: 'POST', headers: { cookie: customerCookie, 'content-type': 'application/json' }, body: JSON.stringify({ hotelId: hotelPayload.hotel.id, checkIn, checkOut, rooms: [{ roomId: roomPayload.room.id, quantity: 1, adults: 2, children: 0 }], primaryGuest: { firstName: 'Rahim', lastName: 'Uddin', email: 'rahim@example.com', phone: '+8801711223344' }, paymentMethod: 'pay_later' }) });
      const { body: hotelBookingPayload } = await responseJson(hotelBooking);
      assert.equal(hotelBooking.status, 201);
      assert.equal(hotelBookingPayload.booking.priceBreakdown.roomTotal, expectedRoomTotal, 'booking must store the server-calculated total');
      assert.equal(hotelBookingPayload.booking.nights, 2);
      // Availability must now reflect the reservation.
      const afterBooking = await (await fetch(`${base}/api/v1/hotels/${hotelSlug}?checkIn=${checkIn}&checkOut=${checkOut}`)).json();
      const bookedRoom = afterBooking.hotel.rooms.find((room: any) => room.id === roomPayload.room.id);
      assert.equal(bookedRoom.available, 4, 'one room of inventory must be consumed by the booking');
      // Owner-facing chat integration: hotel id + owner on the conversation (deep assertions in chat.test.js).
      assert.equal(hotelPayload.hotel.ownerId, adminLogin.user.id, 'super-admin-created hotels default to the creator as owner');

      assert.equal((await fetch(`${base}/api/v1/admin/notifications`, { method: 'POST', headers: { cookie: adminCookie, 'content-type': 'application/json' }, body: JSON.stringify({ userId: customerLogin.user.id, title: 'Booking Update', message: 'Your booking has been updated successfully.', channels: ['in_app'] }) })).status, 201);
            const notifications = await (await fetch(`${base}/api/v1/notifications`, { headers: { cookie: customerCookie } })).json();
            // Every booking lifecycle event creates its own unread row, so the
            // total is dynamic — the invariant is that the admin-posted
            // notification reached the customer as an unread bell entry.
            assert.ok(notifications.unread >= 1, 'the admin-posted notification must be unread');
            assert.ok(notifications.notifications.some((entry: any) => entry.title === 'Booking Update'), 'the admin-posted notification must be in the feed');
    } finally {
      visitorSocket?.disconnect();
      adminSocket?.disconnect();
      await new Promise<void>(resolve => server.close(() => resolve()));
      store.close();
    }
  });

  test('PWA surfaces: public install page, admin install page, admin manifest and admin service worker', async () => {
    const { store, server, base } = await runServer();
    try {
      // Public install landing page.
      const publicPwa = await fetch(`${base}/pwa`);
      assert.equal(publicPwa.status, 200);
      const publicPwaHtml = await publicPwa.text();
      assert.match(publicPwaHtml, /Install the Sadik Travels app/);
      assert.match(publicPwaHtml, /href="\/manifest\.webmanifest"/);
      assert.match(publicPwaHtml, /src="\/pwa-install-page\.js/);

      // Admin install landing page (must NOT be swallowed by the admin SPA catch-all).
      const adminPwa = await fetch(`${base}/admin/pwa`);
      assert.equal(adminPwa.status, 200);
      const adminPwaHtml = await adminPwa.text();
      assert.match(adminPwaHtml, /Install the Admin Console/);
      assert.match(adminPwaHtml, /href="\/admin\/manifest\.webmanifest"/);

      // Admin manifest: scoped to /admin/, standalone, with admin icons.
      const adminManifestResponse = await fetch(`${base}/admin/manifest.webmanifest`);
      assert.equal(adminManifestResponse.status, 200);
      assert.match(adminManifestResponse.headers.get('content-type') || '', /application\/manifest\+json/);
      assert.equal(adminManifestResponse.headers.get('cache-control'), 'no-cache, max-age=0');
      const adminManifest = JSON.parse(await adminManifestResponse.text());
      assert.equal(adminManifest.scope, '/admin/');
      assert.match(adminManifest.start_url, /^\/admin\//);
      assert.ok(adminManifest.icons.some((iconItem: any) => String(iconItem.src).includes('admin-icon-512')));

      // Admin service worker: served un-cached at /admin/sw.js.
      const adminSw = await fetch(`${base}/admin/sw.js`);
      assert.equal(adminSw.status, 200);
      assert.equal(adminSw.headers.get('cache-control'), 'no-cache, max-age=0');
      assert.match(await adminSw.text(), /sta-v/);

      // Public manifest and worker keep working.
      const publicManifest = await (await fetch(`${base}/manifest.webmanifest`)).json();
      assert.equal(publicManifest.scope, '/');
      assert.equal((await fetch(`${base}/sw.js`)).status, 200);

      // The admin SPA catch-all still serves the console shell for other /admin routes.
      const adminShell = await fetch(`${base}/admin`);
      assert.equal(adminShell.status, 200);
      assert.match(await adminShell.text(), /Sadik Travels Admin Console/);

      // admin.html wires the admin PWA bootstrap and manifest.
      const adminHtml = await (await fetch(`${base}/admin/`)).text();
      assert.match(adminHtml, /src="\/admin-pwa\.js/);
      assert.match(adminHtml, /data-pwa-install/);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      store.close();
    }
  });
}
