import axios from 'axios';
import { msalInstance, managementRequest, loginRequest } from '../auth/msalConfig';

const api = axios.create({
  baseURL: '/api',
  timeout: 60000,
});

// Token cache — reuse until 2 minutes before expiry
let _cachedToken = null;
let _tokenExpiry = 0;
// In-flight promises so a burst of parallel requests triggers one token fetch,
// and at most one interactive popup, instead of dozens.
let _pending = null;
let _pendingPopup = null;
let _popupBlocked = false;

function store(result, now) {
  _cachedToken = result.accessToken;
  _tokenExpiry = (result.expiresOn?.getTime() || now + 3600_000) - 120_000;
  return _cachedToken;
}

async function acquire(account, interactive) {
  const now = Date.now();
  try {
    return store(await msalInstance.acquireTokenSilent({ ...managementRequest, account }), now);
  } catch (silentErr) {
    // Silent renewal runs in a hidden iframe, which browsers block on reload and
    // under third-party-cookie restrictions (block_iframe_reload / timed_out).
    // A popup recovers the session, but browsers only allow one during a user
    // gesture — so background page loads fail quietly instead of firing popups
    // that are guaranteed to be blocked.
    _cachedToken = null;
    if (!interactive || _popupBlocked) {
      console.warn('Token acquisition failed:', silentErr);
      return null;
    }
    try {
      _pendingPopup = _pendingPopup
        || msalInstance.acquireTokenPopup({ ...managementRequest, account });
      const result = await _pendingPopup;
      return store(result, Date.now());
    } catch (popupErr) {
      if (popupErr?.errorCode === 'popup_window_error') _popupBlocked = true;
      console.warn('Token acquisition failed:', popupErr);
      return null;
    } finally {
      _pendingPopup = null;
    }
  }
}

async function getToken(interactive = false) {
  if (_cachedToken && Date.now() < _tokenExpiry) return _cachedToken;

  const accounts = msalInstance.getAllAccounts();
  const account = msalInstance.getActiveAccount() || accounts[0];
  if (!account) return null;

  if (!_pending) {
    _pending = acquire(account, interactive).finally(() => { _pending = null; });
  }
  return _pending;
}

/**
 * File parsing happens entirely on our own server — it never calls Azure — so
 * those routes only need proof of sign-in. We send the ID token: it is issued
 * for this app (so our backend can verify its signature), and MSAL serves it
 * from cache without the hidden iframe that browsers now block.
 *
 * Never send the Graph access token here — Microsoft signs those so only Graph
 * can validate them, which fails with "Signature verification failed".
 */
async function getSignInToken() {
  const account = msalInstance.getActiveAccount() || msalInstance.getAllAccounts()[0];
  if (!account) return null;
  if (account.idToken) return account.idToken;
  try {
    const result = await msalInstance.acquireTokenSilent({ ...loginRequest, account });
    return result.idToken || null;
  } catch {
    return null;
  }
}

const LOCAL_ROUTES = ['/upload', '/boq'];

// Attach Bearer token to every request
api.interceptors.request.use(async (config) => {
  // These two run off a click, so a sign-in popup here is allowed to open.
  const userInitiated = LOCAL_ROUTES.some((r) => (config.url || '').startsWith(r));
  const token = (userInitiated ? await getSignInToken() : null)
    || (await getToken(userInitiated));
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// ── API functions ──────────────────────────────────────────────────────────

export const fetchTenants = () => api.get('/tenants').then(r => r.data);
export const addTenant = (body) => api.post('/tenants', body).then(r => r.data);
export const deleteTenant = (tenantId) => api.delete(`/tenants/${tenantId}`);

export const fetchSubscriptions = (tenantId) =>
  api.get('/subscriptions', { params: { tenant_id: tenantId } }).then(r => r.data);

export const fetchCosts = (body) =>
  api.post('/costs', body).then(r => r.data);

export const fetchRgCosts = (body) =>
  api.post('/costs/rg', body).then(r => r.data);

export const fetchDailyCosts = (body) =>
  api.post('/costs/daily', body).then(r => r.data);

export const fetchBandwidth = (body) =>
  api.post('/bandwidth', body).then(r => r.data);

export const fetchServices = (tenantId, subscriptionIds) =>
  api.get('/services', {
    params: { tenant_id: tenantId, subscription_ids: subscriptionIds },
    paramsSerializer: { indexes: null },
  }).then(r => r.data);

export const uploadCSV = (file) => {
  const form = new FormData();
  form.append('file', file);
  return api.post('/upload', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  }).then(r => r.data);
};

/** Parse an Azure Pricing Calculator estimate (BOQ) into budget line items. */
export const uploadBoq = (file) => {
  const form = new FormData();
  form.append('file', file);
  return api.post('/boq/parse', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  }).then(r => r.data);
};

/** Recover the Azure resources an estimate describes, without deploying them. */
export const planBoq = (file, resourceGroup) => {
  const form = new FormData();
  form.append('file', file);
  form.append('resource_group', resourceGroup);
  return api.post('/boq/plan', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  }).then(r => r.data);
};

/** Generate a Bicep or Terraform template for the estimate. */
export const generateIac = (file, format, resourceGroup) => {
  const form = new FormData();
  form.append('file', file);
  form.append('format', format);
  form.append('resource_group', resourceGroup);
  return api.post('/boq/generate', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  }).then(r => r.data);
};

/** Chat about the estimate. The parsed BOQ is echoed back so nothing is stored. */
export const chatAboutBoq = (body) =>
  api.post('/boq/chat', body).then(r => r.data);

export default api;
