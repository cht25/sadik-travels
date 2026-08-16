/*
 * One-time migration utility for a legacy Sadik Travels SQLite database.
 * It is deliberately not imported by the running web service.
 *
 * Usage:
 *   npm install --no-save better-sqlite3
 *   MONGODB_URI='mongodb+srv://…' LEGACY_SQLITE_PATH=/path/to/sadik.sqlite npx tsx src/migrate-sqlite-to-mongo.ts
 *
 * Use a MongoDB backup and run this against a staging Atlas database first.
 */
import { createRequire } from 'node:module';
import mongoose from 'mongoose';
import { connectMongo } from './store.js';

const legacyPath = process.env.LEGACY_SQLITE_PATH;
if (!legacyPath) throw new Error('LEGACY_SQLITE_PATH must point to the legacy SQLite database');

const require = createRequire(import.meta.url);
let Database: any;
try { Database = require('better-sqlite3'); }
catch { throw new Error('Install the one-time migration reader first: npm install --no-save better-sqlite3'); }

const TABLES: Record<string, string> = {
  users: 'users', otp_challenges: 'otp_challenges', sessions: 'sessions', bookings: 'bookings', booking_events: 'booking_events',
  tours: 'tours', payments: 'payments', support_tickets: 'support_tickets', support_messages: 'support_messages', notifications: 'notifications',
  settings: 'settings', content_items: 'content_items', media_assets: 'media_assets', admin_navigation: 'admin_navigation', travel_agents: 'travel_agents',
  campaign_templates: 'campaign_templates', customer_segments: 'customer_segments', campaigns: 'campaigns', campaign_recipients: 'campaign_recipients',
  customer_notes: 'customer_notes', audit_logs: 'audit_logs'
};
const JSON_COLUMNS = new Set(['destinations', 'metadata', 'request', 'response', 'provider_payload', 'channels', 'recipient_filter', 'rules']);
const BOOLEAN_COLUMNS = new Set(['featured', 'visible', 'enabled', 'internal', 'is_secret', 'marketing_email_opt_in', 'marketing_sms_opt_in', 'marketing_in_app_opt_in']);

const camel = (key: string) => key.replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase());
function value(table: string, key: string, input: unknown) {
  if (input === null || input === undefined) return undefined;
  if (JSON_COLUMNS.has(key) && typeof input === 'string') { try { return JSON.parse(input); } catch { return {}; } }
  if (BOOLEAN_COLUMNS.has(key)) return Boolean(input);
  if (table === 'audit_logs' && key === 'id') return String(input);
  return input;
}
function convert(table: string, row: Record<string, unknown>) {
  const data: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(row)) data[camel(key)] = value(table, key, raw);
  if (table === 'settings') { data.id = data.key; delete data.key; }
  if (table === 'admin_navigation') { data.groupName ??= 'General'; }
  if (table === 'support_tickets') { data.priority ??= 'normal'; }
  return Object.fromEntries(Object.entries(data).filter(([, item]) => item !== undefined));
}

const db = new Database(legacyPath, { readonly: true, fileMustExist: true });
await connectMongo();
try {
  for (const [table, collection] of Object.entries(TABLES)) {
    const rows = db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
    if (!rows.length) { console.log(`${table}: 0 records`); continue; }
    const target = mongoose.connection.collection(collection);
    const operations = rows.map(row => {
      const document = convert(table, row);
      if (!document.id) throw new Error(`${table} contains a row without an id`);
      return { updateOne: { filter: { id: document.id }, update: { $set: document }, upsert: true } };
    });
    const result = await target.bulkWrite(operations, { ordered: false });
    console.log(`${table}: ${rows.length} read, ${result.upsertedCount} inserted, ${result.modifiedCount} updated`);
  }
  console.log('Legacy SQLite migration completed. Verify record counts in MongoDB before retiring the old database.');
} finally {
  db.close();
  await mongoose.disconnect();
}
