import { create } from 'zustand';
import { fetchTenants, fetchSubscriptions, fetchCosts, fetchCostRows, fetchServices, fetchRgCosts, fetchDailyCosts, fetchBandwidth } from '../api/client';
import { buildBandwidthSummary, buildCostSummary, buildRgSummary, buildServiceList, filterRows, mergeImports } from '../utils/importAnalytics';
import { readCache, readPrefs, writeCache, writePrefs } from '../utils/persistCache';

/**
 * Azure Cost Management throttles hard (HTTP 429). Several pages mount effects
 * that request the same data at the same time, so identical in-flight requests
 * share a single promise instead of hitting the API once per caller.
 */
const inFlight = new Map();

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

      // Keep the saved selection when it still matches; otherwise select all active.
      const activeIds = subs.filter(s => s.state === 'Enabled').map(s => s.subscription_id);
      const saved = get().selectedSubscriptionIds.filter(id => activeIds.includes(id));
      set({ selectedSubscriptionIds: saved.length ? saved : activeIds });
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
      await cached(
        `costs:${JSON.stringify(payload)}`,
        () => fetchCosts(payload),
        (data) => set({ costData: data, costLoading: false, costError: null }),
        opts,
      );
      set({ costLoading: false });
    } catch (err) {
      set({ costLoading: false, costError: err.response?.data?.detail || err.message });
    }
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
  // Deliberately ignores the date filter and always asks for a span of months:
  // comparing one month to the next is impossible inside a single-month window.
  rowsData: null,
  rowsLoading: false,
  rowsError: null,

  loadCostRows: async (opts = {}) => {
    const { selectedTenantId, selectedSubscriptionIds, months, imported } = get();
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
      costData: buildCostSummary(rows, currency),
      bandwidthData: buildBandwidthSummary(rows, currency),
      rgData: buildRgSummary(rows, currency),
      activeServices: buildServiceList(rows),
      costLoading: false,
      bandwidthLoading: false,
      rgLoading: false,
      servicesLoading: false,
    });
  },

  // ── Active Services ──
  activeServices: [],
  servicesLoading: false,
  loadServices: async (opts = {}) => {
    const { selectedTenantId, selectedSubscriptionIds, imported, recomputeImported } = get();
    if (imported) return recomputeImported();
    if (!selectedTenantId || !selectedSubscriptionIds.length) return;

    set({ servicesLoading: true });
    try {
      await cached(
        `services:${selectedTenantId}:${selectedSubscriptionIds.join(',')}`,
        () => fetchServices(selectedTenantId, selectedSubscriptionIds),
        (data) => set({ activeServices: data, servicesLoading: false }),
        opts,
      );
      set({ servicesLoading: false });
    } catch {
      set({ servicesLoading: false });
    }
  },
}));

// Re-apply a persisted import so the very first render already shows file data
// (subscription list, date span and every summary) instead of live Azure data.
if (restoredImport) useAppStore.getState().setImported(restoredImport);

