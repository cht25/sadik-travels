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

The Mongo repository stores typed entities with stable UUIDs in `sadik_entities`. Data is indexed by entity kind, ID, status, user ownership, update time, and slug. Domain types include users, OTP challenges, sessions, bookings, booking events, tours, payments, tickets, ticket messages, notifications, settings, content, media metadata, admin navigation, travel agents, campaign templates, segments, campaigns, recipients, notes, and audit logs.

This preserves the existing API contract while removing all SQLite-specific SQL, filesystem initialization, and disk persistence assumptions.

## Media

Cloudinary is accessed only by the backend. Uploads are validated from file bytes, limited in memory, stored in an organized Sadik Travels folder, and represented in MongoDB by media metadata. No Cloudinary secret is returned to browser code.

## Testing

`TEST_MONGODB_URI` runs the integration suite against a dedicated disposable MongoDB database. Do not point it to a production database.
