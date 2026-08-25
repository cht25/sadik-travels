# Sadik Travels

Sadik Travels is a single-service Node.js travel platform with an Amy-style customer experience, Sadik Travels branding, a secure operations console, MongoDB persistence, Cloudinary media, and a Render deployment blueprint.

The repository contains no seeded tours, customer records, bookings, offers, admin accounts, or provider responses. Create business content through `/admin` after deployment.

## Stack

- Node.js 20, Express 5, TypeScript
- **MongoDB** via Mongoose — the only runtime database
- Cloudinary for permanent image storage
- JWT sessions in HttpOnly cookies
- OTP and Firebase Google sign-in for customers; password authentication for admin and vendor accounts
- Render web service deployment
- Vanilla responsive public site and routed admin application

## What the application manages

### Public website

Hotels, homes and villas, tours, holiday packages, destination discovery, verified travel-agent profiles, cart and checkout, booking tracking, secure payments, customer accounts, notifications, support tickets, and real-time live support chat.

### Admin console

- Permission-filtered dashboard, bookings, customers, payments and catalogue operations
- Super Admin account management with deny-by-default vendor roles (`HOTEL_OWNER`, `HOME_OWNER`, `TRAVEL_AGENT`)
- Owner-scoped hotel CRUD, room inventory, current pricing, seasonal discounts, availability and Cloudinary galleries
- Dual-pane Live Support Inbox with Socket.IO updates, unread badges, sound alerts and Firebase Realtime Database transcripts (MongoDB fallback)
- Support tickets, tours, homes, holiday packages, destinations, travel agents and website content
- Cloudinary media library and encrypted integration settings
- A production-only sidebar generated from each account’s assigned permissions

## Application shell and routing

The website renders inside one application shell:

```
<div class="app-shell">
  <aside class="travel-sidebar">…</aside>
  <div class="app-main">
    <header class="site-header">…</header>
    <div class="page-content">…page…</div>
    <footer class="site-footer">…</footer>
  </div>
</div>
```

The header is sticky inside the content column and the sidebar is a real
grid/flex column on desktop, so page content is never covered by either.
Below 1024px the sidebar becomes an overlay drawer (hamburger, backdrop,
Escape and click-outside close). No page applies its own header or sidebar
offset — layout lives only in the shell rules at the end of `styles.css`.

Every production storefront route works on refresh and direct access:
`/hotels`, `/homes-villas`, `/tours`, `/holiday-packages`, `/explore`,
`/travel-agents`, `/cart`, `/wishlist`, `/checkout`, `/orders`,
`/invoice/:id`, `/account`, `/payments`, `/track-booking` and `/support`.
Admin deep links render the same console shell, then a frontend route guard and
backend middleware independently enforce the account’s assigned permission.

## Commerce engine

`src/commerce-store.ts` and `src/commerce-routes.ts` add the catalogue and
e-commerce layer on top of the existing booking APIs:

| Collection | Purpose |
| --- | --- |
| `catalog_products` | Holiday packages, homes and villas, and destinations |
| `carts`, `wishlist_items` | Persistent per-customer cart and wishlist |
| `coupons`, `coupon_redemptions` | Server-validated discount rules and per-user limits |
| `orders`, `invoices` | Unified order/booking engine with timeline and receipts |
| `saved_travelers` | Reusable traveller profiles for auto-filled checkout |
| `reviews` | Purchase-verified reviews with admin moderation |

Prices, taxes, service fees, coupons and totals are always recalculated on
the server from persisted records; browser values are never trusted. Every
admin endpoint is guarded by a fine-grained permission
(`catalog.create`, `order.refund`, `coupon.delete`, `review.moderate`, …) and writes an audit entry. Super Admin bypasses
restrictions; an admin can never grant itself permissions.

## Local development

```bash
cp .env.example .env
# Set MONGODB_URI to a MongoDB Atlas development database or local MongoDB.
npm ci
npm run dev
```

Open:

```text
http://localhost:8787
http://localhost:8787/admin
```

For local OTP testing only:

```dotenv
DEV_OTP_ECHO=true
```

For the first administrator, configure `SUPER_ADMIN_EMAIL` and `SUPER_ADMIN_PASSWORD` only through `.env` or the Render secret manager. The password is hashed using `scrypt` and never stored in source. At startup the configured identity is treated as the authoritative super admin: the account is created (or promoted) and its password hash is rebuilt to match the configured secret, which also repairs accounts whose password was previously inserted in the wrong format/collection. Remove the bootstrap credentials after the first successful sign-in.

### Google sign-in (Firebase)

The admin console sign-in is powered by Firebase Authentication ("Continue with Google"). Google handles the password; the browser receives a Firebase ID token, the server verifies it with the Firebase Admin SDK, then maps the Google email to a local admin account and issues the same session cookies as any other login.

Enable it with these environment variables (see `.env.example`):

- `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` — the service-account credentials used to verify ID tokens (server-side, never exposed).
- `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_APP_ID` (optional), `FIREBASE_MEASUREMENT_ID` (optional) — the public web config exposed to the browser.

In the Firebase console, enable the **Google** provider under Authentication → Sign-in method, and add your deployment origin (`http://localhost:8787` locally, or your Render URL) to Authentication → Settings → Authorized domains.

Authorization rules for the Google account that signs in:

- If the Google email matches `SUPER_ADMIN_EMAIL`, the account is granted `super_admin`.
- Otherwise, if the email is listed in `ADMIN_IDENTITIES` (comma-separated), the account is granted `admin`.
- An existing admin account with a matching email is signed in regardless of the whitelist.

### Live chat (Firebase Realtime Database)

Live chat conversations and transcripts are stored in **Firebase Realtime Database** when the Firebase service account is configured. The server writes through the Firebase Admin SDK and subscribes to the chat nodes (`live-chat/sessions`, `live-chat/messages`), relaying every change to the Socket.IO rooms — so Realtime Database is the real-time event source and updates made from any server instance (or the Firebase console) reach connected visitors and admins immediately. Visitors still authenticate with the existing per-session chat token; the browser never talks to the Realtime Database directly.

- Set `FIREBASE_DATABASE_URL` to your database's web API URL, or leave it blank to use the project default (`https://<FIREBASE_PROJECT_ID>-default-rtdb.firebaseio.com`).
- Enable Realtime Database in the Firebase console (the default instance is created automatically for new projects).
- Lock the security rules so no browser/client can read or write the chat data directly — the Admin SDK bypasses rules, which is all the app needs: `{ "rules": { ".read": false, ".write": false } }`.
- Without Firebase credentials the app falls back to the MongoDB `support_tickets`/`support_messages` collections automatically, so local development works without any Firebase setup.

## MongoDB

Set a managed MongoDB connection string:

```dotenv
MONGODB_URI=mongodb+srv://USER:PASSWORD@cluster.example.mongodb.net/sadik_travels?retryWrites=true&w=majority
```

Application entities—including users, sessions, hotels, rooms, inventory, tours, bookings, payments, catalogue content, media, travel agents, support/live-chat sessions, transcripts, settings and navigation—are persisted in dedicated Mongoose collections. Schemas enforce field types, stable IDs, lifecycle status, ownership and query indexes.

The server refuses to start without `MONGODB_URI`; production also rejects localhost MongoDB URLs.

### Legacy data cleanup

The runtime contains no SQLite importer or legacy flight, visa, eSIM, campaign,
Umrah, or medical-tourism modules. After a verified MongoDB backup, operators
can run `CONFIRM_LEGACY_CLEANUP=yes npm run cleanup:legacy` to remove orphaned
legacy collections and navigation.

## Cloudinary

Cloudinary is the permanent image store. Configure:

```dotenv
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=
```

The admin media library validates JPEG, PNG, and WebP magic bytes, performs bounded memory uploads, stores only Cloudinary metadata in MongoDB, prevents deletion of referenced assets, and never uses Render's temporary filesystem for permanent images.

## Payment safety

Payment amounts are never accepted from the browser. Go Get Tour payments derive the amount from the persisted package price and traveller count once an operator accepts the booking. Supplier bookings require a verified provider quote returned from the reservation adapter. A booking without a trusted quote cannot initiate payment.

## Render deployment

Use `render.yaml` as a starting point. Configure these values in Render's secret/environment dashboard:

- `MONGODB_URI` — managed MongoDB/Atlas URI
- `APP_ORIGIN`, `CORS_ORIGINS`, `JWT_SECRET`, `SETTINGS_MASTER_KEY`
- Cloudinary credentials
- SMS/SMTP credentials
- Travel provider and payment gateway credentials
- `SUPER_ADMIN_EMAIL` and `SUPER_ADMIN_PASSWORD` for the super-admin bootstrap (also repairs a broken/missing password hash at startup)
- `FIREBASE_*` credentials for Google admin sign-in
- `FIREBASE_DATABASE_URL` (optional) — live chat Realtime Database URL; the project default is used when blank

The Render service is stateless: MongoDB stores application data, and Cloudinary stores images. No Render disk is required.

Required production settings include `NODE_ENV=production`, `TRUST_PROXY=true`, `COOKIE_SECURE=true`, `DEV_OTP_ECHO=false`, explicit HTTPS origins, and a managed MongoDB URI.

## Checks

```bash
npm run typecheck
npm run build
npm run audit
npm test
```

The MongoDB end-to-end suite is intentionally skipped unless a disposable database is supplied:

```bash
TEST_MONGODB_URI='mongodb+srv://…/sadik_travels_test' npm test
```

## Marketplace, RBAC and real-time support (2026)

- **Hotel inventory** — Super Admins and explicitly permitted Hotel Owners can
  manage owner-scoped hotels, room types, inventory, current nightly pricing,
  seasonal discount windows, availability and Cloudinary galleries.
- **Vendor RBAC** — `HOTEL_OWNER`, `HOME_OWNER` and `TRAVEL_AGENT` accounts are
  deny-by-default. Navigation, frontend routes and backend APIs all enforce the
  granular permissions assigned by a Super Admin.
- **Live support** — visitors initialize a token-protected Socket.IO room and
  exchange messages with the dual-pane Admin Live Support Inbox. Transcripts,
  unread counters and assignment state are persisted in Firebase Realtime
  Database (MongoDB fallback) and fanned out to sockets from the database
  subscription.
- **Payment safety** — gateway IPNs are idempotent, totals are calculated on the
  server and customer payment history uses the persisted ledger.
- **SEO/PWA** — live sitemap, robots policy, structured data and network-first
  application shell with API responses excluded from service-worker caches.
