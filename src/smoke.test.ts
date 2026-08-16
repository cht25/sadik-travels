import test from 'node:test';
import assert from 'node:assert/strict';

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
    const server = await new Promise<ReturnType<typeof built.app.listen>>(resolve => {
      const instance = built.app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    const address = server.address();
    assert(address && typeof address !== 'string');
    return { ...built, server, base: `http://127.0.0.1:${address.port}` };
  }

  test('admin authentication, MongoDB catalogue, travel agents, and notifications work end to end', async () => {
    const { store, server, base } = await runServer();
    try {
      assert.equal((await fetch(`${base}/healthz`)).status, 200);
      const login = await fetch(`${base}/api/v1/auth/password-login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identity: 'admin@example.com', password: 'StrongAdminPassword123!' }) });
      const { body: adminLogin } = await responseJson(login);
      assert.equal(login.status, 200);
      assert.equal(adminLogin.user.role, 'super_admin');
      const adminCookie = cookies(login);

      const createdTour = await fetch(`${base}/api/v1/admin/tours`, { method: 'POST', headers: { cookie: adminCookie, 'content-type': 'application/json' }, body: JSON.stringify({ slug: `umrah-smoke-${Date.now()}`, title: 'Umrah Smoke Package', country: 'Saudi Arabia', tourType: 'Umrah', destinations: ['Makkah', 'Madinah'], durationDays: 10, durationNights: 9, description: 'Published package for the smoke test.', imageUrl: '', metadata: {}, priceBdt: 125000, status: 'published', featured: true }) });
      const { body: tourPayload } = await responseJson(createdTour);
      assert.equal(createdTour.status, 201);
      assert.equal((await fetch(`${base}/api/v1/tours`)).status, 200);

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
      await new Promise<void>(resolve => server.close(() => resolve()));
      store.close();
    }
  });
}
