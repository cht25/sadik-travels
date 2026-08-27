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

/**
 * Tour pricing lives in `./pricing.ts` — the single source of truth for
 * payable amounts, with a self-verifying breakdown. This module re-exports it
 * so existing imports keep resolving; do not add a second calculation here.
 *
 * `BD_VAT_PCT` / `BD_AIT_PCT` are Bangladesh *reference* rates. They are no
 * longer applied implicitly: an operator must opt in per tour or per
 * deployment. That default was one of the two defects that turned a
 * BDT 6,000 package into a BDT 14,400 charge.
 */
export {
  BD_VAT_PCT,
  BD_AIT_PCT,
  DEFAULT_CHILD_PRICE_FACTOR,
  DEFAULT_TOUR_TRAVELLERS,
  computeTourQuote,
  normalizeTravellers,
  tourPricingFromRecord,
  assertQuoteConsistent,
  formatBdt,
  roundTaka
} from './pricing.js';
export type { TourPricingConfig, TourQuote, TourTravellers, PriceLine, SurchargeRule } from './pricing.js';
