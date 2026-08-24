import { useEffect, useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import { fetchBandwidthTraffic } from '../api/client';

/**
 * The resource-level bandwidth breakdown, fetched once and shared.
 *
 * Two places need it: the "Track bandwidth data" section, and the per-meter
 * slide-over that has to answer "which VM produced *this* meter". Fetching it
 * twice would double a slow Azure call for identical data, so the request is
 * cached at module level and keyed on the selection that produced it.
 *
 * The cache is deliberately a single entry. Changing tenant, subscription or
 * date range invalidates it, which is correct: stale resource costs from a
 * different period are worse than a second of loading.
 */

let cache = { key: null, promise: null, data: null, error: null };

export function useBandwidthTraffic() {
  const selectedTenantId = useAppStore((s) => s.selectedTenantId);
  const selectedSubscriptionIds = useAppStore((s) => s.selectedSubscriptionIds);
  const months = useAppStore((s) => s.months);
  const fromDate = useAppStore((s) => s.fromDate);
  const toDate = useAppStore((s) => s.toDate);

  const subs = selectedSubscriptionIds || [];
  const ready = !!selectedTenantId && subs.length > 0;
  const key = [selectedTenantId, subs.join(','), months, fromDate, toDate].join('::');

  const [state, setState] = useState({ key: null, data: null, error: null });

  useEffect(() => {
    if (!ready) return undefined;
    let live = true;

    if (cache.key !== key) {
      cache = {
        key,
        data: null,
        error: null,
        promise: fetchBandwidthTraffic({
          tenant_id: selectedTenantId,
          subscription_ids: subs,
          months,
          from_date: fromDate,
          to_date: toDate,
        }),
      };
    }

    const pending = cache.promise;
    pending
      // fetchBandwidthTraffic already unwraps the axios envelope, so this is
      // the report itself. Reaching for .data again yields undefined, which
      // reads as "still loading" forever and shows an empty section.
      .then((report) => {
        if (report && typeof report === 'object') {
          if (cache.promise === pending) cache.data = report;
          if (live) setState({ key, data: report, error: null });
          return;
        }
        // Never leave the caller stuck on a loading state it cannot exit.
        const message = 'Azure returned an empty response for the resource breakdown.';
        if (cache.promise === pending) cache.error = message;
        if (live) setState({ key, data: null, error: message });
      })
      .catch((err) => {
        const message = err?.response?.data?.detail
          || err?.message
          || 'Could not read the resource breakdown.';
        if (cache.promise === pending) cache.error = message;
        if (live) setState({ key, data: null, error: message });
      });

    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ready]);

  const fresh = state.key === key;
  const data = fresh ? state.data : null;
  const error = fresh ? state.error : null;

  return { ready, data, error, loading: ready && !data && !error };
}

/**
 * The resources that were billed for one particular meter.
 *
 * Each row carries only that meter's share of the resource's cost, never the
 * resource total — a VM charged for three meters must not appear to have spent
 * all of it on the one being viewed.
 */
export function resourcesForMeter(data, meterName) {
  if (!data?.rows || !meterName) return [];

  const wanted = String(meterName).trim().toLowerCase();
  const rows = [];

  for (const row of data.rows) {
    const hit = (row.meters || []).find((m) => m.meter.trim().toLowerCase() === wanted);
    if (!hit) continue;
    rows.push({
      key: row.key,
      name: row.name,
      kind: row.kind,
      resource_group: row.resource_group,
      region: row.region,
      is_resource: row.is_resource,
      gb: hit.gb,
      quantity: hit.quantity,
      unit: hit.unit,
      unit_rate: hit.unit_rate,
      cost: hit.cost,
    });
  }

  return rows.sort((a, b) => b.cost - a.cost);
}
