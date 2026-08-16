import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';

const { Schema, model, models } = mongoose;
type Model<T = any> = mongoose.Model<T>;

export type Channel = 'sms' | 'email';
export type UserRole = 'customer' | 'manager' | 'admin';
export type UserStatus = 'active' | 'blocked' | 'pending';
export type PublishStatus = 'draft' | 'published' | 'archived';
export const CONTENT_TYPES = [
  'umrah-package', 'holiday-package', 'special-umrah-fare', 'campaign', 'travel-agent',
  'visa-service', 'esim', 'medical-tourism', 'card-offer', 'airline-offer', 'go-get-tour',
  'flight', 'hotel', 'home', 'explore', 'homepage', 'banner', 'promotional', 'contact',
  'setting', 'navigation'
] as const;
export type ContentType = typeof CONTENT_TYPES[number];

export type User = { id: string; phone?: string; email?: string; fullName?: string; status: UserStatus; role: UserRole; createdAt: string; updatedAt: string };
export type OtpChallenge = { id: string; identity: string; channel: Channel; purpose: 'login' | 'identity-change'; userId?: string; codeHash: string; attempts: number; maxAttempts: number; expiresAt: string; consumedAt?: string; requestIp?: string; createdAt: string };
export type Session = { id: string; userId: string; refreshJti: string; userAgent?: string; ip?: string; expiresAt: string; revokedAt?: string; createdAt: string };
export type Content = {
  id: string; type: ContentType; slug: string; title: string; excerpt: string; description: string;
  imageUrl: string; gallery: string[]; price?: number; currency: string; location: string; tags: string[];
  ctaLabel: string; ctaUrl: string; startDate?: string; endDate?: string; status: PublishStatus;
  featured: boolean; sortOrder: number; data: Record<string, unknown>; createdBy?: string; updatedBy?: string;
  createdAt: string; updatedAt: string;
};
export type ContentFilters = { type: ContentType; q?: string; status?: PublishStatus; featured?: boolean; page?: number; limit?: number };
export type ContentInput = Omit<Content, 'id' | 'createdAt' | 'updatedAt' | 'createdBy' | 'updatedBy'>;
export type ContentPatch = Partial<ContentInput>;
export type Booking = { id: string; userId: string; vertical: 'flight' | 'hotel' | 'home' | 'visa' | 'esim' | 'tour'; status: 'pending' | 'confirmed' | 'cancelled' | 'failed'; providerRef?: string; quotedAmount?: number; quotedCurrency?: string; request: unknown; response?: unknown; createdAt: string; updatedAt: string };
export type Payment = { id: string; bookingId: string; userId: string; provider: string; amount: number; currency: string; status: 'created' | 'pending' | 'paid' | 'failed' | 'refunded'; transactionRef?: string; providerPayload?: unknown; createdAt: string; updatedAt: string };
export type SupportTicket = { id: string; userId?: string; name: string; mobile: string; email: string; subject: string; message: string; status: 'open' | 'pending' | 'closed'; createdAt: string; updatedAt: string };
export type Notification = { id: string; userId: string; title: string; message: string; channels: ('in_app' | 'sms' | 'email')[]; readAt?: string; createdAt: string };
export type MessageTemplate = { id: string; name: string; subject: string; body: string; status: 'active' | 'archived'; createdBy?: string; createdAt: string; updatedAt: string };
export type Delivery = { id: string; templateId?: string; campaignId?: string; userId: string; channels: ('in_app' | 'sms' | 'email')[]; status: 'queued' | 'sent' | 'partial' | 'failed'; error?: string; createdAt: string; updatedAt: string };

export type ListResult<T> = { items: T[]; total: number; page: number; limit: number };
type CreateUser = { identity: string; channel: Channel; fullName?: string; role?: UserRole };
type CreateOtp = Omit<OtpChallenge, 'createdAt'>;
type CreateSession = Omit<Session, 'createdAt'>;
type CreateBooking = { userId: string; vertical: Booking['vertical']; request: unknown; status?: Booking['status'] };
type CreatePayment = { bookingId: string; userId: string; provider: string; amount: number; currency: string; status?: Payment['status'] };
type CreateTicket = Omit<SupportTicket, 'id' | 'createdAt' | 'updatedAt' | 'status'> & { status?: SupportTicket['status'] };
type CreateNotification = Omit<Notification, 'id' | 'createdAt'>;
type CreateTemplate = Omit<MessageTemplate, 'id' | 'createdAt' | 'updatedAt'>;
type CreateDelivery = Omit<Delivery, 'id' | 'createdAt' | 'updatedAt'>;

export interface Store {
  health(): Promise<boolean>;
  findUserByIdentity(identity: string): Promise<User | undefined>;
  findUserById(id: string): Promise<User | undefined>;
  createUser(input: CreateUser): Promise<User>;
  updateUser(id: string, patch: Partial<Pick<User, 'fullName' | 'phone' | 'email' | 'status' | 'role'>>): Promise<User | undefined>;
  setUserRole(id: string, role: UserRole): Promise<User | undefined>;
  listUsers(filters?: { q?: string; status?: UserStatus; page?: number; limit?: number }): Promise<ListResult<User>>;
  createOtp(input: CreateOtp): Promise<OtpChallenge>;
  findOtp(id: string): Promise<OtpChallenge | undefined>;
  incrementOtpAttempts(id: string): Promise<OtpChallenge | undefined>;
  consumeOtp(id: string): Promise<void>;
  countRecentOtpRequests(identity: string, since: Date): Promise<number>;
  createSession(input: CreateSession): Promise<Session>;
  findSessionById(id: string): Promise<Session | undefined>;
  findSessionByRefreshJti(jti: string): Promise<Session | undefined>;
  revokeSession(id: string): Promise<void>;
  createBooking(input: CreateBooking): Promise<Booking>;
  updateBooking(id: string, patch: Partial<Pick<Booking, 'status' | 'providerRef' | 'quotedAmount' | 'quotedCurrency' | 'response'>>): Promise<Booking | undefined>;
  findBooking(id: string, userId?: string): Promise<Booking | undefined>;
  listBookings(userId: string): Promise<Booking[]>;
  createPayment(input: CreatePayment): Promise<Payment>;
  updatePayment(id: string, patch: Partial<Pick<Payment, 'status' | 'transactionRef' | 'providerPayload'>>): Promise<Payment | undefined>;
  createSupportTicket(input: CreateTicket): Promise<SupportTicket>;
  createNotification(input: CreateNotification): Promise<Notification>;
  listNotifications(userId: string): Promise<Notification[]>;
  markNotificationRead(id: string, userId: string): Promise<Notification | undefined>;
  createContent(input: ContentInput, actorId?: string): Promise<Content>;
  updateContent(id: string, patch: ContentPatch, actorId?: string): Promise<Content | undefined>;
  deleteContent(id: string): Promise<boolean>;
  findContent(idOrSlug: string, type?: ContentType): Promise<Content | undefined>;
  listContent(filters: ContentFilters, publicOnly?: boolean): Promise<ListResult<Content>>;
  contentStats(): Promise<Record<string, number>>;
  createTemplate(input: CreateTemplate): Promise<MessageTemplate>;
  updateTemplate(id: string, patch: Partial<Omit<CreateTemplate, 'createdBy'>>): Promise<MessageTemplate | undefined>;
  listTemplates(status?: MessageTemplate['status']): Promise<MessageTemplate[]>;
  findTemplate(id: string): Promise<MessageTemplate | undefined>;
  createDelivery(input: CreateDelivery): Promise<Delivery>;
  updateDelivery(id: string, patch: Partial<Pick<Delivery, 'status' | 'error'>>): Promise<Delivery | undefined>;
  listDeliveries(limit?: number): Promise<Delivery[]>;
  audit(action: string, input: { userId?: string; ip?: string; userAgent?: string; metadata?: unknown }): Promise<void>;
}

const baseOptions = { timestamps: true, versionKey: false as const };
const userSchema = new Schema({ id: { type: String, unique: true, index: true }, phone: { type: String, unique: true, sparse: true, index: true }, email: { type: String, unique: true, sparse: true, lowercase: true, index: true }, fullName: { type: String, trim: true }, status: { type: String, enum: ['active', 'blocked', 'pending'], default: 'active', index: true }, role: { type: String, enum: ['customer', 'manager', 'admin'], default: 'customer', index: true } }, baseOptions);
const otpSchema = new Schema({ id: { type: String, unique: true, index: true }, identity: { type: String, index: true }, channel: { type: String, enum: ['sms', 'email'] }, purpose: { type: String, enum: ['login', 'identity-change'], default: 'login' }, userId: { type: String, index: true }, codeHash: String, attempts: { type: Number, default: 0 }, maxAttempts: { type: Number, default: 5 }, expiresAt: { type: Date, index: { expires: 0 } }, consumedAt: Date, requestIp: String }, { ...baseOptions, timestamps: { createdAt: true, updatedAt: false } });
const sessionSchema = new Schema({ id: { type: String, unique: true, index: true }, userId: { type: String, index: true }, refreshJti: { type: String, unique: true, index: true }, userAgent: String, ip: String, expiresAt: { type: Date, index: true }, revokedAt: Date }, baseOptions);
const bookingSchema = new Schema({ id: { type: String, unique: true, index: true }, userId: { type: String, index: true }, vertical: { type: String, enum: ['flight', 'hotel', 'home', 'visa', 'esim', 'tour'] }, status: { type: String, enum: ['pending', 'confirmed', 'cancelled', 'failed'], default: 'pending', index: true }, providerRef: String, quotedAmount: Number, quotedCurrency: String, request: Schema.Types.Mixed, response: Schema.Types.Mixed }, baseOptions);
const paymentSchema = new Schema({ id: { type: String, unique: true, index: true }, bookingId: { type: String, index: true }, userId: { type: String, index: true }, provider: String, amount: Number, currency: String, status: { type: String, enum: ['created', 'pending', 'paid', 'failed', 'refunded'], default: 'created', index: true }, transactionRef: String, providerPayload: Schema.Types.Mixed }, baseOptions);
const supportTicketSchema = new Schema({ id: { type: String, unique: true, index: true }, userId: String, name: String, mobile: String, email: String, subject: String, message: String, status: { type: String, enum: ['open', 'pending', 'closed'], default: 'open', index: true } }, baseOptions);
const notificationSchema = new Schema({ id: { type: String, unique: true, index: true }, userId: { type: String, index: true }, title: String, message: String, channels: { type: [String], enum: ['in_app', 'sms', 'email'], default: ['in_app'] }, readAt: Date }, { ...baseOptions, timestamps: { createdAt: true, updatedAt: false } });
const contentSchema = new Schema({ id: { type: String, unique: true, index: true }, type: { type: String, enum: CONTENT_TYPES, index: true }, slug: { type: String, required: true, trim: true }, title: { type: String, trim: true }, excerpt: String, description: String, imageUrl: String, gallery: { type: [String], default: [] }, price: Number, currency: { type: String, default: 'BDT' }, location: String, tags: { type: [String], default: [] }, ctaLabel: String, ctaUrl: String, startDate: Date, endDate: Date, status: { type: String, enum: ['draft', 'published', 'archived'], default: 'draft', index: true }, featured: { type: Boolean, default: false, index: true }, sortOrder: { type: Number, default: 0 }, data: { type: Schema.Types.Mixed, default: {} }, createdBy: String, updatedBy: String }, baseOptions);
contentSchema.index({ type: 1, slug: 1 }, { unique: true });
contentSchema.index({ type: 1, status: 1, sortOrder: 1, createdAt: -1 });
const templateSchema = new Schema({ id: { type: String, unique: true, index: true }, name: { type: String, trim: true, unique: true }, subject: String, body: String, status: { type: String, enum: ['active', 'archived'], default: 'active', index: true }, createdBy: String }, baseOptions);
const deliverySchema = new Schema({ id: { type: String, unique: true, index: true }, templateId: String, campaignId: String, userId: { type: String, index: true }, channels: { type: [String], default: [] }, status: { type: String, enum: ['queued', 'sent', 'partial', 'failed'], default: 'queued', index: true }, error: String }, baseOptions);
const auditSchema = new Schema({ userId: String, action: String, ip: String, userAgent: String, metadata: Schema.Types.Mixed }, { ...baseOptions, timestamps: { createdAt: true, updatedAt: false } });

export const UserModel = (models.SadikUser as Model) || model('SadikUser', userSchema);
export const OtpModel = (models.SadikOtp as Model) || model('SadikOtp', otpSchema);
export const SessionModel = (models.SadikSession as Model) || model('SadikSession', sessionSchema);
export const BookingModel = (models.SadikBooking as Model) || model('SadikBooking', bookingSchema);
export const PaymentModel = (models.SadikPayment as Model) || model('SadikPayment', paymentSchema);
export const SupportTicketModel = (models.SadikSupportTicket as Model) || model('SadikSupportTicket', supportTicketSchema);
export const NotificationModel = (models.SadikNotification as Model) || model('SadikNotification', notificationSchema);
export const ContentModel = (models.SadikContent as Model) || model('SadikContent', contentSchema);
export const TemplateModel = (models.SadikMessageTemplate as Model) || model('SadikMessageTemplate', templateSchema);
export const DeliveryModel = (models.SadikDelivery as Model) || model('SadikDelivery', deliverySchema);
export const AuditModel = (models.SadikAudit as Model) || model('SadikAudit', auditSchema);

const now = () => new Date().toISOString();
const toIso = (value: Date | string | undefined | null) => value ? new Date(value).toISOString() : undefined;
const pageOf = (value?: number) => Math.max(1, Math.floor(value || 1));
const limitOf = (value?: number) => Math.min(100, Math.max(1, Math.floor(value || 24)));
const rx = (value: string) => new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
const userFromDoc = (doc: any): User => ({ id: doc.id, phone: doc.phone || undefined, email: doc.email || undefined, fullName: doc.fullName || undefined, status: doc.status, role: doc.role, createdAt: new Date(doc.createdAt).toISOString(), updatedAt: new Date(doc.updatedAt).toISOString() });
const otpFromDoc = (doc: any): OtpChallenge => ({ id: doc.id, identity: doc.identity, channel: doc.channel, purpose: doc.purpose || 'login', userId: doc.userId || undefined, codeHash: doc.codeHash, attempts: doc.attempts, maxAttempts: doc.maxAttempts, expiresAt: new Date(doc.expiresAt).toISOString(), consumedAt: toIso(doc.consumedAt), requestIp: doc.requestIp || undefined, createdAt: new Date(doc.createdAt).toISOString() });
const sessionFromDoc = (doc: any): Session => ({ id: doc.id, userId: doc.userId, refreshJti: doc.refreshJti, userAgent: doc.userAgent || undefined, ip: doc.ip || undefined, expiresAt: new Date(doc.expiresAt).toISOString(), revokedAt: toIso(doc.revokedAt), createdAt: new Date(doc.createdAt).toISOString() });
const bookingFromDoc = (doc: any): Booking => ({ id: doc.id, userId: doc.userId, vertical: doc.vertical, status: doc.status, providerRef: doc.providerRef || undefined, quotedAmount: doc.quotedAmount ?? undefined, quotedCurrency: doc.quotedCurrency || undefined, request: doc.request, response: doc.response || undefined, createdAt: new Date(doc.createdAt).toISOString(), updatedAt: new Date(doc.updatedAt).toISOString() });
const paymentFromDoc = (doc: any): Payment => ({ id: doc.id, bookingId: doc.bookingId, userId: doc.userId, provider: doc.provider, amount: Number(doc.amount), currency: doc.currency, status: doc.status, transactionRef: doc.transactionRef || undefined, providerPayload: doc.providerPayload || undefined, createdAt: new Date(doc.createdAt).toISOString(), updatedAt: new Date(doc.updatedAt).toISOString() });
const ticketFromDoc = (doc: any): SupportTicket => ({ id: doc.id, userId: doc.userId || undefined, name: doc.name, mobile: doc.mobile, email: doc.email, subject: doc.subject, message: doc.message, status: doc.status, createdAt: new Date(doc.createdAt).toISOString(), updatedAt: new Date(doc.updatedAt).toISOString() });
const notificationFromDoc = (doc: any): Notification => ({ id: doc.id, userId: doc.userId, title: doc.title, message: doc.message, channels: doc.channels || [], readAt: toIso(doc.readAt), createdAt: new Date(doc.createdAt).toISOString() });
const contentFromDoc = (doc: any): Content => ({ id: doc.id, type: doc.type, slug: doc.slug, title: doc.title || '', excerpt: doc.excerpt || '', description: doc.description || '', imageUrl: doc.imageUrl || '', gallery: Array.isArray(doc.gallery) ? doc.gallery : [], price: doc.price ?? undefined, currency: doc.currency || 'BDT', location: doc.location || '', tags: Array.isArray(doc.tags) ? doc.tags : [], ctaLabel: doc.ctaLabel || '', ctaUrl: doc.ctaUrl || '', startDate: toIso(doc.startDate), endDate: toIso(doc.endDate), status: doc.status, featured: Boolean(doc.featured), sortOrder: Number(doc.sortOrder || 0), data: doc.data && typeof doc.data === 'object' ? doc.data : {}, createdBy: doc.createdBy || undefined, updatedBy: doc.updatedBy || undefined, createdAt: new Date(doc.createdAt).toISOString(), updatedAt: new Date(doc.updatedAt).toISOString() });
const templateFromDoc = (doc: any): MessageTemplate => ({ id: doc.id, name: doc.name, subject: doc.subject, body: doc.body, status: doc.status, createdBy: doc.createdBy || undefined, createdAt: new Date(doc.createdAt).toISOString(), updatedAt: new Date(doc.updatedAt).toISOString() });
const deliveryFromDoc = (doc: any): Delivery => ({ id: doc.id, templateId: doc.templateId || undefined, campaignId: doc.campaignId || undefined, userId: doc.userId, channels: doc.channels || [], status: doc.status, error: doc.error || undefined, createdAt: new Date(doc.createdAt).toISOString(), updatedAt: new Date(doc.updatedAt).toISOString() });

export class MemoryStore implements Store {
  private users = new Map<string, User>(); private otps = new Map<string, OtpChallenge>(); private sessions = new Map<string, Session>(); private bookings = new Map<string, Booking>(); private payments = new Map<string, Payment>(); private tickets = new Map<string, SupportTicket>(); private notifications = new Map<string, Notification>(); private content = new Map<string, Content>(); private templates = new Map<string, MessageTemplate>(); private deliveries = new Map<string, Delivery>();
  async health() { return true; }
  async findUserByIdentity(identity: string) { return [...this.users.values()].find(u => u.phone === identity || u.email === identity); }
  async findUserById(id: string) { return this.users.get(id); }
  async createUser(input: CreateUser) { const time = now(); const value: User = { id: randomUUID(), ...(input.channel === 'sms' ? { phone: input.identity } : { email: input.identity }), fullName: input.fullName, role: input.role || 'customer', status: 'active', createdAt: time, updatedAt: time }; this.users.set(value.id, value); return value; }
  async updateUser(id: string, patch: Partial<Pick<User, 'fullName' | 'phone' | 'email' | 'status' | 'role'>>) { const item = this.users.get(id); if (!item) return undefined; Object.assign(item, patch, { updatedAt: now() }); return item; }
  async setUserRole(id: string, role: UserRole) { return this.updateUser(id, { role }); }
  async listUsers(filters: { q?: string; status?: UserStatus; page?: number; limit?: number } = {}) { let items = [...this.users.values()]; if (filters.status) items = items.filter(x => x.status === filters.status); if (filters.q) { const q = filters.q.toLowerCase(); items = items.filter(x => `${x.fullName || ''} ${x.email || ''} ${x.phone || ''}`.toLowerCase().includes(q)); } const page = pageOf(filters.page), limit = limitOf(filters.limit); return { items: items.slice((page - 1) * limit, page * limit), total: items.length, page, limit }; }
  async createOtp(input: CreateOtp) { const item = { ...input, createdAt: now() }; this.otps.set(item.id, item); return item; }
  async findOtp(id: string) { return this.otps.get(id); }
  async incrementOtpAttempts(id: string) { const item = this.otps.get(id); if (item) item.attempts++; return item; }
  async consumeOtp(id: string) { const item = this.otps.get(id); if (item) item.consumedAt = now(); }
  async countRecentOtpRequests(identity: string, since: Date) { return [...this.otps.values()].filter(x => x.identity === identity && new Date(x.createdAt) >= since).length; }
  async createSession(input: CreateSession) { const item = { ...input, createdAt: now() }; this.sessions.set(item.id, item); return item; }
  async findSessionById(id: string) { return this.sessions.get(id); }
  async findSessionByRefreshJti(jti: string) { return [...this.sessions.values()].find(x => x.refreshJti === jti); }
  async revokeSession(id: string) { const item = this.sessions.get(id); if (item) item.revokedAt = now(); }
  async createBooking(input: CreateBooking) { const time = now(); const item: Booking = { id: randomUUID(), ...input, status: input.status || 'pending', createdAt: time, updatedAt: time }; this.bookings.set(item.id, item); return item; }
  async updateBooking(id: string, patch: Partial<Pick<Booking, 'status' | 'providerRef' | 'quotedAmount' | 'quotedCurrency' | 'response'>>) { const item = this.bookings.get(id); if (!item) return undefined; Object.assign(item, patch, { updatedAt: now() }); return item; }
  async findBooking(id: string, userId?: string) { const item = this.bookings.get(id); return item && (!userId || item.userId === userId) ? item : undefined; }
  async listBookings(userId: string) { return [...this.bookings.values()].filter(x => x.userId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  async createPayment(input: CreatePayment) { const time = now(); const item: Payment = { id: randomUUID(), ...input, status: input.status || 'created', createdAt: time, updatedAt: time }; this.payments.set(item.id, item); return item; }
  async updatePayment(id: string, patch: Partial<Pick<Payment, 'status' | 'transactionRef' | 'providerPayload'>>) { const item = this.payments.get(id); if (!item) return undefined; Object.assign(item, patch, { updatedAt: now() }); return item; }
  async createSupportTicket(input: CreateTicket) { const time = now(); const item: SupportTicket = { id: randomUUID(), ...input, status: input.status || 'open', createdAt: time, updatedAt: time }; this.tickets.set(item.id, item); return item; }
  async createNotification(input: CreateNotification) { const item: Notification = { id: randomUUID(), ...input, createdAt: now() }; this.notifications.set(item.id, item); return item; }
  async listNotifications(userId: string) { return [...this.notifications.values()].filter(x => x.userId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  async markNotificationRead(id: string, userId: string) { const item = this.notifications.get(id); if (!item || item.userId !== userId) return undefined; item.readAt = now(); return item; }
  async createContent(input: ContentInput, actorId?: string) { const time = now(); const item: Content = { id: randomUUID(), ...input, createdBy: actorId, updatedBy: actorId, createdAt: time, updatedAt: time }; this.content.set(item.id, item); return item; }
  async updateContent(id: string, patch: ContentPatch, actorId?: string) { const item = this.content.get(id); if (!item) return undefined; Object.assign(item, patch, { updatedBy: actorId, updatedAt: now() }); return item; }
  async deleteContent(id: string) { return this.content.delete(id); }
  async findContent(idOrSlug: string, type?: ContentType) { return [...this.content.values()].find(x => (x.id === idOrSlug || x.slug === idOrSlug) && (!type || x.type === type)); }
  async listContent(filters: ContentFilters, publicOnly = false) { let items = [...this.content.values()].filter(x => x.type === filters.type); if (publicOnly) { const today = new Date(); items = items.filter(x => x.status === 'published' && (!x.startDate || new Date(x.startDate) <= today) && (!x.endDate || new Date(x.endDate) >= today)); } else if (filters.status) items = items.filter(x => x.status === filters.status); if (filters.featured !== undefined) items = items.filter(x => x.featured === filters.featured); if (filters.q) { const q = filters.q.toLowerCase(); items = items.filter(x => `${x.title} ${x.excerpt} ${x.location} ${x.tags.join(' ')}`.toLowerCase().includes(q)); } items.sort((a, b) => a.sortOrder - b.sortOrder || b.createdAt.localeCompare(a.createdAt)); const page = pageOf(filters.page), limit = limitOf(filters.limit); return { items: items.slice((page - 1) * limit, page * limit), total: items.length, page, limit }; }
  async contentStats() { const stats: Record<string, number> = {}; for (const x of this.content.values()) stats[x.type] = (stats[x.type] || 0) + 1; return stats; }
  async createTemplate(input: CreateTemplate) { const time = now(); const item: MessageTemplate = { id: randomUUID(), ...input, createdAt: time, updatedAt: time }; this.templates.set(item.id, item); return item; }
  async updateTemplate(id: string, patch: Partial<Omit<CreateTemplate, 'createdBy'>>) { const item = this.templates.get(id); if (!item) return undefined; Object.assign(item, patch, { updatedAt: now() }); return item; }
  async listTemplates(status?: MessageTemplate['status']) { return [...this.templates.values()].filter(x => !status || x.status === status).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  async findTemplate(id: string) { return this.templates.get(id); }
  async createDelivery(input: CreateDelivery) { const time = now(); const item: Delivery = { id: randomUUID(), ...input, createdAt: time, updatedAt: time }; this.deliveries.set(item.id, item); return item; }
  async updateDelivery(id: string, patch: Partial<Pick<Delivery, 'status' | 'error'>>) { const item = this.deliveries.get(id); if (!item) return undefined; Object.assign(item, patch, { updatedAt: now() }); return item; }
  async listDeliveries(limit = 100) { return [...this.deliveries.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit); }
  async audit() { return; }
}

export class MongoStore implements Store {
  async health() { if (mongoose.connection.readyState !== 1) return false; await mongoose.connection.db?.admin().ping(); return true; }
  async findUserByIdentity(identity: string) { const doc = await UserModel.findOne({ $or: [{ phone: identity }, { email: identity }] }).lean(); return doc ? userFromDoc(doc) : undefined; }
  async findUserById(id: string) { const doc = await UserModel.findOne({ id }).lean(); return doc ? userFromDoc(doc) : undefined; }
  async createUser(input: CreateUser) { const doc = await UserModel.create({ id: randomUUID(), ...(input.channel === 'sms' ? { phone: input.identity } : { email: input.identity }), fullName: input.fullName, role: input.role || 'customer' }); return userFromDoc(doc); }
  async updateUser(id: string, patch: Partial<Pick<User, 'fullName' | 'phone' | 'email' | 'status' | 'role'>>) { const doc = await UserModel.findOneAndUpdate({ id }, { $set: patch }, { new: true, runValidators: true }).lean(); return doc ? userFromDoc(doc) : undefined; }
  async setUserRole(id: string, role: UserRole) { return this.updateUser(id, { role }); }
  async listUsers(filters: { q?: string; status?: UserStatus; page?: number; limit?: number } = {}) { const query: any = {}; if (filters.status) query.status = filters.status; if (filters.q) query.$or = [{ fullName: rx(filters.q) }, { phone: rx(filters.q) }, { email: rx(filters.q) }]; const page = pageOf(filters.page), limit = limitOf(filters.limit); const [docs, total] = await Promise.all([UserModel.find(query).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), UserModel.countDocuments(query)]); return { items: docs.map(userFromDoc), total, page, limit }; }
  async createOtp(input: CreateOtp) { const doc = await OtpModel.create({ ...input, expiresAt: new Date(input.expiresAt) }); return otpFromDoc(doc); }
  async findOtp(id: string) { const doc = await OtpModel.findOne({ id }).lean(); return doc ? otpFromDoc(doc) : undefined; }
  async incrementOtpAttempts(id: string) { const doc = await OtpModel.findOneAndUpdate({ id }, { $inc: { attempts: 1 } }, { new: true }).lean(); return doc ? otpFromDoc(doc) : undefined; }
  async consumeOtp(id: string) { await OtpModel.updateOne({ id }, { $set: { consumedAt: new Date() } }); }
  async countRecentOtpRequests(identity: string, since: Date) { return OtpModel.countDocuments({ identity, createdAt: { $gte: since } }); }
  async createSession(input: CreateSession) { const doc = await SessionModel.create({ ...input, expiresAt: new Date(input.expiresAt) }); return sessionFromDoc(doc); }
  async findSessionById(id: string) { const doc = await SessionModel.findOne({ id }).lean(); return doc ? sessionFromDoc(doc) : undefined; }
  async findSessionByRefreshJti(jti: string) { const doc = await SessionModel.findOne({ refreshJti: jti }).lean(); return doc ? sessionFromDoc(doc) : undefined; }
  async revokeSession(id: string) { await SessionModel.updateOne({ id }, { $set: { revokedAt: new Date() } }); }
  async createBooking(input: CreateBooking) { const doc = await BookingModel.create({ id: randomUUID(), ...input }); return bookingFromDoc(doc); }
  async updateBooking(id: string, patch: Partial<Pick<Booking, 'status' | 'providerRef' | 'quotedAmount' | 'quotedCurrency' | 'response'>>) { const doc = await BookingModel.findOneAndUpdate({ id }, { $set: patch }, { new: true }).lean(); return doc ? bookingFromDoc(doc) : undefined; }
  async findBooking(id: string, userId?: string) { const query: any = { id }; if (userId) query.userId = userId; const doc = await BookingModel.findOne(query).lean(); return doc ? bookingFromDoc(doc) : undefined; }
  async listBookings(userId: string) { return (await BookingModel.find({ userId }).sort({ createdAt: -1 }).lean()).map(bookingFromDoc); }
  async createPayment(input: CreatePayment) { const doc = await PaymentModel.create({ id: randomUUID(), ...input }); return paymentFromDoc(doc); }
  async updatePayment(id: string, patch: Partial<Pick<Payment, 'status' | 'transactionRef' | 'providerPayload'>>) { const doc = await PaymentModel.findOneAndUpdate({ id }, { $set: patch }, { new: true }).lean(); return doc ? paymentFromDoc(doc) : undefined; }
  async createSupportTicket(input: CreateTicket) { const doc = await SupportTicketModel.create({ id: randomUUID(), ...input }); return ticketFromDoc(doc); }
  async createNotification(input: CreateNotification) { const doc = await NotificationModel.create({ id: randomUUID(), ...input }); return notificationFromDoc(doc); }
  async listNotifications(userId: string) { return (await NotificationModel.find({ userId }).sort({ createdAt: -1 }).limit(100).lean()).map(notificationFromDoc); }
  async markNotificationRead(id: string, userId: string) { const doc = await NotificationModel.findOneAndUpdate({ id, userId }, { $set: { readAt: new Date() } }, { new: true }).lean(); return doc ? notificationFromDoc(doc) : undefined; }
  async createContent(input: ContentInput, actorId?: string) { const doc = await ContentModel.create({ id: randomUUID(), ...input, createdBy: actorId, updatedBy: actorId }); return contentFromDoc(doc); }
  async updateContent(id: string, patch: ContentPatch, actorId?: string) { const doc = await ContentModel.findOneAndUpdate({ id }, { $set: { ...patch, updatedBy: actorId } }, { new: true, runValidators: true }).lean(); return doc ? contentFromDoc(doc) : undefined; }
  async deleteContent(id: string) { return (await ContentModel.deleteOne({ id })).deletedCount === 1; }
  async findContent(idOrSlug: string, type?: ContentType) { const query: any = { $or: [{ id: idOrSlug }, { slug: idOrSlug }] }; if (type) query.type = type; const doc = await ContentModel.findOne(query).lean(); return doc ? contentFromDoc(doc) : undefined; }
  async listContent(filters: ContentFilters, publicOnly = false) { const query: any = { type: filters.type }; if (publicOnly) { const nowDate = new Date(); query.status = 'published'; query.$and = [{ $or: [{ startDate: null }, { startDate: { $exists: false } }, { startDate: { $lte: nowDate } }] }, { $or: [{ endDate: null }, { endDate: { $exists: false } }, { endDate: { $gte: nowDate } }] }]; } else if (filters.status) query.status = filters.status; if (filters.featured !== undefined) query.featured = filters.featured; if (filters.q) query.$or = [{ title: rx(filters.q) }, { excerpt: rx(filters.q) }, { description: rx(filters.q) }, { location: rx(filters.q) }, { tags: rx(filters.q) }]; const page = pageOf(filters.page), limit = limitOf(filters.limit); const [docs, total] = await Promise.all([ContentModel.find(query).sort({ sortOrder: 1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), ContentModel.countDocuments(query)]); return { items: docs.map(contentFromDoc), total, page, limit }; }
  async contentStats() { const rows = await ContentModel.aggregate([{ $group: { _id: '$type', count: { $sum: 1 } } }]); return Object.fromEntries(rows.map((row: any) => [row._id, row.count])); }
  async createTemplate(input: CreateTemplate) { const doc = await TemplateModel.create({ id: randomUUID(), ...input }); return templateFromDoc(doc); }
  async updateTemplate(id: string, patch: Partial<Omit<CreateTemplate, 'createdBy'>>) { const doc = await TemplateModel.findOneAndUpdate({ id }, { $set: patch }, { new: true, runValidators: true }).lean(); return doc ? templateFromDoc(doc) : undefined; }
  async listTemplates(status?: MessageTemplate['status']) { return (await TemplateModel.find(status ? { status } : {}).sort({ updatedAt: -1 }).lean()).map(templateFromDoc); }
  async findTemplate(id: string) { const doc = await TemplateModel.findOne({ id }).lean(); return doc ? templateFromDoc(doc) : undefined; }
  async createDelivery(input: CreateDelivery) { const doc = await DeliveryModel.create({ id: randomUUID(), ...input }); return deliveryFromDoc(doc); }
  async updateDelivery(id: string, patch: Partial<Pick<Delivery, 'status' | 'error'>>) { const doc = await DeliveryModel.findOneAndUpdate({ id }, { $set: patch }, { new: true }).lean(); return doc ? deliveryFromDoc(doc) : undefined; }
  async listDeliveries(limit = 100) { return (await DeliveryModel.find({}).sort({ createdAt: -1 }).limit(Math.min(100, limit)).lean()).map(deliveryFromDoc); }
  async audit(action: string, input: { userId?: string; ip?: string; userAgent?: string; metadata?: unknown }) { await AuditModel.create({ action, ...input }); }
}

export function connectMongo() { mongoose.set('strictQuery', true); return mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 5_000, maxPoolSize: 20, minPoolSize: config.isProduction ? 2 : 0, autoIndex: !config.isProduction }); }
export function createStore(): { store: Store; connection?: Promise<typeof mongoose> } { return config.dataMode === 'mongodb' ? { store: new MongoStore(), connection: connectMongo() } : { store: new MemoryStore() }; }
