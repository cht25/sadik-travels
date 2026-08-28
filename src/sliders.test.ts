/**
 * Home Sliders end-to-end suite against a REAL MongoDB + REAL app routes.
 *
 * Skipped by default; run with a disposable database:
 *
 *   TEST_MONGODB_URI='mongodb://127.0.0.1:27017/sadik_travels_test' npm test
 *
 * Covers the mandatory slider QA flow: admin auth + permission guard →
 * media upload (image storage) → create → refresh persists → public feed
 * (only active + published + in-window) → edit propagates → display order →
 * disable hides → archive/delete safe → button link validation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { createServer } from 'node:http';
import { issueSession } from './security.js';

const testUri = process.env.TEST_MONGODB_URI;

test('home sliders: admin CRUD → DB → public carousel', { skip: !testUri ? 'Set TEST_MONGODB_URI to a disposable MongoDB database to run this suite.' : false }, async () => {
  const uri = new URL(testUri!);
  uri.pathname = `${uri.pathname.replace(/\/$/, '')}_sliders_e2e_${process.pid}`;
  process.env.MONGODB_URI = uri.toString();
  process.env.LOG_LEVEL = 'silent';
  process.env.JWT_SECRET = 'test-only-jwt-secret-that-is-long-enough-to-sign-tokens';
  process.env.SETTINGS_MASTER_KEY = 'test-only-settings-secret-that-is-long-enough-to-encrypt';
  process.env.DEV_OTP_ECHO = 'true';

  let uploads = 0;
  let deletes = 0;
  const media = {
    isConfigured: () => true,
    async upload(_buffer: Buffer, input: { folder: string; originalFilename: string; altText?: string }) {
      uploads += 1;
      return {
        publicId: `sadik-travels/${input.folder}/asset-${uploads}`,
        secureUrl: `https://res.cloudinary.com/sadik-travels/image/upload/v1730000000/sadik-travels/${input.folder}/asset-${uploads}.jpg`,
        originalFilename: input.originalFilename,
        mimeType: 'image/jpeg',
        format: 'jpg',
        width: 1200,
        height: 450,
        bytes: 4096,
        folder: input.folder,
        altText: input.altText?.trim() || undefined
      };
    },
    async delete() { deletes += 1; return { result: 'ok' }; }
  };

  const { buildApp } = await import('./app.js');
  const built = buildApp({ media } as any);
  await built.connection;
  await mongoose.connection.dropDatabase();
  const store = built.store;
  const server = createServer(built.app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;

  const admin = await store.createUser({ identity: 'slider-super@e2e.test', channel: 'email', fullName: 'Slider Super', role: 'super_admin' });
  // Admins are provisioned with explicit fine permissions (the production
  // path); the editor gets exactly the offer/media grants a content manager needs.
  const editor = await store.createAdminUser({ email: 'slider-editor@e2e.test', fullName: 'Slider Editor', role: 'content_manager', permissions: ['offer.view', 'offer.create', 'offer.update', 'offer.delete', 'media.view', 'media.upload'] });
  const customer = await store.createUser({ identity: 'slider-customer@e2e.test', channel: 'email', fullName: 'Slider Customer', role: 'customer' });
  const adminToken = (await issueSession(store, admin, {})).accessToken;
  const editorToken = (await issueSession(store, editor, {})).accessToken;
  const customerToken = (await issueSession(store, customer, {})).accessToken;

  const api = async (method: string, path: string, token?: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  };

  try {
    // 1. Auth + authorization guards.
    assert.equal((await api('GET', '/api/v1/admin/sliders')).status, 401, 'anonymous list must be rejected');
    assert.equal((await api('GET', '/api/v1/admin/sliders', customerToken)).status, 403, 'customers must be rejected');
    assert.equal((await api('POST', '/api/v1/admin/sliders', customerToken, { title: 'Nope' })).status, 403, 'customers cannot create sliders');

    // 2. Image upload through the production media route (persistent storage).
    const form = new FormData();
    form.append('file', new Blob([Buffer.from('fake-jpeg-bytes')], { type: 'image/jpeg' }), 'cover.jpg');
    form.append('folder', 'banners');
    form.append('altText', 'E2E cover');
    const uploadResponse = await fetch(`${base}/api/v1/admin/media`, { method: 'POST', headers: { authorization: `Bearer ${adminToken}` }, body: form });
    const uploadBody = await uploadResponse.json();
    assert.equal(uploadResponse.status, 201, 'media upload must succeed');
    assert.equal(uploads, 1, 'the media service must receive the file');
    const asset = uploadBody.media;

    // 3. Link validation — unsafe or incomplete buttons are rejected.
    const bad = async (payload: Record<string, unknown>) => (await api('POST', '/api/v1/admin/sliders', adminToken, { title: 'Bad', subtitle: '', description: '', imageUrl: asset.secureUrl, status: 'draft', active: true, displayOrder: 0, ...payload })).status;
    assert.equal(await bad({ primaryButtonText: 'Go', primaryButtonLink: 'javascript:alert(1)' }), 400);
    assert.equal(await bad({ primaryButtonText: 'Go', primaryButtonLink: '//evil.example' }), 400);
    assert.equal(await bad({ primaryButtonText: 'Go', primaryButtonLink: '' }), 400, 'button label without a link must fail');
    assert.equal(await bad({ weeklyHold: true }), 400, 'unknown fields must be rejected');

    // 4. Create (published) + second slider (draft) via the admin API.
    const created = await api('POST', '/api/v1/admin/sliders', adminToken, {
      title: 'Cox Summer Escape', subtitle: 'Beach season savings', description: 'Stay 3 nights, pay for 2.',
      imageUrl: asset.secureUrl, mediaId: asset.id,
      mobileImageUrl: 'https://res.cloudinary.com/sadik-travels/image/upload/v1/mobile.jpg',
      primaryButtonText: 'Book hotels', primaryButtonLink: '/hotels',
      secondaryButtonText: 'Explore tours', secondaryButtonLink: 'https://example.com/tours', secondaryExternal: true,
      displayOrder: 10, active: true, status: 'published'
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const live = created.body.slider;
    assert.equal(live.primaryButtonLink, '/hotels');
    assert.equal(live.primaryExternal, false);
    assert.equal(live.secondaryExternal, true);

    const draft = await api('POST', '/api/v1/admin/sliders', editorToken, {
      title: 'Draft only', subtitle: '', description: '', imageUrl: asset.secureUrl, mediaId: asset.id,
      primaryButtonText: '', primaryButtonLink: '', secondaryButtonText: '', secondaryButtonLink: '',
      displayOrder: 5, active: true, status: 'draft'
    });
    assert.equal(draft.status, 201, 'a content manager may create sliders');

    // 5. Refresh/list persists and is sorted by display order.
    const list = await api('GET', '/api/v1/admin/sliders', adminToken);
    assert.equal(list.status, 200);
    assert.equal(list.body.sliders.length, 2);
    assert.deepEqual(list.body.sliders.map((item: any) => item.title), ['Draft only', 'Cox Summer Escape']);
    assert.equal(list.body.sliders[1].mediaId, asset.id);

    // 6. Public feed: only active + published + in-window, ordered by display order.
    const publicFeed = async () => (await fetch(`${base}/api/v1/site/sliders`)).json();
    assert.deepEqual((await publicFeed()).sliders.map((item: any) => item.title), ['Cox Summer Escape']);
    const publicItem = (await publicFeed()).sliders[0];
    assert.match(publicItem.imageUrl, /^https:\/\/res\.cloudinary\.com\/sadik-travels\/image\/upload\/f_auto,q_auto,w_1600,c_limit\/v1730000000\/sadik-travels\/banners\/asset-1\.jpg$/, 'public feeds use the optimized CDN URL');
    assert.match(publicItem.mobileImageUrl, /^https:\/\/res\.cloudinary\.com\/.*\/f_auto,q_auto,w_900,c_limit\/.*mobile\.jpg$/, 'mobile image is served with a mobile-optimized transform');
    assert.equal(publicItem.primaryButtonLink, '/hotels');
    assert.equal(publicItem.secondaryButtonLink, 'https://example.com/tours');

    // 7. Edit propagates to the public feed.
    const patched = await api('PATCH', `/api/v1/admin/sliders/${live.id}`, adminToken, { title: 'Cox Boutique Escape', displayOrder: 20 });
    assert.equal(patched.status, 200);
    assert.equal((await publicFeed()).sliders[0].title, 'Cox Boutique Escape');

    // 8. Display order change is respected by the public feed.
    await api('PATCH', `/api/v1/admin/sliders/${draft.body.slider.id}`, adminToken, { status: 'published' });
    const ordered = await publicFeed();
    assert.deepEqual(ordered.sliders.map((item: any) => item.title), ['Draft only', 'Cox Boutique Escape'], 'sortOrder must order the public feed');

    // 9. Disabling hides a published slider without deleting it.
    await api('PATCH', `/api/v1/admin/sliders/${draft.body.slider.id}`, adminToken, { active: false });
    assert.deepEqual((await publicFeed()).sliders.map((item: any) => item.title), ['Cox Boutique Escape']);
    assert.equal((await api('GET', '/api/v1/admin/sliders', adminToken)).body.sliders.length, 2, 'disabled items remain in admin');

    // 10. Publish guard: a slider without an image cannot be published.
    const noImage = await api('POST', '/api/v1/admin/sliders', adminToken, {
      title: 'No image', subtitle: '', description: '', imageUrl: '', primaryButtonText: '', primaryButtonLink: '',
      secondaryButtonText: '', secondaryButtonLink: '', displayOrder: 30, active: true, status: 'draft'
    });
    assert.equal(noImage.status, 201);
    assert.equal((await api('POST', `/api/v1/admin/sliders/${noImage.body.slider.id}/publish`, adminToken)).status, 400, 'publishing without an image must fail');

    // 11. End-dated slider disappears from the public feed.
    const ended = await api('POST', '/api/v1/admin/sliders', adminToken, {
      title: 'Ended campaign', subtitle: '', description: '', imageUrl: asset.secureUrl, primaryButtonText: '', primaryButtonLink: '',
      secondaryButtonText: '', secondaryButtonLink: '', displayOrder: 1, active: true, status: 'published',
      startsAt: '2020-01-01', endsAt: '2020-02-01'
    });
    assert.equal(ended.status, 201);
    assert.equal((await publicFeed()).sliders.some((item: any) => item.title === 'Ended campaign'), false, 'expired sliders must not be public');

    // 12. Archive is safe (hidden publicly, kept in admin); permanent delete removes it.
    assert.equal((await api('DELETE', `/api/v1/admin/sliders/${live.id}`, adminToken)).status, 200);
    assert.equal((await publicFeed()).sliders.some((item: any) => item.title === 'Cox Boutique Escape'), false, 'archived slider must vanish from the carousel');
    assert.equal((await api('GET', '/api/v1/admin/sliders', adminToken)).body.sliders.find((item: any) => item.id === live.id).status, 'archived');
    assert.equal((await api('DELETE', `/api/v1/admin/sliders/${live.id}/permanent`, adminToken)).status, 204);
    assert.equal((await api('GET', '/api/v1/admin/sliders', adminToken)).body.sliders.find((item: any) => item.id === live.id), undefined, 'permanent delete removes the record');

    // 13. The stored image stays referenced by content while sliders use it
    // (media delete guard). The draft (mediaId) and the ended campaign (URL)
    // both still reference the asset after the live slider was deleted.
    assert.equal(await store.mediaReferenceCount(asset.id), 2, 'draft + ended campaign still reference the uploaded image');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
