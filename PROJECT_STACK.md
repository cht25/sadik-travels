# Sadik Travels Stack

## Runtime

- Node.js 20+
- Express 5
- TypeScript
- Vanilla HTML/CSS/JavaScript frontend
- SQLite using `better-sqlite3` with a Render persistent disk
- JWT access/refresh sessions
- HttpOnly cookies
- Zod validation
- Helmet security headers
- Pino request/error logging
- Nodemailer SMTP email delivery
- BulkSMSBD/custom SMS adapters
- Cloudinary REST media service for permanent image uploads
- Multer memory storage for bounded multipart processing only

## Single project layout

Frontend and backend intentionally run in one project. From the project root:

```powershell
npm run dev
```

The Express process serves:

- `/` — customer storefront
- `/admin` and `/admin/*` — routed admin console
- `/api/v1/*` — application API
- `/healthz` and `/api/health` — health checks
- `/readyz` and `/api/ready` — database readiness checks

## Database

SQLite is the only database layer in the current architecture. Tables are created or migrated additively in `src/store.ts`:

- users
- OTP challenges
- sessions
- bookings and booking events
- tours
- payments
- support tickets and support messages
- notifications
- customer notes
- content items
- media assets
- audit logs
- encrypted settings

No records are reset or wiped during startup. There are no demo users, tours, bookings, payments, tickets, notifications, or content seeded into the real database.

For Render:

```env
SQLITE_PATH=/var/data/sadik.sqlite
```

A persistent Render disk is required for business data to survive deploys and restarts.

## API client

Both storefront and admin load `api.js` and use `window.SadikApi.request(path, options)`. It provides:

- same-origin or configured API base handling
- HttpOnly cookie credentials
- refresh-session handling
- JSON and multipart form handling
- request timeouts
- consistent network/API errors

## Admin application

The admin is a routed single-page application with:

- responsive fixed sidebar and mobile drawer
- dashboard KPIs/charts/empty states
- booking lifecycle, claiming, assignment, notes and history
- customer directory and details
- payments and transaction history
- notifications and delivery history
- support conversations and assignment
- tour/content CRUD
- service visibility states: active, hidden, maintenance, archived
- Cloudinary media library
- encrypted integration settings
- admin roles and server-side permissions
- audit logs
- admin navigation configuration
- travel agents
- campaigns, templates, customer segments and campaign recipient queue

## Persistent media

Permanent uploads are handled by `src/media.ts`. It validates image magic bytes, permits JPEG/PNG/WEBP, limits memory-backed multipart uploads, uploads to Cloudinary folders under `sadik-travels/`, stores metadata in `media_assets`, and performs safe replace/archive operations. `CLOUDINARY_API_SECRET` is never sent to browser code or stored in SQLite.

## Render

`render.yaml` configures one Node web service:

```text
Build: npm ci --include=dev && npm run build
Start: npm start
Health: /healthz
```

Production requires strong JWT/settings secrets, HTTPS cookie/origin configuration, the Render SQLite disk, and Cloudinary credentials for persistent media.

## Degraded external services

Travel inventory, payment gateways, SMS, SMTP, and Cloudinary are real provider integrations. If credentials are absent or a provider times out, the API returns a controlled unavailable/error response; the application does not generate fake inventory, fake delivery, fake payment success, or fake upload records.
