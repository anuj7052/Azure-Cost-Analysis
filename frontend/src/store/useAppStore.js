import { create } from 'zustand';
import { fetchTenants, fetchSubscriptions, fetchCosts, fetchCostRows, fetchServices, fetchRgCosts, fetchDailyCosts, fetchBandwidth, fetchMe, fetchOrphaned, fetchPricing, fetchCompute, fetchActivity, fetchPolicy, fetchDefender, fetchAdvisor, fetchAccessReview, fetchRoleAssignments } from '../api/client';
import { buildBandwidthSummary, buildCostSummary, buildRgSummary, buildServiceList, filterRows, mergeImports } from '../utils/importAnalytics';
import { readCache, readPrefs, writeCache, writePrefs, evictApiCache } from '../utils/persistCache';

/**
 * Azure Cost Management throttles hard (HTTP 429). Several pages mount effects
 * that request the same data at the same time, so identical in-flight requests
 * share a single promise instead of hitting the API once per caller.
 */
const inFlight = new Map();

/**
 * Move a YYYY-MM-DD date back by whole months, landing on the first of the month.
 *
 * Meter rows are fetched for a wider window than the user selected so that a
 * month-over-month comparison still has a previous month to compare against.
 */
function widenBackByMonths(isoDate, back) {
  const [y, m] = String(isoDate).split('-').map(Number);
  // Date handles the year rollover; month is zero-based here.
  const start = new Date(Date.UTC(y, (m - 1) - back, 1));
  return start.toISOString().slice(0, 10);
}

function dedupe(key, run) {
  const existing = inFlight.get(key);
  if (existing) return existing;
  const promise = run().finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

/**
 * Stale-while-revalidate around a request.
 *
 * A cached answer is applied synchronously so a refresh renders instantly.
 * If that answer is still fresh we skip the network entirely; if it is stale we
 * render it anyway and refresh in the background, so the user never stares at a
 * spinner while Azure Cost Management takes its time.
 *
 * When Azure replies "rate limited, retry in Ns" we honour that automatically
 * rather than making the user find and press Refresh.
 */
const RATE_LIMIT_RETRIES = 2;

/**
 * How many times a partial cost result is allowed to heal itself.
 *
 * The retries above cover a request that failed outright. These cover the
 * quieter case: the request succeeded, but Azure throttled one subscription
 * out of it, so the total is a real number that is simply too small. Left
 * alone it stays too small until somebody presses Refresh.
 *
 * Bounded, because a tenant that is throttled all afternoon must not be
 * queried in a loop all afternoon -- that makes the throttling worse and
 * outlives the reader's attention either way.
 */
const MAX_COST_RETRIES = 3;

// Never come back sooner than this, whatever Azure asked for.
const MIN_COST_RETRY_SECONDS = 5;

function retryAfterSeconds(err) {
  const detail = err?.response?.data?.detail;
  if (typeof detail !== 'string' || !/rate limit/i.test(detail)) return null;
  const match = detail.match(/about (\d+)\s*s/i);
  return Math.min(match ? Number(match[1]) : 5, 30);
}

/**
 * A 200 response can still be incomplete: the backend returns whatever
 * subscriptions it managed to read plus an `errors` list for the throttled
 * ones. Those totals are wrong, so they must never be cached as fresh.
 */
function isPartial(data) {
  return Array.isArray(data?.errors) && data.errors.length > 0;
}

/** How long to wait before re-asking for the subscriptions that got throttled. */
function partialRetryDelay(data) {
  const detail = data.errors.map(e => e?.error).join(' ');
  const match = detail.match(/about (\d+)\s*s/i);
  return Math.min(match ? Number(match[1]) : 5, 30);
}

async function cached(key, run, apply, { force = false } = {}) {
  const hit = force ? null : readCache(key);
  if (hit) {
    apply(hit.value, { fromCache: true });
    if (hit.fresh) return hit.value;
  }

  let lastErr;
  let partial = null;
  for (let attempt = 0; attempt <= RATE_LIMIT_RETRIES; attempt++) {
    try {
      const data = await dedupe(key, run);
      writeCache(key, data, { stale: isPartial(data) });
      apply(data, { fromCache: false });
      if (!isPartial(data)) return data;
      // Show the partial answer now, then quietly go back for the rest.
      partial = data;
      if (attempt === RATE_LIMIT_RETRIES) return data;
      await new Promise(r => setTimeout(r, (partialRetryDelay(data) + 1) * 1000));
    } catch (err) {
      lastErr = err;
      const wait = attempt < RATE_LIMIT_RETRIES ? retryAfterSeconds(err) : null;
      if (wait === null) break;
      await new Promise(r => setTimeout(r, (wait + 1) * 1000));
    }
  }

  if (partial) return partial;
  if (hit) return hit.value; // keep showing cached data instead of an error
  throw lastErr;
}

const prefs = readPrefs() || {};

/** An uploaded file survives reloads, so a navigation never drops back to live data. */
const IMPORT_KEY = 'import:file';
const BOQ_KEY = 'boq:list';
const restoredImport = readCache(IMPORT_KEY)?.value || null;

/** Identifies the active date range, so pages can re-run effects when it moves. */
function dateKeyOf(dateMode, months, fromDate, toDate) {
  return dateMode === 'custom' && fromDate && toDate
    ? `custom:${fromDate}:${toDate}`
    : `rolling:${months}`;
}

/** Remember what the user picked so a refresh restores the same view. */
function savePrefs(get) {
  const { selectedTenantId, selectedSubscriptionIds, months, dateMode, fromDate, toDate } = get();
  writePrefs({ selectedTenantId, selectedSubscriptionIds, months, dateMode, fromDate, toDate });
}

export const useAppStore = create((set, get) => ({
  // ── Signed-in account ──
  // Role comes from the backend, never from the token, so the admin nav cannot
  // be unlocked by editing anything in the browser.
  me: null,
  meLoading: false,
  // Distinguishes "still loading" from "asked and failed". Without it the shell
  // cannot tell the two apart and spins forever on any error.
  meError: null,

  loadMe: async () => {
    set({ meLoading: true, meError: null });
    try {
      set({ me: await fetchMe(), meLoading: false, meError: null });
    } catch (err) {
      set({
        me: null,
        meLoading: false,
        meError: err.response?.data?.detail || err.message || 'Could not load your account.',
      });
    }
  },

  /** Accepts a fresh account payload from an endpoint that already returned one. */
  setMe: (me) => set({ me }),

  // ── Tenants ──
  tenants: readCache('tenants')?.value ?? [],
  selectedTenantId: prefs.selectedTenantId ?? null,
  tenantsLoading: false,
  tenantsError: null,

  loadTenants: async () => {
    set({ tenantsLoading: true, tenantsError: null });
    try {
      const tenants = await cached('tenants', fetchTenants, (data) => set({ tenants: data }));
      set({ tenantsLoading: false });

      // Restore the previously selected tenant when it still exists.
      const saved = get().selectedTenantId;
      const target = tenants.find(t => t.tenant_id === saved) || tenants[0];
      if (!target) return;
      set({ selectedTenantId: target.tenant_id });
      await get().loadSubscriptions(target.tenant_id);
    } catch (err) {
      set({ tenantsLoading: false, tenantsError: err.message });
    }
  },

  setSelectedTenant: async (tenantId) => {
    set({ selectedTenantId: tenantId, selectedSubscriptionIds: [] });
    savePrefs(get);
    await get().loadSubscriptions(tenantId);
  },

  addTenantToList: (tenant) =>
    set((s) => ({ tenants: [...s.tenants.filter(t => t.tenant_id !== tenant.tenant_id), tenant] })),

  removeTenantFromList: (tenantId) =>
    set((s) => ({ tenants: s.tenants.filter(t => t.tenant_id !== tenantId) })),

  // ── Subscriptions ──
  subscriptions: [],
  // Restored across reloads so the dashboard shows the same view the user left,
  // without making them re-pick their subscriptions every time.
  //
  // This does mean a reload re-issues a cost query per selected subscription.
  // That is affordable because the responses are cached (in memory, in
  // localStorage, and on the server), so a reload inside the cache window
  // costs nothing and a reload outside it is work the user wanted anyway.
  // Anything restored here is still filtered against the subscriptions that
  // actually came back from Azure, so a stale or revoked id cannot resurrect
  // itself and silently skew a total.
  selectedSubscriptionIds: prefs.selectedSubscriptionIds ?? [],
  subscriptionsLoading: false,
  subscriptionsError: null,

  loadSubscriptions: async (tenantId) => {
    // While a file is imported its subscription list is the source of truth.
    if (get().imported) return;
    set({ subscriptionsLoading: true, subscriptionsError: null });
    try {
      const subs = await cached(
        `subs:${tenantId}`,
        () => fetchSubscriptions(tenantId),
        (data) => set({ subscriptions: data }),
      );
      set({ subscriptionsLoading: false });

      // Keep the saved selection when those subscriptions still exist, but do
      // not select everything by default. Auto-selecting every subscription
      // fires a Cost Management query per subscription the moment a tenant
      // loads — slow, and throttled on any sizeable estate — to answer a
      // question the user has not asked yet. They choose, then data loads.
      const activeIds = subs.filter(s => s.state === 'Enabled').map(s => s.subscription_id);
      set({ selectedSubscriptionIds: get().selectedSubscriptionIds.filter(id => activeIds.includes(id)) });
      savePrefs(get);
    } catch (err) {
      set({ subscriptionsLoading: false, subscriptionsError: err.message });
    }
  },

  toggleSubscription: (subId) => {
    set((s) => ({
      selectedSubscriptionIds: s.selectedSubscriptionIds.includes(subId)
        ? s.selectedSubscriptionIds.filter(id => id !== subId)
        : [...s.selectedSubscriptionIds, subId],
    }));
    savePrefs(get);
    if (get().imported) get().recomputeImported();
  },

  setAllSubscriptions: (ids) => {
    set({ selectedSubscriptionIds: ids });
    savePrefs(get);
    if (get().imported) get().recomputeImported();
  },

  // ── Cost Data ──
  costData: null,
  costLoading: false,
  costError: null,
  months: prefs.months ?? 6,
  // dateMode: 'rolling' (last N months) | 'custom' (explicit from/to)
  dateMode: prefs.dateMode ?? 'rolling',
  fromDate: prefs.fromDate ?? null,   // 'YYYY-MM-DD'
  toDate: prefs.toDate ?? null,     // 'YYYY-MM-DD'
  // Single value every page can watch so a date change refetches everywhere.
  dateKey: dateKeyOf(prefs.dateMode ?? 'rolling', prefs.months ?? 6, prefs.fromDate, prefs.toDate),

  setMonths: (months) => {
    set({ months, dateMode: 'rolling', fromDate: null, toDate: null, dateKey: dateKeyOf('rolling', months) });
    savePrefs(get);
    if (get().imported) get().recomputeImported();
  },

  setCustomDateRange: (fromDate, toDate) => {
    set({ dateMode: 'custom', fromDate, toDate, dateKey: dateKeyOf('custom', null, fromDate, toDate) });
    savePrefs(get);
    if (get().imported) get().recomputeImported();
  },

  loadCosts: async (opts = {}) => {
    const { selectedTenantId, selectedSubscriptionIds, months, dateMode, fromDate, toDate, imported, recomputeImported } = get();
    if (imported) return recomputeImported();
    if (!selectedTenantId || selectedSubscriptionIds.length === 0) return;

    set({ costLoading: true, costError: null });
    try {
      const payload = {
        tenant_id: selectedTenantId,
        subscription_ids: selectedSubscriptionIds,
        months,
        ...(dateMode === 'custom' && fromDate && toDate ? { from_date: fromDate, to_date: toDate } : {}),
      };
      const key = `costs:${JSON.stringify(payload)}`;

      // A new selection or date range is a new question, and a person pressing
      // Refresh is asking again on purpose. Either way the automatic retry
      // budget starts over -- carrying an exhausted one across would leave the
      // page silently unable to heal itself for the rest of the session.
      if (key !== get().costRetryKey || (opts.force && !opts.auto)) {
        set({ costRetriesLeft: MAX_COST_RETRIES });
      }
      set({ costRetryKey: key });

      await cached(
        key,
        () => fetchCosts(payload),
        (data) => set({ costData: data, costLoading: false, costError: null }),
        opts,
      );
      set({ costLoading: false });
      get().scheduleThrottledCostRetry();
    } catch (err) {
      set({ costLoading: false, costError: err.response?.data?.detail || err.message });
    }
  },

  /* --------------------------------------------------------------------
   * Filling in a subscription Azure refused to answer for
   *
   * A throttled subscription used to leave the page saying "wait about 4s and
   * hit Refresh". That is reasonable advice for a person and useless to the
   * page, which could not press its own button -- so the total sat there
   * understated until somebody noticed the amber bar and acted on it. The
   * numbers were never wrong, but they were quietly incomplete, which on a
   * cost page is the same problem wearing a different coat.
   *
   * The retry re-runs the whole query rather than merging a per-subscription
   * result into the existing totals. That is deliberate: the response is
   * already aggregated across subscriptions and re-aggregating half of it on
   * the client is exactly the kind of arithmetic that produces a figure nobody
   * can reconcile against an invoice. Re-asking costs one request and the
   * answer is whole.
   *
   * Only failures the server marked retryable are waited on. A missing Cost
   * Management Reader role refuses identically for ever, and a timer around it
   * is a spin loop, not resilience.
   * ----------------------------------------------------------------- */
  costRetryTimer: null,
  costRetryAt: null,
  costRetryKey: null,
  costRetriesLeft: MAX_COST_RETRIES,

  cancelThrottledCostRetry: () => {
    const { costRetryTimer } = get();
    if (costRetryTimer) clearTimeout(costRetryTimer);
    set({ costRetryTimer: null, costRetryAt: null });
  },

  scheduleThrottledCostRetry: () => {
    get().cancelThrottledCostRetry();

    const errors = get().costData?.coverage?.errors;
    if (!Array.isArray(errors)) return;

    const waits = errors.filter(e => e?.retryable).map(e => Number(e.retry_after_seconds) || 0);
    if (waits.length === 0) return;

    const retriesLeft = get().costRetriesLeft;
    if (retriesLeft <= 0) return;

    // The longest wait any failure asked for. Coming back on the shortest one
    // would retry a subscription that is still inside its own cooldown, which
    // renews the throttle instead of clearing it.
    const seconds = Math.max(...waits, MIN_COST_RETRY_SECONDS);

    const timer = setTimeout(() => {
      set({ costRetryTimer: null, costRetryAt: null, costRetriesLeft: get().costRetriesLeft - 1 });
      // `force` because the previous, partial answer is in the cache and
      // serving it again would make the retry a no-op. `auto` marks it as the
      // timer's own doing so it does not refund its own retry budget.
      get().loadCosts({ force: true, auto: true });
    }, seconds * 1000);

    set({ costRetryTimer: timer, costRetryAt: Date.now() + seconds * 1000 });
  },

  setCostData: (data) => set({ costData: data }),

  // ── Resource Group Data ──
  rgData: null,
  rgLoading: false,
  rgError: null,

  loadRgCosts: async (opts = {}) => {
    const { selectedTenantId, selectedSubscriptionIds, months, dateMode, fromDate, toDate, imported, recomputeImported } = get();
    if (imported) return recomputeImported();
    if (!selectedTenantId || selectedSubscriptionIds.length === 0) return;
    set({ rgLoading: true, rgError: null });
    try {
      const payload = {
        tenant_id: selectedTenantId,
        subscription_ids: selectedSubscriptionIds,
        months,
        ...(dateMode === 'custom' && fromDate && toDate ? { from_date: fromDate, to_date: toDate } : {}),
      };
      await cached(
        `rg:${JSON.stringify(payload)}`,
        () => fetchRgCosts(payload),
        (data) => set({ rgData: data, rgLoading: false, rgError: null }),
        opts,
      );
      set({ rgLoading: false });
    } catch (err) {
      set({ rgLoading: false, rgError: err.response?.data?.detail || err.message });
    }
  },

  // ── Daily Cost Data ──
  dailyData: null,
  dailyLoading: false,
  dailyError: null,
  dailyRg: null,  // currently selected RG filter

  loadDailyCosts: async (resourceGroup = null, opts = {}) => {
    const { selectedTenantId, selectedSubscriptionIds, imported } = get();
    // An imported file has no daily granularity, so never fall back to Azure.
    if (imported) return set({ dailyData: null, dailyLoading: false, dailyRg: resourceGroup });
    if (!selectedTenantId || selectedSubscriptionIds.length === 0) return;
    set({ dailyLoading: true, dailyError: null, dailyRg: resourceGroup });
    try {
      const payload = {
        tenant_id: selectedTenantId,
        subscription_ids: selectedSubscriptionIds,
        months: 1,
        resource_group: resourceGroup,
      };
      await cached(
        `daily:${JSON.stringify(payload)}`,
        () => fetchDailyCosts(payload),
        (data) => set({ dailyData: data, dailyLoading: false, dailyError: null }),
        opts,
      );
      set({ dailyLoading: false });
    } catch (err) {
      set({ dailyLoading: false, dailyError: err.response?.data?.detail || err.message });
    }
  },

  // ── Per-meter monthly rows (month-over-month comparison) ──
  // Always asks for a span of several months, because comparing one month to
  // the next is impossible inside a single-month window. A custom range is
  // still honoured — widened backwards, never narrowed — so any month the user
  // picks, including the one in progress, actually has meter rows behind it.
  rowsData: null,
  rowsLoading: false,
  rowsError: null,

  loadCostRows: async (opts = {}) => {
    const { selectedTenantId, selectedSubscriptionIds, months, dateMode, fromDate, toDate, imported } = get();
    // An uploaded file already carries these rows; never overwrite them.
    if (imported) return;
    if (!selectedTenantId || selectedSubscriptionIds.length === 0) return;
    set({ rowsLoading: true, rowsError: null });
    try {
      const payload = {
        tenant_id: selectedTenantId,
        subscription_ids: selectedSubscriptionIds,
        months: Math.max(months || 1, 6),
      };
      // Without an explicit range the API only returns whole past months, so a
      // range covering the current month would come back with no meter rows at
      // all and every charge would collapse into a bare service total.
      if (dateMode === 'custom' && fromDate && toDate) {
        payload.from_date = widenBackByMonths(fromDate, 5);
        payload.to_date = toDate;
      }
      await cached(
        `rows:${JSON.stringify(payload)}`,
        () => fetchCostRows(payload),
        (data) => set({ rowsData: data, rowsLoading: false, rowsError: null }),
        opts,
      );
      set({ rowsLoading: false });
    } catch (err) {
      set({ rowsLoading: false, rowsError: err.response?.data?.detail || err.message });
    }
  },

  // ── Bandwidth / Data Transfer ──
  bandwidthData: null,
  bandwidthLoading: false,
  bandwidthError: null,

  loadBandwidth: async (opts = {}) => {
    const { selectedTenantId, selectedSubscriptionIds, months, dateMode, fromDate, toDate, imported, recomputeImported } = get();
    if (imported) return recomputeImported();
    if (!selectedTenantId || selectedSubscriptionIds.length === 0) return;
    set({ bandwidthLoading: true, bandwidthError: null });
    try {
      const payload = {
        tenant_id: selectedTenantId,
        subscription_ids: selectedSubscriptionIds,
        months,
        ...(dateMode === 'custom' && fromDate && toDate ? { from_date: fromDate, to_date: toDate } : {}),
      };
      await cached(
        `bandwidth:${JSON.stringify(payload)}`,
        () => fetchBandwidth(payload),
        (data) => set({ bandwidthData: data, bandwidthLoading: false, bandwidthError: null }),
        opts,
      );
      set({ bandwidthLoading: false });
    } catch (err) {
      set({ bandwidthLoading: false, bandwidthError: err.response?.data?.detail || err.message });
    }
  },

  // ── Imported file data (CSV / Excel / PDF) ──
  // When `imported` is set it takes over from the live Azure API for the
  // session. Every summary is recomputed locally, so the subscription and
  // date filters behave exactly like they do against live data.
  imported: readCache(IMPORT_KEY)?.value || null,

  setImported: (data) => {
    const subs = data.subscriptions || [];
    // Widen the date filter to cover the whole file. A range left over from the
    // live view (say "July only") would otherwise exclude every imported row
    // and the app would show zeroes for a file that parsed perfectly.
    const span = Math.max(data.months?.length || 1, 1);
    // Keep the import across reloads — otherwise navigating away silently drops
    // back to live Azure data and the file appears to have done nothing.
    writeCache(IMPORT_KEY, data);
    set({
      imported: data,
      subscriptions: subs,
      selectedSubscriptionIds: subs.map(s => s.subscription_id),
      months: span,
      dateMode: 'rolling',
      fromDate: null,
      toDate: null,
      dateKey: dateKeyOf('rolling', span),
      costError: null,
      bandwidthError: null,
      rgError: null,
    });
    get().recomputeImported();
  },

  /**
   * Add one more file to the import instead of replacing what is loaded.
   *
   * Azure exports a single billing period per file, so answering "why did the
   * bill go up?" means holding several of them at once.
   */
  addImport: (data) => {
    const merged = mergeImports(get().imported, data);
    get().setImported(merged);
    return merged;
  },

  /** Drop one file from a multi-file import, keeping the rest loaded. */
  removeImportFile: (fileName) => {
    const { imported } = get();
    if (!imported) return;
    const remaining = (imported.files || []).filter(f => f.file_name !== fileName);
    if (!remaining.length) return get().clearImported();

    const rows = imported.rows.filter(r => r.file !== fileName);
    let rebuilt = null;
    for (const f of remaining) {
      rebuilt = mergeImports(rebuilt, {
        ...f,
        currency: imported.currency,
        subscriptions: imported.subscriptions,
        rows: rows.filter(r => r.file === f.file_name),
      });
    }
    get().setImported({ ...rebuilt, currency: imported.currency });
  },

  /**
   * Correct the currency of an import.
   *
   * Partner / CSP usage reports bill in the customer's currency but carry no
   * currency column, so the parser has to guess. This lets the user say what
   * the amounts really are instead of reading INR figures behind a "$".
   */
  setImportCurrency: (currency) => {
    const { imported } = get();
    if (!imported) return;
    const next = { ...imported, currency };
    writeCache(IMPORT_KEY, next);
    set({ imported: next });
    get().recomputeImported();
  },

  clearImported: async () => {
    const { selectedTenantId } = get();
    writeCache(IMPORT_KEY, null);
    set({ imported: null, costData: null, bandwidthData: null, rgData: null, activeServices: [], subscriptions: [], selectedSubscriptionIds: [] });
    if (selectedTenantId) {
      await get().loadSubscriptions(selectedTenantId);
      await get().loadCosts();
    }
  },

  // ── BOQ (budget estimates) ──
  // Several estimates can be held at once so a multi-workload budget can be
  // compared against one bill. They persist like the import does.
  boqs: readCache(BOQ_KEY)?.value || [],

  addBoq: (boq) => {
    // Re-uploading the same estimate replaces it rather than double-counting.
    const next = [...get().boqs.filter(b => b.file_name !== boq.file_name), { ...boq, enabled: true }];
    writeCache(BOQ_KEY, next);
    set({ boqs: next });
  },

  removeBoq: (fileName) => {
    const next = get().boqs.filter(b => b.file_name !== fileName);
    writeCache(BOQ_KEY, next);
    set({ boqs: next });
  },

  toggleBoq: (fileName) => {
    const next = get().boqs.map(b => b.file_name === fileName ? { ...b, enabled: !b.enabled } : b);
    writeCache(BOQ_KEY, next);
    set({ boqs: next });
  },

  clearBoqs: () => {
    writeCache(BOQ_KEY, []);
    set({ boqs: [] });
  },

  /**
   * Meter-level usage rows for the active filters, or null when no meter-level
   * data is available at all. The BOQ comparison uses these to match individual
   * disks and VM sizes to their budget lines instead of stopping at the service
   * name. Uploaded files provide them directly; on a plain login they come from
   * `/costs/rows`, so BOQ vs Actual works without an import.
   */
  detailedUsageRows: () => {
    const { imported, rowsData, selectedSubscriptionIds, importedRowsInRange } = get();
    if (imported) return filterRows(importedRowsInRange(), selectedSubscriptionIds);
    if (rowsData?.rows?.length) {
      return filterRows(get().liveRowsInRange(), selectedSubscriptionIds);
    }
    return null;
  },

  /** Live per-meter rows narrowed to the active date filter. */
  liveRowsInRange: () => {
    const { rowsData, months, dateMode, fromDate, toDate } = get();
    const rows = rowsData?.rows || [];
    if (dateMode === 'custom' && fromDate && toDate) {
      const from = fromDate.slice(0, 7);
      const to = toDate.slice(0, 7);
      return rows.filter(r => r.month >= from && r.month <= to);
    }
    const available = rowsData?.months || [];
    const window = new Set(available.slice(-months));
    return rows.filter(r => window.has(r.month));
  },

  /** Rows of the import that fall inside the active date filter. */
  importedRowsInRange: () => {
    const { imported, months, dateMode, fromDate, toDate } = get();
    if (!imported) return [];
    const rows = imported.rows || [];

    if (dateMode === 'custom' && fromDate && toDate) {
      const from = fromDate.slice(0, 7);
      const to = toDate.slice(0, 7);
      return rows.filter(r => r.month >= from && r.month <= to);
    }

    const available = imported.months || [];
    const window = new Set(available.slice(-months));
    return rows.filter(r => window.has(r.month));
  },

  recomputeImported: () => {
    const { imported, selectedSubscriptionIds, importedRowsInRange } = get();
    if (!imported) return;
    const currency = imported.currency || 'USD';
    const rows = filterRows(importedRowsInRange(), selectedSubscriptionIds);
    set({
      // An import is a complete answer for the file it came from, and saying
      // so keeps the coverage line honest rather than absent — an absent
      // coverage reads as "unknown", which this is not.
      costData: {
        ...buildCostSummary(rows, currency),
        coverage: {
          source: imported.file_name
            ? `Imported file — ${imported.file_name}`
            : 'Imported file',
          fetched_at: new Date().toISOString(),
          requested_subscriptions: selectedSubscriptionIds.length,
          succeeded_subscriptions: selectedSubscriptionIds.length,
          failed_subscriptions: [],
          partial: false,
          errors: [],
        },
      },
      bandwidthData: buildBandwidthSummary(rows, currency),
      rgData: buildRgSummary(rows, currency),
      activeServices: buildServiceList(rows),
      costLoading: false,
      bandwidthLoading: false,
      rgLoading: false,
      servicesLoading: false,
    });
  },

  // ── Reserved vs on-demand spend ──
  // Reservation coverage is a property of live billing data. An uploaded export
  // rarely carries the PricingModel column, so this stays live-only rather than
  // reporting an import's missing column as "nothing is reserved".
  pricingData: null,
  pricingLoading: false,
  pricingError: null,

  loadPricing: async (opts = {}) => {
    const { selectedTenantId, selectedSubscriptionIds, months, dateMode, fromDate, toDate, imported } = get();
    if (imported) return;
    if (!selectedTenantId || selectedSubscriptionIds.length === 0) return;
    set({ pricingLoading: true, pricingError: null });
    try {
      const payload = {
        tenant_id: selectedTenantId,
        subscription_ids: selectedSubscriptionIds,
        months,
        ...(dateMode === 'custom' && fromDate && toDate ? { from_date: fromDate, to_date: toDate } : {}),
      };
      await cached(
        `pricing:${JSON.stringify(payload)}`,
        () => fetchPricing(payload),
        (data) => set({ pricingData: data, pricingLoading: false, pricingError: null }),
        opts,
      );
      set({ pricingLoading: false });
    } catch (err) {
      set({ pricingLoading: false, pricingError: err.response?.data?.detail || err.message });
    }
  },

  // ── Orphaned resources ──
  // Findings come from Resource Graph, which an uploaded file cannot provide:
  // a billing export lists charges, not what those resources are attached to.
  // So this dataset is live-only and simply stays empty during an import.
  orphanedData: null,
  orphanedLoading: false,
  orphanedError: null,

  loadOrphaned: async (opts = {}) => {
    const { selectedTenantId, selectedSubscriptionIds, imported } = get();
    if (imported) return;
    if (!selectedTenantId || selectedSubscriptionIds.length === 0) return;
    set({ orphanedLoading: true, orphanedError: null });
    try {
      const payload = {
        tenant_id: selectedTenantId,
        subscription_ids: selectedSubscriptionIds,
      };
      await cached(
        `orphaned:${JSON.stringify(payload)}`,
        () => fetchOrphaned(payload),
        (data) => set({ orphanedData: data, orphanedLoading: false, orphanedError: null }),
        opts,
      );
      set({ orphanedLoading: false });
    } catch (err) {
      set({ orphanedLoading: false, orphanedError: err.response?.data?.detail || err.message });
    }
  },

  // ── Active Services ──
  activeServices: [],
  servicesLoading: false,
  servicesError: null,
  loadServices: async (opts = {}) => {
    const { selectedTenantId, selectedSubscriptionIds, months, dateMode, fromDate, toDate, imported, recomputeImported } = get();
    if (imported) return recomputeImported();
    if (!selectedTenantId || !selectedSubscriptionIds.length) return;

    // The custom range has to reach the query, or picking a different month
    // would silently keep showing the rolling window's costs.
    const range = dateMode === 'custom' && fromDate && toDate
      ? { from_date: fromDate, to_date: toDate }
      : {};

    set({ servicesLoading: true, servicesError: null });
    try {
      await cached(
        `services:${selectedTenantId}:${selectedSubscriptionIds.join(',')}:${months}:${range.from_date || ''}:${range.to_date || ''}`,
        () => fetchServices(selectedTenantId, selectedSubscriptionIds, months, range),
        (data) => set({ activeServices: data, servicesLoading: false, servicesError: null }),
        opts,
      );
      set({ servicesLoading: false });
    } catch (err) {
      set({ servicesLoading: false, servicesError: err.response?.data?.detail || err.message });
    }
  },

  // ── Compute Intelligence ──
  //
  // Lives in the store rather than in the page so that /compute and /estate
  // share one answer. This endpoint fans out to Resource Graph, Cost
  // Management, Azure Monitor and Retail Prices; running it twice because the
  // user visited two pages is not merely slow, it is harmful — Monitor
  // throttles, and the second call can push the first into a 429 and turn a
  // working fleet into "Not enough data".
  //
  // The verdicts themselves are computed entirely on the backend. Nothing here
  // interprets, re-derives or adjusts them.
  computeData: null,
  computeLoading: false,
  computeError: null,

  loadCompute: async (opts = {}) => {
    const { selectedTenantId, selectedSubscriptionIds, imported } = get();
    // An uploaded billing file lists charges; it cannot say what a VM's CPU
    // did, so this dataset is live-only and simply stays empty during import.
    if (imported) return;
    if (!selectedTenantId || selectedSubscriptionIds.length === 0) return;
    set({ computeLoading: true, computeError: null });
    try {
      const payload = {
        tenant_id: selectedTenantId,
        subscription_ids: selectedSubscriptionIds,
        days: 30,
      };
      await cached(
        `compute:${JSON.stringify(payload)}`,
        () => fetchCompute(payload),
        (data) => set({ computeData: data, computeLoading: false, computeError: null }),
        opts,
      );
      set({ computeLoading: false });
    } catch (err) {
      set({ computeLoading: false, computeError: err.response?.data?.detail || err.message });
    }
  },

  // ── Activity log ──
  activityData: null,
  activityLoading: false,
  activityError: null,

  loadActivity: async (opts = {}) => {
    const { selectedTenantId, selectedSubscriptionIds, imported } = get();
    if (imported) return;
    if (!selectedTenantId || selectedSubscriptionIds.length === 0) return;
    const days = 7;
    set({ activityLoading: true, activityError: null });
    try {
      await cached(
        `activity:${selectedTenantId}:${selectedSubscriptionIds.join(',')}:${days}`,
        () => fetchActivity(selectedTenantId, selectedSubscriptionIds, { days }),
        (data) => set({ activityData: data, activityLoading: false, activityError: null }),
        opts,
      );
      set({ activityLoading: false });
    } catch (err) {
      set({ activityLoading: false, activityError: err.response?.data?.detail || err.message });
    }
  },

  // ── Governance & security posture ──
  //
  // Three separate Azure providers behind one flag pair. They are requested
  // together because the estate page shows them together, but each is stored
  // on its own: Defender is a paid tier many subscriptions do not have, and a
  // subscription that was never scanned must never be rendered as "0 findings".
  policyData: null,
  defenderData: null,
  advisorData: null,
  postureLoading: false,
  postureError: null,

  loadPosture: async (opts = {}) => {
    const { selectedTenantId, selectedSubscriptionIds, imported } = get();
    if (imported) return;
    if (!selectedTenantId || selectedSubscriptionIds.length === 0) return;
    const payload = {
      tenant_id: selectedTenantId,
      subscription_ids: selectedSubscriptionIds,
    };
    const key = JSON.stringify(payload);
    set({ postureLoading: true, postureError: null });

    // Settled, not all: Defender failing because the tier is not enabled must
    // not erase the Policy answer that arrived perfectly well beside it.
    const results = await Promise.allSettled([
      cached(`policy:${key}`, () => fetchPolicy(payload), (d) => set({ policyData: d }), opts),
      cached(`defender:${key}`, () => fetchDefender(payload), (d) => set({ defenderData: d }), opts),
      cached(`advisor:${key}`, () => fetchAdvisor(payload), (d) => set({ advisorData: d }), opts),
    ]);

    const failures = results.filter(r => r.status === 'rejected');
    set({
      postureLoading: false,
      postureError: failures.length === results.length
        ? (failures[0].reason?.response?.data?.detail || failures[0].reason?.message || 'Could not read governance or security data.')
        : null,
    });
  },

  // ── Access & RBAC ──
  //
  // Kept out of `loadPosture` on purpose. Both endpoints read every role
  // assignment in every selected subscription and the access review reads the
  // Activity Log on top of that, so they are the slowest pair in the
  // application. Firing them in the same wave as Defender and Advisor pushes
  // the whole group into Azure's throttle.
  accessData: null,
  rolesData: null,
  accessLoading: false,
  accessError: null,

  loadAccess: async (opts = {}) => {
    const { selectedTenantId, selectedSubscriptionIds, imported } = get();
    if (imported) return;
    if (!selectedTenantId || selectedSubscriptionIds.length === 0) return;
    const payload = {
      tenant_id: selectedTenantId,
      subscription_ids: selectedSubscriptionIds,
    };
    const key = JSON.stringify(payload);
    set({ accessLoading: true, accessError: null });

    const results = await Promise.allSettled([
      cached(`access:${key}`, () => fetchAccessReview(payload), (d) => set({ accessData: d }), opts),
      cached(`roles:${key}`, () => fetchRoleAssignments(payload), (d) => set({ rolesData: d }), opts),
    ]);

    const failures = results.filter(r => r.status === 'rejected');
    set({
      accessLoading: false,
      accessError: failures.length === results.length
        ? (failures[0].reason?.response?.data?.detail || failures[0].reason?.message || 'Could not read role assignments.')
        : null,
    });
  },

  // ── Refresh ──
  /**
   * Throw away every cached API answer and re-fetch what is on screen.
   *
   * Pressing Refresh has to mean "go and ask Azure again". Forcing only the
   * loaders for the current page left every other page serving a stale copy
   * from localStorage, so the cache is emptied first and each dataset the store
   * already holds is re-requested with the cache bypassed. Pages that are not
   * loaded yet simply have nothing cached to re-serve when they mount.
   *
   * An uploaded file and the BOQ list are the user's own data, not an Azure
   * answer, so they survive.
   */
  refreshAll: async () => {
    const s = get();
    evictApiCache();
    if (s.imported) {
      s.recomputeImported();
      return;
    }
    if (!s.selectedTenantId || s.selectedSubscriptionIds.length === 0) return;
    const force = { force: true };
    const jobs = [s.loadCosts(force), s.loadBandwidth(force), s.loadCostRows(force)];
    if (s.activeServices.length) jobs.push(s.loadServices(force));
    if (s.rgData) jobs.push(s.loadRgCosts(force));
    if (s.orphanedData) jobs.push(s.loadOrphaned(force));
    if (s.pricingData) jobs.push(s.loadPricing(force));
    if (s.dailyData) jobs.push(s.loadDailyCosts(null, force));
    if (s.computeData) jobs.push(s.loadCompute(force));
    if (s.activityData) jobs.push(s.loadActivity(force));
    if (s.policyData || s.defenderData || s.advisorData) jobs.push(s.loadPosture(force));
    if (s.accessData || s.rolesData) jobs.push(s.loadAccess(force));
    await Promise.allSettled(jobs);
  },
}));

// Re-apply a persisted import so the very first render already shows file data
// (subscription list, date span and every summary) instead of live Azure data.
if (restoredImport) useAppStore.getState().setImported(restoredImport);

