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

### Hotel marketplace

`src/hotel-store.ts` and `src/hotel-routes.ts` implement the public hotel
marketplace:

- **Images** — the canonical representation is
  `hotel.images = [{ url, publicId?, mediaId?, alt? }]`. Admin uploads go to
  Cloudinary through the media library; every save and every read passes
  through `normalizeHotelImages`, which repairs legacy string rows, upgrades
  insecure `http://` URLs, and drops empty entries — so an image URL in the
  database is always a usable `https://` URL and a missing/failed image
  renders the branded Sadik Travels placeholder, never a broken icon. The
  first image is the primary photo (re-orderable from Admin → Hotel → Images
  via "Make primary") and feeds listing cards, search results, the details
  hero and booking snapshots. Replaced images get new Cloudinary public ids,
  so guests always see the latest version without manual cache clearing.
  Card and hero containers use fixed `aspect-ratio` boxes with
  `object-fit: cover`, so unusual upload dimensions can never stretch the UI.
- **Search & filters** — the public `/hotels/search` page derives its filter
  options from live data (property types, areas, amenities, star levels and
  price bounds are returned as facets by `GET /api/v1/hotels`). Filters are
  server-side and combinable: multi property types (OR), multi areas (OR),
  exact star levels (OR), amenities (AND), price band over the real lowest
  bookable nightly price, guest score, free cancellation, name/area search,
  and date-aware availability (hotels with no room for the selected dates are
  hidden and flagged). Sorting: recommended, price ↑/↓, rating.
- **Pricing & availability** — listing prices come from persisted room prices
  (`priceFrom`), nightly seasonal discounts included. `POST
  /api/v1/hotels/price-quote` and booking creation recalculate everything
  server-side from the database (never trusting browser values), validate
  occupancy against room capacity and atomically reserve per-date inventory
  with rollback on overbooking.

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

### Live chat (Messenger-style, Firebase Realtime Database)

Live chat is a Messenger-style conversation system with context: every
conversation carries a `type` (`hotel`, `tour`, `home_stay`, `travel_agent`,
`support`) and a stable `contextId` (e.g. the hotel UUID — never a name).
When a customer starts a chat from a hotel page, the server looks up
`hotel.ownerId`, resolves that account, and adds it as a real participant with
its own profile (photo, name, "Hotel Owner" role label). The customer and the
hotel owner then message each other instantly; support conversations reach the
support/admin inbox.

**Real-time path.** Firebase Realtime Database is the source of truth. The
server mints a Firebase **custom token** for each chat identity (registered
customers `u-<userId>`, staff `s-<userId>`, guests get server-issued `g-<uid>`
credentials), the browser signs into Firebase Auth with it, and all message
traffic uses Realtime Database listeners (`onValue`, `onChildAdded`) and
direct database writes. There is no polling anywhere.

**Authorization.**

- `database.rules.json` (this repository) is the production ruleset: a user
  can read a conversation only through `userConversations/<uid>/<cid>`
  (participants) or the `support` custom-token claim; messages are append-only
  writes validated against `senderId === auth.uid`; read state
  (`reads`, `unread`) can only be changed for yourself (others may only
  increment); presence and typing are self-owned and ephemeral.
- Hotel owners can only ever be participants of conversations for hotels they
  own — the server derives participation from `hotel.ownerId`, and the REST
  inbox filters by owned hotel ids. Owner B cannot read or write owner A's
  threads (verified by tests).
- Super Admin / support staff (`support.view` fine permission) can access all
  conversations according to their level.
- Conversation creation and all REST fallbacks are server-validated: the
  browser never dictates `hotelId`, participants, or roles.

**Duplicate prevention.** Conversations are keyed deterministically by
`type:contextId:customerUid`, so the same customer returning to the same hotel
reuses the existing conversation instead of creating a new one.

**Unread / receipts / presence / typing.** Read state is stored in Firebase
(`conversations/$cid/reads/$uid`), unread counters in
`conversations/$cid/unread/$uid` (increment-only for others, resettable only
by the owner of the counter), presence in `presence/$uid` (with
`onDisconnect`), and typing in `typing/$cid/$uid` with short TTL semantics.
The storefront and the admin Live Chat inbox render Messenger-style lists,
bubbles, sent ✓ / read ✓✓ receipts, online status and typing indicators.

**Deploying the rules.** Publish `database.rules.json` to your Firebase
project (Firebase console → Realtime Database → Rules, or
`firebase deploy --only database`). The Admin SDK bypasses rules; browsers are
constrained by them. Never run with `".read": true, ".write": true`.

**Without Firebase credentials** (local development, CI, demo mode) the same
conversation model is stored in MongoDB and events fan out over Socket.IO —
still push-based; no polling. Transcripts persist in both modes.

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

The service must use `npm start` as its start command. Do not append `npm i` or any other setup command to it: dependency installation belongs in the build command, and a post-start install can mask the real application exit. If the service was created from the Render dashboard rather than this Blueprint, copy the production environment values into **Environment** manually—Blueprint changes are not retroactively applied to an existing service. In particular, set `COOKIE_SECURE=true` (and remove any stale `COOKIE_SECURE=false`). The application also defaults this flag to `true` when `NODE_ENV=production`, while still rejecting an explicit insecure value.

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
- **Live support** — a Messenger-style, context-aware chat: hotel pages offer
  "Chat with Hotel", the hotel's owner is added as the conversation partner,
  and messages stream over Firebase Realtime Database listeners (Socket.IO
  fallback without Firebase). The admin Live Chat inbox scopes hotel threads
  to their owners and support threads to the support team.
- **Payment safety** — gateway IPNs are idempotent, totals are calculated on the
  server and customer payment history uses the persisted ledger.
- **SEO/PWA** — live sitemap, robots policy, structured data and network-first
  application shell with API responses excluded from service-worker caches.
