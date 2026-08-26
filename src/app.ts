import express, { type Request, type Response, type NextFunction } from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import { pinoHttp } from 'pino-http';
import { randomInt, randomUUID } from 'node:crypto';
import path from 'node:path';
import { z, ZodError } from 'zod';
import { config } from './config.js';
import { verifyFirebaseIdToken, firebasePublicConfig, isFirebaseConfigured } from './firebase.js';
import { AppError, assert } from './errors.js';
import { createStore, type Store, type TourFilters, type CreateTour, type UpdateTour, type BookingStatus, type Booking, type ContentType, type ContentStatus } from './store.js';
import { hashOtp, hashPassword, issueSession, normalizeIdentity, setAuthCookies, clearAuthCookies, verifyOtpHash, verifyPassword, verifyToken, REFRESH_COOKIE } from './security.js';
import { computeTourQuote, BD_VAT_PCT, BD_AIT_PCT } from './booking-schema.js';
import { MessagingProvider, PaymentProvider } from './providers.js';
import { optionalAuth, requireAuth, requireAdmin, requireFinePermission, requireInternalOperator, requireSuperAdmin, permissionsFor, notFound, requestContext } from './middleware.js';
import { effectiveFinePermissions, sanitizePermissions, PERMISSION_CATALOG, ALL_FINE_PERMISSIONS, ROLE_PERMISSION_PRESETS } from './permissions.js';
import { rateLimit } from './rate-limit.js';
import { SECRET_MASK } from './secrets.js';
import { MediaService, optimizedMediaUrl } from './media.js';
import { createHotelStore } from './hotel-store.js';
import { registerHotelRoutes } from './hotel-routes.js';
import { createCommerceStore } from './commerce-store.js';
import { registerCommerceRoutes } from './commerce-routes.js';
import { registerAnalyticsRoutes, trackEvent } from './analytics.js';
import { registerPaymentGatewayRoutes } from './payment-gateway-routes.js';
import { ChatRealtimeHub } from './chat/realtime.js';
import { ChatService } from './chat/service.js';
import { createChatStore } from './chat/store.js';
import { registerChatRoutes } from './chat/routes.js';
import { createStoreDirectory } from './chat/directory.js';
import { firebaseChatBridge } from './firebase.js';

const verticalSchema = z.enum(['tour']);
const tourStatusSchema = z.enum(['draft', 'published', 'archived']);
const bookingStatusSchema = z.enum(['new', 'reviewing', 'accepted', 'processing', 'pending', 'confirmed', 'completed', 'rejected', 'cancelled', 'failed']);
const contentTypeSchema = z.enum(['homepage', 'destination', 'hotel', 'home', 'offer', 'banner', 'faq', 'company', 'holiday_package', 'explore']);
const contentStatusSchema = z.enum(['draft', 'published', 'archived']);
const tourInputSchema = z.object({ slug: z.string().trim().min(3).max(160).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), title: z.string().trim().min(3).max(180), country: z.string().trim().min(2).max(80), tourType: z.string().trim().min(2).max(80), destinations: z.array(z.string().trim().min(1).max(80)).min(1).max(20), durationDays: z.number().int().positive().max(60), durationNights: z.number().int().nonnegative().max(59), description: z.string().max(3000).default(''), imageUrl: z.string().max(500).default(''), mediaId: z.string().uuid().optional(), metadata: z.record(z.unknown()).default({}), priceBdt: z.number().nonnegative().max(100000000), status: tourStatusSchema.default('draft'), featured: z.boolean().default(false) });
const tourPatchSchema = tourInputSchema.partial();
const identityRequest = z.object({ identity: z.string().min(3).max(160), fullName: z.string().trim().min(2).max(100).optional(), adminOnly: z.boolean().default(false) });
const verifyOtpRequest = z.object({ challengeId: z.string().uuid(), code: z.string().regex(/^\d{6}$/, 'OTP must be a 6 digit code') });
const isValidIsoDate = (value: string) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [, year, month, day] = match.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};
const bookingRequest = z.object({ vertical: verticalSchema, payload: z.unknown() });
const isoDateSchema = z.string().refine(isValidIsoDate, 'Travel date must be a valid date')
  .refine(value => Date.parse(`${value}T00:00:00Z`) >= Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`), 'Travel date cannot be in the past');
const tourBookingPayload = z.object({ tourId: z.string().uuid(), travellers: z.number().int().min(1).max(30), travelDate: isoDateSchema }).passthrough();
const paymentRequest = z.object({ bookingId: z.string().uuid() });
const supportRequest = z.object({ name: z.string().trim().min(2).max(120), mobile: z.string().trim().min(7).max(30), email: z.string().email(), subject: z.string().trim().min(2).max(180) });
const supportPatchRequest = z.object({ status: z.enum(['open', 'pending', 'in_progress', 'waiting_customer', 'resolved', 'closed']).optional(), priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(), assignedTo: z.string().uuid().nullable().optional() }).strict();
const supportMessageRequest = z.object({ message: z.string().trim().min(1).max(4000), internal: z.boolean().default(false) });
const customerNoteRequest = z.object({ note: z.string().trim().min(1).max(4000) });
const preferencesPatchRequest = z.object({ marketingEmailOptIn: z.boolean().optional(), marketingSmsOptIn: z.boolean().optional(), marketingInAppOptIn: z.boolean().optional() }).strict();
const profilePatchRequest = z.object({ fullName: z.string().trim().min(2).max(120).optional(), avatarUrl: z.string().url().or(z.literal('')).optional(), avatarMediaId: z.string().uuid().nullable().optional(), marketingEmailOptIn: z.boolean().optional(), marketingSmsOptIn: z.boolean().optional(), marketingInAppOptIn: z.boolean().optional() }).strict();
const changePasswordRequest = z.object({ currentPassword: z.string().min(8).max(200), newPassword: z.string().min(12).max(200), confirmPassword: z.string().min(12).max(200) });
const contactOtpRequest = z.object({ target: z.string().min(3).max(160), currentPassword: z.string().min(8).max(200) });
const verifyContactOtpRequest = z.object({ challengeId: z.string().uuid(), code: z.string().regex(/^\d{6}$/) });
const serviceStatusSchema = z.enum(['active', 'hidden', 'maintenance', 'archived']);
const paymentStatusSchema = z.enum(['created', 'pending', 'paid', 'failed', 'refunded', 'partially_refunded']);
const trackBookingRequest = z.object({ bookingReference: z.string().uuid(), identity: z.string().min(3).max(160) });
const notificationRequest = z.object({ userId: z.string().optional(), identity: z.string().optional(), allUsers: z.boolean().default(false), confirmMassSend: z.boolean().default(false), title: z.string().trim().min(2).max(160), message: z.string().trim().min(2).max(4000), channels: z.array(z.enum(['in_app', 'sms', 'email'])).min(1).default(['in_app']) });
const isSafeBrandLogo = (value: string) => { if (!value) return true; if (value.startsWith('/')) return true; try { const url = new URL(value); return url.protocol === 'http:' || url.protocol === 'https:'; } catch { return false; } };
const settingPatchSchema = z.object({ brand_name: z.string().max(120).optional(), brand_logo_url: z.string().max(500).refine(isSafeBrandLogo, 'Logo URL must be an https URL or a local path').optional(), support_email: z.string().email().or(z.literal('')).optional(), support_phone: z.string().max(40).optional(), feature_hotels: z.union([z.boolean(), z.enum(['true','false'])]).optional(), feature_homes: z.union([z.boolean(), z.enum(['true','false'])]).optional(), feature_tours: z.union([z.boolean(), z.enum(['true','false'])]).optional(), payment_provider: z.enum(['sslcommerz', 'bkash']).optional(), payment_webhook_secret: z.string().max(500).optional(), sslcommerz_store_id: z.string().max(160).optional(), sslcommerz_store_password: z.string().max(500).optional(), sslcommerz_api_url: z.string().url().or(z.literal('')).optional(), sslcommerz_validation_url: z.string().url().or(z.literal('')).optional(), sslcommerz_ipn_url: z.string().url().or(z.literal('')).optional(), bkash_base_url: z.string().url().or(z.literal('')).optional(), bkash_app_key: z.string().max(500).optional(), bkash_app_secret: z.string().max(500).optional(), bkash_username: z.string().max(200).optional(), bkash_password: z.string().max(500).optional(), sms_provider: z.enum(['custom_gateway', 'bulksmsbd']).optional(), sms_gateway_url: z.string().url().or(z.literal('')).optional(), sms_gateway_username: z.string().max(200).optional(), sms_gateway_password: z.string().max(500).optional(), sms_api_key: z.string().max(500).optional(), sms_sender_id: z.string().max(120).optional(), smtp_host: z.string().max(200).optional(), smtp_port: z.coerce.number().int().min(1).max(65535).optional(), smtp_user: z.string().max(240).optional(), smtp_password: z.string().max(500).optional(), smtp_from: z.string().email().or(z.literal('')).optional(), }).strict();
const passwordLoginRequest = z.object({ identity: z.string().email(), password: z.string().min(8).max(200) });
const firebaseLoginRequest = z.object({ idToken: z.string().min(20).max(20000) });
const messageTestRequest = z.object({ destination: z.string().min(3).max(240), subject: z.string().max(160).optional(), message: z.string().min(1).max(4000) });
const adminBookingPatchRequest = z.object({ status: bookingStatusSchema.optional(), internalNote: z.string().max(4000).optional(), ownerId: z.string().uuid().nullable().optional(), request: z.record(z.unknown()).optional() }).strict();
const contentInputSchema = z.object({ type: contentTypeSchema, slug: z.string().trim().min(2).max(160).regex(/^[a-z0-9]+(?:-[a-z0-9-]+)*$/), title: z.string().trim().min(2).max(180), subtitle: z.string().max(300).optional(), description: z.string().max(5000).optional(), imageUrl: z.string().max(500).optional(), mediaId: z.string().uuid().optional(), metadata: z.record(z.unknown()).default({}), status: contentStatusSchema.default('draft'), sortOrder: z.number().int().min(-100000).max(100000).default(0) });
const contentPatchSchema = contentInputSchema.partial();
const mediaFolderSchema = z.enum(['banners','tours','hotels','homes','destinations','services','testimonials','logos','general']);
const mediaPatchSchema = z.object({ altText: z.string().max(300).optional(), status: z.enum(['active','archived']).optional() }).strict();
const navigationInputSchema = z.object({ groupName: z.string().trim().min(1).max(80), parentId: z.string().uuid().nullable().optional(), label: z.string().trim().min(1).max(120), route: z.string().regex(/^\/admin(?:[/?].*)?$/), icon: z.string().trim().min(1).max(40), permission: z.string().max(80).optional(), sortOrder: z.number().int().min(-100000).max(100000).default(0), visible: z.boolean().default(true), enabled: z.boolean().default(true) });
const navigationPatchSchema = navigationInputSchema.partial();
const navigationReorderSchema = z.object({ ids: z.array(z.string().uuid()).min(1).max(500) });
const agentInputSchema = z.object({ fullName: z.string().trim().min(2).max(160), agencyName: z.string().max(160).optional(), photoUrl: z.string().url().or(z.literal('')).optional(), photoPublicId: z.string().max(300).optional(), mediaId: z.string().uuid().nullable().optional(), jobTitle: z.string().max(120).optional(), department: z.string().max(120).optional(), phone: z.string().max(40).optional(), whatsapp: z.string().max(40).optional(), email: z.string().email().or(z.literal('')).optional(), officeLocation: z.string().max(200).optional(), city: z.string().max(120).optional(), shortBio: z.string().max(500).optional(), fullDescription: z.string().max(5000).optional(), languages: z.array(z.string().max(60)).max(20).default([]), experienceYears: z.number().int().min(0).max(80).optional(), specialization: z.string().max(160).optional(), workingHours: z.string().max(160).optional(), status: z.enum(['active','hidden','archived']).default('active'), featured: z.boolean().default(false), displayOrder: z.number().int().min(-100000).max(100000).default(0) });
const agentPatchSchema = agentInputSchema.partial();
const FEATURE_KEYS = ['feature_hotels','feature_homes','feature_tours'];
const SETTING_KEYS = ['brand_name','brand_logo_url','support_email','support_phone','payment_provider','payment_webhook_secret','sslcommerz_store_id','sslcommerz_store_password','sslcommerz_api_url','sslcommerz_validation_url','sslcommerz_ipn_url','bkash_base_url','bkash_app_key','bkash_app_secret','bkash_username','bkash_password','sms_provider','sms_gateway_url','sms_gateway_username','sms_gateway_password','sms_api_key','sms_sender_id','smtp_host','smtp_port','smtp_user','smtp_password','smtp_from',...FEATURE_KEYS];
const SETTING_SECRET_KEYS = new Set(['sslcommerz_store_password','payment_webhook_secret','sslcommerz_api_key','bkash_app_key','bkash_app_secret','bkash_username','bkash_password','bkash_token','sms_api_key','sms_gateway_username','sms_gateway_password','smtp_password','payment_provider_api_key']);
const ADMIN_ROLES = ['admin', 'manager', 'super_admin', 'support', 'content_manager', 'finance', 'staff', 'hotel_owner', 'home_owner', 'travel_agent'] as const;
const PRIVILEGED_ROLES = ['admin', 'super_admin'] as const;
const CONTENT_ROLES = ['admin', 'super_admin', 'content_manager'] as const;
const FINANCE_ROLES = ['admin', 'super_admin', 'finance'] as const;
const SUPPORT_ROLES = ['admin', 'super_admin', 'support', 'manager'] as const;
const SAFE_PROVIDER_ERROR_CODES = new Set(['SERVICE_UNAVAILABLE','NOT_READY','MEDIA_NOT_CONFIGURED','MEDIA_UPLOAD_FAILED','MEDIA_DELETE_FAILED','IMAGE_TOO_LARGE','UNSUPPORTED_IMAGE_FORMAT','IMAGE_UPLOAD_INVALID','PROVIDER_NOT_CONFIGURED','PROVIDER_UNAVAILABLE','PROVIDER_ERROR','PROVIDER_TIMEOUT','SMS_NOT_CONFIGURED','SMS_PROVIDER_ERROR','EMAIL_NOT_CONFIGURED','SSLCOMMERZ_NOT_CONFIGURED','SSLCOMMERZ_ERROR','BKASH_NOT_CONFIGURED','BKASH_AUTH_ERROR','BKASH_ERROR','REFUNDS_NOT_CONFIGURED','NOTIFICATION_RETRY_FAILED']);
/** Public storefront route prefix for each catalogue type (used by the sitemap). */
const TYPE_ROUTE_PUBLIC: Record<string, string> = { holiday_package: 'holiday-packages', home: 'homes', destination: 'explore' };

const toInput = (schema: z.ZodTypeAny, value: unknown) => {
  try { return schema.parse(value); } catch (error) { if (error instanceof ZodError) throw new AppError(400, 'VALIDATION_ERROR', 'Please check the submitted fields', error.flatten()); throw error; }
};
const clientMeta = (req: Request) => ({ ip: req.ip, userAgent: req.get('user-agent')?.slice(0, 500) });
const sanitizeEmailHtml = (value?: string) => value?.replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<iframe[\s\S]*?<\/iframe>/gi,'').replace(/<object[\s\S]*?<\/object>/gi,'').replace(/<embed[^>]*>/gi,'').replace(/\son[a-z]+\s*=\s*(["']).*?\1/gi,'').replace(/javascript:/gi,'') || undefined;
const errorPageHtml = (status: number) => { const copy: Record<number, [string, string]> = { 403: ['Access restricted', 'You do not have permission to view this page.'], 404: ['Page not found', 'The page you are looking for does not exist or has moved.'], 503: ['Temporarily unavailable', 'We are having trouble reaching a required service. Please try again shortly.'], 500: ['Something went wrong', 'We are having trouble loading this page. Please try again.'] }; const [title, message] = copy[status] || copy[500]; return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Sadik Travels</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f7fb;color:#17253b;font-family:Inter,system-ui,-apple-system,Segoe UI,sans-serif}.card{width:min(460px,calc(100% - 36px));padding:38px 30px;text-align:center;background:#fff;border:1px solid #e3e8f0;border-radius:18px;box-shadow:0 24px 70px rgba(16,36,80,.12)}.code{font-size:12px;letter-spacing:.15em;text-transform:uppercase;color:#1438b8;font-weight:800}.logo{width:72px;height:55px;object-fit:contain}.card h1{font-size:28px;line-height:1.2;margin:14px 0 8px}.card p{color:#68758a;font-size:13px;line-height:1.6;margin:0 auto 24px}.actions{display:flex;justify-content:center;gap:9px;flex-wrap:wrap}.actions a{display:inline-flex;padding:10px 16px;border-radius:8px;text-decoration:none;font-size:12px;font-weight:800;border:1px solid #cbd5e4;color:#17253b}.actions a.primary{background:#1438b8;border-color:#1438b8;color:#fff}</style></head><body><main class="card"><img class="logo" src="/assets/sadik-travels-logo.png?v=3" alt="Sadik Travels"><div class="code">Error ${status}</div><h1>${title}</h1><p>${message}</p><div class="actions"><a class="primary" href="/">Go home</a><a href="/">Try again</a></div></main></body></html>`; };
const isPublicContentLive = (item: any) => { const startsAt=item.metadata?.startsAt; const expiresAt=item.metadata?.expiresAt; const nowMs=Date.now(); return (!startsAt || Number.isNaN(Date.parse(String(startsAt))) || Date.parse(String(startsAt))<=nowMs) && (!expiresAt || Number.isNaN(Date.parse(String(expiresAt))) || Date.parse(String(expiresAt))>nowMs); };
const trustedBookingQuote = async (store: Store, booking: Booking): Promise<{ amount: number; currency: string } | undefined> => {
  const request = booking.request && typeof booking.request === 'object' ? booking.request as Record<string, unknown> : {};
  if (booking.vertical === 'tour') {
    const tour = request.tourId ? await store.findTour(String(request.tourId)) : undefined;
    if (!tour || tour.status !== 'published') return undefined;
    const meta = (tour.metadata || {}) as Record<string, any>;
    const adults = Math.max(1, Math.min(60, Number(request.adults || request.travellers || 1)));
    const children = Math.max(0, Math.min(30, Number(request.children || 0)));
    const infants = Math.max(0, Math.min(15, Number(request.infants || 0)));
    const quote = computeTourQuote({
      adultPrice: Number(tour.priceBdt || 0),
      childPrice: Number(meta.childPrice) || undefined,
      infantPrice: Number(meta.infantPrice) || undefined,
      seasonSurchargePct: Number(meta.seasonSurchargePct) || undefined,
      vatPct: BD_VAT_PCT, aitPct: BD_AIT_PCT
    }, { adults, children, infants });
    let discount = 0;
    const promoCode = String(request.promoCode || '').trim();
    if (promoCode && String(meta.promoCode || '').toUpperCase() === promoCode.toUpperCase()) {
      discount = Math.round(quote.baseFare * (Number(meta.promoPct || 10) / 100));
    }
    const amount = Math.max(0, quote.total - discount);
    return Number.isFinite(amount) && amount > 0 ? { amount, currency: 'BDT' } : undefined;
  }
  const response = booking.response && typeof booking.response === 'object' ? booking.response as Record<string, any> : {};
  const total = response.total && typeof response.total === 'object' ? response.total as Record<string, unknown> : {};
  const amount = Number(response.quotedAmount ?? response.amount ?? total.amount);
  const currency = String(response.quotedCurrency ?? response.currency ?? total.currency ?? 'BDT').toUpperCase();
  return Number.isFinite(amount) && amount > 0 && /^[A-Z]{3}$/.test(currency) ? { amount, currency } : undefined;
};

const publicTourView = (tour: any) => ({ id:tour.id, slug:tour.slug, title:tour.title, country:tour.country, tourType:tour.tourType, destinations:tour.destinations, durationDays:tour.durationDays, durationNights:tour.durationNights, description:tour.description, metadata:tour.metadata, imageUrl:optimizedMediaUrl(tour.imageUrl,{width:1200}), priceBdt:tour.priceBdt, status:tour.status, featured:tour.featured, createdAt:tour.createdAt, updatedAt:tour.updatedAt });
const userView = (user: any, includeSecurity = false) => ({ id:user.id, phone:user.phone, email:user.email, fullName:user.fullName, avatarUrl:user.avatarUrl, avatarMediaId:user.avatarMediaId, status:user.status, role:user.role, createdAt:user.createdAt, updatedAt:user.updatedAt, lastLoginAt:includeSecurity?user.lastLoginAt:undefined, marketingEmailOptIn:user.marketingEmailOptIn, marketingSmsOptIn:user.marketingSmsOptIn, marketingInAppOptIn:user.marketingInAppOptIn });
const isPrivileged = (req: Request) => PRIVILEGED_ROLES.includes(req.user?.role as typeof PRIVILEGED_ROLES[number]);
const assertPrivileged = (req: Request) => assert(isPrivileged(req), 403, 'ADMIN_ONLY', 'Only an admin can perform this operation');
const bookingTransitions: Record<BookingStatus, BookingStatus[]> = {
  new: ['reviewing', 'accepted', 'rejected', 'cancelled'],
  reviewing: ['new', 'accepted', 'rejected', 'cancelled'],
  accepted: ['processing', 'rejected', 'cancelled'],
  processing: ['confirmed', 'rejected', 'cancelled'],
  pending: ['reviewing', 'accepted', 'processing', 'confirmed', 'rejected', 'cancelled'],
  confirmed: ['completed', 'cancelled'],
  completed: [],
  rejected: [],
  cancelled: [],
  failed: ['reviewing', 'cancelled']
};

export function buildApp() {
  const { store, connection } = createStore();
  const messaging = new MessagingProvider(store);
  const payment = new PaymentProvider(store);
  const media = new MediaService();
  const hotelStore = createHotelStore();
  const commerce = createCommerceStore();
  // Messenger-style live chat: Firebase Realtime Database is the real-time
  // source of truth when configured (browsers subscribe directly); otherwise
  // the MongoDB store keeps transcripts and the Socket.IO hub fans out events.
  const chatStore = createChatStore();
  const chatService = new ChatService({ store: chatStore, directory: createStoreDirectory(store, hotelStore), firebase: firebaseChatBridge(), brandName: 'Sadik Travels' });
  const chatHub = new ChatRealtimeHub(chatService);
  connection.then(async () => {
    try { await hotelStore.ensureIndexes(); } catch { /* index creation is best-effort */ }
    try { await commerce.ensureIndexes(); } catch { /* index creation is best-effort */ }
  });
  const mediaUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.mediaMaxUploadBytes, files: 10 }, fileFilter: (_req, file, callback) => { if (!['image/jpeg','image/png','image/webp'].includes(file.mimetype)) callback(new AppError(415, 'UNSUPPORTED_IMAGE_FORMAT', 'Unsupported image format')); else callback(null, true); } });
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use(pinoHttp({ level: config.logLevel, redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'] }));
  app.use(requestContext());
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' }, contentSecurityPolicy: { directives: { imgSrc: ["'self'", 'data:', 'https:'], fontSrc: ["'self'", 'https:', 'data:'], styleSrc: ["'self'", 'https:', "'unsafe-inline'"], scriptSrc: ["'self'", 'https://www.gstatic.com', 'https://apis.google.com'], connectSrc: ["'self'", 'https://identitytoolkit.googleapis.com', 'https://securetoken.googleapis.com', 'https://*.googleapis.com', 'https://*.firebaseio.com', 'wss://*.firebaseio.com', 'https://*.firebasedatabase.app', 'wss://*.firebasedatabase.app'], frameSrc: ["'self'", 'https://*.firebaseapp.com', 'https://accounts.google.com', 'https://*.google.com'] } } }));
  const corsMiddleware = cors({ origin: (origin, callback) => { if (!origin || config.corsOrigins.includes(origin)) callback(null, true); else callback(new AppError(403, 'CORS_DENIED', 'Origin is not allowed')); }, credentials: true, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID', 'X-Chat-Token', 'X-Chat-Identity'] });
  app.use((req, res, next) => { const origin = req.get('origin'); let sameOrigin = !origin; if (origin) { try { sameOrigin = new URL(origin).host === req.get('host'); } catch { /* Invalid origins are handled by CORS. */ } } if (sameOrigin) return next(); return corsMiddleware(req, res, next); });
  app.use(express.json({ limit: '1mb', verify: (req, _res, buffer) => { (req as any).rawBody = Buffer.from(buffer); } }));
  app.use(cookieParser());
  app.use(rateLimit('global', 300, 60));
  app.use(['/api/v1/site', '/api/v1/tours'], (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  // Fail fast when MongoDB is not connected: an honest 503 in milliseconds instead of a
  // 10s mongoose buffering timeout surfacing as a generic 500. /api/health and /api/ready
  // stay outside this guard so they keep reporting real dependency status.
  app.use('/api/v1', (_req, _res, next) => {
    if (mongoose.connection.readyState !== 1) return next(new AppError(503, 'SERVICE_UNAVAILABLE', 'The Sadik Travels database is temporarily unreachable. Please try again in a moment.'));
    next();
  });

  registerChatRoutes(app, { service: chatService, hub: chatHub, auth: { optional: optionalAuth(store) } });

  app.get(['/healthz', '/api/health'], async (_req, res, next) => { try { const healthy = await store.health(); assert(healthy, 503, 'NOT_READY', 'Database is not connected'); res.json({ status: 'ok', ok: true, service: 'sadik-travels-api', database: 'connected', env: config.nodeEnv }); } catch (error) { next(error instanceof AppError ? error : new AppError(503, 'NOT_READY', 'Service dependencies are not ready', config.isProduction ? undefined : error)); } });
  app.get(['/readyz', '/api/ready'], async (_req, res, next) => { try { const healthy = await store.health(); assert(healthy, 503, 'NOT_READY', 'Database is not connected'); res.json({ ok: true, database: 'mongodb' }); } catch (error) { next(error instanceof AppError ? error : new AppError(503, 'NOT_READY', 'Service dependencies are not ready', config.isProduction ? undefined : error)); } });
  app.get('/api/v1/site/settings', async (_req, res) => {
    const serviceVisibility = await store.getServiceVisibility();
    const serviceStatuses = Object.fromEntries(serviceVisibility.map(item => [item.key, item.status]));
    const features: Record<string, boolean> = {};
    for (const key of FEATURE_KEYS) { const serviceKey = key.replace('feature_', ''); const status = serviceStatuses[serviceKey] ?? 'active'; features[serviceKey] = status !== 'hidden' && status !== 'archived'; }
    const savedLogo = await store.getSetting('brand_logo_url');
    const logoUrl = savedLogo && !savedLogo.includes('SqrRwJyv') ? savedLogo : '/assets/sadik-travels-logo.png?v=3';
    res.json({ brand: await store.getSetting('brand_name') || 'Sadik Travels', logoUrl, support: { email: await store.getSetting('support_email') || '', phone: await store.getSetting('support_phone') || '' }, features, serviceStatuses });
  });
  app.get('/api/v1/site/content', async (req, res) => { const type = contentTypeSchema.safeParse(String(req.query.type || 'all')); const content = (await store.listContent({ type: type.success ? type.data : 'all', q: req.query.q ? String(req.query.q) : undefined })).filter(isPublicContentLive); res.json({ content: content.map(item => ({ id:item.id, type:item.type, slug:item.slug, title:item.title, subtitle:item.subtitle, description:item.description, metadata:item.metadata, imageUrl:optimizedMediaUrl(item.imageUrl,{width:1600}) })) }); });
  app.get('/api/v1/site/content/:type/:idOrSlug', async (req, res) => { const type=contentTypeSchema.safeParse(String(req.params.type)); assert(type.success,404,'CONTENT_NOT_FOUND','Content not found'); const items=(await store.listContent({type:type.data})).filter(isPublicContentLive); const item=items.find(entry=>entry.id===String(req.params.idOrSlug)||entry.slug===String(req.params.idOrSlug)); assert(item,404,'CONTENT_NOT_FOUND','Content not found'); res.json({ content:{ id:item.id,type:item.type,slug:item.slug,title:item.title,subtitle:item.subtitle,description:item.description,imageUrl:optimizedMediaUrl(item.imageUrl,{width:1600}),metadata:item.metadata } }); });
  app.get('/api/v1/site/agents', async (req, res) => { const result = await store.listTravelAgents({ publicOnly: true, featured: req.query.featured === 'true' ? true : undefined, page: Number(req.query.page) || 1, pageSize: Number(req.query.pageSize) || 50 }); res.json({ agents: result.agents.map(agent => ({ id:agent.id, fullName:agent.fullName, agencyName:agent.agencyName, photoUrl:agent.photoUrl, photoPublicId:agent.photoPublicId, jobTitle:agent.jobTitle, department:agent.department, phone:agent.phone, whatsapp:agent.whatsapp, email:agent.email, officeLocation:agent.officeLocation, city:agent.city, shortBio:agent.shortBio, fullDescription:agent.fullDescription, languages:agent.languages, experienceYears:agent.experienceYears, specialization:agent.specialization, workingHours:agent.workingHours, featured:agent.featured, displayOrder:agent.displayOrder })) }); });
  app.get('/api/v1/site/agents/:id', async (req,res)=>{ const agent=await store.findTravelAgent(String(req.params.id)); assert(agent && agent.status==='active',404,'AGENT_NOT_FOUND','Agent not found'); res.json({agent:{id:agent.id,fullName:agent.fullName,agencyName:agent.agencyName,photoUrl:agent.photoUrl,photoPublicId:agent.photoPublicId,jobTitle:agent.jobTitle,department:agent.department,phone:agent.phone,whatsapp:agent.whatsapp,email:agent.email,officeLocation:agent.officeLocation,shortBio:agent.shortBio,fullDescription:agent.fullDescription,languages:agent.languages,experienceYears:agent.experienceYears,specialization:agent.specialization,workingHours:agent.workingHours,featured:agent.featured,displayOrder:agent.displayOrder}}); });

  // Authentication: Bangladesh phone OTP first, email OTP as a fallback.
  app.post('/api/v1/auth/password-login', rateLimit('password-login', 10, 300), async (req, res) => { const input = toInput(passwordLoginRequest, req.body); const identity = normalizeIdentity(input.identity).identity; const user = await store.findUserByIdentity(identity); assert(user && ADMIN_ROLES.includes(user.role as typeof ADMIN_ROLES[number]) && user.status === 'active', 401, 'ADMIN_LOGIN_INVALID', 'Invalid admin credentials'); const hash = await store.getPasswordHash(identity); assert(hash && await verifyPassword(input.password, hash), 401, 'ADMIN_LOGIN_INVALID', 'Invalid admin credentials'); const session = await issueSession(store, user, clientMeta(req)); await store.updateLastLogin(user.id, req.ip); setAuthCookies(res, session.accessToken, session.refreshToken); await store.audit('auth.password_login', { ...clientMeta(req), userId: user.id }); res.json({ accessToken: session.accessToken, expiresIn: config.accessTokenTtl, user: userView(user, true) }); });

  // Public (browser-safe) Firebase web config used by the admin console's Google sign-in.
  app.get('/api/v1/site/firebase-config', (_req, res) => res.json({ configured: isFirebaseConfigured(), firebase: firebasePublicConfig() }));

  // Customer "Continue with Google": verifies the Firebase ID token server-side
  // and always results in a customer-role session. A Google identity can never
  // become an admin through this path.
  app.post('/api/v1/auth/google-login', rateLimit('google-login', 10, 300), async (req, res) => {
    const input = toInput(firebaseLoginRequest, req.body);
    const decoded = await verifyFirebaseIdToken(input.idToken);
    const rawEmail = String(decoded.email || '').trim().toLowerCase();
    assert(decoded.email_verified === true && rawEmail, 401, 'FIREBASE_EMAIL_NOT_VERIFIED', 'Your Google account email is not verified');
    const user = await store.upsertGoogleCustomer({
      firebaseUid: decoded.uid,
      email: rawEmail,
      fullName: decoded.name ? String(decoded.name) : undefined,
      avatarUrl: decoded.picture ? String(decoded.picture) : undefined
    });
    assert(user.role === 'customer' && user.status === 'active', 403, 'ACCOUNT_UNAVAILABLE', 'This account is unavailable.');
    const session = await issueSession(store, user, clientMeta(req));
    await store.updateLastLogin(user.id, req.ip);
    setAuthCookies(res, session.accessToken, session.refreshToken);
    await store.audit('auth.google_login', { ...clientMeta(req), userId: user.id, metadata: { firebaseUid: decoded.uid } });
    res.json({ accessToken: session.accessToken, expiresIn: config.accessTokenTtl, user: userView(user) });
  });

  // Public customer navigation: the admin toggles items on/off; hidden items
  // are omitted from the storefront sidebar.
  app.get('/api/v1/site/navigation', async (_req, res) => {
    const items = await store.listSiteNavigation(true);
    res.json({ navigation: items.map(item => ({ key: item.key, label: item.label, route: item.route, icon: item.icon, group: item.group, sortOrder: item.sortOrder })) });
  });

  // Admin sign-in via Firebase Google authentication (serverless Google OAuth + server-side token verification).
  app.post('/api/v1/auth/request-otp', rateLimit('otp', 5, 300), async (req, res) => {
    const input = toInput(identityRequest, req.body);
    const normalized = normalizeIdentity(input.identity);
    if (input.adminOnly && !config.adminIdentities.includes(normalized.identity)) throw new AppError(403, 'ADMIN_NOT_WHITELISTED', 'This identity is not authorized for admin login');
    const recent = await store.countRecentOtpRequests(normalized.identity, new Date(Date.now() - 60_000));
    assert(recent < 3, 429, 'OTP_THROTTLED', 'Please wait before requesting another code');
    const code = String(randomInt(100000, 1_000_000));
    const challengeId = randomUUID();
    await store.createOtp({ id: challengeId, identity: normalized.identity, channel: normalized.channel, codeHash: await hashOtp(code), attempts: 0, maxAttempts: 5, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), requestIp: req.ip });
    const delivery = await messaging.sendOtp(normalized.channel, normalized.identity, code);
    await store.audit('auth.otp_requested', { ...clientMeta(req), metadata: { channel: normalized.channel } });
    res.status(202).json({ challengeId, channel: normalized.channel, maskedDestination: normalized.channel === 'sms' ? `${normalized.identity.slice(0, 7)}••••` : `${normalized.identity.slice(0, 2)}•••${normalized.identity.slice(normalized.identity.indexOf('@'))}`, expiresIn: 300, ...(delivery.devCode && !config.isProduction ? { devCode: delivery.devCode } : {}) });
  });

  app.post('/api/v1/auth/verify-otp', rateLimit('otp-verify', 15, 300), async (req, res) => {
    const input = toInput(verifyOtpRequest, req.body);
    const challenge = await store.findOtp(input.challengeId);
    assert(challenge, 404, 'OTP_NOT_FOUND', 'This verification code is no longer available');
    assert(!challenge.consumedAt, 400, 'OTP_USED', 'This verification code has already been used');
    assert(new Date(challenge.expiresAt) > new Date(), 400, 'OTP_EXPIRED', 'This verification code has expired');
    assert(challenge.attempts < challenge.maxAttempts, 429, 'OTP_LOCKED', 'Too many incorrect attempts');
    const valid = await verifyOtpHash(input.code, challenge.codeHash);
    if (!valid) { const updated = await store.incrementOtpAttempts(challenge.id); const remaining = Math.max(0, (updated?.maxAttempts ?? challenge.maxAttempts) - (updated?.attempts ?? challenge.attempts + 1)); throw new AppError(400, 'OTP_INVALID', remaining ? `Incorrect code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.` : 'Too many incorrect attempts'); }
    await store.consumeOtp(challenge.id);
    const isConfiguredAdmin = config.adminIdentities.includes(challenge.identity);
    let user = await store.findUserByIdentity(challenge.identity);
    if (!user) user = await store.createUser({ identity: challenge.identity, channel: challenge.channel, role: isConfiguredAdmin ? 'admin' : 'customer' });
    else if (isConfiguredAdmin && !['admin', 'super_admin'].includes(user.role)) user = (await store.setUserRole(user.id, 'admin')) ?? user;
    assert(user.status === 'active', 403, 'ACCOUNT_UNAVAILABLE', 'This account is suspended or disabled. Contact a Super Admin.');
    const session = await issueSession(store, user, clientMeta(req));
    await store.updateLastLogin(user.id, req.ip);
    setAuthCookies(res, session.accessToken, session.refreshToken);
    await store.audit('auth.login', { ...clientMeta(req), userId: user.id, metadata: { channel: challenge.channel } });
    res.json({ accessToken: session.accessToken, expiresIn: config.accessTokenTtl, user: userView(user, true) });
  });

  app.post('/api/v1/auth/refresh', rateLimit('refresh', 30, 60), async (req, res) => {
    const token = req.cookies?.[REFRESH_COOKIE] as string | undefined;
    if (!token) throw new AppError(401, 'AUTH_REQUIRED', 'Refresh login is required');
    const claims = await verifyToken(token, 'refresh');
    const existing = await store.findSessionByRefreshJti(claims.jti);
    assert(existing && existing.id === claims.sid && existing.userId === claims.sub && !existing.revokedAt && new Date(existing.expiresAt) > new Date(), 401, 'SESSION_INVALID', 'Your session has expired. Please login again.');
    const user = await store.findUserById(existing.userId);
    assert(user && user.status === 'active', 403, 'ACCOUNT_UNAVAILABLE', 'This account is not available');
    await store.revokeSession(existing.id);
    const next = await issueSession(store, user, clientMeta(req));
    setAuthCookies(res, next.accessToken, next.refreshToken);
    res.json({ accessToken: next.accessToken, expiresIn: config.accessTokenTtl, user: userView(user, true) });
  });
  app.post('/api/v1/auth/logout', async (req, res, next) => { try { const token = req.cookies?.[REFRESH_COOKIE] as string | undefined; if (token) { try { const claims = await verifyToken(token, 'refresh'); await store.revokeSession(claims.sid); await store.audit('auth.logout', { ...clientMeta(req), userId: claims.sub }); } catch { /* Always clear local cookies. */ } } clearAuthCookies(res); res.status(204).send(); } catch (error) { next(error); } });
  app.get('/api/v1/auth/me', requireAuth(store), (req, res) => res.json({ user: userView(req.user) }));
  // Customer profile (self service). Only safe, self-owned fields may change here.
  app.get('/api/v1/account/profile', requireAuth(store), async (req, res) => res.json({ user: userView(req.user, true) }));
  app.patch('/api/v1/account/profile', requireAuth(store), async (req, res) => {
    const input = toInput(z.object({ fullName: z.string().trim().min(2).max(120).optional() }).strict(), req.body);
    const user = await store.updateUserProfile(req.user!.id, input);
    assert(user, 404, 'USER_NOT_FOUND', 'Account not found');
    await store.audit('account.profile_updated', { ...clientMeta(req), userId: req.user!.id, metadata: { keys: Object.keys(input) } });
    res.json({ user: userView(user, true) });
  });
  app.get('/api/v1/account/preferences', requireAuth(store), async (req,res)=>{const user=await store.findUserById(req.user!.id);res.json({preferences:{marketingEmailOptIn:user?.marketingEmailOptIn!==false,marketingSmsOptIn:user?.marketingSmsOptIn!==false,marketingInAppOptIn:user?.marketingInAppOptIn!==false}});});
  app.patch('/api/v1/account/preferences', requireAuth(store), async (req,res)=>{const input=toInput(preferencesPatchRequest,req.body);const user=await store.updateUserProfile(req.user!.id,input);assert(user,404,'USER_NOT_FOUND','Account not found');await store.audit('account.preferences_updated',{...clientMeta(req),userId:req.user!.id,metadata:{keys:Object.keys(input)}});res.json({preferences:{marketingEmailOptIn:user.marketingEmailOptIn!==false,marketingSmsOptIn:user.marketingSmsOptIn!==false,marketingInAppOptIn:user.marketingInAppOptIn!==false}});});
  app.get('/api/v1/notifications', requireAuth(store), async (req, res) => { const notifications = await store.listNotifications(req.user!.id); res.json({ notifications, unread: notifications.filter(item => !item.readAt).length }); });
  app.patch('/api/v1/notifications/:id/read', requireAuth(store), async (req, res) => { const notification = await store.markNotificationRead(String(req.params.id), req.user!.id); assert(notification, 404, 'NOTIFICATION_NOT_FOUND', 'Notification not found'); res.json({ notification }); });

  // Account: transaction ledger and support tickets (self-owned records only).
  app.get('/api/v1/account/payments', requireAuth(store), async (req, res) => {
    const result = await store.listUserPayments(req.user!.id, { page: Number(req.query.page) || 1, pageSize: Number(req.query.pageSize) || 20 });
    res.json({ payments: result.payments.map(payment => ({ id: payment.id, bookingId: payment.bookingId, orderId: payment.orderId, provider: payment.provider, amount: payment.amount, currency: payment.currency, status: payment.status, transactionRef: payment.transactionRef, gatewayTransactionId: payment.gatewayTransactionId, paymentMethod: payment.paymentMethod, initiatedAt: payment.initiatedAt, completedAt: payment.completedAt, failedAt: payment.failedAt, failureReason: payment.failureReason, refundStatus: payment.refundStatus || 'none', refundAmount: payment.refundAmount, refundedAt: payment.refundedAt, createdAt: payment.createdAt })), total: result.total, page: result.page, pageSize: result.pageSize, pageCount: result.pageCount });
  });
  app.get('/api/v1/account/tickets', requireAuth(store), async (req, res) => {
    const tickets = (await store.listSupportTickets({ q: req.query.q ? String(req.query.q) : undefined })).filter(ticket => ticket.userId === req.user!.id);
    res.json({ tickets: tickets.map(ticket => ({ id: ticket.id, subject: ticket.subject, status: ticket.status, priority: ticket.priority, createdAt: ticket.createdAt, updatedAt: ticket.updatedAt })) });
  });
  app.get('/api/v1/account/tickets/:id', requireAuth(store), async (req, res) => {
    const ticket = await store.findSupportTicket(String(req.params.id));
    assert(ticket && ticket.userId === req.user!.id, 404, 'TICKET_NOT_FOUND', 'Ticket not found');
    res.json({ ticket, messages: await store.listSupportMessages(ticket.id) });
  });
  app.post('/api/v1/account/tickets/:id/messages', requireAuth(store), rateLimit('ticket-reply', 20, 60), async (req, res) => {
    const input = toInput(z.object({ message: z.string().trim().min(1).max(4000) }), req.body);
    const ticket = await store.findSupportTicket(String(req.params.id));
    assert(ticket && ticket.userId === req.user!.id, 404, 'TICKET_NOT_FOUND', 'Ticket not found');
    const message = await store.createSupportMessage({ ticketId: ticket.id, authorId: req.user!.id, authorType: 'customer', message: input.message, internal: false });
    await store.updateSupportTicket(ticket.id, { status: 'pending' });
    await store.audit('support.customer_replied', { ...clientMeta(req), userId: req.user!.id, metadata: { ticketId: ticket.id } });
    res.status(201).json({ message });
  });

  // Public tour catalogue and live provider search.
  app.get('/api/v1/tours', rateLimit('tour-catalog', 120, 60), optionalAuth(store), async (req, res) => { const filters: TourFilters = { q: req.query.q ? String(req.query.q) : undefined, country: req.query.destination ? String(req.query.destination) : undefined, tourType: req.query.tour_type ? String(req.query.tour_type) : undefined, minPrice: req.query.min_price ? Number(req.query.min_price) : undefined, maxPrice: req.query.max_price ? Number(req.query.max_price) : undefined, sort: req.query.sort === 'price_asc' || req.query.sort === 'price_desc' ? req.query.sort : 'newest' }; const tours = await store.listTours(filters); res.json({ success: true, filters, count: tours.length, tours: tours.map(publicTourView) }); });
  app.get('/api/v1/tours/:idOrSlug', rateLimit('tour-detail', 120, 60), async (req, res) => { const tour = await store.findTour(String(req.params.idOrSlug)); assert(tour && tour.status === 'published', 404, 'TOUR_NOT_FOUND', 'Tour package not found'); res.json({ tour: publicTourView(tour) }); });

  // Admin access and operational dashboard.
  app.get('/api/v1/admin/me', requireAdmin(store), (req, res) => res.json({ user: userView(req.user, true), permissions: permissionsFor(req.user).map(permission => permission.replace(':', '_')), finePermissions: effectiveFinePermissions(req.user), isSuperAdmin: req.user!.role === 'super_admin' }));

  // ---- Super Admin: admin accounts & granular permissions ----
  const passwordSchema = z.string().min(12).max(200).regex(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{12,}$/, 'Use 12+ characters with upper, lower, number and symbol');
  const adminRoleSchema = z.enum(['admin', 'staff', 'manager', 'support', 'content_manager', 'finance', 'hotel_owner', 'home_owner', 'travel_agent', 'super_admin']);
  const adminCreateSchema = z.object({ fullName: z.string().trim().min(2).max(120), email: z.string().trim().toLowerCase().email(), phone: z.string().max(40).optional(), role: adminRoleSchema, password: passwordSchema, permissions: z.array(z.string().max(60)).default([]), status: z.enum(['active', 'suspended', 'blocked']).default('active'), avatarUrl: z.string().max(500).optional(), avatarMediaId: z.string().uuid().optional() });
  const adminPatchSchema = z.object({ fullName: z.string().trim().min(2).max(120).optional(), email: z.string().trim().toLowerCase().email().optional(), phone: z.string().max(40).optional(), role: adminRoleSchema.optional(), permissions: z.array(z.string().max(60)).optional(), status: z.enum(['active', 'suspended', 'blocked']).optional(), avatarUrl: z.string().max(500).optional(), avatarMediaId: z.string().uuid().optional() });
  const adminView = (user: any) => ({ ...userView(user), permissions: Array.isArray(user.permissions) ? user.permissions : (ROLE_PERMISSION_PRESETS[user.role] || []), isConfigured: Array.isArray(user.permissions) });
  app.get('/api/v1/admin/permissions/catalog', requireSuperAdmin(store), (_req, res) => res.json({ catalog: PERMISSION_CATALOG, allFine: ALL_FINE_PERMISSIONS, presets: ROLE_PERMISSION_PRESETS }));
  app.get('/api/v1/admin/admins', requireSuperAdmin(store), async (_req, res) => res.json({ admins: (await store.listAdmins()).map(adminView) }));
  app.get('/api/v1/admin/admins/:id', requireSuperAdmin(store), async (req, res, next) => { try { const user = await store.findUserById(String(req.params.id)); assert(user && user.role !== 'customer', 404, 'ADMIN_NOT_FOUND', 'Admin not found'); const activity = (await store.listAuditLogs(60)).filter((log: any) => log.userId === user.id).slice(0, 15); res.json({ admin: adminView(user), effectiveFine: effectiveFinePermissions(user), activity }); } catch (error) { next(error); } });
  app.post('/api/v1/admin/admins', requireSuperAdmin(store), async (req, res, next) => {
    try {
      const input = toInput(adminCreateSchema, req.body);
      const existing = await store.findUserByIdentity(input.email);
      assert(!existing, 409, 'IDENTITY_IN_USE', 'That email is already registered');
      const permissions = input.permissions && input.permissions.length > 0
        ? sanitizePermissions(input.permissions, input.role === 'super_admin')
        : sanitizePermissions(ROLE_PERMISSION_PRESETS[input.role] || [], input.role === 'super_admin');
      const user = await store.createAdminUser({ email: input.email, phone: input.phone, fullName: input.fullName, role: input.role, permissions, status: input.status, avatarUrl: input.avatarUrl, avatarMediaId: input.avatarMediaId });
      await store.setPasswordHash(user.id, await hashPassword(input.password));
      await store.audit('admin.created', { ...clientMeta(req), userId: req.user!.id, metadata: { adminId: user.id, role: user.role, permissionsCount: permissions.length } });
      res.status(201).json({ admin: adminView(user) });
    } catch (error) { next(error); }
  });
  app.patch('/api/v1/admin/admins/:id', requireSuperAdmin(store), async (req, res, next) => {
    try {
      const input = toInput(adminPatchSchema, req.body);
      const target = await store.findUserById(String(req.params.id));
      assert(target && target.role !== 'customer', 404, 'ADMIN_NOT_FOUND', 'Admin not found');
      assert(!(target.id === req.user!.id && input.role && input.role !== 'super_admin'), 409, 'SELF_DEMOTE_BLOCKED', 'Another Super Admin must change your role');
      const nextRole = input.role || target.role;
      const patch: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(input)) {
        if (value !== undefined) {
          patch[key] = key === 'permissions' ? sanitizePermissions(value, nextRole === 'super_admin') : value;
        }
      }
      if (input.role && input.role !== target.role && input.permissions === undefined) {
        patch.permissions = sanitizePermissions(ROLE_PERMISSION_PRESETS[input.role] || [], nextRole === 'super_admin');
      }
      const updated = await store.updateAdmin(target.id, patch);
      assert(updated, 404, 'ADMIN_NOT_FOUND', 'Admin not found');
      await store.audit('admin.updated', { ...clientMeta(req), userId: req.user!.id, metadata: { adminId: target.id, keys: Object.keys(patch) } });
      res.json({ admin: adminView(updated) });
    } catch (error) { next(error); }
  });
  app.post('/api/v1/admin/admins/:id/reset-password', requireSuperAdmin(store), async (req, res, next) => { try { const input = toInput(z.object({ newPassword: passwordSchema }), req.body); const target = await store.findUserById(String(req.params.id)); assert(target && target.role !== 'customer', 404, 'ADMIN_NOT_FOUND', 'Admin not found'); await store.setPasswordHash(target.id, await hashPassword(input.newPassword)); await store.revokeOtherSessions(target.id, 'none'); await store.audit('admin.password_reset', { ...clientMeta(req), userId: req.user!.id, metadata: { adminId: target.id } }); res.json({ reset: true }); } catch (error) { next(error); } });
  app.post('/api/v1/admin/admins/:id/status', requireSuperAdmin(store), async (req, res, next) => { try { const input = toInput(z.object({ status: z.enum(['active', 'suspended', 'blocked']) }), req.body); const target = await store.findUserById(String(req.params.id)); assert(target && target.role !== 'customer', 404, 'ADMIN_NOT_FOUND', 'Admin not found'); assert(target.id !== req.user!.id || input.status === 'active', 409, 'SELF_DISABLE_BLOCKED', 'You cannot suspend or disable your own account'); const updated = await store.updateAdmin(target.id, { status: input.status }); if (input.status !== 'active') await store.revokeOtherSessions(target.id, 'none'); await store.audit('admin.status_changed', { ...clientMeta(req), userId: req.user!.id, metadata: { adminId: target.id, status: input.status } }); res.json({ admin: adminView(updated) }); } catch (error) { next(error); } });
  app.delete('/api/v1/admin/admins/:id', requireSuperAdmin(store), async (req, res, next) => { try { const target = await store.findUserById(String(req.params.id)); assert(target && target.role !== 'customer', 404, 'ADMIN_NOT_FOUND', 'Admin not found'); assert(target.id !== req.user!.id, 409, 'SELF_DELETE_BLOCKED', 'You cannot delete your own account'); const deleted = await store.deleteAdminUser(target.id); assert(deleted, 404, 'ADMIN_NOT_FOUND', 'Admin not found'); await store.audit('admin.deleted', { ...clientMeta(req), userId: req.user!.id, metadata: { adminId: target.id } }); res.json({ deleted: true }); } catch (error) { next(error); } });

  app.get('/api/v1/admin/navigation', requireAdmin(store), async (req, res) => {
    const navigation = await store.listNavigation(false);
    if (req.user!.role === 'super_admin') return res.json({ navigation });
    const fine = new Set(effectiveFinePermissions(req.user));
    const routePermission: Record<string, string> = {
      '/admin': 'dashboard.view',
      '/admin/hotels': 'hotel.view',
      '/admin/hotel-bookings': 'booking.view',
      '/admin/live-support': 'support.view',
      '/admin/travel-agents': 'agent.view',
      '/admin/tours': 'tour.view',
      '/admin/catalog?type=home': 'home.view',
      '/admin/catalog?type=holiday_package': 'catalog.view',
      '/admin/catalog?type=destination': 'catalog.view',
      '/admin/customers': 'customer.view',
      '/admin/bookings': 'booking.view',
      '/admin/payments': 'payment.view',
      '/admin/support': 'support.view',
      '/admin/notifications': 'notifications.send',
      '/admin/content': 'content.view',
      '/admin/media': 'media.view',
      '/admin/navigation': 'navigation.manage',
      '/admin/settings': 'settings.view',
      '/admin/system-status': 'settings.view',
      '/admin/profile': 'dashboard.view',
      '/admin/admins': 'admin.manage'
    };
    const vendor = ['hotel_owner', 'home_owner', 'travel_agent'].includes(req.user!.role);
    const allowed = navigation.filter(item => {
      if (item.route === '/admin/admins') return false;
      if (vendor && item.route === '/admin/bookings') return false;
      const routeFine = routePermission[item.route];
      const configuredFine = item.permission ? item.permission.replace(/_/g, '.') : undefined;
      if (routeFine) return fine.has(routeFine);
      if (configuredFine) return fine.has(configuredFine);
      return true;
    });
    res.json({ navigation: allowed });
  });
  app.post('/api/v1/admin/navigation', requireFinePermission(store, 'navigation.manage'), async (req, res) => { const input=toInput(navigationInputSchema,req.body); const item=await store.createNavigation(input); await store.audit('admin.navigation_created',{...clientMeta(req),userId:req.user!.id,metadata:{navigationId:item.id,label:item.label}}); res.status(201).json({ navigation:item }); });
  app.patch('/api/v1/admin/navigation/:id', requireFinePermission(store, 'navigation.manage'), async (req,res)=>{ const input=toInput(navigationPatchSchema,req.body); const item=await store.updateNavigation(String(req.params.id),input); assert(item,404,'NAVIGATION_NOT_FOUND','Navigation item not found'); await store.audit('admin.navigation_updated',{...clientMeta(req),userId:req.user!.id,metadata:{navigationId:item.id,label:item.label,visible:item.visible}}); res.json({navigation:item}); });
  app.delete('/api/v1/admin/navigation/:id', requireFinePermission(store, 'navigation.manage'), async (req,res)=>{ const deleted=await store.deleteNavigation(String(req.params.id)); assert(deleted,404,'NAVIGATION_NOT_FOUND','Navigation item not found'); await store.audit('admin.navigation_deleted',{...clientMeta(req),userId:req.user!.id,metadata:{navigationId:req.params.id}}); res.json({deleted:true}); });
  app.post('/api/v1/admin/navigation/reorder', requireFinePermission(store, 'navigation.manage'), async (req,res)=>{ const input=toInput(navigationReorderSchema,req.body); await store.reorderNavigation(input.ids); await store.audit('admin.navigation_reordered',{...clientMeta(req),userId:req.user!.id,metadata:{count:input.ids.length}}); res.json({navigation:await store.listNavigation(false)}); });
  // Customer/site navigation management (the visible storefront menu).
  app.get('/api/v1/admin/site-navigation', requireFinePermission(store, 'navigation.manage'), async (_req, res) => res.json({ navigation: await store.listSiteNavigation(false) }));
  const siteNavPatchSchema = z.object({ label: z.string().trim().min(1).max(80).optional(), route: z.string().startsWith('/').max(200).optional(), enabled: z.boolean().optional(), sortOrder: z.number().int().min(-100000).max(100000).optional() });
  app.patch('/api/v1/admin/site-navigation/:id', requireFinePermission(store, 'navigation.manage'), async (req, res) => {
    const input = toInput(siteNavPatchSchema, req.body);
    const item = await store.updateSiteNavigation(String(req.params.id), input);
    assert(item, 404, 'NAVIGATION_NOT_FOUND', 'Navigation item not found');
    await store.audit('admin.site_navigation_updated', { ...clientMeta(req), userId: req.user!.id, metadata: { navigationId: item.id, label: item.label, enabled: item.enabled } });
    res.json({ navigation: item });
  });

  app.get('/api/v1/admin/profile', requireAdmin(store), async (req, res) => { const user = await store.findUserById(req.user!.id); assert(user, 404, 'USER_NOT_FOUND', 'Admin profile not found'); res.json({ user: userView(user, true) }); });
  app.patch('/api/v1/admin/profile', requireAdmin(store), async (req, res) => { const input = toInput(profilePatchRequest, req.body); const profilePatch = { ...input, ...(input.avatarMediaId === null ? { avatarMediaId: undefined } : {}) }; const user = await store.updateUserProfile(req.user!.id, profilePatch); assert(user, 404, 'USER_NOT_FOUND', 'Admin profile not found'); await store.audit('admin.profile_updated', { ...clientMeta(req), userId: req.user!.id, metadata: { keys: Object.keys(input) } }); res.json({ user: userView(user, true) }); });
  app.post('/api/v1/admin/profile/change-password', requireAdmin(store), async (req, res) => { const input = toInput(changePasswordRequest, req.body); assert(input.newPassword === input.confirmPassword, 400, 'PASSWORD_MISMATCH', 'New passwords do not match'); assert(input.newPassword.length >= 12 && /[a-z]/.test(input.newPassword) && /[A-Z]/.test(input.newPassword) && /\d/.test(input.newPassword) && /[^A-Za-z0-9]/.test(input.newPassword) && !input.newPassword.toLowerCase().includes('password'), 400, 'PASSWORD_WEAK', 'Use at least 12 characters with upper, lower, number and symbol'); const identity = req.user!.email || req.user!.phone; assert(identity, 400, 'IDENTITY_MISSING', 'This admin account has no login identity'); const hash = await store.getPasswordHash(identity); assert(hash && await verifyPassword(input.currentPassword, hash), 401, 'CURRENT_PASSWORD_INVALID', 'Current password is incorrect'); await store.setPasswordHash(req.user!.id, await hashPassword(input.newPassword)); if (req.auth?.sid) await store.revokeOtherSessions(req.user!.id, req.auth.sid); await store.audit('admin.password_changed', { ...clientMeta(req), userId: req.user!.id }); res.json({ changed: true }); });
  app.post('/api/v1/admin/profile/request-contact-otp', requireAdmin(store), rateLimit('profile-contact-otp', 5, 300), async (req, res) => { const input = toInput(contactOtpRequest, req.body); const identity = req.user!.email || req.user!.phone; assert(identity, 400, 'IDENTITY_MISSING', 'This admin account has no login identity'); const hash = await store.getPasswordHash(identity); assert(hash && await verifyPassword(input.currentPassword, hash), 401, 'CURRENT_PASSWORD_INVALID', 'Current password is incorrect'); const normalized = normalizeIdentity(input.target); const existing = await store.findUserByIdentity(normalized.identity); assert(!existing || existing.id === req.user!.id, 409, 'IDENTITY_IN_USE', 'That contact is already used by another account'); const code = String(randomInt(100000, 1000000)); const challengeId = randomUUID(); await store.createOtp({ id: challengeId, identity: normalized.identity, channel: normalized.channel, codeHash: await hashOtp(code), attempts: 0, maxAttempts: 5, expiresAt: new Date(Date.now()+5*60_000).toISOString(), requestIp: req.ip, purpose: normalized.channel === 'email' ? 'profile_email_change' : 'profile_phone_change', userId: req.user!.id, targetIdentity: normalized.identity }); const delivery = await messaging.sendOtp(normalized.channel, normalized.identity, code); await store.audit('admin.contact_change_otp_requested', { ...clientMeta(req), userId: req.user!.id, metadata: { channel: normalized.channel } }); res.status(202).json({ challengeId, channel: normalized.channel, maskedDestination: normalized.channel === 'sms' ? `${normalized.identity.slice(0,7)}••••` : `${normalized.identity.slice(0,2)}•••${normalized.identity.slice(normalized.identity.indexOf('@'))}`, ...(delivery.devCode && !config.isProduction ? { devCode: delivery.devCode } : {}) }); });
  app.post('/api/v1/admin/profile/verify-contact-otp', requireAdmin(store), rateLimit('profile-contact-verify', 10, 300), async (req, res) => { const input = toInput(verifyContactOtpRequest, req.body); const challenge = await store.findOtp(input.challengeId); assert(challenge && challenge.userId === req.user!.id && challenge.targetIdentity && ['profile_email_change','profile_phone_change'].includes(challenge.purpose || ''), 404, 'OTP_NOT_FOUND', 'This contact verification is no longer available'); assert(!challenge.consumedAt && new Date(challenge.expiresAt)>new Date(), 400, 'OTP_EXPIRED', 'This verification code has expired'); assert(challenge.attempts < challenge.maxAttempts, 429, 'OTP_LOCKED', 'Too many incorrect attempts'); const valid = await verifyOtpHash(input.code, challenge.codeHash); if(!valid){await store.incrementOtpAttempts(challenge.id); throw new AppError(400,'OTP_INVALID','Incorrect verification code');} await store.consumeOtp(challenge.id); const patch = challenge.channel === 'email' ? { email: challenge.targetIdentity } : { phone: challenge.targetIdentity }; const user = await store.updateUserProfile(req.user!.id, patch); await store.audit(challenge.channel === 'email' ? 'admin.email_changed' : 'admin.phone_changed', { ...clientMeta(req), userId: req.user!.id, metadata: { channel: challenge.channel } }); res.json({ user: userView(user, true) }); });
  app.get('/api/v1/admin/profile/sessions', requireAdmin(store), async (req, res) => res.json({ sessions: await store.listSessions(req.user!.id), currentSessionId: req.auth?.sid }));
  app.post('/api/v1/admin/profile/sessions/revoke-others', requireAdmin(store), async (req, res) => { assert(req.auth?.sid, 401, 'SESSION_INVALID', 'Current session is not available'); await store.revokeOtherSessions(req.user!.id, req.auth.sid); await store.audit('admin.sessions_revoked', { ...clientMeta(req), userId: req.user!.id }); res.json({ revoked: true }); });
  app.get('/api/v1/admin/system-status', requireFinePermission(store, 'settings.view'), async (_req,res)=>{ await store.health(); const smsProvider=await store.getSetting('sms_provider')||config.smsProvider; const emailConfigured=Boolean((await store.getSetting('smtp_host'))||config.smtpHost) && Boolean((await store.getSetting('smtp_from'))||config.smtpFrom); const smsConfigured=smsProvider==='custom_gateway'?Boolean((await store.getSetting('sms_gateway_url'))||config.smsGatewayUrl):Boolean((await store.getSetting('sms_api_key'))||config.bulkSmsApiKey); const paymentConfigured=Boolean(await store.getSetting('sslcommerz_store_id')||await store.getSetting('bkash_base_url')); res.json({services:{database:{status:'connected'},cloudinary:{status:media.isConfigured()?'connected':'not_configured'},email:{status:emailConfigured?'configured':'not_configured'},sms:{status:smsConfigured?'configured':'not_configured'},payment:{status:paymentConfigured?'configured':'not_configured'}}}); });
  app.get('/api/v1/admin/stats', requireFinePermission(store, 'dashboard.view'), async (req, res) => {
    if (req.user?.role === 'hotel_owner') {
      const stats = await hotelStore.adminStats(req.user.id);
      const recent = await hotelStore.adminListBookings({ ownerId: req.user.id, pageSize: 8 });
      return res.json({
        ...stats,
        role: 'hotel_owner',
        recentBookings: recent.bookings,
        recentActivity: []
      });
    }
    const stats = await store.adminStats();
    const recent = await store.listAdminBookings({ page: 1, pageSize: 8 });
    res.json({ ...stats, tours: stats.tours, recentBookings: recent.bookings, recentActivity: await store.listAuditLogs(12) });
  });

  app.get('/api/v1/admin/services', requireFinePermission(store, 'service.manage'), async (_req, res) => res.json({ services: await store.getServiceVisibility() }));
  app.patch('/api/v1/admin/services/:key/status', requireFinePermission(store, 'service.manage'), async (req, res) => { const key = String(req.params.key) as any; const input = toInput(z.object({ status: serviceStatusSchema, confirm: z.boolean().default(false) }), req.body); const current = (await store.getServiceVisibility()).find(item => item.key === key); assert(current, 404, 'SERVICE_NOT_FOUND', 'Service not found'); assert(input.status === current.status || input.confirm, 400, 'CONFIRMATION_REQUIRED', `Confirm changing ${current.label} visibility`); const service = await store.updateServiceVisibility(key, input.status, req.user!.id); await store.audit('admin.service_visibility_updated', { ...clientMeta(req), userId: req.user!.id, metadata: { service: key, previousStatus: current.status, status: input.status } }); res.json({ service }); });

  app.get('/api/v1/admin/operators', requireFinePermission(store, 'support.view'), async (_req, res) => res.json({ operators: (await store.listAdmins()).filter(user => ['manager','admin','super_admin','support'].includes(user.role) && user.status === 'active').map(user => userView(user)) }));

  app.get('/api/v1/admin/customers', requireFinePermission(store, 'customer.view'), async (req, res) => res.json(await store.listAdminCustomers({ q: req.query.q ? String(req.query.q) : undefined, status: req.query.status === 'active' || req.query.status === 'blocked' || req.query.status === 'pending' ? req.query.status : 'all', page: Number(req.query.page) || 1, pageSize: Number(req.query.pageSize) || 20 })));
  app.get('/api/v1/admin/customers/:id', requireFinePermission(store, 'customer.view'), async (req, res) => { const customer = await store.findAdminCustomer(String(req.params.id)); assert(customer, 404, 'CUSTOMER_NOT_FOUND', 'Customer not found'); res.json({ customer }); });
  app.post('/api/v1/admin/customers/:id/notes', requireFinePermission(store, 'customer.view'), async (req, res) => { const input = toInput(customerNoteRequest, req.body); const customer = await store.findUserById(String(req.params.id)); assert(customer && customer.role === 'customer', 404, 'CUSTOMER_NOT_FOUND', 'Customer not found'); const note = await store.addCustomerNote({ userId: customer.id, authorId: req.user!.id, note: input.note }); await store.audit('admin.customer_note_added', { ...clientMeta(req), userId: req.user!.id, metadata: { customerId: customer.id, noteId: note.id } }); res.status(201).json({ note }); });

  app.get('/api/v1/admin/payments', requireFinePermission(store, 'payment.view'), async (req, res) => res.json(await store.listAdminPayments({ q: req.query.q ? String(req.query.q) : undefined, status: paymentStatusSchema.safeParse(String(req.query.status || '')).success ? paymentStatusSchema.parse(String(req.query.status)) : 'all', provider: req.query.provider ? String(req.query.provider) : undefined, page: Number(req.query.page) || 1, pageSize: Number(req.query.pageSize) || 20 })));
  app.post('/api/v1/admin/payments/:id/refund', requireFinePermission(store, 'payment.manage'), async (req, res, next) => {
    try {
      const input = toInput(z.object({ amount: z.number().positive().max(100000000).optional(), reason: z.string().max(500).optional() }).strict(), req.body ?? {});
      const payment = await store.findPaymentById(String(req.params.id));
      assert(payment, 404, 'PAYMENT_NOT_FOUND', 'Payment not found');
      assert(payment.status === 'paid', 409, 'PAYMENT_NOT_REFUNDABLE', 'Only paid transactions can be refunded');
      const amount = input.amount ?? payment.amount;
      assert(amount <= payment.amount, 400, 'REFUND_EXCEEDS_PAYMENT', 'Refund amount cannot exceed the paid amount');
      // Record the refund request in the ledger. No money moves until the
      // configured gateway exposes a working refund contract — this endpoint
      // never fakes a refund.
      await store.updatePayment(payment.id, { refundStatus: 'requested', refundAmount: amount, refundReason: input.reason });
      await store.audit('payment.refund_requested', { ...clientMeta(req), userId: req.user!.id, metadata: { paymentId: payment.id, amount, reason: input.reason } });
      throw new AppError(503, 'REFUNDS_NOT_CONFIGURED', `Refund request for ${amount} ${payment.currency} was recorded, but no refund has been issued: the configured gateway does not expose a working refund contract.`);
    } catch (error) { next(error); }
  });

  app.get('/api/v1/admin/notifications/history', requireFinePermission(store, 'notifications.send'), async (req, res) => res.json(await store.listAdminNotifications({ q: req.query.q ? String(req.query.q) : undefined, status: ['queued','sent','failed','read'].includes(String(req.query.status)) ? String(req.query.status) as any : 'all', page: Number(req.query.page) || 1, pageSize: Number(req.query.pageSize) || 20 })));
  app.post('/api/v1/admin/notifications/:id/retry', requireFinePermission(store, 'notifications.send'), async (req, res) => { const notification = await store.findNotification(String(req.params.id)); assert(notification, 404, 'NOTIFICATION_NOT_FOUND', 'Notification not found'); assert(notification.status === 'failed', 409, 'NOTIFICATION_NOT_RETRYABLE', 'Only failed notifications can be retried'); try { if (notification.channels.includes('sms')) { assert(notification.recipient?.phone, 400, 'RECIPIENT_PHONE_MISSING', 'Recipient phone is not available'); await messaging.sendNotification('sms', notification.recipient.phone, notification.title, notification.message); } if (notification.channels.includes('email')) { assert(notification.recipient?.email, 400, 'RECIPIENT_EMAIL_MISSING', 'Recipient email is not available'); await messaging.sendNotification('email', notification.recipient.email, notification.title, notification.message); } const updated = await store.updateNotificationDelivery(notification.id, { status: 'sent', sentAt: new Date().toISOString(), failureReason: '' }); await store.audit('admin.notification_retried', { ...clientMeta(req), userId: req.user!.id, metadata: { notificationId: notification.id } }); res.json({ notification: updated }); } catch (error) { const reason = error instanceof Error ? error.message : 'Delivery failed'; const updated = await store.updateNotificationDelivery(notification.id, { status: 'failed', failureReason: reason }); throw error instanceof AppError ? error : new AppError(502, 'NOTIFICATION_RETRY_FAILED', 'Notification retry failed', config.isProduction ? undefined : { reason, notification: updated }); } });


  app.get('/api/v1/admin/settings', requireFinePermission(store, 'settings.view'), async (_req, res) => { const saved = new Map((await store.getAdminSettings()).map(item => [item.key, item])); const settings = await Promise.all(SETTING_KEYS.map(async key => { const item = saved.get(key); if (item) return item; const value = await store.getSetting(key); return { key, configured: Boolean(value), secret: SETTING_SECRET_KEYS.has(key), ...(SETTING_SECRET_KEYS.has(key) ? { masked: value ? SECRET_MASK : '' } : { value: value ?? '' }) }; })); res.json({ settings }); });
  app.put('/api/v1/admin/settings', requireFinePermission(store, 'settings.edit'), async (req, res) => { assertPrivileged(req); const input = toInput(settingPatchSchema, req.body) as Record<string, string | undefined>; const patch = Object.fromEntries(Object.entries(input).filter(([key, value]) => value !== undefined && !(SETTING_SECRET_KEYS.has(key) && value === SECRET_MASK)).map(([key, value]) => [key, typeof value === 'boolean' ? String(value) : value])); await store.updateSettings(patch, req.user!.id); await store.audit('admin.settings_updated', { ...clientMeta(req), userId: req.user!.id, metadata: { keys: Object.keys(patch) } }); res.json({ settings: await store.getAdminSettings() }); });
  app.post('/api/v1/admin/settings/test-sms', requireFinePermission(store, 'settings.edit'), async (req, res) => { assertPrivileged(req); const input = toInput(messageTestRequest, req.body); const result = await messaging.sendSms(input.destination, input.message); res.json({ sent: true, result }); });
  app.post('/api/v1/admin/settings/test-email', requireFinePermission(store, 'settings.edit'), async (req, res) => { assertPrivileged(req); const input = toInput(messageTestRequest, req.body); const result = await messaging.sendEmail(input.destination, input.subject || 'Sadik Travels test email', input.message); res.json({ sent: true, result }); });

  // Booking assignment and lifecycle controls. Claiming is atomic at the database layer.
  app.get('/api/v1/admin/bookings', requireInternalOperator(store, 'booking.view'), async (req, res) => { const rawStatus = String(req.query.status || ''); const status = rawStatus === 'needs_review' ? 'needs_review' : (bookingStatusSchema.safeParse(rawStatus).success ? rawStatus as BookingStatus : 'all'); const vertical = z.enum(['hotel','home','tour']).safeParse(String(req.query.vertical || '')); const result = await store.listAdminBookings({ q: req.query.q ? String(req.query.q) : undefined, status, vertical: vertical.success ? vertical.data : 'all', ownerId: req.query.ownerId ? String(req.query.ownerId) : undefined, page: Number(req.query.page) || 1, pageSize: Number(req.query.pageSize) || 20 }); res.json(result); });
  app.get('/api/v1/admin/bookings/:id', requireInternalOperator(store, 'booking.view'), async (req, res) => { const result = await store.listAdminBookings({ q: String(req.params.id), page: 1, pageSize: 1 }); const booking = result.bookings[0]; assert(booking, 404, 'BOOKING_NOT_FOUND', 'Booking not found'); res.json({ booking, history: await store.listBookingEvents(booking.id) }); });
  app.post('/api/v1/admin/bookings/:id/claim', requireInternalOperator(store, 'booking.update'), async (req, res) => { const existing = await store.findBooking(String(req.params.id)); assert(existing, 404, 'BOOKING_NOT_FOUND', 'Booking not found'); if (existing.ownerId && existing.ownerId !== req.user!.id) throw new AppError(409, 'BOOKING_ALREADY_CLAIMED', 'This booking is already assigned to another operator'); const booking = await store.claimBooking(existing.id, req.user!.id); assert(booking, 409, 'BOOKING_ALREADY_CLAIMED', 'This booking is already assigned to another operator'); await store.audit('admin.booking_claimed', { ...clientMeta(req), userId: req.user!.id, metadata: { bookingId: existing.id } }); res.json({ booking }); });
  app.post('/api/v1/admin/bookings/:id/release', requireInternalOperator(store, 'booking.update'), async (req, res) => { const existing = await store.findBooking(String(req.params.id)); assert(existing, 404, 'BOOKING_NOT_FOUND', 'Booking not found'); const booking = await store.releaseBooking(existing.id, req.user!.id, isPrivileged(req)); assert(booking, 403, 'BOOKING_OWNER_REQUIRED', 'Only the assigned operator can release this booking'); await store.audit('admin.booking_released', { ...clientMeta(req), userId: req.user!.id, metadata: { bookingId: existing.id } }); res.json({ booking }); });
  app.patch('/api/v1/admin/bookings/:id', requireInternalOperator(store, 'booking.update'), async (req, res) => { const input = toInput(adminBookingPatchRequest, req.body); const existing = await store.findBooking(String(req.params.id)); assert(existing, 404, 'BOOKING_NOT_FOUND', 'Booking not found'); assert(isPrivileged(req) || existing.ownerId === req.user!.id, 403, 'BOOKING_OWNER_REQUIRED', 'Claim this booking before changing it'); if (input.ownerId !== undefined) { assertPrivileged(req); if (input.ownerId) { const assignee = await store.findUserById(input.ownerId); assert(assignee && ['manager', 'admin', 'super_admin', 'support', 'content_manager', 'finance'].includes(assignee.role) && assignee.status === 'active', 400, 'INVALID_ASSIGNEE', 'Choose an active admin or operator'); } } if (input.status && input.status !== existing.status) { assert(bookingTransitions[existing.status].includes(input.status), 409, 'INVALID_BOOKING_TRANSITION', `A ${existing.status} booking cannot move directly to ${input.status}`); } const action = input.ownerId !== undefined ? 'assignee_changed' : input.request !== undefined ? 'request_updated' : input.status ? 'status_changed' : 'note_added'; const booking = await store.updateAdminBooking(existing.id, { status: input.status, internalNote: input.internalNote, ownerId: input.ownerId, request: input.request }, req.user!.id, action); assert(booking, 404, 'BOOKING_NOT_FOUND', 'Booking not found'); await store.audit('admin.booking_updated', { ...clientMeta(req), userId: req.user!.id, metadata: { bookingId: existing.id, previousStatus: existing.status, status: input.status, previousOwnerId: existing.ownerId, ownerId: input.ownerId } }); res.json({ booking, history: await store.listBookingEvents(existing.id) }); });

  app.get('/api/v1/admin/tickets', requireFinePermission(store, 'support.view'), async (req, res) => res.json({ tickets: await store.listSupportTickets({ source: 'support', status: ['open','pending','in_progress','waiting_customer','resolved','closed'].includes(String(req.query.status)) ? String(req.query.status) as any : 'all', q: req.query.q ? String(req.query.q) : undefined }) }));
  app.get('/api/v1/admin/tickets/:id', requireFinePermission(store, 'support.view'), async (req, res) => { const ticket = await store.findSupportTicket(String(req.params.id)); assert(ticket, 404, 'TICKET_NOT_FOUND', 'Support ticket not found'); res.json({ ticket, messages: await store.listSupportMessages(ticket.id) }); });
  app.patch('/api/v1/admin/tickets/:id', requireFinePermission(store, 'support.view'), async (req, res) => { const input = toInput(supportPatchRequest, req.body); if (input.assignedTo) { const assignee = await store.findUserById(input.assignedTo); assert(assignee && ['manager','admin','super_admin','support'].includes(assignee.role) && assignee.status === 'active', 400, 'INVALID_ASSIGNEE', 'Choose an active support operator'); } const ticket = await store.updateSupportTicket(String(req.params.id), input); assert(ticket, 404, 'TICKET_NOT_FOUND', 'Support ticket not found'); await store.audit('admin.ticket_updated', { ...clientMeta(req), userId: req.user!.id, metadata: { ticketId: ticket.id, status: ticket.status, priority: ticket.priority, assignedTo: ticket.assignedTo } }); res.json({ ticket }); });
  app.post('/api/v1/admin/tickets/:id/messages', requireFinePermission(store, 'support.reply'), async (req, res) => { const input = toInput(supportMessageRequest, req.body); const ticket = await store.findSupportTicket(String(req.params.id)); assert(ticket, 404, 'TICKET_NOT_FOUND', 'Support ticket not found'); const message = await store.createSupportMessage({ ticketId: ticket.id, authorId: req.user!.id, authorType: 'admin', message: input.message, internal: input.internal }); await store.audit('admin.ticket_message_added', { ...clientMeta(req), userId: req.user!.id, metadata: { ticketId: ticket.id, internal: input.internal } }); res.status(201).json({ message }); });

  app.get('/api/v1/admin/content', requireFinePermission(store, 'content.view'), async (req, res) => { const type = contentTypeSchema.safeParse(String(req.query.type || '')); const status = contentStatusSchema.safeParse(String(req.query.status || '')); res.json({ content: await store.listContent({ type: type.success ? type.data : 'all', status: status.success ? status.data : 'all', q: req.query.q ? String(req.query.q) : undefined, includeArchived: true }) }); });
  app.post('/api/v1/admin/content', requireFinePermission(store, 'offer.create'), async (req, res) => { const input = toInput(contentInputSchema, req.body); const item = await store.createContent({ ...input, createdBy: req.user!.id }); await store.audit('admin.content_created', { ...clientMeta(req), userId: req.user!.id, metadata: { contentId: item.id, type: item.type } }); res.status(201).json({ content: item }); });
  app.patch('/api/v1/admin/content/:id', requireFinePermission(store, 'offer.update'), async (req, res) => { const input = toInput(contentPatchSchema, req.body); const item = await store.updateContent(String(req.params.id), input); assert(item, 404, 'CONTENT_NOT_FOUND', 'Content item not found'); await store.audit('admin.content_updated', { ...clientMeta(req), userId: req.user!.id, metadata: { contentId: item.id, type: item.type } }); res.json({ content: item }); });
  app.delete('/api/v1/admin/content/:id', requireFinePermission(store, 'offer.delete'), async (req, res) => { const item = await store.archiveContent(String(req.params.id)); assert(item, 404, 'CONTENT_NOT_FOUND', 'Content item not found'); await store.audit('admin.content_archived', { ...clientMeta(req), userId: req.user!.id, metadata: { contentId: item.id } }); res.json({ content: item }); });
  app.post('/api/v1/admin/content/:id/publish', requireFinePermission(store, 'offer.update'), async (req,res)=>{ const content=await store.updateContent(String(req.params.id),{status:'published'}); assert(content,404,'CONTENT_NOT_FOUND','Content item not found'); await store.audit('admin.content_published',{...clientMeta(req),userId:req.user!.id,metadata:{contentId:content.id}}); res.json({content}); });
  app.post('/api/v1/admin/content/:id/unpublish', requireFinePermission(store, 'offer.update'), async (req,res)=>{ const content=await store.updateContent(String(req.params.id),{status:'draft'}); assert(content,404,'CONTENT_NOT_FOUND','Content item not found'); await store.audit('admin.content_unpublished',{...clientMeta(req),userId:req.user!.id,metadata:{contentId:content.id}}); res.json({content}); });
  app.post('/api/v1/admin/content/:id/restore', requireFinePermission(store, 'offer.update'), async (req,res)=>{ const content=await store.updateContent(String(req.params.id),{status:'draft'}); assert(content,404,'CONTENT_NOT_FOUND','Content item not found'); await store.audit('admin.content_restored',{...clientMeta(req),userId:req.user!.id,metadata:{contentId:content.id}}); res.json({content}); });
  app.delete('/api/v1/admin/content/:id/permanent', requireFinePermission(store, 'offer.delete'), async (req,res)=>{ const current=await store.findContent(String(req.params.id)); assert(current?.status==='archived',409,'CONTENT_NOT_ARCHIVED','Archive content before permanent deletion'); const deleted=await store.deleteContent(String(req.params.id)); assert(deleted,404,'CONTENT_NOT_FOUND','Content item not found'); await store.audit('admin.content_deleted',{...clientMeta(req),userId:req.user!.id,metadata:{contentId:String(req.params.id)}}); res.status(204).send(); });

  app.get('/api/v1/admin/media', requireFinePermission(store, 'media.view'), async (req, res) => res.json(await store.listMediaAssets({ q: req.query.q ? String(req.query.q) : undefined, folder: req.query.folder ? String(req.query.folder) : undefined, status: req.query.status === 'active' || req.query.status === 'archived' || req.query.status === 'failed' ? req.query.status : 'all', page: Number(req.query.page) || 1, pageSize: Number(req.query.pageSize) || 24 })));
  app.post('/api/v1/admin/media', requireFinePermission(store, 'media.upload'), rateLimit('media-upload', 20, 60), mediaUpload.single('file'), async (req, res) => { assert(req.file, 400, 'IMAGE_REQUIRED', 'Choose an image to upload'); const folder = toInput(mediaFolderSchema, String(req.body.folder || 'general')); const altText = typeof req.body.altText === 'string' ? req.body.altText : undefined; const uploaded = await media.upload(req.file.buffer, { folder, originalFilename: req.file.originalname, declaredMime: req.file.mimetype, altText }); let asset; try { asset = await store.createMediaAsset({ ...uploaded, status: 'active', uploadedBy: req.user!.id }); } catch (error) { await media.delete(uploaded.publicId).catch(() => undefined); throw error; } await store.audit('admin.media_uploaded', { ...clientMeta(req), userId: req.user!.id, metadata: { mediaId: asset.id, publicId: asset.publicId, folder: asset.folder } }); res.status(201).json({ media: asset }); });
  app.post('/api/v1/admin/media/batch', requireFinePermission(store, 'media.upload'), rateLimit('media-batch-upload', 10, 60), mediaUpload.array('files', 10), async (req, res) => { const files = Array.isArray(req.files) ? req.files : []; assert(files.length > 0, 400, 'IMAGE_REQUIRED', 'Choose one or more images to upload'); const folder = toInput(mediaFolderSchema, String(req.body.folder || 'general')); const assets = []; for (const file of files) { const uploaded = await media.upload(file.buffer, { folder, originalFilename: file.originalname, declaredMime: file.mimetype, altText: typeof req.body.altText === 'string' ? req.body.altText : undefined }); try { assets.push(await store.createMediaAsset({ ...uploaded, status: 'active', uploadedBy: req.user!.id })); } catch (error) { await media.delete(uploaded.publicId).catch(() => undefined); throw error; } } await store.audit('admin.media_batch_uploaded', { ...clientMeta(req), userId: req.user!.id, metadata: { count: assets.length, folder } }); res.status(201).json({ media: assets }); });
  app.patch('/api/v1/admin/media/:id', requireFinePermission(store, 'media.upload'), async (req, res) => { const input = toInput(mediaPatchSchema, req.body); const asset = await store.updateMediaAsset(String(req.params.id), input); assert(asset, 404, 'MEDIA_NOT_FOUND', 'Media asset not found'); await store.audit('admin.media_updated', { ...clientMeta(req), userId: req.user!.id, metadata: { mediaId: asset.id, status: input.status } }); res.json({ media: asset }); });
  app.post('/api/v1/admin/media/:id/replace', requireFinePermission(store, 'media.upload'), rateLimit('media-replace', 20, 60), mediaUpload.single('file'), async (req, res) => { assert(req.file, 400, 'IMAGE_REQUIRED', 'Choose an image to upload'); const current = await store.findMediaAsset(String(req.params.id)); assert(current, 404, 'MEDIA_NOT_FOUND', 'Media asset not found'); const uploaded = await media.upload(req.file.buffer, { folder: current.folder.split('/').pop() || 'general', originalFilename: req.file.originalname, declaredMime: req.file.mimetype, altText: typeof req.body.altText === 'string' ? req.body.altText : current.altText }); let asset; try { asset = await store.updateMediaAsset(current.id, { ...uploaded, status: 'active' }); } catch (error) { await media.delete(uploaded.publicId).catch(() => undefined); throw error; } assert(asset, 500, 'MEDIA_UPDATE_FAILED', 'Image replacement failed'); await media.delete(current.publicId).catch(() => undefined); await store.audit('admin.media_replaced', { ...clientMeta(req), userId: req.user!.id, metadata: { mediaId: asset.id, previousPublicId: current.publicId, publicId: asset.publicId } }); res.json({ media: asset }); });
  app.delete('/api/v1/admin/media/:id', requireFinePermission(store, 'media.delete'), async (req, res) => { const current = await store.findMediaAsset(String(req.params.id)); assert(current, 404, 'MEDIA_NOT_FOUND', 'Media asset not found'); assert((await store.mediaReferenceCount(current.id)) === 0, 409, 'MEDIA_IN_USE', 'This image is still referenced by published content or a tour'); await store.updateMediaAsset(current.id, { status: 'archived' }); try { await media.delete(current.publicId); } catch { throw new AppError(502, 'MEDIA_DELETE_FAILED', 'The asset was archived but could not be removed from Cloudinary'); } await store.audit('admin.media_archived', { ...clientMeta(req), userId: req.user!.id, metadata: { mediaId: current.id, publicId: current.publicId } }); res.json({ media: await store.findMediaAsset(current.id) }); });

  app.get('/api/v1/admin/travel-agents', requireFinePermission(store, 'agent.view'), async (req,res)=>res.json(await store.listTravelAgents({q:req.query.q?String(req.query.q):undefined,status:req.query.status==='active'||req.query.status==='hidden'||req.query.status==='archived'?req.query.status:'all',department:req.query.department?String(req.query.department):undefined,featured:req.query.featured==='true'?true:req.query.featured==='false'?false:undefined,page:Number(req.query.page)||1,pageSize:Number(req.query.pageSize)||20})));
  app.get('/api/v1/admin/travel-agents/:id', requireFinePermission(store, 'agent.view'), async (req,res)=>{const agent=await store.findTravelAgent(String(req.params.id));assert(agent,404,'AGENT_NOT_FOUND','Travel agent not found');res.json({agent});});
  app.post('/api/v1/admin/travel-agents', requireFinePermission(store, 'agent.create'), async (req,res)=>{const input=toInput(agentInputSchema,req.body);const agent=await store.createTravelAgent({...input,createdBy:req.user!.id,updatedBy:req.user!.id});await store.audit('admin.travel_agent_created',{...clientMeta(req),userId:req.user!.id,metadata:{agentId:agent.id}});res.status(201).json({agent});});
  app.patch('/api/v1/admin/travel-agents/:id', requireFinePermission(store, 'agent.update'), async (req,res)=>{const input=toInput(agentPatchSchema,req.body);const previous=await store.findTravelAgent(String(req.params.id));const agent=await store.updateTravelAgent(String(req.params.id),{...input,updatedBy:req.user!.id});assert(agent,404,'AGENT_NOT_FOUND','Travel agent not found');if(previous?.mediaId && input.mediaId && previous.mediaId!==input.mediaId && (await store.mediaReferenceCount(previous.mediaId))===0){const asset=await store.findMediaAsset(previous.mediaId);if(asset){await store.updateMediaAsset(asset.id,{status:'archived'});await media.delete(asset.publicId).catch(()=>undefined);}}await store.audit('admin.travel_agent_updated',{...clientMeta(req),userId:req.user!.id,metadata:{agentId:agent.id,keys:Object.keys(input)}});res.json({agent});});
  app.delete('/api/v1/admin/travel-agents/:id', requireFinePermission(store, 'agent.delete'), async (req,res)=>{const id=String(req.params.id);const current=await store.findTravelAgent(id);assert(current,404,'AGENT_NOT_FOUND','Travel agent not found');if(req.query.hard==='true'){assert(current.status==='archived',409,'AGENT_NOT_ARCHIVED','Archive the agent before permanent deletion');const deleted=await store.deleteTravelAgent(id);assert(deleted,409,'AGENT_DELETE_FAILED','Unable to delete travel agent');if(current.mediaId && (await store.mediaReferenceCount(current.mediaId))===0){const asset=await store.findMediaAsset(current.mediaId);if(asset){await store.updateMediaAsset(asset.id,{status:'archived'});await media.delete(asset.publicId).catch(()=>undefined);}}await store.audit('admin.travel_agent_deleted',{...clientMeta(req),userId:req.user!.id,metadata:{agentId:id}});return res.json({deleted:true});}const agent=await store.archiveTravelAgent(id);assert(agent,404,'AGENT_NOT_FOUND','Travel agent not found');await store.audit('admin.travel_agent_archived',{...clientMeta(req),userId:req.user!.id,metadata:{agentId:agent.id}});res.json({agent});});

  app.get('/api/v1/admin/tours', requireFinePermission(store, 'tour.view'), async (req, res) => { const filters: TourFilters = { q: req.query.q ? String(req.query.q) : undefined, country: req.query.country ? String(req.query.country) : undefined, tourType: req.query.tourType ? String(req.query.tourType) : undefined, status: req.query.status === 'draft' || req.query.status === 'published' || req.query.status === 'archived' ? req.query.status : 'all', sort: req.query.sort === 'price_asc' || req.query.sort === 'price_desc' ? req.query.sort : 'newest' }; res.json({ tours: await store.listTours(filters) }); });
  app.post('/api/v1/admin/tours', requireFinePermission(store, 'tour.create'), async (req, res) => { const input = toInput(tourInputSchema, req.body) as CreateTour; const tour = await store.createTour({ ...input, createdBy: req.user!.id }); await store.audit('admin.tour_created', { ...clientMeta(req), userId: req.user!.id, metadata: { tourId: tour.id } }); res.status(201).json({ tour }); });
  app.post('/api/v1/admin/tours/:id/duplicate', requireFinePermission(store, 'tour.create'), async (req,res)=>{const original=await store.findTour(String(req.params.id));assert(original,404,'TOUR_NOT_FOUND','Tour package not found');const slug=`${original.slug}-copy-${Date.now().toString(36)}`.slice(0,160);const {id:_sourceId,createdAt:_createdAt,updatedAt:_updatedAt,...payload}=original;const tour=await store.createTour({...payload,slug,title:`${original.title} Copy`,status:'draft',createdBy:req.user!.id});await store.audit('admin.tour_duplicated',{...clientMeta(req),userId:req.user!.id,metadata:{sourceTourId:original.id,tourId:tour.id}});res.status(201).json({tour});});
  app.patch('/api/v1/admin/tours/:id', requireFinePermission(store, 'tour.update'), async (req, res) => { const input = toInput(tourPatchSchema, req.body) as UpdateTour; const tour = await store.updateTour(String(req.params.id), input); assert(tour, 404, 'TOUR_NOT_FOUND', 'Tour package not found'); await store.audit('admin.tour_updated', { ...clientMeta(req), userId: req.user!.id, metadata: { tourId: tour.id } }); res.json({ tour }); });
  app.delete('/api/v1/admin/tours/:id', requireFinePermission(store, 'tour.delete'), async (req, res) => { const tour = await store.archiveTour(String(req.params.id)); assert(tour, 404, 'TOUR_NOT_FOUND', 'Tour package not found'); await store.audit('admin.tour_archived', { ...clientMeta(req), userId: req.user!.id, metadata: { tourId: tour.id } }); res.json({ tour }); });

  app.post('/api/v1/admin/notifications', requireFinePermission(store, 'notifications.send'), async (req, res) => {
    const input = toInput(notificationRequest, req.body);
    if (input.allUsers) assert(input.confirmMassSend, 400, 'MASS_SEND_CONFIRMATION_REQUIRED', 'Confirm that this notification should be sent to all active users');
    const normalizedRecipient = input.identity ? normalizeIdentity(input.identity).identity : undefined;
    const recipients = input.allUsers ? await store.listUsers() : [input.userId ? await store.findUserById(input.userId) : normalizedRecipient ? await store.findUserByIdentity(normalizedRecipient) : undefined].filter(Boolean);
    assert(recipients.length > 0, 404, 'RECIPIENT_NOT_FOUND', 'No notification recipient was found');
    const sent: string[] = []; const failed: Array<{ userId: string; reason: string }> = [];
    for (const recipient of recipients) {
      const user = recipient!;
      try {
        if (input.channels.includes('sms')) { assert(user.phone, 400, 'RECIPIENT_PHONE_MISSING', 'A phone number is required for SMS delivery'); await messaging.sendNotification('sms', user.phone, input.title, input.message); }
        if (input.channels.includes('email')) { assert(user.email, 400, 'RECIPIENT_EMAIL_MISSING', 'An email address is required for email delivery'); await messaging.sendNotification('email', user.email, input.title, input.message); }
        await store.createNotification({ userId: user.id, title: input.title, message: input.message, channels: input.channels, status: 'sent', sentAt: new Date().toISOString(), createdBy: req.user!.id }); sent.push(user.id);
      } catch (error) { const reason = error instanceof Error ? error.message : 'Delivery failed'; await store.createNotification({ userId: user.id, title: input.title, message: input.message, channels: input.channels, status: 'failed', failureReason: reason, createdBy: req.user!.id }); failed.push({ userId: user.id, reason }); }
    }
    await store.audit('admin.notification_sent', { ...clientMeta(req), userId: req.user!.id, metadata: { recipients: sent.length, failed: failed.length, channels: input.channels, allUsers: input.allUsers } }); res.status(201).json({ sent: sent.length, failed: failed.length, failures: failed.slice(0, 10), channels: input.channels });
  });

  // Booking creation: tour requests are persisted for operator review; all other verticals require a live supplier adapter.
  app.post('/api/v1/bookings', requireAuth(store), async (req, res) => {
    const input = toInput(bookingRequest, req.body);
    const payload = input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload) ? input.payload as Record<string, unknown> : { value: input.payload };
    if (input.vertical === 'tour') {
      const tourPayload = toInput(tourBookingPayload, payload);
      const tour = await store.findTour(tourPayload.tourId);
      assert(tour && tour.status === 'published', 404, 'TOUR_NOT_FOUND', 'This tour package is no longer available');
      // Only persist server-derived price and the pax/date fields the operator
      // actually needs. Client-supplied totals (quotedTotal, priceBdt, total)
      // are ignored so a forged amount can never be charged later.
      const extra = (tourPayload as Record<string, any>);
      const adults = Math.max(1, Math.min(30, Number(extra.adults ?? extra.travellers ?? 1)));
      const children = Math.max(0, Math.min(20, Number(extra.children ?? 0)));
      const infants = Math.max(0, Math.min(10, Number(extra.infants ?? 0)));
      const promoCode = typeof extra.promoCode === 'string' ? extra.promoCode.trim().slice(0, 40) : undefined;
      const request = {
        tourId: tour.id,
        slug: tour.slug,
        title: tour.title,
        travellers: Math.max(1, Math.min(30, Number(extra.travellers || adults))),
        adults,
        children,
        infants,
        travelDate: tourPayload.travelDate,
        priceBdt: tour.priceBdt,
        ...(promoCode ? { promoCode } : {})
      };
      const booking = await store.createBooking({ userId: req.user!.id, vertical: 'tour', status: 'new', request });
      await store.audit('booking.created', { ...clientMeta(req), userId: req.user!.id, metadata: { bookingId: booking.id, vertical: input.vertical, workflow: 'operator_review' } });
      res.status(201).json({ booking });
      return;
    }
    throw new AppError(400, 'UNSUPPORTED_VERTICAL', 'Only tour bookings are created through this endpoint. Hotels use /hotels and other products use the cart checkout.');
  });
  app.get('/api/v1/bookings', requireAuth(store), async (req, res) => res.json({ bookings: await store.listBookings(req.user!.id) }));
  app.post('/api/v1/bookings/track', rateLimit('booking-track', 30, 60), async (req, res) => { const input = toInput(trackBookingRequest, req.body); const identity = normalizeIdentity(input.identity).identity; const booking = await store.findBookingForTracking(input.bookingReference, identity); assert(booking, 404, 'BOOKING_NOT_FOUND', 'No booking matched that reference and contact'); res.json({ booking: { id: booking.id, vertical: booking.vertical, status: booking.status, providerRef: booking.providerRef, request: booking.request, response: booking.response, createdAt: booking.createdAt, updatedAt: booking.updatedAt } }); });
  app.get('/api/v1/bookings/:id', requireAuth(store), async (req, res) => { const booking = await store.findBooking(String(req.params.id), req.user!.id); assert(booking, 404, 'BOOKING_NOT_FOUND', 'Booking not found'); res.json({ booking }); });
  app.post('/api/v1/bookings/:id/cancel', requireAuth(store), async (req, res) => { const booking = await store.findBooking(String(req.params.id), req.user!.id); assert(booking, 404, 'BOOKING_NOT_FOUND', 'Booking not found'); assert(['new','reviewing','accepted','processing','pending','confirmed'].includes(booking.status), 409, 'BOOKING_NOT_CANCELLABLE', 'This booking cannot be cancelled at its current stage'); const result: unknown = { cancelledLocally: true }; const updated = await store.updateBooking(booking.id, { status: 'cancelled', response: result }); await store.addBookingEvent({ bookingId: booking.id, actorId: req.user!.id, action: 'customer_cancelled', fromStatus: booking.status, toStatus: 'cancelled', note: (req.body as any)?.reason }); await store.audit('booking.cancelled', { ...clientMeta(req), userId: req.user!.id, metadata: { bookingId: booking.id } }); res.json({ booking: updated ?? booking }); });

  const notifyUser = async (userId: string, title: string, message: string) => { try { await store.createNotification({ userId, title, message, channels: ['in_app'], status: 'sent', sentAt: new Date().toISOString() } as any); } catch { /* notifications are best effort */ } };

  app.post('/api/v1/payments/intents', requireAuth(store), rateLimit('payment-intent', 20, 60), async (req, res) => {
    const input = toInput(paymentRequest, req.body);
    const booking = await store.findBooking(input.bookingId, req.user!.id);
    assert(booking, 404, 'BOOKING_NOT_FOUND', 'Booking not found');
    assert(!['cancelled', 'rejected', 'new', 'reviewing', 'failed'].includes(booking.status), 409, 'BOOKING_NOT_PAYABLE', 'This booking is not ready for payment');
    const quote = await trustedBookingQuote(store, booking);
    assert(quote, 409, 'BOOKING_NOT_QUOTED', 'This booking has no verified provider quote yet');
    const idempotencyKey = `intent:${booking.id}:${Date.now().toString(36)}`;
    const paymentRecord = await store.createPayment({ bookingId: booking.id, userId: req.user!.id, provider: 'configured', amount: quote.amount, currency: quote.currency, status: 'created', idempotencyKey, initiatedAt: new Date().toISOString() });
    const providerResponse: any = await payment.createIntent({ paymentId: paymentRecord.id, bookingId: booking.id, amount: quote.amount, currency: quote.currency, customerId: req.user!.id, returnUrl: `${config.appOrigin}/payment/return` });
    const updated = await store.updatePayment(paymentRecord.id, { status: providerResponse?.status === 'paid' ? 'paid' : 'pending', transactionRef: providerResponse?.transactionRef, gatewayTransactionId: providerResponse?.transactionRef, providerPayload: providerResponse });
    await trackEvent({ event: 'payment_started', userId: req.user!.id, path: `/api/v1/payments/intents`, metadata: { bookingId: booking.id, amount: quote.amount, provider: providerResponse?.provider || 'configured' } });
    res.status(201).json({ payment: updated ?? paymentRecord, checkoutUrl: providerResponse?.checkoutUrl });
  });

  // Gateway webhook / IPN. Idempotent: the same event may arrive any number of
  // times (retries, mirrored IPNs) but the ledger and the booking/order are
  // only advanced once per unique event key.
  app.post('/api/v1/payments/webhook', async (req, res) => {
    assert(await payment.verifyWebhook(req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {})), req.header('x-payment-signature')), 401, 'INVALID_WEBHOOK', 'Invalid payment webhook signature');
    const payload = req.body as { paymentId?: string; status?: string; transactionRef?: string; gatewayTransactionId?: string; failureReason?: string };
    assert(payload.paymentId && payload.status, 400, 'INVALID_WEBHOOK', 'Payment webhook payload is incomplete');
    const status = payload.status === 'paid' ? 'paid' : payload.status === 'refunded' ? 'refunded' : payload.status === 'failed' ? 'failed' : 'pending';
    const eventKey = `${payload.paymentId}:${status}:${payload.transactionRef || 'ipn'}`;
    const isNewEvent = await store.recordWebhookEvent(eventKey, { paymentId: payload.paymentId, event: status, payload });
    if (!isNewEvent) return res.json({ received: true, duplicate: true });

    const updated = await store.updatePayment(payload.paymentId, {
      status, transactionRef: payload.transactionRef, gatewayTransactionId: payload.gatewayTransactionId || payload.transactionRef,
      providerPayload: payload,
      ...(status === 'paid' ? { completedAt: new Date().toISOString() } : {}),
      ...(status === 'failed' ? { failedAt: new Date().toISOString(), failureReason: payload.failureReason || 'Payment declined by the gateway' } : {}),
      ...(status === 'refunded' ? { refundStatus: 'refunded' as const, refundedAt: new Date().toISOString() } : {})
    });
    assert(updated, 404, 'PAYMENT_NOT_FOUND', 'Payment not found');
    const eventActor = { ip: req.ip, userAgent: req.get('user-agent')?.slice(0, 500) };

    if (status === 'paid') {
      await trackEvent({ event: 'payment_success', userId: updated.userId, path: '/payment/webhook', metadata: { paymentId: updated.id, bookingId: updated.bookingId, amount: updated.amount } });
      await notifyUser(updated.userId, 'Payment successful', `We received ৳${Number(updated.amount || 0).toLocaleString('en-BD')} for your booking. Your confirmation is on the way.`);
      // The booking record may reference a commerce order (payment.bookingId is
      // the order id) or a legacy vertical booking.
      // Hotel bookings are confirmed through the hotel booking engine.
      if (updated.provider === 'hotel') {
        const hotelBooking = await hotelStore.findBooking(updated.bookingId).catch(() => undefined);
        if (hotelBooking && hotelBooking.paymentStatus !== 'paid') {
          await hotelStore.patchBookingStatus(hotelBooking.id, { status: 'confirmed', paymentStatus: 'paid' });
          await notifyUser(hotelBooking.userId, 'Booking confirmed', `Your stay at ${hotelBooking.hotelSnapshot?.name || 'the hotel'} is confirmed. Thank you for your payment.`);
          await trackEvent({ event: 'booking_confirmed', userId: hotelBooking.userId, path: '/payment/webhook', metadata: { bookingId: hotelBooking.id, bookingNumber: hotelBooking.bookingNumber } });
        }
        return res.json({ received: true });
      }
      const order = await commerce.findOrder(updated.bookingId).catch(() => undefined);
      if (order) {
        const alreadyPaid = order.paymentStatus === 'paid';
        const changed = await commerce.updateOrder(order.id, { paymentStatus: 'paid', status: 'confirmed' },
          { at: new Date().toISOString(), status: 'payment_confirmed', note: 'Payment verified by gateway webhook', actorId: 'system' });
        if (changed && !alreadyPaid) {
          await commerce.markInvoicePaid(order.id).catch(() => undefined);
          // Automatic fulfilment: request fulfilment payloads from the
          // configured provider, or leave the order FULFILLMENT_PENDING for the
          // operations desk. Never fabricates a delivery.
          await commerce.attemptFulfillment(order.id).catch(() => undefined);
          await notifyUser(order.userId, 'Booking confirmed', `Booking ${order.orderNumber} is confirmed. Check your account for the receipt and fulfilment updates.`);
          await trackEvent({ event: 'booking_confirmed', userId: order.userId, path: '/payment/webhook', metadata: { orderId: order.id, orderNumber: order.orderNumber } });
        }
        return res.json({ received: true });
      }
      const booking = await store.findBooking(updated.bookingId);
      if (booking && booking.status !== 'confirmed') {
        await store.updateBooking(booking.id, { status: 'confirmed' });
        await store.addBookingEvent({ bookingId: booking.id, action: 'payment_confirmed', fromStatus: booking.status, toStatus: 'confirmed' });
        await notifyUser(booking.userId, 'Booking confirmed', `Your ${booking.vertical} booking ${booking.id.slice(0, 8).toUpperCase()} is confirmed.`);
        await trackEvent({ event: 'booking_confirmed', userId: booking.userId, path: '/payment/webhook', metadata: { bookingId: booking.id, vertical: booking.vertical } });
      }
    } else if (status === 'failed') {
      await trackEvent({ event: 'payment_failed', userId: updated.userId, path: '/payment/webhook', metadata: { paymentId: updated.id, bookingId: updated.bookingId } });
      await notifyUser(updated.userId, 'Payment failed', 'Your payment was not completed. You can retry from your booking page.');
    }
    await store.audit('payment.webhook', { ...eventActor, metadata: { paymentId: updated.id, status, eventKey } });
    res.json({ received: true });
  });

  // Server-side return-page status for gateway redirects. Never trusts the
  // query string alone: the stored transaction is the source of truth, and
  // when a validation API is configured the gateway is asked directly.
  app.get('/api/v1/payments/return-status', async (req, res) => {
    const paymentId = String(req.query.paymentId || req.query.tran_id || '');
    assert(paymentId, 400, 'PAYMENT_ID_REQUIRED', 'A payment reference is required');
    const paymentRecord = await store.findPaymentById(paymentId);
    assert(paymentRecord, 404, 'PAYMENT_NOT_FOUND', 'Payment reference not found');
    const order = await commerce.findOrder(paymentRecord.bookingId).catch(() => undefined);
    const hotelBooking = paymentRecord.provider === 'hotel' ? await hotelStore.findBooking(paymentRecord.bookingId).catch(() => undefined) : undefined;
    res.json({
      payment: { id: paymentRecord.id, status: paymentRecord.status, transactionRef: paymentRecord.transactionRef, gatewayTransactionId: paymentRecord.gatewayTransactionId, amount: paymentRecord.amount, currency: paymentRecord.currency, failureReason: paymentRecord.failureReason, initiatedAt: paymentRecord.initiatedAt, completedAt: paymentRecord.completedAt },
      order: order ? { id: order.id, orderNumber: order.orderNumber, status: order.status, paymentStatus: order.paymentStatus, total: order.total, currency: order.currency } : undefined,
      hotelBooking: hotelBooking ? { id: hotelBooking.id, bookingNumber: hotelBooking.bookingNumber, status: hotelBooking.status, paymentStatus: hotelBooking.paymentStatus, total: hotelBooking.priceBreakdown?.total, currency: hotelBooking.priceBreakdown?.currency } : undefined
    });
  });

  app.post('/api/v1/support/tickets', optionalAuth(store), rateLimit('support', 20, 60), async (req, res) => { const input = toInput(supportRequest, req.body); const ticket = await store.createSupportTicket({ ...input, userId: req.user?.id }); await store.audit('support.ticket_created', { ...clientMeta(req), userId: req.user?.id, metadata: { ticketId: ticket.id } }); res.status(201).json({ ticket: { id: ticket.id, status: ticket.status, createdAt: ticket.createdAt } }); });

  // Hotel booking ecosystem (search, rooms, inventory, booking engine, admin).
  registerHotelRoutes(app, { store, hotelStore, media, payment });

  // SSLCommerz / SurjoPay-style initiate + return + IPN surface.
  registerPaymentGatewayRoutes(app, { store, payment, hotelStore });

  // Catalogue, cart, wishlist, coupons, orders, invoices and reviews.
  registerCommerceRoutes(app, { store, commerce, payment });

  // Website analytics (page views, searches and business conversions).
  registerAnalyticsRoutes(app, { store });

  // SEO: robots and a live sitemap built from persisted, published records.
  app.get('/robots.txt', (_req, res) => {
    res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\nDisallow: /checkout\nDisallow: /account\nDisallow: /cart\nDisallow: /wishlist\nDisallow: /orders\nSitemap: ${config.appOrigin}/sitemap.xml\n`);
  });
  app.get('/sitemap.xml', async (_req, res, next) => {
    try {
      const origin = config.appOrigin;
      const urls: string[] = ['/', '/hotels', '/homes', '/homes-villas', '/tours', '/holiday-packages', '/explore', '/travel-agents', '/track-booking', '/support'];
      const [hotels, tours, products] = await Promise.all([
        hotelStore.listHotels({ status: 'active', pageSize: 100 }).catch(() => ({ hotels: [] })),
        store.listTours({ status: 'published' }).catch(() => []),
        commerce.listCatalog({ status: 'published', pageSize: 200 }).catch(() => ({ products: [] }))
      ]);
      for (const hotel of hotels.hotels) urls.push(`/hotels/${encodeURIComponent(hotel.slug)}`);
      for (const tour of tours) urls.push(`/tours/${encodeURIComponent(tour.id)}`);
      for (const product of products.products) urls.push(`/${TYPE_ROUTE_PUBLIC[product.type] || 'explore'}/${encodeURIComponent(product.slug || product.id)}`);
      const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map(url => `<url><loc>${origin}${url.replace(/&/g, '&amp;')}</loc><changefreq>weekly</changefreq></url>`).join('')}</urlset>`;
      res.type('application/xml').send(body);
    } catch (error) { next(error); }
  });

  if (!config.serveStatic) app.get('/', (_req, res) => res.json({ service: 'Sadik Travels backend', status: 'online', health: '/healthz', ready: '/readyz' }));
  if (config.serveStatic) {
    app.get(/^\/admin(?:\/.*)?$/, (_req, res) => res.sendFile(path.join(config.publicDir, 'admin.html')));
    // The service worker must never be cached long-term or PWA updates stall.
    app.get('/sw.js', (_req, res) => { res.setHeader('Cache-Control', 'no-cache, max-age=0'); res.sendFile(path.join(config.publicDir, 'sw.js')); });
    app.get('/manifest.webmanifest', (_req, res) => { res.setHeader('Cache-Control', 'no-cache, max-age=0'); res.type('application/manifest+json'); res.sendFile(path.join(config.publicDir, 'manifest.webmanifest')); });
    app.use(express.static(config.publicDir, { index: 'index.html', maxAge: config.isProduction ? '1h' : 0 }));
    // Single page application fallback: any non-API GET that is not a static asset
    // renders the storefront shell, so deep links and refreshes always work.
    app.get(/.*/, (req, res, next) => {
      if (req.path.startsWith('/api/') || req.path.startsWith('/assets/')) return next();
      if (/\.[a-z0-9]{2,5}$/i.test(req.path)) return next();
      if (!req.accepts('html')) return next();
      res.sendFile(path.join(config.publicDir, 'index.html'));
    });
  }
  if (config.serveStatic) app.use((req, res, next) => { if (!req.path.startsWith('/api/')) return res.status(404).type('html').send(errorPageHtml(404)); next(); });
  app.use(notFound);
  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    const parseError = error instanceof SyntaxError && Number((error as any).status) === 400;
    const uploadError = error instanceof multer.MulterError;
    const normalized = error instanceof AppError ? error : error instanceof ZodError ? new AppError(400, 'VALIDATION_ERROR', 'Please check the submitted fields', error.flatten()) : uploadError && (error as any).code === 'LIMIT_FILE_SIZE' ? new AppError(413, 'IMAGE_TOO_LARGE', 'Image exceeds the maximum allowed size') : uploadError ? new AppError(400, 'IMAGE_UPLOAD_INVALID', 'Image upload failed. Please check the file and try again.') : parseError ? new AppError(400, 'INVALID_JSON', 'The request body contains invalid JSON') : new AppError(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
    if ((req as any).log) (req as any).log.error({ err: error, requestId: req.requestId, code: normalized.code }, normalized.message);
    const safeExpose = normalized.expose || SAFE_PROVIDER_ERROR_CODES.has(normalized.code);
    if (config.serveStatic && !req.path.startsWith('/api/')) return res.status(normalized.statusCode).type('html').send(errorPageHtml(normalized.statusCode));
    res.status(normalized.statusCode).json({ error: { code: normalized.code, message: safeExpose ? normalized.message : 'An unexpected error occurred', ...(safeExpose && normalized.details ? { details: normalized.details } : {}) }, requestId: req.requestId });
  });
  return { app, store, connection, liveChat: chatHub, chatHub, chatService, chatStore };
}
