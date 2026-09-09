/**
 * A different person signing in must not inherit the last person's browser.
 *
 * Nothing in the cache is namespaced by account, and `cached()` paints a hit
 * before the network is consulted. So without this guard the new user's first
 * screen was the previous user's tenants and costs -- and it looked entirely
 * normal, because those were real figures, correctly formatted, about another
 * company.
 *
 * Sign-out used to be the only thing separating the two sessions, which made
 * isolation depend on the user having politely used the menu rather than
 * closing the tab or picking a different account at Microsoft's chooser.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readCache, rememberAccount, writeCache, writePrefs } from '../src/utils/persistCache';

// jsdom is not a dependency here, and the module only needs what it actually
// calls. The methods live on the prototype and the entries as own properties,
// because `evictAll` walks the store with `Object.keys` -- exactly as a real
// Storage behaves, and the one detail a naive stub gets wrong.
const storage = Object.create({
  getItem(k) { return Object.prototype.hasOwnProperty.call(this, k) ? this[k] : null; },
  setItem(k, v) { this[k] = String(v); },
  removeItem(k) { delete this[k]; },
});
globalThis.window = { localStorage: storage };

beforeEach(() => {
  for (const k of Object.keys(storage)) delete storage[k];
});

describe('rememberAccount', () => {
  it('keeps everything when the same person returns', () => {
    rememberAccount(1);
    writeCache('costs:x', { total: 42 });

    expect(rememberAccount(1)).toBe(false);
    expect(readCache('costs:x')?.value).toEqual({ total: 42 });
  });

  it('wipes the previous account cached answers', () => {
    rememberAccount(1);
    writeCache('costs:x', { total: 42 });
    writeCache('tenants', [{ tenant_id: 'foetron' }]);

    expect(rememberAccount(4)).toBe(true);
    expect(readCache('costs:x')).toBeNull();
    expect(readCache('tenants')).toBeNull();
  });

  it('drops the saved tenant and subscription selection too', () => {
    // It names a directory the new person may have no access to, and restoring
    // it would point their first page load straight at somebody else's estate.
    rememberAccount(1);
    writePrefs({ selectedTenantId: 'foetron', selectedSubscriptionIds: ['s-1'] });

    rememberAccount(4);
    expect(readCache('pref:ui')).toBeNull();
  });

  it('takes an uploaded file and the BOQ list with it', () => {
    // `evictApiCache` spares these because a refresh must not destroy the
    // user's own work. This is not a refresh, and it is not the same user.
    rememberAccount(1);
    writeCache('import:file', { rows: 3 });
    writeCache('boq:list', [{ id: 1 }]);

    rememberAccount(4);
    expect(readCache('import:file')).toBeNull();
    expect(readCache('boq:list')).toBeNull();
  });

  it('remembers who it switched to, so the next load is not another wipe', () => {
    rememberAccount(1);
    rememberAccount(4);
    writeCache('costs:x', { total: 7 });

    expect(rememberAccount(4)).toBe(false);
    expect(readCache('costs:x')?.value).toEqual({ total: 7 });
  });

  it('does not treat a first ever sign-in as a switch', () => {
    // There is nothing to protect anyone from yet, and reporting a change
    // would clear a cache that was just warmed by this same person.
    expect(rememberAccount(1)).toBe(false);
  });

  it('ignores a missing identifier rather than wiping on it', () => {
    rememberAccount(1);
    writeCache('costs:x', { total: 42 });

    expect(rememberAccount(undefined)).toBe(false);
    expect(readCache('costs:x')?.value).toEqual({ total: 42 });
  });
});
