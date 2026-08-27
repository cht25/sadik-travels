/* Sadik Travels PWA bootstrap.
 *
 * - Registers the service worker.
 * - Shows a branded, accessible install popup driven by `beforeinstallprompt`.
 * - Remembers dismissal (14-day cooldown) so users are not nagged.
 * - On iOS Safari (no beforeinstallprompt) shows platform instructions instead
 *   of pretending an install happened.
 * - Owns the Web Push permission flow: explains first, asks once, subscribes
 *   only on an explicit user action, and degrades gracefully when denied.
 */
(() => {
  'use strict';
  const DISMISS_KEY = 'st_pwa_dismissed_at';
  const DISMISS_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000;
  const AUTO_PROMPT_DELAY_MS = 18000;

  let deferredPrompt = null;
  let popupOpen = false;

  const isStandalone = () =>
    window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
  const recentlyDismissed = () => {
    try { const at = Number(localStorage.getItem(DISMISS_KEY) || 0); return at && Date.now() - at < DISMISS_COOLDOWN_MS; }
    catch { return false; }
  };
  const rememberDismissal = () => { try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch { /* private mode */ } };

  /* ------------------------------------------------- service worker */
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    });
    let refreshed = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshed) return; refreshed = true;
      // A new version has taken control; keep the session, assets refresh on next nav.
    });
  }

  /* ------------------------------------------------- install popup */
  const popupHtml = (mode) => `
    <div class="pwa-popup-backdrop" data-pwa-dismiss></div>
    <div class="pwa-popup" role="dialog" aria-modal="true" aria-labelledby="pwaPopupTitle">
      <button type="button" class="pwa-popup-close" data-pwa-dismiss aria-label="Close install prompt">✕</button>
      <img class="pwa-popup-logo" src="/assets/pwa-icon-192.png" alt="" width="56" height="56" />
      <h2 id="pwaPopupTitle">Install Sadik Travels</h2>
      <p>Install our app for faster booking and easy access to your trips.</p>
      <ul class="pwa-popup-benefits">
        <li>✓ Faster booking</li>
        <li>✓ Easy access from your home screen</li>
        <li>✓ Booking notifications</li>
      </ul>
      ${mode === 'ios' ? `
        <div class="pwa-popup-steps">
          <strong>Install on iPhone / iPad:</strong>
          <ol>
            <li>Tap the <b>Share</b> button <span aria-hidden="true">(⬆︎)</span> in Safari</li>
            <li>Choose <b>Add to Home Screen</b></li>
            <li>Tap <b>Add</b></li>
          </ol>
        </div>
        <div class="pwa-popup-actions"><button type="button" class="pwa-btn-secondary" data-pwa-dismiss>Got it</button></div>
      ` : mode === 'manual' ? `
        <div class="pwa-popup-steps">
          <strong>Install from your browser menu:</strong>
          <ol>
            <li>Open the browser menu <span aria-hidden="true">(⋮)</span></li>
            <li>Choose <b>Install app</b> or <b>Add to Home screen</b></li>
          </ol>
        </div>
        <div class="pwa-popup-actions"><button type="button" class="pwa-btn-secondary" data-pwa-dismiss>Got it</button></div>
      ` : `
        <div class="pwa-popup-actions">
          <button type="button" class="pwa-btn-primary" data-pwa-accept>Install App</button>
          <button type="button" class="pwa-btn-secondary" data-pwa-dismiss>Not Now</button>
        </div>
      `}
    </div>`;

  let lastFocused = null;
  function closePopup(remember) {
    const host = document.getElementById('pwaPopupHost');
    if (host) host.remove();
    popupOpen = false;
    document.body.classList.remove('pwa-popup-open');
    if (remember) rememberDismissal();
    if (lastFocused && typeof lastFocused.focus === 'function') lastFocused.focus();
  }

  function openPopup(mode) {
    if (popupOpen || isStandalone()) return;
    popupOpen = true;
    lastFocused = document.activeElement;
    const host = document.createElement('div');
    host.id = 'pwaPopupHost';
    host.innerHTML = popupHtml(mode);
    document.body.appendChild(host);
    document.body.classList.add('pwa-popup-open');
    const dialog = host.querySelector('.pwa-popup');
    host.querySelectorAll('[data-pwa-dismiss]').forEach((el) => el.addEventListener('click', () => closePopup(true)));
    host.querySelector('[data-pwa-accept]')?.addEventListener('click', async () => {
      const prompt = deferredPrompt;
      deferredPrompt = null;
      closePopup(false);
      if (!prompt) return;
      try {
        prompt.prompt();
        const choice = await prompt.userChoice;
        if (choice.outcome !== 'accepted') rememberDismissal();
      } catch { /* prompt already used */ }
    });
    host.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { closePopup(true); return; }
      if (event.key !== 'Tab') return;
      const focusable = dialog.querySelectorAll('button');
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    (dialog.querySelector('[data-pwa-accept]') || dialog.querySelector('[data-pwa-dismiss]'))?.focus();
  }

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event;
    document.querySelectorAll('[data-pwa-install]').forEach((btn) => { btn.hidden = false; });
    if (!recentlyDismissed() && !isStandalone()) {
      setTimeout(() => { if (deferredPrompt && !popupOpen) openPopup('native'); }, AUTO_PROMPT_DELAY_MS);
    }
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    closePopup(false);
    document.querySelectorAll('[data-pwa-note]').forEach((el) => { el.textContent = 'Installed — open Sadik Travels from your home screen.'; });
    if (window.showToast) window.showToast('Sadik Travels installed. Find it on your home screen.', 'success');
  });

  // Explicit install buttons (hero section, header) always work regardless of cooldown.
  document.addEventListener('click', (event) => {
    const trigger = event.target.closest('[data-pwa-install]');
    if (!trigger) return;
    event.preventDefault();
    if (isStandalone()) { if (window.showToast) window.showToast('The app is already installed.', 'success'); return; }
    if (deferredPrompt) openPopup('native');
    else if (isIos()) openPopup('ios');
    else openPopup('manual');
  });
})();

/* ================================================================ WEB PUSH
 *
 * The permission flow is deliberately conservative:
 *
 *   1. The user opens the notification panel or settings and taps
 *      "Enable notifications".
 *   2. We show what they will receive ("booking updates, payment updates and
 *      messages") BEFORE touching the browser prompt.
 *   3. Only then is `Notification.requestPermission()` called.
 *   4. Only on `granted` do we ask the push manager for a subscription and
 *      store it server-side, bound to the signed-in account.
 *
 * If permission is denied, nothing breaks: in-app notifications and email keep
 * working, and the button explains how to re-enable from browser settings.
 * We never call requestPermission() on page load.
 */
(() => {
  'use strict';

  const ASKED_KEY = 'st_push_asked_at';
  const DECLINED_KEY = 'st_push_declined_at';
  const DECLINED_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

  const api = () => window.SadikApi;
  const toast = (message, kind) => { if (window.showToast) window.showToast(message, kind); };

  const isSupported = () => typeof window !== 'undefined'
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window;

  const permission = () => (typeof Notification !== 'undefined' ? Notification.permission : 'unsupported');

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const output = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
    return output;
  }

  async function serverConfig() {
    try { return await api().get('/push/config'); } catch { return { enabled: false }; }
  }

  /** Re-register the current subscription with the server (idempotent). */
  async function syncSubscription() {
    if (!isSupported() || permission() !== 'granted') return null;
    const registration = await navigator.serviceWorker.ready.catch(() => null);
    if (!registration) return null;
    const config = await serverConfig();
    if (!config.enabled || !config.publicKey) return null;
    const existing = await registration.pushManager.getSubscription();
    if (existing) {
      try { await api().post('/push/subscribe', { subscription: existing.toJSON() }); } catch { /* not signed in yet */ }
      return existing;
    }
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(config.publicKey)
    });
    await api().post('/push/subscribe', { subscription: subscription.toJSON() });
    return subscription;
  }

  /**
   * Full opt-in. Called only from a user gesture (a button tap).
   * Returns one of: `enabled`, `denied`, `blocked`, `unsupported`, `signed_out`,
   * `unavailable`, `error`.
   */
  async function enable() {
    if (!isSupported()) return { status: 'unsupported', reason: 'This browser does not support web notifications.' };
    const account = typeof window.SadikCurrentUser === 'function' ? window.SadikCurrentUser() : null;
    if (!account) return { status: 'signed_out', reason: 'Sign in first — notifications are delivered to your account.' };

    if (permission() === 'denied') {
      return { status: 'blocked', reason: 'Notifications are blocked in your browser settings. Open site settings for sadiktravels and allow notifications, then try again.' };
    }

    const config = await serverConfig();
    if (!config.enabled || !config.publicKey) {
      return { status: 'unavailable', reason: 'Push notifications are not configured on this server yet. You will still get in-app notifications and email.' };
    }

    let decision = permission();
    if (decision === 'default') {
      try { localStorage.setItem(ASKED_KEY, String(Date.now())); } catch { /* private mode */ }
      decision = await Notification.requestPermission();
    }
    if (decision !== 'granted') {
      try { localStorage.setItem(DECLINED_KEY, String(Date.now())); } catch { /* private mode */ }
      return { status: 'denied', reason: 'You declined notifications. In-app notifications and email will continue to work.' };
    }

    try {
      await syncSubscription();
      return { status: 'enabled' };
    } catch (error) {
      return { status: 'error', reason: error && error.message ? error.message : 'Could not register this device for notifications.' };
    }
  }

  async function disable() {
    try {
      if (isSupported()) {
        const registration = await navigator.serviceWorker.ready.catch(() => null);
        const subscription = registration ? await registration.pushManager.getSubscription() : null;
        if (subscription) await subscription.unsubscribe();
      }
      await api().delete('/push/subscriptions');
      return { status: 'disabled' };
    } catch (error) {
      return { status: 'error', reason: error && error.message ? error.message : 'Could not turn notifications off.' };
    }
  }

  /** Send a test push to this account so the user can confirm it works. */
  async function sendTest() {
    try { return await api().post('/push/test', {}); }
    catch (error) { return { success: false, reason: error && error.message ? error.message : 'Test notification failed.' }; }
  }

  async function state() {
    const perm = permission();
    let devices = [];
    try { devices = (await api().get('/push/subscriptions')).subscriptions || []; } catch { devices = []; }
    return {
      supported: isSupported(),
      permission: perm,
      // `subscribed` is true only when this browser currently holds a
      // subscription — it never assumes permission.
      subscribed: perm === 'granted' && devices.length > 0,
      devices,
      recentlyDeclined: (() => {
        try { const at = Number(localStorage.getItem(DECLINED_KEY) || 0); return Boolean(at) && Date.now() - at < DECLINED_COOLDOWN_MS; }
        catch { return false; }
      })()
    };
  }

  // Re-sync on every signed-in page load so the stored endpoint stays fresh and
  // a rotated subscription does not linger. Silent: never prompts.
  window.addEventListener('load', () => {
    if (!isSupported() || permission() !== 'granted') return;
    setTimeout(() => { syncSubscription().catch(() => undefined); }, 4000);
  });

  // Refresh in-app notifications when a push notification is opened.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'sadik-notification-opened' && typeof window.SadikRefreshNotifications === 'function') {
        window.SadikRefreshNotifications();
      }
    });
  }

  window.SadikNotifications = Object.freeze({ isSupported, permission, state, enable, disable, sendTest, syncSubscription });
})();
