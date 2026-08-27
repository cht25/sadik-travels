/**
 * Hotel image API route tests.
 *
 * These drive the REAL Express handlers registered by `registerHotelRoutes`
 * (src/hotel-routes.ts) over HTTP, with real JWT/cookie authentication from
 * src/security.ts and the real permission guard from src/middleware.ts. The
 * MongoDB-backed `Store`/`HotelStore` are replaced by in-memory doubles — this
 * sandbox has no reachable MongoDB — but everything the image fix touched in
 * the request path is production code:
 *
 *   request body -> imageSchema/hotelInputSchema -> hotelStore -> the
 *   post-save persistence check -> JSON response
 *
 * The doubles apply the same `normalizeHotelImages` the real store applies, so
 * the round trip behaves like production.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { registerHotelRoutes } from './hotel-routes.js';
import { normalizeHotelImages, hotelDisplayImages } from './hotel-store.js';
import { issueSession } from './security.js';
import { AppError } from './errors.js';
import type { User } from './store.js';

const CANONICAL = 'https://res.cloudinary.com/sadik-travels/image/upload/v1730000000/sadik-travels/hotels/asset-7f2c.jpg';

type Row = any;

function createHarness(options: { persistImages?: boolean } = {}) {
  const user: User = { id: 'admin-1', email: 'super@demo.test', fullName: 'Super Admin', role: 'super_admin', status: 'active', permissions: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as User;
  const hotels = new Map<string, Row>();
  const rooms = new Map<string, Row>();
  const audits: string[] = [];

  hotels.set('hotel-1', {
    id: 'hotel-1', slug: 'hotel-the-cox-today', name: 'Hotel The Cox Today', city: "Cox's Bazar", country: 'Bangladesh',
    propertyType: 'Hotel', starRating: 4, amenities: ['Free Wi-Fi'], status: 'active', available: true, featured: false, sortOrder: 0,
    // A legacy record: plain-string row + a display-optimized URL written back by
    // an older build. Both must still work and must heal on the next save.
    images: ['http://res.cloudinary.com/demo/image/upload/samples/landscape.jpg', { secureUrl: 'https://res.cloudinary.com/sadik/image/upload/f_auto,q_auto,w_200,c_limit/v1730000000/sadik-travels/hotels/asset-7f2c.jpg', publicId: 'sadik-travels/hotels/asset-7f2c' }],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  });

  const store: any = {
    createSession: async (session: any) => session,
    findSessionById: async (id: string) => ({ id, userId: user.id, revokedAt: undefined, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }),
    findUserById: async (id: string) => (id === user.id ? user : undefined),
    audit: async (action: string) => { audits.push(action); }
  };

  const hotelStore: any = {
    adminFindHotel: async (id: string) => (hotels.has(id) ? { ...hotels.get(id), images: normalizeHotelImages(hotels.get(id).images) } : undefined),
    adminFindRoom: async (id: string) => (rooms.has(id) ? { ...rooms.get(id), images: normalizeHotelImages(rooms.get(id).images) } : undefined),
    adminUpdateHotel: async (id: string, patch: any) => {
      const current = hotels.get(id);
      if (!current) return undefined;
      const next = { ...current, ...patch, images: options.persistImages === false ? [] : normalizeHotelImages(patch.images ?? current.images) };
      hotels.set(id, next);
      return { ...next, images: normalizeHotelImages(next.images) };
    },
    adminCreateHotel: async (input: any) => {
      const row = { ...input, id: `hotel-${hotels.size + 1}`, images: normalizeHotelImages(input.images) };
      hotels.set(row.id, row);
      return { ...row, images: normalizeHotelImages(row.images) };
    },
    findHotel: async (idOrSlug: string) => {
      const row = [...hotels.values()].find(candidate => candidate.id === idOrSlug || candidate.slug === idOrSlug);
      if (!row) return undefined;
      const images = hotelDisplayImages(row.images, 1280);
      return { ...row, images, thumbnail: images[0]?.displayUrl, rooms: [], priceFrom: 4200 };
    },
    adminListHotels: async () => ({ hotels: [...hotels.values()].map(row => ({ ...row, images: normalizeHotelImages(row.images) })), total: hotels.size, page: 1, pageSize: 20, pageCount: 1 }),
    adminListRooms: async () => [...rooms.values()],
    adminCreateRoom: async (hotelId: string, input: any) => { const row = { ...input, id: `room-${rooms.size + 1}`, hotelId, images: normalizeHotelImages(input.images) }; rooms.set(row.id, row); return { ...row, images: normalizeHotelImages(row.images) }; },
    adminUpdateRoom: async (id: string, patch: any) => { const current = rooms.get(id); if (!current) return undefined; const next = { ...current, ...patch, images: normalizeHotelImages(patch.images ?? current.images) }; rooms.set(id, next); return { ...next, images: normalizeHotelImages(next.images) }; },
    adminStats: async () => ({ totalHotels: hotels.size })
  };

  const app = express();
  app.use(express.json());
  registerHotelRoutes(app, { store, hotelStore, media: { isConfigured: () => true } as any, payment: {} as any });
  app.use((error: any, _req: any, res: any, _next: any) => {
    const appError = error instanceof AppError ? error : new AppError(500, 'INTERNAL_ERROR', error?.message || 'failed');
    res.status(appError.statusCode).json({ error: { code: appError.code, message: appError.message } });
  });

  return { app, store, hotelStore, hotels, rooms, audits, user };
}

async function adminToken(store: any, user: User) {
  const { accessToken } = await issueSession(store, user, {});
  return accessToken;
}

const servers: any[] = [];

/** Real HTTP round trip against the real Express app (one server per harness). */
async function call(harness: any, method: string, path: string, token?: string, body?: unknown) {
  if (!harness.baseUrl) {
    harness.server = harness.app.listen(0, '127.0.0.1');
    servers.push(harness.server);
    await new Promise<void>(resolve => harness.server.once('listening', resolve));
    harness.baseUrl = `http://127.0.0.1:${harness.server.address().port}`;
  }
  const response = await fetch(`${harness.baseUrl}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, body: await response.json().catch(() => undefined) };
}

test.after(() => { for (const server of servers) server.close(); });

test('hotel API: PATCH with the exact admin payload stores canonical images and returns them', async () => {
  const harness = createHarness();
  const token = await adminToken(harness.store, harness.user);
  const response = await call(harness, 'PATCH', '/api/v1/admin/hotels/hotel-1', token, {
    name: 'Hotel The Cox Today',
    images: [
      { url: CANONICAL, publicId: 'sadik-travels/hotels/asset-7f2c', mediaId: '2b7f2f3e-0b5f-4d0e-9b3e-8c1f6f7d1a11', alt: 'Hotel The Cox Today', isPrimary: true },
      { secureUrl: 'https://res.cloudinary.com/demo/image/upload/samples/landscape.jpg', alt: 'View' }
    ]
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const stored = harness.hotels.get('hotel-1').images;
  assert.equal(stored.length, 2);
  assert.equal(stored[0].url, CANONICAL, 'the uploaded photo must be the stored primary');
  assert.equal(stored[0].isPrimary, true);
  assert.equal(stored[1].url, 'https://res.cloudinary.com/demo/image/upload/samples/landscape.jpg');
  assert.deepEqual(response.body.hotel.images.map((image: any) => image.url), [CANONICAL, 'https://res.cloudinary.com/demo/image/upload/samples/landscape.jpg']);
  assert.ok(harness.audits.includes('hotel.updated'));
});

test('hotel API: a save is never reported as successful when the photos did not persist', async () => {
  const harness = createHarness({ persistImages: false });
  const token = await adminToken(harness.store, harness.user);
  const response = await call(harness, 'PATCH', '/api/v1/admin/hotels/hotel-1', token, {
    images: [{ url: CANONICAL, publicId: 'sadik-travels/hotels/asset-7f2c' }]
  });
  assert.equal(response.status, 502);
  assert.equal(response.body.error.code, 'IMAGE_NOT_PERSISTED');
  assert.match(response.body.error.message, /photo/i);
});

test('hotel API: an image entry with no usable URL is rejected with a 400, not silently dropped', async () => {
  const harness = createHarness();
  const token = await adminToken(harness.store, harness.user);
  const response = await call(harness, 'PATCH', '/api/v1/admin/hotels/hotel-1', token, { images: [{ url: '' }] });
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'VALIDATION_ERROR');
});

test('hotel API: the legacy record is readable and heals to canonical URLs', async () => {
  const harness = createHarness();
  const token = await adminToken(harness.store, harness.user);
  const adminView = await call(harness, 'GET', '/api/v1/admin/hotels/hotel-1', token);
  assert.equal(adminView.status, 200);
  assert.deepEqual(adminView.body.hotel.images.map((image: any) => image.url), [
    'https://res.cloudinary.com/demo/image/upload/samples/landscape.jpg',
    'https://res.cloudinary.com/sadik/image/upload/v1730000000/sadik-travels/hotels/asset-7f2c.jpg'
  ]);
  for (const image of adminView.body.hotel.images) {
    assert.doesNotMatch(image.url, /\/upload\/f_auto,/, 'the editor must never receive a display-transformed URL to post back');
  }
});

test('hotel API: the public hotel response carries the images and a thumbnail', async () => {
  const harness = createHarness();
  const response = await call(harness, 'GET', '/api/v1/hotels/hotel-the-cox-today');
  assert.equal(response.status, 200);
  const hotel = response.body.hotel;
  assert.equal(hotel.images.length, 2);
  assert.match(hotel.images[0].displayUrl, /\/upload\/f_auto,q_auto,w_1280,c_limit\//);
  assert.doesNotMatch(hotel.images[0].url, /\/upload\/f_auto,/, 'canonical url stays untransformed');
  assert.equal(typeof hotel.thumbnail, 'string');
  assert.ok(hotel.thumbnail.length > 0);
});

test('hotel API: hotel routes still require an authenticated hotel manager', async () => {
  const harness = createHarness();
  const response = await call(harness, 'GET', '/api/v1/admin/hotels/hotel-1');
  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, 'AUTH_REQUIRED');
});
