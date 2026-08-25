import mongoose from 'mongoose';

/**
 * Single source of truth for retired verticals and the hard purge that removes
 * their persisted records.
 *
 * Background: verticals such as the Umrah fare/package pages ("Special Umrah
 * Fair"), flights, visa, eSIM and medical tourism were deleted from the source
 * tree in earlier refactors, but deployments that ran those versions still hold
 * their rows in MongoDB (`admin_navigation`, `catalog_products`,
 * `content_items`, `service_visibility`). Because the data outlived the code,
 * the admin sidebar kept rendering the items on every boot.
 *
 * This module fixes that at the root in two complementary layers:
 *
 *   1. `purgeRetiredData()` deletes the underlying records. It runs
 *      automatically on every startup, so the item cannot survive a refresh,
 *      restart, redeploy, database reload or reseed.
 *   2. The exported allowlists/predicates are applied on every read path, so a
 *      retired record can never be rendered or served by an API even if one is
 *      reintroduced between purges.
 *
 * Shared data (users, bookings, payments, hotels, tours, holiday packages,
 * homes, destinations, carts, wishlists, orders, coupons, reviews, tickets,
 * notifications, media, settings, audit logs) is never touched.
 */

/** Catalogue product types that are still sold. Anything else is retired. */
export const ACTIVE_CATALOG_TYPES = ['holiday_package', 'home', 'destination'] as const;

/** Website content types that are still editable. */
export const ACTIVE_CONTENT_TYPES = [
  'homepage', 'destination', 'hotel', 'home', 'offer', 'banner', 'faq', 'company', 'holiday_package', 'explore'
] as const;

/** Service-visibility rows that are still offered. */
export const ACTIVE_SERVICE_KEYS = ['hotels', 'homes', 'tours'] as const;

/**
 * Product/content `type` discriminators of removed verticals. `umrah_fare` and
 * `umrah_package` are the records behind the "Special Umrah Fair" entry.
 */
export const RETIRED_VERTICAL_TYPES = [
  'umrah_fare', 'umrah_package', 'umrah', 'esim', 'medical_tourism', 'visa', 'visa_service',
  'card_offer', 'airline_offer', 'airline', 'flight_offer', 'flight', 'accessory', 'app'
] as const;

/** Admin sidebar base routes of removed modules. */
export const RETIRED_ADMIN_NAV_ROUTES = new Set([
  '/admin/audit-logs',
  '/admin/users',
  '/admin/campaigns',
  '/admin/campaign-templates',
  '/admin/campaigns/templates',
  '/admin/segments',
  '/admin/customers/segments',
  '/admin/visa-applications',
  '/admin/flights',
  '/admin/visa',
  '/admin/esim',
  '/admin/explore',
  '/admin/umrah',
  '/admin/umrah-fair',
  '/admin/umrah-fare',
  '/admin/umrah-packages'
]);

const retiredTypeSet = new Set<string>(RETIRED_VERTICAL_TYPES);

/**
 * Labels of removed modules, matched case-insensitively and ignoring spacing or
 * punctuation, so "Special Umrah Fair", "special umrah fare" and "Umrah-Fair"
 * are all recognised regardless of the spelling used by the old deployment.
 */
const RETIRED_NAV_LABEL_PATTERN = /umrah|medical\s*tourism|e-?sim|visa|flight|card\s*offer|airline\s*offer/i;

/**
 * True when a persisted admin navigation row belongs to a removed vertical.
 *
 * Checks the base path, the `?type=` discriminator (the "Special Umrah Fair"
 * row is `/admin/catalog?type=umrah_fare`, whose base path `/admin/catalog` is
 * still a live route) and the stored label.
 */
export function isRetiredAdminNavItem(item: { route?: string; label?: string } | null | undefined): boolean {
  if (!item) return false;
  const route = String(item.route || '');
  const [basePath, queryString = ''] = route.split('?');
  if (RETIRED_ADMIN_NAV_ROUTES.has(basePath)) return true;

  const type = new URLSearchParams(queryString).get('type');
  if (type && retiredTypeSet.has(type)) return true;

  // Catch legacy slugs embedded in the path, e.g. /admin/catalog/umrah-fare.
  if (/(^|\/)umrah([/_-]|$)/i.test(basePath)) return true;

  return RETIRED_NAV_LABEL_PATTERN.test(String(item.label || ''));
}

const collectionNames = async (db: mongoose.mongo.Db) =>
  new Set((await db.listCollections().toArray()).map((entry) => entry.name));

/**
 * Deletes the persisted records of removed verticals. Idempotent: a second run
 * finds nothing to delete. Returns a per-collection count of removed documents.
 */
export async function purgeRetiredData(): Promise<Record<string, number>> {
  const db = mongoose.connection.db;
  if (!db) return {};
  const removed: Record<string, number> = {};
  const existing = await collectionNames(db);

  if (existing.has('admin_navigation')) {
    const rows = await db.collection('admin_navigation')
      .find({}, { projection: { _id: 1, route: 1, label: 1 } }).toArray();
    const doomed = rows.filter((row) => isRetiredAdminNavItem(row as { route?: string; label?: string }));
    if (doomed.length) {
      const result = await db.collection('admin_navigation')
        .deleteMany({ _id: { $in: doomed.map((row) => row._id) } });
      if (result.deletedCount) removed.admin_navigation = result.deletedCount;
    }
  }

  if (existing.has('catalog_products')) {
    const result = await db.collection('catalog_products')
      .deleteMany({ type: { $in: [...RETIRED_VERTICAL_TYPES] } });
    if (result.deletedCount) removed.catalog_products = result.deletedCount;
  }

  if (existing.has('content_items')) {
    const result = await db.collection('content_items')
      .deleteMany({ type: { $in: [...RETIRED_VERTICAL_TYPES] } });
    if (result.deletedCount) removed.content_items = result.deletedCount;
  }

  if (existing.has('service_visibility')) {
    const result = await db.collection('service_visibility')
      .deleteMany({ key: { $nin: [...ACTIVE_SERVICE_KEYS] } });
    if (result.deletedCount) removed.service_visibility = result.deletedCount;
  }

  return removed;
}
