/**
 * Manual, opt-in cleanup of legacy feature data left by the removed modules
 * (flights/live-supplier search, visa services, eSIM, Umrah fare/package pages,
 * medical tourism, card/airline offers, marketing campaigns and customer
 * segments).
 *
 * The same purge now also runs automatically on every application start (see
 * `legacy-purge.ts`), so this script is only needed to additionally drop whole
 * legacy collections that the runtime no longer references at all.
 *
 * It NEVER touches shared data (users, bookings, payments, hotels, tours,
 * holiday packages, homes, destinations, carts, wishlists, orders, coupons,
 * reviews, support tickets, notifications, media, settings, audit logs).
 *
 * Usage (run manually against your database AFTER taking a backup):
 *   MONGODB_URI='mongodb+srv://…' CONFIRM_LEGACY_CLEANUP=yes npm run cleanup:legacy
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { purgeRetiredData } from './legacy-purge.js';

/** Collections that belong exclusively to removed modules. */
const LEGACY_COLLECTIONS = [
  'campaigns', 'campaign_recipients', 'campaign_templates', 'customer_segments',
  'visa_applications'
];

/** Settings rows that only configured removed modules. */
const LEGACY_SETTING_KEYS = [
  'travel_provider_url', 'travel_provider_api_key', 'esim_provider_url', 'esim_provider_api_key',
  'feature_flights', 'feature_visa', 'feature_esim'
];

async function main() {
  if (process.env.CONFIRM_LEGACY_CLEANUP !== 'yes') {
    console.error('Refusing to run: set CONFIRM_LEGACY_CLEANUP=yes after taking a database backup.');
    process.exit(1);
  }
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error('MONGODB_URI is required'); process.exit(1); }
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
  const db = mongoose.connection.db!;
  const existing = new Set((await db.listCollections().toArray()).map((c) => c.name));

  for (const name of LEGACY_COLLECTIONS) {
    if (existing.has(name)) { await db.dropCollection(name); console.log(`dropped collection ${name}`); }
  }

  // Removes retired navigation rows, catalogue products, content items and
  // service-visibility rows from the collections the runtime actually uses.
  const removed = await purgeRetiredData();
  for (const [collection, count] of Object.entries(removed)) {
    console.log(`${collection}: removed ${count} legacy record(s)`);
  }

  if (existing.has('settings')) {
    const r = await db.collection('settings').deleteMany({ id: { $in: LEGACY_SETTING_KEYS } });
    console.log(`settings: removed ${r.deletedCount} legacy settings`);
  }

  await mongoose.disconnect();
  console.log('Legacy cleanup complete.');
}

main().catch((error) => { console.error(error); process.exit(1); });
