import { useEffect, useState } from 'react';
import { fetchCostRows } from '../../api/client';
import { dedupeRequest } from '../../utils/queryRequest';
import { buildVariance } from '../../utils/costVariance';
import { rowMatches } from '../../utils/trendFilter';
import { formatAmountFull } from '../../utils/currency';
import { Callout, DataTable } from '../ui';

export default function ServiceMeterChanges({ query, service, filters, prior, current, currency }) {
  const [result, setResult] = useState(null);
  const requestKey = JSON.stringify(query);
  useEffect(() => {
    let live = true;
    dedupeRequest(`rows:${requestKey}`, () => fetchCostRows(JSON.parse(requestKey)))
      .then(data => { if (live) setResult({ data }); })
      .catch(error => { if (live) setResult({ error: error.message }); });
    return () => { live = false; };
  }, [requestKey]);
  if (!result) return <p role="status" className="mt-3 text-sm text-slate-400">Loading the meters behind this service…</p>;
  if (result.error) return <Callout title="Meter detail unavailable" tone="medium">{result.error}</Callout>;
  const rows = (result.data?.rows || []).filter(row => rowMatches(row, { ...filters, service }));
  const variance = buildVariance(rows, prior.month, current.month);
  const items = variance.groups.flatMap(group => group.items);
  const money = value => Number.isFinite(value) ? formatAmountFull(value, currency) : '—';
  const gap = current.total_cost - prior.total_cost - variance.delta;
  const why = item => {
    if (item.reason === 'new') return 'Newly billed in selected month';
    if (item.reason === 'removed') return 'No charge in selected month';
    if (!(item.prev_qty > 0 && item.curr_qty > 0)) return 'Usage/rate split unavailable: billed quantities missing';
    return `Quantity effect ${money(item.usage)}; effective-rate effect ${money(item.rate)}`;
  };
  return <div className="mt-4 space-y-3">
    <p className="text-xs text-slate-400">Meter-level comparison for {service}. New or absent billing does not by itself prove a resource was created or deleted. Effective rates can change with credits, tiers or pricing models.</p>
    {!!result.data?.errors?.length && <Callout title="Partial meter detail" tone="medium">{result.data.errors.map(error => error.error).join(' · ')}</Callout>}
    {Math.abs(gap) >= 0.01 && <Callout title="Detail does not fully reconcile" tone="medium">The meter deltas leave {money(gap)} of the summary change unexplained. The headline remains the Azure summary; meter amounts have not been scaled.</Callout>}
    <DataTable rows={items.map(item => ({ ...item, id: item.key }))} columns={[
      { key: 'meter', header: 'Meter / resource', render: row => row.meter || row.label },
      { key: 'resource_group', header: 'Resource group' },
      { key: 'prev_cost', header: prior.month, align: 'right', render: row => money(row.prev_cost) },
      { key: 'curr_cost', header: current.month, align: 'right', render: row => money(row.curr_cost) },
      { key: 'delta', header: 'Change', align: 'right', render: row => money(row.delta) },
      { key: 'reason', header: 'Why it changed', render: why },
    ]} />
  </div>;
}
