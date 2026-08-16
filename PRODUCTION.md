# Production activation checklist

Sadik Travels refuses to boot in production with in-memory data, development OTP echoes, insecure cookies, missing Redis, missing persistent media storage, or absent live-provider settings. Do not bypass these checks.

## 1. Database and resilience

- Use a managed MongoDB-compatible cluster with TLS, backups, point-in-time recovery, and a dedicated application account. Set `DATA_MODE=mongodb` and `MONGODB_URI`.
- Use managed Redis for distributed rate limiting (`REDIS_URL`).
- Run `npm run build && npm run db:indexes` once against the target database before the first traffic cutover. The application queries CMS content by `(type, status, sortOrder, createdAt)`, identity, and session/OTP IDs.
- Schedule backup/restore tests and retention reviews. Never use Docker's local Mongo volume as a production backup plan.

## 2. Security and identity

- Set an independently generated 32+ character `JWT_SECRET`; rotate it according to your incident policy.
- Set `APP_ORIGIN` and explicit comma-separated `CORS_ORIGINS` to final HTTPS origins only.
- Set `TRUST_PROXY=true`, `COOKIE_SECURE=true`, and a deliberate `COOKIE_SAMESITE` value. If the public web and API origins differ, plan the cross-site cookie policy before release.
- Populate `ADMIN_IDENTITIES` with real normalized manager/admin identities. There are no seeded credentials.
- Confirm `DEV_OTP_ECHO=false`.
- Configure BulkSMSBD sender approval and SMTP credentials. Verify OTP delivery, expiration, throttling, account blocking, and identity-change verification with real devices.
- Review admin audit records and restrict Render/dashboard access to trusted operators.

## 3. Persistent images

- Configure Cloudinary with `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET`.
- Upload from `/admin`; the API validates MIME type, size, and returns a Cloudinary HTTPS URL. It never treats the Render filesystem as persistent media storage.
- Verify transformed URLs, deletion, CDN cache invalidation, and Cloudinary access controls for your account.

## 4. Supplier and payment activation

- Set the live travel supplier endpoint/key and map its exact search, reservation, cancellation, quote, and error contracts in `src/providers.ts`.
- The supplier reservation response must return a trusted quoted amount/currency (`quotedAmount`/`quotedCurrency`, `amount`/`currency`, or `total.amount`/`total.currency`) before a payment intent can be created.
- Set payment endpoint/key/webhook secret. Register the HTTPS `/api/v1/payments/webhook` URL with the gateway and verify HMAC signature behavior against sandbox fixtures.
- Test declined, timeout, duplicate webhook, refund, cancellation, reconciliation, invoice/tax, and provider-outage paths before accepting money.
- The CMS messaging facility sends genuine SMS/email only when its configured provider accepts the message. Review delivery failures and provider rate limits.

## 5. Content and CMS handover

- Sign in to `/admin` with an allowlisted account.
- Add and publish website settings, contact information, homepage content, banners, package/content records, and navigation. No demo catalogue is preloaded.
- Add agency details in Travel Agent **Additional details** (`company`, `phone`, `email`, `address`) and check each public profile URL.
- Create and preview templates. Run an in-app-only test campaign before enabling SMS/email channels.
- Confirm the archive/restore lifecycle, super-admin permanent delete policy, role management, and all navigation links.

## 6. Render release checks

- Use the provided `render.yaml` as a starting point, then populate every `sync: false` secret/value in Render's dashboard.
- Ensure health checks pass at `/healthz` and dependencies pass `/readyz`.
- Check final browser network traffic for mixed content, CORS denial, CSP violations, failed Cloudinary images, and no `localhost` references.
- Set alerts for 5xx rate, dependency readiness, Redis/Mongo errors, provider failures, and Cloudinary delivery errors.

## Mandatory end-to-end sign-off

Before declaring the site production-ready, test against **staging credentials**:

1. OTP sign-in and sign-out; expired/incorrect/throttled OTPs.
2. Admin login restriction, CMS create/publish/archive/restore/reorder/delete, and public publication visibility.
3. Cloudinary upload/delete and image persistence through a deploy/restart.
4. Agent card → agent profile; every public navigation route; 320px through desktop layouts.
5. Contact ticket, notification, template campaign with in-app/SMS/email, delivery failures.
6. Live supplier search/reservation/cancel, price quote locking, payment redirect, signed webhooks, failures/refunds.
7. Mongo backup restore and a rolling deployment with no content loss.
