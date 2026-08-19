/**
 * Sadik Travels — Hotel & Tour booking relational model.
 *
 * Production persistence is MongoDB (Mongoose). This file is the canonical
 * relational contract: UUID primary keys, strict foreign keys, and the
 * equivalent SQL / Prisma mapping used by operators and migrations.
 *
 * Collections:
 *   hotels, hotel_rooms, room_inventory, hotel_bookings,
 *   tours, tour_bookings, payments / transactions
 */

export const BOOKING_SCHEMA_VERSION = 2;

export const HOTEL_AMENITY_TREE = {
  connectivity: ['Free Wi-Fi', 'Wi-Fi'],
  wellness: ['Swimming Pool', 'Pool', 'Gym', 'Spa'],
  dining: ['Complimentary Breakfast', 'Breakfast', 'Restaurant'],
  family: ['Couple-Friendly', 'Family Rooms', 'Kids Club'],
  convenience: ['Parking', 'Airport Transfer', 'Room Service', 'AC', 'Lift']
} as const;

export const NEIGHBORHOODS: Record<string, string[]> = {
  "Cox's Bazar": ['Kolatoli Road', 'Inani Beach', 'Laboni Beach', 'Sugandha Point', 'Himchari'],
  Dhaka: ['Gulshan', 'Banani', 'Dhanmondi', 'Motijheel', 'Uttara'],
  Sylhet: ['Zindabazar', 'Amberkhana', 'Shahjalal University'],
  Chattogram: ['Agrabad', 'GEC Circle', 'Patenga']
};

export const REVIEW_BUCKETS = [
  { id: 'excellent', label: '8.5+ Excellent', min: 4.25 },
  { id: 'very_good', label: '8.0+ Very good', min: 4.0 },
  { id: 'good', label: '7.0+ Good', min: 3.5 }
] as const;

/** VAT 15% + AIT 5% on taxable hotel/tour totals (Bangladesh). */
export const BD_VAT_PCT = 15;
export const BD_AIT_PCT = 5;

export type TourPricingConfig = {
  adultPrice: number;
  childPrice?: number;
  infantPrice?: number;
  seasonSurchargePct?: number;
  emiMonths?: number[];
  vatPct?: number;
  aitPct?: number;
};

export function computeTourQuote(cfg: TourPricingConfig, pax: { adults: number; children?: number; infants?: number }) {
  const adults = Math.max(1, pax.adults || 1);
  const children = Math.max(0, pax.children || 0);
  const infants = Math.max(0, pax.infants || 0);
  const base = adults * cfg.adultPrice + children * (cfg.childPrice ?? Math.round(cfg.adultPrice * 0.7)) + infants * (cfg.infantPrice ?? 0);
  const surcharge = Math.round(base * ((cfg.seasonSurchargePct || 0) / 100));
  const taxable = base + surcharge;
  const vatPct = cfg.vatPct ?? BD_VAT_PCT;
  const aitPct = cfg.aitPct ?? BD_AIT_PCT;
  const vat = Math.round(taxable * vatPct / 100);
  const ait = Math.round(taxable * aitPct / 100);
  const total = taxable + vat + ait;
  const emis = (cfg.emiMonths || [3, 6, 12]).map(months => ({ months, installment: Math.ceil(total / months) }));
  return {
    currency: 'BDT',
    adults, children, infants,
    adultUnit: cfg.adultPrice,
    childUnit: cfg.childPrice ?? Math.round(cfg.adultPrice * 0.7),
    infantUnit: cfg.infantPrice ?? 0,
    baseFare: base,
    seasonSurcharge: surcharge,
    vat, ait, vatPct, aitPct,
    total,
    emi: emis
  };
}
