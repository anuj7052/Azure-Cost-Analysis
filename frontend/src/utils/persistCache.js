/**
 * Small localStorage-backed cache so the app paints instantly on refresh.
 *
 * Cookies are capped at ~4 KB and are sent on every request, which is far too
 * small for a cost payload, so localStorage is used instead. Entries carry a
 * timestamp and are served stale-while-revalidate: a cached answer renders
 * immediately and the network refresh quietly replaces it when it lands.
 */

const PREFIX = 'aca:v1:';
const FRESH_MS = 15 * 60 * 1000;   // served without hitting the network
const STALE_MS = 24 * 60 * 60 * 1000; // served instantly, then revalidated

function safeStorage() {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null; // private mode / blocked storage
  }
}

/** Returns { value, age, fresh } or null when nothing usable is cached. */
export function readCache(key) {
  const store = safeStorage();
  if (!store) return null;
  try {
    const raw = store.getItem(PREFIX + key);
    if (!raw) return null;
    const { t, v } = JSON.parse(raw);
    const age = Date.now() - t;
    if (age > STALE_MS) {
      store.removeItem(PREFIX + key);
      return null;
    }
    return { value: v, age, fresh: age < FRESH_MS };
  } catch {
    return null;
  }
}

/**
 * Store a value.
 *
 * `stale: true` back-dates the entry so it still renders instantly on the next
 * visit but is always revalidated. Used for partial answers — showing them is
 * better than a blank page, trusting them for 15 minutes is not.
 */
export function writeCache(key, value, { stale = false } = {}) {
  const store = safeStorage();
  if (!store) return;
  const t = stale ? Date.now() - FRESH_MS : Date.now();
  const payload = JSON.stringify({ t, v: value });
  try {
    store.setItem(PREFIX + key, payload);
  } catch {
    // Quota exceeded — drop our own entries and retry once.
    evictAll();
    try {
      store.setItem(PREFIX + key, payload);
    } catch {
      /* give up, caching is best-effort */
    }
  }
}

/** Remove every cached API response (keeps user preferences). */
export function evictAll() {
  const store = safeStorage();
  if (!store) return;
  for (const key of Object.keys(store)) {
    if (key.startsWith(PREFIX) && !key.startsWith(PREFIX + 'pref:')) {
      store.removeItem(key);
    }
  }
}

/**
 * Remove cached Azure answers, keeping anything the user supplied.
 *
 * Used by Refresh: an uploaded usage file and the BOQ list are the user's own
 * data and re-fetching cannot bring them back, so wiping them would turn a
 * refresh into data loss.
 */
const KEEP = ['pref:', 'import:', 'boq:'];

export function evictApiCache() {
  const store = safeStorage();
  if (!store) return;
  for (const key of Object.keys(store)) {
    if (!key.startsWith(PREFIX)) continue;
    const name = key.slice(PREFIX.length);
    if (KEEP.some(p => name.startsWith(p))) continue;
    store.removeItem(key);
  }
}

/** Persisted UI preferences (tenant + subscription selection, date range). */
export function readPrefs() {
  return readCache('pref:ui')?.value ?? null;
}

export function writePrefs(prefs) {
  writeCache('pref:ui', prefs);
}

/**
 * Whose answers are currently sitting in this browser.
 *
 * Nothing above namespaces a key by account, so every entry here belongs to
 * whoever was last signed in -- and `cached()` paints a hit before the network
 * is even consulted. Signing in as somebody else on the same machine therefore
 * rendered the previous person's tenants, costs and resources instantly, and
 * they looked entirely normal because they were real figures, correctly
 * formatted, simply belonging to another company.
 *
 * `evictAll` on sign-out was the only thing standing between those two
 * sessions, which made data isolation depend on the user having politely used
 * the menu rather than closing the tab, letting the session lapse, or picking
 * a different account at Microsoft's chooser.
 *
 * Kept under `pref:` so the marker itself survives the eviction it triggers;
 * otherwise every load would look like a new person and wipe the cache it was
 * meant to protect.
 */
const ACCOUNT_KEY = 'pref:account';

export function rememberAccount(id) {
  const next = id ? String(id) : '';
  if (!next) return false;
  const previous = readCache(ACCOUNT_KEY)?.value ?? null;
  writeCache(ACCOUNT_KEY, next);
  if (previous === null || previous === next) return false;
  // Uploads and the BOQ list go too. `evictApiCache` keeps them because a
  // refresh must not destroy the user's own work -- but they are that user's
  // own work, and this is a different user.
  evictAll();
  // `evictAll` spares everything under `pref:`, which is what lets the marker
  // survive. The saved tenant and subscription selection must not: it names a
  // directory the new person may have no access to, and restoring it would
  // point their first page load straight at somebody else's estate.
  safeStorage()?.removeItem(PREFIX + 'pref:ui');
  writeCache(ACCOUNT_KEY, next);
  return true;
}
