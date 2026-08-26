const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];

const state = {
  tab: 'hotels',
  adults: 1,
  children: 0,
  infant: 0,
  hotelAdult: 2,
  hotelChild: 0,
  bannerIndex: 0,
  cardIndexes: { hotels: 0, transit: 0, destinations: 0 },
  autoBanner: null,
  features: { hotels: true, homes: true, tours: true },
  serviceStatuses: { hotels: 'active', homes: 'active', tours: 'active' }
};

const icon = (id) => `<svg><use href="#${id}"></use></svg>`;
const escapeHtml = (value) => String(value).replace(/[&<>\"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;' }[character]));
const appConfig = window.APP_CONFIG || { apiBase: document.body?.dataset.apiBase || '', liveApi: document.body?.dataset.liveApi === 'true' };
const API_BASE = appConfig.apiBase || '';

const apiRequest = (path, options = {}, canRefresh = true) => window.SadikApi.request(path, options, canRefresh);

/* ------------------------------------------------------------------ SEO */
function setSeo({ title, description, canonical, image, jsonLd }) {
  const docTitle = title ? `${title} | Sadik Travels` : 'Sadik Travels | Online Travel Agency';
  document.title = docTitle;
  const setMeta = (selector, attr, value) => { const node = document.querySelector(selector); if (node) node.setAttribute(attr, value); };
  setMeta('meta[name="description"]', 'content', description || 'Book hotels, homes & villas, tours and holiday packages with Sadik Travels.');
  setMeta('meta[property="og:title"]', 'content', docTitle);
  setMeta('meta[property="og:description"]', 'content', description || 'Book hotels, homes & villas, tours and holiday packages with Sadik Travels.');
  setMeta('meta[name="twitter:title"]', 'content', docTitle);
  setMeta('meta[name="twitter:description"]', 'content', description || 'Book hotels, homes & villas, tours and holiday packages with Sadik Travels.');
  if (image) { setMeta('meta[property="og:image"]', 'content', image); setMeta('meta[name="twitter:image"]', 'content', image); }
  const canonicalNode = document.querySelector('link[rel="canonical"]');
  if (canonicalNode) canonicalNode.href = canonical || location.pathname + location.search;
  if (jsonLd) {
    let script = document.getElementById('seoJsonLd');
    if (!script) { script = document.createElement('script'); script.type = 'application/ld+json'; script.id = 'seoJsonLd'; document.head.appendChild(script); }
    script.textContent = JSON.stringify(jsonLd);
  }
}

/* -------------------------------------------------------- analytics */
const ANALYTICS_SESSION_KEY = 'sadikSessionId';
function analyticsSessionId() {
  let session = sessionStorage.getItem(ANALYTICS_SESSION_KEY);
  if (!session) { session = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`; sessionStorage.setItem(ANALYTICS_SESSION_KEY, session); }
  return session;
}
/** Fire-and-forget business event tracking. Never blocks or breaks the page. */
function trackAnalytics(event, metadata = {}) {
  try {
    if (!window.SadikApi) return;
    const payload = { event, path: location.pathname + location.search, metadata };
    fetch(`${window.SadikApi.baseUrl}/analytics/track`, {
      method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'x-session-id': analyticsSessionId() },
      body: JSON.stringify(payload)
    }).catch(() => undefined);
  } catch { /* analytics are best-effort */ }
}
window.SadikAnalytics = { track: trackAnalytics, sessionId: analyticsSessionId };
window.setSeo = setSeo;

async function applySiteSettings() {
  try {
    const response = await apiRequest('/site/settings');
    const features = { ...state.features, ...(response.features || {}) };
    state.features = features;
    if (response.logoUrl) document.querySelectorAll('[data-brand-logo]').forEach(image => { image.src = response.logoUrl; });
    if (response.brand) document.title = `${response.brand} | Online Travel Agency`;
    const supportPhone = response.support?.phone;
    const supportEmail = response.support?.email;
    if (supportPhone) document.querySelectorAll('[data-support-phone]').forEach(node => { node.textContent = supportPhone; node.href = `tel:${supportPhone.replace(/[^+\d]/g, '')}`; });
    if (supportEmail) document.querySelectorAll('[data-support-email]').forEach(node => { node.textContent = supportEmail; node.href = `mailto:${supportEmail}`; });
    const featureTargets = ['hotels', 'homes', 'tours'];
    const serviceStatuses = { ...state.serviceStatuses, ...(response.serviceStatuses || {}) };
    state.serviceStatuses = serviceStatuses;
    featureTargets.forEach(name => {
      const enabled = features[name] !== false;
      const serviceStatus = serviceStatuses[name] || (enabled ? 'active' : 'hidden');
      document.querySelectorAll(`.travel-tab[data-target="${name}"], [data-nav-tab="${name}"], #${name}`).forEach(element => {
        if (element.classList.contains('tab-pane')) element.hidden = !enabled;
        else { element.style.display = enabled ? '' : 'none'; element.dataset.serviceStatus = serviceStatus; if (serviceStatus === 'maintenance') { element.title = `${name[0].toUpperCase()}${name.slice(1)} is temporarily under maintenance`; element.classList.add('service-maintenance'); } }
      });
    });
    const activePane = document.querySelector('.tab-pane.active');
    if (activePane && features[activePane.id] === false) {
      const next = featureTargets.find(name => features[name] !== false && document.getElementById(name));
      if (next) activateTab(next);
    }
  } catch { /* Feature flags fail open for the public shell. */ }
}

async function applyPublicContent() {
  const empty = (title, message) => `<div class="public-content-empty"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(message)}</span></div>`;
  try {
    const [response, agentsResponse, toursResponse] = await Promise.all([apiRequest('/site/content'), apiRequest('/site/agents').catch(() => ({ agents: [] })), apiRequest('/tours').catch(() => ({ tours: [] }))]);
    const items = response.content || [];
    const banners = items.filter(item => item.type === 'banner' && item.imageUrl);
    const bannerTrack = $('#bannerTrack');
    $$('[data-slider-prev="banners"],[data-slider-next="banners"]').forEach(button => { button.hidden = !banners.length; });
    if (bannerTrack) { bannerTrack.innerHTML = banners.length ? banners.map(item => `<a class="banner-slide" data-live-banner="true" href="${escapeHtml(item.metadata?.ctaUrl || '#offers')}" target="${item.metadata?.external ? '_blank' : '_self'}" rel="${item.metadata?.external ? 'noopener' : ''}"><img src="${escapeHtml(item.imageUrl)}" alt="${escapeHtml(item.title)}" loading="lazy" /><span class="banner-copy"><small>Sadik Travels</small><strong>${escapeHtml(item.title)}</strong><em>${escapeHtml(item.subtitle || '')}</em></span></a>`).join('') : empty('No published offers yet', 'Promotional banners will appear here after an admin publishes them.'); state.bannerIndex = 0; bindPromotionalInteractions(bannerTrack); updateBannerSlider(); }
    renderHomeSections(items, toursResponse.tours || []);
    renderAgentsCarousel(agentsResponse.agents || []);
    const appItem = items.find(item => item.type === 'app');
    if (appItem) { const android = appItem.metadata?.androidUrl; const ios = appItem.metadata?.iosUrl; const appButtons = { 'App Store': ios, 'Google Play': android }; Object.entries(appButtons).forEach(([label,url]) => { const button = document.querySelector(`[data-app-download="${label}"]`); if (button && typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) { button.dataset.appUrl = url; button.title = `Open ${label}`; } }); }
    setupSectionObserver();
    scrollToHashFromUrl();
  } catch { /* Empty content keeps the shell available without inventing inventory. */ }
}

/* Hide customer navigation items that an admin has disabled.
   Static markup contains the full canonical menu so the site works even if
   the navigation request fails; the API only toggles visibility/order. */
async function applySiteNavigation() {
  try {
    const response = await apiRequest('/site/navigation', {}, false);
    const enabledKeys = new Set((response.navigation || []).map(item => item.key));
    $$('#sidebarNav [data-nav-key]').forEach(link => {
      const key = link.dataset.navKey;
      link.hidden = !enabledKeys.has(key);
    });
    // Hide now-empty section labels in the sidebar.
    $$('#sidebarNav .sidebar-section-label').forEach(label => {
      let sibling = label.nextElementSibling;
      let visible = false;
      while (sibling && !sibling.classList.contains('sidebar-section-label')) {
        if (sibling.matches('[data-nav-key]') && !sibling.hidden) { visible = true; break; }
        sibling = sibling.nextElementSibling;
      }
      label.hidden = !visible;
    });
  } catch { /* keep the static menu if navigation config is unavailable */ }
}
function showToast(message, type = '') {
  const region = $('#toastRegion');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  region.appendChild(toast);
  setTimeout(() => toast.remove(), 3600);
}

function closeDropdowns(except = '') {
  $$('.mini-menu.open,.passenger-menu.open').forEach(menu => {
    if (menu.id !== except) menu.classList.remove('open');
  });
}

function toggleDropdown(id) {
  const menu = document.getElementById(id);
  if (!menu) return;
  const isOpen = menu.classList.contains('open');
  closeDropdowns(id);
  menu.classList.toggle('open', !isOpen);
}

$$('[data-dropdown]').forEach(button => {
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleDropdown(button.dataset.dropdown);
  });
});

$$('.mini-menu button[data-value]').forEach(button => {
  button.addEventListener('click', () => {
    const menu = button.closest('.mini-menu');
    const target = menu.previousElementSibling?.querySelector('span');
    if (target) target.textContent = button.dataset.value;
    menu.classList.remove('open');
  });
});

document.addEventListener('click', (event) => {
  if (!event.target.closest('.compact-select-wrap')) closeDropdowns();
});

function updatePassengerSummary() {
  const total = state.adults + state.children + state.infant;
  const set = (selector, value) => { const node = $(selector); if (node) node.textContent = value; };
  set('#adultCount', state.adults);
  set('#childCount', state.children);
  set('#infantCount', state.infant);
  set('#passengerValue', total);
  set('#hotelAdultCount', state.hotelAdult);
  set('#hotelChildCount', state.hotelChild);
  set('#guestValue', `Guests - ${state.hotelAdult + state.hotelChild}`);
}

$$('[data-step]').forEach(button => {
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    const key = button.dataset.step;
    const direction = Number(button.dataset.dir);
    const limits = { adult: [1, 9], child: [0, 4], infant: [0, 1], hotelAdult: [1, 9], hotelChild: [0, 4] };
    const stateKey = key === 'adult' ? 'adults' : key === 'child' ? 'children' : key === 'infant' ? 'infant' : key;
    const [min, max] = limits[key];
    state[stateKey] = Math.max(min, Math.min(max, state[stateKey] + direction));
    updatePassengerSummary();
  });
});

$$('[data-close-dropdown]').forEach(button => {
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    document.getElementById(button.dataset.closeDropdown)?.classList.remove('open');
  });
});

function activateTab(tabName, shouldScroll = false) {
  if (state.features[tabName] === false) { showToast(`${tabName[0].toUpperCase()}${tabName.slice(1)} is currently unavailable.`, 'error'); return; }
  const tab = document.querySelector(`.travel-tab[data-target="${tabName}"]`);
  const pane = document.getElementById(tabName);
  if (!tab || !pane) return;
  state.tab = tabName;
  $$('.travel-tab').forEach(item => {
    const active = item === tab;
    item.classList.toggle('active', active);
    item.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  $$('.tab-pane').forEach(item => {
    const active = item === pane;
    item.classList.toggle('active', active);
    item.hidden = !active;
  });
  $$('.nav-links a[data-nav-tab]').forEach(item => item.classList.toggle('active', item.dataset.navTab === tabName));
  $$('.mobile-nav-item[data-nav-tab]').forEach(item => item.classList.toggle('active', item.dataset.navTab === tabName));
  if (window.innerWidth <= 767) tab.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'nearest', inline: 'center' });
  if (shouldScroll) $('#searchPanel')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

$$('.travel-tab').forEach(tab => tab.addEventListener('click', () => activateTab(tab.dataset.target)));

const travelTabScroller = $('#travelTabsShell .travel-tabs');
const travelTabsShell = $('#travelTabsShell');
function updateTravelTabEdges() {
  if (!travelTabScroller || !travelTabsShell) return;
  const maxScroll = Math.max(0, travelTabScroller.scrollWidth - travelTabScroller.clientWidth);
  travelTabsShell.classList.toggle('can-scroll-left', travelTabScroller.scrollLeft > 2);
  travelTabsShell.classList.toggle('can-scroll-right', travelTabScroller.scrollLeft < maxScroll - 2);
}
travelTabScroller?.addEventListener('scroll', () => requestAnimationFrame(updateTravelTabEdges), { passive: true });
travelTabScroller?.addEventListener('wheel', event => {
  if (window.innerWidth > 767 || !travelTabScroller || travelTabScroller.scrollWidth <= travelTabScroller.clientWidth) return;
  const horizontal = Math.abs(event.deltaX) >= Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
  const maxScroll = travelTabScroller.scrollWidth - travelTabScroller.clientWidth;
  const canMove = (horizontal < 0 && travelTabScroller.scrollLeft > 0) || (horizontal > 0 && travelTabScroller.scrollLeft < maxScroll);
  if (canMove && Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
    event.preventDefault();
    travelTabScroller.scrollLeft += horizontal;
  }
}, { passive: false });
window.addEventListener('resize', updateTravelTabEdges);
requestAnimationFrame(updateTravelTabEdges);
$$('[data-nav-tab]').forEach(link => {
  link.addEventListener('click', (event) => {
    event.preventDefault();
    activateTab(link.dataset.navTab, true);
    if (window.innerWidth < 1024) closeSidebar();
  });
});


const globalSearchCities = [
  { label: 'Dhaka', detail: 'Bangladesh' }, { label: "Cox's Bazar", detail: 'Bangladesh' }, { label: 'Chattogram', detail: 'Bangladesh' }, { label: 'Dubai', detail: 'United Arab Emirates' }, { label: 'Singapore', detail: 'Singapore' }, { label: 'Bangkok', detail: 'Thailand' }, { label: 'Kuala Lumpur', detail: 'Malaysia' }, { label: 'Male', detail: 'Maldives' }
];
function renderGlobalSuggestions(query = '') { const input = $('#globalSearchInput'); const menu = $('#globalSearchSuggestions'); if (!input || !menu) return; const q = query.toLowerCase().trim(); const matches = globalSearchCities.filter(city => `${city.label} ${city.detail}`.toLowerCase().includes(q)).slice(0, 6); menu.innerHTML = matches.map(city => `<button type="button" data-global-city="${escapeHtml(city.label)}"><strong>${escapeHtml(city.label)}</strong><small>${escapeHtml(city.detail)}</small></button>`).join(''); menu.classList.toggle('open', matches.length > 0); $$('[data-global-city]', menu).forEach(button => button.addEventListener('click', () => { input.value = button.dataset.globalCity; menu.classList.remove('open'); activateTab('hotels', true); if ($('#hotelDestination')) $('#hotelDestination').value = button.dataset.globalCity; })); }
$('#globalSearchInput')?.addEventListener('focus', () => renderGlobalSuggestions($('#globalSearchInput').value));
$('#globalSearchInput')?.addEventListener('input', event => renderGlobalSuggestions(event.target.value));
$('#globalSearch')?.addEventListener('submit', event => { event.preventDefault(); const value = $('#globalSearchInput').value.trim(); if (!value) return; activateTab('hotels', true); if ($('#hotelDestination')) $('#hotelDestination').value = value; $('#globalSearchSuggestions')?.classList.remove('open'); });
$('#appBtn')?.addEventListener('click', () => $('#appTitle')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
$$('[data-app-download]').forEach(button => button.addEventListener('click', () => { if (button.dataset.appUrl) window.open(button.dataset.appUrl, '_blank', 'noopener'); else showToast(`${button.dataset.appDownload} download link is not configured for this deployment yet.`, 'error'); }));
document.addEventListener('click', event => { if (!event.target.closest('.global-search')) $('#globalSearchSuggestions')?.classList.remove('open'); });

$('#swapAirports')?.addEventListener('click', () => {
  const from = $('#fromAirport');
  const to = $('#toAirport');
  [from.value, to.value] = [to.value, from.value];
  showToast('Journey From and Journey To swapped.');
});

function formatDate(value) {
  if (!value) return '';
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: '2-digit', month: 'short', year: 'numeric' }).format(date);
}

function isoDateFromToday(offsetDays) {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}
function setDefaultDates() {
  const tomorrow = isoDateFromToday(1);
  const weekLater = isoDateFromToday(8);
  [['departureDate', tomorrow], ['returnDate', weekLater], ['checkinDate', tomorrow], ['checkoutDate', isoDateFromToday(2)], ['homeCheckin', tomorrow], ['homeCheckout', isoDateFromToday(2)]].forEach(([id, value]) => { const input = $(`#${id}`); if (input && !input.value) input.value = value; if (input) input.min = tomorrow; });
}
function syncDateLabels() {
  const pairs = [
    ['departureDate', document.querySelector('#departureDate')?.closest('.form-field')?.querySelector('small')],
    ['returnDate', document.querySelector('#returnDate')?.closest('.form-field')?.querySelector('small')],
    ['checkinDate', document.querySelector('#checkinDate')?.closest('.form-field')?.querySelector('small')],
  ];
  pairs.forEach(([id, label]) => { if (label) label.textContent = formatDate($(`#${id}`)?.value); });
  const checkout = $('#checkoutDate');
  const nightLabel = checkout?.closest('.form-field')?.querySelector('small');
  if (checkout && nightLabel) {
    const checkin = $('#checkinDate')?.value;
    const days = checkin && checkout.value ? Math.max(1, Math.round((new Date(`${checkout.value}T00:00:00`) - new Date(`${checkin}T00:00:00`)) / 86400000)) : 1;
    nightLabel.textContent = `${days} night${days === 1 ? '' : 's'}`;
  }
}
setDefaultDates();
$$('input[type="date"]').forEach(input => input.addEventListener('change', syncDateLabels));
syncDateLabels();

const suggestionData = {
  city: [
    { code: 'CXB', city: "Cox's Bazar", name: 'Bangladesh' },
    { code: 'DAC', city: 'Dhaka', name: 'Bangladesh' },
    { code: 'CTG', city: 'Chattogram', name: 'Bangladesh' },
    { code: 'DXB', city: 'Dubai', name: 'United Arab Emirates' },
    { code: 'BKK', city: 'Bangkok', name: 'Thailand' },
    { code: 'SIN', city: 'Singapore', name: 'Singapore' },
    { code: 'KUL', city: 'Kuala Lumpur', name: 'Malaysia' },
    { code: 'MLE', city: 'Male', name: 'Maldives' }
  ],
  country: [
    { code: 'BD', city: 'Bangladesh', name: 'South Asia' },
    { code: 'AE', city: 'United Arab Emirates', name: 'Middle East' },
    { code: 'SA', city: 'Saudi Arabia', name: 'Middle East' },
    { code: 'TH', city: 'Thailand', name: 'South East Asia' },
    { code: 'MY', city: 'Malaysia', name: 'South East Asia' },
    { code: 'SG', city: 'Singapore', name: 'South East Asia' },
    { code: 'MV', city: 'Maldives', name: 'South Asia' },
    { code: 'GB', city: 'United Kingdom', name: 'Europe' },
    { code: 'US', city: 'United States', name: 'North America' }
  ],
  category: [
    { code: 'HTL', city: 'Hotels', name: 'City stays and resorts' },
    { code: 'HOM', city: 'Homes & Villas', name: 'Apartments and holiday homes' },
    { code: 'TOU', city: 'Tours', name: 'Guided tour packages' },
    { code: 'HOL', city: 'Holiday Packages', name: 'Bundled holiday deals' }
  ]
};

function renderSuggestions(input, suggestions, type) {
  const field = input.closest('.autocomplete-field');
  const menu = field?.querySelector('.suggestions');
  if (!menu) return;
  const query = input.value.trim().toLowerCase();
  const matches = suggestionData[type].filter(item => `${item.city} ${item.name} ${item.code}`.toLowerCase().includes(query)).slice(0, 6);
  menu.innerHTML = matches.length ? matches.map(item => `<button type="button" class="suggestion" data-value="${item.city} (${item.code})"><span class="suggestion-code">${item.code}</span><span class="suggestion-copy"><strong>${item.city}</strong><small>${item.name}</small></span></button>`).join('') : '<div class="suggestion"><span class="suggestion-copy"><strong>No matches found</strong><small>Try another search</small></span></div>';
  menu.classList.add('open');
  $$('.suggestion[data-value]', menu).forEach(button => button.addEventListener('click', () => {
    input.value = button.dataset.value;
    menu.classList.remove('open');
    input.dispatchEvent(new Event('change'));
  }));
}

$$('.autocomplete-field').forEach(field => {
  const input = $('input', field);
  const type = field.dataset.autocomplete || 'city';
  input.addEventListener('focus', () => renderSuggestions(input, suggestionData[type], type));
  input.addEventListener('input', () => renderSuggestions(input, suggestionData[type], type));
});

document.addEventListener('click', event => {
  if (!event.target.closest('.autocomplete-field')) $$('.suggestions.open').forEach(menu => menu.classList.remove('open'));
});

let modalReturnFocus = null;
function openModal(modal) {
  if (!modal) return;
  modalReturnFocus = document.activeElement;
  modal.hidden = false;
  document.body.style.overflow = 'hidden';
  requestAnimationFrame(() => (modal.querySelector('input,button,select,textarea,[tabindex]:not([tabindex="-1"])') || modal.querySelector('.modal-close'))?.focus());
}
function closeModal(modal) {
  if (!modal) return;
  modal.hidden = true;
  if (typeof closeActiveChatConversation === 'function') closeActiveChatConversation();
  if (![...document.querySelectorAll('.modal')].some(item => !item.hidden)) {
    document.body.style.overflow = '';
    if (modalReturnFocus && document.contains(modalReturnFocus)) modalReturnFocus.focus();
    modalReturnFocus = null;
  }
}
function openTemplateModal(templateId, summary = '') {
  const modal = $('#genericModal');
  const template = document.getElementById(templateId);
  if (!template) return;
  $('#modalContent').innerHTML = template.innerHTML;
  const summaryNode = $('#resultSummary');
  if (summary && summaryNode) summaryNode.innerHTML = summary;
  openModal(modal);
  bindDynamicModalEvents();
}

/* ---------- Messenger-style live chat (Firebase Realtime Database) ----------
   Conversations are context-aware: a chat started from a hotel page carries
   type:"hotel" + the stable hotel id, so the server can add that hotel's owner
   (via hotel.ownerId) as a real participant. Messages stream over Realtime
   Database listeners (or the Socket.IO hub when Firebase is not configured). */
const visitorChat = {
  booted: false,
  activeId: null,
  conversation: null,
  conversations: new Map(),
  messages: new Map(),
  typing: new Map(),
  presence: new Map(),
  inboxUnsubscribe: null,
  conversationUnsubscribe: null,
  connectionUnsubscribe: null
};

function chatInitials(name) { return String(name || '?').replace(/[^a-zA-Z0-9 ]/g, '').split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase() || '?'; }
function chatAvatarHtml(profile, extra = '') {
  const label = profile?.roleLabel || '';
  if (profile?.photoUrl) return `<span class="chat-avatar ${extra}"><img src="${escapeHtml(profile.photoUrl)}" alt="" />${label ? `<i>${escapeHtml(label)}</i>` : ''}</span>`;
  return `<span class="chat-avatar ${extra}"><b>${escapeHtml(chatInitials(profile?.name))}</b>${label ? `<i>${escapeHtml(label)}</i>` : ''}</span>`;
}
function chatContextTitle(conversation) {
  if (conversation?.type === 'hotel') return conversation.label || 'Hotel';
  if (conversation?.type === 'support') return 'Sadik Travels Support';
  return conversation?.label || 'Conversation';
}
function chatOtherProfile(conversation) {
  const profiles = conversation?.profiles || {};
  const others = Object.values(profiles).filter(profile => profile.uid !== window.SadikChat?.viewer?.uid);
  const staff = others.find(profile => profile.kind === 'staff');
  return staff || others[0] || { uid: 'support-team', name: 'Sadik Travels Support', roleLabel: 'Support Team' };
}
function chatTimeLabel(value) {
  const date = new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
function chatConnectionLabel() {
  const state = window.SadikChat?.connectionState;
  if (state === 'online') return 'Online';
  if (state === 'offline') return 'Reconnecting…';
  return 'Connecting…';
}

function updateChatBubbleBadge() {
  const badge = $('#chatBubble .chat-badge');
  if (!badge) return;
  const mine = window.SadikChat?.viewer?.uid;
  let unread = 0;
  visitorChat.conversations.forEach(conversation => { unread += Number(conversation.unread?.[mine] || 0); });
  badge.hidden = unread === 0 || !$('#genericModal')?.hidden;
  badge.textContent = String(Math.min(99, unread));
}

function startVisitorChatInbox() {
  if (visitorChat.inboxUnsubscribe || !window.SadikChat) return;
  visitorChat.inboxUnsubscribe = window.SadikChat.watchInbox(list => {
    visitorChat.conversations.clear();
    (list || []).forEach(conversation => visitorChat.conversations.set(conversation.id, conversation));
    updateChatBubbleBadge();
    if (!$('#genericModal')?.hidden && !visitorChat.activeId) renderChatList();
  });
  if (!visitorChat.connectionUnsubscribe) {
    visitorChat.connectionUnsubscribe = window.SadikChat.onConnectionState(() => {
      const status = $('#visitorChatStatus');
      if (status && !visitorChat.activeId) status.textContent = chatConnectionLabel();
    });
  }
}

function chatMessageHtml(message) {
  const mine = message.senderId === window.SadikChat?.viewer?.uid;
  const conversation = visitorChat.conversation;
  const profiles = conversation?.profiles || {};
  const author = mine ? null : (profiles[message.senderId] || chatOtherProfile(conversation));
  const otherReadAt = Math.max(0, ...Object.entries(conversation?.reads || {}).filter(([uid]) => uid !== window.SadikChat?.viewer?.uid).map(([, at]) => Number(at) || 0));
  const receipt = mine ? (otherReadAt >= Number(message.sentAt || 0) ? '<span class="chat-receipt read" title="Read">✓✓</span>' : '<span class="chat-receipt" title="Sent">✓</span>') : '';
  const roleLabel = author ? `<small>${escapeHtml(author.roleLabel || (author.kind === 'staff' ? 'Support' : 'Customer'))}</small>` : '';
  return `<article class="visitor-chat-message ${mine ? 'is-visitor' : 'is-support'}${message.pending ? ' is-pending' : ''}" data-chat-message="${escapeHtml(message.id)}">
    <div><strong>${mine ? 'You' : escapeHtml(author?.name || 'Support')}</strong>${roleLabel}<small>${escapeHtml(new Date(message.sentAt || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</small></div>
    <p>${escapeHtml(message.text)}</p>
    ${mine ? `<i class="chat-message-meta">${receipt}</i>` : ''}
  </article>`;
}

function renderChatMessages() {
  const stream = $('#visitorChatStream');
  if (!stream) return;
  const ordered = [...visitorChat.messages.values()].sort((a, b) => (a.sentAt || 0) - (b.sentAt || 0) || String(a.id).localeCompare(String(b.id)));
  stream.innerHTML = ordered.length ? ordered.map(chatMessageHtml).join('') : '<p class="visitor-chat-empty">Say hello — messages arrive here instantly.</p>';
  stream.scrollTop = stream.scrollHeight;
}

function renderChatHeader() {
  const conversation = visitorChat.conversation;
  if (!conversation) return;
  const other = chatOtherProfile(conversation);
  const presence = visitorChat.presence.get(other.uid);
  const typing = [...visitorChat.typing.values()].some(entry => Date.now() - entry.at < 6000);
  const online = presence?.online === true;
  const status = typing ? `${escapeHtml(other.name)} is typing…` : online ? '● Online' : (presence?.lastSeen ? `Last seen ${chatTimeLabel(presence.lastSeen)}` : chatConnectionLabel());
  const header = $('#visitorChatHeader');
  if (!header) return;
  header.innerHTML = `<button type="button" class="chat-back" id="chatBackBtn" aria-label="Back to conversations">←</button>${chatAvatarHtml(other)}<span class="chat-header-copy"><strong>${escapeHtml(chatContextTitle(conversation))}</strong><small>${escapeHtml(other.roleLabel || (other.kind === 'staff' ? 'Support' : 'Customer'))}${conversation.type === 'hotel' && conversation.label && other.name && other.name !== conversation.label ? ` · ${escapeHtml(other.name)}` : ''}</small><em id="visitorChatStatus" class="${typing ? 'typing' : online ? 'online' : ''}">${status}</em></span>`;
  $('#chatBackBtn')?.addEventListener('click', () => { closeActiveChatConversation(); renderChatList(); });
}

function watchActiveConversation(conversationId) {
  visitorChat.conversationUnsubscribe?.();
  visitorChat.conversationUnsubscribe = null;
  visitorChat.messages.clear();
  visitorChat.typing.clear();
  visitorChat.presence.clear();
  visitorChat.activeId = conversationId;
  visitorChat.conversationUnsubscribe = window.SadikChat.watchConversation(conversationId, {
    onHistory(messages) {
      visitorChat.messages.clear();
      (messages || []).forEach(message => visitorChat.messages.set(message.id, message));
      if (visitorChat.activeId === conversationId) renderChatMessages();
    },
    onMessage(message) {
      if (!message?.id || visitorChat.messages.has(message.id)) return;
      visitorChat.messages.set(message.id, message);
      if (visitorChat.activeId !== conversationId) return;
      const stream = $('#visitorChatStream');
      if (stream) {
        stream.querySelector('.visitor-chat-empty')?.remove();
        stream.insertAdjacentHTML('beforeend', chatMessageHtml(message));
        stream.scrollTop = stream.scrollHeight;
      }
      void window.SadikChat.markRead(conversationId);
    },
    onConversation(conversation) {
      visitorChat.conversation = { ...(visitorChat.conversation || {}), ...conversation };
      visitorChat.conversations.set(conversationId, visitorChat.conversation);
      if (visitorChat.activeId === conversationId) { renderChatHeader(); updateChatBubbleBadge(); }
    },
    onRead() { if (visitorChat.activeId === conversationId) renderChatMessages(); },
    onTyping(entries) {
      visitorChat.typing.clear();
      (entries || []).forEach(entry => visitorChat.typing.set(entry.uid, entry));
      if (visitorChat.activeId === conversationId) renderChatHeader();
      setTimeout(() => { if (visitorChat.activeId === conversationId && visitorChat.typing.size) renderChatHeader(); }, 6500);
    },
    onPresence(payload) {
      if (!payload?.uid) return;
      visitorChat.presence.set(payload.uid, { online: payload.online === true, lastSeen: payload.lastSeen });
      if (visitorChat.activeId === conversationId) renderChatHeader();
    },
    onError(error) { showToast(error?.message || 'This conversation is not available.', 'error'); }
  });
  void window.SadikChat.markRead(conversationId);
}

function closeActiveChatConversation() {
  visitorChat.conversationUnsubscribe?.();
  visitorChat.conversationUnsubscribe = null;
  visitorChat.activeId = null;
  visitorChat.conversation = null;
  visitorChat.messages.clear();
}

function renderChatList() {
  const mine = window.SadikChat?.viewer?.uid;
  const items = [...visitorChat.conversations.values()].sort((a, b) => (b.lastMessage?.sentAt || b.updatedAt || 0) - (a.lastMessage?.sentAt || a.updatedAt || 0));
  const rows = items.map(conversation => {
    const other = chatOtherProfile(conversation);
    const unread = Number(conversation.unread?.[mine] || 0);
    const preview = conversation.lastMessage?.text ? `${conversation.lastMessage.senderId === mine ? 'You: ' : ''}${conversation.lastMessage.text}` : 'New conversation';
    return `<button type="button" class="chat-thread${unread ? ' has-unread' : ''}" data-chat-thread="${escapeHtml(conversation.id)}">
      ${chatAvatarHtml(other)}
      <span class="chat-thread-copy">
        <strong>${escapeHtml(chatContextTitle(conversation))}<time>${escapeHtml(chatTimeLabel(conversation.lastMessage?.sentAt || conversation.updatedAt))}</time></strong>
        <small>${escapeHtml(other.name || '')}</small>
        <em>${escapeHtml(preview.slice(0, 90))}</em>
      </span>
      ${unread ? `<b class="chat-unread">${unread > 9 ? '9+' : unread}</b>` : ''}
    </button>`;
  }).join('');
  $('#modalContent').innerHTML = `<div class="chat-modal-content visitor-chat chat-inbox">
    <div class="chat-title-row"><div><span class="online-dot"></span> Messages</div><span class="chat-status" id="visitorChatStatus">${chatConnectionLabel()}</span></div>
    <div class="chat-thread-list">${rows || '<p class="visitor-chat-empty">No conversations yet. Start one from any hotel page or with our travel team below.</p>'}</div>
    <button type="button" class="btn btn-outline full-btn" id="chatSupportBtn">${icon('i-headset')} Chat with our travel team</button>
  </div>`;
  $('#visitorChatStatus').textContent = chatConnectionLabel();
  $$('#modalContent [data-chat-thread]').forEach(button => button.addEventListener('click', () => void openChatConversation(button.dataset.chatThread)));
  $('#chatSupportBtn')?.addEventListener('click', () => void startSupportConversation());
}

async function openChatConversation(conversationId) {
  try {
    const payload = await window.SadikChat.openExisting(conversationId);
    visitorChat.conversation = payload.conversation;
    renderConversationShell();
    watchActiveConversation(conversationId);
    (payload.messages || []).forEach(message => visitorChat.messages.set(message.id, message));
    renderChatMessages();
  } catch (error) { showToast(error.message || 'Unable to open that conversation.', 'error'); }
}

function renderConversationShell() {
  const conversation = visitorChat.conversation || {};
  $('#modalContent').innerHTML = `<div class="chat-modal-content visitor-chat">
    <header class="chat-conversation-header" id="visitorChatHeader"></header>
    <div class="visitor-chat-stream" id="visitorChatStream" aria-live="polite"></div>
    <form class="visitor-chat-reply" id="visitorChatReply">
      <label class="sr-only" for="visitorChatText">Message</label>
      <textarea id="visitorChatText" rows="2" maxlength="4000" placeholder="Type a message…" required></textarea>
      <button class="btn btn-primary" type="submit">Send</button>
    </form>
    <p class="visitor-chat-security">Messages are end-to-end delivered through Firebase Realtime Database and saved for your account.</p>
  </div>`;
  renderChatHeader();
  bindChatComposer();
  if (!visitorChat.connectionUnsubscribe) {
    visitorChat.connectionUnsubscribe = window.SadikChat.onConnectionState(() => renderChatHeader());
  }
}

function bindChatComposer() {
  const form = $('#visitorChatReply');
  const textarea = $('#visitorChatText');
  let typingActive = false;
  textarea?.addEventListener('input', () => {
    if (!visitorChat.activeId) return;
    if (!typingActive && textarea.value.trim()) { typingActive = true; void window.SadikChat.setTyping(visitorChat.activeId, true); }
    if (typingActive && !textarea.value.trim()) { typingActive = false; void window.SadikChat.setTyping(visitorChat.activeId, false); }
  });
  form?.addEventListener('submit', async event => {
    event.preventDefault();
    const text = textarea.value.trim();
    if (!text || !visitorChat.activeId) return;
    const button = event.submitter;
    if (button) button.disabled = true;
    if (typingActive) { typingActive = false; void window.SadikChat.setTyping(visitorChat.activeId, false); }
    try {
      const message = await window.SadikChat.sendMessage(visitorChat.activeId, text, visitorChat.conversation);
      textarea.value = '';
      if (message && !visitorChat.messages.has(message.id)) {
        visitorChat.messages.set(message.id, message);
        const stream = $('#visitorChatStream');
        if (stream) {
          stream.querySelector('.visitor-chat-empty')?.remove();
          stream.insertAdjacentHTML('beforeend', chatMessageHtml(message));
          stream.scrollTop = stream.scrollHeight;
        }
      }
      textarea.focus();
    } catch (error) { showToast(error.message || 'Unable to send the message.', 'error'); }
    finally { if (button) button.disabled = false; }
  });
}

function renderVisitorGuestIntro(context) {
  $('#modalContent').innerHTML = `<div class="chat-modal-content">
    <div class="chat-title-row"><div><span class="online-dot"></span> Sadik Travels Chat</div><span class="chat-status">Live</span></div>
    <div class="chat-welcome"><strong>Start a live conversation${context?.hotelName ? ` with ${escapeHtml(context.hotelName)}` : ''}</strong><p>Tell us your name and how to reach you — the conversation continues instantly and stays in your account.</p></div>
    <form id="visitorChatIntro">
      <label class="chat-intro-field"><span>Name</span><input name="name" autocomplete="name" placeholder="Your name" required /></label>
      <label class="chat-intro-field"><span>Mobile or email</span><input name="contact" autocomplete="tel" placeholder="01XXXXXXXXX or you@example.com" required /></label>
      <button class="btn btn-primary full-btn" type="submit">Continue to chat</button>
    </form>
  </div>`;
  $('#visitorChatIntro')?.addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      await window.SadikChat.updateProfile({ name: String(data.name || '').trim(), contact: String(data.contact || '').trim() });
      if (context?.hotelId) await startHotelConversation({ id: context.hotelId, name: context.hotelName });
      else await renderVisitorInbox();
    } catch (error) {
      showToast(error.message || 'Enter your name and a phone number or email.', 'error');
      button.disabled = false;
    }
  });
}

async function startHotelConversation(hotel) {
  try {
    const conversation = await window.SadikChat.openConversation('hotel', hotel.id);
    visitorChat.conversation = conversation;
    renderConversationShell();
    watchActiveConversation(conversation.id);
    renderChatMessages();
  } catch (error) {
    showToast(error.message || 'This hotel chat is not available right now.', 'error');
    await renderVisitorInbox();
  }
}

async function startSupportConversation() {
  try {
    const conversation = await window.SadikChat.openConversation('support');
    visitorChat.conversation = conversation;
    renderConversationShell();
    watchActiveConversation(conversation.id);
    renderChatMessages();
  } catch (error) { showToast(error.message || 'Support chat is not available right now.', 'error'); }
}

function visitorNeedsIntro() {
  const viewer = window.SadikChat?.viewer;
  return viewer && viewer.kind === 'guest' && (!viewer.name || viewer.name === 'Guest');
}

async function renderVisitorInbox() {
  try {
    await window.SadikChat.ready();
    startVisitorChatInbox();
    if (visitorNeedsIntro()) return renderVisitorGuestIntro({});
    renderChatList();
  } catch (error) {
    $('#modalContent').innerHTML = `<div class="chat-modal-content"><p class="visitor-chat-empty">${escapeHtml(error.message || 'Live chat is temporarily unavailable.')}</p></div>`;
  }
}

/** Open the messenger from the floating bubble or the support buttons. */
function openChat() {
  const badge = $('#chatBubble .chat-badge');
  if (badge) { badge.hidden = true; badge.textContent = '0'; }
  openModal($('#genericModal'));
  void renderVisitorInbox();
}

/** Entry point for the "Chat with Hotel" button on hotel detail pages. */
async function openHotelChat(hotel) {
  openModal($('#genericModal'));
  try {
    await window.SadikChat.ready();
    startVisitorChatInbox();
    if (visitorNeedsIntro()) return renderVisitorGuestIntro({ hotelId: hotel.id, hotelName: hotel.name });
    await startHotelConversation(hotel);
  } catch (error) {
    $('#modalContent').innerHTML = `<div class="chat-modal-content"><p class="visitor-chat-empty">${escapeHtml(error.message || 'Live chat is temporarily unavailable.')}</p></div>`;
  }
}

document.addEventListener('click', event => {
  const closer = event.target.closest('[data-close-modal]');
  if (closer) closeActiveChatConversation();
});
window.addEventListener('pagehide', () => {
  visitorChat.conversationUnsubscribe?.();
  visitorChat.inboxUnsubscribe?.();
});

function bindDynamicModalEvents() {
  $('#trackForm')?.addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.submitter || $('#trackForm button[type="submit"]');
    const reference = $('#trackReference')?.value.trim();
    const identity = $('#trackIdentity')?.value.trim();
    if (!reference || !identity) { showToast('Enter both the booking reference and the contact used for the booking.', 'error'); return; }
    button.disabled = true;
    try {
      const response = await apiRequest('/bookings/track', { method: 'POST', body: JSON.stringify({ bookingReference: reference, identity }) });
      const booking = response.booking;
      $('#modalContent').innerHTML = `<div class="modal-heading"><div class="modal-icon blue">${icon('i-search')}</div><h2 id="modalTitle">Booking status</h2></div><p class="modal-subtitle">Reference <strong>${escapeHtml(booking.id)}</strong></p><div class="result-summary"><strong>${escapeHtml(booking.vertical)} · ${escapeHtml(booking.status)}</strong><br><span>Created ${escapeHtml(new Date(booking.createdAt).toLocaleString())}</span>${booking.providerRef ? `<br><span>Provider reference: ${escapeHtml(booking.providerRef)}</span>` : ''}</div><button type="button" class="btn btn-primary full-btn" data-close-modal>Done</button>`;
    } catch (error) { showToast(error.message || 'Unable to find that booking.', 'error'); } finally { button.disabled = false; }
  });
}

function tourQueryFromForm() {
  return { destination: $('#tourDestination')?.value.trim() || '', tourType: $('#tourType')?.value || '', maxPrice: $('#tourBudget')?.value || '', sort: $('#tourSort')?.value || 'newest' };
}
function tourQueryFromFilters() {
  return { destination: $('#tourFilterDestination')?.value.trim() || '', tourType: $('#tourFilterType')?.value || '', maxPrice: $('#tourFilterBudget')?.value || '', sort: $('#tourResultsSort')?.value || 'newest' };
}
function tourQueryString(query) {
  const params = new URLSearchParams({ type: 'tour' });
  if (query.destination) params.set('destination', query.destination);
  if (query.tourType) params.set('tour_type', query.tourType);
  if (query.maxPrice) params.set('max_price', query.maxPrice);
  if (query.sort && query.sort !== 'newest') params.set('sort', query.sort);
  return params.toString();
}
function tourImage(tour) {
  return tour.imageUrl || '';
}
function renderTourResults(tours, query) {
  const grid = $('#tourResultsGrid');
  const empty = $('#tourEmpty');
  const count = $('#tourResultsCount');
  if (!grid || !empty || !count) return;
  count.textContent = `${tours.length} tour${tours.length === 1 ? '' : 's'} found`;
  empty.hidden = tours.length > 0;
  grid.innerHTML = tours.map(tour => `<article class="tour-package-card" data-tour-id="${escapeHtml(tour.id)}"><div class="tour-package-image">${tourImage(tour) ? `<img src="${escapeHtml(tourImage(tour))}" alt="${escapeHtml(tour.title)}" loading="lazy" />` : '<div class="public-content-empty"><span>No image published</span></div>'}<span class="tour-duration">${escapeHtml(tour.durationDays)} Days ${escapeHtml(tour.durationNights)} Nights</span><span class="tour-country"><svg><use href="#i-location"></use></svg>${escapeHtml(tour.country)}</span></div><div class="tour-package-content"><div class="tour-package-top"><h3>${escapeHtml(tour.title)}</h3><div class="tour-destination-list">${tour.destinations.map(destination => `<span>${escapeHtml(destination)}</span>`).join('')}</div></div><div class="tour-package-bottom"><div class="tour-price"><small>Starting from:</small><strong>৳${Number(tour.priceBdt).toLocaleString('en-BD')}</strong><span>per person</span></div><button type="button" class="tour-view-details" data-tour-details="${escapeHtml(tour.id)}">View Details <span>→</span></button></div></div></article>`).join('');
  $$('.tour-view-details', grid).forEach(button => button.addEventListener('click', () => { const tour = tours.find(item => item.id === button.dataset.tourDetails); if (tour) openTourDetails(tour); }));
  $$('.tour-package-card', grid).forEach(card => card.addEventListener('click', event => { if (event.target.closest('button')) return; const tour = tours.find(item => item.id === card.dataset.tourId); if (tour) openTourDetails(tour); }));
}
function openTourResultsSection() {
  const section = $('#tourResultsSection');
  if (!section) return;
  section.hidden = false;
  section.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
async function searchTours(query, updateUrl = true) {
  if (state.serviceStatuses.tours === 'maintenance') { showToast('Tours are temporarily under maintenance.', 'error'); return; }
  if (state.serviceStatuses.tours === 'hidden' || state.serviceStatuses.tours === 'archived') { showToast('Tours are currently unavailable.', 'error'); return; }
  try {
    const url = new URL(`${API_BASE}/tours`, window.location.origin);
    if (query.destination) url.searchParams.set('destination', query.destination);
    if (query.tourType) url.searchParams.set('tour_type', query.tourType);
    if (query.maxPrice) url.searchParams.set('max_price', query.maxPrice);
    if (query.sort) url.searchParams.set('sort', query.sort);
    const response = await apiRequest(`${url.pathname}${url.search}`, { method: 'GET' });
    const tours = response.tours || [];
    $('#tourFilterDestination').value = query.destination || '';
    $('#tourFilterType').value = query.tourType || '';
    $('#tourFilterBudget').value = query.maxPrice || '';
    $('#tourResultsSort').value = query.sort || 'newest';
    renderTourResults(tours, query);
    openTourResultsSection();
    if (updateUrl) history.pushState({}, '', `/search?${tourQueryString(query)}`);
  } catch (error) { showToast(error.message || 'Tour search is unavailable.', 'error'); }
}
function openTourDetails(tour) {
  publicNavigate(`/tours/${encodeURIComponent(tour.id)}`);
  return;
  const modal = $('#genericModal');
  $('#modalContent').innerHTML = `<div class="tour-detail-modal"><img class="tour-detail-image" src="${escapeHtml(tourImage(tour))}" alt="${escapeHtml(tour.title)}" /><div class="modal-heading"><div class="modal-icon blue">${icon('i-map')}</div><h2 id="modalTitle">${escapeHtml(tour.title)}</h2></div><p class="modal-subtitle">${escapeHtml(tour.durationDays)} days / ${escapeHtml(tour.durationNights)} nights · ${escapeHtml(tour.country)}</p><p class="tour-detail-description">${escapeHtml(tour.description || 'A carefully planned journey with Sadik Travels support.')}</p><div class="result-summary"><strong>Starting from ৳${Number(tour.priceBdt).toLocaleString('en-BD')} per person</strong><br><span>${tour.destinations.map(escapeHtml).join(' · ')}</span></div><form id="tourBookForm"><label class="modal-field"><span>Travellers</span><input id="tourTravellers" type="number" min="1" max="30" value="2" required /></label><label class="modal-field"><span>Preferred travel date</span><input id="tourTravelDate" type="date" required /></label><button class="btn btn-primary full-btn" type="submit">Book this tour</button></form></div>`;
  openModal(modal);
  $('#tourBookForm')?.addEventListener('submit', async event => {
    event.preventDefault();
    try {
      const response = await apiRequest('/bookings', { method: 'POST', body: JSON.stringify({ vertical: 'tour', payload: { tourId: tour.id, slug: tour.slug, title: tour.title, travellers: Number($('#tourTravellers').value), travelDate: $('#tourTravelDate').value, priceBdt: tour.priceBdt } }) });
      closeModal(modal);
      openBookingNextSteps(response.booking);
    } catch (error) { if (error.status === 401 || error.code === 'AUTH_REQUIRED') { closeModal(modal); openLogin(); showToast('Please login to book this tour.'); } else showToast(error.message || 'Unable to create tour booking.', 'error'); }
  });
}

function openBookingNextSteps(booking) {
  const modal = $('#genericModal');
  const isOperatorReview = ['new', 'reviewing'].includes(booking?.status);
  const paymentAction = isOperatorReview
    ? '<div class="result-summary"><strong>Request submitted for operator review.</strong><br><span>We will contact you when the package is accepted and payment is ready. No payment has been taken.</span></div><button type="button" class="btn btn-primary full-btn" data-close-modal>Done</button>'
    : `<div class="result-summary"><strong>Verified provider quote required</strong><br><span>The payment gateway will use the confirmed provider quote. You cannot edit the amount here.</span></div><button type="button" class="btn btn-primary full-btn" id="payBookingBtn">Continue to payment</button>`;
  $('#modalContent').innerHTML = `<div class="modal-heading"><div class="modal-icon green">${icon('i-check')}</div><h2 id="modalTitle">Booking request created</h2></div><p class="modal-subtitle">Your booking reference is <strong>${escapeHtml(booking.id)}</strong>.</p><div class="result-summary"><strong>Status: ${escapeHtml(booking.status)}</strong><br><span>Your request has been saved to Sadik Travels.</span></div>${paymentAction}`;
  openModal(modal);
  $('#payBookingBtn')?.addEventListener('click', async () => {
    const button = $('#payBookingBtn');
    button.disabled = true;
    try {
      const response = await apiRequest('/payments/intents', { method: 'POST', body: JSON.stringify({ bookingId: booking.id }) });
      $('#modalContent').innerHTML = `<div class="modal-heading"><div class="modal-icon green">${icon('i-check')}</div><h2 id="modalTitle">Payment initiated</h2></div><p class="modal-subtitle">Transaction reference: <strong>${escapeHtml(response.payment?.transactionRef || 'pending')}</strong></p><div class="result-summary">${response.checkoutUrl ? 'Continue through the configured payment gateway to complete the booking.' : 'Payment intent created successfully.'}</div>${response.checkoutUrl ? `<a class="btn btn-primary full-btn" href="${escapeHtml(response.checkoutUrl)}" target="_blank" rel="noopener">Open payment gateway</a>` : '<button type="button" class="btn btn-primary full-btn" data-close-modal>Done</button>'}`;
    } catch (error) { showToast(error.message || 'Unable to start payment.', 'error'); } finally { button.disabled = false; }
  });
}
$('#hotelForm')?.addEventListener('submit', event => { event.preventDefault(); void navigateToHotelSearch(); });
$('#homesForm')?.addEventListener('submit', event => { event.preventDefault(); const location = $('#homeDestination')?.value?.trim(); publicNavigate(`/homes${location ? `?q=${encodeURIComponent(location)}` : ''}`); });
$('#toursForm')?.addEventListener('submit', event => { event.preventDefault(); void searchTours(tourQueryFromForm()); });
$('#applyTourFilters')?.addEventListener('click', () => void searchTours(tourQueryFromFilters()));
$('#tourResultsSort')?.addEventListener('change', () => void searchTours(tourQueryFromFilters()));
$('#clearTourFilters')?.addEventListener('click', () => { const query = { destination: '', tourType: '', maxPrice: '', sort: 'newest' }; $('#tourFilterDestination').value = ''; $('#tourFilterType').value = ''; $('#tourFilterBudget').value = ''; $('#tourResultsSort').value = 'newest'; void searchTours(query); });
$('#closeTourResults')?.addEventListener('click', () => { $('#tourResultsSection').hidden = true; $('#searchPanel')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); });

let otpChallengeId = '';
let otpTimer = null;
let currentUser = null;
let notificationsCache = [];
function stopOtpCountdown() { if (otpTimer) clearInterval(otpTimer); otpTimer = null; }
function startOtpCountdown(seconds) {
  stopOtpCountdown();
  const button = $('#requestOtpBtn');
  const note = $('#otpCountdown');
  let remaining = seconds;
  const update = () => { if (note) note.textContent = remaining > 0 ? `You can request another code in ${remaining}s.` : 'You can request a new code.'; if (button) { button.disabled = remaining > 0; button.textContent = remaining > 0 ? `Code sent · ${remaining}s` : 'Resend verification code'; } if (remaining <= 0) stopOtpCountdown(); remaining -= 1; };
  update();
  otpTimer = setInterval(update, 1000);
}
function renderNotifications() {
  const list = $('#notificationList');
  const count = $('#notificationCount');
  if (!list || !count) return;
  const unread = notificationsCache.filter(item => !item.readAt).length;
  count.textContent = unread > 99 ? '99+' : String(unread);
  count.hidden = unread === 0;
  list.innerHTML = notificationsCache.length ? notificationsCache.map(item => `<button type="button" class="notification-item ${item.readAt ? 'read' : 'unread'}" data-notification-id="${escapeHtml(item.id)}"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.message)}</span><small>${new Date(item.createdAt).toLocaleString()}</small></button>`).join('') : '<div class="notification-empty">No notifications yet.</div>';
  $$('.notification-item', list).forEach(item => item.addEventListener('click', async () => { if (item.classList.contains('unread')) { await apiRequest(`/notifications/${item.dataset.notificationId}/read`, { method: 'PATCH' }).catch(() => undefined); await loadNotifications(); } }));
}
async function loadNotifications() { if (!currentUser) { notificationsCache = []; renderNotifications(); return; } try { const response = await apiRequest('/notifications'); notificationsCache = response.notifications || []; renderNotifications(); } catch { notificationsCache = []; renderNotifications(); } }
function openNotificationModal() { const modal = $('#genericModal'); const list = notificationsCache.length ? notificationsCache.map(item => `<button type="button" class="notification-item ${item.readAt ? 'read' : 'unread'}" data-notification-id="${escapeHtml(item.id)}"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.message)}</span><small>${new Date(item.createdAt).toLocaleString()}</small></button>`).join('') : '<div class="notification-empty">No notifications yet.</div>'; $('#modalContent').innerHTML = `<div class="modal-heading"><div class="modal-icon blue">${icon('i-bell')}</div><h2 id="modalTitle">Notifications</h2></div><div class="notification-modal-list">${list}</div><button type="button" class="btn btn-primary full-btn" data-close-modal>Close</button>`; openModal(modal); $$('.notification-item', modal).forEach(item => item.addEventListener('click', async () => { await apiRequest(`/notifications/${item.dataset.notificationId}/read`, { method: 'PATCH' }).catch(() => undefined); await loadNotifications(); openNotificationModal(); })); }
$('#notificationBtn')?.addEventListener('click', async event => { event.stopPropagation(); if (!currentUser) { openLogin(); return; } const panel = $('#notificationPanel'); panel.hidden = !panel.hidden; $('#notificationBtn').setAttribute('aria-expanded', String(!panel.hidden)); if (!panel.hidden) await loadNotifications(); });
$('#markNotificationsRead')?.addEventListener('click', async () => { await Promise.all(notificationsCache.filter(item => !item.readAt).map(item => apiRequest(`/notifications/${item.id}/read`, { method: 'PATCH' }).catch(() => undefined))); await loadNotifications(); });
document.addEventListener('click', event => { if (!event.target.closest('.notification-wrap')) { $('#notificationPanel')?.setAttribute('hidden', ''); $('#notificationBtn')?.setAttribute('aria-expanded', 'false'); } });

function updateAuthUi(user) {
  currentUser = user || null;
  window.SadikPages?.setUser(currentUser);
  const accountName = $('#sidebarAccountName');
  const accountMeta = $('#sidebarAccountMeta');
  if (accountName) accountName.textContent = currentUser ? (currentUser.fullName || 'Welcome back') : 'Welcome to Sadik Travels';
  if (accountMeta) accountMeta.textContent = currentUser ? (currentUser.email || currentUser.phone || 'Manage your trips') : 'Login to manage your trips';
  void loadNotifications();
  const label = currentUser ? 'My Account' : 'Login';
  const loginLabel = $('#loginBtn span');
  if (loginLabel) loginLabel.textContent = label;
  $('#mobileLoginBtn')?.setAttribute('aria-label', label);
  const sidebarLabel = $('#sidebarLogin');
  if (sidebarLabel) sidebarLabel.textContent = currentUser ? 'Account' : 'Login';
}
async function openAccount() {
  try {
    const [response, preferencesResponse] = await Promise.all([apiRequest('/bookings'), apiRequest('/account/preferences').catch(() => ({ preferences: {} }))]);
    const bookings = response.bookings || [];
    const preferences = preferencesResponse.preferences || {};
    const list = bookings.length ? bookings.slice(0, 5).map(item => `<div class="account-booking"><strong>${escapeHtml(item.vertical)}</strong><span>${escapeHtml(item.id)}</span><em>${escapeHtml(item.status)}</em></div>`).join('') : '<div class="result-summary">No bookings yet.</div>';
    const modal = $('#genericModal');
    $('#modalContent').innerHTML = `<div class="modal-heading"><div class="modal-icon blue">${icon('i-user')}</div><h2 id="modalTitle">My Account</h2></div><p class="modal-subtitle">${escapeHtml(currentUser?.phone || currentUser?.email || 'Signed-in traveller')}</p><div class="account-bookings"><h3>Recent bookings</h3>${list}</div><form id="preferenceForm" class="account-preferences"><h3>Communication preferences</h3><label><input type="checkbox" name="marketingEmailOptIn" ${preferences.marketingEmailOptIn !== false ? 'checked' : ''} /> Email marketing</label><label><input type="checkbox" name="marketingSmsOptIn" ${preferences.marketingSmsOptIn !== false ? 'checked' : ''} /> SMS marketing</label><label><input type="checkbox" name="marketingInAppOptIn" ${preferences.marketingInAppOptIn !== false ? 'checked' : ''} /> Website notifications</label><button class="btn btn-outline full-btn" type="submit">Save preferences</button></form><button class="btn btn-outline full-btn" id="logoutBtn">Logout</button>`;
    openModal(modal);
    $('#preferenceForm')?.addEventListener('submit', async event => { event.preventDefault(); const button = event.submitter; button.disabled = true; const form = new FormData(event.currentTarget); try { await apiRequest('/account/preferences', { method: 'PATCH', body: JSON.stringify({ marketingEmailOptIn: form.get('marketingEmailOptIn') === 'on', marketingSmsOptIn: form.get('marketingSmsOptIn') === 'on', marketingInAppOptIn: form.get('marketingInAppOptIn') === 'on' }) }); showToast('Communication preferences saved.', 'success'); } catch (error) { showToast(error.message || 'Unable to save preferences.', 'error'); } finally { button.disabled = false; } });
    $('#logoutBtn')?.addEventListener('click', async () => { await apiRequest('/auth/logout', { method: 'POST' }, false).catch(() => undefined); updateAuthUi(null); closeModal(modal); showToast('You have been logged out.'); });
  } catch (error) { if (error.status === 401) openLogin(); else showToast(error.message || 'Unable to load account.', 'error'); }
}
function handleLoginClick() { currentUser ? void openAccount() : openLogin(); }
function openLogin() { openModal($('#loginModal')); $('#loginIdentity')?.focus(); }
$('#loginBtn')?.addEventListener('click', handleLoginClick);
$('#mobileLoginBtn')?.addEventListener('click', handleLoginClick);

$('#sidebarLogin')?.addEventListener('click', () => { if (window.innerWidth < 1024) closeSidebar(); currentUser ? void openAccount() : openLogin(); });
$('#requestOtpBtn')?.addEventListener('click', async () => {
  const identity = $('#loginIdentity')?.value.trim();
  if (!identity) { showToast('Enter your mobile number or email first.', 'error'); return; }
  try {
    const response = await apiRequest('/auth/request-otp', { method: 'POST', body: JSON.stringify({ identity }) });
    otpChallengeId = response.challengeId;
    $('#otpStep').hidden = false;
    $('#loginOtp').required = true;
    $('#authNote').textContent = `Code sent to ${response.maskedDestination}. It expires in 5 minutes.`;
    if (response.devCode) $('#authNote').textContent += ` Development code: ${response.devCode}`;
    startOtpCountdown(60);
    $('#loginOtp')?.focus();
  } catch (error) { showToast(error.code === 'SMS_NOT_CONFIGURED' ? 'BulkSMSBD is not configured on the backend.' : error.code === 'EMAIL_NOT_CONFIGURED' ? 'SMTP email is not configured on the backend.' : (error.message || 'Unable to send OTP.'), 'error'); }
});
$('#changeIdentityBtn')?.addEventListener('click', () => { otpChallengeId = ''; stopOtpCountdown(); $('#otpStep').hidden = true; $('#loginOtp').required = false; $('#requestOtpBtn').disabled = false; $('#requestOtpBtn').textContent = 'Send verification code'; $('#otpCountdown').textContent = ''; $('#authNote').textContent = 'We’ll send a secure OTP. Your account is created automatically on first login.'; $('#loginIdentity')?.focus(); });
$('#loginForm')?.addEventListener('submit', async event => {
  event.preventDefault();
  if (!otpChallengeId) { showToast('Request a verification code first.', 'error'); return; }
  try {
    const response = await apiRequest('/auth/verify-otp', { method: 'POST', body: JSON.stringify({ challengeId: otpChallengeId, code: $('#loginOtp').value.trim() }) });
    stopOtpCountdown();
    closeModal($('#loginModal'));
    updateAuthUi(response.user);
    showToast('Welcome back to Sadik Travels.', 'success');
    $('#requestOtpBtn').disabled = false;
  } catch (error) { showToast(error.message || 'Unable to verify OTP.', 'error'); }
});
$('#forgotPassword')?.addEventListener('click', () => showToast('Sadik Travels uses passwordless OTP login. Contact support if you cannot access your number or email.'));
$('#createAccount')?.addEventListener('click', () => { showToast('New accounts are created automatically after OTP verification.'); $('#loginIdentity')?.focus(); });

/* ------------------------------------------------------ customer Google login */
let customerFirebaseAuth = null;
let firebaseSdkPromise = null;
function loadFirebaseSdk() {
  if (firebaseSdkPromise) return firebaseSdkPromise;
  firebaseSdkPromise = new Promise((resolve, reject) => {
    if (window.firebase?.auth) { resolve(window.firebase); return; }
    let loaded = 0;
    const scripts = [
      'https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js',
      'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth-compat.js'
    ];
    const fail = (error) => reject(error || new Error('Google sign-in libraries failed to load.'));
    scripts.forEach(src => {
      const tag = document.createElement('script');
      tag.src = src; tag.async = true;
      tag.onload = () => { loaded += 1; if (loaded === scripts.length) resolve(window.firebase); };
      tag.onerror = fail;
      document.head.appendChild(tag);
    });
  });
  return firebaseSdkPromise;
}
async function ensureCustomerFirebaseAuth() {
  if (customerFirebaseAuth) return customerFirebaseAuth;
  const config = await apiRequest('/site/firebase-config', {}, false);
  if (!config || !config.configured || !config.firebase || !config.firebase.apiKey) {
    throw Object.assign(new Error('Google sign-in is not configured for this website.'), { code: 'FIREBASE_NOT_CONFIGURED' });
  }
  const firebase = await loadFirebaseSdk();
  if (!firebase || !firebase.auth) throw Object.assign(new Error('Google sign-in libraries failed to load.'), { code: 'FIREBASE_SDK_MISSING' });
  const app = firebase.apps.length ? firebase.apps[0] : firebase.initializeApp(config.firebase);
  customerFirebaseAuth = firebase.auth(app);
  try { customerFirebaseAuth.useDeviceLanguage(); } catch { /* best effort */ }
  return customerFirebaseAuth;
}
async function loginWithGoogle() {
  const button = $('#googleLoginBtn');
  const label = button?.querySelector('span');
  const original = label ? label.textContent : '';
  if (button) { button.disabled = true; }
  if (label) label.textContent = 'Signing in…';
  try {
    const auth = await ensureCustomerFirebaseAuth();
    const provider = new window.firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    const result = await auth.signInWithPopup(provider);
    const idToken = await result.user.getIdToken();
    const response = await apiRequest('/auth/google-login', { method: 'POST', body: JSON.stringify({ idToken }) });
    updateAuthUi(response.user);
    closeModal($('#loginModal'));
    showToast('Signed in with Google.', 'success');
    void renderPublicRoute();
  } catch (error) {
    if (error?.code === 'auth/popup-closed-by-user' || error?.code === 'auth/cancelled-popup-request') return;
    if (error?.code === 'auth/popup-blocked') showToast('Please allow pop-ups and try again.', 'error');
    else if (error?.code === 'FIREBASE_NOT_CONFIGURED' || error?.code === 'FIREBASE_SDK_MISSING') showToast(error.message || 'Google sign-in is unavailable.', 'error');
    else if (error?.code && String(error.code).startsWith('auth/')) showToast('Google sign-in failed. Please try again.', 'error');
    else showToast(error?.message || 'Unable to sign in with Google.', 'error');
  } finally {
    if (button) button.disabled = false;
    if (label) label.textContent = original || 'Continue with Google';
  }
}
$('#googleLoginBtn')?.addEventListener('click', loginWithGoogle);

$('#chatBubble')?.addEventListener('click', openChat);
$('#supportBtn')?.addEventListener('click', openChat);
$('#supportSideBtn')?.addEventListener('click', () => { if (window.innerWidth < 1024) closeSidebar(); openChat(); });
$('#trackBookingBtn')?.addEventListener('click', (event) => { event.preventDefault(); event.stopImmediatePropagation(); navigateToSection('track-booking'); });
$('#trackCtaBtn')?.addEventListener('click', () => { if (window.innerWidth < 1024) closeSidebar(); openTemplateModal('trackTemplate'); });

$$('[data-close-modal]').forEach(button => button.addEventListener('click', () => closeModal(button.closest('.modal'))));
document.addEventListener('click', event => {
  const closeButton = event.target.closest('[data-close-modal]');
  if (closeButton) closeModal(closeButton.closest('.modal'));
  if (event.target.classList.contains('modal')) closeModal(event.target);
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    document.querySelectorAll('.modal:not([hidden])').forEach(closeModal);
    if (window.innerWidth < 1024 && $('#travelSidebar')?.classList.contains('open')) closeSidebar();
  }
  const sidebar = $('#travelSidebar');
  if (event.key === 'Tab' && window.innerWidth < 1024 && sidebar?.classList.contains('open')) {
    const focusable = $$('a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])', sidebar);
    if (!focusable.length) return;
    const first = focusable[0]; const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
});

function openHotelDetails(title) {
  const modal = $('#genericModal');
  $('#modalContent').innerHTML = `<div class="modal-heading"><div class="modal-icon blue">${icon('i-hotel')}</div><h2 id="modalTitle">${escapeHtml(title)}</h2></div><p class="modal-subtitle">Featured hotel inspiration from Sadik Travels.</p><div class="result-summary"><strong>Promotional information</strong><br><span>Availability, room rates and booking confirmation come only from the configured live hotel provider. This card does not represent live inventory.</span></div><button type="button" class="btn btn-primary full-btn" id="hotelBookCta">Search live rooms</button>`;
  openModal(modal);
  $('#hotelBookCta')?.addEventListener('click', () => { closeModal(modal); activateTab('hotels', true); showToast('Hotel search is ready. Submit your dates to request live availability.'); });
}
function bindPromotionalInteractions(scope = document) {
  $$('.travel-card', scope).forEach(card => { if (card.dataset.interactionBound) return; card.dataset.interactionBound = 'true'; card.addEventListener('click', event => { event.preventDefault(); openHotelDetails(card.dataset.cardTitle || card.textContent.trim()); }); });
  $$('.destination-card', scope).forEach(card => { if (card.dataset.interactionBound) return; card.dataset.interactionBound = 'true'; card.addEventListener('click', event => { event.preventDefault(); showToast(`Destination selected: ${card.dataset.destination}.`); activateTab('hotels', true); if ($('#hotelDestination')) $('#hotelDestination').value = card.dataset.destination; }); });
  $$('.banner-slide', scope).forEach(slide => { if (slide.dataset.liveBanner || slide.dataset.interactionBound) return; slide.dataset.interactionBound = 'true'; slide.addEventListener('click', event => { event.preventDefault(); showToast(`${slide.querySelector('img')?.alt || 'Offer'} selected.`); }); });
}
bindPromotionalInteractions();

let sidebarReturnFocus = null;
let desktopSidebarCollapsed = false;
function syncSidebarState(open) {
  const sidebar = $('#travelSidebar');
  const backdrop = $('#pageBackdrop');
  const desktop = window.innerWidth >= 1024;
  if (!sidebar) return;
  const visible = desktop ? !desktopSidebarCollapsed : open;
  sidebar.classList.toggle('open', visible);
  sidebar.classList.toggle('desktop-collapsed', desktop && desktopSidebarCollapsed);
  sidebar.setAttribute('aria-hidden', String(!visible));
  if (backdrop) backdrop.hidden = desktop || !open;
  document.body.classList.toggle('sidebar-open', !desktop && open);
  document.body.classList.toggle('desktop-sidebar-collapsed', desktop && desktopSidebarCollapsed);
  $('#menuToggle')?.setAttribute('aria-expanded', String(visible));
  $('#menuToggle')?.setAttribute('aria-label', visible ? 'Close menu' : 'Open menu');
  if (!desktop && open) $('#sidebarClose')?.focus();
  if (!open && sidebarReturnFocus && !desktop) { sidebarReturnFocus.focus?.(); sidebarReturnFocus = null; }
}
function openSidebar() {
  sidebarReturnFocus = document.activeElement;
  if (window.innerWidth >= 1024) desktopSidebarCollapsed = false;
  syncSidebarState(true);
}
function closeSidebar() {
  if (window.innerWidth >= 1024) { desktopSidebarCollapsed = true; syncSidebarState(false); return; }
  syncSidebarState(false);
}
function toggleSidebar() {
  if (window.innerWidth >= 1024) { desktopSidebarCollapsed = !desktopSidebarCollapsed; syncSidebarState(!desktopSidebarCollapsed); return; }
  const open = $('#travelSidebar')?.classList.contains('open');
  open ? closeSidebar() : openSidebar();
}
$('#menuToggle')?.addEventListener('click', toggleSidebar);
$('#sidebarClose')?.addEventListener('click', closeSidebar);
$('#pageBackdrop')?.addEventListener('click', closeSidebar);
window.addEventListener('resize', () => syncSidebarState(false));
syncSidebarState(false);

function visibleCount(kind) {
  if (kind === 'banners') return window.innerWidth <= 560 ? 1 : window.innerWidth <= 1000 ? 2 : 3;
  if (kind === 'destinations') return window.innerWidth <= 560 ? 2 : window.innerWidth <= 900 ? 3 : 5;
  return window.innerWidth <= 560 ? 1 : window.innerWidth <= 900 ? 2 : 3;
}

function updateBannerSlider() {
  const track = $('#bannerTrack');
  if (!track) return;
  const slides = $$('.banner-slide', track);
  const dots = $('#bannerDots');
  if (!slides.length) { track.style.transform = 'none'; if (dots) dots.innerHTML = ''; return; }
  const visible = visibleCount('banners');
  const max = Math.max(0, slides.length - visible);
  state.bannerIndex = Math.max(0, Math.min(max, state.bannerIndex));
  const slideWidth = slides[0]?.getBoundingClientRect().width || 0;
  track.style.transform = `translateX(-${state.bannerIndex * (slideWidth + 14)}px)`;
  const pageCount = max + 1;
  dots.innerHTML = Array.from({ length: Math.min(pageCount, 8) }, (_, i) => `<button type="button" aria-label="Go to banner ${i + 1}" class="${i === Math.min(state.bannerIndex, 7) ? 'active' : ''}"></button>`).join('');
  $$('button', dots).forEach((button, i) => button.addEventListener('click', () => { state.bannerIndex = Math.min(i, max); updateBannerSlider(); }));
}
function moveBanner(direction) { state.bannerIndex += direction; updateBannerSlider(); }
$('[data-slider-prev="banners"]')?.addEventListener('click', () => moveBanner(-1));
$('[data-slider-next="banners"]')?.addEventListener('click', () => moveBanner(1));

const cardTrackMap = { hotels: '#hotelTrack', transit: '#transitTrack', destinations: '#destinationTrack' };
function updateCardSlider(kind) {
  const track = $(cardTrackMap[kind]);
  if (!track) return;
  const cards = [...track.children];
  const visible = visibleCount(kind);
  const max = Math.max(0, cards.length - visible);
  state.cardIndexes[kind] = Math.max(0, Math.min(max, state.cardIndexes[kind] || 0));
  const gap = 14;
  const cardWidth = cards[0]?.getBoundingClientRect().width || 0;
  track.style.transform = `translateX(-${state.cardIndexes[kind] * (cardWidth + gap)}px)`;
}
$$('[data-card-prev]').forEach(button => button.addEventListener('click', () => { const kind = button.dataset.cardPrev; state.cardIndexes[kind] = (state.cardIndexes[kind] || 0) - 1; updateCardSlider(kind); }));
$$('[data-card-next]').forEach(button => button.addEventListener('click', () => { const kind = button.dataset.cardNext; state.cardIndexes[kind] = (state.cardIndexes[kind] || 0) + 1; updateCardSlider(kind); }));

function updateAllSliders() { updateBannerSlider(); Object.keys(cardTrackMap).forEach(updateCardSlider); }
window.addEventListener('resize', updateAllSliders);
window.addEventListener('load', updateAllSliders);
setTimeout(updateAllSliders, 80);

const bannerSlider = $('.banner-slider');
bannerSlider?.addEventListener('mouseenter', () => clearInterval(state.autoBanner));
bannerSlider?.addEventListener('mouseleave', () => startBannerAutoplay());
function startBannerAutoplay() {
  clearInterval(state.autoBanner);
  state.autoBanner = setInterval(() => {
    const slides = $$('.banner-slide');
    const max = Math.max(0, slides.length - visibleCount('banners'));
    state.bannerIndex = state.bannerIndex >= max ? 0 : state.bannerIndex + 1;
    updateBannerSlider();
  }, 5600);
}
startBannerAutoplay();

window.addEventListener('scroll', () => $('#siteHeader')?.classList.toggle('scrolled', window.scrollY > 30));
$('#currencyBtn')?.addEventListener('click', () => showToast('Currency selector: BDT is currently selected.'));
$$('a[href^="#"]').forEach(link => {
  link.addEventListener('click', event => {
    const target = link.getAttribute('href');
    if (target === '#' || !document.querySelector(target)) {
      if (!link.closest('.nav-links') && !link.closest('.travel-tab')) {
        event.preventDefault();
        showToast('This destination is ready for your content or live API connection.');
      }
    }
  });
});

const PUBLIC_COLLECTIONS = {
  offers: { type: 'offer', eyebrow: 'Offers', title: 'Travel Offers', description: 'Published offers from Sadik Travels.' },
  'holiday-packages': { type: 'holiday_package', eyebrow: 'Holidays', title: 'Holiday Packages', description: 'Browse published holiday packages and complete itineraries.' },
  explore: { type: 'explore', eyebrow: 'Explore', title: 'Explore Destinations', description: 'Published destinations, travel tips and inspiration.' },
  hotels: { type: 'hotel', eyebrow: 'Stays', title: 'Hotels', description: 'Published hotel content and stay information.' },
  homes: { type: 'home', eyebrow: 'Properties', title: 'Homes & Villas', description: 'Published homes and property information.' }
};

function publicRoute() { const url = new URL(location.href); const path = url.pathname.replace(/\/+$/, '') || '/'; return { url, path, parts: path.split('/').filter(Boolean), query: url.searchParams }; }
function publicHref(route) { return route.startsWith('/') ? route : `/${route}`; }
function publicSetActive(path) {
  const links = $$('[data-public-route]');
  const current = new URL(location.href);
  let best = null;
  let score = -1;

  links.forEach(link => {
    const targetUrl = new URL(link.dataset.publicRoute || link.getAttribute('href'), location.origin);
    const targetPath = targetUrl.pathname.replace(/\/+$/, '') || '/';
    const pathMatches = targetPath === '/' ? path === '/' : path === targetPath || path.startsWith(`${targetPath}/`);
    // Query-specific links (for example Account → Payments) are only active
    // for their exact tab. This prevents two unrelated account links looking active.
    const queryMatches = !targetUrl.search || targetUrl.search === current.search;
    const active = pathMatches && queryMatches;
    const linkScore = targetPath.length + (targetUrl.search ? 10_000 : 0);
    if (active && linkScore > score) { best = link; score = linkScore; }
  });

  links.forEach(link => link.classList.toggle('active', link === best));
}
function publicLoading() { return '<div class="public-public-loading"><span class="spinner"></span>Loading content…</div>'; }
function publicErrorState(message, retry = true) { return `<div class="public-public-error"><strong>Unable to load this page</strong><p>${escapeHtml(message || 'Please try again.')}</p>${retry ? '<button class="btn btn-primary" data-public-retry>Try again</button>' : ''}</div>`; }
function publicEmptyState(title, message, action = '') { return `<div class="public-public-empty"><strong>${escapeHtml(title)}</strong><p>${escapeHtml(message)}</p>${action}</div>`; }
function publicPageHeader(eyebrow, title, description, action = '') { return `<div class="public-page-header"><div><span class="public-page-eyebrow">${escapeHtml(eyebrow)}</span><h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p></div><div class="public-page-actions">${action}<a class="btn btn-outline" href="/" data-public-route="/">Back home</a></div></div>`; }
const CONTAINED_PUBLIC_ROUTES = new Set(['hotels', 'tours', 'travel-agents', 'travels-agents']);
function wrapPublicRouteContent(root) {
  if (!root || root.firstElementChild?.classList?.contains('page-container')) return;
  const wrapper = document.createElement('div');
  wrapper.className = 'page-container';
  while (root.firstChild) wrapper.appendChild(root.firstChild);
  root.appendChild(wrapper);
}
function publicContentPath(item) { return { hotel:'hotels', home:'homes', offer:'offers', holiday_package:'holiday-packages', destination:'explore', explore:'explore' }[item.type] || 'explore'; }
function publicImage(imageUrl, alt, className = '') { return imageUrl ? `<img class="${className}" src="${escapeHtml(imageUrl)}" alt="${escapeHtml(alt)}" loading="lazy" />` : `<div class="public-page-item-image">Sadik Travels</div>`; }
function publicContentCard(item) { const route = `/${publicContentPath(item)}/${item.id}`; const price = item.metadata?.price || item.metadata?.priceBdt; return `<a class="public-page-item" href="${escapeHtml(route)}" data-public-route="${escapeHtml(route)}"><div class="public-page-item-image">${item.imageUrl ? `<img src="${escapeHtml(item.imageUrl)}" alt="${escapeHtml(item.title)}" loading="lazy" />` : '<span>Sadik Travels</span>'}</div><div class="public-page-item-body"><small>${escapeHtml(String(item.type).replace(/_/g, ' '))}</small><h2>${escapeHtml(item.title)}</h2><p>${escapeHtml(item.subtitle || item.description || 'View published details.')}</p>${price ? `<strong>৳${escapeHtml(Number(price).toLocaleString('en-BD'))}</strong>` : ''}</div></a>`; }
function publicMetadataHtml(metadata = {}) {
  const entries = Object.entries(metadata || {}).filter(([key, value]) => value !== undefined && value !== null && value !== '' && !['ctaUrl','external','androidUrl','iosUrl','price','priceBdt','ctaLabel','buttonLabel'].includes(key));
  if (!entries.length) return '';
  const formatVal = (value) => {
    if (Array.isArray(value)) return value.map(item => typeof item === 'object' && item ? (item.title || item.detail || item.name || Object.values(item).filter(Boolean).join(' — ')) : String(item)).filter(Boolean).join(', ');
    if (value && typeof value === 'object') return Object.entries(value).map(([k, v]) => `${k}: ${v}`).join(', ');
    return String(value);
  };
  const price = metadata.price || metadata.priceBdt;
  return `<div class="public-detail-json"><h3>Details</h3>${price ? `<p class="public-detail-price"><strong>From ৳${Number(price).toLocaleString('en-BD')}</strong></p>` : ''}<dl class="public-detail-meta">${entries.map(([key,value]) => `<div><dt>${escapeHtml(key.replace(/([A-Z])/g,' $1').replace(/_/g,' ').replace(/^./,letter=>letter.toUpperCase()))}</dt><dd>${escapeHtml(formatVal(value))}</dd></div>`).join('')}</dl></div>`;
}
function publicDetailActions(item) { const metadata = item.metadata || {}; const actions = []; if (metadata.ctaUrl && (String(metadata.ctaUrl).startsWith('/') || /^https?:\/\//i.test(String(metadata.ctaUrl)))) actions.push(`<a class="btn btn-primary" href="${escapeHtml(metadata.ctaUrl)}" ${metadata.external ? 'target="_blank" rel="noopener"' : ''}>${escapeHtml(metadata.ctaText || 'Learn more')}</a>`); actions.push('<a class="btn btn-outline" href="#contact">Contact Sadik Travels</a>'); return actions.join(''); }
async function renderPublicContentCollection(root, definition) { root.innerHTML = publicPageHeader(definition.eyebrow, definition.title, definition.description, '') + `<section class="public-page-card" id="publicCollectionBody">${publicLoading()}</section>`; const body = root.querySelector('#publicCollectionBody'); try { const response = await apiRequest(`/site/content?type=${encodeURIComponent(definition.type)}`); const items = response.content || []; body.innerHTML = `<div class="public-page-grid">${items.length ? items.map(publicContentCard).join('') : publicEmptyState(`No ${definition.title.toLowerCase()} yet`, 'Published content will appear here after an administrator saves and publishes it.')}</div>`; } catch (error) { body.innerHTML = publicErrorState(error?.status === 503 ? 'This catalogue is temporarily unavailable. Please try again in a moment.' : (error.message || 'Unable to load this catalogue.')); body.querySelector('[data-public-retry]')?.addEventListener('click', () => void renderPublicRoute()); } }
async function renderPublicContentDetail(root, definition, id) { const response = await apiRequest(`/site/content/${encodeURIComponent(definition.type)}/${encodeURIComponent(id)}`); const item = response.content; if (!item) throw new Error('Content not found'); root.innerHTML = publicPageHeader(definition.eyebrow, item.title, item.subtitle || definition.description, '') + `<section class="public-page-card"><div class="public-detail"><div>${item.imageUrl ? `<img class="public-detail-image" src="${escapeHtml(item.imageUrl)}" alt="${escapeHtml(item.title)}" />` : publicEmptyState('No image published','This item does not have an image yet.')}<div class="public-detail-json"><h3>About this service</h3><p class="lead">${escapeHtml(item.description || item.subtitle || 'Published Sadik Travels content.')}</p></div></div><div><h2>${escapeHtml(item.title)}</h2><p class="lead">${escapeHtml(item.subtitle || '')}</p>${publicMetadataHtml(item.metadata)}<div class="public-detail-actions">${publicDetailActions(item)}</div></div></div></section>`; }
async function openTourCheckoutWizard(tour) {
  const modal = $('#genericModal');
  const meta = tour.metadata || {};
  const itinerary = Array.isArray(meta.itinerary) ? meta.itinerary : [];
  const inclusions = Array.isArray(meta.inclusions) ? meta.inclusions : [];
  const exclusions = Array.isArray(meta.exclusions) ? meta.exclusions : [];
  const notes = meta.notes || meta.policies || '';
  $('#modalContent').innerHTML = `<div class="tour-detail-modal">
    <div class="wizard-steps"><span class="on">1 Travellers</span><span>2 Price</span><span>3 Pay</span></div>
    <h2 id="modalTitle">${escapeHtml(tour.title)}</h2>
    <div class="tour-tabs">
      <button type="button" class="active" data-ttab="it">Itinerary</button>
      <button type="button" data-ttab="in">Inclusions</button>
      <button type="button" data-ttab="no">Notes</button>
    </div>
    <div class="tour-tab-panel" data-tpanel="it">${itinerary.length ? itinerary.map((d,i)=>`<p><strong>Day ${i+1}.</strong> ${escapeHtml(typeof d==='string'?d:(d.title||d.detail||''))}</p>`).join('') : `<p>${escapeHtml(tour.description || 'Day-by-day itinerary will appear here when published.')}</p>`}</div>
    <div class="tour-tab-panel" data-tpanel="in" hidden><p><strong>Includes</strong></p><ul>${(inclusions.length?inclusions:['Hotel stay','Breakfast','Airport transfer']).map(x=>`<li>${escapeHtml(x)}</li>`).join('')}</ul><p><strong>Excludes</strong></p><ul>${(exclusions.length?exclusions:['Personal expenses','Optional activities']).map(x=>`<li>${escapeHtml(x)}</li>`).join('')}</ul></div>
    <div class="tour-tab-panel" data-tpanel="no" hidden><p>${escapeHtml(notes || 'Standard Sadik Travels booking and cancellation policies apply. VAT 15% and AIT 5% are added at checkout.')}</p></div>
    <form id="tourBookForm">
      <label class="modal-field"><span>Adults</span><input id="tourAdults" type="number" min="1" max="30" value="2" required /></label>
      <label class="modal-field"><span>Children</span><input id="tourChildren" type="number" min="0" max="20" value="0" /></label>
      <label class="modal-field"><span>Infants</span><input id="tourInfants" type="number" min="0" max="10" value="0" /></label>
      <label class="modal-field"><span>Travel date</span><input id="tourTravelDate" type="date" required /></label>
      <label class="modal-field"><span>Promo code</span><input id="tourPromo" placeholder="Optional" /></label>
      <div class="result-summary" id="tourQuoteBox">Calculating…</div>
      <button class="btn btn-primary full-btn" type="submit">Confirm booking</button>
    </form>
  </div>`;
  openModal(modal);
  $$('[data-ttab]', modal).forEach(btn => btn.addEventListener('click', () => {
    $$('[data-ttab]', modal).forEach(b => b.classList.toggle('active', b === btn));
    $$('[data-tpanel]', modal).forEach(p => { p.hidden = p.dataset.tpanel !== btn.dataset.ttab; });
  }));
  const refreshQuote = async () => {
    try {
      const q = await apiRequest('/tours/quote', { method: 'POST', body: JSON.stringify({ tourId: tour.id, adults: Number($('#tourAdults').value)||1, children: Number($('#tourChildren').value)||0, infants: Number($('#tourInfants').value)||0, promoCode: $('#tourPromo').value || undefined }) });
      const b = q.quote;
      $('#tourQuoteBox').innerHTML = `<strong>৳${Number(b.total).toLocaleString('en-BD')}</strong><br><span>Base ৳${b.baseFare.toLocaleString('en-BD')} · VAT ${b.vatPct}% ৳${b.vat.toLocaleString('en-BD')} · AIT ${b.aitPct}% ৳${b.ait.toLocaleString('en-BD')}${b.discount?` · Promo −৳${b.discount.toLocaleString('en-BD')}`:''}</span>${b.emi?.length?`<br><small>EMI from ৳${b.emi[0].installment.toLocaleString('en-BD')} / mo</small>`:''}`;
      return b;
    } catch (error) { $('#tourQuoteBox').textContent = error.message || 'Unable to price this tour.'; return null; }
  };
  ['tourAdults','tourChildren','tourInfants','tourPromo'].forEach(id => $(`#${id}`)?.addEventListener('change', () => void refreshQuote()));
  void refreshQuote();
  $('#tourBookForm')?.addEventListener('submit', async event => {
    event.preventDefault();
    try {
      const quote = await refreshQuote();
      const response = await apiRequest('/bookings', { method: 'POST', body: JSON.stringify({ vertical: 'tour', payload: { tourId: tour.id, slug: tour.slug, title: tour.title, travellers: Number($('#tourAdults').value)||1, adults: Number($('#tourAdults').value)||1, children: Number($('#tourChildren').value)||0, infants: Number($('#tourInfants').value)||0, travelDate: $('#tourTravelDate').value, priceBdt: tour.priceBdt, quotedTotal: quote?.total, promoCode: $('#tourPromo').value.trim() || undefined } }) });
      closeModal(modal);
      try {
        const pay = await apiRequest('/initiate-payment', { method: 'POST', body: JSON.stringify({ bookingId: response.booking.id, kind: 'tour' }) });
        if (pay.checkoutUrl) { window.location.href = pay.checkoutUrl; return; }
      } catch { /* fall through to operator review */ }
      openBookingNextSteps(response.booking);
    } catch (error) { if (error.status === 401 || error.code === 'AUTH_REQUIRED') { closeModal(modal); openLogin(); showToast('Please login to book this tour.'); } else showToast(error.message || 'Unable to create tour booking.', 'error'); }
  });
}

async function renderPublicTours(root, id = '') {
  if (id) {
    const response = await apiRequest(`/tours/${encodeURIComponent(id)}`);
    const tour = response.tour;
    if (!tour) throw new Error('Tour not found');
    trackAnalytics('tour_view', { id: tour.id, country: tour.country });
    setSeo({ title: tour.title, description: `${tour.durationDays} days / ${tour.durationNights} nights in ${tour.country} — book with Sadik Travels.`, canonical: `/tours/${tour.id}`, image: tour.imageUrl, jsonLd: { '@context': 'https://schema.org', '@type': 'TouristTrip', name: tour.title, description: tour.description || undefined, touristType: tour.tourType } });
    const metadata = tour.metadata || {};
    root.innerHTML = publicPageHeader('Go Get Tour', tour.title, `${tour.durationDays} days / ${tour.durationNights} nights · ${tour.country}`, '') + `<section class="public-page-card"><div class="public-detail"><div>${tour.imageUrl ? `<img class="public-detail-image" src="${escapeHtml(tour.imageUrl)}" alt="${escapeHtml(tour.title)}" />` : publicEmptyState('No image published','This package does not have an image yet.')}<div class="public-detail-json"><h3>Package description</h3><p class="lead">${escapeHtml(tour.description || 'Published tour package details.')}</p></div></div><div><h2>${escapeHtml(tour.title)}</h2><p class="lead">${escapeHtml(tour.destinations.join(' · '))}</p><div class="public-detail-meta"><div><dt>Duration</dt><dd>${tour.durationDays} days / ${tour.durationNights} nights</dd></div><div><dt>Starting price</dt><dd>From ${tourMoney(tour.priceBdt)}/person</dd></div></div>${publicMetadataHtml(metadata)}<div class="public-detail-actions"><button type="button" class="btn btn-primary" data-public-tour-book="${escapeHtml(tour.id)}">Book this tour</button><a class="btn btn-outline" href="#contact">Contact Sadik Travels</a></div></div></div></section>`;
    $('#publicRouteRoot [data-public-tour-book]')?.addEventListener('click',()=>{ void openTourCheckoutWizard(tour); });
    return;
  }

  const query = publicRoute().query;
  const toursState = {
    q: query.get('q') || '',
    destination: query.get('destination') || '',
    tourType: query.get('tour_type') || '',
    minPrice: query.get('min_price') || '',
    maxPrice: query.get('max_price') || '',
    sort: ['price_asc','price_desc','newest'].includes(query.get('sort')) ? query.get('sort') : 'newest'
  };

  function buildQuery() {
    const p = new URLSearchParams();
    if (toursState.q) p.set('q', toursState.q);
    if (toursState.destination) p.set('destination', toursState.destination);
    if (toursState.tourType) p.set('tour_type', toursState.tourType);
    if (toursState.minPrice) p.set('min_price', toursState.minPrice);
    if (toursState.maxPrice) p.set('max_price', toursState.maxPrice);
    if (toursState.sort && toursState.sort !== 'newest') p.set('sort', toursState.sort);
    return p.toString();
  }

  function tourCardHtml(tour) {
    return `<a class="tour-card" href="/tours/${escapeHtml(tour.id)}" data-public-route="/tours/${escapeHtml(tour.id)}">
      <div class="tour-card-media">${tour.imageUrl ? `<img src="${escapeHtml(tour.imageUrl)}" alt="${escapeHtml(tour.title)}" loading="lazy" />` : '<span class="tour-card-noimg">Sadik Travels</span>'}<span class="tour-card-type">${escapeHtml(tour.tourType || 'Tour')}</span></div>
      <div class="tour-card-body">
        <h3>${escapeHtml(tour.title)}</h3>
        <p class="tour-card-dest">${icon('i-location')} ${escapeHtml((tour.destinations || []).join(' · ') || tour.country)}</p>
        <p class="tour-card-desc">${escapeHtml((tour.description || '').slice(0, 110))}${(tour.description || '').length > 110 ? '…' : ''}</p>
        <div class="tour-card-foot">
          <div class="tour-card-meta"><span>${icon('i-calendar')} ${tour.durationDays}d / ${tour.durationNights}n</span></div>
          <div class="tour-card-price"><small>From</small><strong>${tourMoney(tour.priceBdt)}</strong><span>/person</span></div>
        </div>
        <span class="tour-card-cta">View package <span>→</span></span>
      </div>
    </a>`;
  }

  function shellMarkup() {
    return publicPageHeader('Tours', 'Tour packages', 'Search and book curated Bangladesh and international tour packages with transparent pricing.', '') + `
      <section class="public-page-card tours-toolbar-card">
        <form class="tours-toolbar" id="toursSearchForm">
          <label class="tours-field tours-field-grow"><span>Search</span><input type="search" id="toursQ" value="${escapeHtml(toursState.q)}" placeholder="Search tours, destinations…" /></label>
          <label class="tours-field"><span>Destination</span><input type="text" id="toursDest" value="${escapeHtml(toursState.destination)}" placeholder="Country or city" /></label>
          <label class="tours-field"><span>Tour type</span><input type="text" id="toursType" value="${escapeHtml(toursState.tourType)}" placeholder="e.g. Adventure" /></label>
          <label class="tours-field tours-field-price"><span>Min price</span><input type="number" id="toursMin" value="${escapeHtml(toursState.minPrice)}" min="0" placeholder="0" /></label>
          <label class="tours-field tours-field-price"><span>Max price</span><input type="number" id="toursMax" value="${escapeHtml(toursState.maxPrice)}" min="0" placeholder="200000" /></label>
          <label class="tours-field"><span>Sort by</span><select id="toursSort"><option value="newest" ${toursState.sort==='newest'?'selected':''}>Newest</option><option value="price_asc" ${toursState.sort==='price_asc'?'selected':''}>Price: low to high</option><option value="price_desc" ${toursState.sort==='price_desc'?'selected':''}>Price: high to low</option></select></label>
          <div class="tours-toolbar-actions"><button class="btn btn-primary" type="submit">Search</button><button class="btn btn-outline" type="button" id="toursReset">Reset</button></div>
        </form>
      </section>
      <section class="public-page-card" id="toursListBody">${publicLoading()}</section>`;
  }

  root.innerHTML = shellMarkup();
  wrapPublicRouteContent(root);
  const toursBody = root.querySelector('#toursListBody');

  async function loadTours() {
    toursBody.innerHTML = `<div class="tours-grid">${Array.from({length:6},()=>'<div class="tour-card tour-card-skeleton"></div>').join('')}</div>`;
    let tours = [];
    try {
      const qs = buildQuery();
      const response = await apiRequest(`/tours${qs ? `?${qs}` : ''}`);
      tours = response.tours || [];
    } catch (error) {
      toursBody.innerHTML = publicErrorState(error?.status === 503 ? 'Tour packages are temporarily unavailable. Please try again in a moment.' : (error.message || 'Unable to load tour packages.'));
      toursBody.querySelector('[data-public-retry]')?.addEventListener('click', () => void renderPublicRoute());
      return;
    }
    if (!tours.length) {
      toursBody.innerHTML = publicEmptyState('No tours match your search', 'Try a different destination, price range or tour type.', '<button class="btn btn-outline" type="button" id="toursClearFilters">Clear filters</button>');
      root.querySelector('#toursClearFilters')?.addEventListener('click', () => { Object.assign(toursState,{q:'',destination:'',tourType:'',minPrice:'',maxPrice:'',sort:'newest'}); publicNavigate('/tours'); });
      return;
    }
    toursBody.innerHTML = `<p class="result-summary">Showing <strong>${tours.length}</strong> tour package${tours.length===1?'':'s'}</p><div class="tours-grid">${tours.map(tourCardHtml).join('')}</div>`;
  }

  function bindToolbar() {
    const form = root.querySelector('#toursSearchForm');
    form?.addEventListener('submit', event => {
      event.preventDefault();
      Object.assign(toursState, {
        q: $('#toursQ').value.trim(),
        destination: $('#toursDest').value.trim(),
        tourType: $('#toursType').value.trim(),
        minPrice: $('#toursMin').value,
        maxPrice: $('#toursMax').value,
        sort: $('#toursSort').value
      });
      const qs = buildQuery();
      publicNavigate(`/tours${qs ? `?${qs}` : ''}`, true);
      void loadTours();
    });
    root.querySelector('#toursReset')?.addEventListener('click', () => {
      Object.assign(toursState,{q:'',destination:'',tourType:'',minPrice:'',maxPrice:'',sort:'newest'});
      publicNavigate('/tours', true);
      void renderPublicRoute();
    });
    root.querySelector('#toursSort')?.addEventListener('change', () => {
      toursState.sort = $('#toursSort').value;
      const qs = buildQuery();
      publicNavigate(`/tours${qs ? `?${qs}` : ''}`, true);
      void loadTours();
    });
  }

  bindToolbar();
  await loadTours();
}

let agentsPageState = { agents: [], q: '', filter: 'all', ready: false };
const BD_PLACES = ['bangladesh','dhaka','chattogram','chittagong',"cox's bazar",'coxsbazar','sylhet','khulna','rajshahi','barishal','rangpur','mymensingh','cumilla','comilla','gazipur','narayanganj'];
function agentInitials(agent) { return (agent.fullName || '?').split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase(); }
function agentCategory(agent) { const loc = `${agent.city || ''} ${agent.officeLocation || ''} ${agent.country || ''}`.toLowerCase(); return BD_PLACES.some(key => loc.includes(key)) ? 'domestic' : 'international'; }
function agentCardHtml(agent) {
  const initials = agentInitials(agent);
  const photo = agent.photoUrl ? `<img src="${escapeHtml(agent.photoUrl)}" alt="${escapeHtml(agent.fullName)}" loading="lazy" />` : `<span class="id-card-initials">${escapeHtml(initials)}</span>`;
  const role = escapeHtml(agent.jobTitle || agent.specialization || 'Travel Specialist');
  const location = escapeHtml(agent.city || agent.officeLocation || 'Bangladesh');
  const experience = agent.experienceYears ? `${agent.experienceYears}+ Years` : 'Verified';
  const available = agent.status !== 'hidden' && agent.status !== 'archived';
  return `<a class="id-card agent-card" href="/travel-agents/${escapeHtml(agent.id)}" data-public-route="/travel-agents/${escapeHtml(agent.id)}"><div class="id-card-photo agent-photo">${photo}<span class="id-badge agent-badge">OFFICIAL MEMBER</span></div><div class="id-card-body agent-card-body"><h3 class="id-card-name">${escapeHtml(agent.fullName)}</h3><p class="id-card-role">${role}</p><p class="id-card-location">${icon('i-location')}${location}</p><div class="id-card-stats"><div class="id-card-stat"><small>Experience</small><strong>${escapeHtml(experience)}</strong></div><div class="id-card-stat"><small>Status</small><strong><span class="id-status${available ? '' : ' off'}">${available ? 'Available' : 'Away'}</span></strong></div></div><span class="id-card-cta">${icon('i-user')} View Profile</span></div></a>`;
}
function agentSkeletonHtml() { return `<div class="id-card agent-card skeleton"><div class="id-card-photo agent-photo"></div><div class="id-card-body agent-card-body"><h3 class="id-card-name">.</h3><p class="id-card-role">.</p><p class="id-card-location">.</p><div class="id-card-stats"></div></div></div>`; }
function filterAgents(list, q, filter) {
  const query = q.trim().toLowerCase();
  return list.filter(agent => {
    if (query) {
      const haystack = `${agent.fullName} ${agent.jobTitle} ${agent.specialization} ${agent.department} ${agent.city} ${agent.officeLocation} ${(agent.languages || []).join(' ')}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    if (filter === 'available') return agent.status !== 'hidden' && agent.status !== 'archived';
    if (filter === 'domestic') return agentCategory(agent) === 'domestic';
    if (filter === 'international') return agentCategory(agent) === 'international';
    return true;
  });
}
function drawAgentsPage(root) {
  const agents = agentsPageState.agents;
  const filtered = filterAgents(agents, agentsPageState.q, agentsPageState.filter);
  const filters = [['all', 'All'], ['available', 'Available'], ['international', 'International'], ['domestic', 'Domestic']];
  root.innerHTML = publicPageHeader('People', 'Travel Agents', 'Meet our verified Sadik Travels travel specialists. Connect with the right expert for hotels, homes & villas, tours and holiday packages.', '') + `<section class="public-page-card"><div class="agents-toolbar"><div class="agents-search"><svg class="search-icon"><use href="#i-search"></use></svg><input id="agentsSearchInput" type="search" placeholder="Search by name, location, language or specialty" value="${escapeHtml(agentsPageState.q)}" autocomplete="off" aria-label="Search travel agents" />${agentsPageState.q ? `<button type="button" class="agents-clear" id="agentsClearSearch" aria-label="Clear search">${icon('i-close')}</button>` : ''}</div><div class="agents-filters">${filters.map(([key, label]) => `<button type="button" class="agents-filter ${agentsPageState.filter === key ? 'active' : ''}" data-agent-filter="${key}">${label}</button>`).join('')}</div></div><p class="agents-result-count">Showing <strong>${filtered.length}</strong> of ${agents.length} travel agent${agents.length === 1 ? '' : 's'}</p><div class="agents-page-grid">${filtered.length ? filtered.map(agentCardHtml).join('') : publicEmptyState('No travel agents found', 'Try another search or filter to find a specialist.', '')}</div></section>`;
  wrapPublicRouteContent(root);
  bindAgentsPage(root);
}
function bindAgentsPage(root) {
  const input = $('#agentsSearchInput');
  let timer;
  input?.addEventListener('input', () => { clearTimeout(timer); const value = input.value; timer = setTimeout(() => { agentsPageState.q = value; drawAgentsPage(root); const next = $('#agentsSearchInput'); if (next) { next.focus(); next.setSelectionRange(next.value.length, next.value.length); } }, 250); });
  $('#agentsClearSearch')?.addEventListener('click', () => { agentsPageState.q = ''; drawAgentsPage(root); $('#agentsSearchInput')?.focus(); });
  $$('[data-agent-filter]').forEach(button => button.addEventListener('click', () => { agentsPageState.filter = button.dataset.agentFilter; drawAgentsPage(root); }));
}
async function renderPublicAgents(root, id = '') {
  if (id) { await renderPublicAgentProfile(root, id); return; }
  document.title = 'Travel Agents | Sadik Travels';
  if (!agentsPageState.ready) {
    root.innerHTML = publicPageHeader('People', 'Travel Agents', 'Meet our verified Sadik Travels travel specialists.', '') + `<section class="public-page-card"><div class="agents-page-grid">${Array.from({ length: 8 }, agentSkeletonHtml).join('')}</div></section>`;
    wrapPublicRouteContent(root);
    try { const response = await apiRequest('/site/agents'); agentsPageState.agents = response.agents || []; agentsPageState.ready = true; }
    catch (error) { const grid = root.querySelector('.agents-page-grid') || root; grid.innerHTML = publicErrorState(error?.status === 503 ? 'Travel agents are temporarily unavailable. Please try again in a moment.' : 'Travel agents are temporarily unavailable. Please try again shortly.'); root.querySelector('[data-public-retry]')?.addEventListener('click', () => { agentsPageState.ready = false; void renderPublicRoute(); }); return; }
  }
  drawAgentsPage(root);
}
async function renderPublicAgentProfile(root, id) {
  root.innerHTML = publicLoading();
  let agent;
  try { agent = (await apiRequest(`/site/agents/${encodeURIComponent(id)}`)).agent; }
  catch { root.innerHTML = publicErrorState('The requested travel agent was not found.'); return; }
  if (!agent) { root.innerHTML = publicErrorState('The requested travel agent was not found.'); return; }
  document.title = `${agent.fullName} · Travel Agent | Sadik Travels`;
  const photo = agent.photoUrl ? `<img src="${escapeHtml(agent.photoUrl)}" alt="${escapeHtml(agent.fullName)}" />` : `<span class="id-card-initials">${escapeHtml(agentInitials(agent))}</span>`;
  const contacts = [];
  if (agent.phone) contacts.push(`<a class="btn btn-primary" href="tel:${escapeHtml(agent.phone.replace(/[^+\d]/g, ''))}">${icon('i-phone')} Call</a>`);
  if (agent.whatsapp) contacts.push(`<a class="btn btn-outline" href="https://wa.me/${encodeURIComponent(agent.whatsapp.replace(/\D/g, ''))}" target="_blank" rel="noopener">WhatsApp</a>`);
  if (agent.email) contacts.push(`<a class="btn btn-outline" href="mailto:${escapeHtml(agent.email)}">Email</a>`);
  const metaRows = [['Department', agent.department], ['Specialization', agent.specialization], ['Office location', agent.officeLocation || agent.city], ['Languages', (agent.languages || []).join(', ')], ['Experience', agent.experienceYears ? `${agent.experienceYears} years` : ''], ['Working hours', agent.workingHours]].filter(([, value]) => value);
  const languages = (agent.languages || []).filter(Boolean);
  root.innerHTML = publicPageHeader('People', 'Travel Agents', 'Connect with a verified Sadik Travels travel specialist.', `<a class="btn btn-outline" href="/travel-agents" data-public-route="/travel-agents">All agents</a>`) + `<div class="agent-profile"><aside class="agent-profile-card"><div class="agent-profile-photo">${photo}<span class="id-badge">Official Member</span></div><div class="agent-profile-body"><h2>${escapeHtml(agent.fullName)}</h2><p class="agent-profile-role">${escapeHtml(agent.jobTitle || agent.specialization || 'Travel Specialist')}</p><p class="agent-profile-location">${icon('i-location')}${escapeHtml(agent.officeLocation || agent.city || 'Bangladesh')}</p><div class="agent-profile-contacts">${contacts.length ? contacts.join('') : '<span class="result-summary">Contact details will appear here once published.</span>'}</div></div></aside><div class="agent-profile-info"><h2>About ${escapeHtml((agent.fullName || 'the agent').split(' ')[0])}</h2><div class="agent-profile-section"><h3>Profile</h3><p>${escapeHtml(agent.fullDescription || agent.shortBio || 'A verified Sadik Travels travel specialist ready to help you plan and book your journey.')}</p></div>${languages.length || agent.specialization ? `<div class="agent-profile-section"><h3>Languages &amp; specialties</h3><div class="chip-list">${languages.map(language => `<span class="chip">${escapeHtml(language)}</span>`).join('')}${agent.specialization ? `<span class="chip">${escapeHtml(agent.specialization)}</span>` : ''}</div></div>` : ''}<div class="agent-profile-section"><h3>Details</h3><dl class="agent-profile-meta">${metaRows.length ? metaRows.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('') : '<div><dt>Status</dt><dd>Verified specialist</dd></div>'}</dl></div></div></div>`;
}
async function renderPaymentReturn(root, query) {
  const status = query.get('payment') || 'pending';
  const paymentId = query.get('paymentId') || query.get('tran_id') || '';
  let detail = null;
  if (paymentId) {
    try { detail = await apiRequest(`/payments/return-status?paymentId=${encodeURIComponent(paymentId)}`); } catch { /* gateway may still be settling */ }
  }
  const ok = status === 'success' || detail?.payment?.status === 'paid';
  const fail = status === 'failed' || status === 'cancelled';
  root.innerHTML = publicPageHeader('Payments', ok ? 'Payment successful' : fail ? 'Payment not completed' : 'Payment status', ok ? 'Your booking is confirmed. A receipt is available in My Bookings.' : 'If money was deducted, it will be reconciled after IPN verification.', '') +
    `<section class="public-page-card"><p>${escapeHtml(detail?.payment?.status || status)}</p>${detail?.hotelBooking ? `<p>Hotel booking ${escapeHtml(detail.hotelBooking.bookingNumber)} · ${escapeHtml(detail.hotelBooking.status)}</p>` : ''}<div class="public-detail-actions"><a class="btn btn-primary" href="/bookings" data-public-route="/bookings">My bookings</a></div></section>`;
}

async function renderPublicRoute() {
  const root = $('#publicRouteRoot');
  const home = document.querySelector('main');
  if (!root || !home) return;
  const route = publicRoute();
  const usePageContainer = CONTAINED_PUBLIC_ROUTES.has(route.parts[0]);
  root.classList.toggle('contained-public-route', usePageContainer);
  publicSetActive(route.path);
  trackAnalytics('page_view', { route: route.parts[0] || 'home' });
  if (route.path === '/' || route.path === '/') {
    root.hidden = true; home.hidden = false;
    setSeo({ title: '', description: 'Book hotels, homes & villas, tours and holiday packages with Sadik Travels.', canonical: '/' });
    if (route.query.get('service')) requestAnimationFrame(() => activateTab(route.query.get('service'), true));
    const hash = route.url.hash.replace(/^#/, '');
    if (hash) { requestAnimationFrame(() => setTimeout(() => scrollToHashTarget(hash), 80)); }
    return;
  }
  home.hidden = true; root.hidden = false;
  root.innerHTML = publicLoading();
  try {
    const sectionTitles = { hotels: ['Hotel booking', 'Search and book verified hotels with Sadik Travels.'], homes: ['Homes & villas', 'Book homes, apartments and villas with Sadik Travels.'], 'homes-villas': ['Homes & villas', 'Book homes, apartments and villas with Sadik Travels.'], tours: ['Tours', 'Tour packages across Bangladesh and the world.'], 'holiday-packages': ['Holiday packages', 'Curated holidays bundled into one price.'], explore: ['Explore destinations', 'Discover destinations across Bangladesh and the world.'], 'travel-agents': ['Travel agents', 'Connect with verified Sadik Travels travel specialists.'], 'travels-agents': ['Travel agents', 'Connect with verified Sadik Travels travel specialists.'], 'track-booking': ['Track booking', 'Follow your booking status in real time.'], support: ['Support', 'Sadik Travels support centre.'], orders: ['My bookings', 'Your bookings and orders with Sadik Travels.'], account: ['My account', 'Manage your profile, bookings and preferences.'], payments: ['Payments', 'Your Sadik Travels payment history and invoices.'], cart: ['My cart', 'Review items in your Sadik Travels cart.'], wishlist: ['Wishlist', 'Products you saved with Sadik Travels.'], checkout: ['Checkout', 'Secure checkout with Sadik Travels.'], offers: ['Travel offers', 'Published offers from Sadik Travels.'] };
    const meta = sectionTitles[route.parts[0]];
    if (meta) setSeo({ title: meta[0], description: meta[1], canonical: route.path });
    if (window.SadikPages && window.SadikPages.routes[route.parts[0]]) { await window.SadikPages.resolve(root, route); return; }
    if (route.parts[0] === 'hotels') {
      if (!route.parts[1]) { await renderHotelLanding(root); }
      else if (route.parts[1] === 'search') { await renderHotelSearch(root, route.query); }
      else { await renderHotelDetail(root, route.parts[1], route.query); }
      wrapPublicRouteContent(root);
      return;
    }
    if (route.parts[0] === 'payment') { await renderPaymentReturn(root, route.query); return; }
    if (route.parts[0] === 'booking') {
      if (route.parts[1] === 'checkout') { await renderHotelCheckout(root); }
      else if (route.parts[1]) { await renderBookingDetail(root, route.parts[1]); }
      return;
    }
    if (route.parts[0] === 'bookings') { await renderMyBookings(root); return; }
    if (route.parts[0] === 'account' && route.parts[1] === 'bookings') { await renderMyBookings(root); return; }
    if (PUBLIC_COLLECTIONS[route.parts[0]]) {
      const definition = PUBLIC_COLLECTIONS[route.parts[0]];
      if (route.parts[1]) await renderPublicContentDetail(root, definition, route.parts[1]);
      else await renderPublicContentCollection(root, definition);
    }
    else if (route.parts[0] === 'tours') await renderPublicTours(root, route.parts[1] || '');
    else if (['travel-agents', 'travels-agents'].includes(route.parts[0])) await renderPublicAgents(root, route.parts[1] || '');
    else { root.innerHTML = publicErrorState('This public route does not exist.'); }
  } catch (error) {
    const detail = error?.status === 503 || error?.code === 'SERVICE_UNAVAILABLE'
      ? 'The public service is temporarily unavailable. Please try again in a moment.'
      : error?.status === 404 || error?.message?.toLowerCase().includes('not found')
        ? 'The requested content was not found.'
        : error?.code === 'REQUEST_TIMEOUT' || error?.message?.toLowerCase().includes('network')
          ? (error.message || 'Network problem. Please check your connection and try again.')
          : 'Something went wrong while loading this page. Please try again.';
    root.innerHTML = publicErrorState(detail);
  }
  if (usePageContainer) wrapPublicRouteContent(root);
  root.querySelector('[data-public-retry]')?.addEventListener('click', () => void renderPublicRoute());
}
function bindPublicRouter(){document.addEventListener('click',event=>{const link=event.target.closest('[data-public-route]');if(!link)return;event.preventDefault();publicNavigate(link.dataset.publicRoute||link.getAttribute('href'));});window.addEventListener('popstate',()=>void renderPublicRoute());}
function publicNavigate(route,replace=false){const href=publicHref(route);if(href===`${location.pathname}${location.search}`){void renderPublicRoute();return;}if(replace)history.replaceState({},'',href);else history.pushState({},'',href);if(window.innerWidth<=767)closeSidebar();void renderPublicRoute();}

const HOME_SECTIONS = [
  { id: 'home-hotels', eyebrow: 'Stays', title: 'Featured Hotels', subtitle: "Find memorable stays across Bangladesh and abroad. Browse curated hotels or submit a live search to check real-time availability.", type: 'hotel', icon: 'i-hotel', limit: 4, viewAll: '/hotels' },
  { id: 'homes', eyebrow: 'Properties', title: 'Homes & Villas', subtitle: 'Private homes, apartments and villas with clear nightly pricing for every traveller and family.', type: 'home', icon: 'i-home', limit: 4, viewAll: '/homes' },
  { id: 'home-tours', eyebrow: 'Tours', title: 'Popular Tours', subtitle: 'Curated Bangladesh and international tour packages with clear pricing and Sadik Travels support.', source: 'tours', icon: 'i-map', limit: 4, viewAll: '/tours' },
  { id: 'holiday-packages', eyebrow: 'Holidays', title: 'Holiday Packages', subtitle: 'Hand-picked holiday itineraries for families, couples and groups.', type: 'holiday_package', icon: 'i-palm', limit: 4, viewAll: '/holiday-packages' },
  { id: 'explore', eyebrow: 'Explore', title: 'Explore', subtitle: 'Destinations, travel tips and inspiration for your next journey.', type: 'explore', extraTypes: ['destination'], icon: 'i-location', limit: 5, viewAll: '/explore' }
];
const sectionEmpty = (title, message) => `<div class="public-content-empty"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(message)}</span></div>`;
function hsContentCard(item) {
  const route = `/${publicContentPath(item)}/${item.id}`;
  const price = item.metadata?.price || item.metadata?.priceBdt;
  const media = item.imageUrl ? `<img src="${escapeHtml(item.imageUrl)}" alt="${escapeHtml(item.title)}" loading="lazy" />` : `<span class="hs-card-fallback">Sadik Travels</span>`;
  return `<a class="hs-card" href="${escapeHtml(route)}" data-public-route="${escapeHtml(route)}"><div class="hs-card-media">${media}</div><div class="hs-card-body"><small>${escapeHtml(String(item.type).replace(/_/g, ' '))}</small><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.subtitle || item.description || 'View published details.')}</p><div class="hs-card-foot">${price ? `<strong>৳${escapeHtml(Number(price).toLocaleString('en-BD'))}</strong>` : '<span></span>'}<span class="hs-card-cta">View <span>→</span></span></div></div></a>`;
}
function hsTourCard(tour) {
  const route = `/tours/${tour.id}`;
  const media = tour.imageUrl ? `<img src="${escapeHtml(tour.imageUrl)}" alt="${escapeHtml(tour.title)}" loading="lazy" />` : `<span class="hs-card-fallback">Sadik Travels</span>`;
  return `<a class="hs-card" href="${escapeHtml(route)}" data-public-route="${escapeHtml(route)}"><div class="hs-card-media">${media}</div><div class="hs-card-body"><small>${escapeHtml(tour.tourType || 'Tour package')}</small><h3>${escapeHtml(tour.title)}</h3><p>${escapeHtml((tour.destinations || []).join(' · ') || tour.country || '')}</p><div class="hs-card-foot"><strong>৳${escapeHtml(Number(tour.priceBdt || 0).toLocaleString('en-BD'))}</strong><span class="hs-card-cta">View <span>→</span></span></div></div></a>`;
}
function renderHomeSections(items, tours) {
  setTimeout(() => void window.SadikPages?.hydrateHomeSections(), 0);
  const root = $('#homeSections');
  if (!root) return;
  root.innerHTML = HOME_SECTIONS.map(section => {
    let cards = [];
    if (section.id === 'home-hotels') cards = [];
    else if (section.source === 'tours') cards = tours.slice(0, section.limit || 4).map(hsTourCard);
    else { const types = (section.extraTypes || []).concat(section.type); cards = items.filter(item => types.includes(item.type)).slice(0, section.limit || 4).map(hsContentCard); }
    const grid = cards.length ? `<div class="hs-grid">${cards.join('')}</div>` : sectionEmpty(`No ${section.title.toLowerCase()} yet`, 'Published content will appear here after an administrator saves and publishes it.');
    return `<section class="content-section hs-section" id="${section.id}" aria-labelledby="${section.id}Title"><div class="container panel-block section-bg"><div class="section-heading"><div><span class="hs-eyebrow">${icon(section.icon)} ${escapeHtml(section.eyebrow)}</span><h2 id="${section.id}Title">${escapeHtml(section.title)}</h2><p>${escapeHtml(section.subtitle)}</p></div>${section.viewAll ? `<a class="btn btn-outline" href="${escapeHtml(section.viewAll)}" data-public-route="${escapeHtml(section.viewAll)}">View all</a>` : ''}</div>${grid}</div></section>`;
  }).join('');
}
async function hydrateHomeHotels() {
  const section = document.getElementById('home-hotels');
  if (!section) return;
  try {
    const result = await apiRequest('/hotels?pageSize=8&sort=recommended');
    const hotels = result.hotels || [];
    if (!hotels.length) return;
    const grid = section.querySelector('.hs-grid');
    const emptyBox = section.querySelector('.public-content-empty, .section-empty');
    const markup = `<div class="hs-grid">${hotels.slice(0, 4).map(hsHotelCard).join('')}</div>`;
    if (emptyBox) emptyBox.outerHTML = markup;
    else if (grid) grid.outerHTML = markup;
  } catch { /* keep editorial hotel cards if live list is empty */ }
}

function renderAgentsCarousel(agents) {
  const track = $('#agentsTrack');
  if (!track) return;
  const list = agents.slice(0, 12);
  track.innerHTML = list.length ? list.map(agentCardHtml).join('') : sectionEmpty('No published travel agents yet', 'Verified specialist profiles will appear here after an admin publishes them.');
  wireAgentsCarousel();
}
function wireAgentsCarousel() {
  const track = $('#agentsTrack');
  if (!track) return;
  const prev = $('#agentsPrev');
  const next = $('#agentsNext');
  const stepSize = () => { const card = track.querySelector('.id-card'); return card ? card.getBoundingClientRect().width + 18 : 286; };
  prev?.addEventListener('click', () => track.scrollBy({ left: -stepSize(), behavior: 'smooth' }));
  next?.addEventListener('click', () => track.scrollBy({ left: stepSize(), behavior: 'smooth' }));
  const update = () => { if (!prev || !next) return; const max = track.scrollWidth - track.clientWidth - 4; prev.disabled = track.scrollLeft <= 4; next.disabled = track.scrollLeft >= max; };
  track.addEventListener('scroll', () => requestAnimationFrame(update), { passive: true });
  window.addEventListener('resize', update);
  update();
  // Mouse drag + touch swipe with threshold, and pointer-cancel safety.
  let pointer = null;
  const startX = () => pointer?.startX || 0;
  track.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    pointer = { pointerId: event.pointerId, startX: event.clientX, startScroll: track.scrollLeft, dragging: false };
  }, { passive: true });
  track.addEventListener('pointermove', (event) => {
    if (!pointer || pointer.pointerId !== event.pointerId) return;
    const delta = event.clientX - pointer.startX;
    if (!pointer.dragging && Math.abs(delta) > 6) { pointer.dragging = true; track.setPointerCapture?.(pointer.pointerId); track.classList.add('is-dragging'); }
    if (pointer.dragging) track.scrollLeft = pointer.startScroll - delta;
  }, { passive: true });
  const endDrag = (event) => {
    if (!pointer) return;
    const wasDragging = pointer.dragging;
    if (event && pointer.pointerId !== event.pointerId) return;
    pointer = null;
    if (wasDragging) {
      track.classList.remove('is-dragging');
      const max = track.scrollWidth - track.clientWidth;
      const atStart = track.scrollLeft <= 8;
      const atEnd = track.scrollLeft >= max - 8;
      // Snap to nearest card when the drag was a flick with little movement.
      const card = track.querySelector('.id-card');
      if (card && !atStart && !atEnd) {
        const cardWidth = card.getBoundingClientRect().width + 18;
        const snapped = Math.round(track.scrollLeft / cardWidth) * cardWidth;
        track.scrollTo({ left: Math.max(0, Math.min(max, snapped)), behavior: 'smooth' });
      }
    }
  };
  track.addEventListener('pointerup', endDrag, { passive: true });
  track.addEventListener('pointercancel', endDrag, { passive: true });
  // Prevent click-through on cards after a drag gesture.
  track.addEventListener('click', (event) => {
    if (pointer && pointer.dragging) { event.preventDefault(); event.stopPropagation(); }
  }, true);
}
let homeObserver = null;
function setupSectionObserver() {
  const links = $$('[data-scroll]');
  if (!links.length) return;
  const keys = [...new Set(links.map(link => link.dataset.scroll))];
  const sections = keys.map(key => document.getElementById(key)).filter(Boolean);
  if (!sections.length) return;
  if (homeObserver) homeObserver.disconnect();
  const setActive = (id) => links.forEach(link => link.classList.toggle('is-active', link.dataset.scroll === id));
  homeObserver = new IntersectionObserver((entries) => {
    const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio);
    if (visible[0]) setActive(visible[0].target.id);
  }, { rootMargin: '-25% 0px -60% 0px', threshold: [0, 0.15, 0.4, 0.75] });
  sections.forEach(section => homeObserver.observe(section));
}
function scrollToHashTarget(key) {
  const target = key === 'hotels' && !document.getElementById(key) ? $('#searchPanel') : document.getElementById(key);
  if (!target) { window.scrollTo({ top: 0, behavior: 'auto' }); return; }
  const headerHeight = window.innerWidth >= 1024 ? 64 : 58;
  const top = target.getBoundingClientRect().top + window.scrollY - headerHeight - 14;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  window.scrollTo({ top: Math.max(0, top), behavior: reduce ? 'auto' : 'smooth' });
}
function scrollToHashFromUrl() {
  const hash = location.hash.replace(/^#/, '');
  if (!hash) return;
  requestAnimationFrame(() => setTimeout(() => scrollToHashTarget(hash), 60));
}
function navigateToSection(key) {
  if (window.innerWidth < 1024) closeSidebar();
  const path = location.pathname.replace(/\/+$/, '') || '/';
  if (path !== '/') {
    history.pushState({}, '', `/#${key}`);
    void renderPublicRoute().then(() => requestAnimationFrame(() => setTimeout(() => scrollToHashTarget(key), 80)));
    return;
  }
  history.replaceState({}, '', `/#${key}`);
  scrollToHashTarget(key);
}

/* ============================================================
   SADIK TRAVELS — HOTEL BOOKING ECOSYSTEM (public frontend)
   Search · results/filters · detail · rooms · checkout ·
   confirmation · my bookings · receipt. Add-on module.
   ============================================================ */
const HOTEL_AMENITIES = ['Free Wi-Fi', 'Swimming Pool', 'Gym', 'Couple-Friendly', 'Complimentary Breakfast', 'Parking', 'AC', 'Restaurant', 'Room Service', 'Spa', 'Airport Transfer'];
const HOTEL_NEIGHBORHOODS = { "Cox's Bazar": ['Kolatoli Road', 'Inani Beach', 'Laboni Beach', 'Himchari'], Dhaka: ['Gulshan', 'Banani', 'Dhanmondi', 'Uttara'] };
const REVIEW_BUCKETS = [{ id: '4.25', label: '8.5+ Excellent', min: 4.25 }, { id: '4', label: '8.0+ Very good', min: 4 }, { id: '3.5', label: '7.0+ Good', min: 3.5 }];
const HOTEL_CHECKOUT_KEY = 'sadikHotelCheckout';
const hotelSearchState = { destination: '', checkIn: '', checkOut: '', adults: 2, children: 0, rooms: 1, minPrice: '', maxPrice: '', minStarRating: '', starRatings: [], minGuestRating: '', area: '', areas: [], neighborhoods: [], propertyType: [], amenities: [], freeCancellation: false, sort: 'recommended', page: 1 };
/* Branded fallback so a missing/failing image never renders as a broken icon. */
const HOTEL_PLACEHOLDER = '/assets/hotel-placeholder.svg';
function extractImageUrl(entry) {
  if (!entry) return '';
  if (typeof entry === 'string') return entry.trim();
  if (typeof entry === 'object') {
    const obj = entry;
    return (obj.url || obj.secureUrl || obj.secure_url || obj.imageUrl || obj.image_url || obj.src || obj.path || '').trim();
  }
  return '';
}
function hotelHasValidImage(hotel) {
  if (!hotel) return false;
  if (hotel.thumbnail && String(hotel.thumbnail).trim()) return true;
  if (Array.isArray(hotel.images) && hotel.images.length) {
    for (const img of hotel.images) {
      const u = extractImageUrl(img);
      if (u && /^(https?:\/\/|\/\/|data:image\/|\/)/i.test(u)) return true;
    }
  }
  const fallback = extractImageUrl(hotel.imageUrl) || extractImageUrl(hotel.image) || extractImageUrl(hotel.heroImage);
  return Boolean(fallback && /^(https?:\/\/|\/\/|data:image\/|\/)/i.test(fallback));
}
const hotelImageSrc = (hotel) => {
  if (!hotel) return '';
  if (hotel.thumbnail && String(hotel.thumbnail).trim()) return String(hotel.thumbnail).trim();
  if (Array.isArray(hotel.images) && hotel.images.length) {
    const first = extractImageUrl(hotel.images[0]);
    if (first) return first;
  }
  return extractImageUrl(hotel.imageUrl) || extractImageUrl(hotel.image) || extractImageUrl(hotel.heroImage) || '';
};
const hotelNightsBetween = (checkIn, checkOut) => Math.max(1, Math.round((new Date(`${checkOut}T00:00:00`) - new Date(`${checkIn}T00:00:00`)) / 86400000));
const hotelImageTag = (src, alt, attrs = '') => {
  const valid = src && String(src).trim() && !String(src).includes('hotel-placeholder');
  if (!valid) {
    return `<div class="hotel-img-fallback" role="img" aria-label="${escapeHtml(alt || 'Hotel image')}"><img src="${HOTEL_PLACEHOLDER}" alt="${escapeHtml(alt || '')}" loading="lazy" ${attrs} data-fallback-applied="1" /></div>`;
  }
  return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt || '')}" loading="lazy" onerror="if(!this.dataset.fallbackApplied){this.dataset.fallbackApplied='1';this.src='${HOTEL_PLACEHOLDER}';}" ${attrs} />`;
};
document.addEventListener('error', event => {
  const img = event.target;
  if (!img || img.tagName !== 'IMG' || img.dataset.fallbackApplied) return;
  if (!img.closest('.hotel-card, .hotel-detail, .booking-row, .receipt-card, .hs-card')) return;
  const src = img.getAttribute('src') || '';
  if (!src || src.includes('hotel-placeholder.svg')) return;
  img.dataset.fallbackApplied = '1';
  img.src = HOTEL_PLACEHOLDER;
}, true);
const hotelMoney = (value) => `৳${Number(value || 0).toLocaleString('en-BD')}`;
const tourMoney = (value) => `BDT ${Number(value || 0).toLocaleString('en-BD')}`;
const hotelStars = (rating) => { const n = Math.max(0, Math.min(5, Math.round(Number(rating || 0)))); return Array.from({ length: n }, () => icon('i-star')).join(''); };
const hotelRatingLabel = (rating) => rating >= 4.5 ? 'Excellent' : rating >= 4 ? 'Very good' : rating >= 3.5 ? 'Good' : rating >= 3 ? 'Pleasant' : 'Rated';
const hotelNightWord = (n) => `${n} night${n === 1 ? '' : 's'}`;
const hotelGuestsWord = (a, c) => `${a} adult${a === 1 ? '' : 's'}${c ? `, ${c} child${c === 1 ? '' : 'ren'}` : ''}`;
function hotelReadQuery(query) {
  return {
    destination: query.get('destination') || '', checkIn: query.get('checkIn') || isoDateFromToday(1), checkOut: query.get('checkOut') || isoDateFromToday(2),
    adults: Number(query.get('adults')) || 2, children: Number(query.get('children')) || 0, rooms: Number(query.get('rooms')) || 1,
    q: query.get('q') || '',
    minPrice: query.get('minPrice') || '', maxPrice: query.get('maxPrice') || '', minStarRating: query.get('minStarRating') || '',
    starRatings: query.get('starRatings') ? query.get('starRatings').split(',').map(Number).filter(Number.isFinite) : [],
    minGuestRating: query.get('minGuestRating') || '',
    area: query.get('area') || '',
    areas: query.get('areas') ? query.get('areas').split(',').filter(Boolean) : [],
    neighborhoods: query.get('neighborhoods') ? query.get('neighborhoods').split(',').filter(Boolean) : [],
    propertyType: query.get('propertyType') ? query.get('propertyType').split(',').filter(Boolean) : [],
    amenities: query.get('amenities') ? query.get('amenities').split(',').filter(Boolean) : [],
    freeCancellation: query.get('freeCancellation') === 'true', sort: query.get('sort') || 'recommended', page: Number(query.get('page')) || 1
  };
}
function hotelBuildUrl(params) {
  const p = new URLSearchParams();
  if (params.destination) p.set('destination', params.destination);
  p.set('checkIn', params.checkIn); p.set('checkOut', params.checkOut);
  p.set('adults', params.adults); p.set('children', params.children); p.set('rooms', params.rooms);
  if (params.q) p.set('q', params.q);
  if (params.minPrice) p.set('minPrice', params.minPrice);
  if (params.maxPrice) p.set('maxPrice', params.maxPrice);
  if (params.minStarRating) p.set('minStarRating', params.minStarRating);
  if (params.starRatings?.length) p.set('starRatings', params.starRatings.join(','));
  if (params.minGuestRating) p.set('minGuestRating', params.minGuestRating);
  if (params.area) p.set('area', params.area);
  if (params.areas?.length) p.set('areas', params.areas.join(','));
  if (params.neighborhoods?.length) p.set('neighborhoods', params.neighborhoods.join(','));
  if (params.propertyType?.length) p.set('propertyTypes', params.propertyType.join(','));
  if (params.amenities?.length) p.set('amenities', params.amenities.join(','));
  if (params.freeCancellation) p.set('freeCancellation', 'true');
  if (params.sort && params.sort !== 'recommended') p.set('sort', params.sort);
  if (params.page && params.page > 1) p.set('page', params.page);
  return p.toString();
}
function navigateToHotelSearch() {
  const destination = $('#hotelDestination')?.value.trim() || '';
  const checkIn = $('#checkinDate')?.value || isoDateFromToday(1);
  const checkOut = $('#checkoutDate')?.value || isoDateFromToday(2);
  const adults = state.hotelAdult; const children = state.hotelChild; const rooms = Number(($('#roomValue')?.textContent || 'Room - 1').replace(/\D/g, '')) || 1;
  if (window.innerWidth < 1024) closeSidebar();
  publicNavigate(`/hotels/search?${hotelBuildUrl({ destination, checkIn, checkOut, adults, children, rooms })}`);
}
function hotelBreadcrumb(trail) {
  return `<div class="hotel-breadcrumb">${trail.map((item, i) => i === trail.length - 1 ? `<strong>${escapeHtml(item.label)}</strong>` : `<a href="${escapeHtml(item.href)}" data-public-route="${escapeHtml(item.href)}">${escapeHtml(item.label)}</a>`).join('<span>›</span>')}</div>`;
}
function hotelGalleryModal(images, startIndex = 0) {
  if (!images?.length) return;
  let index = startIndex;
  const render = () => { const img = images[index] || images[0]; $('#modalContent').innerHTML = `<div class="gallery-lightbox"><button class="gallery-arrow gallery-prev" type="button" aria-label="Previous">${icon('i-arrow-left')}</button><div class="gallery-stage"><img src="${escapeHtml(img.url)}" alt="${escapeHtml(img.alt || 'Hotel photo')}" /><span class="gallery-count">${index + 1} / ${images.length}</span></div><button class="gallery-arrow gallery-next" type="button" aria-label="Next">${icon('i-arrow-right')}</button></div><button type="button" class="btn btn-outline full-btn" data-close-modal>Close</button>`; bindGallery(); };
  const bindGallery = () => { $('#modalContent .gallery-prev')?.addEventListener('click', () => { index = (index - 1 + images.length) % images.length; render(); }); $('#modalContent .gallery-next')?.addEventListener('click', () => { index = (index + 1) % images.length; render(); }); $$('#modalContent [data-close-modal]').forEach(b => b.addEventListener('click', () => closeModal($('#genericModal')))); };
  openModal($('#genericModal')); render();
}
function hotelCompactSearchForm(values) {
  return `<form class="hotel-modify-form" id="hotelModifyForm">
    <div class="hotel-modify-grid">
      <label class="hm-field hm-field-location"><span>${icon('i-location')} Location</span><input id="hmDestination" value="${escapeHtml(values.destination || '')}" placeholder="Cox's Bazar, Dhaka, Sylhet…" autocomplete="off" /><div class="hm-suggestions" id="hmSuggestions"></div></label>
      <label class="hm-field"><span>${icon('i-calendar')} Check-in</span><input id="hmCheckIn" type="date" value="${escapeHtml(values.checkIn || '')}" min="${isoDateFromToday(0)}" /></label>
      <label class="hm-field"><span>${icon('i-calendar')} Check-out</span><input id="hmCheckOut" type="date" value="${escapeHtml(values.checkOut || '')}" min="${isoDateFromToday(1)}" /></label>
      <label class="hm-field hm-field-guests"><span>${icon('i-user')} Guests</span><input id="hmGuests" value="${escapeHtml(`${values.adults || 2} adults${(values.children || 0) ? `, ${values.children} children` : ''}`)}" readonly /></label>
      <label class="hm-field hm-field-rooms"><span>${icon('i-bed')} Rooms</span><input id="hmRooms" value="${escapeHtml(`${values.rooms || 1} room${(values.rooms || 1) > 1 ? 's' : ''}`)}" readonly /></label>
      <button type="submit" class="btn btn-primary hotel-search-btn">${icon('i-search')} Search</button>
    </div>
  </form>`;
}
function bindHotelModifyForm(values) {
  const form = $('#hotelModifyForm');
  if (!form) return;
  let adults = values.adults || 2, children = values.children || 0, rooms = values.rooms || 1;
  const guestsInput = $('#hmGuests');
  const roomsInput = $('#hmRooms');
  const updateGuests = () => {
    if (guestsInput) guestsInput.value = `${adults} adults${children ? `, ${children} children` : ''}`;
    if (roomsInput) roomsInput.value = `${rooms} room${rooms > 1 ? 's' : ''}`;
  };
  const openGuestModal = () => {
    openModal($('#genericModal'));
    $('#modalContent').innerHTML = `<div class="modal-heading"><div class="modal-icon blue">${icon('i-user')}</div><h2 id="modalTitle">Guests & rooms</h2><p>Select number of guests and rooms</p></div>
      <div class="guest-modal-body">
        ${hotelStepper('Rooms', 'gRooms', rooms, 1, 8)}
        ${hotelStepper('Adults', 'gAdults', adults, 1, 20)}
        ${hotelStepper('Children', 'gChildren', children, 0, 10)}
      </div>
      <button class="btn btn-primary full-btn" type="button" id="gDone">Done</button>`;
    const sync = () => {
      const rEl = document.getElementById('gRooms');
      const aEl = document.getElementById('gAdults');
      const cEl = document.getElementById('gChildren');
      if (rEl) rooms = Number(rEl.dataset.value);
      if (aEl) adults = Number(aEl.dataset.value);
      if (cEl) children = Number(cEl.dataset.value);
    };
    $$('[data-step-target]').forEach(s => s.addEventListener('click', () => {
      const target = s.dataset.stepTarget;
      const dir = Number(s.dataset.dir);
      const map = { gRooms: [1, 8], gAdults: [1, 20], gChildren: [0, 10] };
      const [min, max] = map[target] || [0, 10];
      const out = document.getElementById(target);
      if (!out) return;
      let val = Number(out.dataset.value) + dir;
      val = Math.max(min, Math.min(max, val));
      out.dataset.value = val;
      const valEl = document.getElementById(target + 'Val');
      if (valEl) valEl.textContent = val;
      sync();
    }));
    $('#gDone')?.addEventListener('click', () => {
      sync();
      updateGuests();
      closeModal($('#genericModal'));
    });
  };
  guestsInput?.addEventListener('click', openGuestModal);
  roomsInput?.addEventListener('click', openGuestModal);

  const destInput = $('#hmDestination');
  const sugg = $('#hmSuggestions');
  let timer;
  destInput?.addEventListener('input', () => {
    clearTimeout(timer);
    const q = destInput.value.trim();
    if (q.length < 1) {
      if (sugg) sugg.classList.remove('open');
      return;
    }
    timer = setTimeout(async () => {
      try {
        const r = await apiRequest(`/hotels/destinations?q=${encodeURIComponent(q)}`);
        if (!sugg) return;
        sugg.innerHTML = (r.destinations || []).map(d => `<button type="button" class="hm-suggestion" data-city="${escapeHtml(d.city)}"><strong>${escapeHtml(d.city)}</strong><small>${escapeHtml(d.country)} · ${d.hotels} hotel${d.hotels === 1 ? '' : 's'}</small></button>`).join('');
        sugg.classList.toggle('open', (r.destinations || []).length > 0);
        $$('.hm-suggestion', sugg).forEach(b => b.addEventListener('click', () => {
          destInput.value = b.dataset.city;
          sugg.classList.remove('open');
        }));
      } catch {}
    }, 250);
  });
  document.addEventListener('click', e => {
    const target = e.target;
    if (!target.closest || !target.closest('#hmDestination') && !target.closest('#hmSuggestions')) {
      if (sugg) sugg.classList.remove('open');
    }
  });
  form.addEventListener('submit', e => {
    e.preventDefault();
    const ci = $('#hmCheckIn')?.value, co = $('#hmCheckOut')?.value;
    if (!ci || !co) { showToast('Select check-in and check-out dates.', 'error'); return; }
    if (co <= ci) { showToast('Check-out must be after check-in.', 'error'); return; }
    publicNavigate(`/hotels/search?${hotelBuildUrl({ destination: destInput?.value.trim() || '', checkIn: ci, checkOut: co, adults, children, rooms })}`);
  });
}
function hotelStepper(label, id, value, min, max) {
  return `<div class="guest-stepper"><div><strong>${escapeHtml(label)}</strong></div><div class="stepper"><button type="button" data-step-target="${id}" data-dir="-1">−</button><output id="${id}" data-value="${value}"><span id="${id}Val">${value}</span></output><button type="button" data-step-target="${id}" data-dir="1">+</button></div></div>`;
}
function hotelCardHtml(hotel, search) {
  const img = hotelImageSrc(hotel);
  const hasRealImage = hotelHasValidImage(hotel);
  const photoCount = Array.isArray(hotel.images) ? hotel.images.length : 0;
  const rating = hotel.guestRating || hotel.starRating || 0;
  const reviews = hotel.reviewCount || 0;
  const detailHref = `/hotels/${encodeURIComponent(hotel.slug)}?${hotelBuildUrl({ ...search, page: 1 })}`;
  const amenities = (hotel.amenities || []).slice(0, 4).map(a => `<span class="hotel-chip">${escapeHtml(a)}</span>`).join('');
  const hasDiscount = typeof hotel.priceFrom === 'number' && typeof hotel.originalPriceFrom === 'number' && hotel.originalPriceFrom > hotel.priceFrom;
  const discountPct = hasDiscount ? Math.round((1 - hotel.priceFrom / hotel.originalPriceFrom) * 100) : 0;
  const datesSelected = Boolean(search?.checkIn && search?.checkOut);
  const soldOutForDates = datesSelected && Number(hotel.availableRooms) === 0;
  const loc = [hotel.area, hotel.city].filter(Boolean).join(', ');
  return `<article class="hotel-card${soldOutForDates ? ' is-soldout' : ''}${hasRealImage ? ' has-real-image' : ' no-real-image'}" data-hotel-slug="${escapeHtml(hotel.slug)}">
    <a class="hotel-card-media" href="${escapeHtml(detailHref)}" data-public-route="${escapeHtml(detailHref)}">
      ${hotelImageTag(img, hotel.name)}
      ${hasRealImage && photoCount > 1 ? `<span class="hotel-card-photos">${icon('i-images')} ${photoCount}</span>` : ''}
      ${!hasRealImage ? `<span class="hotel-card-badge-soon">Photos coming soon</span>` : ''}
      ${soldOutForDates ? `<span class="hotel-card-soldout">Not available ${escapeHtml(hotelNightWord(hotelNightsBetween(search.checkIn, search.checkOut)))}</span>` : ''}
    </a>
    <div class="hotel-card-body">
      <div class="hotel-card-head">
        <div class="hotel-card-maininfo">
          <div class="hotel-card-stars">${hotelStars(hotel.starRating)}</div>
          <h3 class="hotel-card-name">${escapeHtml(hotel.name)}</h3>
          <p class="hotel-card-loc">${icon('i-location')}${escapeHtml(loc || hotel.city || '')}</p>
        </div>
        ${reviews > 0 ? `<div class="hotel-card-rating"><strong>${Number(rating).toFixed(1)}</strong><small>${escapeHtml(hotelRatingLabel(rating))}</small><em>${reviews} review${reviews === 1 ? '' : 's'}</em></div>` : `<div class="hotel-card-rating new"><small>New</small></div>`}
      </div>
      <div class="hotel-card-amenities">${amenities || '<span class="hotel-chip muted">Verified property</span>'}</div>
      <div class="hotel-card-foot">
        <div class="hotel-card-price">
          ${typeof hotel.priceFrom === 'number' ? `<small>Starting from</small>
            <div class="hotel-price-row">
              ${hasDiscount ? `<span class="hotel-price-old">${hotelMoney(hotel.originalPriceFrom)}</span><span class="hotel-price-badge">−${discountPct}%</span>` : ''}
              <strong>${hotelMoney(hotel.priceFrom)}<span>/ night</span></strong>
            </div>
            <small class="hotel-price-per">per night</small>` : '<small class="muted">Price on request</small>'}
        </div>
        <div class="hotel-card-actions">
          <a class="btn btn-primary hotel-card-btn" href="${escapeHtml(detailHref)}" data-public-route="${escapeHtml(detailHref)}">View</a>
        </div>
      </div>
    </div>
  </article>`;
}
async function renderHotelLanding(root) {
  document.title = 'Hotels | Sadik Travels';
  const defaultSearch = { destination: '', checkIn: isoDateFromToday(1), checkOut: isoDateFromToday(2), adults: 2, children: 0, rooms: 1 };
  root.innerHTML = `
    <div class="hotel-marketplace hotel-landing">
      ${hotelBreadcrumb([{ label: 'Home', href: '/' }, { label: 'Hotels' }])}
      <section class="public-page-card hotel-search-top">
        <div class="hotel-top-search">
          <h2 class="hotel-landing-title">Find your perfect stay</h2>
          <p class="hotel-landing-sub">Verified hotels, resorts and apartments across Bangladesh with instant booking</p>
          <div class="hotel-top-search-main">${hotelCompactSearchForm(defaultSearch)}</div>
        </div>
      </section>
      <section class="public-page-card">
        <div class="section-heading">
          <div><span class="hs-eyebrow">${icon('i-hotel')} Featured hotels</span><h2>Popular stays</h2><p>A selection of published Sadik Travels properties with real photos and live pricing.</p></div>
          <a class="btn btn-outline" href="/hotels/search" data-public-route="/hotels/search">View all hotels</a>
        </div>
        <div class="hotel-results-grid" id="hotelLandingGrid"><div class="public-public-loading"><span class="spinner"></span>Loading featured hotels…</div></div>
      </section>
    </div>`;
  wrapPublicRouteContent(root);
  bindHotelModifyForm(defaultSearch);
  try {
    const r = await apiRequest('/hotels?pageSize=9&sort=recommended');
    const featured = r.hotels || [];
    const grid = document.getElementById('hotelLandingGrid');
    if (!grid) return;
    if (featured.length) {
      grid.innerHTML = featured.map(h => hotelCardHtml(h, defaultSearch)).join('');
    } else {
      grid.innerHTML = publicEmptyState('No hotels published yet', 'Hotels will appear here after an administrator adds and publishes them.', '<a class="btn btn-primary" href="/" data-public-route="/">Back home</a>');
    }
  } catch (error) {
    const grid = document.getElementById('hotelLandingGrid');
    if (grid) grid.innerHTML = publicErrorState(error?.status === 503 ? 'Hotel results are temporarily unavailable. Please try again in a moment.' : 'Unable to load hotel results. Please try again.');
    root.querySelector('[data-public-retry]')?.addEventListener('click', () => void renderPublicRoute());
  }
}
async function renderHotelSearch(root, query) {
  document.title = 'Hotels | Sadik Travels';
  const search = hotelReadQuery(query);
  Object.assign(hotelSearchState, search);
  const nights = Math.max(1, Math.round((new Date(`${search.checkOut}T00:00:00`) - new Date(`${search.checkIn}T00:00:00`)) / 86400000));
  trackAnalytics('search', { type: 'hotel', destination: search.destination, nights, adults: search.adults });

  // Professional marketplace layout: top search bar + left filters + right results grid
  root.innerHTML = `
    <div class="hotel-marketplace">
      ${hotelBreadcrumb([{ label: 'Home', href: '/' }, { label: 'Hotels', href: '/hotels' }, { label: search.destination || 'All Hotels' }])}
      <section class="public-page-card hotel-search-top">
        <div class="hotel-top-search">
          <div class="hotel-top-search-main">${hotelCompactSearchForm(search)}</div>
          <div class="hotel-search-meta">
            <span>${icon('i-calendar')} ${formatDate(search.checkIn)} → ${formatDate(search.checkOut)}</span>
            <span>${hotelNightWord(nights)}</span>
            <span>${search.rooms} room${search.rooms > 1 ? 's' : ''} · ${hotelGuestsWord(search.adults, search.children)}</span>
          </div>
        </div>
      </section>
      <div class="hotel-results-layout">
        <aside class="hotel-filters" id="hotelFiltersPane">
          <div id="hotelFilters" class="hotel-filters-inner">
            <div class="public-public-loading"><span class="spinner"></span>Loading filters…</div>
          </div>
        </aside>
        <div class="hotel-results-main">
          <div class="hotel-results-toolbar">
            <div class="hotel-results-count">
              <strong id="hotelResultsCount">Searching…</strong>
              <small id="hotelResultsHint">Finding verified stays</small>
            </div>
            <div class="hotel-toolbar-right">
              <button type="button" class="btn btn-outline hotel-filters-toggle" id="hotelFiltersToggle">${icon('i-sliders')} Filters</button>
              <label class="hotel-sort"><span>Sort by</span>
                <select id="hotelSort">
                  <option value="recommended">Recommended</option>
                  <option value="price_asc">Price: Low to High</option>
                  <option value="price_desc">Price: High to Low</option>
                  <option value="rating">Rating</option>
                </select>
              </label>
            </div>
          </div>
          <div class="hotel-results-grid" id="hotelResultsGrid">
            ${Array.from({ length: 6 }, () => `<div class="hotel-card-skeleton"></div>`).join('')}
          </div>
          <div class="hotel-pagination" id="hotelPagination"></div>
        </div>
      </div>
      <div class="mobile-sheet" id="hotelMobileSheet"><div><small>Filters &amp; book</small><strong id="hotelSheetCount">Searching…</strong></div><div style="display:flex;gap:8px"><button type="button" class="btn btn-outline" id="hotelSheetFilters">Filters</button></div></div>
    </div>`;

  wrapPublicRouteContent(root);
  const sortEl = $('#hotelSort');
  if (sortEl) sortEl.value = search.sort;

  let facetData = { propertyTypes: [], areas: [], amenities: [], starRatings: [], priceBounds: {} };

  const loadResults = async () => {
    const grid = $('#hotelResultsGrid');
    if (grid) grid.innerHTML = Array.from({ length: 6 }, () => `<div class="hotel-card-skeleton"></div>`).join('');
    try {
      const r = await apiRequest(`/hotels?${hotelBuildUrl(search)}`);
      facetData = {
        propertyTypes: r.propertyTypes || [],
        cities: r.cities || [],
        areas: r.areas || [],
        amenities: r.amenities || [],
        starRatings: r.starRatings || [],
        priceBounds: r.priceBounds || {}
      };
      const countEl = $('#hotelResultsCount');
      const hintEl = $('#hotelResultsHint');
      const sheetEl = $('#hotelSheetCount');
      if (countEl) countEl.textContent = `${r.total} ${r.total === 1 ? 'property' : 'properties'} found`;
      if (hintEl) hintEl.textContent = search.destination ? `in ${search.destination}` : 'across Bangladesh';
      if (sheetEl) sheetEl.textContent = `${r.total} stay${r.total === 1 ? '' : 's'}`;

      if (grid) {
        if (r.hotels.length) {
          grid.innerHTML = r.hotels.map(h => hotelCardHtml(h, search)).join('');
        } else {
          grid.innerHTML = publicEmptyState('No hotels found', 'Try changing your dates, destination, or filters.', `<button class="btn btn-outline" type="button" id="hotelClearFilters">Clear filters</button>`);
        }
      }

      renderHotelPagination(r);
      renderHotelFilters(facetData);

      const clearBtn = $('#hotelClearFilters');
      if (clearBtn) clearBtn.addEventListener('click', () => {
        Object.assign(hotelSearchState, { q: '', minPrice: '', maxPrice: '', minStarRating: '', minGuestRating: '', starRatings: [], propertyType: [], amenities: [], areas: [], neighborhoods: [], area: '', freeCancellation: false, page: 1, sort: 'recommended' });
        publicNavigate(`/hotels/search?${hotelBuildUrl(hotelSearchState)}`);
      });
    } catch (error) {
      const grid = $('#hotelResultsGrid');
      if (grid) grid.innerHTML = publicErrorState(error.message || 'Hotel search is unavailable. Please try again.');
    }
  };

  const renderHotelFilters = (facets) => {
    const node = $('#hotelFilters');
    if (!node) return;
    const propertyTypes = facets.propertyTypes || [];
    const areas = facets.areas || [];
    const amenities = facets.amenities || [];
    const starOptions = facets.starRatings?.length ? facets.starRatings : [5,4,3,2,1];
    const bounds = facets.priceBounds || {};
    const priceMaxBound = Number(bounds.max) > 0 ? Math.ceil(Number(bounds.max)) : 25000;
    const priceMinBound = Number(bounds.min) >= 0 ? Math.floor(Number(bounds.min)) : 0;
    const anyActive = Boolean(search.q || search.minPrice || search.maxPrice || search.starRatings?.length || search.minGuestRating || search.areas?.length || search.propertyType?.length || search.amenities?.length || search.freeCancellation);

    // Build star rating options with visual stars
    const starMarkup = starOptions.map(stars => {
      const checked = search.starRatings.includes(Number(stars)) ? 'checked' : '';
      return `<label class="check-pill"><input type="checkbox" data-star="${stars}" ${checked} /><span>${hotelStars(stars)} ${stars} star${stars === 1 ? '' : 's'}</span></label>`;
    }).join('') || [5,4,3,2,1].map(s => `<label class="check-pill"><input type="checkbox" data-star="${s}" ${search.starRatings.includes(s) ? 'checked' : ''} /><span>${hotelStars(s)} ${s}</span></label>`).join('');

    node.innerHTML = `
      <div class="filter-head">
        <div class="filter-head-left"><strong>${icon('i-sliders')} Filters &amp; Sort</strong></div>
        ${anyActive ? '<button type="button" class="filter-clear" id="hotelClearFiltersSide">Clear All</button>' : '<span class="filter-count">${facets.amenities?.length || 0} filters</span>'}
      </div>

      <div class="filter-group">
        <h4>Search hotel name / area</h4>
        <div class="filter-search-wrap">
          <input type="search" class="filter-search" id="fNameSearch" value="${escapeHtml(search.q || '')}" placeholder="Hotel The Cox Today, Kolatoli…" />
        </div>
      </div>

      <div class="filter-group">
        <h4>Property Type</h4>
        <div class="filter-checks">
          ${propertyTypes.length ? propertyTypes.map(t => `<label class="check-pill"><input type="checkbox" data-ptype="${escapeHtml(t)}" ${search.propertyType.includes(t) ? 'checked' : ''} /><span>${escapeHtml(t)}</span></label>`).join('') : ['Hotel','Resort','Apartment'].map(t => `<label class="check-pill"><input type="checkbox" data-ptype="${t}" ${search.propertyType.includes(t) ? 'checked' : ''} /><span>${t}</span></label>`).join('')}
        </div>
      </div>

      ${areas.length ? `<div class="filter-group"><h4>Area</h4><div class="filter-checks filter-scroll">${areas.map(a => `<label class="check-pill"><input type="checkbox" data-area="${escapeHtml(a)}" ${(search.areas || []).includes(a) || search.area === a ? 'checked' : ''} /><span>${escapeHtml(a)}</span></label>`).join('')}</div></div>` : ''}

      ${amenities.length ? `<div class="filter-group"><h4>Amenities</h4><div class="filter-checks filter-scroll">${amenities.map(a => `<label class="check-pill"><input type="checkbox" data-amenity="${escapeHtml(a)}" ${search.amenities.includes(a) ? 'checked' : ''} /><span>${escapeHtml(a)}</span></label>`).join('')}</div></div>` : `<div class="filter-group"><h4>Amenities</h4><div class="filter-checks">${['Breakfast','Swimming Pool','Gym','WiFi','A/C','Restaurant','Parking'].map(a => `<label class="check-pill"><input type="checkbox" data-amenity="${a}" ${search.amenities.includes(a) ? 'checked' : ''} /><span>${a}</span></label>`).join('')}</div></div>`}

      <div class="filter-group"><h4>Star Rating</h4><div class="filter-checks"><label class="check-pill"><input type="radio" name="starAll" data-star-all ${search.starRatings.length === 0 ? 'checked' : ''} /><span>All</span></label>${starMarkup}</div></div>

      <div class="filter-group">
        <h4>Price / Night <small class="filter-hint">BDT ${priceMinBound.toLocaleString('en-BD')} – ${priceMaxBound.toLocaleString('en-BD')}</small></h4>
        <div class="filter-price">
          <label><span>Minimum</span><input type="number" id="fMinPrice" value="${escapeHtml(search.minPrice)}" placeholder="${priceMinBound}" min="0" /></label>
          <label><span>Maximum</span><input type="number" id="fMaxPrice" value="${escapeHtml(search.maxPrice)}" placeholder="${priceMaxBound}" min="0" /></label>
        </div>
        <div class="range-wrap">
          <input type="range" id="fPriceSlider" min="${priceMinBound}" max="${priceMaxBound}" step="100" value="${escapeHtml(search.maxPrice || priceMaxBound)}" />
          <div class="range-labels"><span>${priceMinBound.toLocaleString()}</span><span>${priceMaxBound.toLocaleString()}</span></div>
        </div>
      </div>

      <div class="filter-group">
        <h4>Sort By</h4>
        <div class="filter-checks">
          ${[['recommended','Default'],['price_asc','Price: Low to High'],['price_desc','Price: High to Low'],['rating','Rating'],['recommended','Recommended']].slice(0,4).map(([value,label]) => `<label class="check-pill"><input type="radio" name="fSort" data-sort-radio="${value}" ${search.sort === value ? 'checked' : ''} /><span>${label}</span></label>`).join('')}
        </div>
      </div>

      <div class="filter-group"><label class="check-pill"><input type="checkbox" id="fFreeCancel" ${search.freeCancellation ? 'checked' : ''} /><span>Free cancellation only</span></label></div>

      <div class="filter-actions">
        <button type="button" class="btn btn-primary full-btn" id="hotelApplyFilters">Apply Filters</button>
        <button type="button" class="btn btn-outline full-btn" id="hotelClearFiltersSide2">Clear All</button>
      </div>
    `;

    const clearAll = () => {
      Object.assign(hotelSearchState, { q: '', minPrice: '', maxPrice: '', minStarRating: '', minGuestRating: '', starRatings: [], propertyType: [], amenities: [], areas: [], neighborhoods: [], area: '', freeCancellation: false, page: 1, sort: 'recommended' });
      publicNavigate(`/hotels/search?${hotelBuildUrl(hotelSearchState)}`);
    };

    const apply = () => {
      hotelSearchState.q = $('#fNameSearch')?.value.trim() || '';
      hotelSearchState.minPrice = $('#fMinPrice')?.value || '';
      hotelSearchState.maxPrice = $('#fMaxPrice')?.value || '';
      hotelSearchState.propertyType = $$('[data-ptype]:checked').map(i => i.dataset.ptype);
      hotelSearchState.amenities = $$('[data-amenity]:checked').map(i => i.dataset.amenity);
      hotelSearchState.starRatings = $$('[data-star]:checked').map(i => Number(i.dataset.star));
      const allChecked = $('[data-star-all]')?.checked;
      if (allChecked) hotelSearchState.starRatings = [];
      hotelSearchState.areas = $$('[data-area]:checked').map(i => i.dataset.area);
      hotelSearchState.neighborhoods = [];
      hotelSearchState.area = '';
      const scoreEl = $$('[data-score]:checked')[0];
      hotelSearchState.minGuestRating = scoreEl?.dataset.score || '';
      hotelSearchState.freeCancellation = $('#fFreeCancel')?.checked || false;
      hotelSearchState.sort = $$('[data-sort-radio]:checked')[0]?.dataset.sortRadio || hotelSearchState.sort || 'recommended';
      hotelSearchState.page = 1;
      publicNavigate(`/hotels/search?${hotelBuildUrl(hotelSearchState)}`);
    };

    let nameTimer;
    $('#fNameSearch')?.addEventListener('input', () => { clearTimeout(nameTimer); nameTimer = setTimeout(apply, 400); });
    node.querySelectorAll('input[type=checkbox], input[type=radio]').forEach(i => i.addEventListener('change', apply));
    $('#fMinPrice')?.addEventListener('change', apply);
    $('#fMaxPrice')?.addEventListener('change', apply);
    $('#fPriceSlider')?.addEventListener('input', () => {
      const maxInput = $('#fMaxPrice');
      const slider = $('#fPriceSlider');
      if (maxInput && slider) maxInput.value = slider.value;
    });
    $('#fPriceSlider')?.addEventListener('change', apply);
    $('#hotelClearFiltersSide')?.addEventListener('click', clearAll);
    $('#hotelClearFiltersSide2')?.addEventListener('click', clearAll);
    $('#hotelApplyFilters')?.addEventListener('click', apply);
    const starAll = $('[data-star-all]');
    if (starAll) starAll.addEventListener('change', () => {
      if (starAll.checked) {
        $$('[data-star]').forEach(cb => cb.checked = false);
        apply();
      }
    });
  };

  const renderHotelPagination = (r) => {
    const node = $('#hotelPagination');
    if (!node) return;
    if (r.pageCount <= 1) { node.innerHTML = ''; return; }
    node.innerHTML = `<div class="pagination-inner">${r.page > 1 ? `<button class="btn btn-outline" data-page="${r.page - 1}">← Prev</button>` : ''}<span class="page-info">Page ${r.page} of ${r.pageCount} · ${r.total} properties</span>${r.page < r.pageCount ? `<button class="btn btn-outline" data-page="${r.page + 1}">Next →</button>` : ''}</div>`;
    $$('[data-page]', node).forEach(b => b.addEventListener('click', () => {
      hotelSearchState.page = Number(b.dataset.page);
      publicNavigate(`/hotels/search?${hotelBuildUrl(hotelSearchState)}`);
    }));
  };

  const sortElTop = $('#hotelSort');
  if (sortElTop) sortElTop.addEventListener('change', e => {
    hotelSearchState.sort = e.target.value;
    hotelSearchState.page = 1;
    publicNavigate(`/hotels/search?${hotelBuildUrl(hotelSearchState)}`);
  });

  bindHotelModifyForm(search);

  const openFilterSheet = () => {
    const node = $('#hotelFilters');
    if (!node) return;
    openModal($('#genericModal'));
    $('#modalContent').innerHTML = `<div class="modal-heading"><div class="modal-icon blue">${icon('i-sliders')}</div><h2 id="modalTitle">Filters &amp; Sort</h2></div><div id="mobileFiltersSlot"></div><div style="display:flex;gap:8px;margin-top:12px"><button type="button" class="btn btn-primary full-btn" data-close-modal>Show results</button></div>`;
    const slot = $('#mobileFiltersSlot');
    if (slot) slot.appendChild(node);
    const closeBtn = $('#modalContent [data-close-modal]');
    if (closeBtn) closeBtn.addEventListener('click', () => {
      const pane = $('#hotelFiltersPane');
      if (pane && !pane.contains(node)) pane.appendChild(node);
    });
    // Also restore on modal backdrop click
    const modal = $('#genericModal');
    if (modal) {
      const observer = new MutationObserver(() => {
        if (modal.hidden) {
          const pane = $('#hotelFiltersPane');
          if (pane && !pane.contains(node)) pane.appendChild(node);
          observer.disconnect();
        }
      });
      observer.observe(modal, { attributes: true, attributeFilter: ['hidden'] });
    }
  };

  $('#hotelFiltersToggle')?.addEventListener('click', openFilterSheet);
  $('#hotelSheetFilters')?.addEventListener('click', openFilterSheet);
  await loadResults();
}
function roomSelectionFromStore(hotelId) { try { const raw = sessionStorage.getItem(HOTEL_CHECKOUT_KEY); const data = raw ? JSON.parse(raw) : null; return data && data.hotelId === hotelId ? data : null; } catch { return null; } }
function roomSelectionSave(data) { sessionStorage.setItem(HOTEL_CHECKOUT_KEY, JSON.stringify({ ...data, savedAt: Date.now() })); }
function roomSelectionClear() { sessionStorage.removeItem(HOTEL_CHECKOUT_KEY); }
async function renderHotelDetail(root, slug, query) {
  document.title = 'Hotel | Sadik Travels';
  const search = hotelReadQuery(query);
  const nights = Math.max(1, Math.round((new Date(`${search.checkOut}T00:00:00`) - new Date(`${search.checkIn}T00:00:00`)) / 86400000));
  root.innerHTML = publicLoading();
  let hotel;
  try {
    hotel = (await apiRequest(`/hotels/${encodeURIComponent(slug)}?checkIn=${encodeURIComponent(search.checkIn)}&checkOut=${encodeURIComponent(search.checkOut)}`)).hotel;
  } catch (err) {
    root.innerHTML = publicErrorState(err?.status === 404 ? 'The requested hotel was not found.' : (err.message || 'Unable to load hotel.'));
    return;
  }
  if (!hotel) {
    root.innerHTML = publicErrorState('The requested hotel was not found.');
    return;
  }
  document.title = `${hotel.name} | Sadik Travels`;
  const firstImgForSeo = hotel.thumbnail || (hotel.images && hotel.images[0] ? extractImageUrl(hotel.images[0]) : '') || '';
  setSeo({
    title: hotel.name,
    description: hotel.shortDescription || `${hotel.name} in ${hotel.city}. Book with Sadik Travels.`,
    canonical: `/hotels/${hotel.slug}`,
    image: firstImgForSeo,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'Hotel',
      name: hotel.name,
      address: { '@type': 'PostalAddress', addressLocality: hotel.city, addressCountry: hotel.country },
      starRating: { '@type': 'Rating', ratingValue: hotel.starRating },
      ...(hotel.priceFrom ? { priceRange: `BDT ${hotel.priceFrom}` } : {})
    }
  });
  trackAnalytics('hotel_view', { slug: hotel.slug, city: hotel.city });

  // Canonical image handling — use real images only, fallback only when genuinely missing
  const rawImages = Array.isArray(hotel.images) ? hotel.images : [];
  const normalizedImages = rawImages.map(img => {
    const url = extractImageUrl(img);
    return url ? { url, alt: img.alt || hotel.name } : null;
  }).filter(Boolean);
  // Also include thumbnail if it is not already in images
  const thumbUrl = hotel.thumbnail ? String(hotel.thumbnail).trim() : '';
  if (thumbUrl && !normalizedImages.some(i => i.url === thumbUrl)) {
    normalizedImages.unshift({ url: thumbUrl, alt: hotel.name });
  }
  const hasImages = normalizedImages.length > 0;
  const mainImg = hasImages ? normalizedImages[0].url : '';
  const secondaryImages = normalizedImages.slice(1);

  const allSoldOut = Boolean((search.checkIn && search.checkOut) && hotel.rooms?.length && hotel.rooms.every(room => Number(room.available) <= 0));
  const selection = roomSelectionFromStore(hotel.id) || {
    hotelId: hotel.id,
    slug: hotel.slug,
    hotelName: hotel.name,
    hotelCity: hotel.city,
    hotelImage: mainImg,
    checkIn: search.checkIn,
    checkOut: search.checkOut,
    nights,
    rooms: []
  };

  const renderDetail = () => {
    const breadcrumbTrail = [
      { label: 'Home', href: '/' },
      { label: 'Hotels', href: '/hotels' },
      { label: hotel.city || "Cox's Bazar", href: `/hotels/search?destination=${encodeURIComponent(hotel.city || '')}` },
      { label: hotel.name }
    ];

    // Gallery layout logic per requirements
    let galleryHtml = '';
    if (!hasImages) {
      galleryHtml = `
        <div class="hotel-gallery hotel-gallery-empty">
          <div class="hotel-gallery-main hotel-gallery-fallback-main">
            <img src="${HOTEL_PLACEHOLDER}" alt="${escapeHtml(hotel.name)}" />
            <div class="gallery-fallback-text"><strong>SADIK TRAVELS</strong><span>PROPERTY IMAGE COMING SOON</span></div>
          </div>
        </div>`;
    } else if (normalizedImages.length === 1) {
      galleryHtml = `
        <div class="hotel-gallery hotel-gallery-single">
          <button class="hotel-gallery-main" data-gallery-open type="button" aria-label="View photo">
            <img src="${escapeHtml(mainImg)}" alt="${escapeHtml(hotel.name)}" loading="eager" />
            <span class="hotel-gallery-count">${icon('i-images')} 1 photo</span>
          </button>
        </div>`;
    } else if (normalizedImages.length === 2) {
      galleryHtml = `
        <div class="hotel-gallery hotel-gallery-two">
          <button class="hotel-gallery-main" data-gallery-open type="button" aria-label="View photos">
            <img src="${escapeHtml(mainImg)}" alt="${escapeHtml(hotel.name)}" loading="eager" />
            <span class="hotel-gallery-count">${icon('i-images')} ${normalizedImages.length} photos</span>
          </button>
          <div class="hotel-gallery-side">
            <button class="hotel-gallery-side-item" data-thumb="${escapeHtml(secondaryImages[0].url)}" type="button"><img src="${escapeHtml(secondaryImages[0].url)}" alt="" loading="lazy" /></button>
          </div>
        </div>`;
    } else {
      // 3+ images: main + 2 side + view all
      const sideItems = secondaryImages.slice(0, 2).map((img, idx) => `
        <button class="hotel-gallery-side-item" data-thumb="${escapeHtml(img.url)}" data-index="${idx+1}" type="button"><img src="${escapeHtml(img.url)}" alt="" loading="lazy" /></button>
      `).join('');
      const extraCount = normalizedImages.length - 3;
      galleryHtml = `
        <div class="hotel-gallery hotel-gallery-multi">
          <button class="hotel-gallery-main" data-gallery-open type="button" aria-label="View all photos">
            <img src="${escapeHtml(mainImg)}" alt="${escapeHtml(hotel.name)}" loading="eager" />
            <span class="hotel-gallery-count">${icon('i-images')} ${normalizedImages.length} photos</span>
          </button>
          <div class="hotel-gallery-side">
            ${sideItems}
            ${extraCount > 0 ? `<button class="hotel-gallery-side-item hotel-gallery-viewall" data-gallery-open type="button"><span>+${extraCount} more</span><small>View all photos</small></button>` : ''}
          </div>
        </div>`;
    }

    const amenitiesHtml = (hotel.amenities && hotel.amenities.length) ? `
      <section class="hotel-section hotel-amenities-section">
        <h2>Property Amenities</h2>
        <div class="amenity-grid">
          ${hotel.amenities.map(a => `<span class="amenity-item">${icon('i-check')} ${escapeHtml(a)}</span>`).join('')}
        </div>
      </section>` : '';

    const descriptionHtml = hotel.description ? `<section class="hotel-section"><h2>About This Property</h2><div class="hotel-prose"><p>${escapeHtml(hotel.description).replace(/\n/g, '<br />')}</p></div></section>` :
      hotel.shortDescription ? `<section class="hotel-section"><h2>About This Property</h2><div class="hotel-prose"><p>${escapeHtml(hotel.shortDescription)}</p></div></section>` : '';

    const checkInOutHtml = `
      <div class="hotel-checkinout">
        ${hotel.checkInTime ? `<div class="check-item"><small>Check-in</small><strong>${escapeHtml(hotel.checkInTime)}</strong></div>` : ''}
        ${hotel.checkOutTime ? `<div class="check-item"><small>Check-out</small><strong>${escapeHtml(hotel.checkOutTime)}</strong></div>` : ''}
      </div>`;

    const contactHtml = (hotel.phone || hotel.email || hotel.website) ? `
      <section class="hotel-section">
        <h3>Contact the property</h3>
        <div class="hotel-contact-row">
          ${hotel.phone ? `<a href="tel:${escapeHtml(hotel.phone.replace(/[^+\d]/g, ''))}" class="contact-chip">${icon('i-phone')}${escapeHtml(hotel.phone)}</a>` : ''}
          ${hotel.email ? `<a href="mailto:${escapeHtml(hotel.email)}" class="contact-chip">${icon('i-mail')}${escapeHtml(hotel.email)}</a>` : ''}
          ${hotel.website ? `<a href="${escapeHtml(hotel.website)}" target="_blank" rel="noopener" class="contact-chip">${icon('i-globe')}Website</a>` : ''}
        </div>
      </section>` : '';

    const locationHtml = (hotel.latitude && hotel.longitude) ? `
      <section class="hotel-section">
        <h3>Location</h3>
        <div class="hotel-map">
          <iframe title="Map of ${escapeHtml(hotel.name)}" loading="lazy" src="https://www.openstreetmap.org/export/embed.html?bbox=${Number(hotel.longitude) - 0.01}%2C${Number(hotel.latitude) - 0.008}%2C${Number(hotel.longitude) + 0.01}%2C${Number(hotel.latitude) + 0.008}&amp;layer=mapnik&amp;marker=${Number(hotel.latitude)}%2C${Number(hotel.longitude)}"></iframe>
          <p class="hotel-address">${escapeHtml([hotel.address, hotel.area, hotel.city, hotel.country].filter(Boolean).join(', '))}</p>
        </div>
      </section>` : '';

    root.innerHTML = `
      <div class="hotel-detail-page">
        ${hotelBreadcrumb(breadcrumbTrail)}

        ${galleryHtml}

        ${allSoldOut ? `<div class="hotel-soldout-banner">${icon('i-info')} Not available for the selected dates (${formatDate(search.checkIn)} → ${formatDate(search.checkOut)}). Try different dates or <a href="/hotels/search?${escapeHtml(hotelBuildUrl({ ...search, destination: hotel.city }))}" data-public-route="/hotels/search?${escapeHtml(hotelBuildUrl({ ...search, destination: hotel.city }))}">browse other hotels</a>.</div>` : ''}

        <div class="hotel-detail-layout">
          <div class="hotel-detail-maincol">
            <section class="hotel-section hotel-info-section">
              <div class="hotel-detail-head">
                <div class="hotel-head-left">
                  <div class="hotel-card-stars">${hotelStars(hotel.starRating)}</div>
                  <h1 class="hotel-detail-title">${escapeHtml(hotel.name)}</h1>
                  <p class="hotel-card-loc hotel-detail-loc">${icon('i-location')}${escapeHtml([hotel.address || hotel.area || '', hotel.city].filter(Boolean).join(', ') || hotel.city || '')}</p>
                  <div class="hotel-detail-meta">${icon('i-tag')} ${escapeHtml(hotel.propertyType || 'Hotel')} · ${hotel.area ? escapeHtml(hotel.area) + ' · ' : ''}${escapeHtml(hotel.city || '')}</div>
                  ${checkInOutHtml}
                </div>
                <div class="hotel-head-right">
                  ${(hotel.reviewCount || 0) > 0 ? `<div class="hotel-card-rating hotel-rating-large"><strong>${Number(hotel.guestRating || hotel.starRating || 0).toFixed(1)}</strong><small>${escapeHtml(hotelRatingLabel(hotel.guestRating || hotel.starRating))}</small><em>${hotel.reviewCount} review${hotel.reviewCount === 1 ? '' : 's'}</em></div>` : '<div class="hotel-card-rating new"><small>New property</small></div>'}
                  ${typeof hotel.priceFrom === 'number' ? `<div class="hotel-price-badge-detail"><small>From</small><strong>${hotelMoney(hotel.priceFrom)}</strong><span>per night</span></div>` : ''}
                </div>
              </div>
            </section>

            ${amenitiesHtml}

            ${descriptionHtml}

            ${hotel.cancellationPolicy ? `<section class="hotel-section"><h3>Cancellation Policy</h3><p class="hotel-policy">${escapeHtml(hotel.cancellationPolicy.type === 'free' ? `Free cancellation${hotel.cancellationPolicy.freeUntilDays ? ` up to ${hotel.cancellationPolicy.freeUntilDays} day${hotel.cancellationPolicy.freeUntilDays === 1 ? '' : 's'} before check-in` : ''}.` : 'Non-refundable.')}${hotel.cancellationPolicy.description ? ` ${escapeHtml(hotel.cancellationPolicy.description)}` : ''}</p></section>` : ''}

            ${contactHtml}

            ${locationHtml}

            <section class="hotel-section hotel-rooms-section" id="rooms">
              <div class="section-heading hotel-rooms-heading">
                <div>
                  <span class="hs-eyebrow">${icon('i-bed')} Availability</span>
                  <h2>Available Rooms</h2>
                  <p>${formatDate(search.checkIn)} → ${formatDate(search.checkOut)} · ${hotelNightWord(nights)} · ${hotelGuestsWord(search.adults, search.children)}</p>
                </div>
              </div>
              <div class="hotel-rooms-grid" id="hotelRoomsGrid">
                ${hotel.rooms && hotel.rooms.length ? hotel.rooms.map(room => hotelRoomCardHtml(room, hotel, selection, nights)).join('') : publicEmptyState('No rooms published', 'Room types will appear here after an admin adds them.', '')}
              </div>
            </section>

            <section class="hotel-similar-section" id="similar">
              <div class="section-heading">
                <div><span class="hs-eyebrow">${icon('i-hotel')} More stays</span><h2>Similar Hotels</h2><p>Other properties travellers also look at in ${escapeHtml(hotel.city)}.</p></div>
              </div>
              <div class="hotel-results-grid" id="hotelSimilarGrid"><div class="public-public-loading"><span class="spinner"></span>Loading similar hotels…</div></div>
            </section>
          </div>

          <aside class="hotel-detail-sidecol">
            <div class="hotel-booking-card">
              <div class="hotel-booking-card-head">
                <div class="hotel-booking-price">
                  ${typeof hotel.priceFrom === 'number' ? `<strong>${hotelMoney(hotel.priceFrom)}</strong><small>per night</small>` : '<strong>On request</strong>'}
                </div>
                <small class="hotel-booking-meta">${formatDate(search.checkIn)} → ${formatDate(search.checkOut)} · ${hotelNightWord(nights)}</small>
              </div>
              <div class="hotel-booking-actions">
                <a href="#rooms" class="btn btn-primary full-btn" data-scroll-rooms>${icon('i-bed')} Book Now</a>
                <button type="button" class="btn btn-outline full-btn" data-chat-hotel>${icon('i-headset')} Chat with Hotel</button>
              </div>
              <p class="hotel-booking-note">Secure booking · Instant confirmation · No hidden fees</p>
            </div>

            <div class="hotel-support-card">
              <strong>${icon('i-headset')} Need help?</strong>
              <p>Our travel specialists answer within minutes during business hours.</p>
              <a class="btn btn-outline full-btn" href="/support" data-public-route="/support">Contact support</a>
            </div>
          </aside>
        </div>
      </div>
    `;

    wrapPublicRouteContent(root);
    bindHotelDetail(hotel, selection, search, normalizedImages);
    void loadSimilarHotels();
  };

  function hotelRoomCardHtml(room, hotel, selection, nights) {
    const soldOut = Number(room.available) <= 0;
    const selected = selection.rooms.find(r => r.roomId === room.id);
    const img = room.images?.[0] ? extractImageUrl(room.images[0]) : (hotel.thumbnail || (hotel.images?.[0] ? extractImageUrl(hotel.images[0]) : ''));
    const discountBadge = room.originalPrice && room.originalPrice > room.pricePerNight ? `<span class="room-discount">-${Math.round((1 - room.pricePerNight / room.originalPrice) * 100)}% OFF</span>` : '';
    const hasRoomImage = Boolean(img && !img.includes('hotel-placeholder'));
    return `<article class="hotel-room-card${soldOut ? ' soldout' : ''}${selected ? ' selected' : ''}" data-room-id="${escapeHtml(room.id)}">
      <div class="hotel-room-media">
        ${hasRoomImage ? `<img src="${escapeHtml(img)}" alt="${escapeHtml(room.name)}" loading="lazy" />` : `<div class="hotel-img-fallback room-fallback"><img src="${HOTEL_PLACEHOLDER}" alt="" /></div>`}
        ${discountBadge}
      </div>
      <div class="hotel-room-body">
        <div class="hotel-room-top">
          <div class="hotel-room-titlewrap">
            <h3>${escapeHtml(room.name)}</h3>
            <p class="hotel-room-meta">${[room.size ? `${room.size} sq ft` : '', room.bedType || '', `${room.maxGuests || room.maxAdults || 2} guests`, room.numBeds ? `${room.numBeds} bed${room.numBeds === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ')}</p>
          </div>
          ${soldOut ? '<span class="room-status soldout">Sold out</span>' : Number(room.available) <= 3 ? `<span class="room-status low">Only ${room.available} left</span>` : `<span class="room-status ok">${room.available} available</span>`}
        </div>
        <div class="hotel-room-amenities">${(room.amenities || []).slice(0, 6).map(a => `<span class="room-amenity">${icon('i-check')} ${escapeHtml(a)}</span>`).join('') || '<span class="room-amenity muted">Verified room</span>'}</div>
        ${room.mealPlan ? `<p class="hotel-room-meal">${icon('i-check')} ${escapeHtml(room.mealPlan)}</p>` : ''}
        ${room.description ? `<p class="hotel-room-desc">${escapeHtml(room.description.slice(0, 160))}${room.description.length > 160 ? '…' : ''}</p>` : ''}
      </div>
      <div class="hotel-room-price">
        ${room.originalPrice && room.originalPrice > room.pricePerNight ? `<small class="room-original">${hotelMoney(room.originalPrice)}</small>` : ''}
        <div class="room-price-main"><strong>${hotelMoney(room.pricePerNight)}</strong><span>/ night</span></div>
        <small class="room-total">${hotelMoney(room.pricePerNight * nights)} for ${hotelNightWord(nights)}</small>
        ${room.cancellationPolicy?.type === 'non_refundable' ? '<small class="room-nonrefund">Non-refundable</small>' : '<small class="room-freecancel">Free cancellation</small>'}
        ${soldOut ? '<button class="btn btn-outline full-btn" disabled>Sold out</button>' : selected ? `<div class="room-selected"><span class="room-selected-label">${icon('i-check')} Selected</span><button class="btn btn-outline btn-sm" type="button" data-remove-room="${escapeHtml(room.id)}">Remove</button></div>` : `<button class="btn btn-primary full-btn" type="button" data-select-room="${escapeHtml(room.id)}">Select Room</button>`}
      </div>
    </article>`;
  }

  async function loadSimilarHotels() {
    const grid = $('#hotelSimilarGrid');
    if (!grid) return;
    try {
      const r = await apiRequest(`/hotels?city=${encodeURIComponent(hotel.city || '')}&pageSize=6&sort=rating`);
      const similar = (r.hotels || []).filter(item => item.id !== hotel.id).slice(0, 3);
      if (!similar.length) {
        grid.innerHTML = publicEmptyState('No similar hotels yet', 'More properties in this area will appear here.', '');
        return;
      }
      grid.innerHTML = similar.map(h => hotelCardHtml(h, { checkIn: search.checkIn, checkOut: search.checkOut, adults: search.adults, children: search.children, rooms: search.rooms })).join('');
    } catch (err) {
      grid.innerHTML = publicEmptyState('Similar hotels unavailable', 'Try searching again from the hotel search page.', '<a class="btn btn-outline" href="/hotels" data-public-route="/hotels">Search hotels</a>');
    }
  }

  function bindHotelDetail(hotel, selection, search, normalizedImages) {
    // Gallery open
    $$('[data-gallery-open]').forEach(el => el.addEventListener('click', () => {
      hotelGalleryModal(normalizedImages, 0);
    }));
    $$('[data-thumb]').forEach(el => el.addEventListener('click', () => {
      const url = el.dataset.thumb;
      const idx = normalizedImages.findIndex(i => i.url === url);
      hotelGalleryModal(normalizedImages, Math.max(0, idx));
    }));
    $$('[data-chat-hotel]').forEach(btn => btn.addEventListener('click', () => {
      void openHotelChat({ id: hotel.id, name: hotel.name });
    }));
    $$('[data-select-room]').forEach(btn => btn.addEventListener('click', () => {
      const room = hotel.rooms.find(r => r.id === btn.dataset.selectRoom);
      if (!room) return;
      if (selection.rooms.some(r => r.roomId === room.id)) return;
      selection.rooms.push({
        roomId: room.id,
        roomName: room.name,
        quantity: 1,
        pricePerNight: room.pricePerNight,
        maxGuests: room.maxGuests || room.maxAdults || 2,
        image: room.images?.[0] ? extractImageUrl(room.images[0]) : mainImg
      });
      selection.hotelId = hotel.id;
      selection.slug = hotel.slug;
      selection.hotelName = hotel.name;
      selection.hotelCity = hotel.city;
      selection.hotelImage = mainImg;
      roomSelectionSave(selection);
      renderDetail();
      updateSticky();
    }));
    $$('[data-remove-room]').forEach(btn => btn.addEventListener('click', () => {
      const idx = selection.rooms.findIndex(r => r.roomId === btn.dataset.removeRoom);
      if (idx >= 0) selection.rooms.splice(idx, 1);
      roomSelectionSave(selection);
      renderDetail();
      updateSticky();
    }));
    $$('[data-scroll-rooms]').forEach(btn => btn.addEventListener('click', (e) => {
      e.preventDefault();
      document.getElementById('rooms')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }));
    updateSticky();
  }

  function updateSticky() {
    const bar = $('#hotelStickyBar');
    const total = selection.rooms.reduce((s, r) => s + r.pricePerNight * selection.nights, 0);
    if (!selection.rooms.length) {
      if (bar) bar.remove();
      return;
    }
    const html = `<div class="hotel-sticky-bar" id="hotelStickyBar">
      <div class="hotel-sticky-info"><strong>${hotelMoney(total)}</strong><small>${selection.rooms.length} room${selection.rooms.length > 1 ? 's' : ''} · ${hotelNightWord(selection.nights)}</small></div>
      <button class="btn btn-primary" id="hotelContinueBtn">Continue to Book</button>
    </div>`;
    if (bar) bar.outerHTML = html;
    else root.insertAdjacentHTML('beforeend', html);
    $('#hotelContinueBtn')?.addEventListener('click', () => {
      if (!currentUser) {
        showToast('Please login to continue with your booking.', 'error');
        openLogin();
        return;
      }
      publicNavigate('/booking/checkout');
    });
  }

  renderDetail();
}
async function renderHotelCheckout(root) {
  document.title = 'Checkout | Sadik Travels';
  if (!currentUser) { root.innerHTML = publicPageHeader('Booking', 'Checkout', 'Please login to complete your hotel booking.', '') + publicEmptyState('Login required', 'Sign in to continue with your booking.', '<button class="btn btn-primary" id="checkoutLogin">Login</button>'); $('#checkoutLogin')?.addEventListener('click', openLogin); return; }
  const sel = roomSelectionFromStore(''); // any
  let data = null; try { const raw = sessionStorage.getItem(HOTEL_CHECKOUT_KEY); data = raw ? JSON.parse(raw) : null; } catch {}
  if (!data || !data.rooms?.length) { root.innerHTML = publicPageHeader('Booking', 'Checkout', 'Review and confirm your hotel booking.', '') + publicEmptyState('No rooms selected', 'Choose a room from a hotel to start your booking.', '<a class="btn btn-primary" href="/hotels" data-public-route="/hotels">Search hotels</a>'); return; }
  // Fetch authoritative price quote from the server.
  root.innerHTML = publicPageHeader('Booking', 'Checkout', 'Review your stay and confirm. Final pricing is calculated securely by Sadik Travels.', '') + `<section class="public-page-card"><div class="public-public-loading"><span class="spinner"></span>Calculating price…</div></section>`;
  let quote; try { quote = await apiRequest('/hotels/price-quote', { method: 'POST', body: JSON.stringify({ hotelId: data.hotelId, checkIn: data.checkIn, checkOut: data.checkOut, rooms: data.rooms.map(r => ({ roomId: r.roomId, quantity: r.quantity, adults: r.adults || 2, children: r.children || 0 })) }) }); }
  catch (error) { root.innerHTML = publicPageHeader('Booking', 'Checkout', 'Review and confirm your hotel booking.', '') + publicErrorState(error.message || 'Unable to calculate the booking price. The room may no longer be available.'); return; }
  const b = quote.breakdown;
  document.title = `Checkout · ${data.hotelName} | Sadik Travels`;
  root.innerHTML = hotelBreadcrumb([{ label: 'Home', href: '/' }, { label: 'Hotels', href: '/hotels' }, { label: data.hotelName, href: `/hotels/${data.slug}` }, { label: 'Checkout', href: '/booking/checkout' }]) + `
    <div class="checkout-layout">
      <form id="hotelCheckoutForm" class="checkout-main">
        <section class="public-page-card"><h3>Primary guest</h3>
          <div class="checkout-grid">
            <label class="modal-field"><span>First name</span><input id="ckFirstName" required /></label>
            <label class="modal-field"><span>Last name</span><input id="ckLastName" required /></label>
            <label class="modal-field"><span>Email</span><input id="ckEmail" type="email" required value="${escapeHtml(currentUser.email || '')}" /></label>
            <label class="modal-field"><span>Phone</span><input id="ckPhone" required value="${escapeHtml(currentUser.phone || '')}" /></label>
            <label class="modal-field"><span>Country</span><input id="ckCountry" value="Bangladesh" /></label>
          </div>
        </section>
        <section class="public-page-card"><h3>Guests per room</h3><div id="ckRoomGuests">${quote.rooms.map((room, i) => `<div class="checkout-room"><div><strong>${escapeHtml(room.roomName)}${room.quantity > 1 ? ` × ${room.quantity}` : ''}</strong><small>Max ${room.maxGuests || (room.adults + room.children)} guests per room</small></div><div class="checkout-room-guests"><label>Adults<input type="number" min="1" max="20" data-room="${i}" data-kind="adults" value="${room.adults}" /></label><label>Children<input type="number" min="0" max="10" data-room="${i}" data-kind="children" value="${room.children}" /></label></div></div>`).join('')}</div></section>
        <section class="public-page-card"><h3>Special requests <small>(optional)</small></h3><textarea id="ckRequests" rows="3" placeholder="High floor, late check-in, airport transfer, extra bed…"></textarea><p class="form-hint">Requests are not guaranteed unless confirmed by the property.</p></section>
        <section class="public-page-card"><h3>Payment method</h3><div class="checkout-pay">${['online', 'bank_transfer', 'cash', 'pay_later'].map((m, i) => `<label class="pay-option"><input type="radio" name="payMethod" value="${m}" ${i === 3 ? 'checked' : ''} /><span><strong>${escapeHtml(m === 'online' ? 'Online payment' : m === 'bank_transfer' ? 'Bank transfer' : m === 'cash' ? 'Cash at hotel' : 'Pay later / Request')}</strong><small>${escapeHtml(m === 'online' ? 'Pay securely through the configured gateway' : m === 'bank_transfer' ? 'Pay via bank transfer and submit receipt' : m === 'cash' ? 'Pay in cash at the property' : 'Send a booking request; pay after confirmation')}</small></span></label>`).join('')}</div></section>
      </form>
      <aside class="checkout-summary">
        <div class="public-page-card sticky-summary">
          <h3>${escapeHtml(data.hotelName)}</h3>
          <p class="hotel-card-loc">${icon('i-location')}${escapeHtml(data.hotelCity || '')}</p>
          <p class="summary-dates">${formatDate(data.checkIn)} → ${formatDate(data.checkOut)}<br><small>${hotelNightWord(b.nights)} · ${data.rooms.length} room${data.rooms.length > 1 ? 's' : ''}</small></p>
          <div class="summary-rooms">${quote.rooms.map(r => `<div><span>${escapeHtml(r.roomName)}${r.quantity > 1 ? ` × ${r.quantity}` : ''}</span><strong>${hotelMoney(r.subtotal)}</strong></div>`).join('')}</div>
          <dl class="summary-breakdown">
            <div><dt>Room total</dt><dd>${hotelMoney(b.roomTotal)}</dd></div>
            ${b.discount > 0 ? `<div><dt>Discount</dt><dd>− ${hotelMoney(b.discount)}</dd></div>` : ''}
            <div><dt>Taxes</dt><dd>${hotelMoney(b.taxes)}</dd></div>
            <div><dt>Service fee</dt><dd>${hotelMoney(b.serviceFee)}</dd></div>
            <div class="summary-total"><dt>Total</dt><dd>${hotelMoney(b.total)}</dd></div>
          </dl>
          <button class="btn btn-primary full-btn" id="ckConfirm">${icon('i-check')} Confirm booking</button>
          <p class="form-hint">You won't be charged until the booking is confirmed. Inventory is reserved at confirmation.</p>
        </div>
      </aside>
    </div>`;
  $('#ckConfirm').addEventListener('click', async () => {
    const firstName = $('#ckFirstName').value.trim(); const lastName = $('#ckLastName').value.trim(); const email = $('#ckEmail').value.trim(); const phone = $('#ckPhone').value.trim();
    if (!firstName || !lastName || !email || !phone) { showToast('Please complete the primary guest details.', 'error'); return; }
    const rooms = quote.rooms.map((room, i) => ({ roomId: room.roomId, quantity: room.quantity, adults: Number($(`[data-room="${i}"][data-kind="adults"]`).value) || room.adults, children: Number($(`[data-room="${i}"][data-kind="children"]`).value) || room.children }));
    const payMethod = $('input[name="payMethod"]:checked').value;
    const btn = $('#ckConfirm'); btn.disabled = true; const orig = btn.innerHTML; btn.textContent = 'Confirming…';
    try {
      const response = await apiRequest('/hotels/bookings', { method: 'POST', body: JSON.stringify({ hotelId: data.hotelId, checkIn: data.checkIn, checkOut: data.checkOut, rooms, primaryGuest: { firstName, lastName, email, phone, country: $('#ckCountry').value.trim() || undefined }, specialRequests: $('#ckRequests').value.trim() || undefined, paymentMethod: payMethod }) });
      const booking = response.booking;
      roomSelectionClear();
      if (payMethod === 'online') { try { const pay = await apiRequest('/initiate-payment', { method: 'POST', body: JSON.stringify({ bookingId: booking.id, kind: 'hotel' }) }); if (pay.checkoutUrl) { showToast('Booking saved. Redirecting to bKash / Nagad / card…', 'success'); setTimeout(() => { window.location.href = pay.checkoutUrl; }, 800); return; } } catch (error) { showToast(`Booking created, but online payment is unavailable: ${error.message}`, 'error'); } }
      showToast(`Booking ${booking.bookingNumber} confirmed.`, 'success');
      publicNavigate(`/booking/${booking.id}`);
    } catch (error) { showToast(error.message || 'Unable to create booking. The room may no longer be available.', 'error'); btn.disabled = false; btn.innerHTML = orig; }
  });
}
async function renderMyBookings(root) {
  document.title = 'My Bookings | Sadik Travels';
  if (!currentUser) { root.innerHTML = publicPageHeader('Account', 'My Bookings', 'View and manage your hotel bookings.', '') + publicEmptyState('Login required', 'Sign in to view your bookings.', '<button class="btn btn-primary" id="mbLogin">Login</button>'); $('#mbLogin')?.addEventListener('click', openLogin); return; }
  root.innerHTML = publicPageHeader('Account', 'My Bookings', 'Your hotel bookings with Sadik Travels.', `<a class="btn btn-outline" href="/hotels" data-public-route="/hotels">Book a stay</a>`) + `<section class="public-page-card"><div class="public-public-loading"><span class="spinner"></span>Loading your bookings…</div></section>`;
  let bookings; try { bookings = (await apiRequest('/hotels/bookings')).bookings || []; } catch { root.querySelector('.public-page-card').innerHTML = publicErrorState('Unable to load your bookings.'); return; }
  const tabs = [['upcoming', 'Upcoming'], ['completed', 'Completed'], ['cancelled', 'Cancelled']];
  const classify = (b) => ['cancelled', 'refunded'].includes(b.status) ? 'cancelled' : b.status === 'completed' ? 'completed' : 'upcoming';
  const renderList = (active) => {
    const filtered = bookings.filter(b => classify(b) === active);
    return `<div class="bookings-tabs">${tabs.map(([k, label]) => `<button class="bookings-tab ${k === active ? 'active' : ''}" data-tab="${k}">${label}</button>`).join('')}</div>
      <div class="bookings-list">${filtered.length ? filtered.map(b => {
        const href = `/booking/${b.id}`;
        return `<a class="booking-row" href="${escapeHtml(href)}" data-public-route="${escapeHtml(href)}">
          <div class="booking-row-media">${hotelImageTag(b.hotelSnapshot?.image, booking?.hotelSnapshot?.name || '')}</div>
          <div class="booking-row-main"><strong>${escapeHtml(b.hotelSnapshot?.name || 'Hotel')}</strong><small>${escapeHtml(b.bookingNumber)} · ${formatDate(b.checkIn)} → ${formatDate(b.checkOut)}</small><span>${b.rooms.length} room${b.rooms.length > 1 ? 's' : ''} · ${hotelGuestsWord(b.rooms.reduce((s, r) => s + r.adults, 0), b.rooms.reduce((s, r) => s + r.children, 0))}</span></div>
          <div class="booking-row-side"><strong>${hotelMoney(b.priceBreakdown.total)}</strong><span class="hotel-status hotel-status-${escapeHtml(b.status)}">${escapeHtml(b.status.replace(/_/g, ' '))}</span></div>
        </a>`;
      }).join('') : publicEmptyState(`No ${active} bookings`, active === 'upcoming' ? 'Your upcoming hotel stays will appear here.' : 'Nothing here yet.', '')}</div>`;
  };
  root.innerHTML = publicPageHeader('Account', 'My Bookings', 'Your hotel bookings with Sadik Travels.', `<a class="btn btn-outline" href="/hotels" data-public-route="/hotels">Book a stay</a>`) + `<section class="public-page-card">${renderList('upcoming')}</section>`;
  $$('[data-tab]').forEach(t => t.addEventListener('click', () => { $('.public-page-card').innerHTML = renderList(t.dataset.tab); $$('[data-tab]').forEach(x => x.classList.toggle('active', x === t)); $$('[data-tab]').forEach(x => { /* rebind */ }); $$('.bookings-list [data-public-route]').forEach(() => {}); }));
}
async function renderBookingDetail(root, id) {
  document.title = 'Booking | Sadik Travels';
  root.innerHTML = publicLoading();
  let booking, cancellation; try { const r = await apiRequest(`/hotels/bookings/${encodeURIComponent(id)}`); booking = r.booking; cancellation = r.cancellation; } catch { root.innerHTML = publicErrorState('The requested booking was not found.'); return; }
  if (!booking) { root.innerHTML = publicErrorState('The requested booking was not found.'); return; }
  document.title = `${booking.bookingNumber} | Sadik Travels`;
  const b = booking.priceBreakdown;
  const confirmed = ['confirmed', 'completed'].includes(booking.status);
  root.innerHTML = hotelBreadcrumb([{ label: 'Home', href: '/' }, { label: 'My Bookings', href: '/bookings' }, { label: booking.bookingNumber, href: `/booking/${booking.id}` }]) + `
    <div class="receipt-layout">
      <div class="receipt-main">
        <section class="public-page-card receipt-card" id="receiptCard">
          <div class="receipt-top"><div><span class="receipt-eyebrow">${confirmed ? 'Booking confirmed' : escapeHtml(booking.status.replace(/_/g, ' '))}</span><h2>${escapeHtml(booking.hotelSnapshot?.name || 'Hotel')}</h2><p class="hotel-card-loc">${icon('i-location')}${escapeHtml([booking.hotelSnapshot?.address, booking.hotelSnapshot?.city].filter(Boolean).join(', '))}</p></div><div class="receipt-id"><small>Booking ID</small><strong>${escapeHtml(booking.bookingNumber)}</strong></div></div>
          <div class="receipt-dates"><div><small>Check-in</small><strong>${formatDate(booking.checkIn)}</strong></div><div><small>Check-out</small><strong>${formatDate(booking.checkOut)}</strong></div><div><small>Stay</small><strong>${hotelNightWord(booking.nights)}</strong></div></div>
          <div class="receipt-rooms">${booking.rooms.map(r => `<div class="receipt-room"><div><strong>${escapeHtml(r.roomName)}${r.quantity > 1 ? ` × ${r.quantity}` : ''}</strong><small>${hotelGuestsWord(r.adults, r.children)}</small></div><strong>${hotelMoney(r.subtotal)}</strong></div>`).join('')}</div>
          <dl class="summary-breakdown"><div><dt>Room total</dt><dd>${hotelMoney(b.roomTotal)}</dd></div>${b.discount > 0 ? `<div><dt>Discount</dt><dd>− ${hotelMoney(b.discount)}</dd></div>` : ''}<div><dt>Taxes</dt><dd>${hotelMoney(b.taxes)}</dd></div><div><dt>Service fee</dt><dd>${hotelMoney(b.serviceFee)}</dd></div><div class="summary-total"><dt>Total paid / due</dt><dd>${hotelMoney(b.total)}</dd></div></dl>
          <div class="receipt-meta"><div><span>Guest</span><strong>${escapeHtml(`${booking.primaryGuest.firstName} ${booking.primaryGuest.lastName}`)}</strong></div><div><span>Contact</span><strong>${escapeHtml(booking.primaryGuest.phone)} · ${escapeHtml(booking.primaryGuest.email)}</strong></div><div><span>Payment</span><strong>${escapeHtml(booking.paymentMethod.replace(/_/g, ' '))} · ${escapeHtml(booking.paymentStatus)}</strong></div><div><span>Status</span><strong>${escapeHtml(booking.status.replace(/_/g, ' '))}</strong></div></div>
          ${booking.specialRequests ? `<div class="receipt-note"><small>Special requests</small><p>${escapeHtml(booking.specialRequests)}</p></div>` : ''}
        </section>
      </div>
      <aside class="receipt-side">
        <div class="public-page-card sticky-summary">
          <h3>Manage booking</h3>
          <div class="receipt-side-status"><span class="hotel-status hotel-status-${escapeHtml(booking.status)}">${escapeHtml(booking.status.replace(/_/g, ' '))}</span><span class="hotel-status hotel-pay-${escapeHtml(booking.paymentStatus)}">${escapeHtml(booking.paymentStatus)}</span></div>
          ${!['cancelled', 'refunded', 'completed'].includes(booking.status) && booking.paymentStatus !== 'paid' ? `<button class="btn btn-primary full-btn" id="bkPay">${icon('i-tag')} ${booking.status === 'payment_pending' ? 'Retry payment' : 'Pay now'}</button>` : ''}
          ${cancellation?.allowed ? `<button class="btn btn-outline full-btn" id="bkCancel">Cancel booking</button>${cancellation.reason ? `<p class="form-hint">${escapeHtml(cancellation.reason)}</p>` : ''}` : `<p class="form-hint">${escapeHtml(cancellation?.reason || 'This booking cannot be cancelled.')}</p>`}
          <button class="btn btn-outline full-btn" id="bkPrint">${icon('i-print')} Print receipt</button>
          <a class="btn btn-outline full-btn" href="/bookings" data-public-route="/bookings">All bookings</a>
        </div>
      </aside>
    </div>`;
  $('#bkPrint')?.addEventListener('click', () => { const area = $('#receiptCard'); if (!area) return; const win = window.open('', '_blank', 'width=820,height=900'); if (!win) { showToast('Allow pop-ups to print the receipt.', 'error'); return; } win.document.write(`<html><head><title>${escapeHtml(booking.bookingNumber)} · Sadik Travels</title><style>${RECEIPT_PRINT_CSS}</style></head><body>${area.innerHTML}</body></html>`); win.document.close(); win.focus(); setTimeout(() => { win.print(); }, 350); });
  $('#bkPay')?.addEventListener('click', async () => { const btn = $('#bkPay'); btn.disabled = true; btn.textContent = 'Preparing…'; try { const r = await apiRequest(`/hotels/bookings/${booking.id}/pay`, { method: 'POST', body: JSON.stringify({ paymentMethod: 'online' }) }); if (r.checkoutUrl) { window.location.href = r.checkoutUrl; return; } showToast(r.message || 'Payment request recorded.', 'success'); void renderPublicRoute(); } catch (error) { showToast(error.message || 'Payment is unavailable.', 'error'); btn.disabled = false; btn.innerHTML = `${icon('i-tag')} Pay now`; } });
  $('#bkCancel')?.addEventListener('click', async () => { if (!confirm('Cancel this booking? Inventory will be released.')) return; const btn = $('#bkCancel'); btn.disabled = true; btn.textContent = 'Cancelling…'; try { await apiRequest(`/hotels/bookings/${booking.id}/cancel`, { method: 'POST' }); showToast('Booking cancelled.', 'success'); void renderPublicRoute(); } catch (error) { showToast(error.message || 'Unable to cancel booking.', 'error'); btn.disabled = false; btn.textContent = 'Cancel booking'; } });
}
const RECEIPT_PRINT_CSS = `*{box-sizing:border-box}body{font-family:Inter,Segoe UI,Arial,sans-serif;color:#1a2b3d;margin:32px;max-width:680px}h2{margin:0 0 4px;font-size:22px}h3{margin:0 0 10px;font-size:15px}.receipt-top{display:flex;justify-content:space-between;border-bottom:2px solid #001ea0;padding-bottom:14px;margin-bottom:14px}.receipt-eyebrow{color:#001ea0;font-size:11px;font-weight:800;letter-spacing:.1em;text-transform:uppercase}.receipt-id{text-align:right}.receipt-id small{display:block;font-size:11px;color:#6b7280}.receipt-id strong{font-size:16px}.receipt-dates{display:flex;gap:24px;margin:16px 0;padding:12px;background:#f6f8fc;border-radius:8px}.receipt-dates small{display:block;color:#6b7280;font-size:11px}.receipt-rooms{margin:14px 0}.receipt-room{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px dashed #e4e8ee;font-size:13px}.receipt-room small{display:block;color:#6b7280}.summary-breakdown{margin:14px 0 0}.summary-breakdown div{display:flex;justify-content:space-between;padding:6px 0;font-size:13px;border-bottom:1px solid #eef1f6}.summary-breakdown dt{color:#6b7280}.summary-total{font-weight:800;font-size:16px;border-bottom:none!important}.receipt-meta{margin-top:16px}.receipt-meta div{display:flex;justify-content:space-between;padding:5px 0;font-size:12px}.receipt-meta span{color:#6b7280}.receipt-note{margin-top:14px;padding:10px;background:#fff8e6;border-radius:8px;font-size:12px}.hotel-card-loc{color:#6b7280;font-size:12px}`;

window.renderPublicRoute = renderPublicRoute;
window.publicNavigate = publicNavigate;
window.openLogin = openLogin;
window.showToast = showToast;
window.updateAuthUi = updateAuthUi;
bindPublicRouter();
document.addEventListener('click', (event) => {
  const link = event.target.closest('[data-scroll]');
  if (!link) return;
  const path = location.pathname.replace(/\/+$/, '') || '/';
  if (path !== '/') return;

  // Sidebar navigation items also carry data-scroll so their matching home
  // section can be highlighted. They must still open their actual page; the
  // old handler converted them to a hash URL and left the user on the home
  // screen, which looked like the navigation button was stuck loading.
  if (link.classList.contains('side-link')) return;

  event.preventDefault();
  event.stopImmediatePropagation();
  navigateToSection(link.dataset.scroll);
}, true);
async function initStorefront() {
  // Resolve the persisted session before rendering route-protected pages so a
  // valid refresh cookie is honoured on reload/direct-link, and an expired
  // access token never causes an auth flicker or a false login redirect.
  if (appConfig.liveApi) {
    void applySiteSettings();
    void applySiteNavigation();
    void applyPublicContent();
    const initialPath = location.pathname.replace(/\/+$/, '') || '/';
    if (initialPath !== '/') {
      const home = document.querySelector('main');
      const root = $('#publicRouteRoot');
      if (home && root) { home.hidden = true; root.hidden = false; root.innerHTML = publicLoading(); }
    }
  }
  try {
    const response = await apiRequest('/auth/me');
    updateAuthUi(response.user);
  } catch {
    updateAuthUi(null);
  }
  void renderPublicRoute();

  const initialTourParams = new URLSearchParams(window.location.search);
  if (initialTourParams.get('type') === 'tour') {
    activateTab('tours');
    void searchTours({ destination: initialTourParams.get('destination') || '', tourType: initialTourParams.get('tour_type') || '', maxPrice: initialTourParams.get('max_price') || '', sort: initialTourParams.get('sort') || 'newest' }, false);
  }
  updatePassengerSummary();
}
void initStorefront();
