import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { pinoHttp } from 'pino-http';
import { randomInt, randomUUID } from 'node:crypto';
import path from 'node:path';
import { z, ZodError } from 'zod';
import { config } from './config.js';
import { AppError, assert } from './errors.js';
import { CONTENT_TYPES, createStore, type ContentType, type ContentInput, type ContentPatch, type Store, type UserStatus } from './store.js';
import { hashOtp, issueSession, normalizeIdentity, setAuthCookies, clearAuthCookies, verifyOtpHash, verifyToken, REFRESH_COOKIE } from './security.js';
import { TravelProvider, MessagingProvider, PaymentProvider, type Vertical } from './providers.js';
import { csrfProtection, issueCsrfToken, optionalAuth, requireAuth, requireAdmin, requireSuperAdmin, notFound, requestContext } from './middleware.js';
import { rateLimit } from './rate-limit.js';
import { deleteImage, uploadImage } from './storage.js';

const verticalSchema = z.enum(['flight', 'hotel', 'home', 'visa', 'esim', 'tour']);
const statusSchema = z.enum(['draft', 'published', 'archived']);
const contentTypeSchema = z.enum(CONTENT_TYPES);
const url = z.string().trim().max(1000).refine(value => !value || value.startsWith('/') || /^https:\/\//i.test(value), 'Enter a valid HTTPS or site-relative URL');
const contentBaseSchema = z.object({
  type: contentTypeSchema,
  slug: z.string().trim().min(2).max(160).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase words separated by hyphens'),
  title: z.string().trim().min(1).max(180),
  excerpt: z.string().trim().max(600).default(''),
  description: z.string().trim().max(12_000).default(''),
  imageUrl: url.default(''),
  gallery: z.array(url).max(12).default([]),
  price: z.number().nonnegative().max(100_000_000).optional(),
  currency: z.string().trim().length(3).default('BDT'),
  location: z.string().trim().max(160).default(''),
  tags: z.array(z.string().trim().min(1).max(50)).max(30).default([]),
  ctaLabel: z.string().trim().max(60).default(''),
  ctaUrl: url.default(''),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  status: statusSchema.default('draft'),
  featured: z.boolean().default(false),
  sortOrder: z.number().int().min(-100_000).max(100_000).default(0),
  data: z.record(z.unknown()).default({})
});
const contentInputSchema = contentBaseSchema.superRefine((item, ctx) => {
  if (item.startDate && item.endDate && new Date(item.startDate) > new Date(item.endDate)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endDate'], message: 'End date must be after the start date' });
});
const contentPatchSchema = contentBaseSchema.omit({ type: true }).partial();
const identityRequest = z.object({ identity: z.string().min(3).max(160), fullName: z.string().trim().min(2).max(100).optional() });
const verifyOtpRequest = z.object({ challengeId: z.string().uuid(), code: z.string().regex(/^\d{6}$/, 'OTP must be a 6 digit code') });
const bookingRequest = z.object({ vertical: verticalSchema, payload: z.record(z.unknown()).refine(value => JSON.stringify(value).length <= 60_000, 'Booking request is too large') });
const paymentRequest = z.object({ bookingId: z.string().uuid() });
const supportRequest = z.object({ name: z.string().trim().min(2).max(120), mobile: z.string().trim().min(7).max(30), email: z.string().email().max(160), subject: z.string().trim().min(2).max(180), message: z.string().trim().min(10).max(5000) });
const profileRequest = z.object({ fullName: z.string().trim().min(2).max(100) });
const userPatchRequest = z.object({ status: z.enum(['active', 'blocked', 'pending']).optional(), role: z.enum(['customer', 'manager', 'admin']).optional(), fullName: z.string().trim().min(2).max(100).optional() }).refine(value => Object.keys(value).length > 0, 'Choose a field to update');
const userBulkRequest = z.object({ userIds: z.array(z.string().uuid()).min(1).max(100), status: z.enum(['active', 'blocked', 'pending']).optional(), role: z.enum(['customer', 'manager', 'admin']).optional() }).refine(value => value.status || value.role, 'Choose a status or role');
const userAllUpdateRequest = z.object({ q: z.string().trim().max(160).optional(), filterStatus: z.enum(['active', 'blocked', 'pending']).optional(), status: z.enum(['active', 'blocked', 'pending']).optional(), role: z.enum(['customer', 'manager', 'admin']).optional() }).refine(value => value.status || value.role, 'Choose a status or role');
const templateInput = z.object({ name: z.string().trim().min(2).max(120), subject: z.string().trim().min(2).max(180), body: z.string().trim().min(2).max(6000), status: z.enum(['active', 'archived']).default('active') });
const sendMessageInput = z.object({ templateId: z.string().uuid().optional(), subject: z.string().trim().min(2).max(180).optional(), message: z.string().trim().min(2).max(6000).optional(), campaignId: z.string().uuid().optional(), userIds: z.array(z.string().uuid()).max(2000).default([]), allUsers: z.boolean().default(false), channels: z.array(z.enum(['in_app', 'sms', 'email'])).min(1).default(['in_app']) }).refine(value => value.allUsers || value.userIds.length > 0, 'Choose at least one recipient').refine(value => value.templateId || (value.subject && value.message), 'Choose a template or enter a message');
const mediaInput = z.object({ dataUrl: z.string().min(100).max(28_000_000), fileName: z.string().trim().max(120).optional() });
const reorderInput = z.object({ type: contentTypeSchema, ids: z.array(z.string().uuid()).min(1).max(100) });

const toInput = <T>(schema: z.ZodType<T>, value: unknown): T => {
  try { return schema.parse(value); } catch (error) { if (error instanceof ZodError) throw new AppError(400, 'VALIDATION_ERROR', 'Please check the submitted fields', error.flatten()); throw error; }
};
const clientMeta = (req: Request) => ({ ip: req.ip, userAgent: req.get('user-agent')?.slice(0, 500) });
const intQuery = (value: unknown, fallback: number, max: number) => { const parsed = Number(value); return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback; };
const validStatus = (value: unknown) => value === 'draft' || value === 'published' || value === 'archived' ? value : undefined;

function cleanData(value: Record<string, unknown>) {
  const visit = (item: unknown, depth = 0): unknown => {
    assert(depth < 8, 400, 'INVALID_CONTENT_DATA', 'Content data is nested too deeply');
    if (Array.isArray(item)) return item.slice(0, 100).map(child => visit(child, depth + 1));
    if (item && typeof item === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(item as Record<string, unknown>)) {
        assert(!['__proto__', 'prototype', 'constructor'].includes(key), 400, 'INVALID_CONTENT_DATA', 'Invalid content data key');
        out[key.slice(0, 80)] = visit(child, depth + 1);
      }
      return out;
    }
    assert(['string', 'number', 'boolean'].includes(typeof item) || item === null, 400, 'INVALID_CONTENT_DATA', 'Content data must be JSON-safe');
    return typeof item === 'string' ? item.slice(0, 5000) : item;
  };
  const result = visit(value) as Record<string, unknown>;
  assert(JSON.stringify(result).length <= 50_000, 400, 'INVALID_CONTENT_DATA', 'Content data is too large');
  return result;
}

async function verifiedOtp(store: Store, challengeId: string, code: string) {
  const challenge = await store.findOtp(challengeId);
  assert(challenge, 404, 'OTP_NOT_FOUND', 'This verification code is no longer available');
  assert(!challenge.consumedAt, 400, 'OTP_USED', 'This verification code has already been used');
  assert(new Date(challenge.expiresAt) > new Date(), 400, 'OTP_EXPIRED', 'This verification code has expired');
  assert(challenge.attempts < challenge.maxAttempts, 429, 'OTP_LOCKED', 'Too many incorrect attempts');
  const valid = await verifyOtpHash(code, challenge.codeHash);
  if (!valid) {
    const updated = await store.incrementOtpAttempts(challenge.id);
    const remaining = Math.max(0, (updated?.maxAttempts || challenge.maxAttempts) - (updated?.attempts || challenge.attempts + 1));
    throw new AppError(400, 'OTP_INVALID', remaining ? `Incorrect code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.` : 'Too many incorrect attempts');
  }
  await store.consumeOtp(challenge.id);
  return challenge;
}

async function activeUsers(store: Store) {
  const first = await store.listUsers({ status: 'active', page: 1, limit: 100 });
  const users = [...first.items];
  for (let page = 2; (page - 1) * first.limit < first.total; page += 1) users.push(...(await store.listUsers({ status: 'active', page, limit: 100 })).items);
  return users;
}

function messageFor(template: { subject: string; body: string }, user: { fullName?: string }) {
  const name = user.fullName?.trim() || 'Customer';
  return { subject: template.subject.replace(/{{\s*name\s*}}/gi, name), body: template.body.replace(/{{\s*name\s*}}/gi, name) };
}

export function buildApp() {
  const { store, connection } = createStore();
  const travel = new TravelProvider();
  const messaging = new MessagingProvider();
  const payment = new PaymentProvider();
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use(pinoHttp({ level: config.logLevel, redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'] }));
  app.use(requestContext());
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' }, contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], imgSrc: ["'self'", 'https:', 'data:'], connectSrc: ["'self'"], fontSrc: ["'self'", 'data:'], objectSrc: ["'none'"], baseUri: ["'self'"], frameAncestors: ["'self'"] } } }));
  app.use(cors({ origin: (origin, callback) => { if (!origin || config.corsOrigins.includes(origin)) callback(null, true); else callback(new AppError(403, 'CORS_DENIED', 'Origin is not allowed')); }, credentials: true, methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID', 'X-CSRF-Token'] }));
  app.use(express.json({ limit: '28mb', verify: (req, _res, buffer) => { (req as Request).rawBody = Buffer.from(buffer); } }));
  app.use(cookieParser());
  app.use(csrfProtection());
  app.use(rateLimit('global', 300, 60));

  app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'sadik-travels-api' }));
  app.get('/readyz', async (_req, res) => { const healthy = await store.health(); assert(healthy, 503, 'NOT_READY', 'Service dependencies are not ready'); res.json({ ok: true, database: config.dataMode }); });
  app.get('/api/v1/auth/csrf', (req, res) => res.json({ csrfToken: issueCsrfToken(req, res) }));

  app.post('/api/v1/auth/request-otp', rateLimit('otp', 5, 300), async (req, res) => {
    const input = toInput(identityRequest, req.body);
    const normalized = normalizeIdentity(input.identity);
    const recent = await store.countRecentOtpRequests(normalized.identity, new Date(Date.now() - 60_000));
    assert(recent < 3, 429, 'OTP_THROTTLED', 'Please wait before requesting another code');
    const code = String(randomInt(100000, 1_000_000)); const challengeId = randomUUID();
    await store.createOtp({ id: challengeId, identity: normalized.identity, channel: normalized.channel, purpose: 'login', codeHash: await hashOtp(code), attempts: 0, maxAttempts: 5, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), requestIp: req.ip });
    const delivery = await messaging.sendOtp(normalized.channel, normalized.identity, code);
    await store.audit('auth.otp_requested', { ...clientMeta(req), metadata: { channel: normalized.channel } });
    res.status(202).json({ challengeId, channel: normalized.channel, maskedDestination: normalized.channel === 'sms' ? `${normalized.identity.slice(0, 7)}••••` : `${normalized.identity.slice(0, 2)}•••${normalized.identity.slice(normalized.identity.indexOf('@'))}`, expiresIn: 300, ...(delivery.devCode && !config.isProduction ? { devCode: delivery.devCode } : {}) });
  });
  app.post('/api/v1/auth/verify-otp', rateLimit('otp-verify', 15, 300), async (req, res) => {
    const input = toInput(verifyOtpRequest, req.body); const challenge = await verifiedOtp(store, input.challengeId, input.code);
    assert(challenge.purpose === 'login', 400, 'OTP_PURPOSE_INVALID', 'This verification code is not for login');
    const isConfiguredAdmin = config.adminIdentities.includes(challenge.identity);
    let user = await store.findUserByIdentity(challenge.identity);
    if (!user) user = await store.createUser({ identity: challenge.identity, channel: challenge.channel, role: isConfiguredAdmin ? 'admin' : 'customer' });
    else if (isConfiguredAdmin && user.role !== 'admin') user = (await store.setUserRole(user.id, 'admin')) || user;
    const session = await issueSession(store, user, clientMeta(req)); setAuthCookies(res, session.accessToken, session.refreshToken);
    await store.audit('auth.login', { ...clientMeta(req), userId: user.id, metadata: { channel: challenge.channel } });
    res.json({ accessToken: session.accessToken, expiresIn: config.accessTokenTtl, user });
  });
  app.post('/api/v1/auth/refresh', rateLimit('refresh', 30, 60), async (req, res) => {
    const token = req.cookies?.[REFRESH_COOKIE] as string | undefined; assert(token, 401, 'AUTH_REQUIRED', 'Refresh login is required');
    const claims = await verifyToken(token, 'refresh'); const existing = await store.findSessionByRefreshJti(claims.jti);
    assert(existing && existing.id === claims.sid && existing.userId === claims.sub && !existing.revokedAt && new Date(existing.expiresAt) > new Date(), 401, 'SESSION_INVALID', 'Your session has expired. Please login again.');
    const user = await store.findUserById(existing.userId); assert(user && user.status === 'active', 403, 'ACCOUNT_UNAVAILABLE', 'This account is not available');
    await store.revokeSession(existing.id); const next = await issueSession(store, user, clientMeta(req)); setAuthCookies(res, next.accessToken, next.refreshToken);
    res.json({ accessToken: next.accessToken, expiresIn: config.accessTokenTtl, user });
  });
  app.post('/api/v1/auth/logout', async (req, res) => { const token = req.cookies?.[REFRESH_COOKIE] as string | undefined; if (token) { try { await store.revokeSession((await verifyToken(token, 'refresh')).sid); } catch { /* Always clear browser state. */ } } clearAuthCookies(res); res.status(204).send(); });
  app.get('/api/v1/auth/me', requireAuth(store), (req, res) => res.json({ user: req.user }));

  app.patch('/api/v1/profile', requireAuth(store), async (req, res) => { const input = toInput(profileRequest, req.body); const user = await store.updateUser(req.user!.id, input); assert(user, 404, 'USER_NOT_FOUND', 'User not found'); await store.audit('profile.updated', { ...clientMeta(req), userId: user.id }); res.json({ user }); });
  app.post('/api/v1/profile/request-identity-change', requireAuth(store), rateLimit('identity-change', 3, 300), async (req, res) => {
    const input = toInput(identityRequest.pick({ identity: true }), req.body); const normalized = normalizeIdentity(input.identity);
    const existing = await store.findUserByIdentity(normalized.identity); assert(!existing || existing.id === req.user!.id, 409, 'IDENTITY_IN_USE', 'That email or mobile number is already in use');
    const code = String(randomInt(100000, 1_000_000)); const challengeId = randomUUID();
    await store.createOtp({ id: challengeId, identity: normalized.identity, channel: normalized.channel, purpose: 'identity-change', userId: req.user!.id, codeHash: await hashOtp(code), attempts: 0, maxAttempts: 5, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), requestIp: req.ip });
    const delivery = await messaging.sendOtp(normalized.channel, normalized.identity, code);
    res.status(202).json({ challengeId, channel: normalized.channel, expiresIn: 300, ...(delivery.devCode && !config.isProduction ? { devCode: delivery.devCode } : {}) });
  });
  app.post('/api/v1/profile/verify-identity-change', requireAuth(store), rateLimit('identity-change-verify', 10, 300), async (req, res) => {
    const input = toInput(verifyOtpRequest, req.body); const challenge = await verifiedOtp(store, input.challengeId, input.code);
    assert(challenge.purpose === 'identity-change' && challenge.userId === req.user!.id, 403, 'OTP_PURPOSE_INVALID', 'This verification code cannot update this profile');
    const existing = await store.findUserByIdentity(challenge.identity); assert(!existing || existing.id === req.user!.id, 409, 'IDENTITY_IN_USE', 'That email or mobile number is already in use');
    const user = await store.updateUser(req.user!.id, challenge.channel === 'email' ? { email: challenge.identity } : { phone: challenge.identity });
    assert(user, 404, 'USER_NOT_FOUND', 'User not found'); await store.audit('profile.identity_updated', { ...clientMeta(req), userId: user.id, metadata: { channel: challenge.channel } }); res.json({ user });
  });

  app.get('/api/v1/notifications', requireAuth(store), async (req, res) => { const notifications = await store.listNotifications(req.user!.id); res.json({ notifications, unread: notifications.filter(item => !item.readAt).length }); });
  app.patch('/api/v1/notifications/:id/read', requireAuth(store), async (req, res) => { const notification = await store.markNotificationRead(String(req.params.id), req.user!.id); assert(notification, 404, 'NOTIFICATION_NOT_FOUND', 'Notification not found'); res.json({ notification }); });

  // Database-backed public CMS. Only active, published content is ever exposed here.
  app.get('/api/v1/content/:type', rateLimit('content', 180, 60), async (req, res) => {
    const type = toInput(contentTypeSchema, req.params.type); const result = await store.listContent({ type, q: req.query.q ? String(req.query.q).slice(0, 160) : undefined, featured: req.query.featured === 'true' ? true : undefined, page: intQuery(req.query.page, 1, 100000), limit: intQuery(req.query.limit, 24, 100) }, true); res.json(result);
  });
  app.get('/api/v1/content/:type/:idOrSlug', rateLimit('content-detail', 180, 60), async (req, res) => { const type = toInput(contentTypeSchema, req.params.type); const item = await store.findContent(String(req.params.idOrSlug), type); assert(item && item.status === 'published' && (!item.startDate || new Date(item.startDate) <= new Date()) && (!item.endDate || new Date(item.endDate) >= new Date()), 404, 'CONTENT_NOT_FOUND', 'The requested content is not available'); res.json({ item }); });
  app.get('/api/v1/home', rateLimit('homepage', 120, 60), async (_req, res) => {
    const types: ContentType[] = ['banner', 'campaign', 'umrah-package', 'holiday-package', 'special-umrah-fare', 'travel-agent', 'promotional', 'setting', 'contact', 'navigation'];
    const rows = await Promise.all(types.map(type => store.listContent({ type, featured: ['umrah-package', 'holiday-package', 'travel-agent'].includes(type) ? true : undefined, limit: type === 'setting' || type === 'contact' ? 10 : 12 }, true)));
    res.json(Object.fromEntries(rows.map((row, i) => [types[i], row.items])));
  });
  // Compatibility endpoints now read real CMS entries rather than static tour data.
  app.get('/api/v1/tours', async (req, res) => { const result = await store.listContent({ type: 'go-get-tour', q: req.query.q ? String(req.query.q) : undefined, page: intQuery(req.query.page, 1, 100000), limit: intQuery(req.query.limit, 24, 100) }, true); res.json({ success: true, count: result.total, tours: result.items }); });
  app.get('/api/v1/tours/:idOrSlug', async (req, res) => { const item = await store.findContent(String(req.params.idOrSlug), 'go-get-tour'); assert(item?.status === 'published', 404, 'TOUR_NOT_FOUND', 'Tour package not found'); res.json({ tour: item }); });
  app.get('/api/v1/agents', async (req, res) => { const result = await store.listContent({ type: 'travel-agent', q: req.query.q ? String(req.query.q) : undefined, page: intQuery(req.query.page, 1, 100000), limit: intQuery(req.query.limit, 24, 100) }, true); res.json(result); });
  app.get('/api/v1/agents/:idOrSlug', async (req, res) => { const item = await store.findContent(String(req.params.idOrSlug), 'travel-agent'); assert(item?.status === 'published', 404, 'AGENT_NOT_FOUND', 'Travel agent not found'); res.json({ agent: item }); });

  app.post('/api/v1/search/:vertical', rateLimit('search', 90, 60), optionalAuth(store), async (req, res) => { const vertical = toInput(verticalSchema, req.params.vertical) as Vertical; const payload = toInput(z.record(z.unknown()).refine(value => JSON.stringify(value).length <= 60_000, 'Search request is too large'), req.body); const result = await travel.search(vertical, payload); await store.audit('search.requested', { ...clientMeta(req), userId: req.user?.id, metadata: { vertical, keys: Object.keys(payload) } }); res.json({ success: true, vertical, ...(result as Record<string, unknown>) }); });
  app.post('/api/v1/bookings', requireAuth(store), async (req, res) => {
    const input = toInput(bookingRequest, req.body); const booking = await store.createBooking({ userId: req.user!.id, vertical: input.vertical, request: input.payload });
    try { const response: any = await travel.reserve(input.vertical, { ...input.payload, bookingId: booking.id, customerId: req.user!.id }); const amount = Number(response?.quotedAmount ?? response?.amount ?? response?.total?.amount); const currency = String(response?.quotedCurrency ?? response?.currency ?? response?.total?.currency ?? 'BDT').toUpperCase(); const updated = await store.updateBooking(booking.id, { status: response?.status === 'confirmed' ? 'confirmed' : 'pending', providerRef: response?.providerRef, ...(Number.isFinite(amount) && amount > 0 ? { quotedAmount: amount, quotedCurrency: currency } : {}), response }); await store.audit('booking.created', { ...clientMeta(req), userId: req.user!.id, metadata: { bookingId: booking.id, vertical: input.vertical } }); res.status(201).json({ booking: updated || booking }); } catch (error) { await store.updateBooking(booking.id, { status: 'failed', response: { error: 'provider_failure' } }); throw error; }
  });
  app.get('/api/v1/bookings', requireAuth(store), async (req, res) => res.json({ bookings: await store.listBookings(req.user!.id) }));
  app.get('/api/v1/bookings/:id', requireAuth(store), async (req, res) => { const booking = await store.findBooking(String(req.params.id), req.user!.id); assert(booking, 404, 'BOOKING_NOT_FOUND', 'Booking not found'); res.json({ booking }); });
  app.post('/api/v1/bookings/:id/cancel', requireAuth(store), async (req, res) => { const booking = await store.findBooking(String(req.params.id), req.user!.id); assert(booking, 404, 'BOOKING_NOT_FOUND', 'Booking not found'); assert(!['cancelled', 'failed'].includes(booking.status), 409, 'BOOKING_NOT_CANCELLABLE', 'This booking cannot be cancelled'); const result = await travel.cancel(booking.vertical, { bookingId: booking.id, providerRef: booking.providerRef, reason: typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 1000) : undefined }); const updated = await store.updateBooking(booking.id, { status: 'cancelled', response: result }); res.json({ booking: updated || booking }); });
  app.post('/api/v1/payments/intents', requireAuth(store), async (req, res) => { const input = toInput(paymentRequest, req.body); const booking = await store.findBooking(input.bookingId, req.user!.id); assert(booking, 404, 'BOOKING_NOT_FOUND', 'Booking not found'); assert(booking.status !== 'cancelled', 409, 'BOOKING_CANCELLED', 'Cannot pay for a cancelled booking'); assert(booking.quotedAmount && booking.quotedCurrency, 409, 'BOOKING_NOT_QUOTED', 'This booking has no verified provider quote'); const paymentRecord = await store.createPayment({ bookingId: booking.id, userId: req.user!.id, provider: 'configured', amount: booking.quotedAmount, currency: booking.quotedCurrency }); const response: any = await payment.createIntent({ paymentId: paymentRecord.id, bookingId: booking.id, amount: booking.quotedAmount, currency: booking.quotedCurrency, customerId: req.user!.id, returnUrl: `${config.appOrigin}/payment/return` }); const updated = await store.updatePayment(paymentRecord.id, { status: response?.status === 'paid' ? 'paid' : 'pending', transactionRef: response?.transactionRef, providerPayload: response }); res.status(201).json({ payment: updated || paymentRecord, checkoutUrl: response?.checkoutUrl }); });
  app.post('/api/v1/payments/webhook', async (req, res) => { assert(payment.verifyWebhook(req.rawBody || Buffer.from(JSON.stringify(req.body || {})), req.header('x-payment-signature')), 401, 'INVALID_WEBHOOK', 'Invalid payment webhook signature'); const payload = req.body as { paymentId?: string; status?: string; transactionRef?: string }; assert(payload.paymentId && payload.status, 400, 'INVALID_WEBHOOK', 'Payment webhook payload is incomplete'); const status = ['paid', 'refunded', 'failed'].includes(payload.status) ? payload.status as 'paid' | 'refunded' | 'failed' : 'pending'; const updated = await store.updatePayment(payload.paymentId, { status, transactionRef: payload.transactionRef, providerPayload: payload }); assert(updated, 404, 'PAYMENT_NOT_FOUND', 'Payment not found'); if (status === 'paid') await store.updateBooking(updated.bookingId, { status: 'confirmed' }); res.json({ received: true }); });
  app.post('/api/v1/support/tickets', optionalAuth(store), rateLimit('support', 20, 60), async (req, res) => { const input = toInput(supportRequest, req.body); const ticket = await store.createSupportTicket({ ...input, userId: req.user?.id }); await store.audit('support.ticket_created', { ...clientMeta(req), userId: req.user?.id, metadata: { ticketId: ticket.id } }); res.status(201).json({ ticket: { id: ticket.id, status: ticket.status, createdAt: ticket.createdAt } }); });

  // Admin CMS: every listed content type uses one validated, persistent CRUD surface.
  app.get('/api/v1/admin/me', requireAdmin(store), (req, res) => res.json({ user: req.user, permissions: req.user!.role === 'admin' ? ['cms:*', 'users:*', 'messages:*'] : ['cms:*', 'messages:send'] }));
  app.get('/api/v1/admin/stats', requireAdmin(store), async (_req, res) => res.json({ content: await store.contentStats(), users: (await store.listUsers({ limit: 1 })).total }));
  app.get('/api/v1/admin/content', requireAdmin(store), async (req, res) => { const type = toInput(contentTypeSchema, req.query.type); const result = await store.listContent({ type, status: validStatus(req.query.status), q: req.query.q ? String(req.query.q).slice(0, 160) : undefined, page: intQuery(req.query.page, 1, 100000), limit: intQuery(req.query.limit, 30, 100) }); res.json(result); });
  app.post('/api/v1/admin/content', requireAdmin(store), async (req, res) => { const input = toInput(contentInputSchema, req.body) as z.infer<typeof contentBaseSchema>; const item = await store.createContent({ ...input, currency: input.currency.toUpperCase(), data: cleanData(input.data) } as ContentInput, req.user!.id); await store.audit('cms.created', { ...clientMeta(req), userId: req.user!.id, metadata: { id: item.id, type: item.type } }); res.status(201).json({ item }); });
  app.patch('/api/v1/admin/content/:id', requireAdmin(store), async (req, res) => { const input = toInput(contentPatchSchema, req.body) as Partial<z.infer<typeof contentBaseSchema>>; const patch = { ...input, ...(input.currency ? { currency: input.currency.toUpperCase() } : {}), ...(input.data ? { data: cleanData(input.data) } : {}) } as ContentPatch; const item = await store.updateContent(String(req.params.id), patch, req.user!.id); assert(item, 404, 'CONTENT_NOT_FOUND', 'Content item not found'); await store.audit('cms.updated', { ...clientMeta(req), userId: req.user!.id, metadata: { id: item.id, type: item.type } }); res.json({ item }); });
  app.post('/api/v1/admin/content/:id/archive', requireAdmin(store), async (req, res) => { const item = await store.updateContent(String(req.params.id), { status: 'archived' }, req.user!.id); assert(item, 404, 'CONTENT_NOT_FOUND', 'Content item not found'); await store.audit('cms.archived', { ...clientMeta(req), userId: req.user!.id, metadata: { id: item.id, type: item.type } }); res.json({ item }); });
  app.delete('/api/v1/admin/content/:id', requireAdmin(store), requireSuperAdmin, async (req, res) => { const item = await store.findContent(String(req.params.id)); assert(item, 404, 'CONTENT_NOT_FOUND', 'Content item not found'); const removed = await store.deleteContent(item.id); assert(removed, 404, 'CONTENT_NOT_FOUND', 'Content item not found'); await store.audit('cms.deleted', { ...clientMeta(req), userId: req.user!.id, metadata: { id: item.id, type: item.type } }); res.status(204).send(); });
  app.post('/api/v1/admin/content/:id/publish', requireAdmin(store), async (req, res) => { const item = await store.updateContent(String(req.params.id), { status: 'published' }, req.user!.id); assert(item, 404, 'CONTENT_NOT_FOUND', 'Content item not found'); res.json({ item }); });
  app.post('/api/v1/admin/content/:id/unpublish', requireAdmin(store), async (req, res) => { const item = await store.updateContent(String(req.params.id), { status: 'draft' }, req.user!.id); assert(item, 404, 'CONTENT_NOT_FOUND', 'Content item not found'); res.json({ item }); });
  app.post('/api/v1/admin/content/:id/restore', requireAdmin(store), async (req, res) => { const item = await store.updateContent(String(req.params.id), { status: 'draft' }, req.user!.id); assert(item, 404, 'CONTENT_NOT_FOUND', 'Content item not found'); res.json({ item }); });
  app.post('/api/v1/admin/content/reorder', requireAdmin(store), async (req, res) => { const input = toInput(reorderInput, req.body); for (const [index, id] of input.ids.entries()) { const item = await store.findContent(id); assert(item?.type === input.type, 400, 'INVALID_REORDER', 'All selected items must be in the same section'); await store.updateContent(id, { sortOrder: index }, req.user!.id); } res.status(204).send(); });
  app.post('/api/v1/admin/media', requireAdmin(store), rateLimit('media-upload', 20, 300), async (req, res) => { const input = toInput(mediaInput, req.body); const media = await uploadImage(input.dataUrl, input.fileName); await store.audit('media.uploaded', { ...clientMeta(req), userId: req.user!.id, metadata: { publicId: media.publicId } }); res.status(201).json({ media }); });
  app.delete('/api/v1/admin/media', requireAdmin(store), async (req, res) => { await deleteImage(String(req.query.publicId || '')); await store.audit('media.deleted', { ...clientMeta(req), userId: req.user!.id }); res.status(204).send(); });

  app.get('/api/v1/admin/users', requireAdmin(store), async (req, res) => { const status = ['active', 'blocked', 'pending'].includes(String(req.query.status)) ? req.query.status as UserStatus : undefined; res.json(await store.listUsers({ status, q: req.query.q ? String(req.query.q).slice(0, 160) : undefined, page: intQuery(req.query.page, 1, 100000), limit: intQuery(req.query.limit, 30, 100) })); });
  app.patch('/api/v1/admin/users/:id', requireAdmin(store), requireSuperAdmin, async (req, res) => { const input = toInput(userPatchRequest, req.body); if (String(req.params.id) === req.user!.id && input.status && input.status !== 'active') throw new AppError(409, 'SELF_PROTECTION', 'You cannot block or suspend your own account'); const user = await store.updateUser(String(req.params.id), input); assert(user, 404, 'USER_NOT_FOUND', 'User not found'); await store.audit('user.updated', { ...clientMeta(req), userId: req.user!.id, metadata: { target: user.id } }); res.json({ user }); });
  app.post('/api/v1/admin/users/bulk', requireAdmin(store), requireSuperAdmin, async (req, res) => { const input = toInput(userBulkRequest, req.body); assert(!input.userIds.includes(req.user!.id) || !input.status || input.status === 'active', 409, 'SELF_PROTECTION', 'You cannot block or suspend your own account'); const users = await Promise.all(input.userIds.map(id => store.updateUser(id, { ...(input.status ? { status: input.status } : {}), ...(input.role ? { role: input.role } : {}) }))); res.json({ updated: users.filter(Boolean).length }); });
  app.post('/api/v1/admin/users/update-all', requireAdmin(store), requireSuperAdmin, async (req, res) => { const input = toInput(userAllUpdateRequest, req.body); const first = await store.listUsers({ q: input.q, status: input.filterStatus, page: 1, limit: 100 }); const users = [...first.items]; for (let page = 2; (page - 1) * first.limit < first.total; page += 1) users.push(...(await store.listUsers({ q: input.q, status: input.filterStatus, page, limit: 100 })).items); assert(!users.some(user => user.id === req.user!.id && ((input.status && input.status !== 'active') || (input.role && input.role !== req.user!.role))), 409, 'SELF_PROTECTION', 'Your own account cannot be blocked, suspended, or have its role changed in a select-all action'); const updated = await Promise.all(users.map(user => store.updateUser(user.id, { ...(input.status ? { status: input.status } : {}), ...(input.role ? { role: input.role } : {}) }))); await store.audit('users.bulk_updated', { ...clientMeta(req), userId: req.user!.id, metadata: { count: updated.filter(Boolean).length } }); res.json({ updated: updated.filter(Boolean).length }); });

  app.get('/api/v1/admin/message-templates', requireAdmin(store), async (req, res) => res.json({ templates: await store.listTemplates(req.query.status === 'archived' ? 'archived' : undefined) }));
  app.post('/api/v1/admin/message-templates', requireAdmin(store), async (req, res) => { const input = toInput(templateInput, req.body) as z.infer<typeof templateInput>; const template = await store.createTemplate({ ...input, createdBy: req.user!.id }); res.status(201).json({ template }); });
  app.patch('/api/v1/admin/message-templates/:id', requireAdmin(store), async (req, res) => { const input = toInput(templateInput.partial(), req.body); const template = await store.updateTemplate(String(req.params.id), input); assert(template, 404, 'TEMPLATE_NOT_FOUND', 'Message template not found'); res.json({ template }); });
  app.delete('/api/v1/admin/message-templates/:id', requireAdmin(store), async (req, res) => { const template = await store.updateTemplate(String(req.params.id), { status: 'archived' }); assert(template, 404, 'TEMPLATE_NOT_FOUND', 'Message template not found'); res.json({ template }); });
  app.get('/api/v1/admin/deliveries', requireAdmin(store), async (req, res) => res.json({ deliveries: await store.listDeliveries(intQuery(req.query.limit, 100, 100)) }));
  app.post('/api/v1/admin/messages/send', requireAdmin(store), rateLimit('admin-message', 20, 300), async (req, res) => {
    const input = toInput(sendMessageInput, req.body) as z.infer<typeof sendMessageInput>; const template = input.templateId ? await store.findTemplate(input.templateId) : undefined; assert(!input.templateId || template?.status === 'active', 404, 'TEMPLATE_NOT_FOUND', 'Message template not found'); const base = template || { subject: input.subject!, body: input.message! };
    const recipients = input.allUsers ? await activeUsers(store) : (await Promise.all(input.userIds.map(id => store.findUserById(id)))).filter((user): user is NonNullable<typeof user> => Boolean(user && user.status === 'active'));
    assert(recipients.length > 0, 404, 'RECIPIENT_NOT_FOUND', 'No active recipients were found');
    let sent = 0; let failed = 0;
    for (const recipient of recipients) {
      const delivery = await store.createDelivery({ templateId: template?.id, campaignId: input.campaignId, userId: recipient.id, channels: input.channels, status: 'queued' }); const item = messageFor(base, recipient); const errors: string[] = [];
      if (input.channels.includes('in_app')) await store.createNotification({ userId: recipient.id, title: item.subject, message: item.body, channels: ['in_app'] });
      if (input.channels.includes('sms')) { if (!recipient.phone) errors.push('No mobile number'); else try { await messaging.sendNotification('sms', recipient.phone, item.subject, item.body); } catch { errors.push('SMS delivery failed'); } }
      if (input.channels.includes('email')) { if (!recipient.email) errors.push('No email address'); else try { await messaging.sendNotification('email', recipient.email, item.subject, item.body); } catch { errors.push('Email delivery failed'); } }
      const status = errors.length === input.channels.filter(channel => channel !== 'in_app').length && !input.channels.includes('in_app') ? 'failed' : errors.length ? 'partial' : 'sent'; await store.updateDelivery(delivery.id, { status, ...(errors.length ? { error: errors.join('; ') } : {}) }); if (status === 'failed') failed++; else sent++;
    }
    await store.audit('admin.message_sent', { ...clientMeta(req), userId: req.user!.id, metadata: { recipients: recipients.length, sent, failed, channels: input.channels } }); res.status(201).json({ recipients: recipients.length, sent, failed });
  });

  if (config.serveStatic) {
    app.get('/admin', (_req, res) => res.sendFile(path.join(config.publicDir, 'admin.html')));
    app.use(express.static(config.publicDir, { index: 'index.html', maxAge: config.isProduction ? '1h' : 0, etag: true }));
    app.get(/^(?!\/api\/|\/healthz$|\/readyz$).*/, (_req, res) => res.sendFile(path.join(config.publicDir, 'index.html')));
  }
  app.use(notFound);
  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    let normalized: AppError;
    if (error instanceof AppError) normalized = error;
    else if (error instanceof ZodError) normalized = new AppError(400, 'VALIDATION_ERROR', 'Please check the submitted fields', error.flatten());
    else if ((error as any)?.code === 11000) normalized = new AppError(409, 'DUPLICATE_VALUE', 'That value is already in use');
    else normalized = new AppError(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
    if ((req as any).log) (req as any).log.error({ err: error, requestId: req.requestId, code: normalized.code }, normalized.message);
    res.status(normalized.statusCode).json({ error: { code: normalized.code, message: normalized.expose ? normalized.message : 'An unexpected error occurred', ...(normalized.expose && normalized.details ? { details: normalized.details } : {}) }, requestId: req.requestId });
  });
  return { app, store, connection };
}
