# Sadik Travels

Sadik Travels is a single-service Node.js travel platform with an Amy-style customer experience, Sadik Travels branding, a secure operations console, MongoDB persistence, Cloudinary media, and a Render deployment blueprint.

The repository contains no seeded tours, customer records, bookings, offers, admin accounts, or provider responses. Create business content through `/admin` after deployment.

## Stack

- Node.js 20, Express 5, TypeScript
- **MongoDB** via Mongoose — the only runtime database
- Cloudinary for permanent image storage
- JWT sessions in HttpOnly cookies
- OTP customer login plus secure admin password/OTP access
- Render web service deployment
- Vanilla responsive public site and routed admin application

## What the application manages

### Public website

Flights, hotels, homes, visa, eSIM, Go Get Tour, Umrah packages/fare, holiday packages, medical tourism, card/airline offers, explore, travel agents, campaigns, app links, customer login, booking tracking, support/contact flows, and notifications.

### Admin console

- Dashboard, bookings, ownership, lifecycle and booking events
- Customers, notes, status, roles, preferences and sessions
- Payments and transactions
- Support tickets and conversations
- Tours, public content, banners, offers, service visibility and navigation
- Travel-agent CRUD and public profiles
- Campaigns, reusable templates, customer segments, queues and delivery status
- Cloudinary media library
- Encrypted provider/settings workspace
- Admin users, permissions and audit logs

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

Every sidebar entry is a real route that works on refresh and direct URL
access: `/flights`, `/hotels`, `/homes`, `/visa`, `/tours`, `/esim`,
`/special-umrah-fare`, `/umrah-packages`, `/holiday-packages`,
`/medical-tourism`, `/card-offers`, `/airlines-offers`, `/explore`,
`/travel-agents`, `/app`, `/cart`, `/wishlist`, `/checkout`, `/orders`,
`/invoice/:id`, `/account`, `/track-booking` and `/support`.

## Commerce engine

`src/commerce-store.ts` and `src/commerce-routes.ts` add the catalogue and
e-commerce layer on top of the existing booking APIs:

| Collection | Purpose |
| --- | --- |
| `catalog_products` | eSIM, Umrah, holiday, medical, visa, homes, offers, destinations |
| `carts`, `wishlist_items` | Persistent per-customer cart and wishlist |
| `coupons`, `coupon_redemptions` | Server-validated discount rules and per-user limits |
| `orders`, `invoices` | Unified order/booking engine with timeline and receipts |
| `saved_travelers` | Reusable traveller profiles for auto-filled checkout |
| `reviews` | Purchase-verified reviews with admin moderation |
| `visa_applications` | Visa applications with passport data and status tracking |

Prices, taxes, service fees, coupons and totals are always recalculated on
the server from persisted records; browser values are never trusted. Every
admin endpoint is guarded by a fine-grained permission
(`catalog.create`, `order.refund`, `coupon.delete`, `review.moderate`,
`visa.update`, …) and writes an audit entry. Super Admin bypasses
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

For the first administrator, configure `SUPER_ADMIN_EMAIL` and `SUPER_ADMIN_PASSWORD` only through `.env` or the Render secret manager. The password is hashed using `scrypt`, never stored in source, and is not overwritten after initialization. Remove bootstrap credentials after the first successful sign-in.

## MongoDB

Set a managed MongoDB connection string:

```dotenv
MONGODB_URI=mongodb+srv://USER:PASSWORD@cluster.example.mongodb.net/sadik_travels?retryWrites=true&w=majority
```

All application entities—users, sessions, OTP challenges, tours, bookings, payments, content, media metadata, agents, settings, navigation, campaigns, recipients, support, and audit logs—are persisted in dedicated Mongoose collections (users, bookings, tours, content, agents, media, campaigns and supporting records). Schemas enforce field types, enums, unique IDs/slugs, lifecycle status, and query indexes.

The server refuses to start without `MONGODB_URI`; production also rejects localhost MongoDB URLs.

### One-time legacy SQLite import

If an earlier deployment contains real SQLite data, import it once before retiring the old database. This utility is not part of the web-service runtime and does not make SQLite a production dependency:

```bash
npm install --no-save better-sqlite3
MONGODB_URI='mongodb+srv://…/sadik_travels_staging' \
LEGACY_SQLITE_PATH=/absolute/path/to/sadik.sqlite \
npx tsx src/migrate-sqlite-to-mongo.ts
```

The migration imports users, sessions, OTPs, bookings/events, tours, payments, support, notifications, settings, content, media metadata, navigation, agents, campaigns, recipients, templates, segments, notes, and audit logs. Run it against a staging Atlas database first, compare counts, back up both databases, then point Render at the verified MongoDB URI.

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
- `SUPER_ADMIN_EMAIL` and `SUPER_ADMIN_PASSWORD` only for first-run bootstrap

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

## Marketplace, payments and fulfilment (2026 additions)

- **eSIM marketplace** — a dedicated `/esim` page with a country selector, data /
  validity / region filters, sort and premium plan cards. eSIM plans are ordinary
  catalogue products (`type: esim`) enriched with provider, activation method,
  QR code URL, SM-DP+, activation code and installation instructions. Plans are
  uploaded country-wise from Admin → Catalogue.
- **Flight booking flow** — flight search results (live provider) now flow into a
  passenger/contact form at `/flights/booking`; the server re-quotes the fare
  through the travel provider, creates the booking and starts gateway payment.
- **Payment ledger** — payments now record gateway transaction id, initiated /
  completed / failed timestamps, failure reason, refund status and an idempotency
  key. Customers see their transaction history under Account → Payments; admins
  can search and export CSV from Admin → Payments.
- **Idempotent webhooks** — gateway IPNs are deduplicated by
  `paymentId:status:reference` in `webhook_events`, so retries and mirrored IPNs
  never double-confirm a booking or double-mark an invoice paid.
- **Automatic fulfilment** — after a verified payment, eSIM orders request
  activation data from the configured eSIM provider (`esim_provider_url` /
  `esim_provider_api_key`, also editable in Admin → Settings → Travel provider).
  Without a provider the order stays **FULFILLMENT_PENDING** and an admin
  completes it from Admin → Orders → Fulfilment (QR code, SM-DP+, activation
  code, instructions). Fulfilment is never fabricated.
- **Website analytics** — meaningful events (`page_view`, `search`,
  `hotel_view`, `flight_search`, `tour_view`, `esim_view`, `product_view`,
  `add_to_cart`, `checkout_started`, `payment_started`, `payment_success`,
  `payment_failed`, `booking_created`, `booking_confirmed`) are stored in
  `analytics_events` and reported in Admin → Analytics with time ranges, traffic
  trend, popular pages, device breakdown and conversion rates.
- **Payment return page** — `/payment/return` verifies the stored transaction
  server-side and shows success / failed / cancelled states with booking links.
- **SEO** — live `/sitemap.xml` (built from published hotels, tours and
  products), `/robots.txt`, per-page titles/descriptions/canonicals and
  JSON-LD structured data (Hotel, Product, TouristTrip).
- **Unified booking history** — My Bookings and Account → My Bookings merge
  catalogue orders, hotel stays and legacy provider requests into one list.
