import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchCosts } from '../api/client';
import { readCache, writeCache } from '../utils/persistCache';
import { dedupeRequest, partialResponse } from '../utils/queryRequest';

/** Filters that require intersecting dimensions belong in Azure's query, not
 * in a monthly meter response that may not carry all those dimensions. */
export function useFilteredCosts(payload, enabled) {
  const key = enabled ? `filtered-costs:${JSON.stringify(payload)}` : '';
  const [result, setResult] = useState(null);
  const activeKey = useRef(key);
  useEffect(() => { activeKey.current = key; return () => { activeKey.current = ''; }; }, [key]);
  const refresh = useCallback(async () => {
    if (!key) return;
    try {
      const data = await dedupeRequest(key, () => fetchCosts(JSON.parse(key.slice('filtered-costs:'.length))));
      writeCache(key, data, { stale: partialResponse(data) });
      if (activeKey.current === key) setResult({ key, data });
    } catch (error) {
      if (activeKey.current === key) setResult(previous => ({ key, data: previous?.key === key ? previous.data : undefined, error: error.message || 'Filtered costs could not be loaded.' }));
    }
  }, [key]);
  useEffect(() => {
    if (!key) return;
    let live = true;
    const cached = readCache(key);
    const run = async () => {
      if (cached) setResult({ key, data: cached.value });
      if (cached?.fresh && !partialResponse(cached.value)) return;
      try {
        const data = await dedupeRequest(key, () => fetchCosts(JSON.parse(key.slice('filtered-costs:'.length))));
        writeCache(key, data, { stale: partialResponse(data) });
        if (live) setResult({ key, data });
      } catch (error) {
        if (live) setResult({ key, data: cached?.value, error: error.message || 'Filtered costs could not be loaded.' });
      }
    };
    run();
    return () => { live = false; };
  }, [key]);
  const current = result?.key === key ? result : null;
  return { data: current?.data, error: current?.error, loading: Boolean(key && !current), refresh };
}
