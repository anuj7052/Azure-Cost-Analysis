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

export function writeCache(key, value) {
  const store = safeStorage();
  if (!store) return;
  const payload = JSON.stringify({ t: Date.now(), v: value });
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

/** Persisted UI preferences (tenant + subscription selection, date range). */
export function readPrefs() {
  return readCache('pref:ui')?.value ?? null;
}

export function writePrefs(prefs) {
  writeCache('pref:ui', prefs);
}
