/* Sadik Travels Admin Console service worker (scope: /admin/).
 *
 * Mirrors the public worker (sw.js) but only serves the admin surface:
 *
 *  - Precaches the console shell (admin.html, install page, offline fallback,
 *    admin icons). Versioned console assets (admin.js?v=…, admin.css?v=…) are
 *    stale-while-revalidate cached at runtime so a redeploy never strands an
 *    open console on a mixed-version bundle.
 *  - Navigations under /admin/: network-first with the cached shell fallback,
 *    so the installed console opens even on a dead connection (it will show
 *    the login/shell and surface data errors from the API).
 *  - API (/api/) and Socket.IO traffic are NEVER cached — bookings, prices,
 *    auth and chat must always be live.
 *  - Web Push: renders notifications and opens the right admin route on click.
 */
const VERSION = 'sta-v3';
const SHELL_CACHE = `${VERSION}-shell`;
const RUNTIME_CACHE = `${VERSION}-runtime`;
const ADMIN_HOME = '/admin/';
const OFFLINE_URL = '/offline.html';
const PRECACHE = [
  ADMIN_HOME,
  '/admin/pwa',
  OFFLINE_URL,
  '/assets/admin-icon-192.png',
  '/assets/admin-icon-512.png',
  '/assets/sadik-travels-logo.png?v=3'
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

const isLiveTraffic = (url) => url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/');
const isAdminNavigation = (url) => url.pathname === '/admin' || url.pathname.startsWith('/admin/');
const isStaticAsset = (url) => /\.(?:css|js|png|jpe?g|webp|gif|svg|ico|woff2?|ttf)$/.test(url.pathname) || url.pathname.endsWith('.webmanifest');

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (isLiveTraffic(url)) return; // live data only — never cached

  // Console navigations: network first, cached shell fallback.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok && isAdminNavigation(url)) {
            const copy = response.clone();
            // Keep the cached shell fresh so the offline fallback is current.
            caches.open(SHELL_CACHE).then((cache) => cache.put(ADMIN_HOME, copy)).catch(() => undefined);
          }
          return response;
        })
        .catch(async () => {
          if (isAdminNavigation(url)) {
            return (await caches.match(ADMIN_HOME)) || caches.match(OFFLINE_URL);
          }
          return (await caches.match(request)) || caches.match(OFFLINE_URL);
        })
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

/** Where an admin notification click should land (admin routes, not public). */
function targetUrl(data) {
  const explicit = typeof data.url === 'string' && data.url.startsWith('/') ? data.url : '';
  if (explicit) return explicit;
  const type = typeof data.type === 'string' ? data.type : '';
  if (type.startsWith('CHAT')) return '/admin/live-support';
  if (data.bookingId) return '/admin/hotel-bookings';
  if (type.startsWith('PAYMENT')) return '/admin/payments';
  if (type.startsWith('BOOKING') || type.startsWith('HOTEL_') || type.startsWith('TOUR_')) return '/admin/bookings';
  return '/admin/';
}

/** Notifications older than this are dropped: a stale alert is worse than none. */
const MAX_NOTIFICATION_AGE_MS = 7 * 24 * 60 * 60 * 1000;

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: 'Sadik Travels Admin', body: event.data ? event.data.text() : '' };
  }

  const sentAt = payload.sentAt ? Date.parse(payload.sentAt) : NaN;
  if (Number.isFinite(sentAt) && Date.now() - sentAt > MAX_NOTIFICATION_AGE_MS) return;

  const data = payload.data && typeof payload.data === 'object' ? payload.data : {};
  const options = {
    body: typeof payload.body === 'string' ? payload.body : '',
    icon: payload.icon || '/assets/admin-icon-192.png',
    badge: payload.badge || '/assets/admin-icon-192.png',
    tag: payload.tag || undefined,
    renotify: Boolean(payload.tag),
    data: { ...data, url: targetUrl(data), type: data.type || '', receivedAt: Date.now() },
    actions: data.type === 'CHAT_MESSAGE'
      ? [{ action: 'reply', title: 'Open conversation' }]
      : data.bookingId ? [{ action: 'open', title: 'View booking' }] : [],
    vibrate: [120, 60, 120]
  };

  event.waitUntil(
    self.registration.showNotification(payload.title || 'Sadik Travels Admin', options)
      .then(() => (self.registration.setAppBadge ? self.registration.setAppBadge() : undefined))
      .catch(() => undefined)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/admin/';
  const absolute = new URL(url, self.location.origin).href;

  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
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
  const id = event.notification && event.notification.data ? event.notification.data.notificationId : undefined;
  if (!id) return;
  event.waitUntil(fetch('/api/v1/notifications/dismissed', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ notificationId: id }),
    credentials: 'same-origin'
  }).catch(() => undefined));
});

/** The browser rotated the subscription; re-subscribe against the server key. */
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
      // Without a signed-in session the server rejects this; the console
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
