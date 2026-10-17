import { useEffect, useState } from 'react';
import { fetchBillingCategory } from '../api/client';

/*
 * How each charge was billed — Reserved (RI) or Pay-as-you-go — read from
 * Azure's PricingModel through the billing-category endpoint, never guessed
 * from names. One request per type per query, shared across every category
 * panel that asks.
 */

const cache = new Map();
const norm = v => String(v || '').trim().toLowerCase();
export const typeKey = (resourceGroup, meter) => `${norm(resourceGroup)}::${norm(meter)}`;

/** DR / ASR is only claimed where Azure names the service or meter Site Recovery. */
export const isSiteRecovery = (...texts) => texts.some(t => /site recovery|\basr\b/i.test(String(t || '')));

export function buildTypeIndex(results) {
  const index = new Map();
  for (const [type, data] of Object.entries(results)) {
    for (const row of data?.rows || []) {
      for (const key of [typeKey(row.resource_group, row.meter), typeKey('', row.meter)]) {
        const set = index.get(key) || new Set();
        set.add(type);
        index.set(key, set);
      }
    }
  }
  return index;
}

/** Types for one charge: exact resource group + meter first, then meter alone. */
export function typesFor(index, { resource_group: rg, meter, label, service }) {
  const name = meter || String(label || '').split(' · ')[0];
  const found = index?.get(typeKey(rg, name)) || index?.get(typeKey('', name)) || new Set();
  const out = [...found];
  if (isSiteRecovery(service, name, label)) out.push('asr');
  return out;
}

export function useBillingTypes(query) {
  const key = query ? JSON.stringify(query) : '';
  const [state, setState] = useState(() => ({ key, index: cache.get(key)?.index || null, error: '' }));
  useEffect(() => {
    if (!key) return undefined;
    let live = true;
    let entry = cache.get(key);
    if (!entry) {
      const body = JSON.parse(key);
      const promise = Promise.all(['ri', 'payg'].map(category =>
        fetchBillingCategory({ ...body, category }).then(data => [category, data]).catch(() => [category, null]),
      )).then(pairs => {
        const results = Object.fromEntries(pairs);
        const failed = pairs.every(([, data]) => !data);
        entry.index = failed ? null : buildTypeIndex(results);
        entry.error = failed ? 'Azure did not return the pricing model.' : '';
        return entry;
      });
      entry = { promise, index: null, error: '' };
      cache.set(key, entry);
    }
    entry.promise.then(done => { if (live) setState({ key, index: done.index, error: done.error }); });
    return () => { live = false; };
  }, [key]);
  const current = state.key === key ? state : { index: cache.get(key)?.index || null, error: '' };
  return { index: current.index, loading: Boolean(key) && !current.index && !current.error, error: current.error };
}
