/**
 * Hotel image pipeline tests (no database required).
 *
 * These cover the exact functions the production request path runs:
 *  - `canonicalMediaUrl` / `optimizedMediaUrl` (src/media.ts) — the Cloudinary
 *    URL contract between storage, API responses and the editor.
 *  - `normalizeHotelImages` / `hotelDisplayImages` / `primaryImageUrl`
 *    (src/hotel-store.ts) — the single choke point applied on every save and
 *    every read.
 *  - `imageSchema` / `hotelInputSchema` (src/hotel-routes.ts) — the exact
 *    validation the admin upload POSTs are parsed with.
 *
 * The regression that made uploaded hotel photos disappear behind
 * "Photos coming soon" was a URL round trip: the API handed the editor a
 * display-optimized Cloudinary URL, the editor posted it straight back, and the
 * store persisted it — chaining another transformation into the stored URL on
 * every save until the record could no longer be written or read back.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalMediaUrl, optimizedMediaUrl } from './media.js';
import { hotelDisplayImages, normalizeHotelImages, primaryImageUrl } from './hotel-store.js';
import { hotelInputSchema, imageSchema } from './hotel-routes.js';

const CANONICAL = 'https://res.cloudinary.com/sadik-travels/image/upload/v1730000000/sadik-travels/hotels/asset-7f2c.jpg';

test('hotel images: legacy plain-string rows are normalized to {url} objects', () => {
  const result = normalizeHotelImages(['https://res.cloudinary.com/demo/image/upload/sample.jpg', { url: 'https://res.cloudinary.com/demo/image/upload/second.jpg', publicId: 'demo/second', alt: 'Second' }]) as any[];
  assert.equal(result.length, 2);
  assert.equal(result[0].url, 'https://res.cloudinary.com/demo/image/upload/sample.jpg');
  assert.equal(result[1].publicId, 'demo/second');
  assert.equal(result[1].alt, 'Second');
});

test('hotel images: insecure http:// URLs are upgraded to https://', () => {
  const result = normalizeHotelImages([{ url: 'http://res.cloudinary.com/demo/image/upload/insecure.jpg' }]) as any[];
  assert.equal(result[0].url, 'https://res.cloudinary.com/demo/image/upload/insecure.jpg');
});

test('hotel images: empty, whitespace and non-URL entries are dropped', () => {
  const result = normalizeHotelImages([
    { url: '' },
    { url: '   ' },
    'not-a-url',
    { url: undefined },
    null,
    { url: '/uploads/local-file.jpg' }
  ]) as any[];
  assert.equal(result.length, 1, 'only the relative /uploads path survives (browser-accessible same-origin)');
  assert.equal(result[0].url, '/uploads/local-file.jpg');
});

test('hotel images: non-array input yields an empty array instead of crashing', () => {
  assert.deepEqual(normalizeHotelImages(undefined), []);
  assert.deepEqual(normalizeHotelImages(null), []);
  assert.deepEqual(normalizeHotelImages('https://example.com/x.jpg'), []);
});

test('hotel images: alt text is trimmed and length-capped', () => {
  const result = normalizeHotelImages([{ url: 'https://res.cloudinary.com/demo/image/upload/x.jpg', alt: `${'x'.repeat(400)}` }]) as any[];
  assert.equal(result[0].alt.length, 300);
});

test('media: canonicalMediaUrl strips chained Cloudinary transformations but keeps the version', () => {
  assert.equal(canonicalMediaUrl(CANONICAL), CANONICAL);
  const once = optimizedMediaUrl(CANONICAL, { width: 200 })!;
  assert.equal(once, 'https://res.cloudinary.com/sadik-travels/image/upload/f_auto,q_auto,w_200,c_limit/v1730000000/sadik-travels/hotels/asset-7f2c.jpg');
  assert.equal(canonicalMediaUrl(once), CANONICAL);
  // Already-corrupted rows: several chained segments collapse back to canonical.
  const thrice = optimizedMediaUrl(optimizedMediaUrl(once, { width: 600 })!, { width: 1280 })!;
  assert.equal(canonicalMediaUrl(thrice), CANONICAL);
});

test('media: optimizedMediaUrl is idempotent — repeated reads never grow the stored URL', () => {
  let url = CANONICAL;
  const lengths = new Set<number>();
  for (let round = 0; round < 40; round += 1) {
    url = optimizedMediaUrl(url, { width: 600 })!;
    lengths.add(url.length);
  }
  assert.equal(lengths.size, 1, `URL length must be stable, saw ${[...lengths].join(', ')}`);
  assert.ok(url.length < 200, `optimized URL should stay short, got ${url.length}`);
});

test('hotel images: a display URL posted back by an editor is healed to the canonical URL', () => {
  // This is the exact round trip that used to corrupt stored records: the API
  // response carries displayUrl, a client stores it, and the next save must
  // still land on the canonical URL.
  const display = hotelDisplayImages([{ url: CANONICAL, publicId: 'sadik-travels/hotels/asset-7f2c', alt: 'Facade' }], 200)[0];
  assert.notEqual(display.displayUrl, display.url);
  assert.equal(display.url, CANONICAL, 'canonical url must never carry display transformations');
  const healed = normalizeHotelImages([{ url: display.displayUrl, publicId: display.publicId, alt: display.alt }]);
  assert.equal(healed.length, 1);
  assert.equal(healed[0].url, CANONICAL);
  assert.equal(healed[0].publicId, 'sadik-travels/hotels/asset-7f2c');
});

test('hotel images: save/read round trip is a fixed point', () => {
  const stored = normalizeHotelImages([
    { url: CANONICAL, publicId: 'a', alt: 'Facade', isPrimary: true },
    'https://res.cloudinary.com/demo/image/upload/samples/landscape.jpg'
  ]);
  for (let round = 0; round < 5; round += 1) {
    const apiView = hotelDisplayImages(stored, 600);
    const resaved = normalizeHotelImages(apiView.map(image => ({ url: image.url, publicId: image.publicId, alt: image.alt, isPrimary: image.isPrimary })));
    assert.deepEqual(resaved, stored, `round ${round} changed the stored record`);
  }
});

test('hotel images: the primary photo always lands at index 0 and only once', () => {
  const result = normalizeHotelImages([
    { url: 'https://res.cloudinary.com/demo/image/upload/a.jpg' },
    { url: 'https://res.cloudinary.com/demo/image/upload/b.jpg', isPrimary: true },
    { url: 'https://res.cloudinary.com/demo/image/upload/c.jpg' }
  ]) as any[];
  assert.equal(result[0].url, 'https://res.cloudinary.com/demo/image/upload/b.jpg');
  assert.equal(result[0].isPrimary, true);
  assert.deepEqual(result.slice(1).map(image => image.isPrimary), [undefined, undefined]);
  assert.equal(primaryImageUrl(result), 'https://res.cloudinary.com/demo/image/upload/b.jpg');
});

test('hotel images: duplicate URLs are collapsed', () => {
  const result = normalizeHotelImages([
    { url: CANONICAL },
    CANONICAL,
    { secureUrl: optimizedMediaUrl(CANONICAL, { width: 400 }) }
  ]) as any[];
  assert.equal(result.length, 1);
  assert.equal(result[0].url, CANONICAL);
});

test('hotel images: legacy field names still resolve (imageUrl / secureUrl / src / image_url)', () => {
  for (const key of ['secureUrl', 'secure_url', 'imageUrl', 'image_url', 'src', 'path', 'image']) {
    const result = normalizeHotelImages([{ [key]: 'https://res.cloudinary.com/demo/image/upload/legacy.jpg' }]) as any[];
    assert.equal(result.length, 1, `${key} must still be readable`);
    assert.equal(result[0].url, 'https://res.cloudinary.com/demo/image/upload/legacy.jpg');
  }
});

test('hotel images: hotelDisplayImages keeps the canonical url and adds displayUrl', () => {
  const images = hotelDisplayImages([{ url: CANONICAL, alt: 'Facade' }], 600);
  assert.equal(images.length, 1);
  assert.equal(images[0].url, CANONICAL);
  assert.match(images[0].displayUrl, /\/upload\/f_auto,q_auto,w_600,c_limit\/v1730000000\//);
});

test('hotel API schema: the exact admin payload is accepted and canonicalized', () => {
  // This is what admin.js posts after an upload: { url, publicId, mediaId, alt }.
  const parsed: any = hotelInputSchema.partial().parse({
    name: 'Hotel The Cox Today',
    slug: 'hotel-the-cox-today',
    images: [
      { url: CANONICAL, publicId: 'sadik-travels/hotels/asset-7f2c', mediaId: '2b7f2f3e-0b5f-4d0e-9b3e-8c1f6f7d1a11', alt: 'Hotel The Cox Today', isPrimary: true },
      { secureUrl: 'http://res.cloudinary.com/demo/image/upload/second.jpg', alt: 'Second' }
    ]
  });
  assert.equal(parsed.images.length, 2);
  assert.equal(parsed.images[0].url, CANONICAL);
  assert.equal(parsed.images[0].isPrimary, true);
  assert.equal(parsed.images[1].url, 'https://res.cloudinary.com/demo/image/upload/second.jpg');
  // The store must agree with what the API accepted, otherwise the
  // post-save persistence check would report a false failure.
  assert.deepEqual(normalizeHotelImages(parsed.images).map(image => image.url), [CANONICAL, 'https://res.cloudinary.com/demo/image/upload/second.jpg']);
});

test('hotel API schema: an image without a usable URL is rejected, never silently stored', () => {
  const result = imageSchema.safeParse({ url: '   ' });
  assert.equal(result.success, false);
  assert.equal(result.error?.issues[0]?.message, 'Image URL is required');
});

test('hotel API schema: an omitted images field stays omitted so a partial save cannot wipe photos', () => {
  const parsed: any = hotelInputSchema.partial().parse({ name: 'Hotel The Cox Today' });
  assert.equal('images' in parsed, false, 'absent images must not be present as undefined');
});

test('hotel API schema: a long legacy URL is still accepted and canonicalized short', () => {
  let corrupted = CANONICAL;
  for (let round = 0; round < 30; round += 1) corrupted = optimizedMediaUrl(corrupted, { width: 200 })!;
  const parsed: any = hotelInputSchema.partial().parse({ images: [{ url: corrupted }] });
  assert.equal(parsed.images[0].url, CANONICAL);
  assert.ok(parsed.images[0].url.length < 200);
});
