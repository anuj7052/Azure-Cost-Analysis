import axios from 'axios';
import { msalInstance, managementRequest } from '../auth/msalConfig';

const api = axios.create({
  baseURL: '/api',
  timeout: 60000,
});

// Token cache — reuse until 2 minutes before expiry
let _cachedToken = null;
let _tokenExpiry = 0;

async function getToken() {
  const now = Date.now();
  if (_cachedToken && now < _tokenExpiry) return _cachedToken;

  const accounts = msalInstance.getAllAccounts();
  const account = msalInstance.getActiveAccount() || accounts[0];
  if (!account) return null;

  try {
    const result = await msalInstance.acquireTokenSilent({ ...managementRequest, account });
    _cachedToken = result.accessToken;
    // Cache until 2 min before token expires
    _tokenExpiry = (result.expiresOn?.getTime() || now + 3600_000) - 120_000;
    return _cachedToken;
  } catch (err) {
    _cachedToken = null;
    console.warn('Token acquisition failed:', err);
    return null;
  }
}

// Attach Bearer token to every request
api.interceptors.request.use(async (config) => {
  const token = await getToken();
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

export default api;
