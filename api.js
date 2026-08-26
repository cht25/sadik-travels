/* Shared same-origin API client for the Sadik Travels website and admin console. */
(() => {
  const bodyConfig = document.body?.dataset || {};
  const config = window.APP_CONFIG || {};
  const baseUrl = String(config.apiBase || bodyConfig.apiBase || '/api/v1').replace(/\/$/, '');
  const requestTimeoutMs = Number(config.requestTimeoutMs || 20000);

  async function request(path, options = {}, canRefresh = true) {
    const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
    const headers = { accept: 'application/json', ...(options.body && !isFormData ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) };
    if (isFormData && headers['content-type']) delete headers['content-type'];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    const requestOptions = { credentials: 'include', ...options, headers, signal: controller.signal };
    const relativePath = path.startsWith(baseUrl) ? path.slice(baseUrl.length) || '/' : (path.startsWith('/') ? path : `/${path}`);
    let response;
    try { response = await fetch(`${baseUrl}${relativePath}`, requestOptions); } catch (error) { if (error?.name === 'AbortError') { const timeoutError = new Error('The request timed out. Please try again.'); timeoutError.code = 'REQUEST_TIMEOUT'; throw timeoutError; } throw new Error('Network error. Please check your connection and try again.'); } finally { clearTimeout(timeout); }
    let payload = {};
    try { payload = await response.json(); } catch { /* empty 204 response */ }
    const skipRefresh = path.includes('/auth/refresh') || path.includes('/auth/logout') || path.includes('/admin/me');
    if (response.status === 401 && canRefresh && !skipRefresh) {
      try { await request('/auth/refresh', { method: 'POST' }, false); return request(path, options, false); } catch { /* keep original auth error */ }
    }
    if (!response.ok) {
      const error = new Error(payload?.error?.message || `Request failed (${response.status})`);
      error.status = response.status;
      error.code = payload?.error?.code;
      error.details = payload?.error?.details;
      throw error;
    }
    return payload;
  }

  window.SadikApi = Object.freeze({ baseUrl, request, get: path => request(path), post: (path, body) => request(path, { method: 'POST', body: JSON.stringify(body) }), patch: (path, body) => request(path, { method: 'PATCH', body: JSON.stringify(body) }), delete: path => request(path, { method: 'DELETE' }) });
})();
