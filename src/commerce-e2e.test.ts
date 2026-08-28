/**
 * Marketplace end-to-end suite against a REAL MongoDB.
 *
 * Skipped by default (keeps `npm test` green on machines without MongoDB);
 * run with a disposable database:
 *
 *   TEST_MONGODB_URI='mongodb://127.0.0.1:27017/sadik_travels_test' npm test
 *
 * The suite drives the REAL production stores + route handlers over HTTP —
 * no mock doubles — and covers the mandatory marketplace QA flow:
 * admin create → refresh/list → public listing → detail → server-side price →
 * booking → payment intent → offline confirmation → admin manage → edit →
 * unpublish → delete → hotel create/public sync, plus navigation dedup.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import mongoose from 'mongoose';
import { MongoStore } from './store.js';
import { createCommerceStore } from './commerce-store.js';
import { createHotelStore } from './hotel-store.js';
import { registerCommerceRoutes } from './commerce-routes.js';
import { registerHotelRoutes } from './hotel-routes.js';
import { issueSession } from './security.js';
import { AppError } from './errors.js';

const testUri = process.env.TEST_MONGODB_URI;

type Harness = {
  baseUrl: string;
  close: () => Promise<void>;
  adminToken: string;
  customerToken: string;
  intents: Array<{ amount: number; currency: string; bookingId: string }>;
};

async function createHarness(): Promise<Harness> {
  // Never drop the caller's database: run against a throwaway database derived
  // from the URI (e.g. .../sadik_travels_test → .../sadik_travels_test_e2e).
  const uri = new URL(testUri!);
  uri.pathname = `${uri.pathname.replace(/\/$/, '')}_e2e_${process.pid}`;
  await mongoose.connect(uri.toString(), { serverSelectionTimeoutMS: 10_000 });
  await mongoose.connection.dropDatabase();
  const store = new MongoStore();
  await Promise.all(Object.values(mongoose.models).map(model => (model as any).createIndexes?.()));

  const admin = await store.createUser({ identity: 'super@e2e.test', channel: 'email', fullName: 'E2E Super', role: 'super_admin' });
  const customer = await store.createUser({ identity: 'customer@e2e.test', channel: 'email', fullName: 'E2E Customer', role: 'customer' });

  const intents: Harness['intents'] = [];
  const payment: any = {
    async createIntent(input: any) {
      intents.push({ amount: input.amount, currency: input.currency, bookingId: input.bookingId });
      return { checkoutUrl: 'https://checkout.test/session', transactionRef: `TXN-${intents.length}`, status: 'pending' };
    }
  };
  const notifications: any = {
    emit: async () => undefined,
    emitToUser: async () => undefined,
    adminRecipients: async () => []
  };

  const commerce = createCommerceStore();
  const hotelStore = createHotelStore();
  const app = express();
  app.use(express.json());
  registerCommerceRoutes(app, { store, commerce, payment, notifications } as any);
  registerHotelRoutes(app, { store, hotelStore, media: {} as any, payment, notifications } as any);
  // SPA shell + fallback, mirroring the production static serving.
  app.use(express.static(process.cwd(), { index: 'index.html', maxAge: 0 }));
  app.get(/.*/, (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/assets/')) return next();
    if (/\.[a-z0-9]{2,5}$/i.test(req.path)) return next();
    if (!req.accepts('html')) return next();
    res.sendFile(`${process.cwd()}/index.html`);
  });
  app.use((error: any, _req: any, res: any, _next: any) => {
    const appError = error instanceof AppError ? error : new AppError(500, 'INTERNAL_ERROR', error?.message || 'failed');
    res.status(appError.statusCode).json({ error: { code: appError.code, message: appError.message } });
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
  const adminSession = await issueSession(store, admin, {});
  const customerSession = await issueSession(store, customer, {});

  return {
    baseUrl,
    adminToken: adminSession.accessToken,
    customerToken: customerSession.accessToken,
    intents,
    close: async () => {
      await new Promise<void>(resolve => server.close(() => resolve()));
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  };
}

async function api(h: Harness, method: string, path: string, token?: string, body?: unknown) {
  const response = await fetch(`${h.baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

const PACKAGE = {
  type: 'holiday_package', slug: 'e2e-cox-bazar', title: 'E2E Cox Bazar Holiday', summary: '3D/2N beach escape',
  description: 'Server-priced package for the end-to-end suite.', country: 'Bangladesh', city: "Cox's Bazar", destination: "Cox's Bazar",
  durationDays: 3, durationNights: 2, price: 12000, originalPrice: 15000, serviceCharge: 500, taxPct: 5,
  availability: 10, bookable: true, featured: true, status: 'published',
  itinerary: [{ day: 1, title: 'Arrival', detail: 'Check in and beach time' }, { day: 2, title: 'Island tour', detail: 'Inani beach and local sights' }],
  inclusions: ['Breakfast', 'Transfers'], amenities: ['AC'], terms: 'E2E terms'
};

test('marketplace end-to-end (MongoDB-backed)', { skip: !testUri ? 'Set TEST_MONGODB_URI to a disposable MongoDB database to run this suite.' : false }, async () => {
  const h = await createHarness();
  let packageId = '';
  try {
    /* 1 — admin create */
    const created = await api(h, 'POST', '/api/v1/admin/catalog', h.adminToken, PACKAGE);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    packageId = created.body.product.id;
    assert.equal(created.body.product.price, 12000);
    assert.equal(created.body.product.availability, 10);

    /* 2 — admin refresh/list */
    const adminList = await api(h, 'GET', '/api/v1/admin/catalog?type=holiday_package', h.adminToken);
    assert.equal(adminList.status, 200);
    assert.ok(adminList.body.products.some((p: any) => p.id === packageId), 'admin list must show the new package after refresh');

    /* 3 — public listing + detail (only published) */
    const publicList = await api(h, 'GET', '/api/v1/catalog?type=holiday_package');
    assert.equal(publicList.status, 200);
    assert.ok(publicList.body.products.some((p: any) => p.id === packageId));
    const detail = await api(h, 'GET', `/api/v1/catalog/${packageId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.product.itinerary.length, 2);

    /* 4 — server-side price: cart add recomputes from the DB record */
    const cartAdd = await api(h, 'POST', '/api/v1/cart/items', h.customerToken, { productType: 'holiday_package', productId: packageId, quantity: 2, meta: {} });
    assert.equal(cartAdd.status, 201, JSON.stringify(cartAdd.body));
    // 2 × 12000 = 24000 + 5% tax = 1200 + 2 × 500 service = 26200
    assert.equal(cartAdd.body.pricing.subtotal, 24000);
    assert.equal(cartAdd.body.pricing.tax, 1200);
    assert.equal(cartAdd.body.pricing.serviceFee, 1000);
    assert.equal(cartAdd.body.pricing.total, 26200);

    /* 5 — checkout ignores any browser-supplied amount */
    const checkout = await api(h, 'POST', '/api/v1/checkout', h.customerToken, {
      source: 'cart',
      customer: { fullName: 'E2E Customer', email: 'customer@e2e.test', phone: '+8801700000000' },
      travelDate: '2026-09-10', travelers: [], paymentMethod: 'online', acceptTerms: true,
      total: 1, subtotal: 1, tax: 0, serviceFee: 0
    });
    assert.equal(checkout.status, 201, JSON.stringify(checkout.body));
    assert.equal(checkout.body.order.total, 26200, 'server must recompute the total from the DB record');
    assert.equal(checkout.body.order.paymentStatus, 'pending');

    /* 6 — availability consumed by the booking */
    const afterBooking = await api(h, 'GET', `/api/v1/admin/catalog/${packageId}`, h.adminToken);
    assert.equal(afterBooking.body.product.availability, 8, 'a booking must consume purchased seats');

    /* 7 — payment intent amount comes from the DB order total */
    const payIntent = await api(h, 'POST', `/api/v1/orders/${checkout.body.order.id}/pay`, h.customerToken, {});
    assert.equal(payIntent.status, 200, JSON.stringify(payIntent.body));
    assert.equal(payIntent.body.checkoutUrl, 'https://checkout.test/session');
    assert.equal(h.intents.at(-1)?.amount, 26200, 'intent amount must be the server total');
    assert.equal(h.intents.at(-1)?.bookingId, checkout.body.order.id);
    const paidOrder = await api(h, 'GET', `/api/v1/orders/${checkout.body.order.id}`, h.customerToken);
    assert.equal(paidOrder.body.order.paymentStatus, 'processing', 'frontend cannot mark a payment paid');

    /* 8 — admin confirms booking + payment → invoice paid */
    const adminConfirm = await api(h, 'PATCH', `/api/v1/admin/orders/${checkout.body.order.id}`, h.adminToken, { status: 'confirmed', paymentStatus: 'paid' });
    assert.equal(adminConfirm.status, 200, JSON.stringify(adminConfirm.body));
    assert.equal(adminConfirm.body.order.status, 'confirmed');
    assert.equal(adminConfirm.body.order.paymentStatus, 'paid');
    const adminOrder = await api(h, 'GET', `/api/v1/admin/orders/${checkout.body.order.id}`, h.adminToken);
    assert.equal(adminOrder.body.order.status, 'confirmed');
    assert.equal(adminOrder.body.invoice?.status, 'paid', 'invoice must be marked paid with the payment');

    /* 9 — offline (bank transfer) path: frontend can never mark it paid */
    const checkoutOffline = await api(h, 'POST', '/api/v1/checkout', h.customerToken, {
      source: 'direct', item: { productType: 'holiday_package', productId: packageId, quantity: 1, meta: {} },
      customer: { fullName: 'E2E Customer', email: 'customer@e2e.test', phone: '+8801700000000' },
      travelDate: '2026-11-05', travelers: [], paymentMethod: 'bank_transfer', acceptTerms: true
    });
    assert.equal(checkoutOffline.status, 201, JSON.stringify(checkoutOffline.body));
    const offlineOrder = checkoutOffline.body.order;
    assert.equal(offlineOrder.paymentStatus, 'pending');
    const offlinePay = await api(h, 'POST', `/api/v1/orders/${offlineOrder.id}/pay`, h.customerToken, {});
    assert.equal(offlinePay.status, 200);
    assert.equal(offlinePay.body.order.paymentStatus, 'processing');
    assert.notEqual(offlinePay.body.order.status, 'paid', 'offline payment must never auto-complete');

    /* 10 — customer cancellation restores availability */
    const cancel = await api(h, 'POST', `/api/v1/orders/${offlineOrder.id}/cancel`, h.customerToken, {});
    assert.equal(cancel.status, 200);
    assert.equal(cancel.body.order.status, 'cancelled');
    const afterCancel = await api(h, 'GET', `/api/v1/admin/catalog/${packageId}`, h.adminToken);
    // 10 − 2 (online order) − 1 (offline order) + 1 (cancelled offline order) = 8
    assert.equal(afterCancel.body.product.availability, 8, 'cancellation must restore the seat');

    /* 11 — edit: price change reaches public catalogue */
    const edit = await api(h, 'PATCH', `/api/v1/admin/catalog/${packageId}`, h.adminToken, { price: 15000 });
    assert.equal(edit.status, 200);
    const detailAfterEdit = await api(h, 'GET', `/api/v1/catalog/${packageId}`);
    assert.equal(detailAfterEdit.body.product.price, 15000);

    /* 12 — unpublish hides from public site (admin still sees it) */
    const unpublish = await api(h, 'PATCH', `/api/v1/admin/catalog/${packageId}`, h.adminToken, { status: 'draft' });
    assert.equal(unpublish.status, 200);
    const publicAfterUnpublish = await api(h, 'GET', '/api/v1/catalog?type=holiday_package');
    assert.equal(publicAfterUnpublish.body.products.some((p: any) => p.id === packageId), false);
    assert.equal((await api(h, 'GET', `/api/v1/catalog/${packageId}`)).status, 404);
    const adminStillSees = await api(h, 'GET', '/api/v1/admin/catalog?type=holiday_package', h.adminToken);
    assert.ok(adminStillSees.body.products.some((p: any) => p.id === packageId), 'admin list keeps drafts');

    /* 13 — permanent delete removes the record */
    const del = await api(h, 'DELETE', `/api/v1/admin/catalog/${packageId}?permanent=true`, h.adminToken);
    assert.equal(del.status, 200, JSON.stringify(del.body));
    const afterDelete = await api(h, 'GET', '/api/v1/admin/catalog?type=holiday_package', h.adminToken);
    assert.equal(afterDelete.body.products.some((p: any) => p.id === packageId), false);
    packageId = '';

    /* 14 — sold-out / non-bookable products are refused at cart and checkout */
    const soldOut = await api(h, 'POST', '/api/v1/admin/catalog', h.adminToken, { ...PACKAGE, slug: 'e2e-sold-out', title: 'Sold out package', availability: 0 });
    const soldOutId = soldOut.body.product.id;
    assert.equal((await api(h, 'POST', '/api/v1/cart/items', h.customerToken, { productType: 'holiday_package', productId: soldOutId, quantity: 1, meta: {} })).status, 409);
    const notBookable = await api(h, 'POST', '/api/v1/admin/catalog', h.adminToken, { ...PACKAGE, slug: 'e2e-not-bookable', title: 'Quote-only package', bookable: false });
    const notBookableId = notBookable.body.product.id;
    assert.equal((await api(h, 'POST', '/api/v1/cart/items', h.customerToken, { productType: 'holiday_package', productId: notBookableId, quantity: 1, meta: {} })).status, 409);
    await api(h, 'DELETE', `/api/v1/admin/catalog/${soldOutId}?permanent=true`, h.adminToken);
    await api(h, 'DELETE', `/api/v1/admin/catalog/${notBookableId}?permanent=true`, h.adminToken);

    /* 15 — admin hotel create syncs to the public hotel API (homepage source) */
    const hotel = await api(h, 'POST', '/api/v1/admin/hotels', h.adminToken, {
      slug: 'e2e-hotel-sunset', name: 'E2E Hotel Sunset', propertyType: 'Hotel', city: "Cox's Bazar", area: 'Kolatoli Road',
      starRating: 4, shortDescription: 'E2E hotel', amenities: ['Free Wi-Fi'], status: 'active',
      images: [{ url: 'https://res.cloudinary.com/demo/image/upload/samples/landscape.jpg' }],
      pricePerNight: 3500, checkInTime: '14:00', checkOutTime: '12:00'
    });
    assert.equal(hotel.status, 201, JSON.stringify(hotel.body));
    const publicHotels = await api(h, 'GET', '/api/v1/hotels?pageSize=8&sort=recommended');
    assert.equal(publicHotels.status, 200);
    assert.ok(publicHotels.body.hotels.some((x: any) => x.slug === 'e2e-hotel-sunset'), 'admin-created hotel must appear in the public hotel API used by the homepage');

    /* 16 — click-through renders the SPA shell */
    for (const route of ['/hotels', '/holiday-packages']) {
      const page = await fetch(`${h.baseUrl}${route}`);
      assert.equal(page.status, 200);
      assert.ok((await page.text()).includes('Sadik Travels'));
    }
  } finally {
    if (packageId) await api(h, 'DELETE', `/api/v1/admin/catalog/${packageId}?permanent=true`, h.adminToken).catch(() => undefined);
    await h.close();
  }
});

test('sidebar navigation: one entry per catalogue vertical, no duplicates, no bare catalogue row', { skip: !testUri ? 'Set TEST_MONGODB_URI to run.' : false }, async () => {
  const h = await createHarness();
  try {
    // Stray row that must never render: bare /admin/catalog with no ?type=
    const store = new MongoStore();
    await store.createNavigation({ groupName: 'Catalogue', label: 'Catalogue (all)', route: '/admin/catalog', icon: 'grid', permission: 'catalog_view', sortOrder: 99, visible: true, enabled: true });
    const nav = await store.listNavigation(true);
    const catalogRoutes = nav.filter(item => item.route.startsWith('/admin/catalog')).map(item => item.route).sort();
    assert.deepEqual(catalogRoutes, [
      '/admin/catalog?type=destination',
      '/admin/catalog?type=holiday_package',
      '/admin/catalog?type=home'
    ], 'each vertical keeps exactly one entry (this is the regression: dedup used to collapse on the base path)');
    const holiday = nav.find(item => item.route === '/admin/catalog?type=holiday_package');
    assert.equal(holiday?.label, 'Holiday Packages');
    assert.equal(holiday?.permission, 'catalog_view');
    assert.equal(nav.filter(item => item.route === '/admin/catalog?type=holiday_package').length, 1);
  } finally {
    await h.close();
  }
});
