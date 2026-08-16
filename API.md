# Sadik Travels API

Base URL: `/api/v1`. JSON errors are consistently shaped as:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "…" }, "requestId": "…" }
```

Browser writes authenticated through cookies require the `X-CSRF-Token` returned by `GET /auth/csrf`. Bearer-token API clients do not use the cookie CSRF flow. All state-changing browser requests in the included public/admin clients send this header.

## Public

- `GET /auth/csrf`
- `POST /auth/request-otp` — `{ "identity": "017XXXXXXXX" }`
- `POST /auth/verify-otp` — `{ "challengeId": "uuid", "code": "123456" }`
- `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/me`
- `GET /healthz`, `GET /readyz`
- `GET /home` — published homepage CMS data
- `GET /content/:type?page=&limit=&q=&featured=true`
- `GET /content/:type/:idOrSlug`
- `GET /agents`, `GET /agents/:idOrSlug`
- `GET /tours`, `GET /tours/:idOrSlug` (compatibility aliases for published Go Get Tour records)
- `POST /search/:vertical` where vertical is `flight`, `hotel`, `home`, `visa`, `tour`, or `esim`
- `POST /support/tickets`

Valid CMS types are:

`umrah-package`, `holiday-package`, `special-umrah-fare`, `campaign`, `travel-agent`, `visa-service`, `esim`, `medical-tourism`, `card-offer`, `airline-offer`, `go-get-tour`, `flight`, `hotel`, `home`, `explore`, `homepage`, `banner`, `promotional`, `contact`, `setting`, and `navigation`.

## Signed-in customer

- `PATCH /profile` — update display name
- `POST /profile/request-identity-change` — sends a verification OTP to a proposed email/mobile
- `POST /profile/verify-identity-change` — completes the verified contact change
- `GET /notifications`, `PATCH /notifications/:id/read`
- `POST /bookings`, `GET /bookings`, `GET /bookings/:id`, `POST /bookings/:id/cancel`
- `POST /payments/intents` — `{ "bookingId": "uuid" }`

Payment amount/currency are taken from the trusted quote returned by the travel provider when the booking was created. The browser cannot supply its own payment amount.

## Admin / manager

Admin endpoints require a logged-in account with a server-side `admin` or `manager` role. Initial administrator promotion occurs only when the OTP identity appears in `ADMIN_IDENTITIES`.

- `GET /admin/me`, `GET /admin/stats`
- `GET /admin/content?type=…&status=&q=&page=&limit=`
- `POST /admin/content`
- `PATCH /admin/content/:id`
- `POST /admin/content/:id/publish`
- `POST /admin/content/:id/unpublish`
- `POST /admin/content/:id/archive`
- `POST /admin/content/:id/restore`
- `POST /admin/content/reorder` — `{ "type": "banner", "ids": ["uuid", "…"] }`
- `POST /admin/media` — `{ "dataUrl": "data:image/webp;base64,…", "fileName": "banner.webp" }`
- `DELETE /admin/media?publicId=sadik-travels/...`
- `GET /admin/users?q=&status=&page=&limit=`
- `PATCH /admin/users/:id` (super-admin for role/status changes)
- `POST /admin/users/bulk` (super-admin)
- `GET|POST /admin/message-templates`
- `PATCH|DELETE /admin/message-templates/:id`
- `POST /admin/messages/send`
- `GET /admin/deliveries`

## Super-admin destructive actions

- `DELETE /admin/content/:id` permanently removes an archived or any CMS record. The normal archive/restore lifecycle is preferred and available to managers. Permanent deletion requires `admin`, never merely `manager`.

## Payments and provider boundary

`POST /payments/webhook` verifies `x-payment-signature` as an HMAC SHA-256 of the raw request body using `PAYMENT_WEBHOOK_SECRET`. Configure the provider to send the exact raw body expected by this verification.

`src/providers.ts` contains the live integration boundary. It never creates static search results, test reservations, or successful payment data. Supplier-specific contracts belong there and must be tested against the supplier sandbox before go-live.
