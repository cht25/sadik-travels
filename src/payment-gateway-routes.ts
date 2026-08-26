import type { Express } from 'express';
import { z } from 'zod';
import { AppError } from './errors.js';
import { requireAuth } from './middleware.js';
import { rateLimit } from './rate-limit.js';
import { config } from './config.js';
import type { Store } from './store.js';
import type { PaymentProvider } from './providers.js';
import type { HotelStore } from './hotel-store.js';
import { computeTourQuote, BD_VAT_PCT, BD_AIT_PCT } from './booking-schema.js';

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

  const applyPaid = async (paymentId: string, extra: Record<string, unknown> = {}) => {
    const record = await store.findPaymentById(paymentId);
    if (!record) throw new AppError(404, 'PAYMENT_NOT_FOUND', 'Payment not found');
    if (record.status === 'paid') return record;
    const updated = await store.updatePayment(record.id, {
      status: 'paid',
      completedAt: new Date().toISOString(),
      transactionRef: String(extra.tran_id || extra.transactionRef || record.transactionRef || ''),
      gatewayTransactionId: String(extra.val_id || extra.paymentID || extra.gatewayTransactionId || record.gatewayTransactionId || ''),
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

  const applyFailed = async (paymentId: string, reason: string, extra: Record<string, unknown> = {}) => {
    const record = await store.findPaymentById(paymentId);
    if (!record) throw new AppError(404, 'PAYMENT_NOT_FOUND', 'Payment not found');
    if (record.status === 'paid') return record;
    return store.updatePayment(record.id, { status: 'failed', failedAt: new Date().toISOString(), failureReason: reason, providerPayload: extra }) ?? record;
  };

  app.post('/api/v1/initiate-payment', requireAuth(store), rateLimit('initiate-pay', 20, 60), async (req, res, next) => {
    try {
      const input = z.object({
        bookingId: z.string().min(3),
        kind: z.enum(['hotel', 'tour', 'booking']).default('booking'),
        method: z.enum(['sslcommerz', 'bkash', 'nagad', 'rocket', 'card']).optional()
      }).parse(req.body || {});
      const userId = (req as any).user.id;

      if (input.kind === 'hotel') {
        const hotelBooking = await hotelStore.findBooking(input.bookingId, userId);
        if (!hotelBooking) throw new AppError(404, 'BOOKING_NOT_FOUND', 'Hotel booking not found');
        const paymentRecord = await store.createPayment({
          bookingId: hotelBooking.id, userId, provider: 'hotel',
          amount: hotelBooking.priceBreakdown.total, currency: hotelBooking.priceBreakdown.currency || 'BDT',
          status: 'created', paymentMethod: input.method || 'sslcommerz', initiatedAt: new Date().toISOString()
        });
        const intent: any = await payment.createIntent({
          paymentId: paymentRecord.id, bookingId: hotelBooking.id, amount: hotelBooking.priceBreakdown.total,
          currency: hotelBooking.priceBreakdown.currency || 'BDT', customerId: userId,
          returnUrl: `${config.appOrigin}/payment/return`
        });
        await store.updatePayment(paymentRecord.id, { status: 'pending', transactionRef: intent?.transactionRef, providerPayload: intent });
        await hotelStore.patchBookingStatus(hotelBooking.id, { status: 'payment_pending', paymentStatus: 'pending' });
        return res.status(201).json({ success: true, checkoutUrl: intent?.checkoutUrl, paymentId: paymentRecord.id, methods: ['bkash', 'nagad', 'rocket', 'visa', 'mastercard', 'amex'] });
      }

      const booking = await store.findBooking(input.bookingId, userId);
      if (!booking) throw new AppError(404, 'BOOKING_NOT_FOUND', 'Booking not found');
      const request = (booking.request && typeof booking.request === 'object') ? booking.request as Record<string, any> : {};
      // Always recompute the payable amount from the persisted tour record.
      // The browser's quotedTotal / priceBdt is never trusted as the payment
      // amount; it is only used for a consistent customer preview.
      let amount = 0;
      if (booking.vertical === 'tour') {
        const tour = request.tourId ? await store.findTour(String(request.tourId)) : undefined;
        if (!tour || tour.status !== 'published') throw new AppError(409, 'TOUR_NOT_AVAILABLE', 'This tour package is no longer available');
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
        amount = Math.max(0, quote.total - discount);
      }
      if (!amount || amount <= 0) throw new AppError(409, 'BOOKING_NOT_QUOTED', 'This booking has no verified quote yet');
      const paymentRecord = await store.createPayment({
        bookingId: booking.id, userId, provider: input.method || 'sslcommerz',
        amount, currency: 'BDT', status: 'created', paymentMethod: input.method || 'sslcommerz', initiatedAt: new Date().toISOString()
      });
      const intent: any = await payment.createIntent({
        paymentId: paymentRecord.id, bookingId: booking.id, amount, currency: 'BDT', customerId: userId,
        returnUrl: `${config.appOrigin}/payment/return`
      });
      await store.updatePayment(paymentRecord.id, { status: 'pending', transactionRef: intent?.transactionRef, providerPayload: intent });
      res.status(201).json({ success: true, checkoutUrl: intent?.checkoutUrl, paymentId: paymentRecord.id, methods: ['bkash', 'nagad', 'rocket', 'visa', 'mastercard', 'amex'] });
    } catch (error) { next(error); }
  });

  const successHandler = async (req: any, res: any, next: any) => {
    try {
      const paymentId = String(req.body?.tran_id || req.query.tran_id || req.body?.paymentId || req.query.paymentId || '');
      if (!paymentId) throw new AppError(400, 'PAYMENT_ID_REQUIRED', 'A payment reference is required');
      const updated = await applyPaid(paymentId, { ...req.body, ...req.query });
      if (req.method === 'GET' || req.accepts('html')) return res.redirect(302, `/payment/return?payment=success&paymentId=${encodeURIComponent(updated.id)}`);
      res.json({ success: true, payment: { id: updated.id, status: updated.status } });
    } catch (error) { next(error); }
  };
  const failHandler = async (req: any, res: any, next: any) => {
    try {
      const paymentId = String(req.body?.tran_id || req.query.tran_id || req.body?.paymentId || req.query.paymentId || '');
      if (paymentId) await applyFailed(paymentId, 'Payment declined by gateway', { ...req.body, ...req.query });
      if (req.method === 'GET' || req.accepts('html')) return res.redirect(302, `/payment/return?payment=failed&paymentId=${encodeURIComponent(paymentId)}`);
      res.json({ success: false, status: 'failed' });
    } catch (error) { next(error); }
  };
  const cancelHandler = async (req: any, res: any, next: any) => {
    try {
      const paymentId = String(req.body?.tran_id || req.query.tran_id || req.body?.paymentId || req.query.paymentId || '');
      if (paymentId) await applyFailed(paymentId, 'Customer cancelled payment', { ...req.body, ...req.query });
      if (req.method === 'GET' || req.accepts('html')) return res.redirect(302, `/payment/return?payment=cancelled&paymentId=${encodeURIComponent(paymentId)}`);
      res.json({ success: false, status: 'cancelled' });
    } catch (error) { next(error); }
  };

  app.post('/api/v1/payment-success', successHandler);
  app.get('/api/v1/payment-success', successHandler);
  app.post('/api/v1/payment-fail', failHandler);
  app.get('/api/v1/payment-fail', failHandler);
  app.post('/api/v1/payment-cancel', cancelHandler);
  app.get('/api/v1/payment-cancel', cancelHandler);

  app.post('/api/v1/payments/ipn', async (req, res, next) => {
    try {
      const paymentId = String(req.body?.tran_id || req.body?.paymentId || '');
      const status = String(req.body?.status || '').toUpperCase();
      if (!paymentId) return res.status(400).json({ received: false });
      const eventKey = `ipn:${paymentId}:${status}:${req.body?.val_id || 'na'}`;
      const isNew = await store.recordWebhookEvent(eventKey, { paymentId, event: status, payload: req.body });
      if (!isNew) return res.json({ received: true, duplicate: true });
      if (status === 'VALID' || status === 'VALIDATED' || status === 'SUCCESS') await applyPaid(paymentId, req.body);
      else await applyFailed(paymentId, `IPN status ${status || 'unknown'}`, req.body);
      res.json({ received: true });
    } catch (error) { next(error); }
  });

  app.post('/api/v1/tours/quote', rateLimit('tour-quote', 60, 60), async (req, res, next) => {
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
      const meta = (tour.metadata || {}) as Record<string, any>;
      const quote = computeTourQuote({
        adultPrice: tour.priceBdt,
        childPrice: Number(meta.childPrice) || undefined,
        infantPrice: Number(meta.infantPrice) || undefined,
        seasonSurchargePct: Number(meta.seasonSurchargePct) || undefined,
        emiMonths: Array.isArray(meta.emiMonths) ? meta.emiMonths.map(Number) : undefined
      }, input);
      let discount = 0;
      if (input.promoCode && String(meta.promoCode || '').toUpperCase() === input.promoCode.toUpperCase()) {
        discount = Math.round(quote.baseFare * (Number(meta.promoPct || 10) / 100));
      }
      res.json({ success: true, tour: { id: tour.id, title: tour.title }, quote: { ...quote, discount, total: Math.max(0, quote.total - discount) } });
    } catch (error) { next(error); }
  });
}
