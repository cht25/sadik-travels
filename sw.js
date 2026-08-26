/* Sadik Travels service worker.
 *
 * Strategy:
 *  - Precache the app shell (HTML, CSS, JS, logo, offline fallback).
 *  - Navigations: network-first with the offline page as fallback.
 *  - Same-origin static assets (css/js/images/fonts): stale-while-revalidate.
 *  - API requests (/api/) are NEVER cached — bookings, prices, availability,
 *    payments and auth must always come from the server.
 *  - New versions activate immediately (skipWaiting + clients.claim); pwa.js
 *    listens for the controllerchange event to refresh stale tabs.
 */
const VERSION = 'st-v8';
const SHELL_CACHE = `${VERSION}-shell`;
const RUNTIME_CACHE = `${VERSION}-runtime`;
const OFFLINE_URL = '/offline.html';
const PRECACHE = [
  '/',
  OFFLINE_URL,
  '/styles.css?v=21',
  '/storefront.css?v=4',
  '/api.js?v=3',
  '/chat-client.js?v=1',
  '/pages.js?v=3',
  '/app.js?v=23',
  '/pwa.js?v=1',
  '/manifest.webmanifest',
  '/assets/sadik-travels-logo.png?v=3',
  '/assets/pwa-icon-192.png',
  '/assets/pwa-icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => !key.startsWith(VERSION)).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

const isApiRequest = (url) => url.pathname.startsWith('/api/');
const isStaticAsset = (url) => /\.(?:css|js|png|jpe?g|webp|gif|svg|ico|woff2?|ttf)$/.test(url.pathname) || url.pathname === '/manifest.webmanifest';

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (isApiRequest(url)) return; // live data only — never cached

  // App navigations: network first, offline fallback.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok && url.pathname === '/') {
            const copy = response.clone();
            caches.open(SHELL_CACHE).then((cache) => cache.put('/', copy)).catch(() => undefined);
          }
          return response;
        })
        .catch(async () => (await caches.match(request)) || (await caches.match('/')) || caches.match(OFFLINE_URL))
    );
    return;
  }

  // Static assets: stale-while-revalidate.
  if (isStaticAsset(url)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        const refresh = fetch(request)
          .then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, copy)).catch(() => undefined);
            }
            return response;
          })
          .catch(() => cached);
        return cached || refresh;
      })
    );
  }
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
