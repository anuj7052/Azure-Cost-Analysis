import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAppStore } from '../../store/useAppStore';
import { usePageRefresh } from '../../store/usePageRefresh';
import { fetchBillingCategory } from '../../api/client';
import { errorMessage } from '../../utils/apiError';
import { dedupeRequest } from '../../utils/queryRequest';
import { BILLING_CATEGORIES, billingCategory } from '../../utils/billingCategories';
import { formatAmountFull } from '../../utils/currency';
import DataQuality from '../Common/DataQuality';
import { Button, ErrorState } from '../ui';

const PAGE_SIZE = 50;

function Report({ payload, category, subscriptions }) {
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [version, setVersion] = useState(0);
  const register = usePageRefresh(s => s.register);
  const refresh = useCallback(() => setVersion(v => v + 1), []);
  const serialized = JSON.stringify(payload);
  useEffect(() => register(refresh), [register, refresh]);
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError('');
    dedupeRequest(`billing-category:${serialized}`, () => fetchBillingCategory(JSON.parse(serialized)))
      .then(data => { if (live) { setResult(data); setPage(0); } })
      .catch(err => { if (live) setError(errorMessage(err)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [serialized, version]);
  const names = useMemo(() => Object.fromEntries(subscriptions.map(s => [s.subscription_id, s.display_name || s.name || s.subscription_id])), [subscriptions]);
  const rows = result?.rows || [];
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const full = value => formatAmountFull(value, result?.currency || 'USD');
  return <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-xl font-semibold text-slate-100">{category.label} details</h2><p className="mt-1 text-sm text-slate-400">Selected subscriptions and header date range · Actual cost</p></div><Button variant="secondary" size="sm" onClick={refresh} disabled={loading}>Refresh details</Button></div>
    <p className="rounded-xl border border-slate-800 p-4 text-sm leading-6 text-slate-400">{category.description} Spot, Savings Plan and missing pricing models are not reclassified as PAYG or RI.</p>
    {loading && <p role="status" className="text-sm text-slate-400">Loading {category.label} billing detail…</p>}
    {error && <ErrorState title="Could not load billing details" message={error} onRetry={refresh} />}
    {result && <>
      <DataQuality coverage={result.coverage} />
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-slate-800 bg-slate-900 p-5"><p className="text-sm text-slate-400">{result.coverage?.partial ? 'Partial amount' : 'Billed amount'}</p><p className="mt-2 text-2xl font-semibold text-slate-100">{full(result.total)}</p></div>
        <div className="rounded-xl border border-slate-800 bg-slate-900 p-5"><p className="text-sm text-slate-400">Named resources</p><p className="mt-2 text-2xl text-slate-100">{result.resource_count}</p></div>
        <div className="rounded-xl border border-slate-800 bg-slate-900 p-5"><p className="text-sm text-slate-400">Charges without a resource ID</p><p className="mt-2 text-2xl text-slate-100">{full(result.unattributed_cost)}</p></div>
      </div>
      {rows.length === 0 ? <p className="rounded-xl border border-slate-800 p-6 text-slate-400">No matching {category.label} charges were returned for this selection.</p> : <>
        <details className="rounded-xl border border-slate-800 p-4"><summary className="cursor-pointer text-sm font-semibold text-slate-300">Service totals ({result.services.length})</summary><ul className="mt-4 space-y-2">{result.services.map(item => <li key={item.service} className="flex justify-between gap-4 text-sm text-slate-400"><span>{item.service}</span><span>{full(item.cost)}</span></li>)}</ul></details>
        <div className="overflow-x-auto rounded-xl border border-slate-800"><table className="w-full text-left text-sm"><thead className="bg-slate-900 text-slate-400"><tr>{['Month', 'Subscription', 'Service', 'Resource group', 'Resource', 'Meter', 'Amount'].map(label => <th key={label} className="whitespace-nowrap px-4 py-3 font-medium">{label}</th>)}</tr></thead><tbody>{rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((row, index) => <tr key={`${page}:${index}`} className="border-t border-slate-800 text-slate-300"><td className="whitespace-nowrap px-4 py-3">{row.month || 'Not supplied'}</td><td className="px-4 py-3">{names[row.subscription_id] || row.subscription_id || 'Not supplied'}</td><td className="px-4 py-3">{row.service}</td><td className="px-4 py-3">{row.resource_group || 'Not attributed'}</td><td className="max-w-xs px-4 py-3"><span className="break-words">{row.resource_name || 'No resource attribution'}</span>{row.resource_id && <details className="mt-1 text-xs text-slate-400"><summary className="cursor-pointer">Full resource ID</summary><p className="mt-2 break-all">{row.resource_id}</p></details>}</td><td className="px-4 py-3">{row.meter || 'Not supplied'}</td><td className="whitespace-nowrap px-4 py-3 text-right tabular-nums">{full(row.cost)}</td></tr>)}</tbody></table></div>
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-slate-400"><span>{rows.length} billing rows · Page {page + 1} of {pages}</span><div className="flex gap-2"><Button variant="secondary" size="sm" disabled={page === 0} onClick={() => setPage(v => v - 1)}>Previous</Button><Button variant="secondary" size="sm" disabled={page + 1 >= pages} onClick={() => setPage(v => v + 1)}>Next</Button></div></div>
      </>}
      <p className="text-xs leading-6 text-slate-400">Quantities and unit rates are not supplied by this resource-level cost query. Missing resource attribution remains visible rather than being discarded.</p>
    </>}
  </div>;
}

export default function BillingCategoryDetails() {
  const [params, setParams] = useSearchParams();
  const category = billingCategory(params.get('category'));
  const { selectedTenantId, selectedSubscriptionIds, months, dateMode, fromDate, toDate, imported, subscriptions } = useAppStore();
  const payload = { tenant_id: selectedTenantId, subscription_ids: selectedSubscriptionIds, months, category: category.key, ...(dateMode === 'custom' ? { from_date: fromDate, to_date: toDate } : {}) };
  return <div className="space-y-5">
    <div className="flex flex-wrap gap-2" aria-label="Billing category filters">{BILLING_CATEGORIES.map(item => <button key={item.key} aria-pressed={category.key === item.key} onClick={() => setParams(previous => { const next = new URLSearchParams(previous); next.set('tab', 'billing'); next.set('category', item.key); return next; })} className={`rounded-xl border px-4 py-2 text-sm font-semibold ${category.key === item.key ? 'border-blue-500 bg-blue-600 text-white' : 'border-slate-700 text-slate-300 hover:border-blue-400'}`}>{item.label}</button>)}</div>
    {imported ? <p role="note" className="rounded-xl border border-amber-500/30 p-5 text-sm text-slate-300">This breakdown needs Azure PricingModel and resource billing dimensions. Exit imported-data mode and connect an Azure tenant to read these categories. Imported rows are not assumed to be PAYG.</p> : <Report key={JSON.stringify(payload)} payload={payload} category={category} subscriptions={subscriptions} />}
  </div>;
}
