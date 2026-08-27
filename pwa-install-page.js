/* Shared bootstrap for the PWA install landing pages (/pwa and /admin/pwa).
 *
 * The page is configured through data attributes on <body>:
 *   data-app-name  Display name used in copy and toasts
 *   data-sw        Service worker to register for this app ("" = none)
 *
 * Behaviour:
 *   - Registers the app's service worker so installs get offline support.
 *   - Captures `beforeinstallprompt` and, because the visitor came to this
 *     page on purpose, automatically shows the branded install dialog a moment
 *     after the prompt becomes available (no cooldown here — this page IS the
 *     install surface).
 *   - The big install button always works: native prompt on Chromium,
 *     step-by-step instructions on iOS Safari and other browsers.
 *   - Detects already-installed (standalone) sessions and says so.
 */
(() => {
  'use strict';
  const body = document.body;
  const appName = body.dataset.appName || 'Sadik Travels';
  const swUrl = body.dataset.sw || '';

  const installBtn = document.getElementById('pwaPageInstall');
  const note = document.getElementById('pwaPageNote');
  const installedBox = document.getElementById('pwaPageInstalled');
  const iosSteps = document.getElementById('pwaPageIosSteps');

  const isStandalone = () =>
    window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;

  /* ------------------------------------------------- service worker */
  if (swUrl && 'serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register(swUrl).catch(() => undefined);
    });
  }

  /* ------------------------------------------------- installed state */
  function markInstalled() {
    if (installBtn) { installBtn.hidden = true; installBtn.disabled = true; }
    if (note) note.textContent = `${appName} is installed on this device.`;
    if (installedBox) installedBox.hidden = false;
  }
  if (isStandalone()) markInstalled();

  /* ------------------------------------------------- install dialog */
  let deferredPrompt = null;
  let popupOpen = false;

  const popupHtml = (mode) => `
    <div class="pwa-popup-backdrop" data-pwa-dismiss></div>
    <div class="pwa-popup" role="dialog" aria-modal="true" aria-labelledby="pwaPopupTitle">
      <button type="button" class="pwa-popup-close" data-pwa-dismiss aria-label="Close install prompt">✕</button>
      <img class="pwa-popup-logo" src="${body.dataset.icon || '/assets/pwa-icon-192.png'}" alt="" width="56" height="56" />
      <h2 id="pwaPopupTitle">Install ${appName}</h2>
      <p>Add the app to your device for faster access and notifications.</p>
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

  function closePopup() {
    const host = document.getElementById('pwaPopupHost');
    if (host) host.remove();
    popupOpen = false;
    body.classList.remove('pwa-popup-open');
  }

  function openPopup(mode) {
    if (popupOpen || isStandalone()) return;
    popupOpen = true;
    const host = document.createElement('div');
    host.id = 'pwaPopupHost';
    host.innerHTML = popupHtml(mode);
    body.appendChild(host);
    body.classList.add('pwa-popup-open');
    const dialog = host.querySelector('.pwa-popup');
    host.querySelectorAll('[data-pwa-dismiss]').forEach((el) => el.addEventListener('click', closePopup));
    host.querySelector('[data-pwa-accept]')?.addEventListener('click', async () => {
      const prompt = deferredPrompt;
      deferredPrompt = null;
      closePopup();
      if (!prompt) return;
      try {
        prompt.prompt();
        await prompt.userChoice;
      } catch { /* prompt already used */ }
    });
    host.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { closePopup(); return; }
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
    if (note) note.textContent = `Ready to install on Android, iOS & desktop.`;
    // The visitor is on the install page on purpose: show the dialog shortly
    // after the browser makes installation possible.
    setTimeout(() => { if (deferredPrompt && !popupOpen && !isStandalone()) openPopup('native'); }, 700);
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    closePopup();
    markInstalled();
  });

  if (installBtn) {
    installBtn.addEventListener('click', () => {
      if (isStandalone()) { markInstalled(); return; }
      if (deferredPrompt) openPopup('native');
      else if (isIos()) openPopup('ios');
      else openPopup('manual');
    });
  }

  // iOS has no install prompt event: show the instructions inline so iPhone
  // visitors immediately see what to do.
  if (isIos() && !isStandalone() && iosSteps) iosSteps.hidden = false;
})();
