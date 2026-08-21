import axios from 'axios';
import toast from 'react-hot-toast';
import { msalInstance, managementRequest, loginRequest } from '../auth/msalConfig';
import { errorDetail, errorMessage } from '../utils/apiError';

const api = axios.create({
  baseURL: '/api/v1',
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

// Routes our own server answers without ever calling Azure on the caller's
// behalf. They only need proof of sign-in, so they take the ID token — which
// MSAL serves from cache and therefore keeps working after a reload, when
// silent renewal of an Azure management token is blocked by the browser's
// iframe restrictions.
//
// `/tenants` belongs here: registering a tenant authenticates with the service
// principal credentials in the request body, never with the caller's own Azure
// token. Requiring a management token there made first-time registration fail
// with "Not authenticated", because a brand-new session has no ARM token yet
// and cannot silently acquire one.
// `/prices` belongs here too: it reads Microsoft's public, unauthenticated
// price list and our own stored history, never the caller's Azure tenant. Given
// an ARM token it would fail after a reload, when silent renewal is blocked,
// for a route that never needed one.
const LOCAL_ROUTES = ['/upload', '/boq', '/me', '/admin', '/guide', '/integrations', '/tenants', '/search', '/changes', '/prices'];

/**
 * Routes that live under a local prefix but do call Azure.
 *
 * `/boq` parses uploaded files on our own server, so it takes the sign-in
 * token. `/boq/from-subscription` reads live resources and needs an Azure
 * management token — matching on the prefix alone sent it the wrong one and
 * Azure answered 401, which read as an expired session rather than a routing
 * mistake.
 */
const AZURE_ROUTES = ['/boq/from-subscription'];

// A sign-in popup may only open off a real click. These routes run from a file
// picker or an explicit form submit, so recovering the session there is
// allowed; the rest load in the background and must fail quietly instead of
// firing a blocked popup.
//
// `/prices` qualifies: the rate explanation panel only ever opens because
// someone clicked a unit rate.
const GESTURE_ROUTES = ['/upload', '/boq', '/tenants', '/prices'];

// Attach Bearer token to every request
api.interceptors.request.use(async (config) => {
  const url = config.url || '';
  const needsAzure = AZURE_ROUTES.some((r) => url.startsWith(r));
  const localRoute = !needsAzure && LOCAL_ROUTES.some((r) => url.startsWith(r));
  const userInitiated = needsAzure || GESTURE_ROUTES.some((r) => url.startsWith(r));
  const token = (localRoute ? await getSignInToken() : null)
    || (await getToken(userInitiated));

  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
    return config;
  }

  // Sending the request anyway returns a bare "Not authenticated" from the
  // server, which tells the user nothing they can act on. Fail here instead,
  // naming the actual cause: the browser has no usable sign-in to present.
  if (localRoute) {
    throw new axios.Cancel(
      'Your sign-in could not be read. Sign out and sign in again, then retry.',
    );
  }

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
/**
 * Tell the user they are being rate limited, rather than letting the page look
 * empty. An empty cost page is indistinguishable from "you spent nothing", so
 * the reason has to be said out loud.
 */
let lastLimitAlert = 0;

function alertRateLimited(err) {
  const now = Date.now();
  if (now - lastLimitAlert < 15000) return;
  lastLimitAlert = now;

  const retryAfter = Number(
    err.response?.headers?.['retry-after']
    || errorDetail(err).retry_after_seconds
    || 0,
  );

  toast.error(
    retryAfter
      ? `Too many requests. Retry in about ${retryAfter}s.`
      : 'Too many requests. Please slow down and retry shortly.',
    { id: 'rate-limited', duration: 8000 },
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
      alertSessionExpired(errorMessage(err));
    }

    if (err.response?.status === 429) alertRateLimited(err);

    // Carry the server's explanation onto `err.message`.
    //
    // Every failure is now wrapped in `{ error: { message } }`, but call sites
    // written against the older shape read `data.detail` and fall back to
    // `err.message` — which axios sets to "Request failed with status code 502".
    // That tells the user nothing and hides a message that says exactly what
    // went wrong, so the useful text replaces it here, once, rather than in
    // every component.
    if (err.response) {
      err.message = errorMessage(err);
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

/**
 * One meter, day by day, with the start/stop operations behind the shape.
 *
 * A monthly quantity cannot distinguish "ran all month" from "ran three weeks
 * and was left on over one weekend", and those need different answers.
 *
 * Given a longer ceiling than the default: this reads daily cost for two months
 * across every selected subscription and then the Activity Log on top, and on a
 * large estate Azure's own query API takes most of a minute to answer. Failing
 * at sixty seconds would mean the feature simply never works for the accounts
 * that need it most.
 */
export const fetchUsageDetail = (body) =>
  api.post('/costs/usage-detail', body, { timeout: 150000 }).then(r => r.data);

export const fetchBandwidth = (body) =>
  api.post('/bandwidth', body).then(r => r.data);

/** Spend split by pricing model: reserved, on-demand, spot, savings plan. */
export const fetchPricing = (body) =>
  api.post('/costs/pricing', body).then(r => r.data);

/** Which resources a reservation actually paid for: VM, resource group, SKU. */
export const fetchReservedDetail = (body) =>
  api.post('/costs/pricing/reserved', body).then(r => r.data);

/**
 * What changed between two points in time.
 *
 * Accepts a date range (how people actually ask) or an explicit scan pair.
 */
export const fetchChanges = (tenantId, { before, after, from_date, to_date } = {}) =>
  api.get('/changes', {
    params: {
      tenant_id: tenantId,
      ...(from_date ? { from_date } : {}),
      ...(to_date ? { to_date } : {}),
      ...(before ? { before } : {}),
      ...(after ? { after } : {}),
    },
  }).then(r => r.data);

/** Every recorded change for one resource, newest first. */
export const fetchEntityHistory = (tenantId, resourceId) =>
  api.get('/changes/history', {
    params: { tenant_id: tenantId, resource_id: resourceId },
  }).then(r => r.data);

/**
 * Who changed what, from the Azure Activity Log.
 *
 * The only source that records the actor behind a change — snapshot diffs see
 * results, this sees the operations that produced them.
 */
export const fetchActivity = (tenantId, subscriptionIds, { days = 7, resourceId, writesOnly = true } = {}) =>
  api.get('/activity', {
    params: {
      tenant_id: tenantId,
      subscription_ids: subscriptionIds,
      days,
      writes_only: writesOnly,
      ...(resourceId ? { resource_id: resourceId } : {}),
    },
    paramsSerializer: { indexes: null },
  }).then(r => r.data);

/** Build a Bill of Quantities from what is actually running in a subscription. */
export const generateBoqFromSubscription = (body) =>
  api.post('/boq/from-subscription', body).then(r => r.data);

/**
 * Download a BOQ as an .xlsx laid out like the pricing calculator's own export.
 *
 * The BOQ on screen is posted back rather than rebuilt server-side: rebuilding
 * would re-run the throttled resource and cost queries, and the download would
 * then be free to disagree with the figures the user is looking at.
 */
export const downloadBoqEstimate = (boq, title = 'Your Estimate') =>
  api.post('/boq/export/estimate.xlsx', { ...boq, title }, { responseType: 'blob' })
    .then(r => r.data);

/**
 * Why a billed unit rate differs from Microsoft's published one.
 *
 * Answers with both rates, the exchange rate that applied, the meter's recorded
 * price history and links back to Microsoft for each claim.
 */
export const explainUnitRate = (body) =>
  api.post('/prices/explain', body).then(r => r.data);

/** Recorded price movements — for one meter, or everything observed. */
export const fetchPriceHistory = (params = {}) =>
  api.get('/prices/history', { params }).then(r => r.data);

/** The dollar's daily rate against a currency, for one month. */
export const fetchFxRates = (quote, month) =>
  api.get('/prices/fx', { params: { quote, month } }).then(r => r.data);

/** Capture the estate now and store it as a point-in-time snapshot. */
export const runScan = (body) => api.post('/scans', body).then(r => r.data);

export const fetchScans = (tenantId, limit = 20) =>
  api.get('/scans', { params: { tenant_id: tenantId, limit } }).then(r => r.data);

/** Search every scan by resource name, including resources since deleted. */
export const searchResources = (tenantId, q, includeDeleted = true) =>
  api.get('/search', {
    params: { tenant_id: tenantId, q, include_deleted: includeDeleted },
  }).then(r => r.data);

/** Resources that are billed but attached to nothing. */
export const fetchOrphaned = (body) =>
  api.post('/orphaned', body).then(r => r.data);

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
