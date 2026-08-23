/**
 * One-time, opt-in cleanup of legacy feature data left by the removed modules
 * (flights/live-supplier search, visa services, eSIM, Umrah, medical tourism,
 * card/airline offers, marketing campaigns and customer segments).
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

const LEGACY_COLLECTIONS = [
  'campaigns', 'campaign_recipients', 'campaign_templates', 'customer_segments',
  'visa_applications'
];
const LEGACY_CATALOG_TYPES = [
  'esim', 'umrah_package', 'umrah_fare', 'medical_tourism', 'visa_service',
  'card_offer', 'airline_offer', 'flight_offer', 'accessory'
];
const LEGACY_CONTENT_TYPES = ['visa', 'esim', 'airline', 'umrah_fare', 'umrah_package', 'medical_tourism', 'card_offer', 'airline_offer', 'app'];
const LEGACY_SETTING_KEYS = ['travel_provider_url', 'travel_provider_api_key', 'esim_provider_url', 'esim_provider_api_key', 'feature_flights', 'feature_visa', 'feature_esim'];
const LEGACY_SERVICE_KEYS = ['flights', 'visa', 'esim'];

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
  if (existing.has('catalog_products')) {
    const r = await db.collection('catalog_products').deleteMany({ type: { $in: LEGACY_CATALOG_TYPES } });
    console.log(`catalog_products: removed ${r.deletedCount} legacy products`);
  }
  if (existing.has('content')) {
    const r = await db.collection('content').deleteMany({ type: { $in: LEGACY_CONTENT_TYPES } });
    console.log(`content: removed ${r.deletedCount} legacy content items`);
  }
  if (existing.has('settings')) {
    const r = await db.collection('settings').deleteMany({ id: { $in: LEGACY_SETTING_KEYS } });
    console.log(`settings: removed ${r.deletedCount} legacy settings`);
  }
  if (existing.has('services')) {
    const r = await db.collection('services').deleteMany({ id: { $in: LEGACY_SERVICE_KEYS } });
    console.log(`services: removed ${r.deletedCount} legacy service-visibility rows`);
  }
  if (existing.has('admin_navigation')) {
    const r = await db.collection('admin_navigation').deleteMany({
      route: { $regex: '^/admin/(flights|visa($|[/?])|esim|campaigns|customers/segments|catalog\\?type=(esim|umrah_package|umrah_fare|medical_tourism|visa_service|card_offer|airline_offer)|visa-applications|content\\?type=airline)' }
    });
    console.log(`admin_navigation: removed ${r.deletedCount} legacy navigation items`);
  }
  await mongoose.disconnect();
  console.log('Legacy cleanup complete.');
}

main().catch((error) => { console.error(error); process.exit(1); });
