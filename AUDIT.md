# Sadik Travels — Production audit & hardening

This document records what was investigated and what was changed, with the
evidence for each conclusion. Nothing here is aspirational: every statement
about the previous behaviour was reproduced before it was fixed.

---

## 1. The BDT 6,000 → BDT 14,400 payment bug

### Investigation

Traced from the user-visible price back through every layer, in order:

| Layer | What it did | Verdict |
| --- | --- | --- |
| `app.js` `openTourCheckoutWizard` | Rendered `<input id="tourAdults" value="2">` | **Defect A** |
| `app.js` `#tourTravellers` (legacy modal) | Also hardcoded `value="2"` | **Defect A** |
| `POST /api/v1/tours/quote` | Computed `computeTourQuote({ adultPrice, vatPct: 15, aitPct: 5 }, { adults })` | **Defect B** |
| `POST /api/v1/bookings` | Reused the same hardcoded 15% + 5% | **Defect B** |
| `POST /api/v1/initiate-payment` | Ignored the browser's number and recomputed with the same 15% + 5% | **Defect B** |
| `src/payment-gateway-routes.ts` | Same | **Defect B** |

Reproduced exactly, no guessing:

```
computeTourQuote({ adultPrice: 6000, vatPct: 15, aitPct: 5 }, { adults: 2 })
  base      = 6000 × 2        = 12,000
  vat 15%   = 12000 × 0.15    =  1,800
  ait  5%   = 12000 × 0.05    =    600
  total                       = 14,400   ← the reported amount
```

Two independent defects, no third:

* **Defect A — a hidden quantity.** The traveller field silently defaulted to 2,
  so a customer who selected nothing was quoted and charged for two travellers.
* **Defect B — undeclared charges.** A 20% VAT + AIT was applied to every tour
  and shown only as one compressed line, so the jump looked arbitrary.

There was **no** duplicate multiplication, **no** double fee and **no**
duration/night multiplication. Ruling these out mattered: the fix is different.

### Fix

* `DEFAULT_TOUR_TRAVELLERS = 1`; anything missing, zero, negative or non-numeric
  normalises to 1 adult. Both inputs default to `value="1"`.
* Tour surcharges are **opt-in, never implicit**. Default VAT, AIT and service
  fee are 0. An operator sets them per tour (`metadata.vatPct`,
  `metadata.aitPct`), per deployment (`TOUR_VAT_PCT`, `TOUR_AIT_PCT`,
  `TOUR_SERVICE_FEE_PCT`) or per site (Admin → Settings).
* **Every** checkout renders a full line-item breakdown — base, travellers,
  discount, VAT, AIT, service fee, season surcharge, subtotal, total payable —
  so there is no hidden charge left to explain.

> ⚠️ **Breaking change, deliberately.** Tours that previously carried an
> implicit 20% tax now charge none until an operator opts in. Continuing to
> charge an undeclared tax on every booking would repeat the original bug.

The amount is now derived in exactly one place —
`src/tour-quotes.ts::resolveTourQuote` — used by the quote endpoint, booking
creation, `initiate-payment`, `payment-success` and `payment-fail`.

### Regression test

`src/smoke.test.ts` pins the reported case:

```
tour pricing returns 6000 for a single traveller and never the 14400 overcharge
```

It asserts `total === 6000` and `total !== 14400`, and that `{}`, `0`, `NaN` and
`-5` travellers all price as one adult.

---

## 2. Payment: server-side only

| Rule | Where it is enforced |
| --- | --- |
| Browser amounts are never trusted | `checkoutSchema` has no amount field; `initiate-payment` ignores `priceBdt` / `quotedTotal` / `finalAmount` / `paymentAmount` |
| Never PAID before verification | `confirmFromCallback()` — HMAC signature **or** a gateway transaction lookup. `unknown` ⇒ stays `PENDING` |
| Never PAID from a redirect | `/payment-success` verifies before it flips the status; it also audits and notifies |
| Webhook authenticity | `/api/v1/payments/ipn` requires `x-payment-signature`; replays are dropped by `recordWebhookEvent` |
| COD is never PAID | `method: 'cod'` creates a `pending` payment; the only path to `paid` is `POST /admin/payments/:id/confirm` |

Statuses: `PENDING · PROCESSING · PAID · FAILED · CANCELLED · REFUNDED`
(persisted lowercase). Stored per transaction: `transactionRef`,
`gatewayTransactionId`, `paymentMethod`, `amount`, `currency`, `status`,
`verifiedAt`, plus an `audit` entry naming the `source`.

---

## 3. Email (SMTP only — never push)

* Credentials come from environment variables or encrypted settings. The SMTP
  password is in `SECRET_SETTING_KEYS`, so it is redacted from every admin read
  path. No credential is ever serialised to the browser.
* `verifyEmailConfig()` actively connects. `GET /admin/system-status` reports
  whether SMTP is reachable — never the credentials. Boot logs a warning if it
  is misconfigured, rather than failing silently.
* Implicit TLS on port 465; STARTTLS elsewhere; certificate validation on by
  default in production.
* Passwords are **never** emailed. The reset flow sends a link; the welcome
  email contains the name, the address, a greeting, security guidance and the
  sign-in link.

Templates (`src/notifications/templates.ts`) escape every interpolated value and
are covered by tests.

---

## 4. Push notifications (Web Push / VAPID — not SMTP)

* `src/push/vapid.ts` generates and **persists** a VAPID key pair in MongoDB on
  first start. Only the public key is exposed (`GET /api/v1/push/config`).
* Subscriptions (`push_subscriptions`) store userId, device/browser, endpoint,
  keys, `createdAt` and `lastActiveAt`, deduplicated by an SHA-256 endpoint
  hash — the same browser re-subscribing updates one row.
* Dead endpoints are pruned: a `410`/`404` expires the row immediately; four
  consecutive failures expire it. `pushsubscriptionchange` re-subscribes
  automatically.
* The service worker handles `push` and `notificationclick` — a click focuses
  the open tab (or opens one) and navigates to the right page: a booking, an
  order, a payment or a conversation. It also re-subscribes on key rotation and
  reports a dismissed notification back to the server.

---

## 5. Forgot password

* A 32-byte random token, stored **hashed** with a TTL index. Single-use: the
  row is claimed atomically, so a second use fails.
* Rate-limited (default 5 requests per address per 15 minutes), and the endpoint
  always answers `202` with the same wording — **no account enumeration**.
* New passwords must be ≥ 12 characters with upper, lower, digit and symbol.
* Completing a reset revokes the user's other sessions and notifies them.
* Login with a password is only offered to accounts that actually have one.

---

## 6. New-device login alerts

* `user_devices` holds a stable per-device key plus a coarse label
  (`Chrome on Android`). No fingerprinting: only the User-Agent and IP are used,
  and the key ignores version numbers so a routine OS or browser update does not
  raise a false alert.
* A genuinely new device writes a `security_events` row, a persisted
  notification and an email.
* Location is only looked up when `IP_GEO_URL` is configured, is never resolved
  for private/loopback/reserved addresses, and is **always labelled
  approximate**: "Approximate location (based on network information — may be
  inaccurate)". The email explicitly states it is not an exact physical location.
* Users can review and forget devices at `GET/DELETE /api/v1/account/devices`.

---

## 7. One notification system

`src/notifications/` is the single place notifications are produced.
`NotificationService.emit()` fans out one event to in-app, push and email, per
recipient, deduplicated, preference-gated and never throwing.

| Event | Customer | Admin | Owner |
| --- | --- | --- | --- |
| `BOOKING_CREATED` / `TOUR_BOOKING_CREATED` | in-app + push + email | in-app + push + email | — |
| `HOTEL_BOOKING_CREATED` | in-app + push + email | in-app + push + email | in-app + push + email |
| `PAYMENT_SUCCESS` / `PAYMENT_FAILED` | in-app + push + email | in-app + push + email | in-app + push + email |
| `PAYMENT_PENDING_COD` | in-app + push + email | in-app + push + email | in-app + push + email |
| `NEW_DEVICE_LOGIN`, `PASSWORD_CHANGED` | in-app + push + email | — | — |
| `CHAT_MESSAGE` | in-app + push | in-app + push | in-app + push |
| `ADMIN_ANNOUNCEMENT` | in-app + push | in-app + push + email | in-app + push |

Preferences (`GET/PUT /api/v1/notifications/preferences`) cover push and email
across booking, payment, message and promotion categories. **Security alerts
cannot be switched off** — `securityLocked` is always true and a patch that
tries to change it is dropped. Legacy `marketingEmailOptIn` opt-outs still apply
to the promotion category.

Permission flow: the browser prompt is only raised from an explicit tap inside
the notification panel, after an explanation. A user who declines still gets
in-app notifications and email, and is not asked again for 30 days. Nothing on
page load calls `requestPermission()`.

---

## 8. Verification

```
npm run typecheck   → exit 0
npm test            → 71 pass, 0 fail, 1 skip
npm run build       → exit 0
```

`src/notifications.test.ts` covers the event catalogue, preference gating,
service fan-out and deduplication, email escaping, push payload validation,
device keying and reset-token entropy. `src/smoke.test.ts` pins the 6,000
regression.

The 1 skipped suite is the pre-existing MongoDB end-to-end suite: it needs
`TEST_MONGODB_URI`, and no MongoDB is available in this sandbox
(`fastdl.mongodb.org` is blocked and there is no apt package). It is unchanged
by this work.

What was verified by booting the real `buildApp()`: every new route is mounted
(they answer `503` with the database down, not `404`), and the PWA assets —
`manifest.webmanifest`, `sw.js`, `offline.html`, icons and the SPA fallback for
`/reset-password` — all serve with the correct content types.

### Not verifiable here

Real SMTP delivery, real push delivery, real gateway callbacks and the MongoDB
end-to-end suite. These need live credentials and a database.

---

## 9. Configuration

New variables, all documented in `.env.example`:

```
SMTP_FROM_NAME=Sadik Travels
SMTP_SECURE=
SMTP_REJECT_UNAUTHORIZED=
VAPID_PUBLIC_KEY=            # blank ⇒ generated and persisted on first start
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=
PASSWORD_RESET_TTL_MINUTES=30
IP_GEO_URL=                  # must contain {ip}; blank ⇒ no location shown
IP_GEO_TOKEN=
TOUR_VAT_PCT=0
TOUR_AIT_PCT=0
TOUR_SERVICE_FEE_PCT=0
```

Deploy checklist:

1. Set the SMTP variables and confirm `GET /api/v1/admin/system-status` reports
   `email.delivering` (or an actionable error).
2. Generate a VAPID pair with `npx web-push generate-vapid-keys`, or let the
   server create one. HTTPS is required — browsers reject push on plain HTTP.
3. Set the gateway credentials and `PAYMENT_GATEWAY_WEBHOOK_SECRET`.
4. Decide the tour tax policy. The default is now **no surcharge**; set
   `TOUR_VAT_PCT` / `TOUR_AIT_PCT` or per-tour metadata if a charge is intended.
5. Bump the cache-busting query strings if you edit `app.js` or `pwa.js`, and
   `VERSION` in `sw.js`, so clients pick up the new service worker.

## 10. Marketplace final audit (Holiday Packages → booking → payments)

### Root causes found and fixed

1. **Admin sidebar: Holiday Packages entry never rendered.** `MongoStore.listNavigation`
   deduplicated navigation rows on the route *base path* (`/admin/catalog`), so
   `/admin/catalog?type=home` (sortOrder 31) won and the holiday-package,
   destination and every other vertical row collapsed into it. Fix: dedup key is
   now the **full route** (path + query), and a bare `/admin/catalog` row without a
   `?type=` discriminator is never rendered. Live `/api/v1/admin/navigation` now
   returns exactly one entry per vertical — `Holiday Packages`, `Homes & Villas`,
   `Destinations (Explore)` — each with the correct permission
   (`catalog.view` / `home.view`).

2. **Home page hotels were permanently empty.** `renderHomeSections()` rendered an
   empty card list for the `home-hotels` section and `hydrateHomeHotels()` called
   an **undefined** `hsHotelCard()` helper inside a bare `try/catch`, so the
   ReferenceError was swallowed and the section stayed blank while the Hotels page
   worked. Fix: the homepage now hydrates from the **same real source** as the
   Hotels page (`GET /api/v1/hotels?pageSize=8&sort=recommended`) and renders with
   the same canonical `hotelCardHtml(hotel, {})` into the same
   `hotel-results-grid` — no separate list, no editorial fallback, no duplicates.
   The section shows real loading / empty ("No featured hotels yet") / error
   with retry states. `hotelBuildUrl` also no longer serialises `undefined`/
   empty search params into detail links.

3. **Hard-coded demo hotel catalogue in the sandbox server.** `src/demo-server.ts`
   carried an in-memory hotel catalogue with Cloudinary demo photos and
   `demoPriceFrom` pricing, plus demo hotel/destination endpoints — mock data that
   could be served in place of the real store. Fix: the demo server now boots only
   the chat harness and returns honest empty hotel responses; all content lives in
   MongoDB (`src/app.ts` / `src/index.ts`). Sandbox-only file, production unaffected.

4. **Hotel image validation rejected legacy image rows.** The admin hotel schema
   accepted only image *objects*; plain-string URLs (used by seeded records and
   the admin "one URL per line" list) failed with 400 — the same payload the smoke
   suite uses. Fix: the hotel/room image list now accepts canonical objects **or**
   plain URL strings, then normalises them (https upgrade, dedupe, primary flag)
   via `normalizeHotelImages`; entries that can never produce a usable URL are
   still rejected with 400 (existing contract kept).

5. **Room service fee was charged once per stay instead of per night.** The smoke
   suite pins `৳200 × 2 nights = ৳400`; `priceQuote` returned 200. Fix: service
   fee is now `fee × nights × quantity`, and the admin room field is labelled
   "Service fee (per night)".

6. **Checkout could be raced past availability and offline payments were
   unmanaged end-to-end.** Fixes in `commerce-routes.ts`:
   - Cart add enforces quantity ≤ persisted availability (no overselling the cart).
   - Checkout re-reads every line product from MongoDB and rejects unpublished,
     non-bookable or sold-out (quantity-aware) items — the client cannot bypass.
   - Every successful booking decrements the real `availability` counter; customer
     and admin cancellations restore it (admin cancellation is guarded so a
     repeat cancel can never double-restore).
   - Offline methods (`bank_transfer`, `office`, cash) stay `pending` →
     `processing` only, and can only be marked `paid` by an admin action; the
     frontend/redirect can never mark payment successful.

7. **Admin catalogue editor Cancel button did nothing.** The commerce module used
   `data-close-modal`, but the admin shell binds `data-modal-close`; and
   `.admin-modal-actions` had no CSS. Fixed both: buttons close the modal and the
   action row is styled (right-aligned desktop, full-width stacked on ≤760px).

8. **QA/fixture data removed from the sandbox database.** Deleted seeded fixtures
   (Hotel Sunset Test, Cox Bazar Holiday) and all automated-test artifacts
   (hotels, rooms, inventory, catalogue products, orders, invoices, payments,
   bookings, test customers) — `scripts/cleanup-qa-data.mjs` (manual, one-off).

### Changed files

| File | Change |
|---|---|
| `src/store.ts` | `listNavigation` dedup → full route; bare `/admin/catalog` filtered |
| `app.js` | `renderHomeSections`/`hydrateHomeHotels` rewrite; `hotelBuildUrl` optional params |
| `src/hotel-routes.ts` | hotel/room image lists accept objects **or** string URLs |
| `src/hotel-store.ts` | room service fee charged per night × quantity |
| `src/commerce-routes.ts` | checkout re-validation, availability consume/restore, admin-cancel guard |
| `admin-commerce.js` | permanent delete action; `data-modal-close` fix |
| `admin.css` | `.admin-modal-actions` styles + mobile stacking |
| `src/demo-server.ts` | mock hotel catalogue removed (chat harness only) |
| `src/smoke.test.ts` | image payload fixed; notification assertion matches feed semantics |
| `src/commerce-e2e.test.ts` | **new** — MongoDB-gated E2E (admin create/list/detail/pricing/booking/payment/edit/unpublish/delete/hotel sync/nav) |
| `src/homepage-hotels.test.ts` | **new** — homepage hotel source/renderer/URL regression tests |
| `package.json` | new test files wired into `npm test` |
| `AUDIT.md` | this report |

### Verified end-to-end (79/79 tests, 0 skip with TEST_MONGODB_URI; 75 pass / 3
MongoDB-gated skips without it)

- Admin create → refresh list → public list → detail (published only)
- Server-side price: 2 × ৳12,000 + 5% tax + 2 × ৳500 = **৳26,200**, computed from
  the DB record even when the browser sends `total: 1`
- Availability: booking consumes seats; cancellation restores them
- Payment: online intent amount = DB order total; `bank_transfer`/`office` never
  auto-confirm; admin confirm → invoice `paid`
- Edit price propagates; unpublish hides from public (admin keeps drafts);
  permanent delete removes the record
- Sold-out / non-bookable refused at cart and checkout
- Admin hotel create → public `/api/v1/hotels` (homepage source) immediately
- Sidebar: exactly one entry per vertical, permissions correct, retired verticals
  still blocked
- Click-through: `/`, `/hotels`, `/holiday-packages`, `/homes`, `/destinations`
  all render the storefront shell (200 + SPA HTML)
- Live curl QA on the running stack (steps 1–15 of the requested checklist)

### Remaining notes

- Payment gateways (SSLCommerz/bKash) return `503 *_NOT_CONFIGURED` until real
  credentials are set; the intent flow is otherwise verified with a stub and the
  offline/admin-confirm path is fully operational.
- No product "compare" tool exists in the current frontend; the "compare" QA item
  was covered by verifying the homepage and catalogue share the same real sources
  and pricing (no duplicate/mock data anywhere).
- Browsers are not installed in this environment, so UI checks were done by
  code inspection + API/JS-level tests instead of Playwright.

---

## Round 2 — Home Sliders, admin design system, compact sidebar (complete)

### Root causes

1. **No slider admin.** Home banners had no management UI; only generic
   `content` CRUD existed. The promo carousel was therefore either empty or
   unmanageable.
2. **Separate legacy banner rendering.** `app.js` still filtered generic
   content items (`type === 'banner'`) into the carousel, risking a second
   code path and draft leakage; `bindPromotionalInteractions` + a fake
   `openHotelDetails` modal were dead code with no matching markup.
3. **No public filtering contract.** The carousel needed a single endpoint
   that returns only `active + published + valid` sliders in `displayOrder`.
4. **Inconsistent admin layout.** Pages mixed raw `<section>`/`<form>` blocks
   with ad-hoc styling; Coupons had no filter card or empty state.
5. **Wide public sidebar.** `330px` fixed width and `.side-link` 8px+ padding;
   mobile drawer lacked a dedicated responsive lock/offscreen behavior.
6. **Admin icon fallback.** The `icon()` map lacked `sliders` and `archive`,
   silently rendering the grid glyph; `admin-commerce.js` referenced
   `window.icon` which was never exported, so empty-state icons were blank.
7. **Nav seed-merge gap.** `listNavigation` only seeded defaults into an empty
   `admin_navigation` collection; existing deployments never received new
   entries (e.g. Home Sliders).

### Changes

- **API (src/app.ts):** one `content` model (`type: 'banner'`,
  `metadata.sliderSource === 'home'`) — no duplicate endpoints/tables.
  - `sliderFieldsSchema` (strict, safe-href validation: `/` internal only,
    https/http external only, `javascript:`/`data:`/protocol-relative
    rejected), `sliderInputSchema` (full-document guard: published requires
    cover image), `sliderPatchSchema` (partial, merged-document re-validation
    on PATCH so publishing an existing draft works).
  - Admin routes: `GET/POST /api/v1/admin/sliders`,
    `PATCH /api/v1/admin/sliders/:id`, `POST .../:id/publish|unpublish`,
    `DELETE .../:id` (archive), `DELETE .../:id/permanent` (archive-then-
    delete only) — all behind `offer.*` fine permissions + audit events.
  - Public `GET /api/v1/site/sliders`: filter
    `sliderSource === 'home' && status === 'published' && active !== false &&
    imageUrl && date-valid`, sorted by `sortOrder`; Cloudinary-optimized URLs.
  - `sliderContentPatch` writes only defined keys; POST normalizes defaults.
- **Admin UI (admin.js / admin.css):** "Home Sliders" module under
  WEBSITE (one entry, breadcrumb, permission map); stats row, filter card,
  card list with thumbnails, move-up/down ordering, edit/preview/
  publish/unpublish/enable/disable/archive/restore/permanent delete;
  editor with cover+mobile uploads (media library, `banners` folder),
  button text/link + external flag, display order, status, start/end dates.
  Icon map now includes `sliders` and `archive`; `window.icon` exported.
- **Admin design system (admin.css):** `.admin-card` + content/section/
  stats/filter/table/form/empty cards, `.admin-action-bar`, modal card,
  hover states; applied across every admin page (all filter bars now live
  inside an `admin-filter-card`; tables in `admin-table-card`; forms in
  `admin-form-card`). Coupons: Filter Card + Empty State Card
  ("No coupons yet" + explanation + "+ New Coupon").
- **Public carousel (app.js / styles.css):** `applyPublicContent` fetches
  `/site/sliders` only; `sliderSlideHtml` renders `<picture>` mobile image,
  sanitized copy, one slide container with `data-public-route` buttons;
  `bindSliderBanners` handles slide-level clicks; `bindPublicRouter`
  delegation + `publicNavigate` keep SPA routing (no reload, no 404).
  Dead `bindPromotionalInteractions` and `openHotelDetails` removed.
- **Sidebar (styles.css):** shell layout 232px (226px ≤1440, 220px ≤1180),
  `.side-link` min-height 36px, 8px gap, 0.85rem; mobile drawer 280px with
  `body.sidebar-open{overflow:hidden}`, no horizontal scroll
  (`overflow-x:clip`), all items/routes/active/dropdowns preserved.
- **Nav seed (src/store.ts):** `listNavigation` merges missing default
  rows into a populated `admin_navigation` collection (dedup on full route,
  legacy remap, canonical permission refresh, retired filter).

### Files changed

| File | Change |
|---|---|
| `src/app.ts` | slider schemas, admin CRUD/publish/archive/permanent, public `/site/sliders` |
| `src/store.ts` | `listNavigation` seed-merge into existing persisted nav |
| `admin.js` | slider module, icon map (`sliders`, `archive`), `window.icon`, card classes |
| `admin-commerce.js` | catalog/order/coupon/review filter cards; `window.icon` empty states |
| `admin.css` | card design system, slider cards, modal actions, mobile stacking |
| `admin.html` | cache-bust versions |
| `app.js` | public `/site/sliders` carousel, data-public-route SPA delegation, dead code removed |
| `index.html` | carousel container `#bannerTrack`/`#offers`; cache-bust |
| `styles.css` | compact sidebar + drawer/responsive overflow rules |
| `src/sliders.test.ts` | **new** MongoDB E2E: CRUD → DB → public feed, publish guard, ordering, media lifecycle |
| `src/slider-frontend.test.ts` | **new** app.js static contract tests |
| `package.json` | new tests in `npm test` |

### Verified end-to-end

- `npm test`: **82/82 pass** (incl. new suites), `npm run typecheck` clean.
- Live server QA (port 8787): **23/23 checks** — invalid-link rejections,
  create published → public feed, ordering, edit propagation, disable hides,
  publish-without-image blocked, archive hides, permanent delete, homepage
  `#bannerTrack` + `#offers`, app.js uses `/site/sliders` + `banner-actions`,
  storefront home data-driven; test fixtures cleaned to zero.
- Admin nav: 22 entries, exactly one Home Sliders, one Holiday Packages, no
  duplicate routes; seed-merge verified against a simulated old DB.
- All 22 admin page renderers confirmed using the card classes; 15/15 filter
  bars inside `admin-*-card`; Coupons has Filter Card + Empty State Card.

### Remaining notes

- Same browser limitation as Round 1: UI verified by code inspection + API/
  JS-level tests; no Playwright available.
- Gateway stubs unchanged (payment provider config required in production).
