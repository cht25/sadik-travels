/* Sadik Travels PWA bootstrap.
 *
 * - Registers the service worker.
 * - Shows a branded, accessible install popup driven by `beforeinstallprompt`.
 * - Remembers dismissal (14-day cooldown) so users are not nagged.
 * - On iOS Safari (no beforeinstallprompt) shows platform instructions instead
 *   of pretending an install happened.
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
