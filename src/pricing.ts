/**
 * Sadik Travels — single source of truth for payable amounts.
 *
 * Why this file exists
 * --------------------
 * A BDT 6,000 tour was being charged BDT 14,400 at checkout. The chain was
 * audited end to end and produced two independent, compounding defects:
 *
 *   1. HIDDEN QUANTITY DEFAULT. The tour checkout form rendered
 *      `<input id="tourAdults" value="2">`, so a customer who wanted one
 *      traveller was silently priced for two: 6,000 × 2 = 12,000.
 *   2. SILENT SURCHARGES. `computeTourQuote` hard-defaulted to
 *      `vatPct = 15` and `aitPct = 5` for *every* tour, whether or not the
 *      operator had configured any tax: 12,000 + 1,800 + 600 = 14,400.
 *
 *   6,000 → ×2 (hidden quantity) → +20% (undisclosed tax) → 14,400.
 *
 * Both are fixed here and in the storefront form:
 *   - the traveller count always defaults to exactly 1 and is clamped once,
 *     in one place, before it ever reaches a multiplication;
 *   - surcharges are opt-in. A percentage is applied only when an operator
 *     explicitly configured it (tour metadata or a site setting). Nothing is
 *     charged that is not named in `lines` and therefore visible at checkout.
 *
 * Rules enforced by this module (and asserted by `assertQuoteConsistent`):
 *   - every component is applied exactly once — no double multiplication;
 *   - `lines` sums to `total`, so the breakdown shown to the customer is the
 *     amount that is charged, never a cosmetic approximation;
 *   - discounts are clamped to the subtotal and can never make a total
 *     negative;
 *   - the browser never contributes to a number here. Callers pass database
 *     values only.
 */

import { AppError } from './errors.js';

/**
 * Bangladesh VAT (15%) and Advance Income Tax (5%) as *reference* rates.
 * They are deliberately NOT applied by default: an operator must opt in per
 * tour (`metadata.vatPct` / `metadata.aitPct`) or per deployment
 * (`tour_vat_pct` / `tour_ait_pct` site settings) for them to appear.
 */
export const BD_VAT_PCT = 15;
export const BD_AIT_PCT = 5;

/** Children default to 70% of the adult fare when no child price is set. */
export const DEFAULT_CHILD_PRICE_FACTOR = 0.7;

export const DEFAULT_TOUR_TRAVELLERS = 1;
export const MAX_TOUR_ADULTS = 30;
export const MAX_TOUR_CHILDREN = 20;
export const MAX_TOUR_INFANTS = 10;

export type SurchargeRule = {
  /** Machine key, e.g. `vat`. */
  key: string;
  /** Customer-facing label, e.g. `VAT`. */
  label: string;
  /** Percentage applied to the taxable subtotal. 0 means "not charged". */
  pct: number;
};

export type TourPricingConfig = {
  /** Persisted per-person price from the `tours` collection. */
  adultPrice: number;
  childPrice?: number;
  infantPrice?: number;
  /** Peak-season surcharge percentage (operator configured). */
  seasonSurchargePct?: number;
  /** Service fee percentage (operator configured). */
  serviceFeePct?: number;
  /** Explicit tax percentage; defaults to 0 (no charge). */
  vatPct?: number;
  /** Explicit AIT percentage; defaults to 0 (no charge). */
  aitPct?: number;
  /** Extra surcharge rules applied after VAT/AIT, in order. */
  surcharges?: SurchargeRule[];
  /** Promo code the tour accepts, and its discount percentage off the base fare. */
  promoCode?: string;
  promoPct?: number;
  /** EMI tenors to quote. Purely informational — never part of `total`. */
  emiMonths?: number[];
};

export type TourTravellers = { adults?: number; children?: number; infants?: number };

export type PriceLine = {
  key: string;
  label: string;
  /** Positive = added, negative = subtracted. */
  amount: number;
  /** Human explanation, e.g. `6,000 × 2 adults`. Shown at checkout. */
  detail?: string;
};

export type TourQuote = {
  currency: 'BDT';
  adults: number;
  children: number;
  infants: number;
  /** Total travellers the price is for (adults + children + infants). */
  travellerCount: number;
  adultUnit: number;
  childUnit: number;
  infantUnit: number;
  /** adultUnit × adults + childUnit × children + infantUnit × infants. */
  baseFare: number;
  seasonSurcharge: number;
  serviceFee: number;
  vat: number;
  ait: number;
  /** Every surcharge other than VAT/AIT, already summed. */
  extraSurcharges: number;
  subtotal: number;
  discount: number;
  /** vat + ait + extraSurcharges. */
  tax: number;
  total: number;
  /** Effective rates actually applied, so the UI can show "VAT 15%" honestly. */
  vatPct: number;
  aitPct: number;
  serviceFeePct: number;
  seasonSurchargePct: number;
  /** Renderable, order-stable breakdown. Sums exactly to `total`. */
  lines: PriceLine[];
  emi: Array<{ months: number; installment: number }>;
  /** True when the promo code in the request matched the tour's code. */
  promoApplied: boolean;
  promoCode?: string;
};

/** Integer taka. Money is never carried as a float through a calculation. */
export function roundTaka(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value);
}

function finite(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function pct(value: unknown): number {
  const parsed = finite(value, 0);
  // Negative percentages would silently *reduce* a charge; reject them.
  return Math.max(0, Math.min(100, parsed));
}

/**
 * Clamp a traveller count once, in one place.
 *
 * This is the fix for the hidden-quantity defect: the count is normalised here
 * and every caller uses the result, so no code path can multiply by a second,
 * differently-defaulted count. A missing/invalid count is exactly 1 adult.
 */
export function normalizeTravellers(input: TourTravellers = {}): { adults: number; children: number; infants: number; travellerCount: number } {
  const adults = Math.max(1, Math.min(MAX_TOUR_ADULTS, Math.trunc(finite(input.adults, DEFAULT_TOUR_TRAVELLERS)) || DEFAULT_TOUR_TRAVELLERS));
  const children = Math.max(0, Math.min(MAX_TOUR_CHILDREN, Math.trunc(finite(input.children, 0)) || 0));
  const infants = Math.max(0, Math.min(MAX_TOUR_INFANTS, Math.trunc(finite(input.infants, 0)) || 0));
  return { adults, children, infants, travellerCount: adults + children + infants };
}

/**
 * Compute the payable amount for a tour from persisted data only.
 *
 * @param cfg    pricing sourced from the database (tour record + settings)
 * @param pax    traveller counts chosen by the customer
 * @param promoCode promo code typed by the customer (validated against `cfg`)
 */
export function computeTourQuote(cfg: TourPricingConfig, pax: TourTravellers = {}, promoCode?: string): TourQuote {
  const { adults, children, infants, travellerCount } = normalizeTravellers(pax);

  const adultUnit = roundTaka(cfg.adultPrice);
  const childUnit = roundTaka(cfg.childPrice ?? cfg.adultPrice * DEFAULT_CHILD_PRICE_FACTOR);
  const infantUnit = roundTaka(cfg.infantPrice ?? 0);

  const adultFare = adultUnit * adults;
  const childFare = childUnit * children;
  const infantFare = infantUnit * infants;
  const baseFare = roundTaka(adultFare + childFare + infantFare);

  const lines: PriceLine[] = [];
  const pushLine = (key: string, label: string, amount: number, detail?: string) => {
    if (amount === 0) return;
    lines.push({ key, label, amount, detail });
  };

  if (adults > 0) pushLine('adults', `Adults (${adults})`, adultFare, `${adultFare.toLocaleString('en-BD')} total`);
  if (children > 0) pushLine('children', `Children (${children})`, childFare, `${childUnit.toLocaleString('en-BD')} each`);
  if (infants > 0) pushLine('infants', `Infants (${infants})`, infantFare, `${infantUnit.toLocaleString('en-BD')} each`);

  const seasonSurchargePct = pct(cfg.seasonSurchargePct);
  const seasonSurcharge = roundTaka(baseFare * (seasonSurchargePct / 100));
  if (seasonSurchargePct > 0) pushLine('season', `Season surcharge (${seasonSurchargePct}%)`, seasonSurcharge);

  // Taxable base is the fare plus the season surcharge — counted once.
  const taxable = baseFare + seasonSurcharge;

  const vatPct = pct(cfg.vatPct);
  const aitPct = pct(cfg.aitPct);
  const vat = roundTaka(taxable * (vatPct / 100));
  const ait = roundTaka(taxable * (aitPct / 100));
  if (vatPct > 0) pushLine('vat', `VAT (${vatPct}%)`, vat);
  if (aitPct > 0) pushLine('ait', `AIT (${aitPct}%)`, ait);

  const extraSurcharges: Array<{ key: string; label: string; amount: number; pct: number }> = [];
  for (const rule of cfg.surcharges || []) {
    const rulePct = pct(rule.pct);
    if (rulePct <= 0 || !rule.key || !rule.label) continue;
    const amount = roundTaka(taxable * (rulePct / 100));
    if (amount === 0) continue;
    extraSurcharges.push({ key: rule.key, label: rule.label, amount, pct: rulePct });
    pushLine(rule.key, `${rule.label} (${rulePct}%)`, amount);
  }

  const serviceFeePct = pct(cfg.serviceFeePct);
  const serviceFee = roundTaka(taxable * (serviceFeePct / 100));
  if (serviceFeePct > 0) pushLine('service', `Service fee (${serviceFeePct}%)`, serviceFee);

  const subtotal = baseFare;
  const tax = vat + ait + extraSurcharges.reduce((sum, item) => sum + item.amount, 0);
  const preDiscount = baseFare + seasonSurcharge + tax + serviceFee;

  // Discounts apply to the base fare only, are capped at the subtotal, and can
  // never drive the total below zero.
  let discount = 0;
  let promoApplied = false;
  let appliedCode: string | undefined;
  const wanted = (promoCode || '').trim();
  const accepted = (cfg.promoCode || '').trim();
  if (wanted && accepted && wanted.toUpperCase() === accepted.toUpperCase()) {
    promoApplied = true;
    appliedCode = accepted.toUpperCase();
    discount = Math.min(subtotal, roundTaka(subtotal * (pct(cfg.promoPct ?? 10) / 100)));
    if (discount > 0) pushLine('promo', `Discount (${appliedCode})`, -discount);
  }

  const total = Math.max(0, roundTaka(preDiscount - discount));

  const quote: TourQuote = {
    currency: 'BDT',
    adults, children, infants, travellerCount,
    adultUnit, childUnit, infantUnit,
    baseFare, seasonSurcharge, serviceFee, vat, ait,
    extraSurcharges: extraSurcharges.reduce((sum, item) => sum + item.amount, 0),
    subtotal, discount, tax, total,
    vatPct, aitPct, serviceFeePct, seasonSurchargePct,
    lines,
    emi: (cfg.emiMonths || [3, 6, 12])
      .map(months => Math.trunc(months))
      .filter(months => Number.isFinite(months) && months > 0 && months <= 60)
      .map(months => ({ months, installment: Math.ceil(total / months) })),
    promoApplied,
    promoCode: appliedCode
  };

  assertQuoteConsistent(quote);
  return quote;
}

/**
 * Defence in depth: a breakdown that does not add up must never reach a
 * customer or a gateway. If this throws, it is a programming error, not a
 * runtime condition, and the request fails loudly instead of overcharging.
 */
export function assertQuoteConsistent(quote: TourQuote): void {
  const lineSum = quote.lines.reduce((sum, line) => sum + line.amount, 0);
  if (lineSum !== quote.total) {
    throw new AppError(500, 'PRICE_BREAKDOWN_MISMATCH', 'The price breakdown could not be verified. Please try again.', { lineSum, total: quote.total });
  }
  if (quote.total < 0) throw new AppError(500, 'PRICE_BREAKDOWN_MISMATCH', 'The calculated total is negative');
  if (quote.discount > quote.subtotal) throw new AppError(500, 'PRICE_BREAKDOWN_MISMATCH', 'The discount exceeds the subtotal');
  if (quote.tax !== quote.vat + quote.ait + quote.extraSurcharges) throw new AppError(500, 'PRICE_BREAKDOWN_MISMATCH', 'Tax components do not sum to the tax total');
}

/**
 * Map a persisted tour record (plus operator settings) to a pricing config.
 * Kept next to the calculation so every caller resolves tax/fee defaults the
 * same way — the historic bug came from three call sites doing it differently.
 */
export function tourPricingFromRecord(
  tour: { priceBdt?: number; metadata?: Record<string, unknown> },
  settings: { vatPct?: number; aitPct?: number; serviceFeePct?: number; seasonSurchargePct?: number } = {}
): TourPricingConfig {
  const meta = (tour.metadata || {}) as Record<string, unknown>;
  const has = (value: unknown) => value !== undefined && value !== null && value !== '' && Number.isFinite(Number(value));
  return {
    adultPrice: finite(tour.priceBdt, 0),
    childPrice: has(meta.childPrice) ? Number(meta.childPrice) : undefined,
    infantPrice: has(meta.infantPrice) ? Number(meta.infantPrice) : undefined,
    // A tour-level value always wins over the deployment default.
    seasonSurchargePct: has(meta.seasonSurchargePct) ? Number(meta.seasonSurchargePct) : settings.seasonSurchargePct,
    serviceFeePct: has(meta.serviceFeePct) ? Number(meta.serviceFeePct) : settings.serviceFeePct,
    vatPct: has(meta.vatPct) ? Number(meta.vatPct) : settings.vatPct,
    aitPct: has(meta.aitPct) ? Number(meta.aitPct) : settings.aitPct,
    promoCode: typeof meta.promoCode === 'string' ? meta.promoCode : undefined,
    promoPct: has(meta.promoPct) ? Number(meta.promoPct) : undefined,
    emiMonths: Array.isArray(meta.emiMonths) ? (meta.emiMonths as unknown[]).map(Number).filter(Number.isFinite) : undefined
  };
}

/** Bangladeshi taka formatting used across storefront and admin. */
export function formatBdt(amount: number, currency = 'BDT'): string {
  const symbol = currency === 'BDT' ? '৳' : `${currency} `;
  return `${symbol}${roundTaka(amount).toLocaleString('en-BD')}`;
}
