import test from 'node:test';
import assert from 'node:assert/strict';

// The app reads configuration at import time. This is intentionally an isolated, non-persistent test profile.
process.env.NODE_ENV = 'development';
process.env.DATA_MODE = 'memory';
process.env.DEV_OTP_ECHO = 'true';
process.env.ADMIN_IDENTITIES = '01700000000';
process.env.SERVE_STATIC = 'false';
process.env.LOG_LEVEL = 'silent';
process.env.JWT_SECRET = 'test-only-secret-that-is-long-enough-for-jwt-signing';

const { buildApp } = await import('./app.js');

async function start() {
  const { app } = buildApp();
  const server = await new Promise<ReturnType<typeof app.listen>>(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  return { server, base: `http://127.0.0.1:${address.port}` };
}

function cookiePairs(response: Response) {
  return response.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
}

async function json(response: Response) {
  const body = await response.json();
  return { response, body };
}

test('OTP-admin CMS lifecycle, agent profile, and in-app campaign are connected end to end', async () => {
  const { server, base } = await start();
  try {
    const csrfResponse = await fetch(`${base}/api/v1/auth/csrf`);
    const { body: csrfBody } = await json(csrfResponse);
    const csrf = csrfBody.csrfToken as string;
    let cookies = cookiePairs(csrfResponse);

    const missingCsrf = await fetch(`${base}/api/v1/auth/request-otp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identity: '01700000000' }) });
    assert.equal(missingCsrf.status, 403);

    const request = await fetch(`${base}/api/v1/auth/request-otp`, { method: 'POST', headers: { cookie: cookies, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ identity: '01700000000' }) });
    const { body: challenge } = await json(request);
    assert.equal(request.status, 202);
    assert.match(challenge.devCode, /^\d{6}$/);

    const verify = await fetch(`${base}/api/v1/auth/verify-otp`, { method: 'POST', headers: { cookie: cookies, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ challengeId: challenge.challengeId, code: challenge.devCode }) });
    const { body: login } = await json(verify);
    assert.equal(verify.status, 200);
    assert.equal(login.user.role, 'admin');
    cookies = `${cookies}; ${cookiePairs(verify)}`;

    const create = await fetch(`${base}/api/v1/admin/content`, { method: 'POST', headers: { cookie: cookies, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'travel-agent', slug: 'verified-agent', title: 'Verified Agent', excerpt: 'A published agent profile.', description: 'Full agent description.', imageUrl: '', gallery: [], currency: 'BDT', location: 'Dhaka', tags: ['agent'], ctaLabel: '', ctaUrl: '', status: 'published', featured: true, sortOrder: 0, data: { company: 'Sadik Agency', phone: '+8801700000000', email: 'agent@example.com', address: 'Dhaka' } }) });
    const { body: created } = await json(create);
    assert.equal(create.status, 201);

    const publicAgent = await fetch(`${base}/api/v1/agents/verified-agent`);
    assert.equal(publicAgent.status, 200);
    assert.equal((await publicAgent.json()).agent.data.company, 'Sadik Agency');

    const archive = await fetch(`${base}/api/v1/admin/content/${created.item.id}/archive`, { method: 'POST', headers: { cookie: cookies, 'x-csrf-token': csrf } });
    assert.equal(archive.status, 200);
    assert.equal((await fetch(`${base}/api/v1/agents/verified-agent`)).status, 404);

    const restore = await fetch(`${base}/api/v1/admin/content/${created.item.id}/restore`, { method: 'POST', headers: { cookie: cookies, 'x-csrf-token': csrf } });
    assert.equal(restore.status, 200);
    const publish = await fetch(`${base}/api/v1/admin/content/${created.item.id}/publish`, { method: 'POST', headers: { cookie: cookies, 'x-csrf-token': csrf } });
    assert.equal(publish.status, 200);

    const template = await fetch(`${base}/api/v1/admin/message-templates`, { method: 'POST', headers: { cookie: cookies, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Booking Update', subject: 'Booking Update', body: 'Hello {{name}}, your booking changed.', status: 'active' }) });
    const templateBody = await template.json();
    assert.equal(template.status, 201);
    const campaign = await fetch(`${base}/api/v1/admin/messages/send`, { method: 'POST', headers: { cookie: cookies, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ templateId: templateBody.template.id, userIds: [login.user.id], allUsers: false, channels: ['in_app'] }) });
    assert.equal(campaign.status, 201);
    const notifications = await fetch(`${base}/api/v1/notifications`, { headers: { cookie: cookies } });
    const notificationBody = await notifications.json();
    assert.equal(notificationBody.unread, 1);
    assert.match(notificationBody.notifications[0].message, /Customer/);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
