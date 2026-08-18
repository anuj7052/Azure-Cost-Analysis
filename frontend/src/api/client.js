import axios from 'axios';
import toast from 'react-hot-toast';
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

// Routes our own server answers without ever calling Azure. They only need
// proof of sign-in, so they take the ID token — which MSAL serves from cache
// and therefore keeps working after a reload, when silent renewal of an Azure
// management token is blocked by the browser's iframe restrictions.
const LOCAL_ROUTES = ['/upload', '/boq', '/me', '/admin', '/guide', '/integrations'];

// A sign-in popup may only open off a real click. These two routes run from a
// file picker, so recovering the session there is allowed; the rest load in the
// background and must fail quietly instead of firing a blocked popup.
const GESTURE_ROUTES = ['/upload', '/boq'];

// Attach Bearer token to every request
api.interceptors.request.use(async (config) => {
  const url = config.url || '';
  const localRoute = LOCAL_ROUTES.some((r) => url.startsWith(r));
  const userInitiated = GESTURE_ROUTES.some((r) => url.startsWith(r));
  const token = (localRoute ? await getSignInToken() : null)
    || (await getToken(userInitiated));
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

/**
 * Tell the user when their access has lapsed.
 *
 * An expired credential fails every request at once, so pages just went blank
 * or kept showing cached figures with no explanation. The two causes need
 * different actions, so they get different messages: a pasted session token is
 * replaced in Settings, whereas an expired Microsoft sign-in needs a new login.
 * One alert per burst, since a single page load can fire a dozen requests.
 */
let lastExpiryAlert = 0;

function alertSessionExpired(detail) {
  const now = Date.now();
  if (now - lastExpiryAlert < 15000) return;
  lastExpiryAlert = now;

  const sessionToken = /session token/i.test(detail || '');
  toast.error(
    sessionToken
      ? 'Session token expired — paste a fresh one in Settings to keep reading this tenant.'
      : 'Your sign-in has expired. Sign out and sign in again to continue.',
    { id: 'session-expired', duration: 8000 },
  );
}

api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      // The cached management token is useless now; drop it so the next request
      // tries to renew instead of replaying the dead one.
      _cachedToken = null;
      _tokenExpiry = 0;
      alertSessionExpired(err.response?.data?.detail);
    }
    return Promise.reject(err);
  },
);

// ── API functions ──────────────────────────────────────────────────────────

export const fetchMe = () => api.get('/me').then(r => r.data);

/** Fetches the guide as a blob so the download carries the auth header. */
export const downloadSetupGuide = async () => {
  const res = await api.get('/guide/setup.pdf', { responseType: 'blob' });
  const url = URL.createObjectURL(new Blob([res.data], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'azure-cost-analysis-setup-guide.pdf';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};

export const fetchAdminUsers = (params = {}) =>
  api.get('/admin/users', { params }).then(r => r.data);
export const fetchAdminStats = () => api.get('/admin/stats').then(r => r.data);
export const fetchAdminUser = (id) => api.get(`/admin/users/${id}`).then(r => r.data);
export const updateAdminUser = (id, body) =>
  api.patch(`/admin/users/${id}`, body).then(r => r.data);
export const deleteAdminUser = (id) => api.delete(`/admin/users/${id}`);

// Endpoints the customer brings themselves. The key is write-only: the API
// returns a masked hint, never the value.
export const fetchIntegrations = () => api.get('/integrations').then(r => r.data);
export const createIntegration = (body) => api.post('/integrations', body).then(r => r.data);
export const updateIntegration = (id, body) =>
  api.patch(`/integrations/${id}`, body).then(r => r.data);
export const deleteIntegration = (id) => api.delete(`/integrations/${id}`);

export const fetchTenants = () => api.get('/tenants').then(r => r.data);
export const addTenant = (body) => api.post('/tenants', body).then(r => r.data);
export const addSessionToken = (body) => api.post('/tenants/token', body).then(r => r.data);
export const deleteTenant = (tenantId) => api.delete(`/tenants/${tenantId}`);

export const fetchSubscriptions = (tenantId) =>
  api.get('/subscriptions', { params: { tenant_id: tenantId } }).then(r => r.data);

export const fetchCosts = (body) =>
  api.post('/costs', body).then(r => r.data);

/** Per-meter monthly rows — the granularity the month comparison needs. */
export const fetchCostRows = (body) =>
  api.post('/costs/rows', body).then(r => r.data);

export const fetchRgCosts = (body) =>
  api.post('/costs/rg', body).then(r => r.data);

export const fetchDailyCosts = (body) =>
  api.post('/costs/daily', body).then(r => r.data);

export const fetchBandwidth = (body) =>
  api.post('/bandwidth', body).then(r => r.data);

export const fetchServices = (tenantId, subscriptionIds, months = 1, range = {}) =>
  api.get('/services', {
    params: {
      tenant_id: tenantId,
      subscription_ids: subscriptionIds,
      months,
      ...(range.from_date && range.to_date
        ? { from_date: range.from_date, to_date: range.to_date }
        : {}),
    },
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
