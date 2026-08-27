import { computeTourQuote, tourPricingFromRecord, type TourQuote } from './pricing.js';
import { AppError } from './errors.js';
import { config } from './config.js';
import type { Store, Tour } from './store.js';

/**
 * Sadik Travels — tour quote resolution.
 *
 * This is the *one* place a tour's payable amount is derived from the database.
 * Booking creation, the public quote endpoint and payment initiation all call
 * it, so they cannot drift apart — three near-duplicate copies of this logic is
 * exactly how a BDT 6,000 package came to be charged BDT 14,400.
 *
 * What it does, in order:
 *
 *   1. load the published tour row (never a browser-supplied price);
 *   2. read operator surcharge defaults from site settings;
 *   3. let the tour's own metadata override those defaults;
 *   4. normalize the traveller counts once (`normalizeTravellers` inside
 *      `computeTourQuote`) — a missing count is exactly 1 adult;
 *   5. validate the promo code against the tour record;
 *   6. return a breakdown whose lines sum to the total.
 *
 * Nothing here reads `req`. A caller cannot smuggle an amount in.
 */

export type TourSurchargeSettings = { vatPct?: number; aitPct?: number; serviceFeePct?: number; seasonSurchargePct?: number };

/** Deployment defaults. Absent settings mean "no charge" — never an implicit tax. */
export function surchargeSettingsFromConfig(): TourSurchargeSettings {
  return { vatPct: config.tourVatPct, aitPct: config.tourAitPct, serviceFeePct: config.tourServiceFeePct };
}

async function settingNumber(store: Store, key: string, fallback: number): Promise<number> {
  const raw = await store.getSetting(key).catch(() => undefined);
  const parsed = Number(raw);
  if (raw === undefined || raw === '' || !Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(100, parsed));
}

/**
 * Operator-configured surcharge defaults: site settings override the
 * environment, and a tour's own metadata overrides both (handled by
 * `tourPricingFromRecord`).
 */
export async function resolveTourSurchargeSettings(store: Store): Promise<TourSurchargeSettings> {
  const base = surchargeSettingsFromConfig();
  const [vatPct, aitPct, serviceFeePct, seasonSurchargePct] = await Promise.all([
    settingNumber(store, 'tour_vat_pct', base.vatPct ?? 0),
    settingNumber(store, 'tour_ait_pct', base.aitPct ?? 0),
    settingNumber(store, 'tour_service_fee_pct', base.serviceFeePct ?? 0),
    settingNumber(store, 'tour_season_surcharge_pct', base.seasonSurchargePct ?? 0)
  ]);
  return { vatPct, aitPct, serviceFeePct, seasonSurchargePct };
}

export type ResolvedTourQuote = {
  tour: Tour;
  quote: TourQuote;
  /** Renderable rows for the checkout price breakdown. */
  breakdown: Array<{ label: string; amount: number; detail?: string }>;
  /** Same numbers as `quote`, shaped for the storefront and receipts. */
  summary: {
    currency: 'BDT';
    unitPrice: number;
    adults: number;
    children: number;
    infants: number;
    travellerCount: number;
    subtotal: number;
    discount: number;
    tax: number;
    serviceFee: number;
    total: number;
  };
};

/**
 * @param store    the data store
 * @param tourId   persisted tour id (required)
 * @param pax      traveller counts chosen by the customer
 * @param promoCode promo code typed by the customer
 */
export async function resolveTourQuote(
  store: Store,
  tourId: string,
  pax: { adults?: number; children?: number; infants?: number } = {},
  promoCode?: string
): Promise<ResolvedTourQuote> {
  if (!tourId) throw new AppError(400, 'TOUR_ID_REQUIRED', 'A tour package must be selected');
  const tour = await store.findTour(tourId);
  if (!tour || tour.status !== 'published') throw new AppError(404, 'TOUR_NOT_AVAILABLE', 'This tour package is no longer available');

  const settings = await resolveTourSurchargeSettings(store);
  const quote = computeTourQuote(tourPricingFromRecord(tour, settings), pax, promoCode);

  return {
    tour,
    quote,
    breakdown: quote.lines.map(line => ({ label: line.label, amount: line.amount, detail: line.detail })),
    summary: {
      currency: 'BDT',
      unitPrice: quote.adultUnit,
      adults: quote.adults,
      children: quote.children,
      infants: quote.infants,
      travellerCount: quote.travellerCount,
      subtotal: quote.subtotal,
      discount: quote.discount,
      tax: quote.tax,
      serviceFee: quote.serviceFee,
      total: quote.total
    }
  };
}

/**
 * Re-derive the payable amount for an existing tour booking.
 *
 * Used at payment time: the amount charged is recalculated from the tour row
 * and the pax stored on the booking, never taken from the booking's own
 * snapshot or from anything the browser sent. If the tour was withdrawn after
 * the booking was made, payment is refused rather than charged at a stale
 * price.
 */
export async function resolveBookingTourAmount(store: Store, bookingRequest: Record<string, unknown>): Promise<{ amount: number; resolved: ResolvedTourQuote }> {
  const tourId = String(bookingRequest.tourId || '');
  const resolved = await resolveTourQuote(store, tourId, {
    adults: Number(bookingRequest.adults ?? bookingRequest.travellers ?? 1),
    children: Number(bookingRequest.children ?? 0),
    infants: Number(bookingRequest.infants ?? 0)
  }, typeof bookingRequest.promoCode === 'string' ? bookingRequest.promoCode : undefined);

  if (!(resolved.quote.total > 0)) {
    throw new AppError(409, 'BOOKING_NOT_QUOTED', 'This booking has no verified price yet. Please contact support.');
  }
  return { amount: resolved.quote.total, resolved };
}

/** Payment methods offered for a tour booking. */
export const TOUR_PAYMENT_METHODS = ['online', 'cod'] as const;
export type TourPaymentMethod = (typeof TOUR_PAYMENT_METHODS)[number];

export function normalizeTourPaymentMethod(value: unknown): TourPaymentMethod {
  const raw = String(value || '').trim().toLowerCase();
  if (['cod', 'cash', 'pay_later', 'paylater', 'pay_at_office'].includes(raw)) return 'cod';
  return 'online';
}

/** Customer-facing label used on receipts and in emails. */
export function tourPaymentMethodLabel(method: string): string {
  return method === 'cod' ? 'Cash / pay later' : 'Online payment';
}
