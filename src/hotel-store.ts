import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { AppError } from './errors.js';
import { optimizedMediaUrl } from './media.js';

/**
 * Hotel booking ecosystem (add-on). Uses the same shared mongoose connection as
 * the core store and follows the same UUID-keyed collection conventions. All
 * persistent hotel business records (hotels, rooms, inventory, bookings) live
 * in MongoDB; images are Cloudinary URLs stored as metadata.
 */

export type HotelStatus = 'draft' | 'active' | 'hidden' | 'archived';
export type RoomStatus = 'active' | 'hidden' | 'archived';
export type HotelBookingStatus = 'pending' | 'payment_pending' | 'confirmed' | 'cancelled' | 'completed' | 'refund_requested' | 'refunded' | 'failed' | 'expired';
export type PaymentStatus = 'pending' | 'paid' | 'failed' | 'refunded' | 'partial';

export type HotelImage = { url: string; publicId?: string; mediaId?: string; alt?: string };
export type SeasonalDiscount = { name: string; startDate: string; endDate: string; percentage: number };
export type CancellationPolicy = { type: 'free' | 'non_refundable'; freeUntilDays?: number; description?: string };

export type Hotel = {
  id: string; slug: string; name: string; shortDescription?: string; description?: string;
  propertyType: string; address?: string; city: string; country: string; area?: string;
  latitude?: number; longitude?: number; phone?: string; email?: string; website?: string;
  starRating: number; guestRating?: number; reviewCount?: number;
  amenities: string[]; facilities?: string[]; images: HotelImage[];
  roomTypes?: string[]; pricePerNight?: number; seasonalDiscounts?: SeasonalDiscount[]; available?: boolean; ownerId?: string;
  checkInTime?: string; checkOutTime?: string; cancellationPolicy?: CancellationPolicy;
  status: HotelStatus; featured: boolean; sortOrder: number;
  priceFrom?: number; createdBy?: string; updatedBy?: string; deletedAt?: string;
  createdAt: string; updatedAt: string;
};

export type HotelRoom = {
  id: string; hotelId: string; name: string; slug: string; description?: string; images: HotelImage[];
  size?: number; bedType?: string; numBeds?: number; maxAdults: number; maxChildren: number; maxGuests: number;
  amenities: string[]; inventory: number; pricePerNight: number; originalPrice?: number; taxesPct: number; serviceFee: number;
  cancellationPolicy?: CancellationPolicy; mealPlan?: string; status: RoomStatus; sortOrder: number;
  createdBy?: string; updatedBy?: string; deletedAt?: string; createdAt: string; updatedAt: string;
};

export type HotelBookingRoom = {
  roomId: string; roomName: string; quantity: number; adults: number; children: number; childAges?: number[];
  pricePerNight: number; nights: number; subtotal: number; taxes: number; serviceFee: number; discount: number;
};

export type PriceBreakdown = { roomTotal: number; taxes: number; serviceFee: number; discount: number; total: number; currency: string; nights: number };

export type HotelBooking = {
  id: string; bookingNumber: string; userId: string; hotelId: string;
  checkIn: string; checkOut: string; nights: number; rooms: HotelBookingRoom[];
  primaryGuest: { firstName: string; lastName: string; email: string; phone: string; country?: string };
  roomGuests?: Array<{ roomIndex: number; name: string; type: 'adult' | 'child' }>;
  specialRequests?: string; priceBreakdown: PriceBreakdown;
  paymentMethod: string; paymentStatus: PaymentStatus; status: HotelBookingStatus;
  cancellationPolicy?: CancellationPolicy; cancelledAt?: string;
  refund?: { status: 'none' | 'requested' | 'approved' | 'processing' | 'refunded' | 'rejected'; amount?: number; reason?: string; requestedAt?: string; processedAt?: string; processedBy?: string };
  hotelSnapshot: { name: string; city: string; image?: string; address?: string };
  createdBy?: string; createdAt: string; updatedAt: string;
};

export type HotelFilters = {
  q?: string; destination?: string; city?: string; country?: string; propertyType?: string; propertyTypes?: string[];
  minPrice?: number; maxPrice?: number; minStarRating?: number; starRatings?: number[]; minGuestRating?: number; amenities?: string[];
  area?: string; areas?: string[]; neighborhoods?: string[];
  checkIn?: string; checkOut?: string; freeCancellationOnly?: boolean; sort?: string;
  page?: number; pageSize?: number; includeArchived?: boolean; status?: HotelStatus | 'all'; ownerId?: string;
};

const { Schema, model, models } = mongoose;
const mixed = Schema.Types.Mixed;
const makeModel = (name: string, collection: string, fields: Record<string, any>, indexes: Array<[Record<string, 1 | -1>, Record<string, any>?]> = []): mongoose.Model<any> => {
  if (models[name]) return models[name] as mongoose.Model<any>;
  const schema = new Schema({ id: { type: String, required: true, unique: true, index: true }, ...fields }, { versionKey: false, strict: true, collection });
  indexes.forEach(([keys, options]) => schema.index(keys, options));
  return model(name, schema, collection);
};

const imageSchema = () => [{ url: String, publicId: String, mediaId: String, alt: String }];
const cancellationSchema = () => ({ type: { type: String, enum: ['free', 'non_refundable'], default: 'free' }, freeUntilDays: Number, description: String });

const HotelModel = makeModel('SadikHotel', 'hotels', {
  slug: { type: String, unique: true, index: true }, name: String, shortDescription: String, description: String,
  propertyType: { type: String, index: true }, address: String, city: { type: String, index: true }, country: { type: String, index: true }, area: String,
  latitude: Number, longitude: Number, phone: String, email: String, website: String,
  starRating: { type: Number, index: true }, guestRating: Number, reviewCount: { type: Number, default: 0 },
  amenities: [String], facilities: [String], images: imageSchema(),
  roomTypes: [String], pricePerNight: Number, seasonalDiscounts: [mixed], available: { type: Boolean, default: true, index: true }, ownerId: { type: String, index: true },
  checkInTime: String, checkOutTime: String, cancellationPolicy: cancellationSchema(),
  status: { type: String, index: true }, featured: Boolean, sortOrder: Number,
  createdBy: String, updatedBy: String, deletedAt: String, createdAt: String, updatedAt: String
}, [[{ status: 1, featured: 1, sortOrder: 1 }], [{ city: 1, propertyType: 1, starRating: 1 }]]);

const RoomModel = makeModel('SadikHotelRoom', 'hotel_rooms', {
  hotelId: { type: String, index: true }, name: String, slug: String, description: String, images: imageSchema(),
  size: Number, bedType: String, numBeds: Number, maxAdults: Number, maxChildren: Number, maxGuests: Number,
  amenities: [String], inventory: Number, pricePerNight: Number, originalPrice: Number, taxesPct: Number, serviceFee: Number,
  cancellationPolicy: cancellationSchema(), mealPlan: String, status: { type: String, index: true }, sortOrder: Number,
  createdBy: String, updatedBy: String, deletedAt: String, createdAt: String, updatedAt: String
}, [[{ hotelId: 1, status: 1, sortOrder: 1 }]]);

const InventoryModel = makeModel('SadikRoomInventory', 'room_inventory', {
  hotelId: { type: String, index: true }, roomId: { type: String, index: true }, date: { type: String, index: true },
  total: Number, available: Number, blocked: Number
}, [[{ roomId: 1, date: 1 }, { unique: true }]]);

const BookingModel = makeModel('SadikHotelBooking', 'hotel_bookings', {
  bookingNumber: { type: String, unique: true, index: true }, userId: { type: String, index: true }, hotelId: { type: String, index: true },
  checkIn: { type: String }, checkOut: String, nights: Number, rooms: [mixed],
  primaryGuest: mixed, roomGuests: [mixed], specialRequests: String, priceBreakdown: mixed,
  paymentMethod: String, paymentStatus: { type: String, index: true }, status: { type: String, index: true },
  cancellationPolicy: cancellationSchema(), cancelledAt: String, refund: mixed, hotelSnapshot: mixed,
  createdBy: String, createdAt: String, updatedAt: String
}, [[{ userId: 1, createdAt: -1 }], [{ status: 1, updatedAt: -1 }], [{ checkIn: 1 }]]);

const MODELS = [HotelModel, RoomModel, InventoryModel, BookingModel];
const now = () => new Date().toISOString();
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const normalize = (value: unknown) => String(value ?? '').toLowerCase();
const contains = (value: unknown, query?: string) => !query || normalize(value).includes(normalize(query));
const pageN = (value?: number) => Math.max(1, Math.floor(value || 1));
const sizeN = (value?: number, fallback = 20) => Math.min(100, Math.max(1, Math.floor(value || fallback)));
const stripMongo = (doc: any) => { if (!doc) return doc; const { _id, __v, ...rest } = doc; return clone(rest); };
const eachDate = (checkIn: string, checkOut: string): string[] => {
  const dates: string[] = []; const start = new Date(`${checkIn}T00:00:00Z`); const end = new Date(`${checkOut}T00:00:00Z`);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return dates;
  for (let t = start.getTime(); t < end.getTime(); t += 86_400_000) dates.push(new Date(t).toISOString().slice(0, 10));
  return dates;
};
const nightsBetween = (checkIn: string, checkOut: string) => Math.max(0, Math.round((new Date(`${checkOut}T00:00:00Z`).getTime() - new Date(`${checkIn}T00:00:00Z`).getTime()) / 86_400_000));
const isValidIsoDate = (value: string) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [, year, month, day] = match.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

export function generateBookingNumber() {
  const year = new Date().getFullYear();
  const code = Array.from({ length: 6 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 31)]).join('');
  return `ST-${year}-${code}`;
}

const optimizeImages = (images: HotelImage[] | undefined, width: number): HotelImage[] => normalizeHotelImages(images).map(image => ({ ...image, url: optimizedMediaUrl(image.url, { width }) || image.url }));

/**
 * Canonical image normalization — applied on every save AND every read.
 *
 * Fixes the root causes of missing hotel images:
 *  - legacy/malformed rows where `images` contains plain URL strings instead
 *    of {url} objects (these previously produced `url: undefined` and empty
 *    <img src=""> tags — the broken image containers on the public site);
 *  - insecure `http://` URLs, which are blocked by the production CSP and by
 *    browsers on the HTTPS site — upgraded to `https://`;
 *  - whitespace-only or missing URLs, which are dropped entirely so the
 *    frontend can rely on `images[n].url` being a usable absolute URL.
 */
export function normalizeHotelImages(images: unknown): HotelImage[] {
  if (!Array.isArray(images)) return [];
  const normalized: HotelImage[] = [];
  for (const entry of images) {
    const raw = typeof entry === 'string' ? entry : (entry as HotelImage | null)?.url;
    if (typeof raw !== 'string') continue;
    let url = raw.trim();
    if (!url || !/^(https?:\/\/|\/)/i.test(url)) continue;
    if (url.startsWith('http://')) url = `https://${url.slice('http://'.length)}`;
    const source = typeof entry === 'object' && entry ? (entry as HotelImage) : ({} as HotelImage);
    normalized.push({
      url,
      ...(source.publicId ? { publicId: String(source.publicId) } : {}),
      ...(source.mediaId ? { mediaId: String(source.mediaId) } : {}),
      ...(source.alt ? { alt: String(source.alt).slice(0, 300) } : {})
    });
  }
  return normalized;
}

export class HotelStore {
  async ensureIndexes() { await Promise.all(MODELS.map(model => model.createIndexes())); }

  private async allHotels() { return (await HotelModel.find({}).lean()).map(stripMongo); }
  private async allRooms() { return (await RoomModel.find({}).lean()).map(stripMongo); }
  private async oneHotel(idOrSlug: string) { const doc = await HotelModel.findOne({ $or: [{ id: idOrSlug }, { slug: idOrSlug }] }).lean(); return doc ? stripMongo(doc) : undefined; }
  private async oneRoom(id: string) { const doc = await RoomModel.findOne({ id }).lean(); return doc ? stripMongo(doc) : undefined; }
  private async saveHotel(hotel: any) { const doc = await HotelModel.findOneAndUpdate({ id: hotel.id }, { $set: hotel }, { new: true, upsert: true }).lean(); return stripMongo(doc); }
  private async saveRoom(room: any) { const doc = await RoomModel.findOneAndUpdate({ id: room.id }, { $set: room }, { new: true, upsert: true }).lean(); return stripMongo(doc); }
  private async saveBooking(booking: any) { const doc = await BookingModel.findOneAndUpdate({ id: booking.id }, { $set: booking }, { new: true, upsert: true }).lean(); return stripMongo(doc); }

  private seasonalDiscountFor(hotel: Hotel, date = new Date().toISOString().slice(0, 10)): number {
    return Math.max(0, ...(hotel.seasonalDiscounts || [])
      .filter(discount => discount.startDate <= date && discount.endDate >= date)
      .map(discount => Math.min(100, Math.max(0, Number(discount.percentage) || 0))));
  }

  /** Lowest currently bookable price across active rooms, or the hotel fallback price. */
  private priceFromHotel(rooms: HotelRoom[], hotel?: Hotel): number | undefined {
    const active = rooms.filter(room => room.status === 'active' && !room.deletedAt && room.pricePerNight > 0);
    const base = active.length ? Math.min(...active.map(room => room.pricePerNight)) : (hotel?.pricePerNight && hotel.pricePerNight > 0 ? hotel.pricePerNight : undefined);
    if (base === undefined) return undefined;
    const discount = hotel ? this.seasonalDiscountFor(hotel) : 0;
    return Math.round(base * (1 - discount / 100));
  }

  /** Lowest crossed-out original price across a hotel's active rooms (for discount display). */
  private originalPriceFromHotel(rooms: HotelRoom[], hotel?: Hotel): number | undefined {
    const active = rooms.filter(room => room.status === 'active' && !room.deletedAt && room.pricePerNight > 0);
    if (!active.length) return hotel?.pricePerNight && hotel.pricePerNight > 0 ? hotel.pricePerNight : undefined;
    const values = active
      .map(room => (room.originalPrice && room.originalPrice > room.pricePerNight ? room.originalPrice : room.pricePerNight));
    return Math.min(...values);
  }

  /** Minimum available inventory across a date range for a room. */
  async availabilityFor(roomId: string, checkIn: string, checkOut: string, fallbackTotal: number): Promise<number> {
    const dates = eachDate(checkIn, checkOut);
    if (!dates.length) return Math.max(0, fallbackTotal);
    const rows = await InventoryModel.find({ roomId, date: { $in: dates } }).lean();
    const map = new Map(rows.map((row: any) => [String(row.date), stripMongo(row)]));
    let min = Infinity;
    for (const date of dates) { const row = map.get(date); min = Math.min(min, row ? Number(row.available) : fallbackTotal); }
    return min === Infinity ? Math.max(0, fallbackTotal) : Math.max(0, min);
  }

  async listHotels(filters: HotelFilters = {}): Promise<{ hotels: any[]; total: number; page: number; pageSize: number; pageCount: number; propertyTypes: string[]; cities: string[]; areas: string[]; amenities: string[]; starRatings: number[]; priceBounds: { min: number; max: number } }> {
    let hotels = (await this.allHotels()).filter(hotel => !hotel.deletedAt);
    if (filters.includeArchived) { /* keep all */ }
    else if (filters.status && filters.status !== 'all') hotels = hotels.filter(hotel => hotel.status === filters.status);
    else hotels = hotels.filter(hotel => hotel.status === 'active');
    if (!filters.includeArchived) hotels = hotels.filter(hotel => hotel.available !== false);

    const rooms = (await this.allRooms()).filter(room => !room.deletedAt);
    const roomsByHotel = new Map<string, HotelRoom[]>();
    rooms.forEach(room => { if (!roomsByHotel.has(room.hotelId)) roomsByHotel.set(room.hotelId, []); roomsByHotel.get(room.hotelId)!.push(room); });

    // Attach priceFrom + availability counts.
    const availabilityCache = new Map<string, number>();
    const hotelWithPrice = await Promise.all(hotels.map(async hotel => {
      const hotelRooms = roomsByHotel.get(hotel.id) || [];
      const activeRooms = hotelRooms.filter(room => room.status === 'active');
      let availableCount = activeRooms.length;
      if (filters.checkIn && filters.checkOut) {
        const roomAvail = await Promise.all(activeRooms.map(async room => {
          const key = `${room.id}:${filters.checkIn}:${filters.checkOut}`;
          if (!availabilityCache.has(key)) availabilityCache.set(key, await this.availabilityFor(room.id, filters.checkIn!, filters.checkOut!, room.inventory));
          return availabilityCache.get(key)! > 0;
        }));
        availableCount = roomAvail.filter(Boolean).length;
      }
      return { ...hotel, priceFrom: this.priceFromHotel(activeRooms, hotel), originalPriceFrom: this.originalPriceFromHotel(activeRooms, hotel), roomCount: activeRooms.length, availableRooms: availableCount };
    }));

    let items = hotelWithPrice;
    if (filters.q) items = items.filter(hotel => contains(`${hotel.name} ${hotel.city} ${hotel.country} ${hotel.area || ''} ${hotel.shortDescription || ''}`, filters.q));
    if (filters.destination) items = items.filter(hotel => contains(`${hotel.name} ${hotel.city} ${hotel.country} ${hotel.area || ''}`, filters.destination));
    if (filters.city) items = items.filter(hotel => normalize(hotel.city) === normalize(filters.city));
    if (filters.country) items = items.filter(hotel => normalize(hotel.country) === normalize(filters.country));
    // Property type: single value (compat) or multi-select OR-within-group.
    if (filters.propertyTypes?.length) items = items.filter(hotel => filters.propertyTypes!.some(type => normalize(hotel.propertyType) === normalize(type)));
    else if (filters.propertyType) items = items.filter(hotel => normalize(hotel.propertyType) === normalize(filters.propertyType));
    // Star rating: exact match against the selected star levels (OR-within-group).
    if (filters.starRatings?.length) items = items.filter(hotel => filters.starRatings!.includes(Math.round(Number(hotel.starRating) || 0)));
    else if (filters.minStarRating) items = items.filter(hotel => (hotel.starRating || 0) >= filters.minStarRating!);
    if (filters.minGuestRating) items = items.filter(hotel => (hotel.guestRating || hotel.starRating || 0) >= filters.minGuestRating!);
    // Area: single value (compat) or multi-select OR-within-group (exact, case-insensitive).
    if (filters.areas?.length) items = items.filter(hotel => filters.areas!.some(area => normalize(hotel.area || '') === normalize(area)));
    if (filters.area) items = items.filter(hotel => normalize(hotel.area || '') === normalize(filters.area) || contains(hotel.area, filters.area));
    if (filters.neighborhoods?.length) items = items.filter(hotel => filters.neighborhoods!.some(n => contains(`${hotel.area || ''} ${hotel.address || ''}`, n)));
    if (filters.minPrice !== undefined) items = items.filter(hotel => typeof hotel.priceFrom === 'number' && hotel.priceFrom >= filters.minPrice!);
    if (filters.maxPrice !== undefined) items = items.filter(hotel => typeof hotel.priceFrom === 'number' && hotel.priceFrom <= filters.maxPrice!);
    if (filters.amenities?.length) items = items.filter(hotel => filters.amenities!.every(amenity => (hotel.amenities || []).some((h: string) => normalize(h).includes(normalize(amenity)) || normalize(amenity).includes(normalize(h)))));
    if (filters.freeCancellationOnly) items = items.filter(hotel => hotel.cancellationPolicy?.type === 'free');
    if (filters.checkIn && filters.checkOut && filters.sort !== 'distance') items = items.filter(hotel => hotel.availableRooms > 0);

    const sort = filters.sort || 'recommended';
    items.sort((a, b) => {
      if (sort === 'price_asc') return (a.priceFrom ?? Infinity) - (b.priceFrom ?? Infinity);
      if (sort === 'price_desc') return (b.priceFrom ?? -Infinity) - (a.priceFrom ?? -Infinity);
      if (sort === 'rating') return (b.guestRating || b.starRating || 0) - (a.guestRating || a.starRating || 0);
      // recommended: featured first, then rating, then price
      if (a.featured !== b.featured) return a.featured ? -1 : 1;
      return (b.guestRating || b.starRating || 0) - (a.guestRating || a.starRating || 0);
    });

    const total = items.length;
    const currentPage = pageN(filters.page); const pageSize = sizeN(filters.pageSize, 12);
    const slice = items.slice((currentPage - 1) * pageSize, currentPage * pageSize);
    const view = slice.map(hotel => ({
      ...hotel,
      images: optimizeImages(hotel.images, 600),
      thumbnail: hotel.images?.[0]?.url ? optimizedMediaUrl(hotel.images[0].url, { width: 600 }) : undefined
    }));
    const live = (await this.allHotels()).filter(h => h.status === 'active' && h.available !== false && !h.deletedAt);
    const propertyTypes = [...new Set(live.map(h => h.propertyType).filter(Boolean))].sort();
    const cities = [...new Set(live.map(h => h.city).filter(Boolean))].sort();
    const areas = [...new Set(live.map(h => h.area).filter(Boolean))].sort();
    // Amenity/star facets are derived from live hotel data (never hardcoded),
    // so admin-managed taxonomy changes automatically reach the filter panel.
    const amenityCounts = new Map<string, number>();
    for (const hotel of live) for (const amenity of hotel.amenities || []) {
      const key = String(amenity).trim();
      if (key) amenityCounts.set(key, (amenityCounts.get(key) || 0) + 1);
    }
    const amenities = [...amenityCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([amenity]) => amenity);
    const starRatings = [...new Set(live.map(h => Math.round(Number(h.starRating) || 0)).filter(stars => stars > 0))].sort((a, b) => b - a);
    const prices = items.map(h => h.priceFrom).filter((n): n is number => typeof n === 'number');
    const priceBounds = { min: prices.length ? Math.min(...prices) : 0, max: prices.length ? Math.max(...prices) : 25000 };
    return { hotels: view, total, page: currentPage, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)), propertyTypes, cities, areas, amenities, starRatings, priceBounds };
  }

  async findHotel(idOrSlug: string, options: { checkIn?: string; checkOut?: string; withRooms?: boolean } = {}) {
    const hotel = await this.oneHotel(idOrSlug);
    if (!hotel || hotel.deletedAt || hotel.status !== 'active' || hotel.available === false) return undefined;
    const rooms = (await this.allRooms()).filter(room => room.hotelId === hotel.id && !room.deletedAt && room.status === 'active');
    const roomsWithAvail = options.checkIn && options.checkOut ? await Promise.all(rooms.map(async room => ({ ...room, images: optimizeImages(room.images, 800), available: await this.availabilityFor(room.id, options.checkIn!, options.checkOut!, room.inventory), nights: nightsBetween(options.checkIn!, options.checkOut!) }))) : rooms.map(room => ({ ...room, images: optimizeImages(room.images, 800), available: room.inventory }));
    return { ...hotel, priceFrom: this.priceFromHotel(rooms, hotel), originalPriceFrom: this.originalPriceFromHotel(rooms, hotel), images: optimizeImages(hotel.images, 1280), rooms: (options.withRooms === false ? [] : roomsWithAvail) };
  }

  async priceQuote(input: { hotelId: string; rooms: Array<{ roomId: string; quantity?: number; adults?: number; children?: number }>; checkIn: string; checkOut: string }): Promise<{ rooms: HotelBookingRoom[]; breakdown: PriceBreakdown; hotelName: string }> {
    const hotel = await this.oneHotel(input.hotelId);
    if (!hotel || hotel.deletedAt || hotel.status !== 'active' || hotel.available === false) throw new AppError(404, 'HOTEL_NOT_FOUND', 'Hotel not found');
    if (!isValidIsoDate(input.checkIn) || !isValidIsoDate(input.checkOut)) throw new AppError(400, 'INVALID_DATES', 'Select valid check-in and check-out dates');
    const todayStart = new Date(); todayStart.setUTCHours(0, 0, 0, 0);
    if (Date.parse(`${input.checkIn}T00:00:00Z`) < todayStart.getTime()) throw new AppError(400, 'INVALID_DATES', 'Check-in date cannot be in the past');
    const nights = nightsBetween(input.checkIn, input.checkOut);
    if (nights < 1) throw new AppError(400, 'INVALID_DATES', 'Check-out must be after check-in');
    const datedRooms: HotelBookingRoom[] = [];
    const stayDates = eachDate(input.checkIn, input.checkOut);
    for (const selection of input.rooms) {
      const room = await this.oneRoom(selection.roomId);
      if (!room || room.hotelId !== input.hotelId || room.deletedAt || room.status !== 'active') throw new AppError(404, 'ROOM_NOT_FOUND', 'Room not found');
      const quantity = Math.max(1, Math.floor(selection.quantity || 1));
      const adults = Math.max(1, Math.floor(selection.adults || 1));
      const children = Math.max(0, Math.floor(selection.children || 0));
      if (adults + children > room.maxGuests * quantity) throw new AppError(400, 'OCCUPANCY_EXCEEDED', `${room.name} allows up to ${room.maxGuests * quantity} guests for ${quantity} room${quantity > 1 ? 's' : ''}`);
      const nightly = stayDates.map(date => Math.round(room.pricePerNight * (1 - this.seasonalDiscountFor(hotel, date) / 100)));
      const subtotal = nightly.reduce((sum, price) => sum + price, 0) * quantity;
      const originalNightly = room.originalPrice && room.originalPrice > room.pricePerNight ? room.originalPrice : room.pricePerNight;
      const taxes = Math.round(subtotal * (room.taxesPct || 0) / 100);
      const serviceFee = (room.serviceFee || 0) * quantity;
      const discount = Math.max(0, originalNightly * nights * quantity - subtotal);
      datedRooms.push({ roomId: room.id, roomName: room.name, quantity, adults, children, pricePerNight: Math.round(subtotal / nights / quantity), nights, subtotal, taxes, serviceFee, discount });
    }
    const breakdown: PriceBreakdown = {
      roomTotal: datedRooms.reduce((sum, room) => sum + room.subtotal, 0),
      taxes: datedRooms.reduce((sum, room) => sum + room.taxes, 0),
      serviceFee: datedRooms.reduce((sum, room) => sum + room.serviceFee, 0),
      discount: datedRooms.reduce((sum, room) => sum + room.discount, 0),
      total: 0, currency: 'BDT', nights
    };
    breakdown.total = breakdown.roomTotal + breakdown.taxes + breakdown.serviceFee;
    return { rooms: datedRooms, breakdown, hotelName: hotel.name };
  }

  /** Ensure inventory rows exist for the dates without altering existing availability. */
  private async ensureInventory(roomId: string, hotelId: string, dates: string[], total: number) {
    await Promise.all(dates.map(date => InventoryModel.updateOne({ roomId, date }, { $setOnInsert: { id: randomUUID(), hotelId, total, available: total, blocked: 0 } }, { upsert: true })));
  }
  private async reserve(roomId: string, date: string, quantity: number) {
    const updated = await InventoryModel.findOneAndUpdate({ roomId, date, available: { $gte: quantity } }, { $inc: { available: -quantity } }, { new: true }).lean();
    return updated ? stripMongo(updated) : undefined;
  }
  private async release(roomId: string, date: string, quantity: number) { await InventoryModel.updateOne({ roomId, date }, { $inc: { available: quantity } }); }

  async createBooking(userId: string, input: { hotelId: string; rooms: Array<{ roomId: string; quantity?: number; adults?: number; children?: number; childAges?: number[] }>; checkIn: string; checkOut: string; primaryGuest: HotelBooking['primaryGuest']; specialRequests?: string; paymentMethod?: string; roomGuests?: HotelBooking['roomGuests']; }): Promise<HotelBooking> {
    const quote = await this.priceQuote({ hotelId: input.hotelId, rooms: input.rooms, checkIn: input.checkIn, checkOut: input.checkOut });
    const hotel = await this.oneHotel(input.hotelId);
    if (!hotel) throw new AppError(404, 'HOTEL_NOT_FOUND', 'Hotel not found');
    const dates = eachDate(input.checkIn, input.checkOut);
    if (!dates.length) throw new AppError(400, 'INVALID_DATES', 'Select valid check-in and check-out dates');

    // Atomic inventory reservation with rollback on overbooking.
    const reserved: Array<{ roomId: string; date: string; quantity: number }> = [];
    try {
      for (const selection of input.rooms) {
        const room = await this.oneRoom(selection.roomId);
        if (!room) throw new AppError(404, 'ROOM_NOT_FOUND', 'Room not found');
        const quantity = Math.max(1, Math.floor(selection.quantity || 1));
        await this.ensureInventory(room.id, hotel.id, dates, room.inventory);
        for (const date of dates) {
          const result = await this.reserve(room.id, date, quantity);
          if (!result) throw new AppError(409, 'ROOM_SOLD_OUT', `${room.name} is no longer available for ${date}. Please choose different dates or fewer rooms.`);
          reserved.push({ roomId: room.id, date, quantity });
        }
      }
    } catch (error) {
      await Promise.all(reserved.map(entry => this.release(entry.roomId, entry.date, entry.quantity)));
      throw error;
    }

    const quoteRooms: HotelBookingRoom[] = quote.rooms.map((room, index) => {
      const selection = input.rooms[index];
      return { ...room, childAges: selection?.childAges };
    });
    let bookingNumber = generateBookingNumber();
    while (await BookingModel.findOne({ bookingNumber }).lean()) bookingNumber = generateBookingNumber();
    const time = now();
    const booking: HotelBooking = {
      id: randomUUID(), bookingNumber, userId, hotelId: input.hotelId,
      checkIn: input.checkIn, checkOut: input.checkOut, nights: quote.breakdown.nights,
      rooms: quoteRooms, primaryGuest: input.primaryGuest, roomGuests: input.roomGuests,
      specialRequests: input.specialRequests, priceBreakdown: quote.breakdown,
      paymentMethod: input.paymentMethod || 'pay_on_arrival', paymentStatus: 'pending', status: 'pending',
      cancellationPolicy: hotel.cancellationPolicy || { type: 'free', freeUntilDays: 1 },
      hotelSnapshot: { name: hotel.name, city: hotel.city, address: hotel.address, image: hotel.images?.[0]?.url },
      createdBy: userId, createdAt: time, updatedAt: time
    };
    try {
      const saved = await this.saveBooking(booking);
      return saved;
    } catch (error) {
      // Never leave reserved inventory behind when the booking row cannot be persisted.
      await Promise.all(reserved.map(entry => this.release(entry.roomId, entry.date, entry.quantity)));
      throw error;
    }
  }

  async confirmBookingPayment(bookingId: string) { return this.patchBookingStatus(bookingId, { status: 'confirmed', paymentStatus: 'paid' }); }

  async listUserBookings(userId: string): Promise<HotelBooking[]> { return (await BookingModel.find({ userId }).lean()).map(stripMongo).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  async findBooking(bookingId: string, userId?: string): Promise<HotelBooking | undefined> {
    const doc = await BookingModel.findOne({ $or: [{ id: bookingId }, { bookingNumber: bookingId }] }).lean();
    if (!doc) return undefined;
    const booking = stripMongo(doc);
    if (userId && booking.userId !== userId) return undefined;
    return booking;
  }

  canCancel(booking: HotelBooking): { allowed: boolean; reason?: string } {
    if (['cancelled', 'completed', 'refunded'].includes(booking.status)) return { allowed: false, reason: `Booking is ${booking.status.replace(/_/g, ' ')}` };
    if (!booking.cancellationPolicy) return { allowed: true };
    if (booking.cancellationPolicy.type === 'non_refundable') return { allowed: true, reason: 'Non-refundable — cancellation will not issue a refund' };
    const days = booking.cancellationPolicy.freeUntilDays ?? 0;
    const cutoff = new Date(`${booking.checkIn}T00:00:00Z`).getTime() - days * 86_400_000;
    const free = Date.now() <= cutoff;
    return { allowed: true, reason: free ? 'Free cancellation available' : 'Cancellation allowed but may not be refunded' };
  }

  async cancelBooking(bookingId: string, userId: string, isAdmin: boolean): Promise<HotelBooking> {
    const booking = await this.findBooking(bookingId, isAdmin ? undefined : userId);
    if (!booking) throw new AppError(404, 'BOOKING_NOT_FOUND', 'Booking not found');
    const check = this.canCancel(booking);
    if (!check.allowed) throw new AppError(409, 'CANCELLATION_NOT_ALLOWED', check.reason || 'This booking cannot be cancelled');
    const dates = eachDate(booking.checkIn, booking.checkOut);
    await Promise.all(booking.rooms.flatMap(room => dates.map(date => this.release(room.roomId, date, room.quantity))));
    const updated: HotelBooking = { ...booking, status: 'cancelled', paymentStatus: booking.paymentStatus === 'paid' ? 'refunded' : booking.paymentStatus, cancelledAt: now(), updatedAt: now(), refund: booking.paymentStatus === 'paid' ? { status: booking.cancellationPolicy?.type === 'non_refundable' ? 'rejected' : 'approved', amount: booking.priceBreakdown.total, reason: 'Customer cancellation', processedAt: now() } : booking.refund };
    return this.saveBooking(updated);
  }

  async patchBookingStatus(bookingId: string, patch: { status?: HotelBookingStatus; paymentStatus?: PaymentStatus; internalNote?: string }): Promise<HotelBooking | undefined> {
    const booking = await this.findBooking(bookingId);
    if (!booking) return undefined;
    const updated: HotelBooking = { ...booking, ...(patch.status ? { status: patch.status } : {}), ...(patch.paymentStatus ? { paymentStatus: patch.paymentStatus } : {}), updatedAt: now() };
    if (patch.status === 'cancelled' && !booking.cancelledAt) { const dates = eachDate(booking.checkIn, booking.checkOut); await Promise.all(booking.rooms.flatMap(room => dates.map(date => this.release(room.roomId, date, room.quantity)))); updated.cancelledAt = now(); }
    return this.saveBooking(updated);
  }

  // ---- Admin: hotels ----
  async adminListHotels(filters: HotelFilters = {}) {
    let hotels = await this.allHotels();
    if (filters.ownerId) hotels = hotels.filter(hotel => hotel.ownerId === filters.ownerId);
    if (filters.status && filters.status !== 'all') hotels = hotels.filter(hotel => hotel.status === filters.status);
    if (filters.q) hotels = hotels.filter(hotel => contains(`${hotel.name} ${hotel.city} ${hotel.country} ${hotel.propertyType}`, filters.q));
    hotels.sort((a, b) => (a.featured === b.featured ? a.sortOrder - b.sortOrder : a.featured ? -1 : 1) || a.name.localeCompare(b.name));
    const rooms = await this.allRooms();
    const total = hotels.length; const currentPage = pageN(filters.page); const pageSize = sizeN(filters.pageSize, 20);
    const slice = hotels.slice((currentPage - 1) * pageSize, currentPage * pageSize).map(hotel => {
      const hotelRooms = rooms.filter(r => r.hotelId === hotel.id && !r.deletedAt && r.status === 'active');
      return { ...hotel, roomCount: hotelRooms.length, priceFrom: this.priceFromHotel(hotelRooms, hotel), images: optimizeImages(hotel.images, 200) };
    });
    return { hotels: slice, total, page: currentPage, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
  }
  async adminFindHotel(id: string) { const hotel = await this.oneHotel(id); return hotel ? hotel as Hotel : undefined; }
  async adminFindRoom(id: string) { const room = await this.oneRoom(id); return room && !room.deletedAt ? room as HotelRoom : undefined; }
  async adminCreateHotel(input: Partial<Hotel>, actor: string) { const time = now(); const hotel: Hotel = { id: randomUUID(), slug: input.slug!, name: input.name!, shortDescription: input.shortDescription, description: input.description, propertyType: input.propertyType || 'Hotel', address: input.address, city: input.city!, country: input.country || 'Bangladesh', area: input.area, latitude: input.latitude, longitude: input.longitude, phone: input.phone, email: input.email, website: input.website, starRating: input.starRating ?? 3, guestRating: input.guestRating, reviewCount: 0, amenities: input.amenities || [], facilities: input.facilities || [], images: normalizeHotelImages(input.images), roomTypes: input.roomTypes || [], pricePerNight: input.pricePerNight, seasonalDiscounts: input.seasonalDiscounts || [], available: input.available !== false, ownerId: input.ownerId || actor, checkInTime: input.checkInTime, checkOutTime: input.checkOutTime, cancellationPolicy: input.cancellationPolicy, status: input.status || 'active', featured: input.featured || false, sortOrder: input.sortOrder || 0, createdBy: actor, updatedAt: time, createdAt: time } as Hotel; return this.saveHotel(hotel); }
  async adminUpdateHotel(id: string, patch: Partial<Hotel>, actor: string) { const hotel = await this.oneHotel(id); if (!hotel) return undefined; return this.saveHotel({ ...hotel, ...patch, id, updatedBy: actor, updatedAt: now(), ...(patch.images ? { images: normalizeHotelImages(patch.images) } : {}) }); }
  async adminArchiveHotel(id: string) { const hotel = await this.oneHotel(id); if (!hotel) return undefined; return this.saveHotel({ ...hotel, status: 'archived', updatedAt: now() }); }
  async adminRestoreHotel(id: string) { const hotel = await this.oneHotel(id); if (!hotel) return undefined; return this.saveHotel({ ...hotel, status: 'active', deletedAt: undefined as any, updatedAt: now() }); }
  async adminDeleteHotel(id: string) { const bookings = await BookingModel.findOne({ hotelId: id }).lean(); if (bookings) throw new AppError(409, 'HOTEL_IN_USE', 'Archive this hotel instead — it is referenced by existing bookings'); return (await HotelModel.deleteOne({ id })).deletedCount === 1; }

  // ---- Admin: rooms ----
  async adminListRooms(hotelId: string) { return (await this.allRooms()).filter(room => room.hotelId === hotelId && !room.deletedAt).sort((a, b) => a.sortOrder - b.sortOrder).map(room => ({ ...room, images: optimizeImages(room.images, 200) })); }
  async adminCreateRoom(hotelId: string, input: Partial<HotelRoom>, actor: string) { const time = now(); const room: HotelRoom = { id: randomUUID(), hotelId, name: input.name!, slug: input.slug!, description: input.description, images: normalizeHotelImages(input.images), size: input.size, bedType: input.bedType, numBeds: input.numBeds, maxAdults: input.maxAdults ?? 2, maxChildren: input.maxChildren ?? 1, maxGuests: input.maxGuests ?? 3, amenities: input.amenities || [], inventory: input.inventory ?? 5, pricePerNight: input.pricePerNight ?? 0, originalPrice: input.originalPrice, taxesPct: input.taxesPct ?? 0, serviceFee: input.serviceFee ?? 0, cancellationPolicy: input.cancellationPolicy, mealPlan: input.mealPlan, status: input.status || 'active', sortOrder: input.sortOrder || 0, createdBy: actor, updatedAt: time, createdAt: time } as HotelRoom; return this.saveRoom(room); }
  async adminUpdateRoom(id: string, patch: Partial<HotelRoom>, actor: string) { const room = await this.oneRoom(id); if (!room) return undefined; return this.saveRoom({ ...room, ...patch, id, updatedBy: actor, updatedAt: now(), ...(patch.images ? { images: normalizeHotelImages(patch.images) } : {}) }); }
  async adminArchiveRoom(id: string) { const room = await this.oneRoom(id); if (!room) return undefined; return this.saveRoom({ ...room, status: 'archived', deletedAt: now(), updatedAt: now() }); }

  // ---- Admin: inventory ----
  async adminInventory(roomId: string, fromDate: string, days = 30) {
    const room = await this.oneRoom(roomId); if (!room) return undefined;
    const dates: string[] = []; const start = new Date(`${fromDate}T00:00:00Z`); if (!Number.isFinite(start.getTime())) return undefined;
    for (let i = 0; i < days; i++) { const t = new Date(start.getTime() + i * 86_400_000); dates.push(t.toISOString().slice(0, 10)); }
    await this.ensureInventory(roomId, room.hotelId, dates, room.inventory);
    const rows = await InventoryModel.find({ roomId, date: { $in: dates } }).lean();
    return { room: { id: room.id, name: room.name, total: room.inventory }, dates: dates.map(date => { const row = rows.find((r: any) => String(r.date) === date); return { date, total: room.inventory, available: row ? Number(row.available) : room.inventory, blocked: row ? Number(row.blocked || 0) : 0 }; }) };
  }
  async adminSetInventory(roomId: string, date: string, available: number) { const room = await this.oneRoom(roomId); if (!room) return undefined; await this.ensureInventory(roomId, room.hotelId, [date], room.inventory); const doc = await InventoryModel.findOneAndUpdate({ roomId, date }, { $set: { available: Math.max(0, Math.min(room.inventory, Math.floor(available))), total: room.inventory } }, { new: true }).lean(); return doc ? stripMongo(doc) : undefined; }

  // ---- Admin: bookings ----
  async adminListBookings(filters: { q?: string; status?: string; paymentStatus?: string; page?: number; pageSize?: number; ownerId?: string } = {}) {
    let bookings = (await BookingModel.find({}).lean()).map(stripMongo);
    if (filters.ownerId) { const owned = new Set((await this.allHotels()).filter(hotel => hotel.ownerId === filters.ownerId).map(hotel => hotel.id)); bookings = bookings.filter(booking => owned.has(booking.hotelId)); }
    if (filters.status && filters.status !== 'all') bookings = bookings.filter(b => b.status === filters.status);
    if (filters.paymentStatus && filters.paymentStatus !== 'all') bookings = bookings.filter(b => b.paymentStatus === filters.paymentStatus);
    if (filters.q) bookings = bookings.filter(b => contains(`${b.bookingNumber} ${b.primaryGuest?.firstName} ${b.primaryGuest?.lastName} ${b.primaryGuest?.email} ${b.hotelSnapshot?.name}`, filters.q));
    bookings.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const total = bookings.length; const currentPage = pageN(filters.page); const pageSize = sizeN(filters.pageSize, 20);
    return { bookings: bookings.slice((currentPage - 1) * pageSize, currentPage * pageSize), total, page: currentPage, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
  }
  async adminStats(ownerId?: string) {
    const hotels = (await this.allHotels()).filter(h => !h.deletedAt && (!ownerId || h.ownerId === ownerId));
    const hotelIds = new Set(hotels.map(hotel => hotel.id));
    const rooms = (await this.allRooms()).filter(r => !r.deletedAt && (!ownerId || hotelIds.has(r.hotelId)));
    const bookings = (await BookingModel.find(ownerId ? { hotelId: { $in: [...hotelIds] } } : {}).lean()).map(stripMongo);
    const revenue = bookings.filter(b => b.paymentStatus === 'paid').reduce((sum, b) => sum + (b.priceBreakdown?.total || 0), 0);
    const monthKey = new Date().toISOString().slice(0, 7);
    return {
      totalHotels: hotels.length, activeHotels: hotels.filter(h => h.status === 'active').length,
      totalRooms: rooms.length, activeRooms: rooms.filter(r => r.status === 'active').length,
      totalBookings: bookings.length,
      bookingsThisMonth: bookings.filter(b => String(b.createdAt).startsWith(monthKey)).length,
      pendingPayments: bookings.filter(b => b.paymentStatus === 'pending').length,
      confirmedBookings: bookings.filter(b => b.status === 'confirmed').length,
      cancelledBookings: bookings.filter(b => b.status === 'cancelled').length,
      revenueBdt: revenue
    };
  }
}

export function createHotelStore() { return new HotelStore(); }
