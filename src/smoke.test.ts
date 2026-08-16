import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

// Isolated SQLite file and real HTTP requests exercise the same public/admin boundary used in deployment.
const sqlitePath = `/tmp/sadik-travels-smoke-${process.pid}.sqlite`;
process.env.NODE_ENV = 'development';
process.env.SQLITE_PATH = sqlitePath;
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

function cookies(response: Response) {
  return response.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
}

async function runServer() {
  const built = buildApp();
  await bootstrapSuperAdmin(built.store);
  const server = await new Promise<ReturnType<typeof built.app.listen>>(resolve => {
    const instance = built.app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  return { ...built, server, base: `http://127.0.0.1:${address.port}` };
}

async function responseJson(response: Response) {
  return { response, body: await response.json() };
}

test('admin authentication, public catalogue, travel agents, and in-app notifications work end to end', async () => {
  const { app: _app, store, server, base } = await runServer();
  try {
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);

    const login = await fetch(`${base}/api/v1/auth/password-login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identity: 'admin@example.com', password: 'StrongAdminPassword123!' })
    });
    const { body: adminLogin } = await responseJson(login);
    assert.equal(login.status, 200);
    assert.equal(adminLogin.user.role, 'super_admin');
    const adminCookie = cookies(login);

    const createdTour = await fetch(`${base}/api/v1/admin/tours`, {
      method: 'POST', headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'umrah-smoke-package', title: 'Umrah Smoke Package', country: 'Saudi Arabia', tourType: 'Umrah', destinations: ['Makkah', 'Madinah'], durationDays: 10, durationNights: 9, description: 'Published package for the smoke test.', imageUrl: '', metadata: {}, priceBdt: 125000, status: 'published', featured: true })
    });
    const { body: tourPayload } = await responseJson(createdTour);
    assert.equal(createdTour.status, 201);

    const publicTours = await fetch(`${base}/api/v1/tours`);
    const publicToursBody = await publicTours.json();
    assert.equal(publicTours.status, 200);
    assert.equal(publicToursBody.tours[0].id, tourPayload.tour.id);

    const createdAgent = await fetch(`${base}/api/v1/admin/travel-agents`, {
      method: 'POST', headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ fullName: 'Sadik Travels Agent', jobTitle: 'Umrah Specialist', phone: '+8801700000000', email: 'agent@example.com', officeLocation: 'Dhaka', shortBio: 'Experienced travel consultant.', fullDescription: 'Full public agent profile.', languages: ['Bangla', 'English'], experienceYears: 8, status: 'active', featured: true, displayOrder: 0 })
    });
    const { body: agentPayload } = await responseJson(createdAgent);
    assert.equal(createdAgent.status, 201);
    const publicAgent = await fetch(`${base}/api/v1/site/agents/${agentPayload.agent.id}`);
    assert.equal(publicAgent.status, 200);
    assert.equal((await publicAgent.json()).agent.fullName, 'Sadik Travels Agent');

    const otpRequest = await fetch(`${base}/api/v1/auth/request-otp`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identity: '01700000000' })
    });
    const { body: otp } = await responseJson(otpRequest);
    assert.equal(otpRequest.status, 202);
    const verify = await fetch(`${base}/api/v1/auth/verify-otp`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ challengeId: otp.challengeId, code: otp.devCode })
    });
    const { body: customerLogin } = await responseJson(verify);
    assert.equal(verify.status, 200);

    const customerCookie = cookies(verify);
    const bookingRequest = await fetch(`${base}/api/v1/bookings`, {
      method: 'POST', headers: { cookie: customerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ vertical: 'tour', payload: { tourId: tourPayload.tour.id, travellers: 2, travelDate: '2026-12-01' } })
    });
    const { body: bookingPayload } = await responseJson(bookingRequest);
    assert.equal(bookingRequest.status, 201);
    const acceptBooking = await fetch(`${base}/api/v1/admin/bookings/${bookingPayload.booking.id}`, {
      method: 'PATCH', headers: { cookie: adminCookie, 'content-type': 'application/json' }, body: JSON.stringify({ status: 'accepted' })
    });
    assert.equal(acceptBooking.status, 200);
    const paymentStart = await fetch(`${base}/api/v1/payments/intents`, {
      method: 'POST', headers: { cookie: customerCookie, 'content-type': 'application/json' },
      // This amount must be ignored: only the persisted tour price × travellers is trusted.
      body: JSON.stringify({ bookingId: bookingPayload.booking.id, amount: 1, currency: 'USD' })
    });
    const paymentError = await paymentStart.json();
    assert.equal(paymentStart.status, 503);
    assert.equal(paymentError.error.code, 'SSLCOMMERZ_NOT_CONFIGURED');
    const paymentRecords = await store.listAdminPayments({ q: bookingPayload.booking.id });
    assert.equal(paymentRecords.payments[0].amount, 250000);
    assert.equal(paymentRecords.payments[0].currency, 'BDT');

    const notification = await fetch(`${base}/api/v1/admin/notifications`, {
      method: 'POST', headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ userId: customerLogin.user.id, title: 'Booking Update', message: 'Your booking has been updated successfully.', channels: ['in_app'] })
    });
    assert.equal(notification.status, 201);
    const customerNotifications = await fetch(`${base}/api/v1/notifications`, { headers: { cookie: customerCookie } });
    const notificationsPayload = await customerNotifications.json();
    assert.equal(customerNotifications.status, 200);
    assert.equal(notificationsPayload.unread, 1);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    await fs.rm(sqlitePath, { force: true });
  }
});
