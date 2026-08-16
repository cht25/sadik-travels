/* =====================================================================
   Sadik Travels — storefront pages module
   ---------------------------------------------------------------------
   Renders every dedicated sidebar route (marketplaces, product details,
   cart, wishlist, checkout, orders, invoices, account, tracking and
   support) from live API data using one shared page shell.

   The module is intentionally framework free so it drops straight into
   the existing single page application. app.js delegates unknown public
   routes to `window.SadikPages.resolve(...)`.
   ===================================================================== */
(() => {
  'use strict';

  const api = window.SadikApi;
  const $ = (selector, scope = document) => scope.querySelector(selector);
  const $$ = (selector, scope = document) => Array.from(scope.querySelectorAll(selector));

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const money = (value, currency = 'BDT') => `${currency === 'BDT' ? '৳' : `${currency} `}${Number(value || 0).toLocaleString('en-BD', { maximumFractionDigits: 0 })}`;
  const icon = (name) => `<svg aria-hidden="true"><use href="#${name}"></use></svg>`;
  const toast = (message, type) => (window.showToast ? window.showToast(message, type) : undefined);
  const titleCase = (value) => String(value || '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
  const dateLabel = (value) => { if (!value) return '—'; const date = new Date(value); return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }); };
  const dateTimeLabel = (value) => { if (!value) return '—'; const date = new Date(value); return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); };
  const todayPlus = (days) => { const date = new Date(); date.setDate(date.getDate() + days); return date.toISOString().slice(0, 10); };

  /* ------------------------------------------------------------ state */
  const state = {
    user: null,
    cart: { count: 0, items: [] },
    wishlist: new Set(),
    booted: false
  };

  const isLoggedIn = () => Boolean(state.user);
  const requireLogin = (message) => {
    toast(message || 'Please login to continue', 'error');
    if (typeof window.openLogin === 'function') window.openLogin();
    return false;
  };

  async function refreshBadges() {
    if (!isLoggedIn()) {
      state.cart = { count: 0, items: [] };
      state.wishlist = new Set();
      paintBadges();
      return;
    }
    try {
      const [cart, wishlist] = await Promise.all([
        api.get('/cart').catch(() => null),
        api.get('/wishlist').catch(() => null)
      ]);
      if (cart) state.cart = { count: (cart.cart?.items || []).reduce((sum, item) => sum + item.quantity, 0), items: cart.cart?.items || [] };
      if (wishlist) state.wishlist = new Set((wishlist.items || []).map((item) => item.productId));
    } catch { /* badges are non-critical */ }
    paintBadges();
  }

  function paintBadges() {
    const setCount = (element, value) => { if (!element) return; element.textContent = String(value); element.hidden = !value; };
    setCount($('#cartCount'), state.cart.count);
    setCount($('#sidebarCartCount'), state.cart.count);
    setCount($('#wishlistCount'), state.wishlist.size);
    setCount($('#sidebarWishlistCount'), state.wishlist.size);
  }

  /* --------------------------------------------------------- fragments */
  const breadcrumbs = (trail) => `<nav class="sf-breadcrumb" aria-label="Breadcrumb">${trail
    .map((item, index) => (index === trail.length - 1
      ? `<span aria-current="page">${esc(item.label)}</span>`
      : `<a href="${esc(item.href)}" data-public-route="${esc(item.href)}">${esc(item.label)}</a><span class="sf-breadcrumb-sep">›</span>`))
    .join('')}</nav>`;

  const pageHead = ({ eyebrow, title, description, actions = '' }) => `
    <header class="sf-page-head">
      <div class="sf-page-head-main">
        ${eyebrow ? `<span class="sf-eyebrow">${esc(eyebrow)}</span>` : ''}
        <h1>${esc(title)}</h1>
        ${description ? `<p>${esc(description)}</p>` : ''}
      </div>
      ${actions ? `<div class="sf-page-head-actions">${actions}</div>` : ''}
    </header>`;

  const skeletonGrid = (count = 6) => `<div class="sf-grid">${Array.from({ length: count }, () => `
    <div class="sf-card sf-skeleton"><div class="sf-card-media"></div><div class="sf-card-body"><span class="sk-line w60"></span><span class="sk-line w90"></span><span class="sk-line w40"></span></div></div>`).join('')}</div>`;

  const emptyState = (title, message, action = '') => `
    <div class="sf-state sf-empty">
      <div class="sf-state-icon">${icon('i-search')}</div>
      <strong>${esc(title)}</strong><p>${esc(message)}</p>${action}
    </div>`;

  const errorState = (message) => `
    <div class="sf-state sf-error">
      <div class="sf-state-icon">${icon('i-info')}</div>
      <strong>Something went wrong</strong><p>${esc(message || 'Please try again in a moment.')}</p>
      <button class="btn btn-primary" data-sf-retry type="button">Try again</button>
    </div>`;

  const loadingState = (label = 'Loading…') => `<div class="sf-state sf-loading"><span class="sf-spinner"></span><span>${esc(label)}</span></div>`;

  const ratingStars = (rating, count) => {
    if (!rating) return '<span class="sf-rating sf-rating-new">New</span>';
    return `<span class="sf-rating">${icon('i-star')}<strong>${Number(rating).toFixed(1)}</strong>${count ? `<small>(${count})</small>` : ''}</span>`;
  };

  const productImage = (product) => product.heroImage?.url || product.images?.[0]?.url || '';

  const productHref = (product) => `/${TYPE_ROUTE[product.type] || 'explore'}/${encodeURIComponent(product.slug || product.id)}`;

  const discountBadge = (product) => {
    if (!product.originalPrice || product.originalPrice <= product.price) return '';
    const percent = Math.round(((product.originalPrice - product.price) / product.originalPrice) * 100);
    return `<span class="sf-badge sf-badge-save">${percent}% off</span>`;
  };

  function productMeta(product) {
    const bits = [];
    if (product.destination || product.country) bits.push(`${icon('i-location')}${esc(product.destination || product.country)}`);
    if (product.durationDays) bits.push(`${icon('i-calendar')}${product.durationDays}D/${product.durationNights ?? Math.max(0, product.durationDays - 1)}N`);
    if (product.dataAmount) bits.push(`${icon('i-sim')}${esc(product.dataAmount)}`);
    if (product.validityDays) bits.push(`${icon('i-clock')}${product.validityDays} days`);
    if (product.processingTime) bits.push(`${icon('i-clock')}${esc(product.processingTime)}`);
    if (product.guests) bits.push(`${icon('i-user')}${product.guests} guests`);
    if (product.beds) bits.push(`${icon('i-bed')}${product.beds} beds`);
    if (product.airline) bits.push(`${icon('i-plane')}${esc(product.airline)}`);
    if (product.bank) bits.push(`${icon('i-card')}${esc(product.bank)}`);
    if (product.hospital) bits.push(`${icon('i-medical')}${esc(product.hospital)}`);
    return bits.slice(0, 3).map((bit) => `<span>${bit}</span>`).join('');
  }

  function productCard(product, options = {}) {
    const image = productImage(product);
    const href = productHref(product);
    const saved = state.wishlist.has(product.id);
    const priceBlock = product.price > 0
      ? `<div class="sf-price">${product.originalPrice && product.originalPrice > product.price ? `<s>${money(product.originalPrice, product.currency)}</s>` : ''}<strong>${money(product.price, product.currency)}</strong>${options.priceSuffix ? `<small>${esc(options.priceSuffix)}</small>` : ''}</div>`
      : `<div class="sf-price sf-price-quote"><strong>On request</strong></div>`;
    return `
      <article class="sf-card" data-product-id="${esc(product.id)}">
        <a class="sf-card-media" href="${esc(href)}" data-public-route="${esc(href)}">
          ${image ? `<img src="${esc(image)}" alt="${esc(product.title)}" loading="lazy" />` : `<span class="sf-card-media-fallback">${icon('i-images')}Sadik Travels</span>`}
          <span class="sf-card-badges">${product.featured ? '<span class="sf-badge sf-badge-featured">Featured</span>' : ''}${discountBadge(product)}</span>
        </a>
        <button class="sf-wish ${saved ? 'is-saved' : ''}" type="button" data-sf-wish="${esc(product.id)}" aria-label="${saved ? 'Remove from wishlist' : 'Save to wishlist'}">${icon(saved ? 'i-heart-fill' : 'i-heart')}</button>
        <div class="sf-card-body">
          <div class="sf-card-top">
            <span class="sf-card-type">${esc(titleCase(product.type))}</span>
            ${ratingStars(product.rating, product.reviewCount)}
          </div>
          <h3><a href="${esc(href)}" data-public-route="${esc(href)}">${esc(product.title)}</a></h3>
          ${product.summary || product.subtitle ? `<p>${esc(product.summary || product.subtitle)}</p>` : ''}
          <div class="sf-card-meta">${productMeta(product)}</div>
          <div class="sf-card-foot">
            ${priceBlock}
            <div class="sf-card-actions">
              ${product.bookable && product.price > 0 ? `<button class="btn btn-outline btn-sm" type="button" data-sf-cart="${esc(product.id)}">${icon('i-cart')}Add</button>` : ''}
              <a class="btn btn-primary btn-sm" href="${esc(href)}" data-public-route="${esc(href)}">${product.bookable && product.price > 0 ? 'Book now' : 'View details'}</a>
            </div>
          </div>
        </div>
      </article>`;
  }

  const pagination = (result) => {
    if (!result || result.pageCount <= 1) return '';
    const pages = [];
    const total = result.pageCount;
    const current = result.page;
    for (let page = 1; page <= total; page += 1) {
      if (page === 1 || page === total || Math.abs(page - current) <= 1) pages.push(page);
      else if (pages[pages.length - 1] !== '…') pages.push('…');
    }
    return `<nav class="sf-pagination" aria-label="Pagination">
      <button class="sf-page-btn" type="button" data-sf-page="${current - 1}" ${current <= 1 ? 'disabled' : ''}>${icon('i-arrow-left')}</button>
      ${pages.map((page) => (page === '…'
        ? '<span class="sf-page-gap">…</span>'
        : `<button class="sf-page-btn ${page === current ? 'is-active' : ''}" type="button" data-sf-page="${page}">${page}</button>`)).join('')}
      <button class="sf-page-btn" type="button" data-sf-page="${current + 1}" ${current >= total ? 'disabled' : ''}>${icon('i-arrow-right')}</button>
    </nav>`;
  };

  /* ------------------------------------------------- catalogue definitions */
  const TYPE_ROUTE = {
    esim: 'esim', umrah_package: 'umrah-packages', umrah_fare: 'special-umrah-fare', holiday_package: 'holiday-packages',
    medical_tourism: 'medical-tourism', visa_service: 'visa', home: 'homes', card_offer: 'card-offers',
    airline_offer: 'airlines-offers', destination: 'explore', flight_offer: 'flights', accessory: 'shop'
  };

  const COLLECTIONS = {
    esim: {
      type: 'esim', route: 'esim', eyebrow: 'Connectivity', title: 'eSIM Marketplace',
      description: 'Stay connected the moment you land. Instant digital SIM plans with country and regional coverage.',
      filters: ['q', 'country', 'price', 'sort'], emptyTitle: 'No eSIM plans published yet'
    },
    'umrah-packages': {
      type: 'umrah_package', route: 'umrah-packages', eyebrow: 'Pilgrimage', title: 'Umrah Packages',
      description: 'Complete Umrah packages with visa, hotels near Haram, transport and guided ziyarat.',
      filters: ['q', 'price', 'sort'], emptyTitle: 'No Umrah packages published yet'
    },
    'special-umrah-fare': {
      type: 'umrah_fare', route: 'special-umrah-fare', eyebrow: 'Limited fares', title: 'Special Umrah Fare',
      description: 'Negotiated airline fares for Umrah pilgrims, updated by the Sadik Travels fares desk.',
      filters: ['q', 'price', 'sort'], emptyTitle: 'No special fares published yet'
    },
    'holiday-packages': {
      type: 'holiday_package', route: 'holiday-packages', eyebrow: 'Holidays', title: 'Holiday Packages',
      description: 'Curated holidays with flights, stays, transfers and experiences bundled into one price.',
      filters: ['q', 'country', 'price', 'sort'], emptyTitle: 'No holiday packages published yet'
    },
    'medical-tourism': {
      type: 'medical_tourism', route: 'medical-tourism', eyebrow: 'Health travel', title: 'Medical Tourism',
      description: 'Treatment abroad with hospital coordination, appointments, visa support and travel logistics.',
      filters: ['q', 'country', 'sort'], emptyTitle: 'No medical tourism programmes published yet'
    },
    'card-offers': {
      type: 'card_offer', route: 'card-offers', eyebrow: 'Bank offers', title: 'Card Offers',
      description: 'Discounts and instalment plans with partner bank cards on Sadik Travels bookings.',
      filters: ['q', 'sort'], emptyTitle: 'No card offers published yet'
    },
    'airlines-offers': {
      type: 'airline_offer', route: 'airlines-offers', eyebrow: 'Airline deals', title: 'Airlines Offers',
      description: 'Promotional fares, route launches and airline campaigns available through Sadik Travels.',
      filters: ['q', 'sort'], emptyTitle: 'No airline offers published yet'
    },
    explore: {
      type: 'destination', route: 'explore', eyebrow: 'Inspiration', title: 'Explore Destinations',
      description: 'Discover destinations across Bangladesh and the world with things to do, seasons and costs.',
      filters: ['q', 'country', 'sort'], emptyTitle: 'No destinations published yet'
    },
    homes: {
      type: 'home', route: 'homes', eyebrow: 'Stays', title: 'Homes, Apartments & Villas',
      description: 'Entire homes, serviced apartments, villas, resorts and guest houses for longer, calmer stays.',
      filters: ['q', 'country', 'price', 'sort'], emptyTitle: 'No homes published yet'
    },
    visa: {
      type: 'visa_service', route: 'visa', eyebrow: 'Documentation', title: 'Visa Services',
      description: 'Visa processing with document checklists, transparent government and service fees, and live tracking.',
      filters: ['q', 'country', 'sort'], emptyTitle: 'No visa services published yet'
    }
  };

  /* ------------------------------------------------------- generic list page */
  async function renderCollection(root, definition, query) {
    const params = new URLSearchParams();
    params.set('type', definition.type);
    params.set('pageSize', '12');
    ['q', 'country', 'minPrice', 'maxPrice', 'sort', 'page'].forEach((key) => { if (query.get(key)) params.set(key, query.get(key)); });

    root.innerHTML = `<div class="sf-page">
      ${breadcrumbs([{ label: 'Home', href: '/' }, { label: definition.title }])}
      ${pageHead({ eyebrow: definition.eyebrow, title: definition.title, description: definition.description })}
      <div class="sf-layout">
        <aside class="sf-filters" id="sfFilters">${loadingState('Loading filters…')}</aside>
        <div class="sf-results" id="sfResults">${skeletonGrid(6)}</div>
      </div>
    </div>`;

    const resultsBox = $('#sfResults', root);
    const filtersBox = $('#sfFilters', root);

    let facets = { minPrice: 0, maxPrice: 0, countries: [], destinations: [], tags: [] };
    try { facets = (await api.get(`/catalog/facets/${definition.type}`)).facets || facets; } catch { /* filters degrade gracefully */ }

    filtersBox.innerHTML = filtersMarkup(definition, facets, query);

    try {
      const result = await api.get(`/catalog?${params.toString()}`);
      if (!result.products.length) {
        resultsBox.innerHTML = emptyState(
          definition.emptyTitle,
          query.toString() ? 'No products match these filters yet. Try widening your search.' : 'Our team is publishing this catalogue. Please check back shortly.',
          query.toString() ? `<button class="btn btn-outline" type="button" data-sf-clear-filters>Clear filters</button>` : `<a class="btn btn-primary" href="/" data-public-route="/">Back to home</a>`
        );
        return;
      }
      resultsBox.innerHTML = `
        <div class="sf-results-head">
          <span class="sf-results-count"><strong>${result.total}</strong> ${result.total === 1 ? 'result' : 'results'}</span>
          <label class="sf-sort"><span>Sort</span>
            <select data-sf-sort>
              ${[['recommended', 'Recommended'], ['price_asc', 'Price: low to high'], ['price_desc', 'Price: high to low'], ['rating', 'Rating'], ['newest', 'Newest']]
                .map(([value, label]) => `<option value="${value}" ${query.get('sort') === value ? 'selected' : ''}>${label}</option>`).join('')}
            </select>
          </label>
        </div>
        <div class="sf-grid">${result.products.map((product) => productCard(product)).join('')}</div>
        ${pagination(result)}`;
    } catch (error) {
      resultsBox.innerHTML = errorState(error.message);
    }
  }

  function filtersMarkup(definition, facets, query) {
    const has = (key) => definition.filters.includes(key);
    return `<form class="sf-filter-card" data-sf-filter-form>
      <div class="sf-filter-head"><strong>${icon('i-sliders')} Filters</strong><button class="sf-link" type="button" data-sf-clear-filters>Reset</button></div>
      ${has('q') ? `<label class="sf-field"><span>Search</span><input type="search" name="q" value="${esc(query.get('q') || '')}" placeholder="Search ${esc(definition.title.toLowerCase())}" /></label>` : ''}
      ${has('country') && facets.countries.length ? `<label class="sf-field"><span>Country</span><select name="country"><option value="">All countries</option>${facets.countries.map((country) => `<option value="${esc(country)}" ${query.get('country') === country ? 'selected' : ''}>${esc(country)}</option>`).join('')}</select></label>` : ''}
      ${has('price') && facets.maxPrice > 0 ? `
        <div class="sf-field">
          <span>Price range (৳)</span>
          <div class="sf-range-inputs">
            <input type="number" name="minPrice" min="0" placeholder="${Math.floor(facets.minPrice)}" value="${esc(query.get('minPrice') || '')}" />
            <input type="number" name="maxPrice" min="0" placeholder="${Math.ceil(facets.maxPrice)}" value="${esc(query.get('maxPrice') || '')}" />
          </div>
        </div>` : ''}
      <button class="btn btn-primary full-btn" type="submit">Apply filters</button>
    </form>`;
  }

  /* ------------------------------------------------------- product detail */
  async function renderProductDetail(root, definition, idOrSlug) {
    root.innerHTML = `<div class="sf-page">${loadingState('Loading product…')}</div>`;
    let data;
    try { data = await api.get(`/catalog/${encodeURIComponent(idOrSlug)}`); }
    catch (error) { root.innerHTML = `<div class="sf-page">${errorState(error.status === 404 ? 'This product is no longer available.' : error.message)}</div>`; return; }

    const product = data.product;
    const gallery = [product.heroImage, ...(product.images || [])].filter((image) => image && image.url);
    const saved = state.wishlist.has(product.id);
    const canBook = product.bookable && product.price > 0;
    const isVisa = product.type === 'visa_service';

    root.innerHTML = `<div class="sf-page">
      ${breadcrumbs([{ label: 'Home', href: '/' }, { label: definition.title, href: `/${definition.route}` }, { label: product.title }])}
      <div class="sf-detail">
        <div class="sf-detail-main">
          <div class="sf-gallery">
            <div class="sf-gallery-main">${gallery.length
              ? `<img id="sfGalleryImage" src="${esc(gallery[0].url)}" alt="${esc(product.title)}" />`
              : `<div class="sf-gallery-fallback">${icon('i-images')}<span>No image published</span></div>`}</div>
            ${gallery.length > 1 ? `<div class="sf-gallery-thumbs">${gallery.map((image, index) => `<button type="button" class="${index === 0 ? 'is-active' : ''}" data-sf-gallery="${esc(image.url)}"><img src="${esc(image.url)}" alt="${esc(image.alt || product.title)}" loading="lazy" /></button>`).join('')}</div>` : ''}
          </div>

          <section class="sf-panel">
            <div class="sf-detail-head">
              <div>
                <span class="sf-eyebrow">${esc(titleCase(product.type))}</span>
                <h1>${esc(product.title)}</h1>
                ${product.subtitle ? `<p class="sf-detail-sub">${esc(product.subtitle)}</p>` : ''}
              </div>
              <div class="sf-detail-head-side">${ratingStars(product.rating, product.reviewCount)}</div>
            </div>
            <div class="sf-fact-grid">${factRows(product).map(([label, value]) => `<div class="sf-fact"><small>${esc(label)}</small><strong>${esc(value)}</strong></div>`).join('')}</div>
            ${product.description ? `<div class="sf-prose"><h2>Overview</h2><p>${esc(product.description).replace(/\n/g, '<br />')}</p></div>` : ''}
          </section>

          ${product.itinerary?.length ? `<section class="sf-panel"><h2>Itinerary</h2><ol class="sf-itinerary">${product.itinerary.map((day) => `<li><span class="sf-itinerary-day">Day ${day.day}</span><div><strong>${esc(day.title)}</strong>${day.detail ? `<p>${esc(day.detail)}</p>` : ''}</div></li>`).join('')}</ol></section>` : ''}

          ${(product.inclusions?.length || product.exclusions?.length) ? `<section class="sf-panel sf-two-col">
            ${product.inclusions?.length ? `<div><h2>What's included</h2><ul class="sf-list sf-list-yes">${product.inclusions.map((item) => `<li>${icon('i-check')}${esc(item)}</li>`).join('')}</ul></div>` : ''}
            ${product.exclusions?.length ? `<div><h2>Not included</h2><ul class="sf-list sf-list-no">${product.exclusions.map((item) => `<li>${icon('i-close')}${esc(item)}</li>`).join('')}</ul></div>` : ''}
          </section>` : ''}

          ${product.requiredDocuments?.length ? `<section class="sf-panel"><h2>Required documents</h2><ul class="sf-list sf-list-doc">${product.requiredDocuments.map((item) => `<li>${icon('i-file')}${esc(item)}</li>`).join('')}</ul></section>` : ''}
          ${product.amenities?.length ? `<section class="sf-panel"><h2>Amenities</h2><div class="sf-chips">${product.amenities.map((item) => `<span class="sf-chip">${esc(item)}</span>`).join('')}</div></section>` : ''}
          ${product.coverage?.length ? `<section class="sf-panel"><h2>Coverage</h2><div class="sf-chips">${product.coverage.map((item) => `<span class="sf-chip">${esc(item)}</span>`).join('')}</div></section>` : ''}
          ${product.terms ? `<section class="sf-panel"><h2>Terms &amp; conditions</h2><div class="sf-prose sf-prose-sm"><p>${esc(product.terms).replace(/\n/g, '<br />')}</p></div></section>` : ''}

          <section class="sf-panel" id="sfReviews">
            <h2>Customer reviews</h2>
            ${data.reviews?.length
              ? `<div class="sf-reviews">${data.reviews.map((review) => `<article class="sf-review"><div class="sf-review-head"><strong>${esc(review.userName || 'Customer')}</strong><span class="sf-stars">${'★'.repeat(review.rating)}${'☆'.repeat(5 - review.rating)}</span></div>${review.title ? `<h4>${esc(review.title)}</h4>` : ''}<p>${esc(review.body)}</p><small>${dateLabel(review.createdAt)}</small>${review.adminReply ? `<div class="sf-review-reply"><strong>Sadik Travels</strong><p>${esc(review.adminReply)}</p></div>` : ''}</article>`).join('')}</div>`
              : emptyState('No reviews yet', 'Reviews appear here once travellers complete this booking.')}
            ${isLoggedIn() ? `
              <form class="sf-review-form" id="sfReviewForm" data-product-id="${esc(product.id)}" data-product-type="${esc(product.type)}" data-product-title="${esc(product.title)}">
                <h3>Write a review</h3>
                <div class="sf-form-grid">
                  <label class="sf-field"><span>Rating</span><select name="rating">${[5, 4, 3, 2, 1].map((value) => `<option value="${value}">${'★'.repeat(value)} ${value}</option>`).join('')}</select></label>
                  <label class="sf-field"><span>Title</span><input name="title" maxlength="160" placeholder="Summarise your experience" /></label>
                  <label class="sf-field sf-field-wide"><span>Your review *</span><textarea name="body" rows="3" required placeholder="What did you like? What could be better?"></textarea></label>
                </div>
                <button class="btn btn-primary" type="submit">Submit review</button>
                <p class="sf-hint">Reviews can be posted after a confirmed booking and are published once moderated.</p>
              </form>` : `<p class="sf-hint">${'Login after your trip to review this product.'}</p>`}
          </section>
        </div>

        <aside class="sf-detail-side">
          <div class="sf-booking-card">
            <div class="sf-booking-price">
              ${product.originalPrice && product.originalPrice > product.price ? `<s>${money(product.originalPrice, product.currency)}</s>` : ''}
              <strong>${product.price > 0 ? money(product.price, product.currency) : 'On request'}</strong>
              ${product.price > 0 ? '<small>per person / unit</small>' : '<small>Our team will quote you</small>'}
            </div>
            ${product.serviceCharge ? `<div class="sf-booking-row"><span>Service charge</span><span>${money(product.serviceCharge, product.currency)}</span></div>` : ''}
            ${product.taxPct ? `<div class="sf-booking-row"><span>Tax / VAT</span><span>${product.taxPct}%</span></div>` : ''}
            <div class="sf-booking-row"><span>Availability</span><span class="${product.availability > 0 ? 'sf-ok' : 'sf-warn'}">${product.availability > 0 ? `${product.availability} available` : 'Sold out'}</span></div>
            ${isVisa
              ? `<a class="btn btn-primary full-btn" href="/visa/${esc(product.slug)}/apply" data-public-route="/visa/${esc(product.slug)}/apply">${icon('i-passport')} Apply now</a>`
              : canBook
                ? `<button class="btn btn-primary full-btn" type="button" data-sf-book="${esc(product.id)}">${icon('i-check')} Book now</button>
                   <button class="btn btn-outline full-btn" type="button" data-sf-cart="${esc(product.id)}">${icon('i-cart')} Add to cart</button>`
                : `<a class="btn btn-primary full-btn" href="/support" data-public-route="/support">${icon('i-headset')} Request a quote</a>`}
            <div class="sf-booking-secondary">
              <button class="btn btn-ghost" type="button" data-sf-wish="${esc(product.id)}">${icon(saved ? 'i-heart-fill' : 'i-heart')} ${saved ? 'Saved' : 'Wishlist'}</button>
              <button class="btn btn-ghost" type="button" data-sf-share>${icon('i-share')} Share</button>
            </div>
          </div>
          <div class="sf-support-card">
            <strong>${icon('i-headset')} Need help?</strong>
            <p>Our travel specialists answer within minutes during business hours.</p>
            <a class="btn btn-outline full-btn" href="/support" data-public-route="/support">Contact support</a>
          </div>
        </aside>
      </div>

      ${data.related?.length ? `<section class="sf-related"><h2>You may also like</h2><div class="sf-grid">${data.related.map((item) => productCard(item)).join('')}</div></section>` : ''}
    </div>`;
  }

  function factRows(product) {
    const rows = [];
    const push = (label, value) => { if (value !== undefined && value !== null && value !== '') rows.push([label, String(value)]); };
    push('Destination', product.destination || product.city);
    push('Country', product.country);
    push('Duration', product.durationDays ? `${product.durationDays} days / ${product.durationNights ?? Math.max(0, product.durationDays - 1)} nights` : '');
    push('Data', product.dataAmount);
    push('Validity', product.validityDays ? `${product.validityDays} days` : product.validity);
    push('Network', product.network);
    push('Activation', product.activation);
    push('Visa type', product.visaType);
    push('Processing time', product.processingTime);
    push('Entry type', product.entryType);
    push('Hospital', product.hospital);
    push('Treatment', product.treatmentCategory);
    push('Specialist', product.doctor);
    push('Estimated cost', product.estimatedCost);
    push('Property type', product.propertyType);
    push('Guests', product.guests);
    push('Bedrooms', product.bedrooms);
    push('Bathrooms', product.bathrooms);
    push('Bank', product.bank);
    push('Card', product.cardName);
    push('Airline', product.airline);
    push('Route', product.route);
    push('Promo code', product.promoCode);
    push('Valid from', product.startDate ? dateLabel(product.startDate) : '');
    push('Valid until', product.endDate ? dateLabel(product.endDate) : '');
    return rows.slice(0, 8);
  }

  /* ------------------------------------------------------------- flights */
  async function renderFlights(root, query) {
    const trip = query.get('trip') || 'oneway';
    root.innerHTML = `<div class="sf-page">
      ${breadcrumbs([{ label: 'Home', href: '/' }, { label: 'Flights' }])}
      ${pageHead({ eyebrow: 'Air travel', title: 'Flight Booking', description: 'Search one way, round trip and multi city itineraries across every airline Sadik Travels works with.' })}
      <section class="sf-panel sf-search-panel">
        <div class="sf-trip-tabs" role="tablist">
          ${[['oneway', 'One Way'], ['round', 'Round Trip'], ['multi', 'Multi City']].map(([value, label]) => `<button type="button" role="tab" class="sf-trip-tab ${trip === value ? 'is-active' : ''}" data-sf-trip="${value}">${label}</button>`).join('')}
        </div>
        <form class="sf-flight-form" id="sfFlightForm" data-trip="${esc(trip)}">
          <div class="sf-flight-legs" id="sfFlightLegs">${flightLeg(0, query)}</div>
          ${trip === 'multi' ? '<button class="sf-link" type="button" data-sf-add-leg>+ Add another city</button>' : ''}
          <div class="sf-flight-grid">
            <label class="sf-field"><span>Passengers</span>
              <div class="sf-pax">
                <select name="adults">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<option value="${n}">${n} adult${n > 1 ? 's' : ''}</option>`).join('')}</select>
                <select name="children">${[0, 1, 2, 3, 4, 5, 6].map((n) => `<option value="${n}">${n} child${n === 1 ? '' : 'ren'}</option>`).join('')}</select>
                <select name="infants">${[0, 1, 2, 3, 4].map((n) => `<option value="${n}">${n} infant${n === 1 ? '' : 's'}</option>`).join('')}</select>
              </div>
            </label>
            <label class="sf-field"><span>Cabin class</span>
              <select name="cabin">
                <option value="economy">Economy</option><option value="premium_economy">Premium Economy</option>
                <option value="business">Business</option><option value="first">First Class</option>
              </select>
            </label>
            <button class="btn btn-primary sf-search-btn" type="submit">${icon('i-search')} Search flights</button>
          </div>
        </form>
      </section>
      <div id="sfFlightResults"></div>
      <section class="sf-related" id="sfAirlineOffers"></section>
    </div>`;

    // Airline offers are real catalogue records and always render, search or not.
    try {
      const offers = await api.get('/catalog?type=airline_offer&pageSize=3');
      if (offers.products.length) {
        $('#sfAirlineOffers', root).innerHTML = `<h2>Airline offers you can use today</h2><div class="sf-grid">${offers.products.map((product) => productCard(product)).join('')}</div>`;
      }
    } catch { /* offers are supplementary */ }

    if (query.get('from') && query.get('to')) await runFlightSearch(root, query);
  }

  const flightLeg = (index, query) => `
    <div class="sf-flight-leg" data-leg="${index}">
      <label class="sf-field"><span>From</span><input name="from" required placeholder="Dhaka (DAC)" value="${esc(query?.get('from') || '')}" autocomplete="off" /></label>
      <button class="sf-swap" type="button" data-sf-swap aria-label="Swap airports">${icon('i-arrow-right')}</button>
      <label class="sf-field"><span>To</span><input name="to" required placeholder="Dubai (DXB)" value="${esc(query?.get('to') || '')}" autocomplete="off" /></label>
      <label class="sf-field"><span>Departure</span><input type="date" name="departure" required min="${todayPlus(0)}" value="${esc(query?.get('departure') || todayPlus(7))}" /></label>
      <label class="sf-field sf-return-field"><span>Return</span><input type="date" name="return" min="${todayPlus(0)}" value="${esc(query?.get('return') || '')}" /></label>
    </div>`;

  async function runFlightSearch(root, query) {
    const box = $('#sfFlightResults', root);
    if (!box) return;
    box.innerHTML = `<section class="sf-panel">${loadingState('Searching live airline availability…')}</section>`;
    try {
      const payload = {
        from: query.get('from'), to: query.get('to'), departure: query.get('departure'),
        returnDate: query.get('return') || undefined, adults: Number(query.get('adults') || 1),
        children: Number(query.get('children') || 0), infants: Number(query.get('infants') || 0),
        cabin: query.get('cabin') || 'economy', tripType: query.get('trip') || 'oneway'
      };
      const result = await api.post('/search/flight', payload);
      const offers = result.results || result.offers || result.flights || [];
      if (!offers.length) {
        box.innerHTML = `<section class="sf-panel">${emptyState('No flights found', 'No airline returned availability for this itinerary. Try nearby dates or another airport.')}</section>`;
        return;
      }
      box.innerHTML = `<section class="sf-panel"><div class="sf-results-head"><span class="sf-results-count"><strong>${offers.length}</strong> flights</span></div>
        <div class="sf-flight-list">${offers.map(flightRow).join('')}</div></section>`;
    } catch (error) {
      box.innerHTML = `<section class="sf-panel">${providerState('Flight search', error)}</section>`;
    }
  }

  const flightRow = (offer) => `
    <article class="sf-flight-row">
      <div class="sf-flight-airline">${offer.airlineLogo ? `<img src="${esc(offer.airlineLogo)}" alt="${esc(offer.airline || '')}" />` : icon('i-plane')}<div><strong>${esc(offer.airline || 'Airline')}</strong><small>${esc(offer.flightNumber || '')}</small></div></div>
      <div class="sf-flight-times">
        <div><strong>${esc(offer.departureTime || '—')}</strong><small>${esc(offer.origin || '')}</small></div>
        <div class="sf-flight-duration"><span>${esc(offer.duration || '')}</span><i></i><small>${offer.stops ? `${offer.stops} stop${offer.stops > 1 ? 's' : ''}` : 'Non-stop'}</small></div>
        <div><strong>${esc(offer.arrivalTime || '—')}</strong><small>${esc(offer.destination || '')}</small></div>
      </div>
      <div class="sf-flight-extra">
        ${offer.baggage ? `<span>${icon('i-tag')}${esc(offer.baggage)}</span>` : ''}
        ${offer.refundable !== undefined ? `<span class="${offer.refundable ? 'sf-ok' : 'sf-warn'}">${offer.refundable ? 'Refundable' : 'Non-refundable'}</span>` : ''}
      </div>
      <div class="sf-flight-price"><strong>${money(offer.price || offer.fare || 0, offer.currency)}</strong><button class="btn btn-primary btn-sm" type="button" data-sf-flight-select='${esc(JSON.stringify({ id: offer.id, airline: offer.airline, price: offer.price || offer.fare }))}'>Select</button></div>
    </article>`;

  const providerState = (label, error) => `
    <div class="sf-state sf-provider">
      <div class="sf-state-icon">${icon('i-info')}</div>
      <strong>${esc(label)} is not connected yet</strong>
      <p>${esc(error?.message || 'The live supplier is not configured.')} Sadik Travels never shows invented availability — real results appear as soon as an administrator connects the supplier in Admin → Settings → Travel provider.</p>
      <div class="sf-state-actions">
        <a class="btn btn-primary" href="/support" data-public-route="/support">Ask our team to book manually</a>
        <button class="btn btn-outline" type="button" data-sf-retry>Try again</button>
      </div>
    </div>`;

  /* ---------------------------------------------------------------- app */
  async function renderAppPage(root) {
    root.innerHTML = `<div class="sf-page">${loadingState('Loading…')}</div>`;
    let content = null;
    try { const response = await api.get('/site/content?type=app'); content = (response.content || [])[0] || null; } catch { /* fall back to defaults */ }
    const meta = content?.metadata || {};
    const features = Array.isArray(meta.features) && meta.features.length ? meta.features : [
      { title: 'Book in seconds', detail: 'Flights, hotels, homes, tours and eSIM in a single checkout.' },
      { title: 'Live booking status', detail: 'Push notifications from booking created to trip completed.' },
      { title: 'Digital documents', detail: 'Invoices, e-tickets and visa papers stored in your account.' },
      { title: '24/7 support', detail: 'Chat with the Sadik Travels support desk from inside the app.' }
    ];
    root.innerHTML = `<div class="sf-page">
      ${breadcrumbs([{ label: 'Home', href: '/' }, { label: 'Sadik App' }])}
      <section class="sf-app-hero">
        <div>
          <span class="sf-eyebrow">Mobile</span>
          <h1>${esc(content?.title || 'The Sadik Travels app')}</h1>
          <p>${esc(content?.subtitle || content?.description || 'Plan, book and manage every trip from your pocket. Available for Android and iOS.')}</p>
          <div class="sf-app-badges">
            <a class="sf-store" href="${esc(meta.androidUrl || '#')}" ${meta.androidUrl ? 'target="_blank" rel="noopener"' : 'aria-disabled="true"'}><img src="/assets/images__amy-android.png" alt="Get it on Google Play" /></a>
            <a class="sf-store" href="${esc(meta.iosUrl || '#')}" ${meta.iosUrl ? 'target="_blank" rel="noopener"' : 'aria-disabled="true"'}><img src="/assets/images__amy-ios.png" alt="Download on the App Store" /></a>
          </div>
          <div class="sf-app-qr">
            <img src="/assets/images__qr-google.svg" alt="Android QR code" />
            <img src="/assets/images__qr-apple.svg" alt="iOS QR code" />
            <span>Scan to install on your phone</span>
          </div>
        </div>
        <div class="sf-app-shot">${content?.imageUrl ? `<img src="${esc(content.imageUrl)}" alt="Sadik Travels app" />` : `<div class="sf-gallery-fallback">${icon('i-phone')}<span>App preview</span></div>`}</div>
      </section>
      <section class="sf-panel"><h2>Why travellers use the app</h2>
        <div class="sf-feature-grid">${features.map((feature) => `<div class="sf-feature">${icon('i-check')}<div><strong>${esc(feature.title || feature)}</strong>${feature.detail ? `<p>${esc(feature.detail)}</p>` : ''}</div></div>`).join('')}</div>
      </section>
      <section class="sf-panel sf-cta-panel">
        <div><h2>Need help installing?</h2><p>Our support desk walks you through installation, login and your first booking.</p></div>
        <a class="btn btn-primary" href="/support" data-public-route="/support">${icon('i-headset')} Contact support</a>
      </section>
    </div>`;
  }

  /* ------------------------------------------------------------ wishlist */
  async function renderWishlist(root) {
    if (!isLoggedIn()) return renderLoginRequired(root, 'Wishlist', 'Login to see the stays, tours and packages you saved.');
    root.innerHTML = `<div class="sf-page">${breadcrumbs([{ label: 'Home', href: '/' }, { label: 'Wishlist' }])}${pageHead({ eyebrow: 'Saved', title: 'My Wishlist', description: 'Everything you saved for later, synced to your Sadik Travels account.' })}${skeletonGrid(3)}</div>`;
    try {
      const { items } = await api.get('/wishlist');
      const body = items.length
        ? `<div class="sf-grid">${items.map((item) => `
            <article class="sf-card">
              <a class="sf-card-media" href="/${TYPE_ROUTE[item.productType] || 'explore'}/${esc(item.slug || item.productId)}" data-public-route="/${TYPE_ROUTE[item.productType] || 'explore'}/${esc(item.slug || item.productId)}">
                ${item.imageUrl ? `<img src="${esc(item.imageUrl)}" alt="${esc(item.title)}" loading="lazy" />` : `<span class="sf-card-media-fallback">${icon('i-images')}Sadik Travels</span>`}
              </a>
              <div class="sf-card-body">
                <span class="sf-card-type">${esc(titleCase(item.productType))}</span>
                <h3>${esc(item.title)}</h3>
                <div class="sf-card-foot">
                  <div class="sf-price"><strong>${item.price ? money(item.price) : 'On request'}</strong></div>
                  <div class="sf-card-actions">
                    <button class="btn btn-ghost btn-sm" type="button" data-sf-wish-remove="${esc(item.id)}">${icon('i-trash')}</button>
                    <button class="btn btn-primary btn-sm" type="button" data-sf-cart="${esc(item.productId)}">Add to cart</button>
                  </div>
                </div>
              </div>
            </article>`).join('')}</div>`
        : emptyState('Your wishlist is empty', 'Tap the heart on any package, stay or destination to save it here.', '<a class="btn btn-primary" href="/explore" data-public-route="/explore">Explore destinations</a>');
      root.innerHTML = `<div class="sf-page">${breadcrumbs([{ label: 'Home', href: '/' }, { label: 'Wishlist' }])}${pageHead({ eyebrow: 'Saved', title: 'My Wishlist', description: `${items.length} saved item${items.length === 1 ? '' : 's'}.` })}${body}</div>`;
    } catch (error) {
      root.innerHTML = `<div class="sf-page">${errorState(error.message)}</div>`;
    }
  }

  /* ---------------------------------------------------------------- cart */
  async function renderCart(root) {
    if (!isLoggedIn()) return renderLoginRequired(root, 'Cart', 'Login to see the items in your cart.');
    root.innerHTML = `<div class="sf-page">${breadcrumbs([{ label: 'Home', href: '/' }, { label: 'Cart' }])}${pageHead({ eyebrow: 'Shop', title: 'My Cart', description: 'Review your items, apply a coupon and continue to secure checkout.' })}<div id="sfCartBody">${loadingState('Loading your cart…')}</div></div>`;
    await paintCart(root);
  }

  async function paintCart(root) {
    const box = $('#sfCartBody', root);
    if (!box) return;
    try {
      const data = await api.get('/cart');
      state.cart = { count: data.cart.items.reduce((sum, item) => sum + item.quantity, 0), items: data.cart.items };
      paintBadges();
      if (!data.cart.items.length) {
        box.innerHTML = emptyState('Your cart is empty', 'Add a tour, package, eSIM or stay to get started.', '<a class="btn btn-primary" href="/holiday-packages" data-public-route="/holiday-packages">Browse packages</a>');
        return;
      }
      box.innerHTML = `<div class="sf-cart-layout">
        <div class="sf-cart-items">
          ${data.cart.items.map((item) => `
            <article class="sf-cart-item">
              <div class="sf-cart-media">${item.imageUrl ? `<img src="${esc(item.imageUrl)}" alt="${esc(item.title)}" />` : icon('i-images')}</div>
              <div class="sf-cart-info">
                <span class="sf-card-type">${esc(titleCase(item.productType))}</span>
                <h3>${esc(item.title)}</h3>
                <small>${money(item.unitPrice)} each${item.taxPct ? ` · ${item.taxPct}% tax` : ''}${item.serviceCharge ? ` · ${money(item.serviceCharge)} service` : ''}</small>
              </div>
              <div class="sf-qty">
                <button type="button" data-sf-qty="${esc(item.id)}" data-value="${item.quantity - 1}" aria-label="Decrease">−</button>
                <output>${item.quantity}</output>
                <button type="button" data-sf-qty="${esc(item.id)}" data-value="${item.quantity + 1}" aria-label="Increase">+</button>
              </div>
              <div class="sf-cart-line"><strong>${money(item.lineTotal)}</strong><button class="sf-link sf-link-danger" type="button" data-sf-cart-remove="${esc(item.id)}">Remove</button></div>
            </article>`).join('')}
        </div>
        <aside class="sf-summary">
          <h2>Order summary</h2>
          ${summaryRows(data.pricing)}
          <form class="sf-coupon" data-sf-coupon-form>
            <input name="code" placeholder="Coupon code" value="${esc(data.cart.couponCode || '')}" />
            <button class="btn btn-outline" type="submit">Apply</button>
          </form>
          ${data.pricing.couponMessage ? `<p class="sf-coupon-msg ${data.pricing.couponDiscount ? 'is-ok' : 'is-warn'}">${esc(data.pricing.couponMessage)}</p>` : ''}
          <a class="btn btn-primary full-btn" href="/checkout" data-public-route="/checkout">Proceed to checkout</a>
          <p class="sf-secure">${icon('i-shield')} Prices, discounts and taxes are calculated on our servers.</p>
        </aside>
      </div>`;
    } catch (error) {
      box.innerHTML = errorState(error.message);
    }
  }

  const summaryRows = (pricing) => `
    <div class="sf-summary-rows">
      <div><span>Subtotal</span><span>${money(pricing.subtotal)}</span></div>
      ${pricing.couponDiscount ? `<div class="sf-summary-discount"><span>Coupon ${esc(pricing.couponCode || '')}</span><span>−${money(pricing.couponDiscount)}</span></div>` : ''}
      ${pricing.tax ? `<div><span>Tax &amp; VAT</span><span>${money(pricing.tax)}</span></div>` : ''}
      ${pricing.serviceFee ? `<div><span>Service fee</span><span>${money(pricing.serviceFee)}</span></div>` : ''}
      <div class="sf-summary-total"><span>Total</span><span>${money(pricing.total)}</span></div>
    </div>`;

  /* ------------------------------------------------------------ checkout */
  async function renderCheckout(root, query) {
    if (!isLoggedIn()) return renderLoginRequired(root, 'Checkout', 'Login to complete your booking securely.');
    root.innerHTML = `<div class="sf-page">${breadcrumbs([{ label: 'Home', href: '/' }, { label: 'Cart', href: '/cart' }, { label: 'Checkout' }])}${pageHead({ eyebrow: 'Secure checkout', title: 'Checkout', description: 'Confirm your details and complete payment. Your account details are filled in automatically.' })}<div id="sfCheckoutBody">${loadingState('Preparing your checkout…')}</div></div>`;
    const box = $('#sfCheckoutBody', root);
    const directId = query.get('product');
    const directQty = Number(query.get('qty') || 1);

    try {
      const [prefill, cartData, directProduct] = await Promise.all([
        api.get('/checkout/prefill'),
        directId ? Promise.resolve(null) : api.get('/cart'),
        directId ? api.get(`/catalog/${encodeURIComponent(directId)}`) : Promise.resolve(null)
      ]);

      let pricing;
      let items;
      if (directProduct) {
        const product = directProduct.product;
        items = [{ title: product.title, quantity: directQty, unitPrice: product.price, imageUrl: productImage(product), productType: product.type, lineTotal: product.price * directQty }];
        pricing = {
          subtotal: product.price * directQty, couponDiscount: 0,
          tax: Math.round((product.price * directQty * (product.taxPct || 0)) / 100),
          serviceFee: (product.serviceCharge || 0) * directQty, total: 0
        };
        pricing.total = pricing.subtotal + pricing.tax + pricing.serviceFee;
      } else {
        if (!cartData.cart.items.length) { box.innerHTML = emptyState('Your cart is empty', 'Add something to your cart before checking out.', '<a class="btn btn-primary" href="/holiday-packages" data-public-route="/holiday-packages">Browse packages</a>'); return; }
        items = cartData.cart.items;
        pricing = cartData.pricing;
      }

      const customer = prefill.customer || {};
      const travelers = prefill.travelers || [];
      box.innerHTML = `<form class="sf-checkout" id="sfCheckoutForm" data-source="${directProduct ? 'direct' : 'cart'}" data-product="${esc(directId || '')}" data-qty="${directQty}">
        <div class="sf-checkout-main">
          <section class="sf-panel">
            <div class="sf-panel-head"><h2>Contact &amp; billing details</h2>${customer.fullName ? '<span class="sf-tag">Auto-filled from your account</span>' : ''}</div>
            <div class="sf-form-grid">
              <label class="sf-field"><span>Full name *</span><input name="fullName" required value="${esc(customer.fullName || '')}" /></label>
              <label class="sf-field"><span>Email *</span><input type="email" name="email" required value="${esc(customer.email || '')}" /></label>
              <label class="sf-field"><span>Phone *</span><input name="phone" required value="${esc(customer.phone || '')}" /></label>
              <label class="sf-field"><span>Nationality</span><input name="nationality" value="${esc(customer.nationality || '')}" /></label>
              <label class="sf-field sf-field-wide"><span>Address</span><input name="address" value="${esc(customer.address || '')}" /></label>
              <label class="sf-field"><span>Travel date</span><input type="date" name="travelDate" min="${todayPlus(0)}" /></label>
            </div>
          </section>

          <section class="sf-panel">
            <div class="sf-panel-head"><h2>Traveller details</h2><button class="sf-link" type="button" data-sf-add-traveler>+ Add traveller</button></div>
            ${travelers.length ? `<div class="sf-saved-travelers"><span>Use a saved traveller:</span>${travelers.map((traveler) => `<button class="sf-chip sf-chip-btn" type="button" data-sf-use-traveler='${esc(JSON.stringify(traveler))}'>${esc(traveler.fullName)}</button>`).join('')}</div>` : ''}
            <div id="sfTravelers" class="sf-travelers"></div>
            <p class="sf-hint">Traveller details are used for this booking only and never change your account profile.</p>
          </section>

          <section class="sf-panel">
            <h2>Payment method</h2>
            <div class="sf-pay-options">
              <label class="sf-pay"><input type="radio" name="paymentMethod" value="online" checked /><span><strong>${icon('i-card')} Pay online</strong><small>Card, bKash, Nagad or internet banking via our secure gateway</small></span></label>
              <label class="sf-pay"><input type="radio" name="paymentMethod" value="bank_transfer" /><span><strong>${icon('i-wallet')} Bank transfer</strong><small>We send account details and confirm once funds arrive</small></span></label>
              <label class="sf-pay"><input type="radio" name="paymentMethod" value="office" /><span><strong>${icon('i-hotel')} Pay at office</strong><small>Reserve now and pay at a Sadik Travels counter</small></span></label>
            </div>
          </section>

          <section class="sf-panel">
            <h2>Notes for our team</h2>
            <textarea name="notes" rows="3" placeholder="Special requests, meal preference, wheelchair assistance…"></textarea>
          </section>
        </div>

        <aside class="sf-summary sf-summary-sticky">
          <h2>Your order</h2>
          <ul class="sf-summary-items">${items.map((item) => `<li><span>${esc(item.title)} × ${item.quantity}</span><span>${money(item.lineTotal ?? item.unitPrice * item.quantity)}</span></li>`).join('')}</ul>
          ${summaryRows(pricing)}
          <label class="sf-terms"><input type="checkbox" name="acceptTerms" required /><span>I accept the booking terms, fare rules and cancellation policy.</span></label>
          <button class="btn btn-primary full-btn" type="submit" id="sfPlaceOrder">${icon('i-shield')} Confirm &amp; pay ${money(pricing.total)}</button>
          <p class="sf-secure">${icon('i-shield')} Totals are recalculated and verified on our servers before payment.</p>
        </aside>
      </form>`;
      addTravelerRow();
    } catch (error) {
      box.innerHTML = errorState(error.message);
    }
  }

  function addTravelerRow(values = {}) {
    const holder = $('#sfTravelers');
    if (!holder) return;
    const index = holder.children.length;
    if (index >= 15) { toast('You can add up to 15 travellers per booking', 'error'); return; }
    const row = document.createElement('div');
    row.className = 'sf-traveler-row';
    row.innerHTML = `
      <div class="sf-traveler-head"><strong>Traveller ${index + 1}</strong><button class="sf-link sf-link-danger" type="button" data-sf-remove-traveler>Remove</button></div>
      <div class="sf-form-grid">
        <label class="sf-field"><span>Full name</span><input name="tFullName" value="${esc(values.fullName || '')}" /></label>
        <label class="sf-field"><span>Date of birth</span><input type="date" name="tDob" value="${esc(values.dateOfBirth || '')}" /></label>
        <label class="sf-field"><span>Gender</span><select name="tGender"><option value="">—</option><option value="male" ${values.gender === 'male' ? 'selected' : ''}>Male</option><option value="female" ${values.gender === 'female' ? 'selected' : ''}>Female</option><option value="other" ${values.gender === 'other' ? 'selected' : ''}>Other</option></select></label>
        <label class="sf-field"><span>Nationality</span><input name="tNationality" value="${esc(values.nationality || '')}" /></label>
        <label class="sf-field"><span>Passport number</span><input name="tPassport" value="${esc(values.passportNumber || '')}" /></label>
        <label class="sf-field"><span>Passport expiry</span><input type="date" name="tPassportExpiry" value="${esc(values.passportExpiry || '')}" /></label>
      </div>`;
    holder.appendChild(row);
  }

  async function submitCheckout(form) {
    const button = $('#sfPlaceOrder');
    const data = new FormData(form);
    const travelers = $$('.sf-traveler-row', form).map((row) => ({
      fullName: $('[name="tFullName"]', row).value.trim(),
      dateOfBirth: $('[name="tDob"]', row).value || undefined,
      gender: $('[name="tGender"]', row).value || undefined,
      nationality: $('[name="tNationality"]', row).value.trim() || undefined,
      passportNumber: $('[name="tPassport"]', row).value.trim() || undefined,
      passportExpiry: $('[name="tPassportExpiry"]', row).value || undefined
    })).filter((traveler) => traveler.fullName.length > 1);

    const payload = {
      source: form.dataset.source === 'direct' ? 'direct' : 'cart',
      customer: {
        fullName: String(data.get('fullName') || '').trim(),
        email: String(data.get('email') || '').trim(),
        phone: String(data.get('phone') || '').trim(),
        address: String(data.get('address') || '').trim() || undefined,
        nationality: String(data.get('nationality') || '').trim() || undefined
      },
      travelers,
      travelDate: data.get('travelDate') || undefined,
      notes: String(data.get('notes') || '').trim() || undefined,
      paymentMethod: data.get('paymentMethod') || 'online',
      acceptTerms: true
    };
    if (payload.source === 'direct') payload.item = { productType: 'catalog', productId: form.dataset.product, quantity: Number(form.dataset.qty || 1), meta: {} };

    button.disabled = true;
    button.innerHTML = 'Placing your booking…';
    try {
      const result = await api.post('/checkout', payload);
      toast(`Booking ${result.order.orderNumber} created`, 'success');
      await refreshBadges();
      if (payload.paymentMethod === 'online') {
        try {
          const payResult = await api.post(`/orders/${result.order.id}/pay`, {});
          if (payResult.checkoutUrl) { window.location.href = payResult.checkoutUrl; return; }
          toast(payResult.message || 'Payment session created', 'success');
        } catch (error) {
          toast(error.message || 'Online payment is unavailable right now. Your booking is saved.', 'error');
        }
      }
      window.SadikPages.navigate(`/orders/${result.order.orderNumber}`);
    } catch (error) {
      toast(error.message || 'We could not complete your booking', 'error');
      button.disabled = false;
      button.innerHTML = 'Try again';
    }
  }

  /* -------------------------------------------------------------- orders */
  async function renderOrders(root) {
    if (!isLoggedIn()) return renderLoginRequired(root, 'My bookings', 'Login to see your bookings and orders.');
    root.innerHTML = `<div class="sf-page">${breadcrumbs([{ label: 'Home', href: '/' }, { label: 'My bookings' }])}${pageHead({ eyebrow: 'Account', title: 'My Bookings & Orders', description: 'Every Sadik Travels booking, order, payment and invoice in one place.' })}${loadingState('Loading your bookings…')}</div>`;
    try {
      const result = await api.get('/orders?pageSize=30');
      const body = result.orders.length
        ? `<div class="sf-order-list">${result.orders.map(orderRow).join('')}</div>`
        : emptyState('No bookings yet', 'Your bookings appear here as soon as you make one.', '<a class="btn btn-primary" href="/holiday-packages" data-public-route="/holiday-packages">Find something to book</a>');
      root.innerHTML = `<div class="sf-page">${breadcrumbs([{ label: 'Home', href: '/' }, { label: 'My bookings' }])}${pageHead({ eyebrow: 'Account', title: 'My Bookings & Orders', description: `${result.total} record${result.total === 1 ? '' : 's'}.` })}${body}</div>`;
    } catch (error) {
      root.innerHTML = `<div class="sf-page">${errorState(error.message)}</div>`;
    }
  }

  const statusPill = (status) => `<span class="sf-pill sf-pill-${esc(status)}">${esc(titleCase(status))}</span>`;

  const orderRow = (order) => `
    <a class="sf-order-row" href="/orders/${esc(order.orderNumber)}" data-public-route="/orders/${esc(order.orderNumber)}">
      <div class="sf-order-media">${order.items?.[0]?.imageUrl ? `<img src="${esc(order.items[0].imageUrl)}" alt="" />` : icon('i-images')}</div>
      <div class="sf-order-main">
        <strong>${esc(order.items?.[0]?.title || titleCase(order.primaryType))}${order.items?.length > 1 ? ` +${order.items.length - 1} more` : ''}</strong>
        <small>${esc(order.orderNumber)} · ${dateLabel(order.createdAt)}${order.travelDate ? ` · Travel ${dateLabel(order.travelDate)}` : ''}</small>
        <div class="sf-order-pills">${statusPill(order.status)}${statusPill(order.paymentStatus)}</div>
      </div>
      <div class="sf-order-side"><strong>${money(order.total, order.currency)}</strong><span>View details ›</span></div>
    </a>`;

  async function renderOrderDetail(root, reference) {
    if (!isLoggedIn()) return renderLoginRequired(root, 'Booking', 'Login to view this booking.');
    root.innerHTML = `<div class="sf-page">${loadingState('Loading booking…')}</div>`;
    try {
      const { order, invoice } = await api.get(`/orders/${encodeURIComponent(reference)}`);
      root.innerHTML = `<div class="sf-page">
        ${breadcrumbs([{ label: 'Home', href: '/' }, { label: 'My bookings', href: '/orders' }, { label: order.orderNumber }])}
        ${pageHead({ eyebrow: titleCase(order.primaryType), title: `Booking ${order.orderNumber}`, description: `Created ${dateTimeLabel(order.createdAt)}`, actions: `
          ${invoice ? `<a class="btn btn-outline" href="/invoice/${esc(invoice.invoiceNumber)}" data-public-route="/invoice/${esc(invoice.invoiceNumber)}">${icon('i-file')} Invoice</a>` : ''}
          ${order.paymentStatus !== 'paid' && !['cancelled', 'refunded'].includes(order.status) ? `<button class="btn btn-primary" type="button" data-sf-pay="${esc(order.id)}">${icon('i-card')} Pay now</button>` : ''}` })}
        <div class="sf-detail">
          <div class="sf-detail-main">
            <section class="sf-panel">
              <h2>Items</h2>
              <div class="sf-order-items">${order.items.map((item) => `
                <div class="sf-order-item">
                  <div class="sf-cart-media">${item.imageUrl ? `<img src="${esc(item.imageUrl)}" alt="" />` : icon('i-images')}</div>
                  <div><strong>${esc(item.title)}</strong><small>${esc(titleCase(item.productType))} · Qty ${item.quantity}</small></div>
                  <strong>${money(item.lineTotal, order.currency)}</strong>
                </div>`).join('')}</div>
            </section>
            <section class="sf-panel">
              <h2>Booking timeline</h2>
              <ol class="sf-timeline">${(order.timeline || []).map((entry) => `<li><span class="sf-timeline-dot"></span><div><strong>${esc(titleCase(entry.status))}</strong>${entry.note ? `<p>${esc(entry.note)}</p>` : ''}<small>${dateTimeLabel(entry.at)}</small></div></li>`).join('')}</ol>
            </section>
            ${order.travelers?.length ? `<section class="sf-panel"><h2>Travellers</h2><div class="sf-fact-grid">${order.travelers.map((traveler) => `<div class="sf-fact"><small>${esc(traveler.nationality || 'Traveller')}</small><strong>${esc(traveler.fullName)}</strong></div>`).join('')}</div></section>` : ''}
          </div>
          <aside class="sf-detail-side">
            <div class="sf-summary">
              <h2>Payment summary</h2>
              ${summaryRows({ subtotal: order.subtotal, couponDiscount: order.couponDiscount, couponCode: order.couponCode, tax: order.tax, serviceFee: order.serviceFee, total: order.total })}
              <div class="sf-summary-rows"><div><span>Payment status</span><span>${statusPill(order.paymentStatus)}</span></div><div><span>Booking status</span><span>${statusPill(order.status)}</span></div>${order.paymentMethod ? `<div><span>Method</span><span>${esc(titleCase(order.paymentMethod))}</span></div>` : ''}</div>
              ${['pending', 'confirmed', 'processing'].includes(order.status) ? `<button class="btn btn-outline full-btn" type="button" data-sf-cancel-order="${esc(order.id)}">Cancel booking</button>` : ''}
            </div>
            <div class="sf-support-card"><strong>${icon('i-headset')} Questions?</strong><p>Quote ${esc(order.orderNumber)} when you contact us.</p><a class="btn btn-outline full-btn" href="/support" data-public-route="/support">Get support</a></div>
          </aside>
        </div>
      </div>`;
    } catch (error) {
      root.innerHTML = `<div class="sf-page">${errorState(error.status === 404 ? 'Booking not found.' : error.message)}</div>`;
    }
  }

  /* ------------------------------------------------------------- invoice */
  async function renderInvoice(root, reference) {
    if (!isLoggedIn()) return renderLoginRequired(root, 'Invoice', 'Login to view your invoice.');
    root.innerHTML = `<div class="sf-page">${loadingState('Loading invoice…')}</div>`;
    try {
      const { invoice } = await api.get(`/invoices/${encodeURIComponent(reference)}`);
      root.innerHTML = `<div class="sf-page">
        ${breadcrumbs([{ label: 'Home', href: '/' }, { label: 'My bookings', href: '/orders' }, { label: invoice.invoiceNumber }])}
        ${pageHead({ eyebrow: 'Billing', title: `Invoice ${invoice.invoiceNumber}`, description: `Issued ${dateLabel(invoice.issuedAt)}`, actions: `<button class="btn btn-outline" type="button" data-sf-print>${icon('i-print')} Print</button><button class="btn btn-primary" type="button" data-sf-download-invoice>${icon('i-download')} Download</button>` })}
        <section class="sf-panel sf-invoice" id="sfInvoice">
          <div class="sf-invoice-head">
            <div><img src="/assets/sadik-travels-logo.png?v=3" alt="Sadik Travels" class="sf-invoice-logo" /><p>Sadik Travels<br />Dhaka, Bangladesh</p></div>
            <div class="sf-invoice-meta">
              <div><small>Invoice</small><strong>${esc(invoice.invoiceNumber)}</strong></div>
              <div><small>Booking</small><strong>${esc(invoice.orderNumber)}</strong></div>
              <div><small>Status</small><strong>${esc(titleCase(invoice.status))}</strong></div>
              <div><small>Date</small><strong>${dateLabel(invoice.issuedAt)}</strong></div>
            </div>
          </div>
          <div class="sf-invoice-parties">
            <div><small>Billed to</small><strong>${esc(invoice.customer?.fullName || '')}</strong><p>${esc(invoice.customer?.email || '')}<br />${esc(invoice.customer?.phone || '')}<br />${esc(invoice.customer?.address || '')}</p></div>
            <div><small>Payment method</small><strong>${esc(titleCase(invoice.paymentMethod || 'Online'))}</strong></div>
          </div>
          <table class="sf-invoice-table">
            <thead><tr><th>Item</th><th>Qty</th><th>Unit</th><th>Total</th></tr></thead>
            <tbody>${invoice.items.map((item) => `<tr><td>${esc(item.title)}<small>${esc(titleCase(item.productType))}</small></td><td>${item.quantity}</td><td>${money(item.unitPrice, invoice.currency)}</td><td>${money(item.lineTotal, invoice.currency)}</td></tr>`).join('')}</tbody>
          </table>
          <div class="sf-invoice-totals">
            <div><span>Subtotal</span><span>${money(invoice.subtotal, invoice.currency)}</span></div>
            ${invoice.discount ? `<div><span>Discount</span><span>−${money(invoice.discount, invoice.currency)}</span></div>` : ''}
            ${invoice.tax ? `<div><span>Tax</span><span>${money(invoice.tax, invoice.currency)}</span></div>` : ''}
            ${invoice.serviceFee ? `<div><span>Service fee</span><span>${money(invoice.serviceFee, invoice.currency)}</span></div>` : ''}
            <div class="sf-invoice-grand"><span>Total</span><span>${money(invoice.total, invoice.currency)}</span></div>
          </div>
        </section>
      </div>`;
    } catch (error) {
      root.innerHTML = `<div class="sf-page">${errorState(error.status === 404 ? 'Invoice not found.' : error.message)}</div>`;
    }
  }

  /* -------------------------------------------------------- track booking */
  async function renderTrackBooking(root, query) {
    root.innerHTML = `<div class="sf-page">
      ${breadcrumbs([{ label: 'Home', href: '/' }, { label: 'Track booking' }])}
      ${pageHead({ eyebrow: 'Manage', title: 'Track Your Booking', description: 'Enter your booking reference with the email or phone used at checkout.' })}
      <div class="sf-track-layout">
        <section class="sf-panel">
          <form class="sf-form-grid" id="sfTrackForm">
            <label class="sf-field"><span>Booking reference *</span><input name="reference" required placeholder="SB-20260816-A1B2C3" value="${esc(query.get('ref') || '')}" /></label>
            <label class="sf-field"><span>Email or phone *</span><input name="identity" required placeholder="you@example.com" /></label>
            <button class="btn btn-primary sf-search-btn" type="submit">${icon('i-search')} Track booking</button>
          </form>
          <div id="sfTrackResult"></div>
        </section>
        <aside class="sf-support-card">
          <strong>${icon('i-info')} Where is my reference?</strong>
          <p>Your reference starts with SB or SO and is on your confirmation email, invoice and in My Bookings.</p>
          <a class="btn btn-outline full-btn" href="/orders" data-public-route="/orders">Open my bookings</a>
        </aside>
      </div>
    </div>`;
    if (query.get('ref') && query.get('identity')) {
      $('#sfTrackForm [name="identity"]', root).value = query.get('identity');
      await trackBooking($('#sfTrackForm', root));
    }
  }

  async function trackBooking(form) {
    const box = $('#sfTrackResult');
    const data = new FormData(form);
    box.innerHTML = loadingState('Looking up your booking…');
    try {
      const { order } = await api.post('/orders/track', { reference: String(data.get('reference')).trim(), identity: String(data.get('identity')).trim() });
      box.innerHTML = `<div class="sf-track-result">
        <div class="sf-track-head">
          <div><small>Booking</small><strong>${esc(order.orderNumber)}</strong></div>
          <div><small>Status</small>${statusPill(order.status)}</div>
          <div><small>Payment</small>${statusPill(order.paymentStatus)}</div>
          <div><small>Total</small><strong>${money(order.total, order.currency)}</strong></div>
        </div>
        <div class="sf-fact-grid">
          <div class="sf-fact"><small>Customer</small><strong>${esc(order.customerName || '—')}</strong></div>
          <div class="sf-fact"><small>Product</small><strong>${esc(order.items?.[0]?.title || titleCase(order.primaryType))}</strong></div>
          <div class="sf-fact"><small>Travel date</small><strong>${order.travelDate ? dateLabel(order.travelDate) : '—'}</strong></div>
          <div class="sf-fact"><small>Last update</small><strong>${dateTimeLabel(order.updatedAt)}</strong></div>
        </div>
        <h3>Timeline</h3>
        <ol class="sf-timeline">${(order.timeline || []).map((entry) => `<li><span class="sf-timeline-dot"></span><div><strong>${esc(titleCase(entry.status))}</strong>${entry.note ? `<p>${esc(entry.note)}</p>` : ''}<small>${dateTimeLabel(entry.at)}</small></div></li>`).join('')}</ol>
      </div>`;
    } catch (error) {
      box.innerHTML = errorState(error.status === 404 ? 'No booking matched that reference and contact detail.' : error.message);
    }
  }

  /* -------------------------------------------------------------- support */
  async function renderSupport(root) {
    root.innerHTML = `<div class="sf-page">
      ${breadcrumbs([{ label: 'Home', href: '/' }, { label: 'Support' }])}
      ${pageHead({ eyebrow: 'Help centre', title: 'Sadik Travels Support', description: 'Open a ticket and our travel desk responds during business hours, usually much faster.' })}
      <div class="sf-support-layout">
        <section class="sf-panel">
          <h2>Create a support ticket</h2>
          <form class="sf-form-grid" id="sfTicketForm">
            <label class="sf-field"><span>Your name *</span><input name="name" required value="${esc(state.user?.fullName || '')}" /></label>
            <label class="sf-field"><span>Mobile *</span><input name="mobile" required value="${esc(state.user?.phone || '')}" /></label>
            <label class="sf-field"><span>Email *</span><input type="email" name="email" required value="${esc(state.user?.email || '')}" /></label>
            <label class="sf-field sf-field-wide"><span>Subject *</span><input name="subject" required placeholder="Booking SB-… payment question" /></label>
            <button class="btn btn-primary sf-search-btn" type="submit">${icon('i-headset')} Submit ticket</button>
          </form>
          <div id="sfTicketResult"></div>
        </section>
        <aside class="sf-support-side">
          <div class="sf-support-card"><strong>${icon('i-phone')} Call us</strong><p id="sfSupportPhone">Loading…</p></div>
          <div class="sf-support-card"><strong>${icon('i-info')} Email</strong><p id="sfSupportEmail">Loading…</p></div>
          <div class="sf-support-card"><strong>${icon('i-clock')} Hours</strong><p>Saturday – Thursday, 09:00 – 21:00 (GMT+6)</p></div>
        </aside>
      </div>
      <section class="sf-panel"><h2>Frequently asked</h2><div class="sf-faq" id="sfFaq">${loadingState('Loading FAQs…')}</div></section>
    </div>`;
    try {
      const settings = await api.get('/site/settings');
      $('#sfSupportPhone', root).textContent = settings.settings?.support_phone || 'Support phone will appear here once configured.';
      $('#sfSupportEmail', root).textContent = settings.settings?.support_email || 'Support email will appear here once configured.';
    } catch { /* non critical */ }
    try {
      const response = await api.get('/site/content?type=faq');
      const faqs = response.content || [];
      $('#sfFaq', root).innerHTML = faqs.length
        ? faqs.map((faq) => `<details class="sf-faq-item"><summary>${esc(faq.title)}</summary><p>${esc(faq.description || faq.subtitle || '')}</p></details>`).join('')
        : emptyState('No FAQs published yet', 'Our team publishes answers to common questions here.');
    } catch { $('#sfFaq', root).innerHTML = emptyState('FAQs unavailable', 'Please try again shortly.'); }
  }

  /* -------------------------------------------------------------- account */
  const ACCOUNT_TABS = [
    { key: 'profile', label: 'My Profile', icon: 'i-user' },
    { key: 'bookings', label: 'My Bookings', icon: 'i-briefcase' },
    { key: 'wishlist', label: 'Wishlist', icon: 'i-heart' },
    { key: 'travelers', label: 'Saved Travellers', icon: 'i-user' },
    { key: 'invoices', label: 'Invoices', icon: 'i-file' },
    { key: 'reviews', label: 'My Reviews', icon: 'i-star' },
    { key: 'notifications', label: 'Notifications', icon: 'i-bell' },
    { key: 'security', label: 'Security', icon: 'i-shield' }
  ];

  async function renderAccount(root, query) {
    if (!isLoggedIn()) return renderLoginRequired(root, 'My account', 'Login to open your Sadik Travels dashboard.');
    const tab = query.get('tab') || 'profile';
    root.innerHTML = `<div class="sf-page">
      ${breadcrumbs([{ label: 'Home', href: '/' }, { label: 'My account' }])}
      ${pageHead({ eyebrow: 'Account', title: `Hello, ${state.user.fullName || 'traveller'}`, description: 'Manage your profile, bookings, travellers, invoices and preferences.' })}
      <div class="sf-account">
        <nav class="sf-account-nav">
          ${ACCOUNT_TABS.map((item) => `<a class="sf-account-link ${tab === item.key ? 'is-active' : ''}" href="/account?tab=${item.key}" data-public-route="/account?tab=${item.key}">${icon(item.icon)}<span>${esc(item.label)}</span></a>`).join('')}
          <button class="sf-account-link sf-account-logout" type="button" data-sf-logout>${icon('i-close')}<span>Logout</span></button>
        </nav>
        <div class="sf-account-body" id="sfAccountBody">${loadingState()}</div>
      </div>
    </div>`;
    const body = $('#sfAccountBody', root);
    try {
      if (tab === 'profile') body.innerHTML = accountProfile();
      else if (tab === 'bookings') { const result = await api.get('/orders?pageSize=20'); body.innerHTML = result.orders.length ? `<div class="sf-order-list">${result.orders.map(orderRow).join('')}</div>` : emptyState('No bookings yet', 'Bookings you make appear here.'); }
      else if (tab === 'wishlist') { const { items } = await api.get('/wishlist'); body.innerHTML = items.length ? `<div class="sf-grid sf-grid-2">${items.map((item) => `<article class="sf-mini-card"><strong>${esc(item.title)}</strong><small>${esc(titleCase(item.productType))}</small><button class="sf-link sf-link-danger" type="button" data-sf-wish-remove="${esc(item.id)}">Remove</button></article>`).join('')}</div>` : emptyState('Wishlist empty', 'Save products to find them here.'); }
      else if (tab === 'travelers') await renderTravelersTab(body);
      else if (tab === 'invoices') { const { invoices } = await api.get('/invoices'); body.innerHTML = invoices.length ? `<div class="sf-table-wrap"><table class="sf-table"><thead><tr><th>Invoice</th><th>Booking</th><th>Date</th><th>Total</th><th>Status</th><th></th></tr></thead><tbody>${invoices.map((invoice) => `<tr><td>${esc(invoice.invoiceNumber)}</td><td>${esc(invoice.orderNumber)}</td><td>${dateLabel(invoice.issuedAt)}</td><td>${money(invoice.total, invoice.currency)}</td><td>${statusPill(invoice.status)}</td><td><a class="sf-link" href="/invoice/${esc(invoice.invoiceNumber)}" data-public-route="/invoice/${esc(invoice.invoiceNumber)}">View</a></td></tr>`).join('')}</tbody></table></div>` : emptyState('No invoices yet', 'Invoices are generated automatically after checkout.'); }
      else if (tab === 'reviews') { const result = await api.get('/account/reviews'); body.innerHTML = result.reviews.length ? `<div class="sf-reviews">${result.reviews.map((review) => `<article class="sf-review"><div class="sf-review-head"><strong>${esc(review.productTitle || titleCase(review.productType))}</strong>${statusPill(review.status)}</div><span class="sf-stars">${'★'.repeat(review.rating)}${'☆'.repeat(5 - review.rating)}</span><p>${esc(review.body)}</p><small>${dateLabel(review.createdAt)}</small></article>`).join('')}</div>` : emptyState('No reviews yet', 'Review a product after your booking is confirmed.'); }
      else if (tab === 'notifications') { const { notifications } = await api.get('/notifications'); body.innerHTML = notifications.length ? `<div class="sf-notification-list">${notifications.map((item) => `<article class="sf-notification ${item.readAt ? '' : 'is-unread'}"><strong>${esc(item.title)}</strong><p>${esc(item.message)}</p><small>${dateTimeLabel(item.createdAt)}</small></article>`).join('')}</div>` : emptyState('No notifications', 'Booking and payment updates appear here.'); }
      else if (tab === 'security') body.innerHTML = accountSecurity();
      else body.innerHTML = emptyState('Unknown section', 'Choose a section from the menu.');
    } catch (error) {
      body.innerHTML = errorState(error.message);
    }
  }

  const accountProfile = () => `
    <section class="sf-panel">
      <h2>Profile details</h2>
      <form class="sf-form-grid" id="sfProfileForm">
        <label class="sf-field"><span>Full name</span><input name="fullName" value="${esc(state.user.fullName || '')}" /></label>
        <label class="sf-field"><span>Email</span><input value="${esc(state.user.email || '')}" disabled /></label>
        <label class="sf-field"><span>Phone</span><input value="${esc(state.user.phone || '')}" disabled /></label>
        <label class="sf-field"><span>Member since</span><input value="${dateLabel(state.user.createdAt)}" disabled /></label>
        <button class="btn btn-primary sf-search-btn" type="submit">Save profile</button>
      </form>
      <p class="sf-hint">Email and phone changes are verified with a one-time code from the login menu.</p>
    </section>
    <section class="sf-panel">
      <h2>Marketing preferences</h2>
      <form class="sf-pref-form" id="sfPrefForm">
        <label class="sf-switch"><input type="checkbox" name="marketingEmailOptIn" ${state.user.marketingEmailOptIn ? 'checked' : ''} /><span>Email offers and travel inspiration</span></label>
        <label class="sf-switch"><input type="checkbox" name="marketingSmsOptIn" ${state.user.marketingSmsOptIn ? 'checked' : ''} /><span>SMS fare alerts</span></label>
        <label class="sf-switch"><input type="checkbox" name="marketingInAppOptIn" ${state.user.marketingInAppOptIn ? 'checked' : ''} /><span>In-app notifications</span></label>
        <button class="btn btn-outline" type="submit">Update preferences</button>
      </form>
    </section>`;

  const accountSecurity = () => `
    <section class="sf-panel">
      <h2>Account security</h2>
      <div class="sf-fact-grid">
        <div class="sf-fact"><small>Login method</small><strong>One-time code</strong></div>
        <div class="sf-fact"><small>Account status</small><strong>${esc(titleCase(state.user.status || 'active'))}</strong></div>
        <div class="sf-fact"><small>Role</small><strong>${esc(titleCase(state.user.role || 'customer'))}</strong></div>
        <div class="sf-fact"><small>Last login</small><strong>${state.user.lastLoginAt ? dateTimeLabel(state.user.lastLoginAt) : '—'}</strong></div>
      </div>
      <p class="sf-hint">Sadik Travels never asks for your one-time code by phone or email. Sessions are signed, HttpOnly and expire automatically.</p>
      <button class="btn btn-outline" type="button" data-sf-logout>Log out of this device</button>
    </section>`;

  async function renderTravelersTab(body) {
    const { travelers } = await api.get('/account/travelers');
    body.innerHTML = `
      <section class="sf-panel">
        <div class="sf-panel-head"><h2>Saved travellers</h2><span class="sf-tag">${travelers.length} saved</span></div>
        ${travelers.length ? `<div class="sf-grid sf-grid-2">${travelers.map((traveler) => `
          <article class="sf-mini-card">
            <strong>${esc(traveler.fullName)}</strong>
            <small>${[traveler.nationality, traveler.gender ? titleCase(traveler.gender) : '', traveler.dateOfBirth ? dateLabel(traveler.dateOfBirth) : ''].filter(Boolean).join(' · ') || 'Traveller'}</small>
            ${traveler.passportNumber ? `<small>Passport ••••${esc(String(traveler.passportNumber).slice(-4))}</small>` : ''}
            <button class="sf-link sf-link-danger" type="button" data-sf-traveler-remove="${esc(traveler.id)}">Remove</button>
          </article>`).join('')}</div>` : emptyState('No saved travellers', 'Save travellers once and reuse them at every checkout.')}
      </section>
      <section class="sf-panel">
        <h2>Add a traveller</h2>
        <form class="sf-form-grid" id="sfTravelerForm">
          <label class="sf-field"><span>Full name *</span><input name="fullName" required /></label>
          <label class="sf-field"><span>Date of birth</span><input type="date" name="dateOfBirth" /></label>
          <label class="sf-field"><span>Gender</span><select name="gender"><option value="">—</option><option value="male">Male</option><option value="female">Female</option><option value="other">Other</option></select></label>
          <label class="sf-field"><span>Nationality</span><input name="nationality" /></label>
          <label class="sf-field"><span>Passport number</span><input name="passportNumber" /></label>
          <label class="sf-field"><span>Passport expiry</span><input type="date" name="passportExpiry" /></label>
          <button class="btn btn-primary sf-search-btn" type="submit">Save traveller</button>
        </form>
        <p class="sf-hint">Passport details are stored only to speed up your own bookings and are never shared.</p>
      </section>`;
  }

  const renderLoginRequired = (root, title, message) => {
    root.innerHTML = `<div class="sf-page">
      ${breadcrumbs([{ label: 'Home', href: '/' }, { label: title }])}
      ${pageHead({ eyebrow: 'Account', title, description: message })}
      <div class="sf-state sf-login-required">
        <div class="sf-state-icon">${icon('i-user')}</div>
        <strong>Login required</strong><p>${esc(message)}</p>
        <div class="sf-state-actions"><button class="btn btn-primary" type="button" data-sf-login>Login or sign up</button><a class="btn btn-outline" href="/" data-public-route="/">Back home</a></div>
      </div>
    </div>`;
  };

  /* ----------------------------------------------------- visa application */
  async function renderVisaApply(root, slug) {
    if (!isLoggedIn()) return renderLoginRequired(root, 'Visa application', 'Login to start a visa application.');
    root.innerHTML = `<div class="sf-page">${loadingState('Loading visa service…')}</div>`;
    try {
      const { product } = await api.get(`/catalog/${encodeURIComponent(slug)}`);
      const prefill = await api.get('/checkout/prefill').catch(() => ({ customer: {} }));
      const customer = prefill.customer || {};
      root.innerHTML = `<div class="sf-page">
        ${breadcrumbs([{ label: 'Home', href: '/' }, { label: 'Visa Services', href: '/visa' }, { label: product.title, href: `/visa/${esc(product.slug)}` }, { label: 'Apply' }])}
        ${pageHead({ eyebrow: 'Visa application', title: `Apply — ${product.title}`, description: 'Your account details are pre-filled. Add passport information and submit; our visa desk takes it from there.' })}
        <form class="sf-checkout" id="sfVisaForm" data-product="${esc(product.id)}">
          <div class="sf-checkout-main">
            <section class="sf-panel">
              <div class="sf-panel-head"><h2>Applicant details</h2>${customer.fullName ? '<span class="sf-tag">Auto-filled from your account</span>' : ''}</div>
              <div class="sf-form-grid">
                <label class="sf-field"><span>Full name *</span><input name="fullName" required value="${esc(customer.fullName || '')}" /></label>
                <label class="sf-field"><span>Email *</span><input type="email" name="email" required value="${esc(customer.email || '')}" /></label>
                <label class="sf-field"><span>Phone *</span><input name="phone" required value="${esc(customer.phone || '')}" /></label>
                <label class="sf-field"><span>Date of birth</span><input type="date" name="dateOfBirth" /></label>
                <label class="sf-field"><span>Nationality</span><input name="nationality" value="${esc(customer.nationality || '')}" /></label>
                <label class="sf-field sf-field-wide"><span>Address</span><input name="address" value="${esc(customer.address || '')}" /></label>
              </div>
            </section>
            <section class="sf-panel">
              <h2>Passport details</h2>
              <div class="sf-form-grid">
                <label class="sf-field"><span>Passport number *</span><input name="passportNumber" required /></label>
                <label class="sf-field"><span>Issuing country</span><input name="issuingCountry" /></label>
                <label class="sf-field"><span>Issue date</span><input type="date" name="issueDate" /></label>
                <label class="sf-field"><span>Expiry date</span><input type="date" name="expiryDate" /></label>
                <label class="sf-field"><span>Intended travel date</span><input type="date" name="travelDate" min="${todayPlus(0)}" /></label>
              </div>
            </section>
            ${product.requiredDocuments?.length ? `<section class="sf-panel"><h2>Documents you will need</h2><ul class="sf-list sf-list-doc">${product.requiredDocuments.map((item) => `<li>${icon('i-file')}${esc(item)}</li>`).join('')}</ul><p class="sf-hint">Our visa desk emails you a secure upload link right after submission.</p></section>` : ''}
          </div>
          <aside class="sf-summary sf-summary-sticky">
            <h2>${esc(product.title)}</h2>
            <div class="sf-summary-rows">
              ${product.visaType ? `<div><span>Visa type</span><span>${esc(product.visaType)}</span></div>` : ''}
              ${product.processingTime ? `<div><span>Processing</span><span>${esc(product.processingTime)}</span></div>` : ''}
              ${product.entryType ? `<div><span>Entry</span><span>${esc(product.entryType)}</span></div>` : ''}
              <div><span>Service fee</span><span>${money(product.serviceCharge || 0)}</span></div>
              <div class="sf-summary-total"><span>Total payable</span><span>${money(product.price + (product.serviceCharge || 0))}</span></div>
            </div>
            <label class="sf-terms"><input type="checkbox" required /><span>I confirm the information provided is accurate.</span></label>
            <button class="btn btn-primary full-btn" type="submit">${icon('i-passport')} Submit application</button>
          </aside>
        </form>
      </div>`;
    } catch (error) {
      root.innerHTML = `<div class="sf-page">${errorState(error.message)}</div>`;
    }
  }

  /* ------------------------------------------------------------- actions */
  async function addToCart(productId, quantity = 1) {
    if (!isLoggedIn()) return requireLogin('Login to add items to your cart');
    try {
      const data = await api.post('/cart/items', { productType: 'catalog', productId, quantity, meta: {} });
      state.cart = { count: data.cart.items.reduce((sum, item) => sum + item.quantity, 0), items: data.cart.items };
      paintBadges();
      toast('Added to your cart', 'success');
      return true;
    } catch (error) {
      toast(error.message || 'Could not add this item', 'error');
      return false;
    }
  }

  async function toggleWishlist(productId, button) {
    if (!isLoggedIn()) return requireLogin('Login to save items to your wishlist');
    const saved = state.wishlist.has(productId);
    try {
      if (saved) { await api.delete(`/wishlist/${encodeURIComponent(productId)}`); state.wishlist.delete(productId); toast('Removed from wishlist'); }
      else { await api.post('/wishlist', { productType: 'catalog', productId }); state.wishlist.add(productId); toast('Saved to your wishlist', 'success'); }
      paintBadges();
      if (button) {
        button.classList.toggle('is-saved', !saved);
        const label = button.querySelector('use');
        if (label) label.setAttribute('href', saved ? '#i-heart' : '#i-heart-fill');
      }
      $$('[data-sf-wish]').forEach((element) => {
        if (element.dataset.sfWish !== productId) return;
        element.classList.toggle('is-saved', !saved);
        const use = element.querySelector('use');
        if (use) use.setAttribute('href', saved ? '#i-heart' : '#i-heart-fill');
      });
    } catch (error) {
      toast(error.message || 'Wishlist update failed', 'error');
    }
  }


  /* ------------------------------------------------- homepage catalogue */
  /** Fills each homepage section with live catalogue products. Sections that
   *  already have editorial content keep it; empty ones get real products. */
  const HOME_SECTION_TYPES = {
    homes: 'home', 'visa-services': 'visa_service', esim: 'esim', 'special-umrah-fare': 'umrah_fare',
    'umrah-packages': 'umrah_package', 'holiday-packages': 'holiday_package', 'medical-tourism': 'medical_tourism',
    'card-offers': 'card_offer', 'airline-offers': 'airline_offer', explore: 'destination'
  };

  async function hydrateHomeSections() {
    const host = document.getElementById('homeSections');
    if (!host) return;
    let sections = [];
    try { sections = (await api.get('/storefront/home')).sections || []; } catch { return; }
    const byType = new Map(sections.map((section) => [section.type, section.products]));
    Object.entries(HOME_SECTION_TYPES).forEach(([sectionId, type]) => {
      const section = document.getElementById(sectionId);
      const products = byType.get(type);
      if (!section || !products?.length) return;
      const grid = section.querySelector('.hs-grid');
      const emptyBox = section.querySelector('.section-empty, .public-public-empty');
      const markup = `<div class="sf-grid sf-grid-home">${products.slice(0, 4).map((product) => productCard(product)).join('')}</div>`;
      if (emptyBox) emptyBox.outerHTML = markup;
      else if (grid && !grid.children.length) grid.outerHTML = markup;
      else if (!grid) section.querySelector('.panel-block')?.insertAdjacentHTML('beforeend', markup);
    });
  }

  /** Routes that render differently once the customer is authenticated. */
  const AUTH_ROUTES = new Set(['cart', 'wishlist', 'checkout', 'orders', 'invoice', 'account']);

  /* ---------------------------------------------------------- route table */
  const routes = {
    flights: (root, route) => renderFlights(root, route.query),
    app: (root) => renderAppPage(root),
    'sadik-app': (root) => renderAppPage(root),
    cart: (root) => renderCart(root),
    wishlist: (root) => renderWishlist(root),
    checkout: (root, route) => renderCheckout(root, route.query),
    orders: (root, route) => (route.parts[1] ? renderOrderDetail(root, route.parts[1]) : renderOrders(root)),
    invoice: (root, route) => renderInvoice(root, route.parts[1] || ''),
    'track-booking': (root, route) => renderTrackBooking(root, route.query),
    support: (root) => renderSupport(root),
    account: (root, route) => renderAccount(root, route.query)
  };

  Object.entries(COLLECTIONS).forEach(([routeKey, definition]) => {
    routes[routeKey] = (root, route) => {
      if (routeKey === 'visa' && route.parts[2] === 'apply') return renderVisaApply(root, route.parts[1]);
      return route.parts[1] ? renderProductDetail(root, definition, route.parts[1]) : renderCollection(root, definition, route.query);
    };
  });
  // Legacy alias kept working so old links never 404.
  routes['airline-offers'] = routes['airlines-offers'];

  /* --------------------------------------------------------------- events */
  function bindGlobalEvents() {
    document.addEventListener('click', async (event) => {
      const target = event.target;
      const closest = (selector) => target.closest?.(selector);

      const wish = closest('[data-sf-wish]');
      if (wish) { event.preventDefault(); await toggleWishlist(wish.dataset.sfWish, wish); return; }

      const wishRemove = closest('[data-sf-wish-remove]');
      if (wishRemove) {
        event.preventDefault();
        try { await api.delete(`/wishlist/${encodeURIComponent(wishRemove.dataset.sfWishRemove)}`); toast('Removed from wishlist'); await refreshBadges(); window.SadikPages.reload(); }
        catch (error) { toast(error.message, 'error'); }
        return;
      }

      const cart = closest('[data-sf-cart]');
      if (cart) { event.preventDefault(); cart.disabled = true; await addToCart(cart.dataset.sfCart, 1); cart.disabled = false; return; }

      const book = closest('[data-sf-book]');
      if (book) {
        event.preventDefault();
        if (!isLoggedIn()) { requireLogin('Login to complete your booking'); return; }
        window.SadikPages.navigate(`/checkout?product=${encodeURIComponent(book.dataset.sfBook)}&qty=1`);
        return;
      }

      const qty = closest('[data-sf-qty]');
      if (qty) {
        event.preventDefault();
        try { await api.request('/cart/items', { method: 'PATCH', body: JSON.stringify({ itemId: qty.dataset.sfQty, quantity: Number(qty.dataset.value) }) }); await paintCart(document); await refreshBadges(); }
        catch (error) { toast(error.message, 'error'); }
        return;
      }

      const cartRemove = closest('[data-sf-cart-remove]');
      if (cartRemove) {
        event.preventDefault();
        try { await api.delete(`/cart/items/${encodeURIComponent(cartRemove.dataset.sfCartRemove)}`); toast('Item removed'); await paintCart(document); await refreshBadges(); }
        catch (error) { toast(error.message, 'error'); }
        return;
      }

      const page = closest('[data-sf-page]');
      if (page && !page.disabled) {
        event.preventDefault();
        const url = new URL(location.href);
        url.searchParams.set('page', page.dataset.sfPage);
        window.SadikPages.navigate(`${url.pathname}${url.search}`);
        return;
      }

      const clear = closest('[data-sf-clear-filters]');
      if (clear) { event.preventDefault(); window.SadikPages.navigate(location.pathname); return; }

      const retry = closest('[data-sf-retry]');
      if (retry) { event.preventDefault(); window.SadikPages.reload(); return; }

      const login = closest('[data-sf-login]');
      if (login) { event.preventDefault(); if (typeof window.openLogin === 'function') window.openLogin(); return; }

      const logout = closest('[data-sf-logout]');
      if (logout) {
        event.preventDefault();
        try { await api.post('/auth/logout', {}); } catch { /* logout is best effort */ }
        state.user = null; await refreshBadges(); toast('You have been logged out', 'success');
        window.SadikPages.navigate('/');
        return;
      }

      const gallery = closest('[data-sf-gallery]');
      if (gallery) {
        event.preventDefault();
        const image = document.getElementById('sfGalleryImage');
        if (image) image.src = gallery.dataset.sfGallery;
        $$('.sf-gallery-thumbs button').forEach((button) => button.classList.toggle('is-active', button === gallery));
        return;
      }

      if (closest('[data-sf-share]')) {
        event.preventDefault();
        const shareData = { title: document.title, url: location.href };
        if (navigator.share) { try { await navigator.share(shareData); } catch { /* dismissed */ } }
        else { try { await navigator.clipboard.writeText(location.href); toast('Link copied', 'success'); } catch { toast('Copy the address bar link to share'); } }
        return;
      }

      if (closest('[data-sf-print]') || closest('[data-sf-download-invoice]')) { event.preventDefault(); window.print(); return; }

      const trip = closest('[data-sf-trip]');
      if (trip) {
        event.preventDefault();
        const url = new URL(location.href);
        url.searchParams.set('trip', trip.dataset.sfTrip);
        window.SadikPages.navigate(`${url.pathname}${url.search}`);
        return;
      }

      if (closest('[data-sf-add-leg]')) {
        event.preventDefault();
        const legs = document.getElementById('sfFlightLegs');
        if (legs && legs.children.length < 5) legs.insertAdjacentHTML('beforeend', flightLeg(legs.children.length, new URLSearchParams()));
        return;
      }

      const swap = closest('[data-sf-swap]');
      if (swap) {
        event.preventDefault();
        const leg = swap.closest('.sf-flight-leg');
        const from = $('[name="from"]', leg); const to = $('[name="to"]', leg);
        const value = from.value; from.value = to.value; to.value = value;
        return;
      }

      if (closest('[data-sf-add-traveler]')) { event.preventDefault(); addTravelerRow(); return; }

      const useTraveler = closest('[data-sf-use-traveler]');
      if (useTraveler) { event.preventDefault(); try { addTravelerRow(JSON.parse(useTraveler.dataset.sfUseTraveler)); } catch { addTravelerRow(); } return; }

      const removeTraveler = closest('[data-sf-remove-traveler]');
      if (removeTraveler) { event.preventDefault(); removeTraveler.closest('.sf-traveler-row')?.remove(); return; }

      const travelerRemove = closest('[data-sf-traveler-remove]');
      if (travelerRemove) {
        event.preventDefault();
        try { await api.delete(`/account/travelers/${encodeURIComponent(travelerRemove.dataset.sfTravelerRemove)}`); toast('Traveller removed'); window.SadikPages.reload(); }
        catch (error) { toast(error.message, 'error'); }
        return;
      }

      const pay = closest('[data-sf-pay]');
      if (pay) {
        event.preventDefault(); pay.disabled = true;
        try {
          const result = await api.post(`/orders/${encodeURIComponent(pay.dataset.sfPay)}/pay`, {});
          if (result.checkoutUrl) { window.location.href = result.checkoutUrl; return; }
          toast(result.message || 'Payment request recorded', 'success');
          window.SadikPages.reload();
        } catch (error) { toast(error.message || 'Payment is unavailable', 'error'); pay.disabled = false; }
        return;
      }

      const cancelOrder = closest('[data-sf-cancel-order]');
      if (cancelOrder) {
        event.preventDefault();
        if (!window.confirm('Cancel this booking? This cannot be undone.')) return;
        try { await api.post(`/orders/${encodeURIComponent(cancelOrder.dataset.sfCancelOrder)}/cancel`, {}); toast('Booking cancelled', 'success'); window.SadikPages.reload(); }
        catch (error) { toast(error.message, 'error'); }
        return;
      }

      const flightSelect = closest('[data-sf-flight-select]');
      if (flightSelect) {
        event.preventDefault();
        toast('Our flight desk will confirm this fare with you', 'success');
        window.SadikPages.navigate('/support');
      }
    });

    document.addEventListener('submit', async (event) => {
      const form = event.target;

      if (form.matches('[data-sf-filter-form]')) {
        event.preventDefault();
        const data = new FormData(form);
        const url = new URL(location.href);
        url.search = '';
        for (const [key, value] of data.entries()) if (String(value).trim()) url.searchParams.set(key, String(value).trim());
        window.SadikPages.navigate(`${url.pathname}${url.search}`);
        return;
      }

      if (form.matches('[data-sf-coupon-form]')) {
        event.preventDefault();
        const code = new FormData(form).get('code');
        try { const result = await api.post('/cart/coupon', { code: String(code || '').trim() }); toast(result.message || 'Coupon updated', 'success'); await paintCart(document); }
        catch (error) { toast(error.message || 'Coupon could not be applied', 'error'); }
        return;
      }

      if (form.id === 'sfFlightForm') {
        event.preventDefault();
        const data = new FormData(form);
        const url = new URL(location.origin + '/flights');
        url.searchParams.set('trip', form.dataset.trip || 'oneway');
        ['from', 'to', 'departure', 'return', 'adults', 'children', 'infants', 'cabin'].forEach((key) => {
          const value = data.get(key);
          if (value) url.searchParams.set(key, String(value));
        });
        window.SadikPages.navigate(`${url.pathname}${url.search}`);
        return;
      }

      if (form.id === 'sfCheckoutForm') { event.preventDefault(); await submitCheckout(form); return; }

      if (form.id === 'sfTrackForm') { event.preventDefault(); await trackBooking(form); return; }

      if (form.id === 'sfTicketForm') {
        event.preventDefault();
        const data = Object.fromEntries(new FormData(form).entries());
        const box = document.getElementById('sfTicketResult');
        try {
          const result = await api.post('/support/tickets', { name: data.name, mobile: data.mobile, email: data.email, subject: data.subject });
          box.innerHTML = `<div class="sf-state sf-success"><strong>Ticket created</strong><p>Reference ${esc(result.ticket.id)}. Our team replies by email and SMS.</p></div>`;
          form.reset();
          toast('Support ticket created', 'success');
        } catch (error) { box.innerHTML = errorState(error.message); }
        return;
      }

      if (form.id === 'sfReviewForm') {
        event.preventDefault();
        const data = new FormData(form);
        const button = form.querySelector('button[type="submit"]');
        button.disabled = true;
        try {
          const result = await api.post('/reviews', {
            productType: form.dataset.productType, productId: form.dataset.productId, productTitle: form.dataset.productTitle,
            rating: Number(data.get('rating')), title: String(data.get('title') || '').trim() || undefined, body: String(data.get('body') || '').trim()
          });
          toast(result.message || 'Review submitted', 'success');
          form.reset();
        } catch (error) { toast(error.message || 'Review could not be submitted', 'error'); }
        finally { button.disabled = false; }
        return;
      }

      if (form.id === 'sfTravelerForm') {
        event.preventDefault();
        const data = Object.fromEntries(new FormData(form).entries());
        try {
          await api.post('/account/travelers', {
            fullName: String(data.fullName || '').trim(), dateOfBirth: data.dateOfBirth || undefined,
            gender: data.gender || undefined, nationality: data.nationality || undefined,
            passportNumber: data.passportNumber || undefined, passportExpiry: data.passportExpiry || undefined, isPrimary: false
          });
          toast('Traveller saved', 'success');
          window.SadikPages.reload();
        } catch (error) { toast(error.message, 'error'); }
        return;
      }

      if (form.id === 'sfProfileForm') {
        event.preventDefault();
        const data = new FormData(form);
        try {
          const result = await api.request('/account/profile', { method: 'PATCH', body: JSON.stringify({ fullName: String(data.get('fullName') || '').trim() }) });
          state.user = result.user || state.user;
          toast('Profile updated', 'success');
        } catch (error) { toast(error.message || 'Profile update failed', 'error'); }
        return;
      }

      if (form.id === 'sfPrefForm') {
        event.preventDefault();
        const data = new FormData(form);
        try {
          await api.request('/account/preferences', { method: 'PATCH', body: JSON.stringify({
            marketingEmailOptIn: data.get('marketingEmailOptIn') === 'on',
            marketingSmsOptIn: data.get('marketingSmsOptIn') === 'on',
            marketingInAppOptIn: data.get('marketingInAppOptIn') === 'on'
          }) });
          toast('Preferences updated', 'success');
        } catch (error) { toast(error.message, 'error'); }
        return;
      }

      if (form.id === 'sfVisaForm') {
        event.preventDefault();
        const data = Object.fromEntries(new FormData(form).entries());
        const button = form.querySelector('button[type="submit"]');
        button.disabled = true;
        try {
          const result = await api.post('/visa/applications', {
            productId: form.dataset.product,
            applicant: { fullName: data.fullName, email: data.email, phone: data.phone, dateOfBirth: data.dateOfBirth || undefined, nationality: data.nationality || undefined, address: data.address || undefined },
            passport: { number: data.passportNumber, issueDate: data.issueDate || undefined, expiryDate: data.expiryDate || undefined, issuingCountry: data.issuingCountry || undefined },
            documents: [], travelDate: data.travelDate || undefined
          });
          toast(`Application ${result.application.referenceNumber} submitted`, 'success');
          window.SadikPages.navigate('/account?tab=bookings');
        } catch (error) { toast(error.message || 'Submission failed', 'error'); button.disabled = false; }
      }
    });

    document.addEventListener('change', (event) => {
      if (event.target.matches('[data-sf-sort]')) {
        const url = new URL(location.href);
        url.searchParams.set('sort', event.target.value);
        url.searchParams.delete('page');
        window.SadikPages.navigate(`${url.pathname}${url.search}`);
      }
    });
  }

  /* ----------------------------------------------------------- public API */
  window.SadikPages = {
    routes,
    state,
    /** Called by app.js: returns true when this module owns and rendered the route. */
    async resolve(root, route) {
      const handler = routes[route.parts[0]];
      if (!handler) return false;
      await handler(root, route);
      return true;
    },
    setUser(user) {
      const previous = state.user?.id || '';
      state.user = user || null;
      void refreshBadges();
      // Auth resolves after the first paint. Re-render account-only routes so a
      // direct link or refresh never leaves the customer on the login prompt.
      const first = (location.pathname.split('/').filter(Boolean)[0] || '');
      if (previous !== (state.user?.id || '') && AUTH_ROUTES.has(first)) this.reload();
    },
    navigate(href) { if (typeof window.publicNavigate === 'function') window.publicNavigate(href); else window.location.href = href; },
    reload() { if (typeof window.renderPublicRoute === 'function') void window.renderPublicRoute(); },
    refreshBadges,
    hydrateHomeSections,
    productCard,
    money,
    escapeHtml: esc
  };

  bindGlobalEvents();
  state.booted = true;
})();
