import type { Express, Request } from 'express';
import { z, ZodError } from 'zod';
import { randomUUID } from 'node:crypto';
import { AppError, assert } from './errors.js';
import { optionalAuth, requireAuth, requireFinePermission } from './middleware.js';
import { hasFinePermission } from './permissions.js';
import { rateLimit } from './rate-limit.js';
import type { Store } from './store.js';
import type { PaymentProvider } from './providers.js';
import type { CommerceStore, CatalogType, CartItem, OrderTraveler } from './commerce-store.js';
import { CATALOG_TYPES } from './commerce-store.js';
import { config } from './config.js';

/**
 * Storefront + commerce API.
 *
 * Split into three tiers:
 *  - public      : catalogue browsing, facets, published reviews, order tracking
 *  - customer    : wishlist, cart, checkout, orders, invoices, travellers, tickets
 *  - admin       : catalogue CRUD, coupons, orders, reviews, visa applications
 *
 * Every admin route is guarded by a fine-grained permission and writes an audit
 * entry. Every price is recalculated on the server from persisted records.
 */

const toInput = (schema: z.ZodTypeAny, value: unknown) => {
  try { return schema.parse(value); } catch (error) {
    if (error instanceof ZodError) throw new AppError(400, 'VALIDATION_ERROR', 'Please check the submitted fields', error.flatten());
    throw error;
  }
};
const clientMeta = (req: Request) => ({ ip: req.ip, userAgent: req.get('user-agent')?.slice(0, 500) });

const catalogTypeSchema = z.enum(CATALOG_TYPES as unknown as [CatalogType, ...CatalogType[]]);
const imageSchema = z.object({ url: z.string().max(1000), publicId: z.string().max(300).optional(), mediaId: z.string().uuid().optional(), alt: z.string().max(300).optional() });

const catalogInputSchema = z.object({
  type: catalogTypeSchema,
  slug: z.string().trim().min(2).max(160).regex(/^[a-z0-9]+(?:-[a-z0-9-]+)*$/, 'Use lowercase letters, numbers and hyphens'),
  title: z.string().trim().min(2).max(200), subtitle: z.string().max(300).optional(), summary: z.string().max(600).optional(), description: z.string().max(8000).optional(),
  country: z.string().max(120).optional(), city: z.string().max(120).optional(), destination: z.string().max(160).optional(), region: z.string().max(120).optional(),
  heroImage: imageSchema.optional(), images: z.array(imageSchema).max(20).default([]),
  price: z.number().nonnegative().max(100000000).default(0), originalPrice: z.number().nonnegative().max(100000000).optional(),
  currency: z.string().length(3).default('BDT'), serviceCharge: z.number().nonnegative().max(1000000).default(0), taxPct: z.number().min(0).max(100).default(0),
  durationDays: z.number().int().min(0).max(365).optional(), durationNights: z.number().int().min(0).max(365).optional(),
  activationCode: z.string().max(300).optional(), instructions: z.string().max(4000).optional(),
  entryType: z.string().max(80).optional(), requiredDocuments: z.array(z.string().max(200)).max(40).default([]),
  itinerary: z.array(z.object({ day: z.number().int().min(1).max(365), title: z.string().max(200), detail: z.string().max(2000).optional() })).max(60).default([]),
  inclusions: z.array(z.string().max(200)).max(40).default([]), exclusions: z.array(z.string().max(200)).max(40).default([]),
  hotelInfo: z.string().max(1000).optional(), transportInfo: z.string().max(1000).optional(), guideInfo: z.string().max(1000).optional(),
  propertyType: z.string().max(80).optional(), guests: z.number().int().min(0).max(100).optional(), bedrooms: z.number().int().min(0).max(50).optional(),
  beds: z.number().int().min(0).max(80).optional(), bathrooms: z.number().int().min(0).max(50).optional(), amenities: z.array(z.string().max(80)).max(60).default([]),
  startDate: z.string().max(40).optional(), endDate: z.string().max(40).optional(), terms: z.string().max(4000).optional(),
  rating: z.number().min(0).max(5).optional(), tags: z.array(z.string().max(60)).max(30).default([]),
  availability: z.number().int().min(0).max(100000).default(100), bookable: z.boolean().default(true),
  featured: z.boolean().default(false), status: z.enum(['draft', 'published', 'archived']).default('draft'),
  sortOrder: z.number().int().min(-100000).max(100000).default(0), metadata: z.record(z.unknown()).default({})
});
const catalogPatchSchema = catalogInputSchema.partial();

const cartItemSchema = z.object({
  productType: z.string().min(2).max(60), productId: z.string().min(3).max(200),
  quantity: z.number().int().min(1).max(30).default(1), meta: z.record(z.unknown()).default({})
});
const cartUpdateSchema = z.object({ itemId: z.string().min(3).max(80), quantity: z.number().int().min(0).max(30) });

const travelerSchema = z.object({
  fullName: z.string().trim().min(2).max(160), relationship: z.string().max(60).optional(), dateOfBirth: z.string().max(40).optional(),
  gender: z.enum(['male', 'female', 'other']).optional(), nationality: z.string().max(80).optional(),
  passportNumber: z.string().max(40).optional(), passportExpiry: z.string().max(40).optional(),
  phone: z.string().max(40).optional(), email: z.string().email().or(z.literal('')).optional(), isPrimary: z.boolean().default(false)
});

const customerSchema = z.object({
  fullName: z.string().trim().min(2).max(160), email: z.string().email(), phone: z.string().trim().min(6).max(40),
  address: z.string().max(300).optional(), dateOfBirth: z.string().max(40).optional(), nationality: z.string().max(80).optional()
});

const checkoutSchema = z.object({
  source: z.enum(['cart', 'direct']).default('cart'),
  item: cartItemSchema.optional(),
  customer: customerSchema,
  travelers: z.array(travelerSchema.omit({ isPrimary: true, relationship: true })).max(20).default([]),
  travelDate: z.string().max(40).optional(), notes: z.string().max(2000).optional(),
  couponCode: z.string().max(60).optional(), paymentMethod: z.enum(['online', 'cod', 'bank_transfer', 'office']).default('online'),
  acceptTerms: z.literal(true)
});

const couponInputSchema = z.object({
  code: z.string().trim().min(3).max(40).regex(/^[A-Za-z0-9_-]+$/), description: z.string().max(300).optional(),
  discountType: z.enum(['percent', 'fixed']).default('percent'), value: z.number().positive().max(1000000),
  minAmount: z.number().nonnegative().max(10000000).default(0), maxDiscount: z.number().positive().max(10000000).optional(),
  startDate: z.string().max(40).optional(), endDate: z.string().max(40).optional(),
  usageLimit: z.number().int().positive().max(1000000).optional(), perUserLimit: z.number().int().min(1).max(100).default(1),
  applicableTypes: z.array(z.string().max(60)).max(20).default([]), status: z.enum(['active', 'paused', 'expired']).default('active')
});
const couponPatchSchema = couponInputSchema.partial();

const reviewInputSchema = z.object({
  productType: z.string().min(2).max(60), productId: z.string().min(3).max(200), productTitle: z.string().max(200).optional(),
  orderId: z.string().max(80).optional(), rating: z.number().int().min(1).max(5),
  title: z.string().max(160).optional(), body: z.string().trim().min(4).max(3000)
});


const trackSchema = z.object({ reference: z.string().trim().min(4).max(80), identity: z.string().trim().min(4).max(160) });

/** Only fields a checkout genuinely needs are read back from the account. */
const accountPrefill = (user: any) => ({
  fullName: user?.fullName || '', email: user?.email || '', phone: user?.phone || '',
  address: user?.address || '', dateOfBirth: user?.dateOfBirth || '', nationality: user?.nationality || ''
});

export function registerCommerceRoutes(app: Express, deps: { store: Store; commerce: CommerceStore; payment: PaymentProvider }) {
  const { store, commerce, payment } = deps;

  const notify = async (userId: string, title: string, message: string) => {
    try { await store.createNotification({ userId, title, message, channels: ['in_app'], status: 'sent', sentAt: new Date().toISOString() } as any); } catch { /* notifications are best-effort */ }
  };

  /* =====================================================  PUBLIC CATALOGUE  */
  app.get('/api/v1/catalog', async (req, res) => {
    const query = req.query as Record<string, string>;
    const result = await commerce.listCatalog({
      type: (query.type as CatalogType) || 'all', status: 'published', q: query.q, country: query.country, destination: query.destination,
      minPrice: query.minPrice ? Number(query.minPrice) : undefined, maxPrice: query.maxPrice ? Number(query.maxPrice) : undefined,
      featured: query.featured === 'true' ? true : undefined, tags: query.tags ? query.tags.split(',').filter(Boolean) : undefined,
      region: query.region || undefined,
      sort: (query.sort as any) || 'recommended', page: Number(query.page) || 1, pageSize: Number(query.pageSize) || 12
    });
    res.setHeader('Cache-Control', 'no-store');
    res.json(result);
  });

  app.get('/api/v1/catalog/facets/:type', async (req, res) => {
    const type = toInput(catalogTypeSchema, req.params.type);
    res.json({ facets: await commerce.catalogFacets(type) });
  });

  app.get('/api/v1/catalog/:idOrSlug', async (req, res) => {
    const product = await commerce.findCatalogProduct(String(req.params.idOrSlug));
    assert(product && product.status === 'published', 404, 'PRODUCT_NOT_FOUND', 'This product is no longer available');
    const reviews = await commerce.listReviews({ productType: product!.type, productId: product!.id, status: 'approved', pageSize: 10 });
    const related = await commerce.listCatalog({ type: product!.type, status: 'published', pageSize: 4 });
    res.json({ product, reviews: reviews.reviews, related: related.products.filter(item => item.id !== product!.id).slice(0, 3) });
  });

  app.get('/api/v1/search', async (req, res) => {
    const term = String((req.query.q as string) || '').trim();
    if (term.length < 2) return res.json({ results: [] });
    const products = await commerce.globalSearch(term, 10);
    res.json({ results: products.map(item => ({ id: item.id, type: item.type, slug: item.slug, title: item.title, subtitle: item.destination || item.country || item.subtitle, price: item.price, imageUrl: item.heroImage?.url || item.images?.[0]?.url })) });
  });

  /* ======================================================  ORDER TRACKING  */
  app.post('/api/v1/orders/track', rateLimit('order-track', 30, 60), async (req, res) => {
    const input = toInput(trackSchema, req.body);
    const order = await commerce.findOrderForTracking(input.reference, input.identity);
    assert(order, 404, 'ORDER_NOT_FOUND', 'No booking matched that reference and contact detail');
    res.json({
      order: {
        orderNumber: order!.orderNumber, status: order!.status, paymentStatus: order!.paymentStatus, primaryType: order!.primaryType,
        items: order!.items.map(item => ({ title: item.title, quantity: item.quantity, productType: item.productType })),
        customerName: order!.customer?.fullName, travelDate: order!.travelDate, total: order!.total, currency: order!.currency,
        timeline: order!.timeline, createdAt: order!.createdAt, updatedAt: order!.updatedAt
      }
    });
  });

  /* ==========================================================  WISHLIST  */
  app.get('/api/v1/wishlist', requireAuth(store), async (req, res) => res.json({ items: await commerce.listWishlist(req.user!.id) }));

  app.post('/api/v1/wishlist', requireAuth(store), async (req, res) => {
    const input = toInput(z.object({ productType: z.string().min(2).max(60), productId: z.string().min(3).max(200) }), req.body);
    const product = await commerce.findCatalogProduct(input.productId);
    const item = await commerce.addWishlist({
      userId: req.user!.id, productType: product?.type || input.productType, productId: product?.id || input.productId,
      slug: product?.slug, title: product?.title || 'Saved item', imageUrl: product?.heroImage?.url || product?.images?.[0]?.url, price: product?.price
    });
    res.status(201).json({ item });
  });

  app.delete('/api/v1/wishlist/:id', requireAuth(store), async (req, res) => {
    const removed = await commerce.removeWishlist(req.user!.id, String(req.params.id));
    assert(removed, 404, 'WISHLIST_ITEM_NOT_FOUND', 'That item is not in your wishlist');
    res.json({ removed: true });
  });

  /* ==============================================================  CART  */
  const cartResponse = async (userId: string) => {
    const cart = await commerce.getCart(userId);
    const pricing = await commerce.priceCart(cart.items, { couponCode: cart.couponCode, userId });
    return { cart: { ...cart, items: pricing.items }, pricing };
  };

  app.get('/api/v1/cart', requireAuth(store), async (req, res) => res.json(await cartResponse(req.user!.id)));

  app.post('/api/v1/cart/items', requireAuth(store), async (req, res) => {
    const input = toInput(cartItemSchema, req.body);
    const product = await commerce.findCatalogProduct(input.productId);
    assert(product && product.status === 'published', 404, 'PRODUCT_NOT_FOUND', 'This product is no longer available');
    assert(product!.bookable, 409, 'PRODUCT_NOT_BOOKABLE', 'This item cannot be added to the cart');
    assert(product!.availability > 0, 409, 'PRODUCT_UNAVAILABLE', 'This item is currently out of stock');
    const cart = await commerce.getCart(req.user!.id);
    const items = [...cart.items];
    const existing = items.find(item => item.productId === product!.id && JSON.stringify(item.meta || {}) === JSON.stringify(input.meta || {}));
    if (existing) existing.quantity = Math.min(30, existing.quantity + input.quantity);
    else items.push({
      id: randomUUID(), productType: product!.type, productId: product!.id, slug: product!.slug, title: product!.title,
      imageUrl: product!.heroImage?.url || product!.images?.[0]?.url, unitPrice: product!.price,
      quantity: input.quantity, serviceCharge: product!.serviceCharge || 0, taxPct: product!.taxPct || 0, meta: input.meta
    });
    await commerce.saveCart(req.user!.id, items);
    res.status(201).json(await cartResponse(req.user!.id));
  });

  app.patch('/api/v1/cart/items', requireAuth(store), async (req, res) => {
    const input = toInput(cartUpdateSchema, req.body);
    const cart = await commerce.getCart(req.user!.id);
    const items = cart.items.filter(item => item.id !== input.itemId || input.quantity > 0)
      .map(item => item.id === input.itemId ? { ...item, quantity: input.quantity } : item);
    await commerce.saveCart(req.user!.id, items);
    res.json(await cartResponse(req.user!.id));
  });

  app.delete('/api/v1/cart/items/:itemId', requireAuth(store), async (req, res) => {
    const cart = await commerce.getCart(req.user!.id);
    await commerce.saveCart(req.user!.id, cart.items.filter(item => item.id !== req.params.itemId));
    res.json(await cartResponse(req.user!.id));
  });

  app.post('/api/v1/cart/coupon', requireAuth(store), async (req, res) => {
    const input = toInput(z.object({ code: z.string().trim().max(60) }), req.body);
    const cart = await commerce.getCart(req.user!.id);
    if (!input.code) { await commerce.saveCart(req.user!.id, cart.items, null); return res.json({ ...(await cartResponse(req.user!.id)), message: 'Coupon removed' }); }
    const pricing = await commerce.priceCart(cart.items, { userId: req.user!.id });
    const result = await commerce.evaluateCoupon(input.code, req.user!.id, pricing.subtotal, [...new Set(cart.items.map(item => item.productType))]);
    assert(result.valid, 400, 'COUPON_INVALID', result.message);
    await commerce.saveCart(req.user!.id, cart.items, input.code.trim().toUpperCase());
    res.json({ ...(await cartResponse(req.user!.id)), message: result.message });
  });

  /* =========================================================  CHECKOUT  */
  app.get('/api/v1/checkout/prefill', requireAuth(store), async (req, res) => {
    const travelers = await commerce.listTravelers(req.user!.id);
    res.json({ customer: accountPrefill(req.user), travelers });
  });

  app.post('/api/v1/checkout', requireAuth(store), rateLimit('checkout', 20, 60), async (req, res) => {
    const input = toInput(checkoutSchema, req.body);
    let items: CartItem[] = [];
    if (input.source === 'direct') {
      assert(input.item, 400, 'ITEM_REQUIRED', 'Select a product to continue');
      const product = await commerce.findCatalogProduct(input.item!.productId);
      assert(product && product.status === 'published', 404, 'PRODUCT_NOT_FOUND', 'This product is no longer available');
      items = [{
        id: randomUUID(), productType: product!.type, productId: product!.id, slug: product!.slug, title: product!.title,
        imageUrl: product!.heroImage?.url || product!.images?.[0]?.url, unitPrice: product!.price,
        quantity: input.item!.quantity, serviceCharge: product!.serviceCharge || 0, taxPct: product!.taxPct || 0, meta: input.item!.meta
      }];
    } else {
      const cart = await commerce.getCart(req.user!.id);
      items = cart.items;
      assert(items.length > 0, 400, 'CART_EMPTY', 'Your cart is empty');
    }

    const couponCode = input.couponCode || (input.source === 'cart' ? (await commerce.getCart(req.user!.id)).couponCode : undefined);
    const pricing = await commerce.priceCart(items, { couponCode, userId: req.user!.id });
    assert(pricing.total >= 0, 400, 'INVALID_TOTAL', 'The order total could not be calculated');

    const primaryType = pricing.items[0]?.productType || 'order';
    const bookingTypes = ['holiday_package', 'home'];
    const order = await commerce.createOrder({
      userId: req.user!.id, kind: bookingTypes.includes(primaryType) ? 'booking' : 'order', primaryType,
      items: pricing.items, customer: input.customer, travelers: input.travelers as OrderTraveler[],
      travelDate: input.travelDate, notes: input.notes,
      subtotal: pricing.subtotal, discount: 0, couponCode: pricing.couponCode, couponDiscount: pricing.couponDiscount,
      tax: pricing.tax, serviceFee: pricing.serviceFee, total: pricing.total, currency: pricing.currency,
      paymentMethod: input.paymentMethod, paymentStatus: 'pending', status: 'pending',
      contactEmail: input.customer.email.toLowerCase(), contactPhone: input.customer.phone
    });

    if (pricing.couponCode) {
      const coupon = await commerce.findCoupon(pricing.couponCode);
      if (coupon) await commerce.redeemCoupon(coupon.id, coupon.code, req.user!.id, order.id, pricing.couponDiscount);
    }
    if (input.source === 'cart') await commerce.clearCart(req.user!.id);

    const invoice = await commerce.createInvoice(order);
    await store.audit('order.created', { ...clientMeta(req), userId: req.user!.id, metadata: { orderId: order.id, orderNumber: order.orderNumber, total: order.total } });
    await notify(req.user!.id, 'Booking created', `Your booking ${order.orderNumber} has been created. Complete payment to confirm it.`);

    res.status(201).json({ order, invoice });
  });

  /* ============================================================  ORDERS  */
  app.get('/api/v1/orders', requireAuth(store), async (req, res) => {
    const query = req.query as Record<string, string>;
    res.json(await commerce.listOrders(req.user!.id, { status: query.status, kind: query.kind, page: Number(query.page) || 1, pageSize: Number(query.pageSize) || 20 }));
  });

  app.get('/api/v1/orders/:id', requireAuth(store), async (req, res) => {
    const order = await commerce.findOrder(String(req.params.id), req.user!.id);
    assert(order, 404, 'ORDER_NOT_FOUND', 'Booking not found');
    const invoice = await commerce.findInvoice(order!.id, req.user!.id);
    res.json({ order, invoice });
  });

  app.post('/api/v1/orders/:id/cancel', requireAuth(store), async (req, res) => {
    const order = await commerce.findOrder(String(req.params.id), req.user!.id);
    assert(order, 404, 'ORDER_NOT_FOUND', 'Booking not found');
    assert(['pending', 'confirmed', 'processing'].includes(order!.status), 409, 'ORDER_NOT_CANCELLABLE', 'This booking can no longer be cancelled online');
    const updated = await commerce.updateOrder(order!.id, { status: 'cancelled' }, { at: new Date().toISOString(), status: 'cancelled', note: 'Cancelled by customer', actorId: req.user!.id });
    await store.audit('order.cancelled', { ...clientMeta(req), userId: req.user!.id, metadata: { orderId: order!.id } });
    await notify(req.user!.id, 'Booking cancelled', `Booking ${order!.orderNumber} has been cancelled.`);
    res.json({ order: updated });
  });

  app.post('/api/v1/orders/:id/pay', requireAuth(store), rateLimit('order-pay', 20, 60), async (req, res) => {
    const order = await commerce.findOrder(String(req.params.id), req.user!.id);
    assert(order, 404, 'ORDER_NOT_FOUND', 'Booking not found');
    assert(order!.paymentStatus !== 'paid', 409, 'ALREADY_PAID', 'This booking is already paid');
    assert(!['cancelled', 'refunded', 'failed'].includes(order!.status), 409, 'ORDER_NOT_PAYABLE', 'This booking is not payable');
    if (order!.paymentMethod && order!.paymentMethod !== 'online') {
      const updated = await commerce.updateOrder(order!.id, { paymentStatus: 'processing', status: 'processing' }, { at: new Date().toISOString(), status: 'payment_pending', note: `Offline payment selected: ${order!.paymentMethod}` });
      return res.json({ order: updated, message: 'Our team will contact you to complete the offline payment.' });
    }
    const paymentRecord = await store.createPayment({ bookingId: order!.id, userId: req.user!.id, provider: 'configured', amount: order!.total, currency: order!.currency, status: 'created' });
    const providerResponse: any = await payment.createIntent({
      paymentId: paymentRecord.id, bookingId: order!.id, amount: order!.total, currency: order!.currency,
      customerId: req.user!.id, returnUrl: `${config.appOrigin}/payment/return`
    });
    await store.updatePayment(paymentRecord.id, { status: providerResponse?.status === 'paid' ? 'paid' : 'pending', transactionRef: providerResponse?.transactionRef, providerPayload: providerResponse });
    const updated = await commerce.updateOrder(order!.id, { paymentStatus: 'processing', paymentId: paymentRecord.id, transactionRef: providerResponse?.transactionRef },
      { at: new Date().toISOString(), status: 'payment_initiated', note: 'Payment session created' });
    res.json({ order: updated, checkoutUrl: providerResponse?.checkoutUrl, payment: paymentRecord });
  });

  /* ==========================================================  INVOICES  */
  app.get('/api/v1/invoices', requireAuth(store), async (req, res) => res.json({ invoices: await commerce.listInvoices(req.user!.id) }));
  app.get('/api/v1/invoices/:id', requireAuth(store), async (req, res) => {
    const invoice = await commerce.findInvoice(String(req.params.id), req.user!.id);
    assert(invoice, 404, 'INVOICE_NOT_FOUND', 'Invoice not found');
    res.json({ invoice });
  });

  /* ==================================================  SAVED TRAVELLERS  */
  app.get('/api/v1/account/travelers', requireAuth(store), async (req, res) => res.json({ travelers: await commerce.listTravelers(req.user!.id) }));
  app.post('/api/v1/account/travelers', requireAuth(store), async (req, res) => {
    const input = toInput(travelerSchema, req.body);
    res.status(201).json({ traveler: await commerce.createTraveler({ ...input, userId: req.user!.id } as any) });
  });
  app.patch('/api/v1/account/travelers/:id', requireAuth(store), async (req, res) => {
    const input = toInput(travelerSchema.partial(), req.body);
    const traveler = await commerce.updateTraveler(String(req.params.id), req.user!.id, input as any);
    assert(traveler, 404, 'TRAVELER_NOT_FOUND', 'Traveller not found');
    res.json({ traveler });
  });
  app.delete('/api/v1/account/travelers/:id', requireAuth(store), async (req, res) => {
    const removed = await commerce.deleteTraveler(String(req.params.id), req.user!.id);
    assert(removed, 404, 'TRAVELER_NOT_FOUND', 'Traveller not found');
    res.json({ removed: true });
  });

  /* ===========================================================  REVIEWS  */
  app.get('/api/v1/reviews', async (req, res) => {
    const query = req.query as Record<string, string>;
    assert(query.productId, 400, 'PRODUCT_REQUIRED', 'A product is required');
    res.json(await commerce.listReviews({ productId: query.productId, status: 'approved', page: Number(query.page) || 1, pageSize: Number(query.pageSize) || 10 }));
  });

  app.get('/api/v1/account/reviews', requireAuth(store), async (req, res) => res.json(await commerce.listReviews({ userId: req.user!.id, status: 'all', pageSize: 50 })));

  app.post('/api/v1/reviews', requireAuth(store), rateLimit('review', 10, 60), async (req, res) => {
    const input = toInput(reviewInputSchema, req.body);
    // A review requires a real completed purchase of that product by this customer.
    const orders = await commerce.listOrders(req.user!.id, { pageSize: 50 });
    const purchased = orders.orders.some(order => ['confirmed', 'completed'].includes(order.status) && order.items.some(item => item.productId === input.productId));
    assert(purchased, 403, 'REVIEW_NOT_ALLOWED', 'You can review a product after your booking is confirmed');
    const review = await commerce.createReview({
      ...input, userId: req.user!.id, userName: req.user!.fullName || 'Sadik Travels customer', status: 'pending'
    } as any);
    res.status(201).json({ review, message: 'Thank you. Your review is awaiting moderation.' });
  });

  /* ======================================================  ADMIN: CATALOG  */
  app.get('/api/v1/admin/catalog', requireFinePermission(store, 'catalog.view'), async (req, res) => {
    const query = req.query as Record<string, string>;
    res.json(await commerce.listCatalog({
      type: (query.type as CatalogType) || 'all', status: (query.status as any) || 'all', q: query.q,
      sort: (query.sort as any) || 'newest', page: Number(query.page) || 1, pageSize: Number(query.pageSize) || 20
    }));
  });
  app.get('/api/v1/admin/catalog/stats', requireFinePermission(store, 'catalog.view'), async (_req, res) => res.json({ stats: await commerce.catalogStats() }));
  app.get('/api/v1/admin/catalog/:id', requireFinePermission(store, 'catalog.view'), async (req, res) => {
    const product = await commerce.findCatalogProduct(String(req.params.id));
    assert(product, 404, 'PRODUCT_NOT_FOUND', 'Product not found');
    res.json({ product });
  });
  app.post('/api/v1/admin/catalog', requireFinePermission(store, 'catalog.create'), async (req, res) => {
    const input = toInput(catalogInputSchema, req.body);
    const product = await commerce.createCatalogProduct({ ...input, createdBy: req.user!.id } as any);
    await store.audit('catalog.created', { ...clientMeta(req), userId: req.user!.id, metadata: { productId: product.id, type: product.type, title: product.title } });
    res.status(201).json({ product });
  });
  app.patch('/api/v1/admin/catalog/:id', requireFinePermission(store, 'catalog.update'), async (req, res) => {
    const input = toInput(catalogPatchSchema, req.body);
    const product = await commerce.updateCatalogProduct(String(req.params.id), { ...input, updatedBy: req.user!.id } as any);
    assert(product, 404, 'PRODUCT_NOT_FOUND', 'Product not found');
    await store.audit('catalog.updated', { ...clientMeta(req), userId: req.user!.id, metadata: { productId: product!.id, type: product!.type } });
    res.json({ product });
  });
  app.delete('/api/v1/admin/catalog/:id', requireFinePermission(store, 'catalog.delete'), async (req, res) => {
    const permanent = String(req.query.permanent || '') === 'true';
    const product = permanent ? undefined : await commerce.archiveCatalogProduct(String(req.params.id));
    if (permanent) {
      const removed = await commerce.deleteCatalogProduct(String(req.params.id));
      assert(removed, 404, 'PRODUCT_NOT_FOUND', 'Product not found');
    } else assert(product, 404, 'PRODUCT_NOT_FOUND', 'Product not found');
    await store.audit(permanent ? 'catalog.deleted' : 'catalog.archived', { ...clientMeta(req), userId: req.user!.id, metadata: { productId: req.params.id } });
    res.json({ removed: true, product });
  });

  /* =======================================================  ADMIN: COUPONS  */
  app.get('/api/v1/admin/coupons', requireFinePermission(store, 'coupon.view'), async (req, res) => {
    const query = req.query as Record<string, string>;
    res.json(await commerce.listCoupons({ q: query.q, status: query.status, page: Number(query.page) || 1, pageSize: Number(query.pageSize) || 20 }));
  });
  app.post('/api/v1/admin/coupons', requireFinePermission(store, 'coupon.create'), async (req, res) => {
    const input = toInput(couponInputSchema, req.body);
    const coupon = await commerce.createCoupon({ ...input, createdBy: req.user!.id } as any);
    await store.audit('coupon.created', { ...clientMeta(req), userId: req.user!.id, metadata: { couponId: coupon.id, code: coupon.code } });
    res.status(201).json({ coupon });
  });
  app.patch('/api/v1/admin/coupons/:id', requireFinePermission(store, 'coupon.update'), async (req, res) => {
    const input = toInput(couponPatchSchema, req.body);
    const coupon = await commerce.updateCoupon(String(req.params.id), input as any);
    assert(coupon, 404, 'COUPON_NOT_FOUND', 'Coupon not found');
    await store.audit('coupon.updated', { ...clientMeta(req), userId: req.user!.id, metadata: { couponId: coupon!.id, code: coupon!.code } });
    res.json({ coupon });
  });
  app.delete('/api/v1/admin/coupons/:id', requireFinePermission(store, 'coupon.delete'), async (req, res) => {
    const removed = await commerce.deleteCoupon(String(req.params.id));
    assert(removed, 404, 'COUPON_NOT_FOUND', 'Coupon not found');
    await store.audit('coupon.deleted', { ...clientMeta(req), userId: req.user!.id, metadata: { couponId: req.params.id } });
    res.json({ removed: true });
  });

  /* ========================================================  ADMIN: ORDERS  */
  app.get('/api/v1/admin/orders', requireFinePermission(store, 'order.view'), async (req, res) => {
    const query = req.query as Record<string, string>;
    const result = await commerce.listAllOrders({ q: query.q, status: query.status, paymentStatus: query.paymentStatus, type: query.type, page: Number(query.page) || 1, pageSize: Number(query.pageSize) || 20 });
    const customers = await Promise.all(result.orders.map(order => store.findUserById(order.userId).catch(() => undefined)));
    res.json({ ...result, orders: result.orders.map((order, index) => ({ ...order, customer: customers[index] ? { id: customers[index]!.id, fullName: customers[index]!.fullName, email: customers[index]!.email, phone: customers[index]!.phone } : undefined })) });
  });
  app.get('/api/v1/admin/orders/stats', requireFinePermission(store, 'order.view'), async (_req, res) => res.json({ stats: await commerce.orderStats() }));
  app.get('/api/v1/admin/orders/:id', requireFinePermission(store, 'order.view'), async (req, res) => {
    const order = await commerce.findOrder(String(req.params.id));
    assert(order, 404, 'ORDER_NOT_FOUND', 'Order not found');
    const [customer, invoice] = await Promise.all([store.findUserById(order!.userId).catch(() => undefined), commerce.findInvoice(order!.id)]);
    res.json({ order, invoice, customer: customer ? { id: customer.id, fullName: customer.fullName, email: customer.email, phone: customer.phone } : undefined });
  });
  app.patch('/api/v1/admin/orders/:id', requireFinePermission(store, 'order.update'), async (req, res) => {
    const input = toInput(z.object({
      status: z.enum(['pending', 'confirmed', 'processing', 'completed', 'cancelled', 'refunded', 'failed']).optional(),
      paymentStatus: z.enum(['pending', 'processing', 'paid', 'failed', 'refunded', 'cancelled']).optional(),
      note: z.string().max(1000).optional()
    }).strict(), req.body);
    const order = await commerce.findOrder(String(req.params.id));
    assert(order, 404, 'ORDER_NOT_FOUND', 'Order not found');
    if (input.status === 'cancelled') assert(hasFinePermission(req.user, 'order.cancel'), 403, 'PERMISSION_DENIED', 'Permission required: order.cancel');
    if (input.paymentStatus === 'refunded') assert(hasFinePermission(req.user, 'order.refund'), 403, 'PERMISSION_DENIED', 'Permission required: order.refund');
    const patch: Record<string, unknown> = {};
    if (input.status) patch.status = input.status;
    if (input.paymentStatus) patch.paymentStatus = input.paymentStatus;
    const updated = await commerce.updateOrder(order!.id, patch, { at: new Date().toISOString(), status: input.status || input.paymentStatus || 'updated', note: input.note, actorId: req.user!.id });
    if (input.paymentStatus === 'paid') { await commerce.markInvoicePaid(order!.id); await notify(order!.userId, 'Payment received', `We have received payment for booking ${order!.orderNumber}.`); }
    if (input.status === 'confirmed') await notify(order!.userId, 'Booking confirmed', `Your booking ${order!.orderNumber} is confirmed.`);
    await store.audit('order.updated', { ...clientMeta(req), userId: req.user!.id, metadata: { orderId: order!.id, ...patch } });
    res.json({ order: updated });
  });

  /* Admin-driven manual fulfilment (eSIM activation details, provider payloads,
     physical dispatch). Requires an order.update permission and writes an audit
     entry with the fulfilment payload reference. */
  app.post('/api/v1/admin/orders/:id/fulfill', requireFinePermission(store, 'order.update'), async (req, res) => {
    const input = toInput(z.object({
      provider: z.string().max(160).optional(),
      activationCode: z.string().max(300).optional(), instructions: z.string().max(4000).optional(),
      reference: z.string().max(200).optional(), note: z.string().max(1000).optional()
    }).strict(), req.body);
    const order = await commerce.findOrder(String(req.params.id));
    assert(order, 404, 'ORDER_NOT_FOUND', 'Order not found');
    const payload: Record<string, unknown> = { provider: input.provider, qrCodeUrl: input.qrCodeUrl, smDpPlus: input.smDpPlus, activationCode: input.activationCode, instructions: input.instructions, reference: input.reference, note: input.note };
    const updated = await commerce.markOrderFulfilled(order!.id, payload, req.user!.id);
    await notify(order!.userId, 'Your order is fulfilled', `Booking ${order!.orderNumber} has been fulfilled. Check your account for delivery details.`);
    await store.audit('order.fulfilled', { ...clientMeta(req), userId: req.user!.id, metadata: { orderId: order!.id, payloadKeys: Object.keys(payload).filter(key => Boolean(payload[key])) } });
    res.json({ order: updated });
  });

  /* =======================================================  ADMIN: REVIEWS  */
  app.get('/api/v1/admin/reviews', requireFinePermission(store, 'review.view'), async (req, res) => {
    const query = req.query as Record<string, string>;
    res.json(await commerce.listReviews({ status: query.status || 'all', q: query.q, page: Number(query.page) || 1, pageSize: Number(query.pageSize) || 20 }));
  });
  app.patch('/api/v1/admin/reviews/:id', requireFinePermission(store, 'review.moderate'), async (req, res) => {
    const input = toInput(z.object({ status: z.enum(['pending', 'approved', 'rejected']).optional(), adminReply: z.string().max(2000).optional() }).strict(), req.body);
    const review = await commerce.updateReview(String(req.params.id), input as any);
    assert(review, 404, 'REVIEW_NOT_FOUND', 'Review not found');
    await commerce.refreshProductRating(review!.productType, review!.productId);
    await store.audit('review.moderated', { ...clientMeta(req), userId: req.user!.id, metadata: { reviewId: review!.id, status: review!.status } });
    res.json({ review });
  });
  app.delete('/api/v1/admin/reviews/:id', requireFinePermission(store, 'review.delete'), async (req, res) => {
    const removed = await commerce.deleteReview(String(req.params.id));
    assert(removed, 404, 'REVIEW_NOT_FOUND', 'Review not found');
    await store.audit('review.deleted', { ...clientMeta(req), userId: req.user!.id, metadata: { reviewId: req.params.id } });
    res.json({ removed: true });
  });

  /* Public storefront summary used by the homepage to render every section in one round trip. */
  app.get('/api/v1/storefront/home', optionalAuth(store), async (_req, res) => {
    const types: CatalogType[] = ['holiday_package', 'home', 'destination'];
    const sections = await Promise.all(types.map(async type => ({ type, products: (await commerce.listCatalog({ type, status: 'published', pageSize: 6, sort: 'recommended' })).products })));
    res.setHeader('Cache-Control', 'no-store');
    res.json({ sections: sections.filter(section => section.products.length > 0) });
  });
}
