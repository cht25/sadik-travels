/**
 * One-off QA cleanup for the sandbox database: removes every fixture, seeded
 * demo row and automated-test artifact (hotels, rooms, inventory, catalog
 * products, orders, invoices, carts, payments, bookings, test customers and
 * their sessions/notifications) so the dev environment is left with only real
 * brand + admin bootstrap data.
 *
 * Run: node scripts/cleanup-qa-data.mjs
 * (not wired into npm scripts — deliberately manual)
 */
import mongoose from 'mongoose';

const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/sadik_travels_test';
const dropped = {};

await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
const db = mongoose.connection.db;
const wipe = async (name) => {
  try {
    const result = await db.collection(name).deleteMany({});
    if (result.deletedCount) dropped[name] = result.deletedCount;
  } catch { /* collection does not exist */ }
};

// Marketplace + hotel test data
for (const col of ['catalog_products', 'carts', 'wishlist_items', 'orders', 'invoices', 'room_inventory', 'hotel_bookings', 'hotel_rooms', 'hotels', 'payment', 'booking', 'booking-event', 'ticket', 'support-message']) {
  await wipe(col);
}

// Test customers + their sessions/otp/notifications/customer notes
const users = await db.collection('users').find({ role: 'customer' }).project({ id: 1 }).toArray();
const customerIds = users.map(u => u.id);
if (customerIds.length) {
  await db.collection('session').deleteMany({ userId: { $in: customerIds } });
  await db.collection('otp').deleteMany({});
  await db.collection('notification').deleteMany({ userId: { $in: customerIds } });
  await db.collection('customer-note').deleteMany({ userId: { $in: customerIds } });
  const res = await db.collection('users').deleteMany({ _id: { $in: users.map(u => u._id) } });
  dropped.users = res.deletedCount;
}

console.log('Removed QA/fixture data:', JSON.stringify(dropped, null, 2));
await mongoose.disconnect();
