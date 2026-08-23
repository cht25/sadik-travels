import type { Express, Request } from 'express';
import { z, ZodError } from 'zod';
import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { AppError } from './errors.js';
import { optionalAuth, requireFinePermission } from './middleware.js';
import { rateLimit } from './rate-limit.js';

/**
 * Website analytics (add-on module).
 *
 * Tracks meaningful business events only — a page_view is a route render, not a
 * conversion. Conversions (search, checkout_started, payment_success,
 * booking_created, ...) are counted as their own events and reported separately,
 * so refresh spam never inflates business metrics.
 *
 * Events are stored in MongoDB (`analytics_events`) with a stable UUID, session
 * and optional user id, so the admin console can report unique visitors, page
 * views, devices, popular pages and conversion rates without external services.
 */

export const ANALYTICS_EVENTS = [
  'page_view', 'search', 'hotel_view', 'tour_view',
  'product_view', 'add_to_cart', 'wishlist', 'checkout_started', 'payment_started',
  'payment_success', 'payment_failed', 'booking_created', 'booking_confirmed',
  'support_ticket_created', 'agent_view', 'coupon_applied'
] as const;
export type AnalyticsEventName = typeof ANALYTICS_EVENTS[number];

export type AnalyticsRecord = {
  id: string; event: AnalyticsEventName; userId?: string; sessionId: string;
  path: string; referrer?: string; device: 'desktop' | 'tablet' | 'mobile';
  ip?: string; userAgent?: string; country?: string;
  metadata: Record<string, unknown>; createdAt: string;
};

const { Schema, model, models } = mongoose;
const AnalyticsModel = models.SadikAnalyticsEvent || model('SadikAnalyticsEvent', new Schema({
  id: { type: String, required: true, unique: true, index: true },
  event: { type: String, required: true, index: true },
  userId: { type: String, index: true },
  sessionId: { type: String, index: true },
  path: { type: String, index: true },
  referrer: String,
  device: String,
  ip: String,
  userAgent: String,
  country: String,
  metadata: { type: Schema.Types.Mixed, default: {} },
  createdAt: { type: String, index: true }
}, { versionKey: false, collection: 'analytics_events' }), 'analytics_events');
AnalyticsModel.schema.index({ createdAt: 1, event: 1 });
AnalyticsModel.schema.index({ sessionId: 1, createdAt: 1 });

const now = () => new Date().toISOString();

const eventSchema = z.object({
  event: z.enum(ANALYTICS_EVENTS as unknown as [AnalyticsEventName, ...AnalyticsEventName[]]),
  path: z.string().max(500).default('/'),
  referrer: z.string().max(1000).optional(),
  metadata: z.record(z.unknown()).default({})
}).superRefine((value, ctx) => {
  const keys = Object.keys(value.metadata || {});
  if (keys.length > 20) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['metadata'], message: 'Metadata can have at most 20 keys' });
  const serialized = JSON.stringify(value.metadata || {});
  if (serialized.length > 4000) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['metadata'], message: 'Metadata is too large' });
});

const toInput = (schema: z.ZodTypeAny, value: unknown) => {
  try { return schema.parse(value); } catch (error) {
    if (error instanceof ZodError) throw new AppError(400, 'VALIDATION_ERROR', 'Please check the submitted fields', error.flatten());
    throw error;
  }
};

const deviceFromUserAgent = (userAgent = ''): AnalyticsRecord['device'] => {
  if (/iPad|Tablet|Silk/i.test(userAgent)) return 'tablet';
  if (/Mobi|Android|iPhone|BlackBerry|Opera Mini|IEMobile/i.test(userAgent)) return 'mobile';
  return 'desktop';
};

/** Insert an analytics event. Failures are swallowed — analytics must never break the storefront. */
export async function trackEvent(input: {
  event: AnalyticsEventName; sessionId?: string; userId?: string; path?: string;
  referrer?: string; ip?: string; userAgent?: string; metadata?: Record<string, unknown>;
}) {
  try {
    const record: AnalyticsRecord = {
      id: randomUUID(), event: input.event, sessionId: input.sessionId || 'anonymous',
      userId: input.userId, path: String(input.path || '/').slice(0, 500),
      referrer: input.referrer ? String(input.referrer).slice(0, 1000) : undefined,
      device: deviceFromUserAgent(input.userAgent),
      ip: input.ip, userAgent: input.userAgent ? String(input.userAgent).slice(0, 500) : undefined,
      metadata: input.metadata || {}, createdAt: now()
    };
    await AnalyticsModel.create(record);
  } catch { /* best effort */ }
}

export type AnalyticsRange = 'today' | '7d' | '30d' | '90d' | 'year' | 'custom';
export type AnalyticsReport = {
  range: AnalyticsRange; from: string; to: string;
  summary: { visitors: number; pageViews: number; searches: number; bookingsCreated: number; bookingsConfirmed: number; paymentsStarted: number; paymentsSuccess: number; paymentsFailed: number; conversionRate: number; paymentConversionRate: number };
  topPages: Array<{ path: string; views: number; visitors: number }>;
  topEvents: Array<{ event: string; count: number }>;
  deviceBreakdown: Array<{ device: string; count: number }>;
  trend: Array<{ day: string; pageViews: number; visitors: number; conversions: number }>;
};

function startOfRange(range: AnalyticsRange, from?: string, to?: string): { from: string; to: string } {
  const end = to ? new Date(`${to}T23:59:59`) : new Date();
  const start = new Date(end);
  if (range === 'today') start.setHours(0, 0, 0, 0);
  else if (range === '7d') start.setDate(start.getDate() - 6);
  else if (range === '30d') start.setDate(start.getDate() - 29);
  else if (range === '90d') start.setDate(start.getDate() - 89);
  else if (range === 'year') start.setFullYear(start.getFullYear() - 1);
  else if (from) start.setTime(new Date(`${from}T00:00:00`).getTime());
  return { from: start.toISOString(), to: end.toISOString() };
}

const dayKey = (iso: string) => iso.slice(0, 10);

export async function analyticsReport(range: AnalyticsRange, from?: string, to?: string): Promise<AnalyticsReport> {
  const { from: fromIso, to: toIso } = startOfRange(range, from, to);
  const query = { createdAt: { $gte: fromIso, $lte: toIso } };
  const events = await AnalyticsModel.find(query).lean().exec() as Array<Record<string, any>>;

  const visitors = new Set<string>();
  const pages = new Map<string, { views: number; visitors: Set<string> }>();
  const eventsByName = new Map<string, number>();
  const devices = new Map<string, number>();
  const trendMap = new Map<string, { pageViews: number; visitors: Set<string>; conversions: number }>();
  const counts = { pageViews: 0, searches: 0, bookingsCreated: 0, bookingsConfirmed: 0, paymentsStarted: 0, paymentsSuccess: 0, paymentsFailed: 0 };

  for (const event of events) {
    const session = String(event.sessionId || 'anonymous');
    visitors.add(session);
    const day = dayKey(String(event.createdAt || ''));
    const bucket = trendMap.get(day) || { pageViews: 0, visitors: new Set<string>(), conversions: 0 };
    bucket.visitors.add(session);
    if (event.event === 'page_view') { counts.pageViews += 1; bucket.pageViews += 1; }
    if (event.event === 'search') counts.searches += 1;
    if (event.event === 'booking_created') { counts.bookingsCreated += 1; bucket.conversions += 1; }
    if (event.event === 'booking_confirmed') counts.bookingsConfirmed += 1;
    if (event.event === 'payment_started') counts.paymentsStarted += 1;
    if (event.event === 'payment_success') { counts.paymentsSuccess += 1; bucket.conversions += 1; }
    if (event.event === 'payment_failed') counts.paymentsFailed += 1;
    eventsByName.set(event.event, (eventsByName.get(event.event) || 0) + 1);
    devices.set(event.device || 'desktop', (devices.get(event.device || 'desktop') || 0) + 1);
    const page = pages.get(event.path) || { views: 0, visitors: new Set<string>() };
    page.views += 1; page.visitors.add(session); pages.set(event.path, page);
  }

  const totalSessions = Math.max(1, visitors.size);
  const conversions = counts.bookingsCreated + counts.paymentsSuccess;
  return {
    range, from: fromIso, to: toIso,
    summary: {
      visitors: visitors.size,
      pageViews: counts.pageViews,
      searches: counts.searches,
      bookingsCreated: counts.bookingsCreated,
      bookingsConfirmed: counts.bookingsConfirmed,
      paymentsStarted: counts.paymentsStarted,
      paymentsSuccess: counts.paymentsSuccess,
      paymentsFailed: counts.paymentsFailed,
      conversionRate: Math.round((conversions / totalSessions) * 1000) / 10,
      paymentConversionRate: counts.paymentsStarted > 0 ? Math.round((counts.paymentsSuccess / counts.paymentsStarted) * 1000) / 10 : 0
    },
    topPages: [...pages.entries()].map(([path, value]) => ({ path, views: value.views, visitors: value.visitors.size })).sort((a, b) => b.views - a.views).slice(0, 12),
    topEvents: [...eventsByName.entries()].map(([event, count]) => ({ event, count })).sort((a, b) => b.count - a.count).slice(0, 20),
    deviceBreakdown: [...devices.entries()].map(([device, count]) => ({ device, count })).sort((a, b) => b.count - a.count),
    trend: [...trendMap.entries()].map(([day, value]) => ({ day, pageViews: value.pageViews, visitors: value.visitors.size, conversions: value.conversions })).sort((a, b) => a.day.localeCompare(b.day))
  };
}

export function registerAnalyticsRoutes(app: Express, deps: { store: any }) {
  const { store } = deps;

  // Public, low-priority tracking endpoint. Never blocks the page and never
  // accepts anything beyond the whitelist of business events.
  app.post('/api/v1/analytics/track', rateLimit('analytics-track', 240, 60), optionalAuth(store), async (req, res) => {
    const input = toInput(eventSchema, req.body);
    await trackEvent({
      event: input.event, sessionId: String(req.header('x-session-id') || req.query.session || 'anonymous').slice(0, 120),
      userId: (req as any).user?.id, path: input.path, referrer: input.referrer,
      ip: req.ip, userAgent: req.get('user-agent'), metadata: input.metadata
    });
    res.status(202).json({ accepted: true });
  });

  // Admin analytics report. Guarded by the reports/dashboard permission.
  app.get('/api/v1/admin/analytics', requireFinePermission(store, 'reports.view'), async (req, res, next) => {
    try {
      const range = ['today', '7d', '30d', '90d', 'year', 'custom'].includes(String(req.query.range)) ? String(req.query.range) as AnalyticsRange : '30d';
      const from = String(req.query.from || '');
      const to = String(req.query.to || '');
      res.json({ report: await analyticsReport(range, from, to) });
    } catch (error) { next(error); }
  });
}
