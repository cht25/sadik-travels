import type { Express } from 'express';
import { z, ZodError } from 'zod';
import { randomUUID } from 'node:crypto';
import { AppError } from './errors.js';
import { optionalAuth, requireAuth, requireHotelManager } from './middleware.js';
import { rateLimit } from './rate-limit.js';
import type { Store } from './store.js';
import type { PaymentProvider } from './providers.js';
import type { HotelStore } from './hotel-store.js';
import type { MediaService } from './media.js';

const toInput = (schema: z.ZodTypeAny, value: unknown) => { try { return schema.parse(value); } catch (error) { if (error instanceof ZodError) throw new AppError(400, 'VALIDATION_ERROR', 'Please check the submitted fields', error.flatten()); throw error; } };
const clientMeta = (req: any) => ({ ip: req.ip, userAgent: req.get('user-agent')?.slice(0, 500) });

const imageSchema = z.object({ url: z.string().max(1000), publicId: z.string().max(300).optional(), mediaId: z.string().uuid().optional(), alt: z.string().max(300).optional() });
const seasonalDiscountSchema = z.object({ name: z.string().trim().min(2).max(120), startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), percentage: z.number().min(0).max(100) }).refine(value => value.endDate >= value.startDate, { message: 'Discount end date must not precede its start date', path: ['endDate'] });
const cancellationSchema = z.object({ type: z.enum(['free', 'non_refundable']).default('free'), freeUntilDays: z.number().int().min(0).max(365).optional(), description: z.string().max(500).optional() });
const hotelInputSchema = z.object({
  slug: z.string().trim().min(2).max(160).regex(/^[a-z0-9]+(?:-[a-z0-9-]+)*$/), name: z.string().trim().min(2).max(160),
  shortDescription: z.string().max(300).optional(), description: z.string().max(5000).optional(),
  propertyType: z.string().max(80).default('Hotel'), address: z.string().max(300).optional(), city: z.string().trim().min(2).max(120), country: z.string().max(120).default('Bangladesh'), area: z.string().max(120).optional(),
  latitude: z.number().min(-90).max(90).optional(), longitude: z.number().min(-180).max(180).optional(), phone: z.string().max(40).optional(), email: z.string().email().max(160).optional(), website: z.string().max(200).optional(),
  starRating: z.number().int().min(0).max(5).default(3), guestRating: z.number().min(0).max(5).optional(),
  amenities: z.array(z.string().max(80)).default([]), facilities: z.array(z.string().max(80)).default([]), images: z.array(imageSchema).default([]),
  roomTypes: z.array(z.string().trim().min(1).max(120)).max(50).default([]), pricePerNight: z.number().nonnegative().max(1000000).optional(), seasonalDiscounts: z.array(seasonalDiscountSchema).max(30).default([]), available: z.boolean().default(true), ownerId: z.string().uuid().optional(),
  checkInTime: z.string().max(20).optional(), checkOutTime: z.string().max(20).optional(), cancellationPolicy: cancellationSchema.optional(),
  status: z.enum(['draft', 'active', 'hidden', 'archived']).default('active'), featured: z.boolean().default(false), sortOrder: z.number().int().min(-100000).max(100000).default(0)
});
const roomInputSchema = z.object({
  name: z.string().trim().min(2).max(160), slug: z.string().trim().min(2).max(160).regex(/^[a-z0-9]+(?:-[a-z0-9-]+)*$/), description: z.string().max(3000).optional(),
  images: z.array(imageSchema).default([]), size: z.number().int().min(0).max(100000).optional(), bedType: z.string().max(60).optional(), numBeds: z.number().int().min(0).max(20).optional(),
  maxAdults: z.number().int().min(1).max(20).default(2), maxChildren: z.number().int().min(0).max(20).default(0), maxGuests: z.number().int().min(1).max(30).default(3),
  amenities: z.array(z.string().max(80)).default([]), inventory: z.number().int().min(0).max(1000).default(5),
  pricePerNight: z.number().nonnegative().max(1000000), originalPrice: z.number().nonnegative().max(1000000).optional(), taxesPct: z.number().min(0).max(100).default(0), serviceFee: z.number().min(0).max(100000).default(0),
  cancellationPolicy: cancellationSchema.optional(), mealPlan: z.string().max(120).optional(),
  status: z.enum(['active', 'hidden', 'archived']).default('active'), sortOrder: z.number().int().min(-100000).max(100000).default(0)
});
const priceQuoteSchema = z.object({
  hotelId: z.string().min(3), checkIn: z.string().min(8).max(12), checkOut: z.string().min(8).max(12),
  rooms: z.array(z.object({ roomId: z.string().min(3), quantity: z.number().int().min(1).max(10).default(1), adults: z.number().int().min(1).max(20).default(2), children: z.number().int().min(0).max(20).default(0) })).min(1).max(8)
});
const bookingSchema = priceQuoteSchema.extend({
  primaryGuest: z.object({ firstName: z.string().trim().min(1).max(80), lastName: z.string().trim().min(1).max(80), email: z.string().email().max(160), phone: z.string().trim().min(4).max(40), country: z.string().max(80).optional() }),
  specialRequests: z.string().max(1000).optional(),
  paymentMethod: z.enum(['online', 'bank_transfer', 'cash', 'pay_later']).default('pay_later'),
  rooms: z.array(z.object({ roomId: z.string().min(3), quantity: z.number().int().min(1).max(10), adults: z.number().int().min(1).max(20), children: z.number().int().min(0).max(20).default(0), childAges: z.array(z.number().int().min(0).max(17)).max(10).optional() })).min(1).max(8),
  roomGuests: z.array(z.object({ roomIndex: z.number().int().min(0), name: z.string().max(120), type: z.enum(['adult', 'child']) })).max(100).optional()
});

export function registerHotelRoutes(app: Express, deps: { store: Store; hotelStore: HotelStore; media: MediaService; payment: PaymentProvider }) {
  const { store, hotelStore, payment } = deps;
  const ownerScope = (req: any) => req.user?.role === 'hotel_owner' ? req.user.id : undefined;
  const assertHotelAccess = async (req: any, hotelId: string) => {
    const hotel = await hotelStore.adminFindHotel(hotelId);
    if (!hotel) throw new AppError(404, 'HOTEL_NOT_FOUND', 'Hotel not found');
    if (req.user?.role === 'hotel_owner' && hotel.ownerId !== req.user.id) throw new AppError(403, 'HOTEL_OWNERSHIP_REQUIRED', 'You can manage only your own hotel listings');
    return hotel;
  };
  const assertRoomAccess = async (req: any, roomId: string) => {
    const room = await hotelStore.adminFindRoom(roomId);
    if (!room) throw new AppError(404, 'ROOM_NOT_FOUND', 'Room not found');
    await assertHotelAccess(req, room.hotelId);
    return room;
  };
  const assertBookingAccess = async (req: any, bookingId: string) => {
    const booking = await hotelStore.findBooking(bookingId);
    if (!booking) throw new AppError(404, 'BOOKING_NOT_FOUND', 'Booking not found');
    await assertHotelAccess(req, booking.hotelId);
    return booking;
  };

  // ---------- Public catalogue ----------
  app.get('/api/v1/hotels', rateLimit('hotel-search', 120, 60), async (req, res, next) => {
    try {
      const q = req.query;
      const result = await hotelStore.listHotels({
        q: q.q ? String(q.q) : undefined, destination: q.destination ? String(q.destination) : undefined,
        city: q.city ? String(q.city) : undefined, country: q.country ? String(q.country) : undefined,
        propertyType: q.propertyType ? String(q.propertyType) : undefined,
        minPrice: q.minPrice ? Number(q.minPrice) : undefined, maxPrice: q.maxPrice ? Number(q.maxPrice) : undefined,
        minStarRating: q.minStarRating ? Number(q.minStarRating) : undefined,
        minGuestRating: q.minGuestRating ? Number(q.minGuestRating) : undefined,
        area: q.area ? String(q.area) : undefined,
        neighborhoods: q.neighborhoods ? String(q.neighborhoods).split(',').map((s: string) => s.trim()).filter(Boolean) : undefined,
        amenities: q.amenities ? String(q.amenities).split(',').map((s: string) => s.trim()).filter(Boolean) : undefined,
        checkIn: q.checkIn ? String(q.checkIn) : undefined, checkOut: q.checkOut ? String(q.checkOut) : undefined,
        freeCancellationOnly: q.freeCancellation === 'true',
        sort: ['recommended', 'price_asc', 'price_desc', 'rating'].includes(String(q.sort)) ? String(q.sort) : 'recommended',
        page: Number(q.page) || 1, pageSize: Number(q.pageSize) || 12
      });
      res.json({ success: true, ...result });
    } catch (error) { next(error); }
  });

  app.get('/api/v1/hotels/destinations', rateLimit('hotel-destinations', 120, 60), async (req, res) => {
    const q = String(req.query.q || '').toLowerCase().trim();
    const result = await hotelStore.listHotels({ pageSize: 100 });
    const seen = new Map<string, { city: string; country: string; hotels: number }>();
    result.hotels.forEach((hotel: any) => { const key = `${hotel.city}|${hotel.country}`; const entry = seen.get(key) || { city: hotel.city, country: hotel.country, hotels: 0 }; entry.hotels += 1; seen.set(key, entry); });
    let destinations = [...seen.values()];
    if (q) destinations = destinations.filter(d => `${d.city} ${d.country}`.toLowerCase().includes(q));
    res.json({ success: true, destinations: destinations.sort((a, b) => b.hotels - a.hotels).slice(0, 12) });
  });

  app.get('/api/v1/hotels/:slug', rateLimit('hotel-detail', 120, 60), async (req, res, next) => {
    try {
      const hotel = await hotelStore.findHotel(String(req.params.slug), { checkIn: req.query.checkIn ? String(req.query.checkIn) : undefined, checkOut: req.query.checkOut ? String(req.query.checkOut) : undefined, withRooms: true });
      if (!hotel) throw new AppError(404, 'HOTEL_NOT_FOUND', 'Hotel not found');
      res.json({ success: true, hotel });
    } catch (error) { next(error); }
  });

  app.post('/api/v1/hotels/price-quote', rateLimit('hotel-quote', 60, 60), async (req, res, next) => {
    try { const input = toInput(priceQuoteSchema, req.body); const quote = await hotelStore.priceQuote(input); res.json({ success: true, ...quote }); }
    catch (error) { next(error); }
  });

  // ---------- Booking engine ----------
  app.post('/api/v1/hotels/bookings', requireAuth(store), rateLimit('hotel-booking', 10, 60), async (req, res, next) => {
    try {
      const input = toInput(bookingSchema, req.body);
      const booking = await hotelStore.createBooking((req as any).user.id, input);
      await store.audit('hotel.booking_created', { ...clientMeta(req), userId: (req as any).user.id, metadata: { bookingId: booking.id, bookingNumber: booking.bookingNumber, hotelId: input.hotelId, total: booking.priceBreakdown.total } });
      res.status(201).json({ success: true, booking });
    } catch (error) { next(error); }
  });

  app.get('/api/v1/hotels/bookings', requireAuth(store), async (req, res) => { res.json({ success: true, bookings: await hotelStore.listUserBookings((req as any).user.id) }); });

  app.get('/api/v1/hotels/bookings/:id', requireAuth(store), async (req, res, next) => {
    try { const booking = await hotelStore.findBooking(String(req.params.id), (req as any).user.id); if (!booking) throw new AppError(404, 'BOOKING_NOT_FOUND', 'Booking not found'); res.json({ success: true, booking, cancellation: hotelStore.canCancel(booking) }); }
    catch (error) { next(error); }
  });

  app.post('/api/v1/hotels/bookings/:id/cancel', requireAuth(store), async (req, res, next) => {
    try {
      const booking = await hotelStore.cancelBooking(String(req.params.id), (req as any).user.id, false);
      await store.audit('hotel.booking_cancelled', { ...clientMeta(req), userId: (req as any).user.id, metadata: { bookingId: booking.id, bookingNumber: booking.bookingNumber } });
      res.json({ success: true, booking });
    } catch (error) { next(error); }
  });

  app.post('/api/v1/hotels/bookings/:id/pay', requireAuth(store), async (req, res, next) => {
    try {
      const booking = await hotelStore.findBooking(String(req.params.id), (req as any).user.id);
      if (!booking) throw new AppError(404, 'BOOKING_NOT_FOUND', 'Booking not found');
      if (['cancelled', 'refunded', 'completed'].includes(booking.status)) throw new AppError(409, 'BOOKING_NOT_PAYABLE', 'This booking cannot be paid');
      const method = String(req.body?.paymentMethod || booking.paymentMethod || 'online');
      if (method === 'online') {
        const paymentRecord = await store.createPayment({ bookingId: booking.id, userId: (req as any).user.id, provider: 'hotel', amount: booking.priceBreakdown.total, currency: booking.priceBreakdown.currency, status: 'created' });
        try {
          const intent: any = await payment.createIntent({ paymentId: paymentRecord.id, bookingId: booking.id, amount: booking.priceBreakdown.total, currency: booking.priceBreakdown.currency, customerId: (req as any).user.id, returnUrl: `${process.env.APP_ORIGIN || ''}/booking/${booking.id}` });
          await hotelStore.patchBookingStatus(booking.id, { status: 'payment_pending', paymentStatus: 'pending' });
          await store.updatePayment(paymentRecord.id, { status: intent?.status === 'paid' ? 'paid' : 'pending', transactionRef: intent?.transactionRef, providerPayload: intent });
          res.json({ success: true, checkoutUrl: intent?.checkoutUrl, transactionRef: intent?.transactionRef, booking: await hotelStore.findBooking(booking.id, (req as any).user.id) });
        } catch (error) {
          await store.updatePayment(paymentRecord.id, { status: 'failed' });
          throw error;
        }
      }
      // Non-online methods: record the request; admin confirms.
      await hotelStore.patchBookingStatus(booking.id, { status: 'pending', paymentStatus: 'pending' });
      await store.audit('hotel.payment_requested', { ...clientMeta(req), userId: (req as any).user.id, metadata: { bookingId: booking.id, method } });
      res.json({ success: true, booking: await hotelStore.findBooking(booking.id, (req as any).user.id), message: 'Your booking request has been recorded. Our team will confirm payment and availability.' });
    } catch (error) { next(error); }
  });

  // ---------- Admin: hotels ----------
  app.get('/api/v1/admin/hotels', requireHotelManager(store, 'hotel.view'), async (req, res) => {
    const q = req.query;
    res.json(await hotelStore.adminListHotels({ ownerId: ownerScope(req), q: q.q ? String(q.q) : undefined, status: ['all', 'draft', 'active', 'hidden', 'archived'].includes(String(q.status)) ? String(q.status) as any : 'all', page: Number(q.page) || 1, pageSize: Number(q.pageSize) || 20 }));
  });
  app.get('/api/v1/admin/hotels/stats', requireHotelManager(store, 'hotel.view'), async (req, res) => res.json({ success: true, stats: await hotelStore.adminStats(ownerScope(req)) }));
  app.post('/api/v1/admin/hotels', requireHotelManager(store, 'hotel.create'), async (req, res, next) => {
    try { const input = toInput(hotelInputSchema, req.body) as any; const actor = (req as any).user; if (actor.role !== 'super_admin') input.ownerId = actor.id; else if (input.ownerId) { const owner = await store.findUserById(input.ownerId); if (!owner || owner.role !== 'hotel_owner' || owner.status !== 'active') throw new AppError(400, 'INVALID_HOTEL_OWNER', 'Choose an active Hotel Owner'); } const hotel = await hotelStore.adminCreateHotel(input, actor.id); await store.audit('hotel.created', { ...clientMeta(req), userId: (req as any).user.id, metadata: { hotelId: hotel.id, slug: hotel.slug } }); res.status(201).json({ hotel }); }
    catch (error) { next(error); }
  });
  app.get('/api/v1/admin/hotels/:id', requireHotelManager(store, 'hotel.view'), async (req, res, next) => {
    try { const hotel = await assertHotelAccess(req, String(req.params.id)); const rooms = await hotelStore.adminListRooms(hotel.id); res.json({ hotel, rooms }); }
    catch (error) { next(error); }
  });
  app.patch('/api/v1/admin/hotels/:id', requireHotelManager(store, 'hotel.update'), async (req, res, next) => {
    try { const input = toInput(hotelInputSchema.partial(), req.body) as any; const current = await assertHotelAccess(req, String(req.params.id)); if ((req as any).user.role !== 'super_admin') delete input.ownerId; else if (input.ownerId) { const owner = await store.findUserById(input.ownerId); if (!owner || owner.role !== 'hotel_owner' || owner.status !== 'active') throw new AppError(400, 'INVALID_HOTEL_OWNER', 'Choose an active Hotel Owner'); } const hotel = await hotelStore.adminUpdateHotel(current.id, input, (req as any).user.id); if (!hotel) throw new AppError(404, 'HOTEL_NOT_FOUND', 'Hotel not found'); await store.audit('hotel.updated', { ...clientMeta(req), userId: (req as any).user.id, metadata: { hotelId: hotel.id, keys: Object.keys(input) } }); res.json({ hotel }); }
    catch (error) { next(error); }
  });
  app.delete('/api/v1/admin/hotels/:id', requireHotelManager(store, 'hotel.delete'), async (req, res, next) => {
    try { const id = String(req.params.id); await assertHotelAccess(req, id); if (req.query.hard === 'true') { const deleted = await hotelStore.adminDeleteHotel(id); if (!deleted) throw new AppError(404, 'HOTEL_NOT_FOUND', 'Hotel not found'); await store.audit('hotel.deleted', { ...clientMeta(req), userId: (req as any).user.id, metadata: { hotelId: id } }); return res.json({ deleted: true }); } const hotel = await hotelStore.adminArchiveHotel(id); if (!hotel) throw new AppError(404, 'HOTEL_NOT_FOUND', 'Hotel not found'); await store.audit('hotel.archived', { ...clientMeta(req), userId: (req as any).user.id, metadata: { hotelId: id } }); res.json({ hotel }); }
    catch (error) { next(error); }
  });
  app.post('/api/v1/admin/hotels/:id/restore', requireHotelManager(store, 'hotel.update'), async (req, res, next) => {
    try { await assertHotelAccess(req, String(req.params.id)); const hotel = await hotelStore.adminRestoreHotel(String(req.params.id)); if (!hotel) throw new AppError(404, 'HOTEL_NOT_FOUND', 'Hotel not found'); await store.audit('hotel.restored', { ...clientMeta(req), userId: (req as any).user.id, metadata: { hotelId: hotel.id } }); res.json({ hotel }); }
    catch (error) { next(error); }
  });

  // ---------- Admin: rooms ----------
  app.get('/api/v1/admin/hotels/:id/rooms', requireHotelManager(store, 'room.view'), async (req, res, next) => { try { await assertHotelAccess(req, String(req.params.id)); res.json({ rooms: await hotelStore.adminListRooms(String(req.params.id)) }); } catch (error) { next(error); } });
  app.post('/api/v1/admin/hotels/:id/rooms', requireHotelManager(store, 'room.create'), async (req, res, next) => {
    try { await assertHotelAccess(req, String(req.params.id)); const input = toInput(roomInputSchema, req.body); const room = await hotelStore.adminCreateRoom(String(req.params.id), input as any, (req as any).user.id); await store.audit('hotel.room_created', { ...clientMeta(req), userId: (req as any).user.id, metadata: { hotelId: req.params.id, roomId: room.id } }); res.status(201).json({ room }); }
    catch (error) { next(error); }
  });
  app.patch('/api/v1/admin/hotels/:hotelId/rooms/:roomId', requireHotelManager(store, 'room.update'), async (req, res, next) => {
    try { const ownedRoom = await assertRoomAccess(req, String(req.params.roomId)); if (ownedRoom.hotelId !== String(req.params.hotelId)) throw new AppError(404, 'ROOM_NOT_FOUND', 'Room not found'); const input = toInput(roomInputSchema.partial(), req.body); const room = await hotelStore.adminUpdateRoom(String(req.params.roomId), input as any, (req as any).user.id); if (!room) throw new AppError(404, 'ROOM_NOT_FOUND', 'Room not found'); await store.audit('hotel.room_updated', { ...clientMeta(req), userId: (req as any).user.id, metadata: { roomId: room.id, keys: Object.keys(input) } }); res.json({ room }); }
    catch (error) { next(error); }
  });
  app.delete('/api/v1/admin/hotels/:hotelId/rooms/:roomId', requireHotelManager(store, 'room.delete'), async (req, res, next) => {
    try { const ownedRoom = await assertRoomAccess(req, String(req.params.roomId)); if (ownedRoom.hotelId !== String(req.params.hotelId)) throw new AppError(404, 'ROOM_NOT_FOUND', 'Room not found'); const room = await hotelStore.adminArchiveRoom(String(req.params.roomId)); if (!room) throw new AppError(404, 'ROOM_NOT_FOUND', 'Room not found'); await store.audit('hotel.room_archived', { ...clientMeta(req), userId: (req as any).user.id, metadata: { roomId: room.id } }); res.json({ room }); }
    catch (error) { next(error); }
  });

  // ---------- Admin: inventory ----------
  app.get('/api/v1/admin/hotels/rooms/:roomId/inventory', requireHotelManager(store, 'room.view'), async (req, res, next) => {
    try { await assertRoomAccess(req, String(req.params.roomId)); const inv = await hotelStore.adminInventory(String(req.params.roomId), String(req.query.from || new Date().toISOString().slice(0, 10)), Number(req.query.days) || 30); if (!inv) throw new AppError(404, 'ROOM_NOT_FOUND', 'Room not found'); res.json({ success: true, ...inv }); }
    catch (error) { next(error); }
  });
  app.patch('/api/v1/admin/hotels/rooms/:roomId/inventory', requireHotelManager(store, 'room.update'), async (req, res, next) => {
    try { await assertRoomAccess(req, String(req.params.roomId)); const inv = await hotelStore.adminSetInventory(String(req.params.roomId), String(req.body.date), Number(req.body.available)); if (!inv) throw new AppError(404, 'ROOM_NOT_FOUND', 'Room not found'); await store.audit('hotel.inventory_updated', { ...clientMeta(req), userId: (req as any).user.id, metadata: { roomId: req.params.roomId, date: req.body.date, available: req.body.available } }); res.json({ inventory: inv }); }
    catch (error) { next(error); }
  });

  // ---------- Admin: bookings ----------
  app.get('/api/v1/admin/hotel-bookings', requireHotelManager(store, 'booking.view'), async (req, res) => {
    const q = req.query;
    res.json(await hotelStore.adminListBookings({ ownerId: ownerScope(req), q: q.q ? String(q.q) : undefined, status: String(q.status || 'all'), paymentStatus: String(q.paymentStatus || 'all'), page: Number(q.page) || 1, pageSize: Number(q.pageSize) || 20 }));
  });
  app.get('/api/v1/admin/hotel-bookings/:id', requireHotelManager(store, 'booking.view'), async (req, res, next) => {
    try { const booking = await assertBookingAccess(req, String(req.params.id)); res.json({ booking, cancellation: hotelStore.canCancel(booking) }); }
    catch (error) { next(error); }
  });
  app.patch('/api/v1/admin/hotel-bookings/:id', requireHotelManager(store, 'booking.update'), async (req, res, next) => {
    try {
      const input = toInput(z.object({ status: z.enum(['pending', 'payment_pending', 'confirmed', 'cancelled', 'completed', 'refund_requested', 'refunded', 'failed', 'expired']).optional(), paymentStatus: z.enum(['pending', 'paid', 'failed', 'refunded', 'partial']).optional() }).strict(), req.body);
      const current = await assertBookingAccess(req, String(req.params.id));
      const booking = await hotelStore.patchBookingStatus(String(req.params.id), input as any);
      await store.audit('hotel.booking_updated', { ...clientMeta(req), userId: (req as any).user.id, metadata: { bookingId: req.params.id, previousStatus: current.status, previousPayment: current.paymentStatus, status: input.status, paymentStatus: input.paymentStatus } });
      res.json({ booking });
    } catch (error) { next(error); }
  });
}
