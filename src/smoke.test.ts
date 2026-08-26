import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { io as createSocket, type Socket } from 'socket.io-client';
import { effectiveFinePermissions, hasFinePermission, ROLE_PERMISSION_PRESETS, getRolePreset, auditAndMigrateVendorPermissions, sanitizePermissions } from './permissions.js';
import { hashChatToken, verifyChatToken } from './live-chat.js';
import { ACTIVE_CATALOG_TYPES, RETIRED_VERTICAL_TYPES, isRetiredAdminNavItem } from './legacy-purge.js';
import { computeTourQuote } from './booking-schema.js';

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

test('live-chat room tokens are hashed and timing-safe verified', () => {
  const token = 'visitor-session-token-with-more-than-32-characters';
  const hash = hashChatToken(token);
  assert.notEqual(hash, token);
  assert.equal(verifyChatToken(token, hash), true);
  assert.equal(verifyChatToken(`${token}-wrong`, hash), false);
  assert.equal(verifyChatToken('', hash), false);
});

test('tour pricing is always computed on the server from the persisted adult price', () => {
  const quote = computeTourQuote({ adultPrice: 200 }, { adults: 3 });
  assert.equal(quote.baseFare, 600);
  assert.equal(quote.vat, 90);
  assert.equal(quote.ait, 30);
  assert.equal(quote.total, 720);

  // Children default to 70% of adult fare; infants are free unless configured.
  const family = computeTourQuote({ adultPrice: 200 }, { adults: 2, children: 2, infants: 1 });
  assert.equal(family.baseFare, 400 + 280 + 0);
  assert.equal(family.total, family.baseFare + family.vat + family.ait);

  // A configured child price is used, not the default 70%.
  const explicit = computeTourQuote({ adultPrice: 200, childPrice: 120, infantPrice: 0 }, { adults: 1, children: 2 });
  assert.equal(explicit.baseFare, 200 + 240);
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
  const connected = (socket: Socket) => new Promise<void>((resolve, reject) => {
    if (socket.connected) return resolve();
    const timeout = setTimeout(() => reject(new Error('Socket connection timed out')), 5000);
    socket.once('connect', () => { clearTimeout(timeout); resolve(); });
    socket.once('connect_error', error => { clearTimeout(timeout); reject(error); });
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

      const chatStart = await fetch(`${base}/api/v1/live-chat/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Live Chat Visitor', mobile: '01700000000', email: 'visitor@example.com', subject: 'Hotel availability' }) });
      const { body: chat } = await responseJson(chatStart);
      assert.equal(chatStart.status, 201);
      visitorSocket = createSocket(base, { transports: ['websocket'] });
      adminSocket = createSocket(base, { transports: ['websocket'], extraHeaders: { cookie: adminCookie } });
      await Promise.all([connected(visitorSocket), connected(adminSocket)]);
      const visitorJoin = await socketAck<any>(visitorSocket, 'join_chat_room', { sessionId: chat.session.id, token: chat.token });
      assert.equal(visitorJoin.ok, true);
      const adminInbox = await socketAck<any>(adminSocket, 'admin_join_inbox', {});
      assert.equal(adminInbox.ok, true);
      const adminJoin = await socketAck<any>(adminSocket, 'join_chat_room', { sessionId: chat.session.id });
      assert.equal(adminJoin.ok, true);
      assert.equal((await socketAck<any>(visitorSocket, 'send_chat_message', { message: 'Is a room available this weekend?' })).ok, true);
      assert.equal((await socketAck<any>(adminSocket, 'admin_reply', { sessionId: chat.session.id, message: 'Yes, we can help with current availability.' })).ok, true);
      const transcript = await (await fetch(`${base}/api/v1/live-chat/sessions/${chat.session.id}/messages`, { headers: { 'x-chat-token': chat.token } })).json();
      assert.deepEqual(transcript.messages.map((message: any) => message.authorType), ['customer', 'admin']);

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

      assert.equal((await fetch(`${base}/api/v1/admin/notifications`, { method: 'POST', headers: { cookie: adminCookie, 'content-type': 'application/json' }, body: JSON.stringify({ userId: customerLogin.user.id, title: 'Booking Update', message: 'Your booking has been updated successfully.', channels: ['in_app'] }) })).status, 201);
      const notifications = await (await fetch(`${base}/api/v1/notifications`, { headers: { cookie: customerCookie } })).json();
      assert.equal(notifications.unread, 1);
    } finally {
      visitorSocket?.disconnect();
      adminSocket?.disconnect();
      await new Promise<void>(resolve => server.close(() => resolve()));
      store.close();
    }
  });
}
