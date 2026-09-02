import axios from 'axios';
import toast from 'react-hot-toast';
import { msalInstance, managementRequest, loginRequest, graphRequest } from '../auth/msalConfig';
import { errorDetail, errorMessage } from '../utils/apiError';
import * as inflight from './inflight';

/**
 * Re-establish a lapsed sign-in, silently, and at most once.
 *
 * The redirect is normally invisible: Microsoft still holds a session cookie,
 * so it re-issues and returns the user to the same URL without asking them
 * anything. If that cookie has gone too, they get a real sign-in page, which is
 * the honest outcome - the difference is that they arrive there because their
 * Microsoft session genuinely ended, not because this app threw their tokens
 * away.
 *
 * The guard is the important part. Recovery navigates away and comes back, so
 * without a marker that survives the navigation a still-broken sign-in would
 * bounce the user between the app and Microsoft forever. `sessionStorage` is
 * the right home for it: it survives the redirect and dies with the tab, so a
 * genuine failure is attempted once per visit and then left alone for the
 * error message to explain.
 */
const RECOVERY_MARK = 'aca:signin-recovery';
let recovering = false;

function beginSilentRecovery(account) {
  if (recovering || sessionStorage.getItem(RECOVERY_MARK)) return;
  recovering = true;
  sessionStorage.setItem(RECOVERY_MARK, String(Date.now()));
  msalInstance
    .acquireTokenRedirect({ ...loginRequest, account })
    .catch(() => { recovering = false; });
}

/** Called once a request succeeds, so the next lapse is allowed its own retry. */
function clearRecoveryMark() {
  if (sessionStorage.getItem(RECOVERY_MARK)) sessionStorage.removeItem(RECOVERY_MARK);
}

const api = axios.create({
  baseURL: '/api/v1',
  timeout: 60000,
});

/**
 * Routes that fan out across every selected subscription and therefore wait on
 * Azure, not on us.
 *
 * The server caps those reads at its own budget (DEFAULT_GATHER_BUDGET, 100s)
 * and answers with partial data plus a named gap once it expires. The client
 * must therefore wait *longer* than the server, or it aborts a request that was
 * about to return a perfectly good answer — which is exactly what produced
 * "timeout of 60000ms exceeded" on accounts with a dozen subscriptions.
 *
 * 60s is kept for everything else: those routes only touch our own database, so
 * a minute of silence really is a fault.
 */
const SLOW_ROUTES = [
  '/costs', '/bandwidth', '/orphaned', '/scans', '/changes',
  '/services', '/activity', '/subscriptions', '/security', '/anomalies',
  // One Resource Graph query across every selected subscription, projecting
  // full `properties`. On a large estate it is the slowest read in the app.
  '/network/topology', '/commitments',
];
const SLOW_TIMEOUT = 120000;

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

  // Check the expiry before trusting the cached copy.
  //
  // MSAL fills `account.idToken` when the user signs in and refreshes it only
  // as a side effect of a silent acquisition happening to run. Nothing keeps it
  // current on its own, so this used to hand the server a token it correctly
  // rejected as expired. The two-minute margin matches the management token
  // above, so a token cannot lapse between being read and being received.
  const expiresAt = (account.idTokenClaims?.exp || 0) * 1000;
  if (account.idToken && Date.now() < expiresAt - 120_000) return account.idToken;

  try {
    const result = await msalInstance.acquireTokenSilent({ ...loginRequest, account });
    if (result.idToken) return result.idToken;
  } catch {
    // Re-establish the sign-in rather than send a token we know is dead.
    //
    // Reaching this point already means the cached token has expired, so any
    // failure to renew it - whatever the cause - leaves nothing usable. The
    // reason is deliberately not inspected. Renewal runs in a hidden iframe,
    // which browsers abort under third-party-cookie rules, and that surfaces as
    // a timeout rather than as MSAL's "interaction required". Keying the
    // recovery on the error class therefore missed the single most common way
    // this fails, and the app sat in a 401 loop instead of fixing itself.
    //
    // This is what made the app look like it signed people out on its own. A
    // single-page app's refresh token lives twenty-four hours and cannot be
    // extended, so roughly once a day silent renewal stops working for
    // everybody. MSAL still reports the account as signed in, because the
    // account record is cached separately from the tokens - so the app looked
    // authenticated while every request failed with "Token has expired", and
    // the only visible way out was the Sign out button.
    //
    // A redirect fixes it without involving the user: it is a top-level
    // navigation, so their Microsoft session cookie is sent as first-party,
    // Microsoft re-issues immediately, and they land back on the page they were
    // on. They see a flicker, not a sign-in form - and never a sign-out they
    // did not ask for.
    beginSilentRecovery(account);
  }

  // Send the stale token rather than nothing while recovery is under way. It
  // earns "Token has expired", which names the problem; sending no token at all
  // earns a bare "Not authenticated", which names nothing.
  return account.idToken || null;
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
const LOCAL_ROUTES = ['/upload', '/boq', '/me', '/admin', '/guide', '/integrations', '/tenants', '/search', '/changes', '/prices', '/team'];

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

/**
 * Routes that can show people's names instead of object ids if we hand the
 * server a Microsoft Graph token alongside the usual one.
 *
 * This is a second credential in a second header, never a replacement for the
 * Authorization bearer. The server authenticates the request exactly as before
 * and uses this token for one thing only: asking Graph who an object id belongs
 * to. Sending it as the Authorization token instead would fail signature
 * verification, since Microsoft signs Graph tokens so that only Graph can
 * validate them.
 */
const GRAPH_ROUTES = [
  '/security/role-assignments',
  '/security/access-review',
  '/security/access/grant/preview',
  '/security/access/revoke/preview',
  '/security/access/downgrade/preview',
  // Looking people up by name is a directory read like any other.
  '/team/directory',
];

let _graphToken = null;
let _graphExpiry = 0;
let _graphPending = null;
// Once the tenant refuses the directory scope, every later attempt refuses too.
// Retrying on each request would add a failed round trip to every scan for no
// possible gain, so the refusal is remembered for the life of the page.
let _graphRefused = false;

/**
 * A Graph token, or null.
 *
 * Null is a normal outcome, not an error: the directory scope needs admin
 * consent that many tenants have not granted. The caller sends the request
 * without the header and the server says plainly that names were not looked up.
 */
async function getGraphToken() {
  if (_graphRefused) return null;
  if (_graphToken && Date.now() < _graphExpiry) return _graphToken;

  const account = msalInstance.getActiveAccount() || msalInstance.getAllAccounts()[0];
  if (!account) return null;

  if (!_graphPending) {
    _graphPending = msalInstance
      .acquireTokenSilent({ ...graphRequest, account })
      .then((result) => {
        _graphToken = result.accessToken;
        _graphExpiry = (result.expiresOn?.getTime() || Date.now() + 3600_000) - 120_000;
        return _graphToken;
      })
      .catch(() => {
        // No popup here. This runs during a background scan, where browsers
        // block popups anyway, and a blocked popup would be a worse failure
        // than simply showing object ids.
        _graphRefused = true;
        return null;
      })
      .finally(() => { _graphPending = null; });
  }
  return _graphPending;
}

/**
 * Ask the user, interactively, for permission to read directory names.
 *
 * Separate from `getGraphToken` because the two run at different moments. That
 * one runs inside a background scan, where a popup would be blocked by the
 * browser and would fail worse than showing object ids. This one runs from a
 * button the user just pressed, which is the only context in which a popup is
 * allowed and the only context in which it is not a surprise.
 *
 * Returns true if names can now be resolved. A rejection is not an error: some
 * tenants require an administrator to approve this, and the pages carry on
 * saying "Name unavailable" rather than breaking.
 */
export async function requestDirectoryConsent() {
  const account = msalInstance.getActiveAccount() || msalInstance.getAllAccounts()[0];
  if (!account) return false;
  try {
    const result = await msalInstance.acquireTokenPopup({ ...graphRequest, account });
    _graphToken = result.accessToken;
    _graphExpiry = (result.expiresOn?.getTime() || Date.now() + 3600_000) - 120_000;
    _graphRefused = false;
    return true;
  } catch {
    return false;
  }
}

// Attach Bearer token to every request
async function prepareRequest(config) {
  const url = config.url || '';

  // Give Azure-backed fan-out routes the longer budget, unless the call site
  // already asked for something specific.
  if (config.timeout === 60000 && SLOW_ROUTES.some((r) => url.startsWith(r))) {
    config.timeout = SLOW_TIMEOUT;
  }

  const needsAzure = AZURE_ROUTES.some((r) => url.startsWith(r));
  const localRoute = !needsAzure && LOCAL_ROUTES.some((r) => url.startsWith(r));
  const userInitiated = needsAzure || GESTURE_ROUTES.some((r) => url.startsWith(r));

  if (GRAPH_ROUTES.some((r) => url.startsWith(r))) {
    const graph = await getGraphToken();
    if (graph) config.headers['X-Graph-Token'] = graph;
  }

  // Two tokens, two jobs.
  //
  // `Authorization` proves who is calling and must be issued for this app, so
  // it is always the sign-in token. `X-Azure-Token` is the delegated ARM token
  // the server forwards to Azure on the caller's behalf; the server never
  // treats it as proof of identity, because it was minted for Azure and Azure
  // is the only thing that can properly validate it.
  //
  // These used to be the same header, which meant the API accepted an
  // ARM-audience bearer as authentication -- and therefore would have accepted
  // a token minted for any other application the user had ever consented to.
  // That is why this deployment could not be run with ENVIRONMENT=production.
  const azureToken = localRoute ? null : await getToken(userInitiated);
  if (azureToken) config.headers['X-Azure-Token'] = azureToken;

  // Fall back to the ARM token as the bearer only if there is no sign-in token
  // at all. A request with no credential returns a bare "Not authenticated",
  // which tells the user nothing; a production server will reject the fallback
  // by audience, which at least fails for a nameable reason.
  const token = (await getSignInToken()) || azureToken;

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
}

/**
 * Count the request as in flight, and make sure it stops counting.
 *
 * Registered here rather than at the call sites so that nothing can be slow
 * invisibly -- a request that forgets to report itself is exactly the one that
 * leaves somebody staring at an empty panel.
 *
 * The release has to happen in three places, and missing any of them leaves the
 * indicator spinning forever over an app that has finished. Two are the
 * response interceptors below; the third is here, because `prepareRequest` can
 * reject before the request is ever sent and the `Cancel` it throws carries no
 * `config` for the response handler to read an id from.
 */
api.interceptors.request.use(async (config) => {
  config.__inflightId = inflight.begin(config.url || '');
  try {
    return await prepareRequest(config);
  } catch (err) {
    inflight.end(config.__inflightId);
    throw err;
  }
});

/**
 * Tell the user when a credential has lapsed, and which one.
 *
 * Two completely different things produce a 401 here and they were being
 * treated as one. A pasted tenant session token is a *data-source* credential:
 * it says which Azure directory we may read, and it expiring says nothing
 * whatsoever about who the user is. The Microsoft sign-in is the *identity*.
 * Conflating them meant an expired tenant token told a perfectly signed-in
 * person that their sign-in had gone and they should sign out - advice that
 * destroyed a working session to fix an unrelated problem.
 *
 * So each names its own credential and offers only actions that address it.
 * Neither tells anyone to sign out, because neither is fixed by signing out.
 * One alert per burst, since a single page load can fire a dozen requests.
 */
let lastExpiryAlert = 0;

/**
 * Whether a 401 is about the tenant's stored session token rather than the
 * caller's sign-in. The server says so in the message it already returns - see
 * `token_resolver.resolve_tenant_token`, which is the only thing that speaks of
 * a "session token for this tenant".
 */
export function isTenantTokenExpiry(detail) {
  return /session token/i.test(detail || '');
}

function alertSessionExpired(detail) {
  const now = Date.now();
  if (now - lastExpiryAlert < 15000) return;
  lastExpiryAlert = now;

  if (isTenantTokenExpiry(detail)) {
    toast.error(
      'This tenant\u2019s session token has expired. Renew it in Settings, or switch to another tenant. You are still signed in.',
      { id: 'session-expired', duration: 10000 },
    );
    return;
  }

  // The sign-in itself. A renewal is attempted automatically on the next
  // request, so this does not ask for a new login - it says what is happening
  // and what to do only if it keeps happening.
  toast.error(
    'Your sign-in is being renewed. If pages stay empty, reload once to continue.',
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
  (res) => {
    inflight.end(res.config?.__inflightId);
    // A working request proves the sign-in recovered, so let the next lapse
    // have its own attempt instead of inheriting this one's spent marker.
    clearRecoveryMark();
    return res;
  },
  (err) => {
    inflight.end(err.config?.__inflightId);
    if (err.response?.status === 401) {
      const detail = errorMessage(err);

      // Only discard the cached Azure token when the caller's own credential
      // is what failed. A tenant's session token expiring is somebody else's
      // credential going stale; throwing away this user's working management
      // token because of it forced a needless renewal on every other tenant
      // they can see.
      if (!isTenantTokenExpiry(detail)) {
        _cachedToken = null;
        _tokenExpiry = 0;
      }
      alertSessionExpired(detail);
    }

    if (err.response?.status === 429) alertRateLimited(err);

    // Axios reports an aborted request as "timeout of 60000ms exceeded", which
    // names a number the user never chose and gives them nothing to do about
    // it. Say what was being read and what actually shortens it.
    if (!err.response && (err.code === 'ECONNABORTED' || /timeout/i.test(err.message || ''))) {
      const seconds = Math.round((err.config?.timeout || 0) / 1000) || null;
      err.isTimeout = true;
      err.message = seconds
        ? `Azure did not respond within ${seconds}s. This usually means too many subscriptions or too wide a date range — narrow either one and retry.`
        : 'Azure did not respond in time. Narrow the date range or select fewer subscriptions, then retry.';
      return Promise.reject(err);
    }

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

/**
 * Phone, company and consent. Everything else comes from Entra and is
 * refreshed from the token on every request, so editing it here would be
 * silently overwritten.
 *
 * Send `{ consent: false }` on its own to withdraw: the API treats that as an
 * erasure of everything consent was covering, not as a flag being flipped.
 */
export const updateProfile = (body) => api.patch('/me', body).then(r => r.data);

/** Close this person's open sessions before the Microsoft sign-out redirect. */
export const endMySession = () => api.post('/me/sign-out').then(r => r.data);

// Team seats. Every write returns the whole team back, so the caller never has
// to guess what the seat counts became after an invite or a removal.
export const fetchTeam = () => api.get('/team').then(r => r.data);

/**
 * People in the signed-in user's own Microsoft directory whose name or address
 * starts with `q`. Comes back as `{ people, reason, note }` rather than a bare
 * list, because a directory the administrator has not consented to is a
 * different answer from a directory with nobody by that name.
 */
export const searchDirectory = (q) =>
  api.get('/team/directory', { params: { q } }).then(r => r.data);

export const inviteTeamMember = (email, role = 'user') =>
  api.post('/team/invitations', { email, role }).then(r => r.data);
export const setMemberRole = (id, role) =>
  api.patch(`/team/members/${id}/role`, { role }).then(r => r.data);
export const setInvitationRole = (id, role) =>
  api.patch(`/team/invitations/${id}/role`, { role }).then(r => r.data);
export const revokeInvitation = (id) =>
  api.delete(`/team/invitations/${id}`).then(r => r.data);
export const removeTeamMember = (id) =>
  api.delete(`/team/members/${id}`).then(r => r.data);

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

/**
 * The permission list, plus a consent link for the given tenant.
 *
 * `tenantId` is optional — the API falls back to the caller's own directory,
 * which is the right default for somebody onboarding their own company.
 */
export const fetchPermissions = (tenantId) =>
  api.get('/guide/permissions', { params: tenantId ? { tenant_id: tenantId } : {} })
    .then(r => r.data);

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

// Building resources.
//
// `/provision` is deliberately absent from LOCAL_ROUTES: the deploy route
// calls Azure with the caller's own management token, which is what makes
// Azure's RBAC — rather than a check of ours — decide who may create what.
export const fetchProvisionCatalog = () =>
  api.get('/provision/catalog').then(r => r.data);
export const sendProvisionChat = (body) =>
  api.post('/provision/chat', body).then(r => r.data);
export const startProvisionDeploy = (body) =>
  api.post('/provision/deploy', body).then(r => r.data);
export const fetchProvisionDeployments = () =>
  api.get('/provision/deployments').then(r => r.data);
export const fetchProvisionDeployment = (id) =>
  api.get(`/provision/deployments/${id}`).then(r => r.data);

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

/**
 * The same rows for a single service, but named per resource.
 *
 * A separate call because the resource name and the usage quantity cannot be
 * asked for in one Cost Management query; this trades the quantity away to
 * find out which machine the money went to.
 */
export const fetchServiceResources = (body) =>
  api.post('/costs/resources', body).then(r => r.data);

export const fetchRgCosts = (body) =>
  api.post('/costs/rg', body).then(r => r.data);

/**
 * Classified cost changes for a period against its comparison window.
 *
 * Reads the same Cost Management data the rest of the app uses -- this is one
 * request for the whole page, not one per finding.
 */
export const analyzeAnomalies = (body) =>
  api.post('/anomalies/analyze', body).then(r => r.data);

/** Record that somebody triaged a finding. Returns the refreshed trail. */
export const setAnomalyStatus = (body) =>
  api.post('/anomalies/status', body).then(r => r.data);

/** The activity trail for one finding. */
export const fetchAnomalyHistory = (tenantId, anomalyKey) =>
  api.get('/anomalies/history', { params: { tenant_id: tenantId, anomaly_key: anomalyKey } })
    .then(r => r.data);

/**
 * Reserved Instance / Savings Plan coverage, and what moved between months.
 *
 * Asked separately from the main rows query because Cost Management accepts at
 * most three grouping dimensions and that query already spends all three.
 */
export const fetchPricingModel = (body) =>
  api.post('/costs/pricing-model', body).then(r => r.data);

/**
 * Reservations and savings plans: what is committed, how much of it is being
 * used, what lapses soon, and what Azure suggests buying.
 *
 * One call rather than four because the page is meaningless in pieces -- a
 * utilisation figure without the cost beside it cannot be acted on.
 */
export const fetchCommitments = (body) =>
  api.post('/commitments', body).then(r => r.data);

/**
 * Which public IPs and resource groups produced the data-transfer charge.
 *
 * Joins the Resource Manager address inventory to Cost Management charges. The
 * join is only exact where a charged resource group holds one public IP, so
 * every row carries its own confidence rather than being presented flat.
 */
export const fetchBandwidthTraffic = (body) =>
  api.post('/bandwidth/traffic', body).then(r => r.data);

/**
 * One resource's transfer cost, day by day.
 *
 * Asked per resource rather than for everything at once: a daily, unfiltered
 * query over a large subscription returns tens of thousands of rows to answer a
 * question about one machine, and Cost Management throttles hard enough that
 * the waste is felt by the next request.
 */
export const fetchResourceDaily = (body) =>
  api.post('/bandwidth/resource-daily', body).then(r => r.data);

/*
 * Access & Security.
 *
 * All four POST endpoints fan out across every selected subscription and read a
 * different Azure provider, so they are slow by nature and are listed in
 * SLOW_ROUTES. Each also captures a snapshot as it reads — Advisor, Defender and
 * Policy report only the present tense, so the previous reading is the only
 * record that a comparison can ever be made against.
 */

/** Every principal, and everything it can reach. */
export const fetchRoleAssignments = (body) =>
  api.post('/security/role-assignments', body).then(r => r.data);

/** Grants that look unused, stale, over-privileged, over-scoped, sprawling or redundant. */
export const fetchAccessReview = (body) =>
  api.post('/security/access-review', body).then(r => r.data);

/** Advisor recommendations across the estate, and what changed since last time. */
export const fetchAdvisor = (body) =>
  api.post('/security/advisor', body).then(r => r.data);

/**
 * The management group hierarchy this account can see.
 *
 * Tenant-wide rather than subscription-scoped, because the point of it is to
 * see the levels *above* whatever subscriptions happen to be ticked.
 */
export const fetchManagementGroups = (body) =>
  api.post('/security/management-groups', body).then(r => r.data);

/** Access findings this workspace has already reviewed and accepted. */
export const fetchAccessIgnores = (tenantId) =>
  api.get('/security/access-ignores', { params: { tenant_id: tenantId } }).then(r => r.data);

/**
 * Accept a finding, or a whole principal when `finding_key` is empty.
 *
 * Nothing in Azure changes — this only affects what this workspace sees by
 * default, and it is always reversible.
 */
export const acceptAccessFinding = (body) =>
  api.post('/security/access-ignores', body).then(r => r.data);

/** Put an accepted finding back in the list. */
export const restoreAccessFinding = (tenantId, principalId, findingKey = '') =>
  api.delete('/security/access-ignores', {
    params: { tenant_id: tenantId, principal_id: principalId, finding_key: findingKey },
  }).then(r => r.data);

/** Defender assessments, alerts and secure score. */
export const fetchDefender = (body) =>
  api.post('/security/defender', body).then(r => r.data);

/** Policy compliance, assignments and exemptions. */
export const fetchPolicy = (body) =>
  api.post('/security/policy', body).then(r => r.data);

/** Every stored reading of one source, for the trend line. */
export const fetchPostureSnapshots = (params) =>
  api.get('/security/snapshots', { params }).then(r => r.data);

/**
 * Changing access.
 *
 * Every mutation here has a matching preview that runs the identical checks
 * server-side. The preview exists so a user can see what would happen; it is
 * not what makes the change safe, because the server re-runs every check before
 * touching Azure regardless of what the preview said.
 */
export const fetchAssignableRoles = (body) =>
  api.post('/security/access/roles', body).then(r => r.data);

/**
 * The virtual networks in the selected subscriptions, and how they connect.
 *
 * One large Resource Graph query rather than a request per network: peerings
 * are only discoverable from each network's own configuration, so the whole set
 * has to be in hand before any line can be drawn.
 */
export const fetchNetworkTopology = (body) =>
  api.post('/network/topology', body).then(r => r.data);

export const previewGrantAccess = (body) =>
  api.post('/security/access/grant/preview', body).then(r => r.data);

export const grantAccess = (body) =>
  api.post('/security/access/grant', body).then(r => r.data);

export const previewRevokeAccess = (body) =>
  api.post('/security/access/revoke/preview', body).then(r => r.data);

export const revokeAccess = (body) =>
  api.post('/security/access/revoke', body).then(r => r.data);

/**
 * Replacing a role with a smaller one.
 *
 * Two Azure operations behind one call, and the order is the point: the
 * narrower role is granted before the wider one is removed, so a failure
 * part-way leaves too much access rather than none at all.
 */
export const previewDowngradeAccess = (body) =>
  api.post('/security/access/downgrade/preview', body).then(r => r.data);

export const downgradeAccess = (body) =>
  api.post('/security/access/downgrade', body).then(r => r.data);

/** What this account has changed about access in this tenant. */
export const fetchAccessHistory = (params) =>
  api.get('/security/access/history', { params }).then(r => r.data);

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
export const fetchChanges = (tenantId, { before, after, from_date, to_date, group_by, show_ignored } = {}) =>
  api.get('/changes', {
    params: {
      tenant_id: tenantId,
      ...(from_date ? { from_date } : {}),
      ...(to_date ? { to_date } : {}),
      ...(before ? { before } : {}),
      ...(after ? { after } : {}),
      ...(group_by ? { group_by } : {}),
      ...(show_ignored ? { show_ignored: true } : {}),
    },
  }).then(r => r.data);

/**
 * What changed in the estate while this cost moved.
 *
 * Answered from our own scan snapshots, so it costs no Azure call and can be
 * opened per anomaly without the page rate-limiting itself. What comes back is
 * evidence, never a cause: billing records what was charged, not who did what.
 */
export const explainAnomaly = (body) =>
  api.post('/anomalies/explain', body).then(r => r.data);

/** Every recorded change for one resource, newest first. */
export const fetchEntityHistory = (tenantId, resourceId) =>
  api.get('/changes/history', {
    params: { tenant_id: tenantId, resource_id: resourceId },
  }).then(r => r.data);

/**
 * The same history, plus what the resource cost around each change and who
 * made it.
 *
 * Deliberately not under `/changes`: that prefix is a local route answered
 * from our own database and it keeps working when Azure is throttling
 * everybody. This one reads Cost Management and the Activity Log, so it needs
 * a management token and belongs on its own prefix where it gets one.
 *
 * `granularity` is 'monthly' or 'daily'. Daily is the expensive question --
 * did the bill step up on the exact day it changed -- so it is only asked when
 * somebody explicitly opens it.
 */
export const fetchResourceTimeline = (tenantId, resourceId, { granularity = 'monthly' } = {}) =>
  api.post('/timeline/resource', {
    tenant_id: tenantId,
    resource_id: resourceId,
    granularity,
  }).then(r => r.data);

/** Which changes are currently being suppressed, and who suppressed them. */
export const fetchIgnores = (tenantId) =>
  api.get('/changes/ignores', { params: { tenant_id: tenantId } }).then(r => r.data);

/**
 * Mark a change as expected.
 *
 * An empty `field` silences the whole resource; naming one silences only that
 * property, which is usually what people mean.
 */
export const ignoreChange = (body) =>
  api.post('/changes/ignores', body).then(r => r.data);

/** Stop suppressing a change. */
export const unignoreChange = (tenantId, resourceId, field = '') =>
  api.delete('/changes/ignores', {
    params: { tenant_id: tenantId, resource_id: resourceId, field },
  }).then(r => r.data);

/**
 * Who changed what, from the Azure Activity Log.
 *
 * The only source that records the actor behind a change — snapshot diffs see
 * results, this sees the operations that produced them.
 */
export const fetchActivity = (tenantId, subscriptionIds, { days = 7, resourceId, resourceGroup, writesOnly = true } = {}) =>
  api.get('/activity', {
    params: {
      tenant_id: tenantId,
      subscription_ids: subscriptionIds,
      days,
      writes_only: writesOnly,
      ...(resourceId ? { resource_id: resourceId } : {}),
      // Only sent when no resource id is, because a resource id already names
      // the group and Azure rejects the pair. Narrowing to a group is what lets
      // a whole resource group be attributed in one call instead of one per
      // resource.
      ...(resourceGroup && !resourceId ? { resource_group: resourceGroup } : {}),
    },
    paramsSerializer: { indexes: null },
  }).then(r => r.data);

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

/** Whether the machine's `az login` can stand in for stored credentials. */
export const fetchCliStatus = () => api.get('/tenants/cli').then(r => r.data);

/** Start a device-code `az login` and get back the code to type. */
export const startCliLogin = (tenantId) =>
  api.post('/tenants/cli/login', null, tenantId ? { params: { tenant_id: tenantId } } : undefined)
    .then(r => r.data);

/** How the sign-in that is already running is getting on. */
export const fetchCliLogin = () => api.get('/tenants/cli/login').then(r => r.data);

/** Abandon a sign-in rather than leaving `az` waiting on the server. */
export const cancelCliLogin = () => api.delete('/tenants/cli/login').then(r => r.data);

/** Today's dollar rate for several currencies, for the display-currency switch. */
export const fetchLatestFxRates = (quotes) =>
  api.get('/prices/fx/latest', { params: { quotes: quotes.join(',') } }).then(r => r.data);

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

/**
 * The VM fleet with a right-sizing verdict per machine.
 *
 * Joins Resource Graph, Cost Management, Azure Monitor and Retail Prices, so
 * it is slower than most calls and the response carries a `sources` block
 * saying which of the four actually answered.
 */
export const fetchCompute = (body) =>
  api.post('/compute', body).then(r => r.data);

/**
 * Ask what a resize would involve. Read-only on the Azure side — the backend
 * performs only GETs — so this is safe to call whenever the review opens.
 * Its `can_resize` verdict is what enables the confirm button.
 */
export const previewResize = (body) =>
  api.post('/compute/resize/preview', body).then(r => r.data);

/**
 * Start a real resize. The backend refuses without `confirmation: true` and
 * re-validates everything against Azure, so nothing here is load-bearing for
 * safety — the explicit flag exists so an accidental call cannot be
 * destructive.
 */
export const startResize = (body) =>
  api.post('/compute/resize', { ...body, confirmation: true }).then(r => r.data);

/** Where a running resize has actually got to, read from the backend record. */
export const fetchResizeOperation = (operationId) =>
  api.get(`/compute/resize/operations/${operationId}`).then(r => r.data);

export const fetchResizeHistory = (tenantId) =>
  api.get('/compute/resize/history', { params: { tenant_id: tenantId } })
    .then(r => r.data);

/**
 * What this platform is able to change in Azure.
 *
 * Served by the backend rather than hard-coded here, so the list cannot drift
 * from what the server will actually accept. Includes actions that are
 * switched off, with `enabled: false` — a capability that exists and is
 * disabled is more useful to show than to hide.
 */
export const fetchActionCatalogue = () =>
  api.get('/actions').then(r => r.data);

/** Every change this workspace has made to one tenant, failures included. */
export const fetchActionHistory = (tenantId, limit = 50) =>
  api.get('/actions/history', { params: { tenant_id: tenantId, limit } })
    .then(r => r.data);

export const fetchAction = (actionId) =>
  api.get(`/actions/${actionId}`).then(r => r.data);

/**
 * Merge tags onto a resource.
 *
 * The idempotency key is generated per call rather than taken from the caller
 * so that a retry inside axios, a flaky connection or an impatient second
 * click cannot become a second write. It is the request that is identified,
 * not the intent: asking again later is a new key and a new change.
 */
export const applyTags = (body) =>
  api.post('/actions/tag', { ...body, confirmation: true }, {
    headers: { 'Idempotency-Key': crypto.randomUUID() },
  }).then(r => r.data);

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

/**
 * Every size this VM can move to, each with its own quota, availability and
 * price, read live from the caller's own tenant. Read-only.
 */
export const fetchResizeOptions = (body) =>
  api.post('/compute/resize/options', body).then(r => r.data);
