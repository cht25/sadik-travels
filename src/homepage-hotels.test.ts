/**
 * Homepage hotels regression tests (no MongoDB needed).
 *
 * Root cause pinned: `renderHomeSections()` rendered the hotels section with an
 * empty card list, `hydrateHomeHotels()` referenced an undefined `hsHotelCard`
 * renderer and swallowed the ReferenceError in a bare `catch`, so the homepage
 * hotel section was permanently empty while the Hotels page worked.
 *
 * After the fix the homepage uses the SAME real source (`GET /api/v1/hotels`)
 * and the SAME canonical card renderer (`hotelCardHtml`) as the Hotels page —
 * no duplicate list, no editorial fallback — with real loading/empty/error
 * states instead of a silent empty section.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');

function sourceBetween(startMarker: string, endMarker: string) {
  const start = app.indexOf(startMarker);
  assert.notEqual(start, -1, `marker not found: ${startMarker}`);
  const end = app.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `end marker not found: ${endMarker}`);
  return app.slice(start, end);
}

test('homepage hotels are hydrated from the same API as the Hotels page', () => {
  const render = sourceBetween('function renderHomeSections(', 'async function hydrateHomeHotels(');
  assert.match(render, /setTimeout\(\(\) => void hydrateHomeHotels\(\)/, 'renderHomeSections must invoke the hydrator');
  assert.match(render, /Loading featured hotels…/, 'the section must start with a loading state, not silence');
  assert.doesNotMatch(render, /hsHotelCard/, 'no undefined renderer in the section markup');
});

test('hydrateHomeHotels uses the canonical hotelCardHtml renderer', () => {
  const hydrate = sourceBetween('async function hydrateHomeHotels(', 'function renderAgentsCarousel(');
  assert.match(hydrate, /apiRequest\('\/hotels\?pageSize=8&sort=recommended'\)/, 'must request the same endpoint as the Hotels page');
  assert.match(hydrate, /hotels\.map\(hotel => hotelCardHtml\(hotel, \{\}\)\)/, 'must render with the canonical card renderer');
  assert.match(hydrate, /hotel-results-grid/, 'must reuse the Hotels page grid (no bespoke layout)');
  assert.doesNotMatch(hydrate, /hsHotelCard/, 'the undefined renderer is gone');
  assert.match(hydrate, /data-home-hotels-retry/, 'a failed load must offer a retry action');
});

test('no hsHotelCard reference remains anywhere in app.js', () => {
  assert.doesNotMatch(app, /hsHotelCard/, 'app.js must not reference the undefined helper');
  // Block used by hotel-image-frontend.test.ts must be intact.
  assert.match(app, /SADIK-HOTEL-IMAGES:BEGIN/);
  assert.match(app, /SADIK-HOTEL-IMAGES:END/);
});

test('hotelBuildUrl never serializes undefined parameters', () => {
  const build = sourceBetween('function hotelBuildUrl(params) {', 'function navigateToHotelSearch()');
  const run = new Function(`${build}\nreturn hotelBuildUrl;`)();
  const bare = run({});
  assert.equal(bare, '', 'a card without search dates must link with no query string');
  assert.doesNotMatch(bare, /undefined/);
  const withDates = run({ checkIn: '2026-09-10', checkOut: '2026-09-12', adults: 2, children: 0, rooms: 1, page: 1 });
  assert.equal(withDates, 'checkIn=2026-09-10&checkOut=2026-09-12&adults=2&children=0&rooms=1');
  assert.doesNotMatch(withDates, /undefined/);
});
