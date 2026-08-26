# Sadik Travels runtime architecture

## Runtime and deployment

- Node.js 20 and Express 5
- One Render web service serving public website, admin console, API, and static assets from one origin
- `TRUST_PROXY=true` in Render so cookies, request IPs, and HTTPS proxy behavior are correct

## Persistent services

| Concern | Production service |
| --- | --- |
| Application data | Managed MongoDB / MongoDB Atlas via `MONGODB_URI` |
| Live chat (conversations + transcripts) | Firebase Realtime Database via the Admin SDK; MongoDB fallback when Firebase is not configured |
| Images | Cloudinary |
| Session state | Signed HttpOnly JWT cookies, with server-side session records in MongoDB |
| Delivery | Configured SMS, SMTP, travel, and payment providers |

No runtime business data relies on SQLite, local files, or a Render persistent disk.

## MongoDB entity model

The Mongo repository stores stable UUID-based records in dedicated Mongoose collections. Schemas and indexes cover IDs, lifecycle status, ownership, update time, and slugs. Domain types include users, OTP challenges, sessions, bookings, booking events, hotels, rooms, room inventory, tours, payments, support/live-chat sessions, transcript messages, notifications, settings, content, media metadata, admin navigation, travel agents, customer notes, and audit records.

This preserves the existing API contract while removing all SQLite-specific SQL, filesystem initialization, and disk persistence assumptions.

## Vendor RBAC and hotel ownership

Canonical platform roles are `SUPER_ADMIN`, `HOTEL_OWNER`, `HOME_OWNER` and
`TRAVEL_AGENT` (stored in MongoDB using the existing lower-case role
convention). Vendor roles are deny-by-default: only a Super Admin can assign
granular capabilities. Both the admin route guard and API middleware enforce
those assignments. Hotel APIs additionally restrict management to Super Admins
and Hotel Owners; Hotel Owners are scoped to listings they own.

Hotel records support room-type labels, fallback per-night pricing, seasonal
discount windows, gallery metadata and an explicit availability toggle. Public
catalogue prices are calculated from active room inventory (or the fallback
price), apply the current seasonal discount, and never trust browser totals.

## Real-time support

The live chat module lives in `src/chat/`. `service.ts` resolves conversation
context server-side (hotel id → `hotel.ownerId` → owner participant), enforces
per-role scoping (hotel owners see only their hotels, support staff see all)
and derives duplicate-prevention keys (`type:contextId:customerUid`).
`store.ts` persists the model behind a `ChatStore` interface: Firebase
Realtime Database (`conversations`, `userConversations`, `messages`, `typing`,
`presence`, `chatIdentities`) when credentials are configured, MongoDB
otherwise. `realtime.ts` fans Socket.IO events out for the MongoDB mode.
Browsers use `chat-client.js`: with Firebase they subscribe directly to
Realtime Database using server-minted custom tokens (onValue/onChildAdded
listeners, direct writes) — Realtime Database is the real-time source of
truth; without Firebase the same UI runs on Socket.IO events. The production
security rules are in `database.rules.json`.

## Media

Cloudinary is accessed only by the backend. Uploads are validated from file bytes, limited in memory, stored in an organized Sadik Travels folder, and represented in MongoDB by media metadata. No Cloudinary secret is returned to browser code.

## Testing

`TEST_MONGODB_URI` runs the integration suite against a dedicated disposable MongoDB database. Do not point it to a production database.

## Commerce and catalogue module

`commerce-store.ts` registers additional Mongoose collections on the shared
connection: `catalog_products`, `carts`, `wishlist_items`, `coupons`,
`coupon_redemptions`, `orders`, `invoices`, `saved_travelers` and `reviews`. Each has UUID keys, `createdAt`/`updatedAt` stamps and
indexes for the queries the storefront and admin console run (type + status +
sort, unique slug per type, order number, contact email/phone, review product,
coupon code).

`commerce-routes.ts` exposes the public catalogue, the authenticated customer
surface (cart, wishlist, checkout, orders, invoices, travellers and reviews)
and the permission-guarded admin surface. Pricing is computed
server side in `priceCart`, coupons are evaluated in `evaluateCoupon`, and
payment intents reuse the existing `PaymentProvider` abstraction so the
gateway (SSLCommerz, bKash, …) stays configurable from the admin settings.

## Front-end modules

- `pages.js` — storefront route module (shared page shell, catalogue pages,
  product detail, cart, checkout, orders, invoices, account, tracking,
  support). Registered as `window.SadikPages`; `app.js` delegates to it.
- `storefront.css` — component styles for those pages.
- `admin-commerce.js` — catalogue, orders, coupons, reviews and visa
  application screens for the admin console, registered as
  `window.AdminCommerce`.

## Storefront navigation (marketplace focus)

The primary customer navigation is intentionally limited to the travel
marketplace surface: Home, Hotels, Homes & Villas, Tours, Holiday Packages,
Explore, Travel Agents, My Cart, Wishlist, Track Booking, Payments, Support
and My Account. Legacy verticals (flights, visa, eSIM, Umrah, medical tourism,
card/airline offers) keep their routes and admin data models so old links and
existing content never 404, but they are no longer part of the primary
navigation, hero search tabs or homepage sections. The default admin sidebar
(`DEFAULT_NAVIGATION` in `src/store.ts`) is trimmed to match; existing
deployments can hide any remaining legacy items from Admin → Navigation
Manager without deleting data.

## PWA

- `manifest.webmanifest` — installable app manifest (standalone display,
  brand icons incl. a maskable 512px icon, app shortcuts for Hotels, Tours,
  Track Booking and My Cart).
- `sw.js` — service worker: precached app shell, network-first navigations
  with `offline.html` fallback, stale-while-revalidate for static assets and
  **no caching of `/api/`** (prices, availability, auth and payments always
  come from the server). Served with `Cache-Control: no-cache` so new
  versions roll out immediately.
- `pwa.js` — registers the worker and drives the custom branded install
  popup: `beforeinstallprompt` on Chromium, step-by-step instructions on iOS
  Safari and other browsers, 14-day dismissal cooldown persisted in
  `localStorage`, focus-trapped and keyboard-accessible dialog. Explicit
  "Install App" buttons (`[data-pwa-install]`) always work regardless of the
  cooldown.

## Degraded-mode behaviour (database unreachable)

- Every `/api/v1/*` request is guarded: if the MongoDB connection is not in
  `connected` state the API answers **503 `SERVICE_UNAVAILABLE`** within
  milliseconds with a user-safe message, instead of a 10-second mongoose
  buffering timeout surfacing as a generic 500.
- `/healthz`, `/readyz`, `/api/health` and `/api/ready` fail with 503 when the
  database is down (previously they incorrectly returned 200).
- Storefront pages render their shell (heading, search, filters) first and
  load data into a slot with explicit loading / empty / error(+retry) states,
  so a data failure never blanks the page: Hotels, Tours, Travel Agents,
  content collections and all `sf-page` catalogue routes degrade locally.
- `/homes-villas` (alias of `/homes`) and `/payments` (payment history) are
  first-class routes.


## Hard feature deletion (marketplace refactor)

The legacy verticals were **deleted from the architecture**, not hidden:

- **Removed backend chains**: live-supplier `TravelProvider` (flight/visa/eSIM
  search + reserve/cancel) and `/api/v1/search/:vertical`; the marketing
  campaign module (background `CampaignWorker` polling loop, campaigns,
  campaign recipients, templates, customer segments — models, store methods
  and all `/api/v1/admin/campaigns*` + segment routes); the visa-application
  module (model, store functions, customer and admin routes); the eSIM
  fulfilment adapter; legacy content types, feature flags
  (`feature_flights/visa/esim`) and sitemap entries.
- **Catalogue** is reduced to `holiday_package`, `home`, `destination`
  (plus the dedicated hotel store and tours). Bookings accept `tour` only;
  hotels use `/api/v1/hotels/*`, everything else checks out via the cart.
- **Frontend**: flight/visa/eSIM/Umrah/medical/card-offer/airline-offer pages,
  renderers, search forms and event handlers were deleted from `app.js`,
  `pages.js`, `admin.js` and `admin-commerce.js` (~60 KB of JS removed).
  Unused SVG symbols, 29 airline logo images, 3.6 MB of scraped promo images,
  the unused `prisma/` schema and the one-time SQLite importer are gone.
- **Data cleanup**: `npm run cleanup:legacy` (requires
  `CONFIRM_LEGACY_CLEANUP=yes` and a backup) drops the orphaned collections
  (`campaigns`, `campaign_recipients`, `campaign_templates`,
  `customer_segments`, `visa_applications`), deletes catalogue/content rows of
  removed types and removes legacy settings/service/navigation rows. Legacy
  `bookings` documents from removed verticals are intentionally preserved
  (financial history) and still render in the admin.
- **Legacy sidebar links never 404**: navigation rows persisted in MongoDB by
  older deployments are sanitized on read in `listNavigation`
  (`LEGACY_ADMIN_NAV_ROUTE_REMAP`, e.g. `/admin/homes` →
  `/admin/catalog?type=home`), and rows for deleted modules (campaign
  templates, customer segments, visa applications) are retired from the
  sidebar. The admin router mirrors this: `admin.js` redirects renamed legacy
  routes (`LEGACY_ADMIN_ROUTE_REDIRECTS`) and renders active placeholder
  workspaces for the consolidated SERVICES entries — Flights, eSIM and Visa
  (`renderLegacyServicePage`) — so every sidebar item opens a functional page
  instead of "Page not found".
