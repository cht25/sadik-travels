/* =====================================================================
   Sadik Travels admin — commerce & catalogue module
   ---------------------------------------------------------------------
   Adds Catalogue, Orders, Coupons, Reviews and Visa Application
   management to the existing admin console. Registers itself with
   window.AdminCommerce; admin.js dispatches matching routes here.

   Every action calls a permission-guarded API. The UI hides what an
   admin cannot do, and the server independently enforces it.
   ===================================================================== */
(() => {
  'use strict';

  const request = (path, options) => window.SadikApi.request(path, options);
  const q = (selector, scope = document) => scope.querySelector(selector);
  const qa = (selector, scope = document) => [...scope.querySelectorAll(selector)];
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const attr = (value) => esc(value).replace(/`/g, '&#96;');
  const money = (value) => `৳${Number(value || 0).toLocaleString('en-BD', { maximumFractionDigits: 0 })}`;
  const titleCase = (value) => String(value || '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const day = (value) => (value ? new Date(value).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
  const dayTime = (value) => (value ? new Date(value).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
  const notify = (message, type) => window.toast?.(message, type);
  const outlet = () => document.getElementById('adminOutlet');
  const refresh = () => window.renderRoute?.();
  const pill = (status) => window.statusPill ? window.statusPill(status) : `<span class="status-pill">${esc(titleCase(status))}</span>`;
  const header = (eyebrow, title, description, actions = '') => (window.pageHeader ? window.pageHeader(eyebrow, title, description, actions)
    : `<header class="admin-page-header"><div><span>${esc(eyebrow)}</span><h1>${esc(title)}</h1><p>${esc(description)}</p></div><div>${actions}</div></header>`);

  const permissions = { fine: new Set(), isSuper: false, loaded: false };
  async function loadPermissions() {
    if (permissions.loaded) return permissions;
    try {
      const me = await request('/admin/me');
      permissions.fine = new Set(me.finePermissions || []);
      permissions.isSuper = me.isSuperAdmin === true || me.user?.role === 'super_admin';
    } catch { /* the shell handles auth errors */ }
    permissions.loaded = true;
    return permissions;
  }
  const can = (key) => permissions.isSuper || permissions.fine.has(key);

  const route = () => {
    const url = new URL(location.href);
    return { path: url.pathname.replace(/^\/admin\/?/, '').replace(/\/+$/, ''), query: url.searchParams };
  };
  const go = (href) => (window.navigate ? window.navigate(href) : (location.href = href));

  const empty = (title, message, action = '') => `<div class="admin-card"><div class="admin-empty"><strong>${esc(title)}</strong><p>${esc(message)}</p>${action}</div></div>`;
  const tableWrap = (inner) => `<div class="admin-card"><div class="table-scroll"><table class="admin-table">${inner}</table></div></div>`;

  function pager(result, base) {
    if (!result || result.pageCount <= 1) return '';
    return `<div class="admin-pagination">
      <button class="admin-secondary" data-ac-page="${result.page - 1}" data-ac-base="${attr(base)}" ${result.page <= 1 ? 'disabled' : ''}>Previous</button>
      <span>Page ${result.page} of ${result.pageCount} · ${result.total} records</span>
      <button class="admin-secondary" data-ac-page="${result.page + 1}" data-ac-base="${attr(base)}" ${result.page >= result.pageCount ? 'disabled' : ''}>Next</button>
    </div>`;
  }

  const CATALOG_TYPES = [
    ['esim', 'eSIM plan'], ['umrah_package', 'Umrah package'], ['umrah_fare', 'Special Umrah fare'],
    ['holiday_package', 'Holiday package'], ['medical_tourism', 'Medical tourism'], ['visa_service', 'Visa service'],
    ['home', 'Home / apartment'], ['card_offer', 'Card offer'], ['airline_offer', 'Airline offer'],
    ['destination', 'Destination'], ['flight_offer', 'Flight offer'], ['accessory', 'Travel accessory']
  ];

  /* ============================================================ CATALOGUE */
  async function renderCatalog() {
    await loadPermissions();
    const current = route();
    const type = current.query.get('type') || '';
    const status = current.query.get('status') || '';
    const search = current.query.get('q') || '';
    const page = Number(current.query.get('page') || 1);
    const params = new URLSearchParams({ page: String(page), pageSize: '20' });
    if (type) params.set('type', type);
    if (status) params.set('status', status);
    if (search) params.set('q', search);

    const [result, stats] = await Promise.all([
      request(`/admin/catalog?${params}`),
      request('/admin/catalog/stats').catch(() => ({ stats: {} }))
    ]);

    const typeStats = stats.stats || {};
    outlet().innerHTML = header('Catalogue', type ? titleCase(type) : 'All products',
      'Every eSIM, package, visa service, home, offer and destination sold on the website is managed here.',
      `${can('catalog.create') ? '<button class="admin-primary" data-ac-new-product>+ New product</button>' : ''}<button class="admin-secondary" data-ac-refresh>Refresh</button>`)
      + `<div class="admin-card">
          <form class="admin-filter-row" id="acCatalogFilter">
            <input name="q" placeholder="Search title, destination, airline…" value="${attr(search)}" />
            <select name="type"><option value="">All types</option>${CATALOG_TYPES.map(([value, label]) => `<option value="${value}" ${type === value ? 'selected' : ''}>${label}</option>`).join('')}</select>
            <select name="status"><option value="">All statuses</option>${['draft', 'published', 'archived'].map((value) => `<option value="${value}" ${status === value ? 'selected' : ''}>${titleCase(value)}</option>`).join('')}</select>
            <button class="admin-primary" type="submit">Apply</button>
          </form>
          <div class="ac-stat-row">${CATALOG_TYPES.filter(([value]) => typeStats[value]).map(([value, label]) => `
            <a class="ac-stat" href="/admin/catalog?type=${value}" data-route="/admin/catalog?type=${value}">
              <strong>${typeStats[value].total}</strong><span>${esc(label)}</span><small>${typeStats[value].published} published</small>
            </a>`).join('') || '<p class="admin-muted">No products yet. Create the first one to populate the website.</p>'}</div>
        </div>`
      + (result.products.length ? tableWrap(`
          <thead><tr><th>Product</th><th>Type</th><th>Price</th><th>Status</th><th>Updated</th><th></th></tr></thead>
          <tbody>${result.products.map((product) => `
            <tr>
              <td>
                <div class="ac-product-cell">
                  <div class="ac-thumb">${product.heroImage?.url || product.images?.[0]?.url ? `<img src="${attr(product.heroImage?.url || product.images[0].url)}" alt="" />` : ''}</div>
                  <div><strong>${esc(product.title)}</strong><small>${esc(product.destination || product.country || product.slug)}</small></div>
                </div>
              </td>
              <td>${esc(titleCase(product.type))}</td>
              <td>${product.price ? money(product.price) : '<span class="admin-muted">On request</span>'}</td>
              <td>${pill(product.status)}${product.featured ? ' <span class="status-pill">Featured</span>' : ''}</td>
              <td>${day(product.updatedAt)}</td>
              <td class="ac-row-actions">
                ${can('catalog.update') ? `<button class="table-action" data-ac-edit="${attr(product.id)}">Edit</button>` : ''}
                ${can('catalog.update') ? `<button class="table-action" data-ac-toggle="${attr(product.id)}" data-status="${product.status === 'published' ? 'draft' : 'published'}">${product.status === 'published' ? 'Unpublish' : 'Publish'}</button>` : ''}
                ${can('catalog.delete') ? `<button class="table-action danger" data-ac-archive="${attr(product.id)}">Archive</button>` : ''}
              </td>
            </tr>`).join('')}</tbody>`) + pager(result, `/admin/catalog?${params}`)
        : empty('No products found', 'Adjust the filters or create a new product to publish it on the website.',
            can('catalog.create') ? '<button class="admin-primary" data-ac-new-product>+ New product</button>' : ''));

    bindCatalogPage(result.products);
  }

  function bindCatalogPage(products) {
    q('#acCatalogFilter')?.addEventListener('submit', (event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const params = new URLSearchParams();
      for (const [key, value] of data.entries()) if (value) params.set(key, String(value));
      go(`/admin/catalog?${params}`);
    });
    qa('[data-ac-new-product]').forEach((button) => button.addEventListener('click', () => openProductEditor()));
    qa('[data-ac-edit]').forEach((button) => button.addEventListener('click', () => openProductEditor(products.find((item) => item.id === button.dataset.acEdit))));
    qa('[data-ac-toggle]').forEach((button) => button.addEventListener('click', async () => {
      button.disabled = true;
      try { await request(`/admin/catalog/${button.dataset.acToggle}`, { method: 'PATCH', body: JSON.stringify({ status: button.dataset.status }) }); notify(`Product ${button.dataset.status === 'published' ? 'published' : 'moved to draft'}`, 'success'); refresh(); }
      catch (error) { notify(error.message || 'Update failed', 'error'); button.disabled = false; }
    }));
    qa('[data-ac-archive]').forEach((button) => button.addEventListener('click', async () => {
      const confirmed = window.confirmAction ? await window.confirmAction('Archive product?', 'The product is hidden from the website but kept for reporting.', 'Archive') : window.confirm('Archive this product?');
      if (!confirmed) return;
      try { await request(`/admin/catalog/${button.dataset.acArchive}`, { method: 'DELETE' }); notify('Product archived', 'success'); refresh(); }
      catch (error) { notify(error.message || 'Archive failed', 'error'); }
    }));
  }

  const field = (label, name, value = '', options = {}) => `
    <label class="admin-field ${options.wide ? 'admin-field-wide' : ''}">
      <span>${esc(label)}</span>
      ${options.textarea
        ? `<textarea name="${name}" rows="${options.rows || 3}" placeholder="${attr(options.placeholder || '')}">${esc(value)}</textarea>`
        : options.select
          ? `<select name="${name}">${options.select.map(([optionValue, optionLabel]) => `<option value="${attr(optionValue)}" ${String(value) === String(optionValue) ? 'selected' : ''}>${esc(optionLabel)}</option>`).join('')}</select>`
          : `<input name="${name}" type="${options.type || 'text'}" value="${attr(value)}" placeholder="${attr(options.placeholder || '')}" ${options.required ? 'required' : ''} ${options.step ? `step="${options.step}"` : ''} />`}
      ${options.hint ? `<small>${esc(options.hint)}</small>` : ''}
    </label>`;

  const listField = (label, name, values = [], hint = '') => field(label, name, (values || []).join('\n'), { textarea: true, rows: 3, hint: hint || 'One entry per line' });

  function openProductEditor(product) {
    const editing = Boolean(product);
    const type = product?.type || 'holiday_package';
    const markup = `
      <form class="admin-modal-form ac-editor" id="acProductForm" data-id="${attr(product?.id || '')}">
        <h2>${editing ? 'Edit product' : 'New catalogue product'}</h2>
        <div class="admin-form-grid">
          ${field('Product type *', 'type', type, { select: CATALOG_TYPES })}
          ${field('Status', 'status', product?.status || 'draft', { select: [['draft', 'Draft'], ['published', 'Published'], ['archived', 'Archived']] })}
          ${field('Title *', 'title', product?.title || '', { required: true, wide: true })}
          ${field('URL slug *', 'slug', product?.slug || '', { required: true, hint: 'lowercase-with-hyphens' })}
          ${field('Subtitle', 'subtitle', product?.subtitle || '')}
          ${field('Card summary', 'summary', product?.summary || '', { textarea: true, rows: 2, wide: true })}
          ${field('Full description', 'description', product?.description || '', { textarea: true, rows: 5, wide: true })}
          ${field('Hero image URL', 'heroImage', product?.heroImage?.url || '', { wide: true, hint: 'Upload in Media Library, then paste the Cloudinary URL' })}
          ${field('Gallery image URLs', 'images', (product?.images || []).map((image) => image.url).join('\n'), { textarea: true, rows: 3, wide: true, hint: 'One URL per line' })}
          ${field('Country', 'country', product?.country || '')}
          ${field('City', 'city', product?.city || '')}
          ${field('Destination', 'destination', product?.destination || '')}
          ${field('Price (৳)', 'price', product?.price ?? 0, { type: 'number', step: '1' })}
          ${field('Original price (৳)', 'originalPrice', product?.originalPrice ?? '', { type: 'number', step: '1', hint: 'Shown struck through' })}
          ${field('Service charge (৳)', 'serviceCharge', product?.serviceCharge ?? 0, { type: 'number', step: '1' })}
          ${field('Tax %', 'taxPct', product?.taxPct ?? 0, { type: 'number', step: '0.01' })}
          ${field('Availability', 'availability', product?.availability ?? 100, { type: 'number' })}
          ${field('Sort order', 'sortOrder', product?.sortOrder ?? 0, { type: 'number' })}
          ${field('Duration (days)', 'durationDays', product?.durationDays ?? '', { type: 'number' })}
          ${field('Duration (nights)', 'durationNights', product?.durationNights ?? '', { type: 'number' })}
          ${field('Data amount', 'dataAmount', product?.dataAmount || '', { hint: 'eSIM, e.g. 5 GB' })}
          ${field('Validity (days)', 'validityDays', product?.validityDays ?? '', { type: 'number' })}
          ${field('Network', 'network', product?.network || '')}
          ${field('Activation', 'activation', product?.activation || '')}
          ${field('Visa type', 'visaType', product?.visaType || '')}
          ${field('Processing time', 'processingTime', product?.processingTime || '')}
          ${field('Entry type', 'entryType', product?.entryType || '')}
          ${field('Hospital', 'hospital', product?.hospital || '')}
          ${field('Treatment category', 'treatmentCategory', product?.treatmentCategory || '')}
          ${field('Doctor / service', 'doctor', product?.doctor || '')}
          ${field('Estimated cost', 'estimatedCost', product?.estimatedCost || '')}
          ${field('Property type', 'propertyType', product?.propertyType || '')}
          ${field('Guests', 'guests', product?.guests ?? '', { type: 'number' })}
          ${field('Bedrooms', 'bedrooms', product?.bedrooms ?? '', { type: 'number' })}
          ${field('Beds', 'beds', product?.beds ?? '', { type: 'number' })}
          ${field('Bathrooms', 'bathrooms', product?.bathrooms ?? '', { type: 'number' })}
          ${field('Bank', 'bank', product?.bank || '')}
          ${field('Card name', 'cardName', product?.cardName || '')}
          ${field('Airline', 'airline', product?.airline || '')}
          ${field('Route', 'route', product?.route || '')}
          ${field('Promo code', 'promoCode', product?.promoCode || '')}
          ${field('Discount label', 'discountLabel', product?.discountLabel || '')}
          ${field('Valid from', 'startDate', product?.startDate || '', { type: 'date' })}
          ${field('Valid until', 'endDate', product?.endDate || '', { type: 'date' })}
          ${listField('Inclusions', 'inclusions', product?.inclusions)}
          ${listField('Exclusions', 'exclusions', product?.exclusions)}
          ${listField('Required documents', 'requiredDocuments', product?.requiredDocuments)}
          ${listField('Amenities', 'amenities', product?.amenities)}
          ${listField('Coverage', 'coverage', product?.coverage)}
          ${listField('Tags', 'tags', product?.tags)}
          ${field('Itinerary', 'itinerary', (product?.itinerary || []).map((item) => `${item.day}|${item.title}|${item.detail || ''}`).join('\n'), { textarea: true, rows: 4, wide: true, hint: 'One line per day: day|title|detail' })}
          ${field('Hotel information', 'hotelInfo', product?.hotelInfo || '', { textarea: true, rows: 2, wide: true })}
          ${field('Transport information', 'transportInfo', product?.transportInfo || '', { textarea: true, rows: 2, wide: true })}
          ${field('Guide information', 'guideInfo', product?.guideInfo || '', { textarea: true, rows: 2, wide: true })}
          ${field('Terms & conditions', 'terms', product?.terms || '', { textarea: true, rows: 3, wide: true })}
          <label class="admin-field"><span>Options</span>
            <span class="ac-checks">
              <label><input type="checkbox" name="featured" ${product?.featured ? 'checked' : ''} /> Featured</label>
              <label><input type="checkbox" name="bookable" ${product?.bookable !== false ? 'checked' : ''} /> Bookable online</label>
            </span>
          </label>
        </div>
        <div class="admin-modal-actions">
          <button type="button" class="admin-secondary" data-close-modal>Cancel</button>
          <button type="submit" class="admin-primary">${editing ? 'Save product' : 'Create product'}</button>
        </div>
      </form>`;

    window.openModal(markup, () => {
      q('#acProductForm').addEventListener('submit', async (event) => {
        event.preventDefault();
        const button = event.submitter;
        window.setLoading?.(button, true, 'Saving…');
        try {
          const payload = readProductForm(event.currentTarget);
          const id = event.currentTarget.dataset.id;
          await request(id ? `/admin/catalog/${id}` : '/admin/catalog', { method: id ? 'PATCH' : 'POST', body: JSON.stringify(payload) });
          window.closeModal();
          notify(id ? 'Product updated successfully' : 'Product created successfully', 'success');
          refresh();
        } catch (error) {
          notify(error.message || 'Could not save the product', 'error');
        } finally { window.setLoading?.(button, false); }
      });
    });
  }

  function readProductForm(form) {
    const data = new FormData(form);
    const text = (name) => String(data.get(name) || '').trim();
    const number = (name) => { const value = String(data.get(name) || '').trim(); return value === '' ? undefined : Number(value); };
    const lines = (name) => text(name).split('\n').map((line) => line.trim()).filter(Boolean);
    const payload = {
      type: text('type'), slug: text('slug'), title: text('title'),
      subtitle: text('subtitle') || undefined, summary: text('summary') || undefined, description: text('description') || undefined,
      country: text('country') || undefined, city: text('city') || undefined, destination: text('destination') || undefined,
      heroImage: text('heroImage') ? { url: text('heroImage') } : undefined,
      images: lines('images').map((url) => ({ url })),
      price: number('price') ?? 0, originalPrice: number('originalPrice'),
      serviceCharge: number('serviceCharge') ?? 0, taxPct: number('taxPct') ?? 0,
      availability: number('availability') ?? 100, sortOrder: number('sortOrder') ?? 0,
      durationDays: number('durationDays'), durationNights: number('durationNights'),
      dataAmount: text('dataAmount') || undefined, validityDays: number('validityDays'),
      network: text('network') || undefined, activation: text('activation') || undefined,
      visaType: text('visaType') || undefined, processingTime: text('processingTime') || undefined, entryType: text('entryType') || undefined,
      hospital: text('hospital') || undefined, treatmentCategory: text('treatmentCategory') || undefined,
      doctor: text('doctor') || undefined, estimatedCost: text('estimatedCost') || undefined,
      propertyType: text('propertyType') || undefined, guests: number('guests'), bedrooms: number('bedrooms'),
      beds: number('beds'), bathrooms: number('bathrooms'),
      bank: text('bank') || undefined, cardName: text('cardName') || undefined, airline: text('airline') || undefined,
      route: text('route') || undefined, promoCode: text('promoCode') || undefined, discountLabel: text('discountLabel') || undefined,
      startDate: text('startDate') || undefined, endDate: text('endDate') || undefined, terms: text('terms') || undefined,
      inclusions: lines('inclusions'), exclusions: lines('exclusions'), requiredDocuments: lines('requiredDocuments'),
      amenities: lines('amenities'), coverage: lines('coverage'), tags: lines('tags'),
      hotelInfo: text('hotelInfo') || undefined, transportInfo: text('transportInfo') || undefined, guideInfo: text('guideInfo') || undefined,
      itinerary: lines('itinerary').map((line) => { const [dayNumber, title, detail] = line.split('|'); return { day: Number(dayNumber) || 1, title: (title || '').trim(), detail: (detail || '').trim() || undefined }; }).filter((item) => item.title),
      featured: data.get('featured') === 'on', bookable: data.get('bookable') === 'on',
      status: text('status') || 'draft'
    };
    Object.keys(payload).forEach((key) => { if (payload[key] === undefined) delete payload[key]; });
    return payload;
  }

  /* =============================================================== ORDERS */
  async function renderOrders() {
    await loadPermissions();
    const current = route();
    const params = new URLSearchParams({ page: current.query.get('page') || '1', pageSize: '20' });
    ['q', 'status', 'paymentStatus', 'type'].forEach((key) => { if (current.query.get(key)) params.set(key, current.query.get(key)); });
    const [result, statsResponse] = await Promise.all([
      request(`/admin/orders?${params}`),
      request('/admin/orders/stats').catch(() => ({ stats: null }))
    ]);
    const stats = statsResponse.stats;

    outlet().innerHTML = header('E-commerce', 'Orders & bookings', 'Every checkout from the website: packages, eSIM, homes, visa services and offers.', '<button class="admin-secondary" data-ac-refresh>Refresh</button>')
      + (stats ? `<div class="ac-stat-row">
          <div class="ac-stat"><strong>${stats.orders}</strong><span>Total orders</span></div>
          <div class="ac-stat"><strong>${money(stats.revenue)}</strong><span>Paid revenue</span></div>
          ${stats.byStatus.slice(0, 4).map((row) => `<div class="ac-stat"><strong>${row.count}</strong><span>${esc(titleCase(row.status))}</span></div>`).join('')}
        </div>` : '')
      + `<div class="admin-card"><form class="admin-filter-row" id="acOrderFilter">
          <input name="q" placeholder="Order number, customer, email…" value="${attr(current.query.get('q') || '')}" />
          <select name="status"><option value="">All statuses</option>${['pending', 'confirmed', 'processing', 'completed', 'cancelled', 'refunded', 'failed'].map((value) => `<option value="${value}" ${current.query.get('status') === value ? 'selected' : ''}>${titleCase(value)}</option>`).join('')}</select>
          <select name="paymentStatus"><option value="">All payments</option>${['pending', 'processing', 'paid', 'failed', 'refunded'].map((value) => `<option value="${value}" ${current.query.get('paymentStatus') === value ? 'selected' : ''}>${titleCase(value)}</option>`).join('')}</select>
          <button class="admin-primary" type="submit">Apply</button>
        </form></div>`
      + (result.orders.length ? tableWrap(`
          <thead><tr><th>Order</th><th>Customer</th><th>Items</th><th>Total</th><th>Payment</th><th>Status</th><th>Created</th><th></th></tr></thead>
          <tbody>${result.orders.map((order) => `
            <tr>
              <td><strong>${esc(order.orderNumber)}</strong><small>${esc(titleCase(order.primaryType))}</small></td>
              <td>${esc(order.customer?.fullName || order.customer?.email || '—')}<small>${esc(order.contactEmail || '')}</small></td>
              <td>${order.items.length} item${order.items.length === 1 ? '' : 's'}<small>${esc(order.items[0]?.title || '')}</small></td>
              <td><strong>${money(order.total)}</strong></td>
              <td>${pill(order.paymentStatus)}</td>
              <td>${pill(order.status)}</td>
              <td>${day(order.createdAt)}</td>
              <td><a class="table-action" href="/admin/orders/${attr(order.id)}" data-route="/admin/orders/${attr(order.id)}">Open</a></td>
            </tr>`).join('')}</tbody>`) + pager(result, `/admin/orders?${params}`)
        : empty('No orders yet', 'Orders placed on the website appear here in real time.'));

    q('#acOrderFilter')?.addEventListener('submit', (event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const next = new URLSearchParams();
      for (const [key, value] of data.entries()) if (value) next.set(key, String(value));
      go(`/admin/orders?${next}`);
    });
  }

  async function renderOrderDetail(id) {
    await loadPermissions();
    const { order, customer, invoice } = await request(`/admin/orders/${id}`);
    outlet().innerHTML = header('Order', order.orderNumber, `Placed ${dayTime(order.createdAt)} · ${titleCase(order.primaryType)}`,
      '<a class="admin-secondary" href="/admin/orders" data-route="/admin/orders">Back to orders</a>')
      + `<div class="ac-detail-grid">
          <div class="admin-card">
            <h3>Items</h3>
            <table class="admin-table"><tbody>${order.items.map((item) => `<tr><td><strong>${esc(item.title)}</strong><small>${esc(titleCase(item.productType))} · qty ${item.quantity}</small></td><td style="text-align:right">${money(item.lineTotal)}</td></tr>`).join('')}</tbody></table>
            <div class="ac-totals">
              <div><span>Subtotal</span><span>${money(order.subtotal)}</span></div>
              ${order.couponDiscount ? `<div><span>Coupon ${esc(order.couponCode || '')}</span><span>−${money(order.couponDiscount)}</span></div>` : ''}
              ${order.tax ? `<div><span>Tax</span><span>${money(order.tax)}</span></div>` : ''}
              ${order.serviceFee ? `<div><span>Service fee</span><span>${money(order.serviceFee)}</span></div>` : ''}
              <div class="ac-total"><span>Total</span><span>${money(order.total)}</span></div>
            </div>
          </div>
          <div class="admin-card">
            <h3>Customer</h3>
            <dl class="ac-dl">
              <div><dt>Name</dt><dd>${esc(order.customer?.fullName || '—')}</dd></div>
              <div><dt>Email</dt><dd>${esc(order.customer?.email || '—')}</dd></div>
              <div><dt>Phone</dt><dd>${esc(order.customer?.phone || '—')}</dd></div>
              <div><dt>Account</dt><dd>${customer ? esc(customer.email || customer.phone || customer.id) : 'Guest'}</dd></div>
              <div><dt>Travel date</dt><dd>${day(order.travelDate)}</dd></div>
              <div><dt>Payment method</dt><dd>${esc(titleCase(order.paymentMethod || 'online'))}</dd></div>
              ${invoice ? `<div><dt>Invoice</dt><dd>${esc(invoice.invoiceNumber)}</dd></div>` : ''}
            </dl>
            ${order.travelers?.length ? `<h3 style="margin-top:16px">Travellers</h3><ul class="ac-plain-list">${order.travelers.map((traveler) => `<li><strong>${esc(traveler.fullName)}</strong> ${esc([traveler.nationality, traveler.passportNumber ? `Passport ${traveler.passportNumber}` : ''].filter(Boolean).join(' · '))}</li>`).join('')}</ul>` : ''}
            ${order.notes ? `<h3 style="margin-top:16px">Customer note</h3><p class="admin-muted">${esc(order.notes)}</p>` : ''}
          </div>
          <div class="admin-card">
            <h3>Manage</h3>
            <form id="acOrderForm" class="admin-form-grid">
              ${field('Booking status', 'status', order.status, { select: [['pending', 'Pending'], ['confirmed', 'Confirmed'], ['processing', 'Processing'], ['completed', 'Completed'], ['cancelled', 'Cancelled'], ['refunded', 'Refunded'], ['failed', 'Failed']] })}
              ${field('Payment status', 'paymentStatus', order.paymentStatus, { select: [['pending', 'Pending'], ['processing', 'Processing'], ['paid', 'Paid'], ['failed', 'Failed'], ['refunded', 'Refunded'], ['cancelled', 'Cancelled']] })}
              ${field('Internal note', 'note', '', { textarea: true, rows: 2, wide: true })}
              <div class="admin-modal-actions" style="grid-column:1/-1">
                <button class="admin-primary" type="submit" ${can('order.update') ? '' : 'disabled title="Permission required: order.update"'}>Save changes</button>
              </div>
            </form>
            <h3 style="margin-top:18px">Timeline</h3>
            <ol class="ac-timeline">${(order.timeline || []).map((entry) => `<li><strong>${esc(titleCase(entry.status))}</strong>${entry.note ? `<p>${esc(entry.note)}</p>` : ''}<small>${dayTime(entry.at)}</small></li>`).join('')}</ol>
          </div>
        </div>`;

    q('#acOrderForm')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = event.submitter;
      const data = new FormData(event.currentTarget);
      window.setLoading?.(button, true, 'Saving…');
      try {
        await request(`/admin/orders/${order.id}`, { method: 'PATCH', body: JSON.stringify({
          status: data.get('status'), paymentStatus: data.get('paymentStatus'), note: String(data.get('note') || '').trim() || undefined
        }) });
        notify('Order updated successfully', 'success');
        refresh();
      } catch (error) { notify(error.message || 'Update failed', 'error'); }
      finally { window.setLoading?.(button, false); }
    });
  }

  /* ============================================================== COUPONS */
  async function renderCoupons() {
    await loadPermissions();
    const current = route();
    const params = new URLSearchParams({ page: current.query.get('page') || '1', pageSize: '20' });
    if (current.query.get('q')) params.set('q', current.query.get('q'));
    if (current.query.get('status')) params.set('status', current.query.get('status'));
    const result = await request(`/admin/coupons?${params}`);

    outlet().innerHTML = header('E-commerce', 'Coupons & promo codes', 'Discount rules are validated on the server at checkout — a coupon can never be forged from the browser.',
      `${can('coupon.create') ? '<button class="admin-primary" data-ac-new-coupon>+ New coupon</button>' : ''}<button class="admin-secondary" data-ac-refresh>Refresh</button>`)
      + `<div class="admin-card"><form class="admin-filter-row" id="acCouponFilter">
          <input name="q" placeholder="Search code" value="${attr(current.query.get('q') || '')}" />
          <select name="status"><option value="">All statuses</option>${['active', 'paused', 'expired'].map((value) => `<option value="${value}" ${current.query.get('status') === value ? 'selected' : ''}>${titleCase(value)}</option>`).join('')}</select>
          <button class="admin-primary" type="submit">Apply</button>
        </form></div>`
      + (result.coupons.length ? tableWrap(`
          <thead><tr><th>Code</th><th>Discount</th><th>Minimum</th><th>Usage</th><th>Valid</th><th>Status</th><th></th></tr></thead>
          <tbody>${result.coupons.map((coupon) => `
            <tr>
              <td><strong>${esc(coupon.code)}</strong><small>${esc(coupon.description || '')}</small></td>
              <td>${coupon.discountType === 'percent' ? `${coupon.value}%` : money(coupon.value)}${coupon.maxDiscount ? `<small>max ${money(coupon.maxDiscount)}</small>` : ''}</td>
              <td>${coupon.minAmount ? money(coupon.minAmount) : '—'}</td>
              <td>${coupon.usedCount}${coupon.usageLimit ? ` / ${coupon.usageLimit}` : ''}<small>${coupon.perUserLimit} per customer</small></td>
              <td>${coupon.startDate ? day(coupon.startDate) : '—'} → ${coupon.endDate ? day(coupon.endDate) : '—'}</td>
              <td>${pill(coupon.status)}</td>
              <td class="ac-row-actions">
                ${can('coupon.update') ? `<button class="table-action" data-ac-coupon-edit="${attr(coupon.id)}">Edit</button>` : ''}
                ${can('coupon.delete') ? `<button class="table-action danger" data-ac-coupon-delete="${attr(coupon.id)}">Delete</button>` : ''}
              </td>
            </tr>`).join('')}</tbody>`) + pager(result, `/admin/coupons?${params}`)
        : empty('No coupons yet', 'Create a coupon to run a campaign. Discounts are applied and verified server side.',
            can('coupon.create') ? '<button class="admin-primary" data-ac-new-coupon>+ New coupon</button>' : ''));

    q('#acCouponFilter')?.addEventListener('submit', (event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const next = new URLSearchParams();
      for (const [key, value] of data.entries()) if (value) next.set(key, String(value));
      go(`/admin/coupons?${next}`);
    });
    qa('[data-ac-new-coupon]').forEach((button) => button.addEventListener('click', () => openCouponEditor()));
    qa('[data-ac-coupon-edit]').forEach((button) => button.addEventListener('click', () => openCouponEditor(result.coupons.find((item) => item.id === button.dataset.acCouponEdit))));
    qa('[data-ac-coupon-delete]').forEach((button) => button.addEventListener('click', async () => {
      const confirmed = window.confirmAction ? await window.confirmAction('Delete coupon?', 'Customers will no longer be able to use this code.', 'Delete') : window.confirm('Delete this coupon?');
      if (!confirmed) return;
      try { await request(`/admin/coupons/${button.dataset.acCouponDelete}`, { method: 'DELETE' }); notify('Coupon deleted', 'success'); refresh(); }
      catch (error) { notify(error.message || 'Delete failed', 'error'); }
    }));
  }

  function openCouponEditor(coupon) {
    const markup = `
      <form class="admin-modal-form" id="acCouponForm" data-id="${attr(coupon?.id || '')}">
        <h2>${coupon ? 'Edit coupon' : 'New coupon'}</h2>
        <div class="admin-form-grid">
          ${field('Code *', 'code', coupon?.code || '', { required: true, hint: 'Letters, numbers, dash and underscore' })}
          ${field('Status', 'status', coupon?.status || 'active', { select: [['active', 'Active'], ['paused', 'Paused'], ['expired', 'Expired']] })}
          ${field('Description', 'description', coupon?.description || '', { wide: true })}
          ${field('Discount type', 'discountType', coupon?.discountType || 'percent', { select: [['percent', 'Percentage'], ['fixed', 'Fixed amount']] })}
          ${field('Value *', 'value', coupon?.value ?? '', { type: 'number', step: '0.01', required: true })}
          ${field('Minimum order (৳)', 'minAmount', coupon?.minAmount ?? 0, { type: 'number' })}
          ${field('Maximum discount (৳)', 'maxDiscount', coupon?.maxDiscount ?? '', { type: 'number' })}
          ${field('Start date', 'startDate', coupon?.startDate ? String(coupon.startDate).slice(0, 10) : '', { type: 'date' })}
          ${field('End date', 'endDate', coupon?.endDate ? String(coupon.endDate).slice(0, 10) : '', { type: 'date' })}
          ${field('Total usage limit', 'usageLimit', coupon?.usageLimit ?? '', { type: 'number' })}
          ${field('Per customer limit', 'perUserLimit', coupon?.perUserLimit ?? 1, { type: 'number' })}
          ${field('Applicable product types', 'applicableTypes', (coupon?.applicableTypes || []).join('\n'), { textarea: true, rows: 3, wide: true, hint: 'One type per line (esim, umrah_package…). Leave empty for all products.' })}
        </div>
        <div class="admin-modal-actions">
          <button type="button" class="admin-secondary" data-close-modal>Cancel</button>
          <button type="submit" class="admin-primary">${coupon ? 'Save coupon' : 'Create coupon'}</button>
        </div>
      </form>`;
    window.openModal(markup, () => {
      q('#acCouponForm').addEventListener('submit', async (event) => {
        event.preventDefault();
        const button = event.submitter;
        const data = new FormData(event.currentTarget);
        const number = (name) => { const value = String(data.get(name) || '').trim(); return value === '' ? undefined : Number(value); };
        const payload = {
          code: String(data.get('code') || '').trim(), description: String(data.get('description') || '').trim() || undefined,
          discountType: data.get('discountType'), value: number('value'), minAmount: number('minAmount') ?? 0,
          maxDiscount: number('maxDiscount'), startDate: String(data.get('startDate') || '') || undefined,
          endDate: String(data.get('endDate') || '') || undefined, usageLimit: number('usageLimit'),
          perUserLimit: number('perUserLimit') ?? 1,
          applicableTypes: String(data.get('applicableTypes') || '').split('\n').map((line) => line.trim()).filter(Boolean),
          status: data.get('status')
        };
        Object.keys(payload).forEach((key) => { if (payload[key] === undefined) delete payload[key]; });
        window.setLoading?.(button, true, 'Saving…');
        try {
          const id = event.currentTarget.dataset.id;
          await request(id ? `/admin/coupons/${id}` : '/admin/coupons', { method: id ? 'PATCH' : 'POST', body: JSON.stringify(payload) });
          window.closeModal();
          notify(id ? 'Coupon updated' : 'Coupon created successfully', 'success');
          refresh();
        } catch (error) { notify(error.message || 'Could not save coupon', 'error'); }
        finally { window.setLoading?.(button, false); }
      });
    });
  }

  /* ============================================================== REVIEWS */
  async function renderReviews() {
    await loadPermissions();
    const current = route();
    const params = new URLSearchParams({ page: current.query.get('page') || '1', pageSize: '20' });
    if (current.query.get('status')) params.set('status', current.query.get('status'));
    if (current.query.get('q')) params.set('q', current.query.get('q'));
    const result = await request(`/admin/reviews?${params}`);

    outlet().innerHTML = header('Community', 'Reviews & ratings', 'Only customers with a confirmed booking can post. Approve a review to publish it and update the product rating.', '<button class="admin-secondary" data-ac-refresh>Refresh</button>')
      + `<div class="admin-card"><form class="admin-filter-row" id="acReviewFilter">
          <input name="q" placeholder="Search review text" value="${attr(current.query.get('q') || '')}" />
          <select name="status"><option value="">All</option>${['pending', 'approved', 'rejected'].map((value) => `<option value="${value}" ${current.query.get('status') === value ? 'selected' : ''}>${titleCase(value)}</option>`).join('')}</select>
          <button class="admin-primary" type="submit">Apply</button>
        </form></div>`
      + (result.reviews.length ? `<div class="admin-card"><div class="ac-review-list">${result.reviews.map((review) => `
          <article class="ac-review">
            <div class="ac-review-head">
              <div><strong>${esc(review.userName || 'Customer')}</strong><small>${esc(review.productTitle || titleCase(review.productType))} · ${day(review.createdAt)}</small></div>
              <div>${'★'.repeat(review.rating)}${'☆'.repeat(5 - review.rating)} ${pill(review.status)}</div>
            </div>
            ${review.title ? `<h4>${esc(review.title)}</h4>` : ''}
            <p>${esc(review.body)}</p>
            ${review.adminReply ? `<div class="ac-review-reply"><strong>Sadik Travels reply</strong><p>${esc(review.adminReply)}</p></div>` : ''}
            ${can('review.moderate') ? `<div class="ac-row-actions">
              <button class="table-action" data-ac-review="${attr(review.id)}" data-status="approved">Approve</button>
              <button class="table-action" data-ac-review="${attr(review.id)}" data-status="rejected">Reject</button>
              <button class="table-action" data-ac-review-reply="${attr(review.id)}">Reply</button>
              ${can('review.delete') ? `<button class="table-action danger" data-ac-review-delete="${attr(review.id)}">Delete</button>` : ''}
            </div>` : ''}
          </article>`).join('')}</div></div>` + pager(result, `/admin/reviews?${params}`)
        : empty('No reviews yet', 'Reviews appear here when customers rate a completed booking.'));

    q('#acReviewFilter')?.addEventListener('submit', (event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const next = new URLSearchParams();
      for (const [key, value] of data.entries()) if (value) next.set(key, String(value));
      go(`/admin/reviews?${next}`);
    });
    qa('[data-ac-review]').forEach((button) => button.addEventListener('click', async () => {
      button.disabled = true;
      try { await request(`/admin/reviews/${button.dataset.acReview}`, { method: 'PATCH', body: JSON.stringify({ status: button.dataset.status }) }); notify(`Review ${button.dataset.status}`, 'success'); refresh(); }
      catch (error) { notify(error.message || 'Moderation failed', 'error'); button.disabled = false; }
    }));
    qa('[data-ac-review-reply]').forEach((button) => button.addEventListener('click', () => {
      const reply = window.prompt('Public reply to this review');
      if (!reply) return;
      request(`/admin/reviews/${button.dataset.acReviewReply}`, { method: 'PATCH', body: JSON.stringify({ adminReply: reply }) })
        .then(() => { notify('Reply published', 'success'); refresh(); })
        .catch((error) => notify(error.message || 'Reply failed', 'error'));
    }));
    qa('[data-ac-review-delete]').forEach((button) => button.addEventListener('click', async () => {
      const confirmed = window.confirmAction ? await window.confirmAction('Delete review?', 'This permanently removes the review.', 'Delete') : window.confirm('Delete review?');
      if (!confirmed) return;
      try { await request(`/admin/reviews/${button.dataset.acReviewDelete}`, { method: 'DELETE' }); notify('Review deleted', 'success'); refresh(); }
      catch (error) { notify(error.message || 'Delete failed', 'error'); }
    }));
  }

  /* ==================================================== VISA APPLICATIONS */
  async function renderVisaApplications() {
    await loadPermissions();
    const current = route();
    const params = new URLSearchParams({ page: current.query.get('page') || '1', pageSize: '20' });
    if (current.query.get('status')) params.set('status', current.query.get('status'));
    if (current.query.get('q')) params.set('q', current.query.get('q'));
    const result = await request(`/admin/visa-applications?${params}`);

    outlet().innerHTML = header('Services', 'Visa applications', 'Applications submitted from the website with applicant, passport and document details.', '<button class="admin-secondary" data-ac-refresh>Refresh</button>')
      + `<div class="admin-card"><form class="admin-filter-row" id="acVisaFilter">
          <input name="q" placeholder="Search reference" value="${attr(current.query.get('q') || '')}" />
          <select name="status"><option value="">All statuses</option>${['submitted', 'document_review', 'processing', 'approved', 'rejected', 'cancelled'].map((value) => `<option value="${value}" ${current.query.get('status') === value ? 'selected' : ''}>${titleCase(value)}</option>`).join('')}</select>
          <button class="admin-primary" type="submit">Apply</button>
        </form></div>`
      + (result.applications.length ? tableWrap(`
          <thead><tr><th>Reference</th><th>Applicant</th><th>Service</th><th>Passport</th><th>Travel</th><th>Status</th><th>Update</th></tr></thead>
          <tbody>${result.applications.map((application) => `
            <tr>
              <td><strong>${esc(application.referenceNumber)}</strong><small>${day(application.createdAt)}</small></td>
              <td>${esc(application.applicant?.fullName || '—')}<small>${esc(application.applicant?.email || '')}</small></td>
              <td>${esc(application.productTitle || '—')}</td>
              <td>${esc(application.passport?.number ? `••••${String(application.passport.number).slice(-4)}` : '—')}</td>
              <td>${day(application.travelDate)}</td>
              <td>${pill(application.status)}</td>
              <td>
                <select data-ac-visa="${attr(application.id)}" ${can('visa.update') ? '' : 'disabled'}>
                  ${['submitted', 'document_review', 'processing', 'approved', 'rejected', 'cancelled'].map((value) => `<option value="${value}" ${application.status === value ? 'selected' : ''}>${titleCase(value)}</option>`).join('')}
                </select>
              </td>
            </tr>`).join('')}</tbody>`) + pager(result, `/admin/visa-applications?${params}`)
        : empty('No visa applications yet', 'Applications submitted from the Visa Services pages appear here.'));

    q('#acVisaFilter')?.addEventListener('submit', (event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const next = new URLSearchParams();
      for (const [key, value] of data.entries()) if (value) next.set(key, String(value));
      go(`/admin/visa-applications?${next}`);
    });
    qa('[data-ac-visa]').forEach((select) => select.addEventListener('change', async () => {
      select.disabled = true;
      try { await request(`/admin/visa-applications/${select.dataset.acVisa}`, { method: 'PATCH', body: JSON.stringify({ status: select.value }) }); notify('Application updated', 'success'); refresh(); }
      catch (error) { notify(error.message || 'Update failed', 'error'); select.disabled = false; }
    }));
  }

  /* ------------------------------------------------------------ dispatch */
  const routes = {
    catalog: renderCatalog,
    orders: renderOrders,
    coupons: renderCoupons,
    reviews: renderReviews,
    'visa-applications': renderVisaApplications
  };

  document.addEventListener('click', (event) => {
    const refreshButton = event.target.closest('[data-ac-refresh]');
    if (refreshButton) { event.preventDefault(); refresh(); return; }
    const pageButton = event.target.closest('[data-ac-page]');
    if (pageButton && !pageButton.disabled) {
      event.preventDefault();
      const url = new URL(pageButton.dataset.acBase, location.origin);
      url.searchParams.set('page', pageButton.dataset.acPage);
      go(`${url.pathname}${url.search}`);
    }
  });

  window.AdminCommerce = {
    routes,
    resolve(path) {
      if (routes[path]) return routes[path];
      if (path.startsWith('orders/')) return () => renderOrderDetail(path.split('/')[1]);
      return null;
    }
  };
})();
