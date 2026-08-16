# Sadik Travels

Sadik Travels is a full-stack, database-backed travel website and CMS. The public site reads only published content; the protected admin panel manages the catalogue, homepage, banners, campaigns, agents, navigation, customer accounts, messaging templates, and delivery history.

> The repository intentionally ships with **no fabricated packages, offers, images, or travel inventory**. Create real content in the CMS after deployment.

## What is included

- Responsive public SPA with catalogue listings, details pages, travel-agent directory/profile pages, contact form, OTP sign-in, notifications, loading/error/empty states, and mobile drawer navigation.
- Full admin CMS at `/admin` for Umrah, holidays, special fares, campaigns, travel agents, visa/eSIM/medical services, card/airline offers, Go Get Tour, flights, hotels, homes, explore, homepage, banners, promotions, contact, settings, and navigation.
- CMS lifecycle actions: create, edit, publish, unpublish, archive, restore, order, and (super-admin) permanent delete.
- Travel-agent fields via the **Additional details** JSON field: `company`, `phone`, `email`, `address`, and any other display-safe detail. Public cards lead to the matching agent profile.
- Persistent media uploads using Cloudinary; no uploaded image is written to the application filesystem.
- Passwordless OTP authentication, server-side role allowlist, HttpOnly sessions, token rotation, CSRF protection for cookie writes, rate limits, audit records, security headers, input validation, and signed payment webhooks.
- Customer search/filter/select/bulk status management, reusable message templates, live SMS/email/in-app campaign delivery, and stored delivery status.

## Local development

Requirements: Node 20+; for the default development profile, MongoDB and Redis. Docker is optional.

```bash
cp .env.example .env
npm ci
npm run dev
```

The application is served at `http://localhost:8787` and the CMS is at `http://localhost:8787/admin`.

For an **ephemeral local UI/API smoke session only**, you may set:

```dotenv
DATA_MODE=memory
DEV_OTP_ECHO=true
ADMIN_IDENTITIES=017XXXXXXXXX
```

Memory mode is explicitly blocked in production. It is never a persistence option.

### First administrator

Set `ADMIN_IDENTITIES` to the actual mobile number or email of each administrator before they sign in. Numbers can be written as `017XXXXXXXXX` or `+8801XXXXXXXXX`; identities are normalized on the server. Sign in at `/admin` with the one-time code. There are no seeded accounts or hard-coded credentials.

## CMS content model

All content sections share a validated record with title, slug, image, short/full copy, location, tags, price/currency, CTA, active dates, featured flag, display order, status, and an `Additional details` JSON object. This keeps ordinary content data editable without source changes while retaining one authorization and lifecycle implementation.

Useful examples for the `Additional details` field:

```json
// Travel agent
{ "company": "Sadik Agency", "phone": "+8801…", "email": "agent@example.com", "address": "Dhaka" }

// Navigation
{ "label": "Umrah", "path": "/umrah", "visible": true }

// Homepage/banner
{ "eyebrow": "Travel with confidence" }
```

When at least one published Navigation item exists, it controls the public menu. Otherwise the application shows its built-in, functional route menu so a new site cannot become unreachable.

## Required production configuration

Copy `.env.example` and provide every required live credential. `validateConfig()` refuses production startup unless all of these are configured safely:

- TLS MongoDB (`MONGODB_URI`) and managed Redis (`REDIS_URL`)
- a unique 32+ character `JWT_SECRET`, HTTPS `APP_ORIGIN`, explicit `CORS_ORIGINS`, secure cookies, and `TRUST_PROXY=true` behind Render
- `ADMIN_IDENTITIES`
- Cloudinary (`CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`)
- BulkSMSBD and SMTP credentials for real OTP/email delivery
- a real travel provider and payment provider, including `PAYMENT_WEBHOOK_SECRET`

`DEV_OTP_ECHO` must remain `false` in production. No provider, payment gateway, or SMS/email response is faked when credentials are absent: the API returns a clear configuration/provider error instead.

### Deploy on Render

`render.yaml` describes a web service. Add a managed MongoDB-compatible database and Redis, set the `sync: false` environment values in the Render dashboard, then deploy. Set `APP_ORIGIN` and `CORS_ORIGINS` to the final HTTPS public URL. The service listens on Render's injected `PORT`; it binds to `0.0.0.0`.

### Docker

```bash
cp .env.example .env
# populate .env with non-development credentials before using production mode
docker compose up --build
```

The Docker compose Mongo/Redis volumes are for local operations only. Use managed backups, TLS, monitoring, secret rotation, and a managed object store in production.

## Scripts

```bash
npm run typecheck
npm run build
npm run db:indexes  # after build, against the configured MongoDB
npm start
npm run dev
```

## Important supplier integration note

`src/providers.ts` is a deliberately narrow boundary for real supplier contracts. It uses the generic endpoints documented in `API.md`. If your flight/hotel/payment supplier uses a different payload or signature contract, update only that adapter, validate its sandbox flows, and keep user-facing payloads/provider secrets out of the browser.
