/**
 * Frontend hotel-image selector tests.
 *
 * The helpers are loaded VERBATIM out of the shipped `app.js` (the block
 * between the SADIK-HOTEL-IMAGES markers) and executed in a VM, so these tests
 * exercise the real public-site code rather than a copy of it. They pin the
 * contract the bug report asks for:
 *
 *  1. a valid uploaded image is always found, whichever field it was stored in;
 *  2. the primary photo is used first on cards, search results and the hero;
 *  3. legacy records keep working;
 *  4. "Photos coming soon" is a data state — it can only be reached when the
 *     record genuinely has no loadable image, never because the frontend read
 *     the wrong field.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const appSource = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const BEGIN = '/* ==== SADIK-HOTEL-IMAGES:BEGIN';
const END = '/* ==== SADIK-HOTEL-IMAGES:END';

test('app.js still ships the canonical hotel image helper block', () => {
  const start = appSource.indexOf(BEGIN);
  const end = appSource.indexOf(END);
  assert.ok(start > -1, 'SADIK-HOTEL-IMAGES:BEGIN marker missing from app.js');
  assert.ok(end > start, 'SADIK-HOTEL-IMAGES:END marker missing from app.js');
});

function loadHotelImageHelpers() {
  const start = appSource.indexOf(BEGIN);
  const end = appSource.indexOf(END);
  const block = appSource.slice(start, end);
  const sandbox: any = { document: { addEventListener() { /* capture-phase safety net */ } } };
  vm.createContext(sandbox);
  vm.runInContext(`${block}\n;this.api = { hotelImageList, getHotelPrimaryImage, hotelImageSrc, hotelHasRealImage, hotelImageTag, hotelImageEntryOf, HOTEL_PLACEHOLDER };`, sandbox);
  return sandbox.api;
}

const helpers = loadHotelImageHelpers();
const { hotelImageList, getHotelPrimaryImage, hotelImageSrc, hotelHasRealImage, hotelImageTag, HOTEL_PLACEHOLDER } = helpers;

const COX_TODAY = {
  name: 'Hotel The Cox Today',
  images: [
    { url: 'https://res.cloudinary.com/sadik/image/upload/v1/hotels/a.jpg', displayUrl: 'https://res.cloudinary.com/sadik/image/upload/f_auto,q_auto,w_1280,c_limit/v1/hotels/a.jpg', alt: 'Facade', isPrimary: true },
    { url: 'https://res.cloudinary.com/sadik/image/upload/v1/hotels/b.jpg', alt: 'Pool' }
  ]
};

test('frontend: an uploaded photo is found and rendered (never the "coming soon" state)', () => {
  assert.equal(hotelHasRealImage(COX_TODAY), true);
  const primary = getHotelPrimaryImage(COX_TODAY);
  assert.ok(primary, 'a hotel with images must resolve a primary photo');
  assert.equal(primary!.url, 'https://res.cloudinary.com/sadik/image/upload/v1/hotels/a.jpg');
  // The hero renders the responsive variant when the API provides one.
  assert.match(hotelImageSrc(COX_TODAY), /w_1280/);
  const tag = hotelImageTag(hotelImageSrc(COX_TODAY), COX_TODAY.name);
  assert.match(tag, /<img /);
  assert.match(tag, /src="https:\/\/res\.cloudinary\.com/);
  assert.doesNotMatch(tag, /hotel-placeholder/);
  assert.doesNotMatch(tag, /onerror=/, 'inline onerror is refused by the production CSP');
});

test('frontend: the primary photo is first even when it is not stored first', () => {
  const hotel = {
    images: [
      { url: 'https://res.cloudinary.com/sadik/image/upload/v1/x.jpg' },
      { url: 'https://res.cloudinary.com/sadik/image/upload/v1/cover.jpg', isPrimary: true }
    ]
  };
  assert.equal(hotelImageSrc(hotel), 'https://res.cloudinary.com/sadik/image/upload/v1/cover.jpg');
  const list = hotelImageList(hotel);
  assert.equal(list.length, 2);
  assert.equal(list[0].isPrimary, true);
  assert.equal(list[1].isPrimary, false);
});

test('frontend: legacy records keep working (imageUrl / image / coverImage / heroImage / thumbnail)', () => {
  for (const [key, value] of Object.entries({
    imageUrl: 'https://res.cloudinary.com/sadik/image/upload/legacy.jpg',
    image: 'https://res.cloudinary.com/sadik/image/upload/legacy.jpg',
    coverImage: 'https://res.cloudinary.com/sadik/image/upload/legacy.jpg',
    heroImage: 'https://res.cloudinary.com/sadik/image/upload/legacy.jpg',
    thumbnail: 'https://res.cloudinary.com/sadik/image/upload/legacy.jpg'
  })) {
    assert.equal(hotelHasRealImage({ [key]: value }), true, `${key} must still render`);
    assert.equal(hotelImageSrc({ [key]: value }), 'https://res.cloudinary.com/sadik/image/upload/legacy.jpg');
  }
  // Plain-string galleries from very old rows.
  assert.equal(hotelImageSrc({ images: ['https://res.cloudinary.com/sadik/image/upload/old.jpg'] }), 'https://res.cloudinary.com/sadik/image/upload/old.jpg');
  assert.equal(hotelImageSrc({ images: [{ secureUrl: 'https://res.cloudinary.com/sadik/image/upload/old2.jpg' }] }), 'https://res.cloudinary.com/sadik/image/upload/old2.jpg');
});

test('frontend: "Photos coming soon" is reachable only when there is genuinely no image', () => {
  for (const empty of [
    {},
    { images: [] },
    { images: [{ url: '' }, { url: '   ' }, null, 'not-a-url'] },
    { images: [{}] },
    { thumbnail: '' },
    null,
    undefined
  ]) {
    assert.equal(hotelHasRealImage(empty), false, `${JSON.stringify(empty)} must fall back`);
    assert.equal(hotelImageSrc(empty), '');
    assert.equal(getHotelPrimaryImage(empty), null);
  }
  const tag = hotelImageTag('', 'Hotel The Cox Today');
  assert.match(tag, /hotel-placeholder/, 'the branded placeholder is used, never a broken <img>');
});

test('frontend: entries that cannot be loaded by an <img> are rejected', () => {
  assert.equal(hotelHasRealImage({ images: [{ url: 'asset-7f2c' }] }), false);
  assert.equal(hotelHasRealImage({ imageUrl: 'C:\\fakepath\\photo.jpg' }), false);
  // Same-origin relative paths and data URLs are legitimately loadable.
  assert.equal(hotelHasRealImage({ images: [{ url: '/uploads/local.jpg' }] }), true);
  assert.equal(hotelHasRealImage({ images: [{ url: 'data:image/png;base64,AAAA' }] }), true);
});

test('frontend: duplicate photos are collapsed so the gallery count is honest', () => {
  const url = 'https://res.cloudinary.com/sadik/image/upload/v1/dup.jpg';
  const hotel = { images: [{ url }, url, { secureUrl: url }], thumbnail: url };
  assert.equal(hotelImageList(hotel).length, 1);
});

test('frontend: hotelImageTag escapes and prefers the display variant', () => {
  const tag = hotelImageTag('https://res.cloudinary.com/sadik/image/upload/v1/a.jpg?a=1&b=2', 'A "quoted" <name>');
  assert.match(tag, /&amp;b=2/);
  assert.match(tag, /&quot;quoted&quot;/);
  assert.match(tag, /data-image-fallback/);
  assert.equal(HOTEL_PLACEHOLDER, '/assets/hotel-placeholder.svg');
  assert.doesNotMatch(tag, /hotel-placeholder/);
});
