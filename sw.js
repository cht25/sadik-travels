/* Sadik Travels service worker.
 *
 * Two responsibilities:
 *
 *  1. OFFLINE / CACHING
 *     - Precache the app shell (HTML, CSS, JS, logo, offline fallback).
 *     - Navigations: network-first with the offline page as fallback.
 *     - Same-origin static assets: stale-while-revalidate.
 *     - API requests (/api/) are NEVER cached — bookings, prices, availability,
 *       payments and auth must always come from the server.
 *     - New versions activate immediately (skipWaiting + clients.claim); pwa.js
 *       listens for controllerchange to refresh stale tabs.
 *
 *  2. WEB PUSH
 *     - `push` renders a system notification from the VAPID payload.
 *     - `notificationclick` focuses an open tab or opens the app at the right
 *       route, so a booking notification opens the booking and a chat
 *       notification opens the conversation.
 *     - `notificationclose` reports a dismissal back to the server.
 *     - `pushsubscriptionchange` re-subscribes automatically when the browser
 *       rotates the endpoint, so a dead subscription does not linger.
 */
const VERSION = 'st-v10';
const SHELL_CACHE = `${VERSION}-shell`;
const RUNTIME_CACHE = `${VERSION}-runtime`;
const OFFLINE_URL = '/offline.html';
const PRECACHE = [
  '/',
  OFFLINE_URL,
  '/styles.css?v=22',
  '/storefront.css?v=4',
  '/api.js?v=3',
  '/chat-client.js?v=1',
  '/pages.js?v=3',
  '/app.js?v=25',
  '/pwa.js?v=2',
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

/* ================================================================ WEB PUSH */

/**
 * Where a notification click should land.
 *
 * The server supplies `data.url` and logical identifiers; this maps the
 * notification type to the in-app route so a booking alert opens the booking
 * and a chat alert opens the conversation.
 */
function targetUrl(data) {
  const explicit = typeof data.url === 'string' && data.url.startsWith('/') ? data.url : '';
  if (explicit) return explicit;
  const type = typeof data.type === 'string' ? data.type : '';
  if (type === 'CHAT_MESSAGE' && data.serviceId) return `/support?conversation=${encodeURIComponent(data.serviceId)}`;
  if (type.startsWith('CHAT')) return '/support';
  if (data.bookingId) return `/orders/${encodeURIComponent(data.bookingId)}`;
  if (data.orderId) return `/orders/${encodeURIComponent(data.orderId)}`;
  if (type.startsWith('PAYMENT')) return '/payments';
  if (type.startsWith('BOOKING') || type.startsWith('HOTEL_') || type.startsWith('TOUR_')) return '/orders';
  return '/';
}

/** Notifications older than this are dropped: a stale alert is worse than none. */
const MAX_NOTIFICATION_AGE_MS = 7 * 24 * 60 * 60 * 1000;

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: 'Sadik Travels', body: event.data ? event.data.text() : '' };
  }

  const sentAt = payload.sentAt ? Date.parse(payload.sentAt) : NaN;
  if (Number.isFinite(sentAt) && Date.now() - sentAt > MAX_NOTIFICATION_AGE_MS) return;

  const data = payload.data && typeof payload.data === 'object' ? payload.data : {};
  const options = {
    body: typeof payload.body === 'string' ? payload.body : '',
    icon: payload.icon || '/assets/pwa-icon-192.png',
    badge: payload.badge || '/assets/pwa-icon-192.png',
    tag: payload.tag || undefined,
    // A new notification for the same tag replaces the old one rather than
    // stacking duplicates when the same event is emitted twice.
    renotify: Boolean(payload.tag),
    data: { ...data, url: targetUrl(data), type: data.type || '', receivedAt: Date.now() },
    actions: data.type === 'CHAT_MESSAGE'
      ? [{ action: 'reply', title: 'Open conversation' }]
      : data.bookingId ? [{ action: 'open', title: 'View booking' }] : [],
    vibrate: [120, 60, 120]
  };

  event.waitUntil(
    self.registration.showNotification(payload.title || 'Sadik Travels', options)
      // Keep the badge in step with unread notifications where supported.
      .then(() => (self.registration.setAppBadge ? self.registration.setAppBadge() : undefined))
      .catch(() => undefined)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  const absolute = new URL(url, self.location.origin).href;

  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Reuse an already-open tab of the app instead of opening a second one.
    for (const client of clients) {
      try {
        if (new URL(client.url).origin === self.location.origin) {
          await client.focus();
          await client.navigate(absolute);
          client.postMessage({ type: 'sadik-notification-opened', payload: event.notification.data });
          return;
        }
      } catch { /* fall through to opening a new window */ }
    }
    await self.clients.openWindow(absolute);
    if (self.registration.clearAppBadge) await self.registration.clearAppBadge().catch(() => undefined);
  })());
});

self.addEventListener('notificationclose', (event) => {
  // Best effort: tells the server the alert was dismissed without opening it.
  const id = event.notification && event.notification.data ? event.notification.data.notificationId : undefined;
  if (!id) return;
  event.waitUntil(fetch('/api/v1/notifications/dismissed', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ notificationId: id }),
    credentials: 'same-origin'
  }).catch(() => undefined));
});

/**
 * The browser rotated or dropped our subscription. Re-subscribe against the
 * server's current VAPID key so push keeps working without the user noticing.
 */
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    try {
      const config = await fetch('/api/v1/push/config', { credentials: 'same-origin' }).then((r) => r.json());
      if (!config || !config.enabled || !config.publicKey) return;
      const applicationServerKey = urlBase64ToUint8Array(config.publicKey);
      const subscription = event.newSubscription
        || await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
      await fetch('/api/v1/push/subscribe', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subscription: subscription.toJSON() })
      });
    } catch {
      // Without a signed-in session the server rejects this; the storefront
      // re-subscribes on the next visit.
    }
  })());
});

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
  if (event.data && event.data.type === 'clear-badge' && self.registration.clearAppBadge) {
    event.waitUntil(self.registration.clearAppBadge().catch(() => undefined));
  }
});
