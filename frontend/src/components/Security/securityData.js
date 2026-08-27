import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../store/useAppStore';

/*
 * Non-component helpers for the Access & Security pages.
 *
 * These live apart from SecurityShell.jsx only because Vite's fast refresh
 * requires a module to export components or plain values, never both.
 */

/**
 * Why a request produced no data. Every one of these renders differently,
 * because sending somebody to check their permissions when Azure merely rate
 * limited them wastes an afternoon.
 */
export const FAILURE = {
  NO_ACCESS: 'no_access',
  THROTTLED: 'throttled',
  API_ERROR: 'api_error',
  OFFLINE: 'offline',
};

export function classifyError(err) {
  const status = err?.response?.status;
  const detail = err?.response?.data?.detail;

  if (status === 401 || status === 403) {
    return {
      kind: FAILURE.NO_ACCESS,
      message: detail || 'You do not have permission to read this data.',
    };
  }
  if (status === 429) {
    return {
      kind: FAILURE.THROTTLED,
      message: detail || 'Azure is temporarily limiting requests. Please wait a moment and try again.',
    };
  }
  if (!err?.response) {
    return {
      kind: FAILURE.OFFLINE,
      message: err?.message || 'We could not reach the service. Check your connection and try again.',
    };
  }
  if (status >= 500) {
    return { kind: FAILURE.API_ERROR, message: 'Azure data could not be loaded.' };
  }
  return {
    kind: FAILURE.API_ERROR,
    message: detail || err?.message || 'Could not read from Azure.',
  };
}

/* -------------------------------------------------------------------------
 * The cache
 *
 * This lives at module scope, not in component state, and that is the whole
 * point. Previously each page held its answer in `useState`, so leaving the
 * page destroyed it: navigating from Access Optimization to Role Assignments
 * and back produced "Access data has not been scanned yet" over a tenant that
 * had been scanned ninety seconds earlier. Nothing was wrong with the fetch --
 * the result simply had nowhere to live that outlasted the component.
 *
 * Keying is what keeps that safe. An entry is only reused for the same source,
 * tenant, set of subscriptions and parameters, so one tenant's findings cannot
 * surface under another's name and deselecting a subscription cannot leave its
 * rows on screen. Subscriptions are sorted before they go into the key because
 * the selector's order is incidental and two identical selections must not
 * become two cache entries.
 * ---------------------------------------------------------------------- */

const CACHE = new Map();
const INFLIGHT = new Map();

function cacheKey(source, tenantId, subscriptionIds, paramsJson) {
  return JSON.stringify([source, tenantId, [...subscriptionIds].sort(), paramsJson]);
}

/**
 * Forget everything read from Azure.
 *
 * Called on sign-out. Keying by tenant already prevents one tenant's data being
 * shown under another, but a different person signing in on the same machine is
 * a different question, and the answer to it should not be "whatever happened
 * to be in memory from the last session".
 */
export function clearSecurityCache() {
  CACHE.clear();
  INFLIGHT.clear();
}

/** Test seam: what the cache currently holds, without exposing the map. */
export function securityCacheSize() {
  return CACHE.size;
}

const EMPTY = { data: null, error: null, failure: null, lastUpdated: null };

/**
 * Run one security endpoint, reusing what was already read.
 *
 * `source` is an explicit string rather than `fetcher.name` because the build
 * minifies function names, which would silently collapse all five pages onto a
 * single cache key in production and nowhere else.
 *
 * On mount, cached data appears immediately with no request at all. If nothing
 * has ever been read for this key, one read starts automatically -- the user
 * asked for the page, which is a clear enough request for its contents. A
 * failure is cached too, so a page that has just been refused with 403 does not
 * repeat the refusal on every visit.
 */
export function useSecurityQuery(fetcher, { source, params } = {}) {
  const tenantId = useAppStore(s => s.selectedTenantId);
  const subscriptionIds = useAppStore(s => s.selectedSubscriptionIds);

  // Serialised so callers can pass an object literal without memoising it.
  // Without this, every render would build a new key and start a new request.
  const paramsKey = JSON.stringify(params || {});
  const ready = Boolean(tenantId) && subscriptionIds.length > 0;
  const key = ready ? cacheKey(source, tenantId, subscriptionIds, paramsKey) : '';

  const [tick, setTick] = useState(0);
  const [loading, setLoading] = useState(false);

  // Every run gets a number. A slow response for a key the user has since
  // navigated away from must not overwrite the current one.
  const generation = useRef(0);
  const alive = useRef(true);
  // When this visit began. Anything read before it was read on an earlier
  // visit, which is exactly what "Cached" means -- and it is a far more honest
  // test than a flag on the entry, which would still say "fresh" an hour after
  // the tab was left open.
  // State rather than a ref, because this is read while rendering. A lazy
  // initialiser runs once per mounted component, which is exactly the meaning
  // wanted here: the instant this visit began.
  const [visitedAt] = useState(() => Date.now());
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const run = useCallback((extra = {}) => {
    if (!ready) return undefined;
    const { force = false, ...rest } = extra;
    const body = { ...JSON.parse(paramsKey), ...rest };
    // Extras beyond the declared params would change the answer without
    // changing the key, so they are folded into it.
    const runKey = cacheKey(source, tenantId, subscriptionIds, JSON.stringify(body));

    // A request already in flight for exactly this data is joined rather than
    // repeated. Two components mounting at once, or a double-click on Refresh,
    // used to mean two fan-outs across every selected subscription.
    const existing = INFLIGHT.get(runKey);
    if (existing && !force) return existing;

    const mine = ++generation.current;
    setLoading(true);

    const promise = fetcher({ tenant_id: tenantId, subscription_ids: subscriptionIds, ...body })
      .then((result) => {
        // A helper that already unwrapped the axios envelope returns the body
        // directly. Guarding on the shape means a malformed response ends the
        // spinner with an error rather than leaving it turning for ever.
        if (!result || typeof result !== 'object' || Array.isArray(result)) {
          const prev = CACHE.get(runKey) || EMPTY;
          CACHE.set(runKey, {
            ...prev,
            error: 'The server returned an unexpected response.',
            failure: FAILURE.API_ERROR,
          });
          return;
        }
        CACHE.set(runKey, {
          data: result, error: null, failure: null, lastUpdated: new Date(),
        });
      })
      .catch((err) => {
        const { kind, message } = classifyError(err);
        // Data from a previous successful run is kept. Replacing it with null
        // would turn a failed refresh into an apparently clean estate, which is
        // the most dangerous thing a security page can do.
        const prev = CACHE.get(runKey) || EMPTY;
        CACHE.set(runKey, { ...prev, error: message, failure: kind });
      })
      .finally(() => {
        INFLIGHT.delete(runKey);
        if (alive.current && mine === generation.current) {
          setLoading(false);
          setTick(n => n + 1);
        }
      });

    INFLIGHT.set(runKey, promise);
    return promise;
  }, [fetcher, source, tenantId, subscriptionIds, paramsKey, ready]);

  // The automatic first read. `CACHE.has` rather than a truthiness check, so
  // that a genuinely empty result and a remembered failure both count as
  // "already asked" and are not re-requested on every visit.
  useEffect(() => {
    if (!key || CACHE.has(key) || INFLIGHT.has(key)) return undefined;
    // Deferred by a microtask rather than called outright. `run` flips the
    // loading flag immediately, and doing that inside the effect body makes
    // the mount render twice before it has painted anything. Starting the
    // request just after the commit costs nothing and keeps the first paint --
    // the skeleton -- honest.
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled) run(); });
    return () => { cancelled = true; };
  }, [key, run]);

  // `tick` is read so the linter can see why it is state; the value itself is
  // meaningless. The cache is not reactive, so a render has to be provoked
  // whenever a run finishes.
  void tick;
  const entry = key ? CACHE.get(key) : null;

  return {
    ...(entry || EMPTY),
    // True when this page is showing something read during an earlier visit
    // rather than a moment ago. The header uses it to say "Cached" instead of
    // implying the figures came from Azure just now.
    cached: Boolean(entry?.lastUpdated) && entry.lastUpdated.getTime() < visitedAt,
    loading,
    loaded: Boolean(entry),
    run,
    ready,
  };
}

/**
 * SQLite stores UTC without a zone marker; without the Z the browser reads it
 * as local time and every snapshot appears hours out.
 */
export function when(timestamp) {
  if (!timestamp) return '—';
  const raw = String(timestamp);
  const date = new Date(`${raw.replace(' ', 'T')}${raw.endsWith('Z') ? '' : 'Z'}`);
  return Number.isNaN(date.getTime()) ? timestamp : date.toLocaleString();
}
