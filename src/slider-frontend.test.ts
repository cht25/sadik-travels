/**
 * Home slider frontend regression tests (no MongoDB needed).
 *
 * Pins the public carousel data flow: `applyPublicContent` must fetch the
 * dedicated `/site/sliders` endpoint (admin → DB → public API → carousel)
 * instead of deriving banners from generic content items, and every slide
 * must render with safe escaping, responsive <picture> support, working
 * internal SPA links and external buttons that open in a new tab.
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

test('homepage carousel reads the dedicated sliders API, not generic content', () => {
  const apply = sourceBetween('async function applyPublicContent()', 'function sliderSlideHtml(');
  assert.match(apply, /apiRequest\('\/site\/sliders'\)/, 'must fetch the active+published+valid slider feed');
  assert.match(apply, /slidersResponse\.sliders \|\| \[\]/, 'must use the slider payload');
  assert.doesNotMatch(apply, /type === 'banner'/, 'banners must no longer come from generic content items');
});

test('sliderSlideHtml renders buttons, mobile image and safe SPA links', () => {
  const helper = sourceBetween('function sliderSlideHtml(item) {', 'function bindSliderBanners(');
  const escapeHtml = (value: string) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
  const render = new Function(`const escapeHtml = ${escapeHtml.toString()};\n${helper}\nreturn sliderSlideHtml;`)() as (item: Record<string, unknown>) => string;

  const html = render({
    imageUrl: 'https://res.cloudinary.com/demo/cover.jpg',
    mobileImageUrl: 'https://res.cloudinary.com/demo/mobile.jpg',
    title: 'Cox Summer Escape',
    subtitle: 'Beach savings',
    description: 'Stay long, pay less.',
    primaryButtonText: 'Book hotels',
    primaryButtonLink: '/hotels',
    primaryExternal: false,
    secondaryButtonText: 'Partner site',
    secondaryButtonLink: 'https://partner.example/deal',
    secondaryExternal: true
  });
  assert.match(html, /<picture><source media="\(max-width:760px\)" srcset="https:\/\/res\.cloudinary\.com\/demo\/mobile\.jpg">/, 'mobile image must use a <picture> source');
  assert.match(html, /data-public-route="\/hotels"/, 'internal links must be intercepted by the SPA router');
  assert.match(html, /target="_blank" rel="noopener"/, 'external links must open safely in a new tab');
  assert.match(html, /class="banner-actions"/, 'buttons must render in the banner copy');
  assert.match(html, /onerror="this\.style\.display='none'"/, 'broken image URLs must be contained');
  assert.doesNotMatch(html, /href="javascript:/, 'no unsafe destinations may be rendered');
  assert.match(html, /<div class="banner-slide"/, 'a slide with buttons must be a div container');
  assert.doesNotMatch(html, /<a class="banner-slide"[^>]*>[\s\S]*<a class="banner-btn"/, 'anchors must never nest inside another anchor');
});
