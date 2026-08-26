import type { Express, Request, RequestHandler } from 'express';
import { z } from 'zod';
import { AppError } from './errors.js';
import { requireAuth } from './middleware.js';
import { rateLimit } from './rate-limit.js';
import { config } from './config.js';
import type { Store } from './store.js';
import type { PaymentProvider } from './providers.js';
import type { HotelStore } from './hotel-store.js';
import { computeTourQuote, BD_VAT_PCT, BD_AIT_PCT } from './booking-schema.js';

type GatewayPayload = Record<string, unknown>;

function isRecord(value: unknown): value is GatewayPayload {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requestBody(req: Request): GatewayPayload {
  return isRecord(req.body) ? req.body : {};
}

function requestQuery(req: Request): GatewayPayload {
  return { ...req.query };
}

function gatewayPayload(req: Request): GatewayPayload {
  return { ...requestBody(req), ...requestQuery(req) };
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    if (Array.isArray(value)) {
      const fromArray = firstText(...value);
      if (fromArray) return fromArray;
      continue;
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

function finiteNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function gatewayPaymentId(req: Request): string {
  const body = requestBody(req);
  const query = requestQuery(req);
  return firstText(body.tran_id, query.tran_id, body.paymentId, query.paymentId);
}

function authenticatedUserId(req: Request): string {
  if (!req.user?.id) throw new AppError(401, 'AUTH_REQUIRED', 'Login is required');
  return req.user.id;
}

/**
 * Bangladesh gateway surface used by the storefront:
 *   POST /api/v1/initiate-payment
 *   POST /api/v1/payment-success  (and GET for browser return)
 *   POST /api/v1/payment-fail
 *   POST /api/v1/payment-cancel
 *   POST /api/v1/payments/ipn     (SSLCommerz IPN)
 *
 * Booking rows are persisted before any redirect so a drop-off cannot lose
 * the reservation. Gateway validation is the source of truth — query strings
 * are never trusted alone.
 */
export function registerPaymentGatewayRoutes(app: Express, deps: { store: Store; payment: PaymentProvider; hotelStore: HotelStore }) {
  const { store, payment, hotelStore } = deps;

  const applyPaid = async (paymentId: string, extra: GatewayPayload = {}) => {
    const record = await store.findPaymentById(paymentId);
    if (!record) throw new AppError(404, 'PAYMENT_NOT_FOUND', 'Payment not found');
    if (record.status === 'paid') return record;
    const updated = await store.updatePayment(record.id, {
      status: 'paid',
      completedAt: new Date().toISOString(),
      transactionRef: firstText(extra.tran_id, extra.transactionRef, record.transactionRef),
      gatewayTransactionId: firstText(extra.val_id, extra.paymentID, extra.gatewayTransactionId, record.gatewayTransactionId),
      providerPayload: extra
    });
    if (record.provider === 'hotel') {
      await hotelStore.patchBookingStatus(record.bookingId, { status: 'confirmed', paymentStatus: 'paid' }).catch(() => undefined);
    } else {
      const booking = await store.findBooking(record.bookingId);
      if (booking && booking.status !== 'confirmed') await store.updateBooking(booking.id, { status: 'confirmed' });
    }
    return updated ?? record;
  };

  const applyFailed = async (paymentId: string, reason: string, extra: GatewayPayload = {}) => {
    const record = await store.findPaymentById(paymentId);
    if (!record) throw new AppError(404, 'PAYMENT_NOT_FOUND', 'Payment not found');
    if (record.status === 'paid') return record;
    return store.updatePayment(record.id, { status: 'failed', failedAt: new Date().toISOString(), failureReason: reason, providerPayload: extra }) ?? record;
  };

  const initiatePaymentHandler: RequestHandler = async (req, res, next) => {
    try {
      const input = z.object({
        bookingId: z.string().min(3),
        kind: z.enum(['hotel', 'tour', 'booking']).default('booking'),
        method: z.enum(['sslcommerz', 'bkash', 'nagad', 'rocket', 'card']).optional()
      }).parse(req.body || {});
      const userId = authenticatedUserId(req);

      if (input.kind === 'hotel') {
        const hotelBooking = await hotelStore.findBooking(input.bookingId, userId);
        if (!hotelBooking) throw new AppError(404, 'BOOKING_NOT_FOUND', 'Hotel booking not found');
        const paymentRecord = await store.createPayment({
          bookingId: hotelBooking.id,
          userId,
          provider: 'hotel',
          amount: hotelBooking.priceBreakdown.total,
          currency: hotelBooking.priceBreakdown.currency || 'BDT',
          status: 'created',
          paymentMethod: input.method || 'sslcommerz',
          initiatedAt: new Date().toISOString()
        });
        const intent = await payment.createIntent({
          paymentId: paymentRecord.id,
          bookingId: hotelBooking.id,
          amount: hotelBooking.priceBreakdown.total,
          currency: hotelBooking.priceBreakdown.currency || 'BDT',
          customerId: userId,
          returnUrl: `${config.appOrigin}/payment/return`
        });
        await store.updatePayment(paymentRecord.id, { status: 'pending', transactionRef: intent.transactionRef, providerPayload: intent });
        await hotelStore.patchBookingStatus(hotelBooking.id, { status: 'payment_pending', paymentStatus: 'pending' });
        return res.status(201).json({ success: true, checkoutUrl: intent.checkoutUrl, paymentId: paymentRecord.id, methods: ['bkash', 'nagad', 'rocket', 'visa', 'mastercard', 'amex'] });
      }

      const booking = await store.findBooking(input.bookingId, userId);
      if (!booking) throw new AppError(404, 'BOOKING_NOT_FOUND', 'Booking not found');
      const request = isRecord(booking.request) ? booking.request : {};
      // Always recompute the payable amount from the persisted tour record.
      // The browser's quotedTotal / priceBdt is never trusted as the payment
      // amount; it is only used for a consistent customer preview.
      let amount = 0;
      if (booking.vertical === 'tour') {
        const tourId = firstText(request.tourId);
        const tour = tourId ? await store.findTour(tourId) : undefined;
        if (!tour || tour.status !== 'published') throw new AppError(409, 'TOUR_NOT_AVAILABLE', 'This tour package is no longer available');
        const meta = isRecord(tour.metadata) ? tour.metadata : {};
        const adults = Math.max(1, Math.min(60, finiteNumber(firstText(request.adults) || request.travellers, 1)));
        const children = Math.max(0, Math.min(30, finiteNumber(request.children, 0)));
        const infants = Math.max(0, Math.min(15, finiteNumber(request.infants, 0)));
        const quote = computeTourQuote({
          adultPrice: Number(tour.priceBdt || 0),
          childPrice: finiteNumber(meta.childPrice) || undefined,
          infantPrice: finiteNumber(meta.infantPrice) || undefined,
          seasonSurchargePct: finiteNumber(meta.seasonSurchargePct) || undefined,
          vatPct: BD_VAT_PCT,
          aitPct: BD_AIT_PCT
        }, { adults, children, infants });
        let discount = 0;
        const promoCode = firstText(request.promoCode);
        if (promoCode && firstText(meta.promoCode).toUpperCase() === promoCode.toUpperCase()) {
          discount = Math.round(quote.baseFare * (finiteNumber(meta.promoPct, 10) / 100));
        }
        amount = Math.max(0, quote.total - discount);
      }
      if (!amount || amount <= 0) throw new AppError(409, 'BOOKING_NOT_QUOTED', 'This booking has no verified quote yet');
      const paymentRecord = await store.createPayment({
        bookingId: booking.id,
        userId,
        provider: input.method || 'sslcommerz',
        amount,
        currency: 'BDT',
        status: 'created',
        paymentMethod: input.method || 'sslcommerz',
        initiatedAt: new Date().toISOString()
      });
      const intent = await payment.createIntent({
        paymentId: paymentRecord.id,
        bookingId: booking.id,
        amount,
        currency: 'BDT',
        customerId: userId,
        returnUrl: `${config.appOrigin}/payment/return`
      });
      await store.updatePayment(paymentRecord.id, { status: 'pending', transactionRef: intent.transactionRef, providerPayload: intent });
      res.status(201).json({ success: true, checkoutUrl: intent.checkoutUrl, paymentId: paymentRecord.id, methods: ['bkash', 'nagad', 'rocket', 'visa', 'mastercard', 'amex'] });
    } catch (error) {
      next(error);
    }
  };

  app.post('/api/v1/initiate-payment', requireAuth(store), rateLimit('initiate-pay', 20, 60), initiatePaymentHandler);

  const successHandler: RequestHandler = async (req, res, next) => {
    try {
      const paymentId = gatewayPaymentId(req);
      if (!paymentId) throw new AppError(400, 'PAYMENT_ID_REQUIRED', 'A payment reference is required');
      const updated = await applyPaid(paymentId, gatewayPayload(req));
      if (req.method === 'GET' || req.accepts('html')) return res.redirect(302, `/payment/return?payment=success&paymentId=${encodeURIComponent(updated.id)}`);
      res.json({ success: true, payment: { id: updated.id, status: updated.status } });
    } catch (error) {
      next(error);
    }
  };

  const failHandler: RequestHandler = async (req, res, next) => {
    try {
      const paymentId = gatewayPaymentId(req);
      if (paymentId) await applyFailed(paymentId, 'Payment declined by gateway', gatewayPayload(req));
      if (req.method === 'GET' || req.accepts('html')) return res.redirect(302, `/payment/return?payment=failed&paymentId=${encodeURIComponent(paymentId)}`);
      res.json({ success: false, status: 'failed' });
    } catch (error) {
      next(error);
    }
  };

  const cancelHandler: RequestHandler = async (req, res, next) => {
    try {
      const paymentId = gatewayPaymentId(req);
      if (paymentId) await applyFailed(paymentId, 'Customer cancelled payment', gatewayPayload(req));
      if (req.method === 'GET' || req.accepts('html')) return res.redirect(302, `/payment/return?payment=cancelled&paymentId=${encodeURIComponent(paymentId)}`);
      res.json({ success: false, status: 'cancelled' });
    } catch (error) {
      next(error);
    }
  };

  app.post('/api/v1/payment-success', successHandler);
  app.get('/api/v1/payment-success', successHandler);
  app.post('/api/v1/payment-fail', failHandler);
  app.get('/api/v1/payment-fail', failHandler);
  app.post('/api/v1/payment-cancel', cancelHandler);
  app.get('/api/v1/payment-cancel', cancelHandler);

  const ipnHandler: RequestHandler = async (req, res, next) => {
    try {
      const payload = requestBody(req);
      const paymentId = firstText(payload.tran_id, payload.paymentId);
      const status = firstText(payload.status).toUpperCase();
      if (!paymentId) return res.status(400).json({ received: false });
      const eventKey = `ipn:${paymentId}:${status}:${firstText(payload.val_id) || 'na'}`;
      const isNew = await store.recordWebhookEvent(eventKey, { paymentId, event: status, payload });
      if (!isNew) return res.json({ received: true, duplicate: true });
      if (status === 'VALID' || status === 'VALIDATED' || status === 'SUCCESS') await applyPaid(paymentId, payload);
      else await applyFailed(paymentId, `IPN status ${status || 'unknown'}`, payload);
      res.json({ received: true });
    } catch (error) {
      next(error);
    }
  };

  app.post('/api/v1/payments/ipn', ipnHandler);

  const tourQuoteHandler: RequestHandler = async (req, res, next) => {
    try {
      const input = z.object({
        tourId: z.string().min(3),
        adults: z.number().int().min(1).max(30).default(1),
        children: z.number().int().min(0).max(20).default(0),
        infants: z.number().int().min(0).max(10).default(0),
        promoCode: z.string().max(40).optional()
      }).parse(req.body || {});
      const tour = await store.findTour(input.tourId);
      if (!tour || tour.status !== 'published') throw new AppError(404, 'TOUR_NOT_FOUND', 'Tour not found');
      const meta = isRecord(tour.metadata) ? tour.metadata : {};
      const emiMonths = Array.isArray(meta.emiMonths) ? meta.emiMonths.map(Number).filter(Number.isFinite) : undefined;
      const quote = computeTourQuote({
        adultPrice: tour.priceBdt,
        childPrice: finiteNumber(meta.childPrice) || undefined,
        infantPrice: finiteNumber(meta.infantPrice) || undefined,
        seasonSurchargePct: finiteNumber(meta.seasonSurchargePct) || undefined,
        emiMonths
      }, input);
      let discount = 0;
      if (input.promoCode && firstText(meta.promoCode).toUpperCase() === input.promoCode.toUpperCase()) {
        discount = Math.round(quote.baseFare * (finiteNumber(meta.promoPct, 10) / 100));
      }
      res.json({ success: true, tour: { id: tour.id, title: tour.title }, quote: { ...quote, discount, total: Math.max(0, quote.total - discount) } });
    } catch (error) {
      next(error);
    }
  };

  app.post('/api/v1/tours/quote', rateLimit('tour-quote', 60, 60), tourQuoteHandler);
}
