/**
 * Sandbox / local DEMO server for the live chat system.
 *
 * The production app (`src/index.ts`) runs the full Express application backed
 * by MongoDB and (optionally) Firebase Realtime Database. This demo exists for
 * environments without MongoDB/Firebase (e.g. CI sandboxes): it wires the REAL
 * chat service, routes and Socket.IO hub from src/chat/* to an in-memory
 * store, and serves the real storefront + admin console front-ends so the
 * two-browser acceptance test can be run end to end.
 *
 * Run with: npm run demo   (NOT used in production deployments)
 */
import { createServer } from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';
import { config } from './config.js';
import { ChatRealtimeHub } from './chat/realtime.js';
import { ChatService } from './chat/service.js';
import { registerChatRoutes } from './chat/routes.js';
import { MemoryChatStore } from './chat/testing.js';
import type { ChatDirectory, ChatHotel } from './chat/directory.js';
import { chatUidForUser } from './chat/keys.js';
import { ACCESS_COOKIE, issueSession, setAuthCookies, verifyToken } from './security.js';
import type { User } from './store.js';
import { randomUUID } from 'node:crypto';

const BRAND = 'Sadik Travels';

const users: User[] = [
  { id: randomUUID(), email: 'owner.a@demo.test', fullName: 'Hotel Owner A', role: 'hotel_owner', status: 'active', permissions: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
  { id: randomUUID(), email: 'owner.b@demo.test', fullName: 'Hotel Owner B', role: 'hotel_owner', status: 'active', permissions: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
  { id: randomUUID(), email: 'super@demo.test', fullName: 'Super Admin', role: 'super_admin', status: 'active', permissions: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
  { id: randomUUID(), email: 'customer@demo.test', fullName: 'Rahim Customer', role: 'customer', status: 'active', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
];

const hotels: ChatHotel[] = [
  { id: randomUUID(), name: 'Hotel The Cox Today', ownerId: users[0].id, city: 'Cox\'s Bazar', propertyType: 'Hotel', status: 'active', available: true, images: [{ url: '/assets/sadik-travels-logo.png' }] },
  { id: randomUUID(), name: 'Seagull Beach Resort', ownerId: users[1].id, city: 'Cox\'s Bazar', propertyType: 'Resort', status: 'active', available: true, images: [{ url: '/assets/sadik-travels-logo.png' }] }
];

const directory: ChatDirectory = {
  async findUserById(id) { return users.find(user => user.id === id); },
  async listSupportStaffIds() { return users.filter(user => user.role === 'super_admin').map(user => user.id); },
  async findHotel(hotelId) { return hotels.find(hotel => hotel.id === hotelId); },
  async listOwnedHotelIds(ownerId) { return hotels.filter(hotel => hotel.ownerId === ownerId).map(hotel => hotel.id); },
  async audit() { /* demo: no audit trail */ }
};

async function main() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  const chatStore = new MemoryChatStore();
  const chatService = new ChatService({ store: chatStore, directory, brandName: BRAND });
  const chatHub = new ChatRealtimeHub(chatService);

  const demoAuth: express.RequestHandler = (req, _res, next) => {
    const token = req.cookies?.[ACCESS_COOKIE];
    if (token) {
      verifyToken(token, 'access').then(async claims => {
        const user = users.find(candidate => candidate.id === claims.sub);
        if (user) (req as any).user = user;
        next();
      }).catch(() => next());
    } else next();
  };

  registerChatRoutes(app, { service: chatService, hub: chatHub, auth: { optional: demoAuth } });

  /* ---- minimal demo storefront/admin endpoints ---- */
  app.get('/api/v1/site/settings', (_req, res) => res.json({ brand: BRAND, logoUrl: '/assets/sadik-travels-logo.png?v=3', support: { email: 'support@demo.test', phone: '+8801700000000' }, features: {}, serviceStatuses: {} }));
  app.get('/api/v1/site/firebase-config', (_req, res) => res.json({ configured: false, firebase: null }));
  app.get('/api/v1/site/content', (_req, res) => res.json({ content: [] }));
  app.get('/api/v1/site/agents', (_req, res) => res.json({ agents: [] }));
  const hotelSlug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  app.get('/api/v1/hotels', (_req, res) => res.json({ success: true, hotels: hotels.map(hotel => ({ ...hotel, slug: hotelSlug(hotel.name), shortDescription: `Demo property in ${hotel.city}.`, images: hotel.images, priceFrom: 3500, starRating: 4, guestRating: 4.5, amenities: ['AC', 'Free WiFi'] })) }));
  app.get('/api/v1/hotels/destinations', (_req, res) => res.json({ destinations: [{ city: "Cox's Bazar", count: hotels.length }] }));
  app.get('/api/v1/hotels/:slug', (req, res) => {
    const hotel = hotels.find(candidate => candidate.id === req.params.slug || candidate.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') === String(req.params.slug).toLowerCase());
    if (!hotel) return res.status(404).json({ error: { code: 'HOTEL_NOT_FOUND', message: 'Hotel not found' } });
    const slug = hotelSlug(hotel.name);
    res.json({ success: true, hotel: { ...hotel, slug, starRating: 4, guestRating: 4.5, reviewCount: 12, images: (hotel.images || []).map(url => ({ url: typeof url === 'string' ? url : url.url, alt: hotel.name })), rooms: [{ id: 'deluxe', name: 'Deluxe Double Room', size: 320, bedType: '1 double bed', maxGuests: 2, numBeds: 1, pricePerNight: 3500, originalPrice: 4200, available: 5, amenities: ['AC', 'Free WiFi', 'Breakfast'], images: [] }, { id: 'premium', name: 'Premium Sea View', size: 420, bedType: '1 king bed', maxGuests: 3, numBeds: 1, pricePerNight: 5500, available: 3, amenities: ['AC', 'Balcony', 'Sea view'], images: [] }] } });
  });

  const publicUser = (user: User) => ({ id: user.id, email: user.email, phone: user.phone, fullName: user.fullName, role: user.role, status: user.status, avatarUrl: user.avatarUrl });
  const fineFor = (user: User) => (user.role === 'super_admin' ? ['support.view', 'support.reply', 'dashboard.view', 'hotel.view'] : user.role === 'hotel_owner' ? ['dashboard.view', 'hotel.view', 'hotel.update', 'room.view', 'booking.view'] : user.role === 'customer' ? [] : []);

  app.post('/api/v1/auth/password-login', async (req, res) => {
    const identity = String(req.body?.identity || '').toLowerCase();
    const user = users.find(candidate => (candidate.email || '').toLowerCase() === identity || identity === 'owner.a' && candidate.email === 'owner.a@demo.test' || identity === 'owner.b' && candidate.email === 'owner.b@demo.test' || identity === 'super' && candidate.email === 'super@demo.test');
    if (!user) return res.status(401).json({ error: { code: 'AUTH_INVALID', message: 'Unknown demo account. Try owner.a@demo.test / owner.b@demo.test / super@demo.test' } });
    const { accessToken, refreshToken } = await issueSession({ createSession: async (session: any) => session } as any, user, {});
    setAuthCookies(res, accessToken, refreshToken);
    res.json({ user: publicUser(user), permissions: [], finePermissions: fineFor(user), isSuperAdmin: user.role === 'super_admin' });
  });

  app.post('/api/v1/auth/request-otp', (req, res) => res.json({ challengeId: 'demo-challenge', devCode: '123456', expiresAt: new Date(Date.now() + 300000).toISOString() }));
  app.post('/api/v1/auth/verify-otp', async (req, res) => {
    if (String(req.body?.code || '') !== '123456') return res.status(401).json({ error: { code: 'OTP_INVALID', message: 'Demo OTP is 123456' } });
    const customer = users.find(user => user.role === 'customer')!;
    const { accessToken, refreshToken } = await issueSession({ createSession: async (session: any) => session } as any, customer, {});
    setAuthCookies(res, accessToken, refreshToken);
    res.json({ user: publicUser(customer), isNew: false });
  });
  app.post('/api/v1/auth/refresh', (_req, res) => res.status(401).json({ error: { code: 'SESSION_INVALID', message: 'Login again' } }));
  app.get('/api/v1/auth/me', demoAuth, (req, res) => { const user = (req as any).user; res.json({ user: user ? publicUser(user) : null }); });

  app.get('/api/v1/admin/me', demoAuth, (req, res) => {
    const user = (req as any).user as User | undefined;
    if (!user || user.role === 'customer') return res.status(401).json({ error: { code: 'AUTH_REQUIRED', message: 'Admin login is required' } });
    res.json({ user: publicUser(user), permissions: [], finePermissions: fineFor(user), isSuperAdmin: user.role === 'super_admin' });
  });
  app.get('/api/v1/admin/navigation', demoAuth, (req, res) => {
    const user = (req as any).user as User | undefined;
    if (!user) return res.status(401).json({ error: { code: 'AUTH_REQUIRED', message: 'Admin login is required' } });
    const items = [
      { id: 'nav-dash', label: 'Dashboard', route: '/admin', icon: 'grid', group: 'Overview', sortOrder: 0, permission: 'dashboard:view', visible: true, enabled: true },
      { id: 'nav-hotels', label: 'Hotels', route: '/admin/hotels', icon: 'hotel', group: 'Inventory', sortOrder: 1, permission: 'hotel:view', visible: true, enabled: true },
      { id: 'nav-chat', label: 'Live Chat', route: '/admin/live-support', icon: 'message', group: 'Customer care', sortOrder: 2, permission: 'support:manage', visible: true, enabled: true }
    ];
    res.json({ navigation: items });
  });
  app.get('/api/v1/admin/stats', demoAuth, (_req, res) => res.json({ totalBookings: 0, pendingBookings: 0, revenue: 0, hotels: hotels.length, recentBookings: [] }));
  app.get('/api/v1/admin/hotels', demoAuth, (req, res) => {
    const user = (req as any).user as User;
    const scoped = user.role === 'hotel_owner' ? hotels.filter(hotel => hotel.ownerId === user.id) : hotels;
    res.json({ hotels: scoped.map(hotel => ({ ...hotel, slug: hotel.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), roomCount: 2, priceFrom: 3500, images: hotel.images, status: 'active' })), total: scoped.length, page: 1, pageSize: 50, pageCount: 1 });
  });
  app.get('/api/v1/notifications', demoAuth, (_req, res) => res.json({ unread: 0, notifications: [] }));

  /* ---- static front-ends ---- */
  app.use(express.static(process.cwd(), { extensions: ['html'] }));
  app.get(['/admin', /^\/admin(?:\/.*)?$/], (_req, res) => res.sendFile(`${process.cwd()}/admin.html`));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/') || req.path.startsWith('/socket.io')) return next();
    res.sendFile(`${process.cwd()}/index.html`);
  });

  const server = createServer(app);
  chatHub.attach(server);
  server.listen(config.port, '0.0.0.0', () => {
    console.log(`Sadik Travels DEMO (in-memory) listening on http://0.0.0.0:${config.port}`);
    console.log('Storefront:      /            (hotel pages: /hotels)');
    console.log('Admin console:   /admin       (login owner.a@demo.test | owner.b@demo.test | super@demo.test, any password)');
    console.log('Customer login:  OTP flow with code 123456');
    console.log(`Hotels: ${hotels.map(hotel => `${hotel.name} (${hotel.id})`).join(' | ')}`);
  });

  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

void main();
