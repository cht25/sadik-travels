import type { Express, Request, RequestHandler } from 'express';
import { z } from 'zod';
import { AppError } from './errors.js';
import { requireAuth } from './middleware.js';
import { rateLimit } from './rate-limit.js';
import { config } from './config.js';
import type { Store, User } from './store.js';
import type { PaymentProvider } from './providers.js';
import type { HotelStore } from './hotel-store.js';
import { formatBdt } from './pricing.js';
import { resolveTourQuote, resolveBookingTourAmount, normalizeTourPaymentMethod, tourPaymentMethodLabel } from './tour-quotes.js';
import { NOTIFICATION_EVENT } from './notifications/events.js';
import type { NotificationService, NotificationRecipient } from './notifications/service.js';
import { bookingReceivedEmail, paymentResultEmail, staffBookingEmail } from './notifications/templates.js';

type GatewayPayload = Record<string, unknown>;

function isRecord(value: unknown): value is GatewayPayload {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requestBody(req: Request): GatewayPayload {
  return isRecord(req.body) ? req.body : {};
}

function requestQuery(req: Request): GatewayPayload {
  return { ...req.query } as GatewayPayload;
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

function gatewayPaymentId(req: Request): string {
  const body = requestBody(req);
  const query = requestQuery(req);
  return firstText(body.tran_id, query.tran_id, body.paymentId, query.paymentId);
}

function authenticatedUserId(req: Request): string {
  if (!req.user?.id) throw new AppError(401, 'AUTH_REQUIRED', 'Login is required');
  return req.user.id;
}

export type PaymentGatewayDeps = {
  store: Store;
  payment: PaymentProvider;
  hotelStore: HotelStore;
  notifications: NotificationService;
};

/**
 * Bangladesh gateway surface used by the storefront:
 *   POST /api/v1/initiate-payment
 *   POST /api/v1/payment-success  (and GET for browser return)
 *   POST /api/v1/payment-fail
 *   POST /api/v1/payment-cancel
 *   POST /api/v1/payments/ipn     (SSLCommerz IPN)
 *
 * Payment safety rules enforced here:
 *
 *   - **the amount is never taken from the browser.** A tour payment re-derives
 *     its amount from the persisted tour row and the traveller counts stored on
 *     the booking (`resolveBookingTourAmount`);
 *   - **a browser redirect is not proof of payment.** `payment-success` asks the
 *     gateway to validate the transaction (or checks the HMAC signature) before
 *     anything is marked paid. Without a verification path it leaves the
 *     payment pending and waits for the signed webhook;
 *   - **cash/pay-later bookings are never marked paid.** They stay PENDING with
 *     `paymentMethod: cod` until an operator confirms the money was received;
 *   - booking rows are persisted before any redirect, so a drop-off cannot lose
 *     the reservation.
 */
export function registerPaymentGatewayRoutes(app: Express, deps: PaymentGatewayDeps) {
  const { store, payment, hotelStore, notifications } = deps;

  /** Resolve the customer so emails/push have a name and an address. */
  const customerOf = async (userId: string): Promise<User | undefined> => store.findUserById(userId).catch(() => undefined);

  const applyPaid = async (paymentId: string, extra: GatewayPayload = {}, opts: { source: 'webhook' | 'gateway_validation' | 'signed_callback' } = { source: 'webhook' }) => {
    const record = await store.findPaymentById(paymentId);
    if (!record) throw new AppError(404, 'PAYMENT_NOT_FOUND', 'Payment not found');
    if (record.status === 'paid') return { record, changed: false };

    const updated = await store.updatePayment(record.id, {
      status: 'paid',
      completedAt: new Date().toISOString(),
      transactionRef: firstText(extra.tran_id, extra.transactionRef, record.transactionRef),
      gatewayTransactionId: firstText(extra.val_id, extra.paymentID, extra.gatewayTransactionId, record.gatewayTransactionId),
      providerPayload: extra
    });
    const paid = updated ?? record;
    const verifiedAt = new Date().toISOString();

    let serviceName = 'your booking';
    let serviceKind = 'Booking';
    let dates: string | undefined;
    let guests: string | undefined;
    let bookingId: string | undefined;
    let route = '/payments';
    const ownerRecipients: NotificationRecipient[] = [];

    if (record.provider === 'hotel') {
      const hotelBooking = await hotelStore.findBooking(record.bookingId).catch(() => undefined);
      if (hotelBooking && hotelBooking.paymentStatus !== 'paid') {
        await hotelStore.patchBookingStatus(hotelBooking.id, { status: 'confirmed', paymentStatus: 'paid' });
        serviceName = hotelBooking.hotelSnapshot?.name || 'your hotel';
        serviceKind = 'Hotel booking';
        dates = `${hotelBooking.checkIn} → ${hotelBooking.checkOut}`;
        guests = `${hotelBooking.rooms.reduce((sum, room) => sum + room.quantity, 0)} room(s), ${hotelBooking.nights} night(s)`;
        bookingId = hotelBooking.id;
        route = `/orders/${hotelBooking.id}`;
        const hotel = await hotelStore.adminFindHotel(hotelBooking.hotelId).catch(() => undefined);
        // Owner is resolved from the persisted hotel record, never from input,
        // so an owner can never be told about another owner's booking.
        if (hotel?.ownerId) ownerRecipients.push({ userId: hotel.ownerId, audience: 'hotel_owner' });
      }
    } else {
      const booking = await store.findBooking(record.bookingId);
      if (booking) {
        bookingId = booking.id;
        route = `/orders/${booking.id}`;
        if (booking.status !== 'confirmed') {
          await store.updateBooking(booking.id, { status: 'confirmed' });
          await store.addBookingEvent({ bookingId: booking.id, action: 'payment_confirmed', fromStatus: booking.status, toStatus: 'confirmed' });
        }
        const request = isRecord(booking.request) ? booking.request : {};
        serviceName = firstText(request.title, request.slug) || 'your tour package';
        serviceKind = 'Tour booking';
        dates = firstText(request.travelDate);
        const adults = Number(request.adults ?? request.travellers ?? 1);
        const children = Number(request.children ?? 0);
        const infants = Number(request.infants ?? 0);
        guests = `${adults} adult(s)${children ? `, ${children} child(ren)` : ''}${infants ? `, ${infants} infant(s)` : ''}`;
      }
    }

    await store.audit('payment.confirmed', {
      userId: record.userId,
      metadata: { paymentId: record.id, bookingId: record.bookingId, amount: record.amount, source: opts.source, verifiedAt }
    });

    const facts = {
      reference: bookingId ? bookingId.slice(0, 8).toUpperCase() : paid.id.slice(0, 8).toUpperCase(),
      serviceName,
      serviceKind,
      dates,
      guests,
      total: paid.amount,
      currency: paid.currency,
      paymentStatus: 'paid',
      bookingStatus: 'CONFIRMED',
      paymentMethod: tourPaymentMethodLabel(paid.paymentMethod || 'online'),
      url: `${config.appOrigin}${route}`
    };

    await notifications.emit({
      event: NOTIFICATION_EVENT.PAYMENT_SUCCESS,
      title: 'Payment received',
      message: `We received ${formatBdt(paid.amount, paid.currency)} for ${serviceName}. Your booking is confirmed.`,
      context: { bookingId, route },
      recipients: [
        { userId: record.userId, audience: 'customer' },
        ...(await notifications.adminRecipients(NOTIFICATION_EVENT.PAYMENT_SUCCESS)),
        ...ownerRecipients
      ],
      email: paymentResultEmail({ ...facts, succeeded: true, transactionRef: paid.gatewayTransactionId || paid.transactionRef, paidAt: new Date(verifiedAt) }),
      push: { tag: `payment-${paid.id}` }
    }).catch(error => console.error('[payments] confirmation notification failed', error));

    return { record: paid, changed: true };
  };

  const applyFailed = async (paymentId: string, reason: string, extra: GatewayPayload = {}) => {
    const record = await store.findPaymentById(paymentId);
    if (!record) throw new AppError(404, 'PAYMENT_NOT_FOUND', 'Payment not found');
    if (record.status === 'paid') return record;
    const updated = await store.updatePayment(record.id, { status: 'failed', failedAt: new Date().toISOString(), failureReason: reason, providerPayload: extra });
    const failed = updated ?? record;
    await notifications.emit({
      event: NOTIFICATION_EVENT.PAYMENT_FAILED,
      title: 'Payment could not be completed',
      message: `Your payment of ${formatBdt(failed.amount, failed.currency)} was not completed: ${reason}. You can retry from your booking page.`,
      context: { bookingId: failed.bookingId, route: '/payments' },
      recipients: [{ userId: failed.userId, audience: 'customer' }, ...(await notifications.adminRecipients(NOTIFICATION_EVENT.PAYMENT_FAILED))],
      email: paymentResultEmail({
        reference: failed.bookingId.slice(0, 8).toUpperCase(),
        serviceName: 'your booking',
        serviceKind: 'Booking',
        total: failed.amount,
        currency: failed.currency,
        paymentStatus: 'failed',
        bookingStatus: 'PENDING',
        succeeded: false,
        failureReason: reason,
        url: `${config.appOrigin}/payments`
      })
    }).catch(error => console.error('[payments] failure notification failed', error));
    return failed;
  };

  const initiatePaymentHandler: RequestHandler = async (req, res, next) => {
    try {
      const input = z.object({
        bookingId: z.string().min(3),
        kind: z.enum(['hotel', 'tour', 'booking']).default('booking'),
        method: z.enum(['sslcommerz', 'bkash', 'nagad', 'rocket', 'card', 'online', 'cod']).optional()
      }).parse(req.body || {});
      const userId = authenticatedUserId(req);
      const method = normalizeTourPaymentMethod(input.method);

      /* ------------------------------------------------ cash / pay later */
      if (method === 'cod') {
        const record = await createCodReservation({ store, hotelStore, userId, kind: input.kind, bookingId: input.bookingId });
        await notifyCodReservation({ store, hotelStore, notifications, userId, kind: input.kind, bookingId: input.bookingId, amount: record.amount, currency: record.currency });
        return res.status(201).json({
          success: true,
          paymentMethod: 'cod',
          paymentStatus: 'pending',
          requiresPayment: false,
          message: 'Booking created. Nothing has been charged — you will pay later.',
          amount: record.amount,
          currency: record.currency
        });
      }

      /* ------------------------------------------------------ hotel order */
      if (input.kind === 'hotel') {
        const hotelBooking = await hotelStore.findBooking(input.bookingId, userId);
        if (!hotelBooking) throw new AppError(404, 'BOOKING_NOT_FOUND', 'Hotel booking not found');
        const amount = hotelBooking.priceBreakdown.total;
        const currency = hotelBooking.priceBreakdown.currency || 'BDT';
        const paymentRecord = await store.createPayment({
          bookingId: hotelBooking.id, userId, provider: 'hotel', amount, currency,
          status: 'created', paymentMethod: input.method || 'sslcommerz', initiatedAt: new Date().toISOString()
        });
        const intent = await payment.createIntent({ paymentId: paymentRecord.id, bookingId: hotelBooking.id, amount, currency, customerId: userId, returnUrl: `${config.appOrigin}/payment/return` });
        await store.updatePayment(paymentRecord.id, { status: 'pending', transactionRef: intent.transactionRef, providerPayload: intent });
        await hotelStore.patchBookingStatus(hotelBooking.id, { status: 'payment_pending', paymentStatus: 'pending' });
        return res.status(201).json({ success: true, checkoutUrl: intent.checkoutUrl, paymentId: paymentRecord.id, amount, currency, methods: ['bkash', 'nagad', 'rocket', 'visa', 'mastercard', 'amex'] });
      }

      /* ------------------------------------------------------- tour order */
      const booking = await store.findBooking(input.bookingId, userId);
      if (!booking) throw new AppError(404, 'BOOKING_NOT_FOUND', 'Booking not found');
      const request = isRecord(booking.request) ? booking.request : {};

      // The amount charged is re-derived from the database here, at payment
      // time. `quotedTotal`, `priceBdt` and any other browser value are ignored.
      let amount = 0;
      if (booking.vertical === 'tour') {
        amount = (await resolveBookingTourAmount(store, request)).amount;
      }
      if (!amount || amount <= 0) throw new AppError(409, 'BOOKING_NOT_QUOTED', 'This booking has no verified quote yet');

      const paymentRecord = await store.createPayment({
        bookingId: booking.id, userId, provider: input.method || 'sslcommerz',
        amount, currency: 'BDT', status: 'created', paymentMethod: input.method || 'sslcommerz', initiatedAt: new Date().toISOString()
      });
      const intent = await payment.createIntent({ paymentId: paymentRecord.id, bookingId: booking.id, amount, currency: 'BDT', customerId: userId, returnUrl: `${config.appOrigin}/payment/return` });
      await store.updatePayment(paymentRecord.id, { status: 'pending', transactionRef: intent.transactionRef, providerPayload: intent });
      res.status(201).json({ success: true, checkoutUrl: intent.checkoutUrl, paymentId: paymentRecord.id, amount, currency: 'BDT', methods: ['bkash', 'nagad', 'rocket', 'visa', 'mastercard', 'amex'] });
    } catch (error) {
      next(error);
    }
  };

  app.post('/api/v1/initiate-payment', requireAuth(store), rateLimit('initiate-pay', 20, 60), initiatePaymentHandler);

  /**
   * Gateway return endpoint.
   *
   * Reaching this URL means the *browser* came back — not that money moved.
   * The payment is only marked paid when one of these holds:
   *   1. the request carries a valid HMAC signature for the raw body, or
   *   2. the gateway's own validation API confirms the transaction.
   * Otherwise the payment stays pending and the signed webhook/IPN settles it.
   */
  const confirmFromCallback = async (req: Request, paymentId: string): Promise<'paid' | 'pending' | 'failed'> => {
    const record = await store.findPaymentById(paymentId);
    if (!record) throw new AppError(404, 'PAYMENT_NOT_FOUND', 'Payment not found');
    if (record.status === 'paid') return 'paid';

    const signature = req.header('x-payment-signature');
    if (signature) {
      const raw = (req as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
      if (await payment.verifyWebhook(raw, signature)) {
        await applyPaid(paymentId, gatewayPayload(req), { source: 'signed_callback' });
        return 'paid';
      }
    }

    const verification = await payment.validateTransaction({
      paymentId: record.id,
      valId: firstText(gatewayPayload(req).val_id, gatewayPayload(req).val_id),
      gatewayTransactionId: firstText(gatewayPayload(req).paymentID, gatewayPayload(req).gateway_ref, record.transactionRef),
      amount: record.amount,
      currency: record.currency
    });

    if (verification.verdict === 'verified') {
      await applyPaid(paymentId, { ...gatewayPayload(req), ...(verification.payload || {}) }, { source: 'gateway_validation' });
      return 'paid';
    }
    if (verification.verdict === 'failed') {
      await applyFailed(paymentId, verification.detail || `Gateway reported ${verification.gatewayStatus || 'failure'}`, gatewayPayload(req));
      return 'failed';
    }
    // No verification path available: do NOT mark paid. Stay pending.
    return 'pending';
  };

  const successHandler: RequestHandler = async (req, res, next) => {
    try {
      const paymentId = gatewayPaymentId(req);
      if (!paymentId) throw new AppError(400, 'PAYMENT_ID_REQUIRED', 'A payment reference is required');
      const outcome = await confirmFromCallback(req, paymentId);
      if (req.method === 'GET' || req.accepts('html')) {
        return res.redirect(302, `/payment/return?payment=${outcome}&paymentId=${encodeURIComponent(paymentId)}`);
      }
      res.json({ success: outcome === 'paid', status: outcome });
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

  /**
   * SSLCommerz IPN. Idempotent (deduplicated on a persisted event key) and
   * verified: when `PAYMENT_WEBHOOK_SECRET` is configured, an unsigned IPN is
   * rejected rather than trusted.
   */
  const ipnHandler: RequestHandler = async (req, res, next) => {
    try {
      const payload = requestBody(req);
      const paymentId = firstText(payload.tran_id, payload.paymentId);
      const status = firstText(payload.status).toUpperCase();
      if (!paymentId) return res.status(400).json({ received: false });

      if (config.paymentWebhookSecret) {
        const raw = (req as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
        const valid = await payment.verifyWebhook(raw, req.header('x-payment-signature'));
        if (!valid) {
          await store.audit('payment.ipn_rejected', { ip: req.ip, metadata: { paymentId, reason: 'INVALID_SIGNATURE' } });
          return res.status(401).json({ received: false, error: 'INVALID_SIGNATURE' });
        }
      }

      const eventKey = `ipn:${paymentId}:${status}:${firstText(payload.val_id) || 'na'}`;
      const isNew = await store.recordWebhookEvent(eventKey, { paymentId, event: status, payload });
      if (!isNew) return res.json({ received: true, duplicate: true });

      if (['VALID', 'VALIDATED', 'SUCCESS'].includes(status)) {
        await applyPaid(paymentId, payload);
      } else {
        await applyFailed(paymentId, `IPN status ${status || 'unknown'}`, payload);
      }
      res.json({ received: true });
    } catch (error) {
      next(error);
    }
  };

  app.post('/api/v1/payments/ipn', ipnHandler);

  /**
   * Public price quote.
   *
   * Returns the same numbers the payment will charge, including the line-by-line
   * breakdown the checkout renders, so what the customer sees is what is billed.
   */
  const tourQuoteHandler: RequestHandler = async (req, res, next) => {
    try {
      const input = z.object({
        tourId: z.string().min(3),
        adults: z.number().int().min(1).max(30).default(1),
        children: z.number().int().min(0).max(20).default(0),
        infants: z.number().int().min(0).max(10).default(0),
        promoCode: z.string().max(40).optional()
      }).parse(req.body || {});

      const resolved = await resolveTourQuote(store, input.tourId, input, input.promoCode);
      const quote = resolved.quote;

      res.json({
        success: true,
        tour: { id: resolved.tour.id, title: resolved.tour.title, durationDays: resolved.tour.durationDays, durationNights: resolved.tour.durationNights },
        quote: {
          ...quote,
          baseFare: quote.baseFare,
          discount: quote.discount,
          total: quote.total,
          lines: resolved.breakdown,
          summary: resolved.summary
        }
      });
    } catch (error) {
      next(error);
    }
  };

  app.post('/api/v1/tours/quote', rateLimit('tour-quote', 60, 60), tourQuoteHandler);
}

/* -------------------------------------------------------------------------- */

/**
 * Create the ledger row for a cash / pay-later reservation.
 *
 * The payment is created `pending` with `paymentMethod: cod`. It is never
 * created as `paid`: an operator must confirm the money was received.
 */
async function createCodReservation(deps: { store: Store; hotelStore: HotelStore; userId: string; kind: 'hotel' | 'tour' | 'booking'; bookingId: string }): Promise<{ amount: number; currency: string }> {
  const { store, hotelStore, userId, kind, bookingId } = deps;

  if (kind === 'hotel') {
    const hotelBooking = await hotelStore.findBooking(bookingId, userId);
    if (!hotelBooking) throw new AppError(404, 'BOOKING_NOT_FOUND', 'Hotel booking not found');
    const amount = hotelBooking.priceBreakdown.total;
    const currency = hotelBooking.priceBreakdown.currency || 'BDT';
    await store.createPayment({
      bookingId: hotelBooking.id, userId, provider: 'hotel', amount, currency,
      status: 'pending', paymentMethod: 'cod', initiatedAt: new Date().toISOString()
    });
    await hotelStore.patchBookingStatus(hotelBooking.id, { paymentStatus: 'pending' });
    return { amount, currency };
  }

  const booking = await store.findBooking(bookingId, userId);
  if (!booking) throw new AppError(404, 'BOOKING_NOT_FOUND', 'Booking not found');
  const request = isRecord(booking.request) ? booking.request : {};
  const amount = booking.vertical === 'tour' ? (await resolveBookingTourAmount(store, request)).amount : 0;
  if (!(amount > 0)) throw new AppError(409, 'BOOKING_NOT_QUOTED', 'This booking has no verified price yet');
  await store.createPayment({
    bookingId: booking.id, userId, provider: 'cod', amount, currency: 'BDT',
    status: 'pending', paymentMethod: 'cod', initiatedAt: new Date().toISOString()
  });
  // Keep the booking visible for operations, but never `confirmed` until paid.
  if (booking.status === 'new') await store.updateBooking(booking.id, { status: 'pending' });
  return { amount, currency: 'BDT' };
}

/** Notify customer + operations that a pay-later booking needs attention. */
async function notifyCodReservation(deps: {
  store: Store; hotelStore: HotelStore; notifications: NotificationService;
  userId: string; kind: 'hotel' | 'tour' | 'booking'; bookingId: string; amount: number; currency: string;
}): Promise<void> {
  const { store, hotelStore, notifications, userId, kind, bookingId, amount, currency } = deps;
  const customer = await store.findUserById(userId).catch(() => undefined);
  const reference = bookingId.slice(0, 8).toUpperCase();
  const money = formatBdt(amount, currency);

  let serviceName = 'your booking';
  let serviceKind = 'Booking';
  let dates: string | undefined;
  let guests: string | undefined;
  let route = `/orders/${bookingId}`;
  const ownerRecipients: NotificationRecipient[] = [];

  if (kind === 'hotel') {
    const hotelBooking = await hotelStore.findBooking(bookingId, userId).catch(() => undefined);
    if (hotelBooking) {
      serviceName = hotelBooking.hotelSnapshot?.name || 'your hotel';
      serviceKind = 'Hotel booking';
      dates = `${hotelBooking.checkIn} → ${hotelBooking.checkOut}`;
      guests = `${hotelBooking.rooms.reduce((sum, room) => sum + room.quantity, 0)} room(s), ${hotelBooking.nights} night(s)`;
      const hotel = await hotelStore.adminFindHotel(hotelBooking.hotelId).catch(() => undefined);
      if (hotel?.ownerId) ownerRecipients.push({ userId: hotel.ownerId, audience: 'hotel_owner' });
    }
  } else {
    const booking = await store.findBooking(bookingId, userId).catch(() => undefined);
    const request = booking && isRecord(booking.request) ? booking.request : {};
    serviceName = firstText(request.title, request.slug) || 'your tour package';
    serviceKind = 'Tour booking';
    dates = firstText(request.travelDate);
    guests = `${Number(request.adults ?? request.travellers ?? 1)} traveller(s)`;
  }

  const facts = {
    reference, serviceName, serviceKind, dates, guests,
    total: amount, currency,
    paymentStatus: 'pending',
    bookingStatus: 'PENDING_PAYMENT',
    paymentMethod: 'Cash / pay later',
    url: `${config.appOrigin}${route}`,
    customerName: customer?.fullName,
    customerEmail: customer?.email,
    customerPhone: customer?.phone
  };

  await notifications.emit({
    event: NOTIFICATION_EVENT.PAYMENT_PENDING_COD,
    title: 'Booking created — payment pending',
    message: `Your ${serviceKind.toLowerCase()} ${reference} is created for ${money}. Nothing has been charged; our team will contact you to arrange payment.`,
    context: { bookingId, route },
    recipients: [
      { userId, audience: 'customer' },
      ...(await notifications.adminRecipients(NOTIFICATION_EVENT.PAYMENT_PENDING_COD)),
      ...ownerRecipients
    ],
    email: user => (user.id === userId
      ? bookingReceivedEmail(facts)
      : staffBookingEmail({ ...facts, audience: user.role === 'hotel_owner' ? 'Hotel owner' : 'Operations team' })),
    push: { tag: `cod-${bookingId}` }
  }).catch(error => console.error('[payments] COD notification failed', error));
}

