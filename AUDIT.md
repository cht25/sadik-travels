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
