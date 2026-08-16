# Sadik Travels runtime architecture

## Runtime and deployment

- Node.js 20 and Express 5
- One Render web service serving public website, admin console, API, and static assets from one origin
- `TRUST_PROXY=true` in Render so cookies, request IPs, and HTTPS proxy behavior are correct

## Persistent services

| Concern | Production service |
| --- | --- |
| Application data | Managed MongoDB / MongoDB Atlas via `MONGODB_URI` |
| Images | Cloudinary |
| Session state | Signed HttpOnly JWT cookies, with server-side session records in MongoDB |
| Delivery | Configured SMS, SMTP, travel, and payment providers |

No runtime business data relies on SQLite, local files, or a Render persistent disk.

## MongoDB entity model

The Mongo repository stores stable UUID-based records in dedicated Mongoose collections. Schemas and indexes cover IDs, lifecycle status, ownership, update time, and slugs. Domain types include users, OTP challenges, sessions, bookings, booking events, tours, payments, tickets, ticket messages, notifications, settings, content, media metadata, admin navigation, travel agents, campaign templates, segments, campaigns, recipients, notes, and audit logs.

This preserves the existing API contract while removing all SQLite-specific SQL, filesystem initialization, and disk persistence assumptions.

## Media

Cloudinary is accessed only by the backend. Uploads are validated from file bytes, limited in memory, stored in an organized Sadik Travels folder, and represented in MongoDB by media metadata. No Cloudinary secret is returned to browser code.

## Testing

`TEST_MONGODB_URI` runs the integration suite against a dedicated disposable MongoDB database. Do not point it to a production database.

## Legacy import

`src/migrate-sqlite-to-mongo.ts` is a one-time, opt-in importer for a previous SQLite deployment. It is never loaded by the Render service. It reads a supplied legacy file, maps the application tables to the Mongoose collections, and uses idempotent MongoDB upserts.

## Commerce and catalogue module

`commerce-store.ts` registers additional Mongoose collections on the shared
connection: `catalog_products`, `carts`, `wishlist_items`, `coupons`,
`coupon_redemptions`, `orders`, `invoices`, `saved_travelers`, `reviews` and
`visa_applications`. Each has UUID keys, `createdAt`/`updatedAt` stamps and
indexes for the queries the storefront and admin console run (type + status +
sort, unique slug per type, order number, contact email/phone, review product,
coupon code).

`commerce-routes.ts` exposes the public catalogue, the authenticated customer
surface (cart, wishlist, checkout, orders, invoices, travellers, reviews, visa
applications) and the permission-guarded admin surface. Pricing is computed
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
