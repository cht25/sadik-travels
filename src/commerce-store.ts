import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { AppError } from './errors.js';

/**
 * Commerce & catalogue layer (add-on module).
 *
 * Uses the same shared mongoose connection and UUID-keyed conventions as the
 * core store and the hotel store. Every bookable / sellable product that is not
 * a hotel room lives in the `catalog_products` collection with a `type`
 * discriminator, so a single admin CRUD surface, a single storefront renderer
 * and a single order engine serve every vertical.
 *
 * All money is stored in the smallest sensible unit for the currency (BDT
 * whole taka) as a Number and is ALWAYS recomputed on the server. Prices,
 * discounts, coupons, taxes and totals sent by a browser are never trusted.
 */

export const CATALOG_TYPES = [
  'esim', 'umrah_package', 'umrah_fare', 'holiday_package', 'medical_tourism',
  'visa_service', 'home', 'card_offer', 'airline_offer', 'destination', 'flight_offer', 'accessory'
] as const;
export type CatalogType = typeof CATALOG_TYPES[number];
export type CatalogStatus = 'draft' | 'published' | 'archived';

export type CatalogImage = { url: string; publicId?: string; mediaId?: string; alt?: string };

export type CatalogProduct = {
  id: string; type: CatalogType; slug: string; title: string; subtitle?: string; summary?: string; description?: string;
  country?: string; city?: string; destination?: string; region?: string;
  heroImage?: CatalogImage; images: CatalogImage[];
  price: number; originalPrice?: number; currency: string; serviceCharge: number; taxPct: number;
  durationDays?: number; durationNights?: number;
  // eSIM
  dataAmount?: string; validityDays?: number; network?: string; activation?: string; coverage: string[];
  // Visa
  visaType?: string; processingTime?: string; validity?: string; entryType?: string; requiredDocuments: string[];
  // Packages
  itinerary: Array<{ day: number; title: string; detail?: string }>;
  inclusions: string[]; exclusions: string[]; hotelInfo?: string; transportInfo?: string; guideInfo?: string;
  // Medical tourism
  hospital?: string; treatmentCategory?: string; doctor?: string; estimatedCost?: string;
  // Homes
  propertyType?: string; guests?: number; bedrooms?: number; beds?: number; bathrooms?: number; amenities: string[];
  // Offers
  bank?: string; cardName?: string; airline?: string; route?: string; promoCode?: string; discountLabel?: string;
  startDate?: string; endDate?: string; terms?: string;
  rating?: number; reviewCount: number; tags: string[];
  availability: number; bookable: boolean; featured: boolean; status: CatalogStatus; sortOrder: number;
  metadata: Record<string, unknown>;
  createdBy?: string; updatedBy?: string; createdAt: string; updatedAt: string;
};

export type CatalogFilters = {
  type?: CatalogType | 'all'; status?: CatalogStatus | 'all'; q?: string; country?: string; destination?: string;
  minPrice?: number; maxPrice?: number; featured?: boolean; tags?: string[];
  sort?: 'recommended' | 'price_asc' | 'price_desc' | 'rating' | 'newest' | 'popular';
  page?: number; pageSize?: number;
};

export type CartItem = {
  id: string; productType: string; productId: string; slug?: string; title: string; imageUrl?: string;
  unitPrice: number; quantity: number; serviceCharge: number; taxPct: number; meta: Record<string, unknown>;
};
export type Cart = { id: string; userId: string; items: CartItem[]; couponCode?: string; currency: string; createdAt: string; updatedAt: string };

export type WishlistItem = { id: string; userId: string; productType: string; productId: string; slug?: string; title: string; imageUrl?: string; price?: number; createdAt: string };

export type DiscountType = 'percent' | 'fixed';
export type Coupon = {
  id: string; code: string; description?: string; discountType: DiscountType; value: number;
  minAmount: number; maxDiscount?: number; startDate?: string; endDate?: string;
  usageLimit?: number; perUserLimit: number; usedCount: number; applicableTypes: string[];
  status: 'active' | 'paused' | 'expired'; createdBy?: string; createdAt: string; updatedAt: string;
};

export type OrderStatus = 'pending' | 'confirmed' | 'processing' | 'completed' | 'cancelled' | 'refunded' | 'failed';
export type OrderPaymentStatus = 'pending' | 'processing' | 'paid' | 'failed' | 'refunded' | 'cancelled';
export type OrderItem = CartItem & { lineSubtotal: number; lineTax: number; lineTotal: number };
export type OrderTimelineEntry = { at: string; status: string; note?: string; actorId?: string };
export type OrderCustomer = { fullName: string; email: string; phone: string; address?: string; dateOfBirth?: string; nationality?: string };
export type OrderTraveler = { fullName: string; dateOfBirth?: string; gender?: string; nationality?: string; passportNumber?: string; passportExpiry?: string };

export type Order = {
  id: string; orderNumber: string; userId: string; kind: 'order' | 'booking'; primaryType: string;
  items: OrderItem[]; customer: OrderCustomer; travelers: OrderTraveler[];
  travelDate?: string; notes?: string;
  subtotal: number; discount: number; couponCode?: string; couponDiscount: number; tax: number; serviceFee: number; total: number; currency: string;
  paymentMethod?: string; paymentStatus: OrderPaymentStatus; paymentId?: string; transactionRef?: string;
  status: OrderStatus; timeline: OrderTimelineEntry[]; invoiceId?: string;
  contactEmail?: string; contactPhone?: string;
  createdAt: string; updatedAt: string;
};

export type Invoice = {
  id: string; invoiceNumber: string; orderId: string; orderNumber: string; userId: string;
  customer: OrderCustomer; items: OrderItem[]; subtotal: number; discount: number; tax: number; serviceFee: number; total: number; currency: string;
  paymentMethod?: string; status: 'issued' | 'paid' | 'void' | 'refunded'; issuedAt: string; paidAt?: string; createdAt: string; updatedAt: string;
};

export type SavedTraveler = {
  id: string; userId: string; fullName: string; relationship?: string; dateOfBirth?: string; gender?: string; nationality?: string;
  passportNumber?: string; passportExpiry?: string; phone?: string; email?: string; isPrimary: boolean; createdAt: string; updatedAt: string;
};

export type Review = {
  id: string; userId: string; userName: string; productType: string; productId: string; productTitle?: string;
  orderId?: string; rating: number; title?: string; body: string; status: 'pending' | 'approved' | 'rejected';
  adminReply?: string; createdAt: string; updatedAt: string;
};

export type VisaApplication = {
  id: string; referenceNumber: string; userId: string; productId: string; productTitle: string; orderId?: string;
  applicant: { fullName: string; email: string; phone: string; dateOfBirth?: string; nationality?: string; address?: string };
  passport: { number: string; issueDate?: string; expiryDate?: string; issuingCountry?: string };
  documents: Array<{ label: string; url: string; publicId?: string; mediaId?: string }>;
  travelDate?: string; status: 'submitted' | 'document_review' | 'processing' | 'approved' | 'rejected' | 'cancelled';
  timeline: OrderTimelineEntry[]; adminNote?: string; createdAt: string; updatedAt: string;
};

const now = () => new Date().toISOString();
const stamp = { createdAt: { type: String, default: now }, updatedAt: { type: String, default: now } };
const baseOptions = { versionKey: false, minimize: false } as const;

const imageSchema = new mongoose.Schema({ url: String, publicId: String, mediaId: String, alt: String }, { _id: false, versionKey: false });

const catalogSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  type: { type: String, required: true, index: true },
  slug: { type: String, required: true, index: true },
  title: { type: String, required: true }, subtitle: String, summary: String, description: String,
  country: String, city: String, destination: String, region: String,
  heroImage: { type: imageSchema, default: undefined }, images: { type: [imageSchema], default: [] },
  price: { type: Number, default: 0 }, originalPrice: Number, currency: { type: String, default: 'BDT' },
  serviceCharge: { type: Number, default: 0 }, taxPct: { type: Number, default: 0 },
  durationDays: Number, durationNights: Number,
  dataAmount: String, validityDays: Number, network: String, activation: String, coverage: { type: [String], default: [] },
  visaType: String, processingTime: String, validity: String, entryType: String, requiredDocuments: { type: [String], default: [] },
  itinerary: { type: [{ _id: false, day: Number, title: String, detail: String }], default: [] },
  inclusions: { type: [String], default: [] }, exclusions: { type: [String], default: [] },
  hotelInfo: String, transportInfo: String, guideInfo: String,
  hospital: String, treatmentCategory: String, doctor: String, estimatedCost: String,
  propertyType: String, guests: Number, bedrooms: Number, beds: Number, bathrooms: Number, amenities: { type: [String], default: [] },
  bank: String, cardName: String, airline: String, route: String, promoCode: String, discountLabel: String,
  startDate: String, endDate: String, terms: String,
  rating: Number, reviewCount: { type: Number, default: 0 }, tags: { type: [String], default: [] },
  availability: { type: Number, default: 100 }, bookable: { type: Boolean, default: true },
  featured: { type: Boolean, default: false }, status: { type: String, default: 'draft', index: true },
  sortOrder: { type: Number, default: 0 }, metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  createdBy: String, updatedBy: String, ...stamp
}, baseOptions);
catalogSchema.index({ type: 1, slug: 1 }, { unique: true });
catalogSchema.index({ type: 1, status: 1, sortOrder: 1, createdAt: -1 });
catalogSchema.index({ status: 1, featured: -1 });
catalogSchema.index({ title: 'text', summary: 'text', destination: 'text', country: 'text', city: 'text', tags: 'text' });

const cartItemSchema = new mongoose.Schema({
  id: String, productType: String, productId: String, slug: String, title: String, imageUrl: String,
  unitPrice: Number, quantity: Number, serviceCharge: { type: Number, default: 0 }, taxPct: { type: Number, default: 0 },
  meta: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { _id: false, versionKey: false });

const cartSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  userId: { type: String, required: true, unique: true, index: true },
  items: { type: [cartItemSchema], default: [] }, couponCode: String, currency: { type: String, default: 'BDT' }, ...stamp
}, baseOptions);

const wishlistSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  userId: { type: String, required: true, index: true },
  productType: { type: String, required: true }, productId: { type: String, required: true },
  slug: String, title: String, imageUrl: String, price: Number, createdAt: { type: String, default: now }
}, baseOptions);
wishlistSchema.index({ userId: 1, productType: 1, productId: 1 }, { unique: true });

const couponSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  code: { type: String, required: true, unique: true, uppercase: true, index: true },
  description: String, discountType: { type: String, default: 'percent' }, value: { type: Number, default: 0 },
  minAmount: { type: Number, default: 0 }, maxDiscount: Number, startDate: String, endDate: String,
  usageLimit: Number, perUserLimit: { type: Number, default: 1 }, usedCount: { type: Number, default: 0 },
  applicableTypes: { type: [String], default: [] }, status: { type: String, default: 'active', index: true },
  createdBy: String, ...stamp
}, baseOptions);

const redemptionSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true }, couponId: { type: String, index: true },
  code: String, userId: { type: String, index: true }, orderId: String, amount: Number, createdAt: { type: String, default: now }
}, baseOptions);

const orderItemSchema = new mongoose.Schema({
  id: String, productType: String, productId: String, slug: String, title: String, imageUrl: String,
  unitPrice: Number, quantity: Number, serviceCharge: Number, taxPct: Number,
  lineSubtotal: Number, lineTax: Number, lineTotal: Number, meta: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { _id: false, versionKey: false });

const orderSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  orderNumber: { type: String, required: true, unique: true, index: true },
  userId: { type: String, required: true, index: true },
  kind: { type: String, default: 'order' }, primaryType: { type: String, index: true },
  items: { type: [orderItemSchema], default: [] },
  customer: { type: mongoose.Schema.Types.Mixed, default: {} },
  travelers: { type: [mongoose.Schema.Types.Mixed], default: [] },
  travelDate: String, notes: String,
  subtotal: Number, discount: { type: Number, default: 0 }, couponCode: String, couponDiscount: { type: Number, default: 0 },
  tax: { type: Number, default: 0 }, serviceFee: { type: Number, default: 0 }, total: Number, currency: { type: String, default: 'BDT' },
  paymentMethod: String, paymentStatus: { type: String, default: 'pending', index: true }, paymentId: String, transactionRef: String,
  status: { type: String, default: 'pending', index: true },
  timeline: { type: [mongoose.Schema.Types.Mixed], default: [] }, invoiceId: String,
  contactEmail: { type: String, index: true }, contactPhone: { type: String, index: true }, ...stamp
}, baseOptions);
orderSchema.index({ createdAt: -1 });

const invoiceSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  invoiceNumber: { type: String, required: true, unique: true },
  orderId: { type: String, required: true, index: true }, orderNumber: String,
  userId: { type: String, required: true, index: true },
  customer: { type: mongoose.Schema.Types.Mixed, default: {} }, items: { type: [orderItemSchema], default: [] },
  subtotal: Number, discount: Number, tax: Number, serviceFee: Number, total: Number, currency: { type: String, default: 'BDT' },
  paymentMethod: String, status: { type: String, default: 'issued' }, issuedAt: { type: String, default: now }, paidAt: String, ...stamp
}, baseOptions);

const travelerSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  userId: { type: String, required: true, index: true },
  fullName: { type: String, required: true }, relationship: String, dateOfBirth: String, gender: String, nationality: String,
  passportNumber: String, passportExpiry: String, phone: String, email: String, isPrimary: { type: Boolean, default: false }, ...stamp
}, baseOptions);

const reviewSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  userId: { type: String, required: true, index: true }, userName: String,
  productType: { type: String, index: true }, productId: { type: String, index: true }, productTitle: String,
  orderId: String, rating: { type: Number, min: 1, max: 5 }, title: String, body: String,
  status: { type: String, default: 'pending', index: true }, adminReply: String, ...stamp
}, baseOptions);

const visaApplicationSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  referenceNumber: { type: String, required: true, unique: true, index: true },
  userId: { type: String, required: true, index: true },
  productId: String, productTitle: String, orderId: String,
  applicant: { type: mongoose.Schema.Types.Mixed, default: {} },
  passport: { type: mongoose.Schema.Types.Mixed, default: {} },
  documents: { type: [mongoose.Schema.Types.Mixed], default: [] },
  travelDate: String, status: { type: String, default: 'submitted', index: true },
  timeline: { type: [mongoose.Schema.Types.Mixed], default: [] }, adminNote: String, ...stamp
}, baseOptions);

/** Models are intentionally untyped (like the hotel store) so the TypeScript
 *  compiler does not have to infer mongoose's very expensive document generics.
 *  Every read is normalised through `clean`/`cleanList`, which apply our types. */
const buildModel = (name: string, schema: mongoose.Schema, collection: string): mongoose.Model<any> =>
  (mongoose.models[name] as mongoose.Model<any>) ?? mongoose.model(name, schema, collection);

const CatalogModel = buildModel('CatalogProduct', catalogSchema, 'catalog_products');
const CartModel = buildModel('Cart', cartSchema, 'carts');
const WishlistModel = buildModel('WishlistItem', wishlistSchema, 'wishlist_items');
const CouponModel = buildModel('Coupon', couponSchema, 'coupons');
const RedemptionModel = buildModel('CouponRedemption', redemptionSchema, 'coupon_redemptions');
const OrderModel = buildModel('Order', orderSchema, 'orders');
const InvoiceModel = buildModel('Invoice', invoiceSchema, 'invoices');
const TravelerModel = buildModel('SavedTraveler', travelerSchema, 'saved_travelers');
const ReviewModel = buildModel('Review', reviewSchema, 'reviews');
const VisaApplicationModel = buildModel('VisaApplication', visaApplicationSchema, 'visa_applications');

const clean = <T>(doc: any): T | undefined => {
  if (!doc) return undefined;
  const value = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  delete value._id; delete value.__v;
  return value as T;
};
const cleanList = <T>(docs: any[]): T[] => docs.map(doc => clean<T>(doc)!).filter(Boolean);
const round = (value: number) => Math.round((Number(value) || 0) * 100) / 100;
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Human friendly sequential-ish reference. Collision chance is negligible and guarded by a unique index. */
const reference = (prefix: string) => {
  const date = new Date();
  const ymd = `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`;
  const rand = randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
  return `${prefix}-${ymd}-${rand}`;
};

export type PriceBreakdown = {
  items: OrderItem[]; subtotal: number; discount: number; couponCode?: string; couponDiscount: number;
  tax: number; serviceFee: number; total: number; currency: string; couponMessage?: string;
};

export type CommerceStore = ReturnType<typeof createCommerceStore>;

export function createCommerceStore() {
  const ensureIndexes = async () => {
    await Promise.all([
      CatalogModel.createIndexes(), CartModel.createIndexes(), WishlistModel.createIndexes(),
      CouponModel.createIndexes(), OrderModel.createIndexes(), InvoiceModel.createIndexes(),
      TravelerModel.createIndexes(), ReviewModel.createIndexes(), VisaApplicationModel.createIndexes(),
      RedemptionModel.createIndexes()
    ]);
  };

  /* ---------------------------------------------------------------- catalog */
  const listCatalog = async (filters: CatalogFilters = {}) => {
    const page = Math.max(1, Number(filters.page) || 1);
    const pageSize = Math.min(60, Math.max(1, Number(filters.pageSize) || 12));
    const query: Record<string, unknown> = {};
    if (filters.type && filters.type !== 'all') query.type = filters.type;
    if (filters.status && filters.status !== 'all') query.status = filters.status;
    if (filters.country) query.country = new RegExp(`^${escapeRegex(filters.country)}$`, 'i');
    if (filters.destination) query.destination = new RegExp(escapeRegex(filters.destination), 'i');
    if (filters.featured !== undefined) query.featured = filters.featured;
    if (filters.tags?.length) query.tags = { $in: filters.tags };
    if (filters.minPrice !== undefined || filters.maxPrice !== undefined) {
      query.price = {
        ...(filters.minPrice !== undefined ? { $gte: filters.minPrice } : {}),
        ...(filters.maxPrice !== undefined ? { $lte: filters.maxPrice } : {})
      };
    }
    if (filters.q) {
      const rx = new RegExp(escapeRegex(filters.q), 'i');
      query.$or = [{ title: rx }, { subtitle: rx }, { summary: rx }, { destination: rx }, { country: rx }, { city: rx }, { airline: rx }, { bank: rx }, { hospital: rx }, { tags: rx }];
    }
    const sortMap: Record<string, Record<string, 1 | -1>> = {
      recommended: { featured: -1, sortOrder: 1, createdAt: -1 },
      price_asc: { price: 1 }, price_desc: { price: -1 },
      rating: { rating: -1, reviewCount: -1 }, newest: { createdAt: -1 }, popular: { reviewCount: -1, rating: -1 }
    };
    const sort = sortMap[filters.sort || 'recommended'] || sortMap.recommended;
    const [docs, total] = await Promise.all([
      CatalogModel.find(query).sort(sort).skip((page - 1) * pageSize).limit(pageSize).lean(),
      CatalogModel.countDocuments(query)
    ]);
    return { products: cleanList<CatalogProduct>(docs), total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
  };

  const findCatalogProduct = async (idOrSlug: string, type?: CatalogType) => {
    const query: Record<string, unknown> = { $or: [{ id: idOrSlug }, { slug: idOrSlug }] };
    if (type) query.type = type;
    return clean<CatalogProduct>(await CatalogModel.findOne(query).lean());
  };

  const catalogFacets = async (type: CatalogType) => {
    const rows = await CatalogModel.aggregate([
      { $match: { type, status: 'published' } },
      { $group: { _id: null, minPrice: { $min: '$price' }, maxPrice: { $max: '$price' }, countries: { $addToSet: '$country' }, destinations: { $addToSet: '$destination' }, tags: { $push: '$tags' } } }
    ]);
    const row = rows[0] || {};
    return {
      minPrice: row.minPrice ?? 0, maxPrice: row.maxPrice ?? 0,
      countries: (row.countries || []).filter(Boolean).sort(),
      destinations: (row.destinations || []).filter(Boolean).sort(),
      tags: [...new Set(((row.tags || []) as string[][]).flat().filter(Boolean))].sort()
    };
  };

  const createCatalogProduct = async (input: Partial<CatalogProduct> & { type: CatalogType; slug: string; title: string; createdBy?: string }) => {
    const exists = await CatalogModel.findOne({ type: input.type, slug: input.slug }).lean();
    if (exists) throw new AppError(409, 'SLUG_IN_USE', 'Another product of this type already uses that slug');
    const doc = await CatalogModel.create({ ...input, id: randomUUID(), createdAt: now(), updatedAt: now() });
    return clean<CatalogProduct>(doc)!;
  };

  const updateCatalogProduct = async (id: string, patch: Partial<CatalogProduct>) => {
    const current = clean<CatalogProduct>(await CatalogModel.findOne({ id }).lean());
    if (!current) return undefined;
    if (patch.slug && patch.slug !== current.slug) {
      const exists = await CatalogModel.findOne({ type: patch.type || current.type, slug: patch.slug, id: { $ne: id } }).lean();
      if (exists) throw new AppError(409, 'SLUG_IN_USE', 'Another product of this type already uses that slug');
    }
    return clean<CatalogProduct>(await CatalogModel.findOneAndUpdate({ id }, { $set: { ...patch, updatedAt: now() } }, { new: true }).lean());
  };

  const archiveCatalogProduct = async (id: string) =>
    clean<CatalogProduct>(await CatalogModel.findOneAndUpdate({ id }, { $set: { status: 'archived', updatedAt: now() } }, { new: true }).lean());
  const deleteCatalogProduct = async (id: string) => (await CatalogModel.deleteOne({ id })).deletedCount > 0;

  const catalogStats = async () => {
    const rows = await CatalogModel.aggregate([{ $group: { _id: { type: '$type', status: '$status' }, count: { $sum: 1 } } }]);
    const byType: Record<string, { total: number; published: number; draft: number; archived: number }> = {};
    for (const row of rows) {
      const type = row._id.type as string;
      byType[type] ||= { total: 0, published: 0, draft: 0, archived: 0 };
      byType[type].total += row.count;
      const status = row._id.status as 'published' | 'draft' | 'archived';
      if (status in byType[type]) byType[type][status] += row.count;
    }
    return byType;
  };

  /* --------------------------------------------------------------- wishlist */
  const listWishlist = async (userId: string) =>
    cleanList<WishlistItem>(await WishlistModel.find({ userId }).sort({ createdAt: -1 }).lean());

  const addWishlist = async (input: Omit<WishlistItem, 'id' | 'createdAt'>) => {
    const doc = await WishlistModel.findOneAndUpdate(
      { userId: input.userId, productType: input.productType, productId: input.productId },
      { $setOnInsert: { ...input, id: randomUUID(), createdAt: now() } },
      { new: true, upsert: true }
    ).lean();
    return clean<WishlistItem>(doc)!;
  };

  const removeWishlist = async (userId: string, productId: string) =>
    (await WishlistModel.deleteOne({ userId, $or: [{ id: productId }, { productId }] })).deletedCount > 0;

  /* ------------------------------------------------------------------- cart */
  const getCart = async (userId: string): Promise<Cart> => {
    const existing = clean<Cart>(await CartModel.findOne({ userId }).lean());
    if (existing) return existing;
    const created = await CartModel.create({ id: randomUUID(), userId, items: [], currency: 'BDT', createdAt: now(), updatedAt: now() });
    return clean<Cart>(created)!;
  };

  const saveCart = async (userId: string, items: CartItem[], couponCode?: string | null) => {
    const update: Record<string, unknown> = { items, updatedAt: now() };
    if (couponCode === null) update.couponCode = undefined;
    else if (couponCode !== undefined) update.couponCode = couponCode;
    const doc = await CartModel.findOneAndUpdate(
      { userId },
      { $set: update, $setOnInsert: { id: randomUUID(), userId, currency: 'BDT', createdAt: now() } },
      { new: true, upsert: true }
    ).lean();
    return clean<Cart>(doc)!;
  };

  const clearCart = async (userId: string) => saveCart(userId, [], null);

  /* ---------------------------------------------------------------- coupons */
  const listCoupons = async (filters: { q?: string; status?: string; page?: number; pageSize?: number } = {}) => {
    const page = Math.max(1, Number(filters.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(filters.pageSize) || 20));
    const query: Record<string, unknown> = {};
    if (filters.status && filters.status !== 'all') query.status = filters.status;
    if (filters.q) query.code = new RegExp(escapeRegex(filters.q), 'i');
    const [docs, total] = await Promise.all([
      CouponModel.find(query).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
      CouponModel.countDocuments(query)
    ]);
    return { coupons: cleanList<Coupon>(docs), total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
  };
  const findCoupon = async (id: string) => clean<Coupon>(await CouponModel.findOne({ $or: [{ id }, { code: String(id).toUpperCase() }] }).lean());
  const createCoupon = async (input: Partial<Coupon> & { code: string }) => {
    const code = input.code.trim().toUpperCase();
    if (await CouponModel.findOne({ code }).lean()) throw new AppError(409, 'COUPON_EXISTS', 'A coupon with that code already exists');
    return clean<Coupon>(await CouponModel.create({ ...input, code, id: randomUUID(), usedCount: 0, createdAt: now(), updatedAt: now() }))!;
  };
  const updateCoupon = async (id: string, patch: Partial<Coupon>) => {
    if (patch.code) {
      const code = patch.code.trim().toUpperCase();
      if (await CouponModel.findOne({ code, id: { $ne: id } }).lean()) throw new AppError(409, 'COUPON_EXISTS', 'A coupon with that code already exists');
      patch.code = code;
    }
    return clean<Coupon>(await CouponModel.findOneAndUpdate({ id }, { $set: { ...patch, updatedAt: now() } }, { new: true }).lean());
  };
  const deleteCoupon = async (id: string) => (await CouponModel.deleteOne({ id })).deletedCount > 0;

  /**
   * Server-authoritative coupon evaluation. Returns the discount in currency
   * units, or a reason the coupon cannot be used. Never throws for a bad code
   * so checkout can degrade gracefully.
   */
  const evaluateCoupon = async (code: string, userId: string, subtotal: number, productTypes: string[]) => {
    const coupon = clean<Coupon>(await CouponModel.findOne({ code: String(code || '').trim().toUpperCase() }).lean());
    if (!coupon) return { valid: false as const, discount: 0, message: 'This coupon code is not valid' };
    if (coupon.status !== 'active') return { valid: false as const, discount: 0, message: 'This coupon is no longer active' };
    const nowMs = Date.now();
    if (coupon.startDate && Date.parse(coupon.startDate) > nowMs) return { valid: false as const, discount: 0, message: 'This coupon is not active yet' };
    if (coupon.endDate && Date.parse(coupon.endDate) < nowMs) return { valid: false as const, discount: 0, message: 'This coupon has expired' };
    if (coupon.usageLimit && coupon.usedCount >= coupon.usageLimit) return { valid: false as const, discount: 0, message: 'This coupon has reached its usage limit' };
    if (subtotal < (coupon.minAmount || 0)) return { valid: false as const, discount: 0, message: `Minimum order of ৳${Number(coupon.minAmount).toLocaleString('en-BD')} required for this coupon` };
    if (coupon.applicableTypes?.length && !productTypes.some(type => coupon.applicableTypes.includes(type))) {
      return { valid: false as const, discount: 0, message: 'This coupon does not apply to the items in your order' };
    }
    const used = await RedemptionModel.countDocuments({ couponId: coupon.id, userId });
    if (coupon.perUserLimit && used >= coupon.perUserLimit) return { valid: false as const, discount: 0, message: 'You have already used this coupon' };
    let discount = coupon.discountType === 'percent' ? (subtotal * coupon.value) / 100 : coupon.value;
    if (coupon.maxDiscount) discount = Math.min(discount, coupon.maxDiscount);
    discount = round(Math.min(discount, subtotal));
    return { valid: true as const, discount, coupon, message: `Coupon ${coupon.code} applied` };
  };

  const redeemCoupon = async (couponId: string, code: string, userId: string, orderId: string, amount: number) => {
    await RedemptionModel.create({ id: randomUUID(), couponId, code, userId, orderId, amount, createdAt: now() });
    await CouponModel.updateOne({ id: couponId }, { $inc: { usedCount: 1 }, $set: { updatedAt: now() } });
  };

  /* ------------------------------------------------------------- price math */
  /** Recomputes every line from the persisted catalogue price. Frontend numbers are ignored. */
  const priceCart = async (items: CartItem[], options: { couponCode?: string; userId: string }): Promise<PriceBreakdown> => {
    const priced: OrderItem[] = [];
    for (const item of items) {
      const product = await findCatalogProduct(item.productId, undefined);
      const unitPrice = product ? round(product.price) : round(item.unitPrice);
      const serviceCharge = product ? round(product.serviceCharge || 0) : round(item.serviceCharge || 0);
      const taxPct = product ? Number(product.taxPct || 0) : Number(item.taxPct || 0);
      const quantity = Math.max(1, Math.min(30, Math.floor(Number(item.quantity) || 1)));
      const lineSubtotal = round(unitPrice * quantity);
      const lineTax = round((lineSubtotal * taxPct) / 100);
      priced.push({
        ...item, quantity, unitPrice, serviceCharge, taxPct,
        title: product?.title || item.title, slug: product?.slug || item.slug,
        imageUrl: product?.heroImage?.url || product?.images?.[0]?.url || item.imageUrl,
        productType: product?.type || item.productType,
        lineSubtotal, lineTax, lineTotal: round(lineSubtotal + lineTax + serviceCharge * quantity)
      });
    }
    const subtotal = round(priced.reduce((sum, item) => sum + item.lineSubtotal, 0));
    const tax = round(priced.reduce((sum, item) => sum + item.lineTax, 0));
    const serviceFee = round(priced.reduce((sum, item) => sum + item.serviceCharge * item.quantity, 0));
    let couponDiscount = 0; let couponCode: string | undefined; let couponMessage: string | undefined;
    if (options.couponCode) {
      const result = await evaluateCoupon(options.couponCode, options.userId, subtotal, [...new Set(priced.map(item => item.productType))]);
      couponMessage = result.message;
      if (result.valid) { couponDiscount = result.discount; couponCode = result.coupon.code; }
    }
    const total = round(Math.max(0, subtotal - couponDiscount + tax + serviceFee));
    return { items: priced, subtotal, discount: couponDiscount, couponCode, couponDiscount, tax, serviceFee, total, currency: 'BDT', couponMessage };
  };

  /* ----------------------------------------------------------------- orders */
  const createOrder = async (input: Omit<Order, 'id' | 'orderNumber' | 'createdAt' | 'updatedAt' | 'timeline'> & { timeline?: OrderTimelineEntry[] }) => {
    const order = await OrderModel.create({
      ...input, id: randomUUID(), orderNumber: reference(input.kind === 'booking' ? 'SB' : 'SO'),
      timeline: input.timeline?.length ? input.timeline : [{ at: now(), status: 'created', note: 'Booking created' }],
      createdAt: now(), updatedAt: now()
    });
    return clean<Order>(order)!;
  };

  const listOrders = async (userId: string, filters: { status?: string; kind?: string; page?: number; pageSize?: number } = {}) => {
    const page = Math.max(1, Number(filters.page) || 1);
    const pageSize = Math.min(50, Math.max(1, Number(filters.pageSize) || 20));
    const query: Record<string, unknown> = { userId };
    if (filters.status && filters.status !== 'all') query.status = filters.status;
    if (filters.kind && filters.kind !== 'all') query.kind = filters.kind;
    const [docs, total] = await Promise.all([
      OrderModel.find(query).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
      OrderModel.countDocuments(query)
    ]);
    return { orders: cleanList<Order>(docs), total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
  };

  const listAllOrders = async (filters: { q?: string; status?: string; paymentStatus?: string; type?: string; page?: number; pageSize?: number } = {}) => {
    const page = Math.max(1, Number(filters.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(filters.pageSize) || 20));
    const query: Record<string, unknown> = {};
    if (filters.status && filters.status !== 'all') query.status = filters.status;
    if (filters.paymentStatus && filters.paymentStatus !== 'all') query.paymentStatus = filters.paymentStatus;
    if (filters.type && filters.type !== 'all') query.primaryType = filters.type;
    if (filters.q) {
      const rx = new RegExp(escapeRegex(filters.q), 'i');
      query.$or = [{ orderNumber: rx }, { contactEmail: rx }, { contactPhone: rx }, { 'customer.fullName': rx }];
    }
    const [docs, total] = await Promise.all([
      OrderModel.find(query).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
      OrderModel.countDocuments(query)
    ]);
    return { orders: cleanList<Order>(docs), total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
  };

  const findOrder = async (idOrNumber: string, userId?: string) => {
    const query: Record<string, unknown> = { $or: [{ id: idOrNumber }, { orderNumber: String(idOrNumber).toUpperCase() }] };
    if (userId) query.userId = userId;
    return clean<Order>(await OrderModel.findOne(query).lean());
  };

  const findOrderForTracking = async (orderNumber: string, identity: string) => {
    const value = String(identity || '').trim().toLowerCase();
    return clean<Order>(await OrderModel.findOne({
      orderNumber: String(orderNumber).trim().toUpperCase(),
      $or: [{ contactEmail: value }, { contactPhone: identity.trim() }, { contactPhone: value }]
    }).lean());
  };

  const updateOrder = async (id: string, patch: Partial<Order>, event?: OrderTimelineEntry) => {
    const update: Record<string, unknown> = { $set: { ...patch, updatedAt: now() } };
    if (event) update.$push = { timeline: event };
    return clean<Order>(await OrderModel.findOneAndUpdate({ id }, update, { new: true }).lean());
  };

  const orderStats = async () => {
    const [totals] = await OrderModel.aggregate([
      { $group: { _id: null, orders: { $sum: 1 }, revenue: { $sum: { $cond: [{ $eq: ['$paymentStatus', 'paid'] }, '$total', 0] } } } }
    ]);
    const byStatus = await OrderModel.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]);
    const byType = await OrderModel.aggregate([{ $group: { _id: '$primaryType', count: { $sum: 1 }, revenue: { $sum: '$total' } } }, { $sort: { count: -1 } }, { $limit: 10 }]);
    const trend = await OrderModel.aggregate([
      { $match: { paymentStatus: 'paid' } },
      { $group: { _id: { $substr: ['$createdAt', 0, 7] }, revenue: { $sum: '$total' }, orders: { $sum: 1 } } },
      { $sort: { _id: 1 } }, { $limit: 12 }
    ]);
    return {
      orders: totals?.orders || 0, revenue: round(totals?.revenue || 0),
      byStatus: byStatus.map(row => ({ status: row._id, count: row.count })),
      byType: byType.map(row => ({ type: row._id, count: row.count, revenue: round(row.revenue) })),
      trend: trend.map(row => ({ month: row._id, revenue: round(row.revenue), orders: row.orders }))
    };
  };

  /* --------------------------------------------------------------- invoices */
  const createInvoice = async (order: Order) => {
    const existing = clean<Invoice>(await InvoiceModel.findOne({ orderId: order.id }).lean());
    if (existing) return existing;
    const invoice = await InvoiceModel.create({
      id: randomUUID(), invoiceNumber: reference('INV'), orderId: order.id, orderNumber: order.orderNumber, userId: order.userId,
      customer: order.customer, items: order.items, subtotal: order.subtotal, discount: order.discount + order.couponDiscount,
      tax: order.tax, serviceFee: order.serviceFee, total: order.total, currency: order.currency,
      paymentMethod: order.paymentMethod, status: order.paymentStatus === 'paid' ? 'paid' : 'issued',
      issuedAt: now(), paidAt: order.paymentStatus === 'paid' ? now() : undefined, createdAt: now(), updatedAt: now()
    });
    const created = clean<Invoice>(invoice)!;
    await OrderModel.updateOne({ id: order.id }, { $set: { invoiceId: created.id, updatedAt: now() } });
    return created;
  };
  const findInvoice = async (id: string, userId?: string) => {
    const query: Record<string, unknown> = { $or: [{ id }, { invoiceNumber: String(id).toUpperCase() }, { orderId: id }] };
    if (userId) query.userId = userId;
    return clean<Invoice>(await InvoiceModel.findOne(query).lean());
  };
  const listInvoices = async (userId: string) => cleanList<Invoice>(await InvoiceModel.find({ userId }).sort({ createdAt: -1 }).limit(100).lean());
  const markInvoicePaid = async (orderId: string) =>
    clean<Invoice>(await InvoiceModel.findOneAndUpdate({ orderId }, { $set: { status: 'paid', paidAt: now(), updatedAt: now() } }, { new: true }).lean());

  /* -------------------------------------------------------- saved travelers */
  const listTravelers = async (userId: string) => cleanList<SavedTraveler>(await TravelerModel.find({ userId }).sort({ isPrimary: -1, createdAt: -1 }).lean());
  const createTraveler = async (input: Omit<SavedTraveler, 'id' | 'createdAt' | 'updatedAt'>) => {
    const count = await TravelerModel.countDocuments({ userId: input.userId });
    if (count >= 20) throw new AppError(409, 'TRAVELER_LIMIT', 'You can save up to 20 travellers');
    return clean<SavedTraveler>(await TravelerModel.create({ ...input, id: randomUUID(), createdAt: now(), updatedAt: now() }))!;
  };
  const updateTraveler = async (id: string, userId: string, patch: Partial<SavedTraveler>) =>
    clean<SavedTraveler>(await TravelerModel.findOneAndUpdate({ id, userId }, { $set: { ...patch, updatedAt: now() } }, { new: true }).lean());
  const deleteTraveler = async (id: string, userId: string) => (await TravelerModel.deleteOne({ id, userId })).deletedCount > 0;

  /* ---------------------------------------------------------------- reviews */
  const listReviews = async (filters: { productType?: string; productId?: string; status?: string; userId?: string; q?: string; page?: number; pageSize?: number } = {}) => {
    const page = Math.max(1, Number(filters.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(filters.pageSize) || 20));
    const query: Record<string, unknown> = {};
    if (filters.productType) query.productType = filters.productType;
    if (filters.productId) query.productId = filters.productId;
    if (filters.userId) query.userId = filters.userId;
    if (filters.status && filters.status !== 'all') query.status = filters.status;
    if (filters.q) query.body = new RegExp(escapeRegex(filters.q), 'i');
    const [docs, total] = await Promise.all([
      ReviewModel.find(query).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
      ReviewModel.countDocuments(query)
    ]);
    return { reviews: cleanList<Review>(docs), total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
  };
  const createReview = async (input: Omit<Review, 'id' | 'createdAt' | 'updatedAt' | 'status'> & { status?: Review['status'] }) =>
    clean<Review>(await ReviewModel.create({ ...input, status: input.status || 'pending', id: randomUUID(), createdAt: now(), updatedAt: now() }))!;
  const updateReview = async (id: string, patch: Partial<Review>) =>
    clean<Review>(await ReviewModel.findOneAndUpdate({ id }, { $set: { ...patch, updatedAt: now() } }, { new: true }).lean());
  const deleteReview = async (id: string) => (await ReviewModel.deleteOne({ id })).deletedCount > 0;
  /** Recompute the cached rating on a catalogue product from approved reviews. */
  const refreshProductRating = async (productType: string, productId: string) => {
    const [row] = await ReviewModel.aggregate([
      { $match: { productType, productId, status: 'approved' } },
      { $group: { _id: null, rating: { $avg: '$rating' }, count: { $sum: 1 } } }
    ]);
    await CatalogModel.updateOne({ id: productId }, { $set: { rating: row ? round(row.rating) : undefined, reviewCount: row?.count || 0, updatedAt: now() } });
  };

  /* ----------------------------------------------------- visa applications */
  const createVisaApplication = async (input: Omit<VisaApplication, 'id' | 'referenceNumber' | 'createdAt' | 'updatedAt' | 'timeline'>) =>
    clean<VisaApplication>(await VisaApplicationModel.create({
      ...input, id: randomUUID(), referenceNumber: reference('VA'),
      timeline: [{ at: now(), status: 'submitted', note: 'Application submitted' }], createdAt: now(), updatedAt: now()
    }))!;
  const listVisaApplications = async (filters: { userId?: string; status?: string; q?: string; page?: number; pageSize?: number } = {}) => {
    const page = Math.max(1, Number(filters.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(filters.pageSize) || 20));
    const query: Record<string, unknown> = {};
    if (filters.userId) query.userId = filters.userId;
    if (filters.status && filters.status !== 'all') query.status = filters.status;
    if (filters.q) query.referenceNumber = new RegExp(escapeRegex(filters.q), 'i');
    const [docs, total] = await Promise.all([
      VisaApplicationModel.find(query).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
      VisaApplicationModel.countDocuments(query)
    ]);
    return { applications: cleanList<VisaApplication>(docs), total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
  };
  const findVisaApplication = async (id: string, userId?: string) => {
    const query: Record<string, unknown> = { $or: [{ id }, { referenceNumber: String(id).toUpperCase() }] };
    if (userId) query.userId = userId;
    return clean<VisaApplication>(await VisaApplicationModel.findOne(query).lean());
  };
  const updateVisaApplication = async (id: string, patch: Partial<VisaApplication>, event?: OrderTimelineEntry) => {
    const update: Record<string, unknown> = { $set: { ...patch, updatedAt: now() } };
    if (event) update.$push = { timeline: event };
    return clean<VisaApplication>(await VisaApplicationModel.findOneAndUpdate({ id }, update, { new: true }).lean());
  };

  /* ---------------------------------------------------------------- search */
  const globalSearch = async (term: string, limit = 8) => {
    const rx = new RegExp(escapeRegex(term), 'i');
    const docs = await CatalogModel.find({
      status: 'published',
      $or: [{ title: rx }, { destination: rx }, { country: rx }, { city: rx }, { summary: rx }, { airline: rx }, { bank: rx }]
    }).limit(limit).lean();
    return cleanList<CatalogProduct>(docs);
  };

  return {
    ensureIndexes,
    listCatalog, findCatalogProduct, catalogFacets, createCatalogProduct, updateCatalogProduct, archiveCatalogProduct, deleteCatalogProduct, catalogStats,
    listWishlist, addWishlist, removeWishlist,
    getCart, saveCart, clearCart,
    listCoupons, findCoupon, createCoupon, updateCoupon, deleteCoupon, evaluateCoupon, redeemCoupon,
    priceCart, createOrder, listOrders, listAllOrders, findOrder, findOrderForTracking, updateOrder, orderStats,
    createInvoice, findInvoice, listInvoices, markInvoicePaid,
    listTravelers, createTraveler, updateTraveler, deleteTraveler,
    listReviews, createReview, updateReview, deleteReview, refreshProductRating,
    createVisaApplication, listVisaApplications, findVisaApplication, updateVisaApplication,
    globalSearch
  };
}
