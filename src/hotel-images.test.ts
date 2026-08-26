/**
 * Hotel image pipeline unit tests (no database required).
 * normalizeHotelImages is the single choke point that repairs the historic
 * causes of missing hotel images: plain-string rows, http:// URLs that the
 * production CSP/browser block on HTTPS, and empty/invalid entries that used
 * to render as <img src=""> broken containers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHotelImages } from './hotel-store.js';

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
