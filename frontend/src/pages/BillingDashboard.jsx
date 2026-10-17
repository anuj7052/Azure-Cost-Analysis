import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowUpRight, Building2, CalendarDays, Cloud, FileText, Layers, RefreshCw, ShieldCheck, TrendingUp, Wallet } from 'lucide-react';
import { fetchBillingDashboard, listBillingCustomers } from '../api/client';
import { errorMessage } from '../utils/apiError';
import { dashboardFilters, dashboardPayload, exactDays, monthRange } from '../utils/billingDashboard';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../components/billing-ui/card';
import { BillingPage, BillingNotice } from '../components/billing-ui/workspace';
import { attentionCount, customerRows } from '../utils/billingPresentation';

const control = 'mt-1.5 h-10 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100 outline-none focus-visible:ring-2 focus-visible:ring-blue-500';
const action = 'inline-flex items-center justify-center gap-2 rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50';

function SummaryCard({ label, value, hint, icon: Icon, accent = 'blue' }) {
  return <Card><CardHeader className="pb-3"><div className="flex items-center justify-between gap-2"><CardTitle className="text-sm font-medium text-slate-400">{label}</CardTitle><Icon size={18} className={accent === 'green' ? 'text-emerald-400' : 'text-blue-400'} aria-hidden="true" /></div></CardHeader><CardContent><p className="text-2xl font-semibold tracking-tight tabular-nums">{value}</p><p className="mt-2 text-xs leading-5 text-slate-400">{hint}</p></CardContent></Card>;
}

function DashboardReport({ filters, onFilterChange, onMetadata }) {
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [settled, setSettled] = useState(-1);
  const [search, setSearch] = useState('');
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [showUsage, setShowUsage] = useState(false);
  const serialized = JSON.stringify(dashboardPayload(filters));
  const days = exactDays(filters.from, filters.to);
  const valid = days !== null && days <= 3661;
  const loading = valid && settled !== refreshKey;
  useEffect(() => {
    if (!valid) return undefined;
    let live = true;
    fetchBillingDashboard(JSON.parse(serialized)).then(data => {
      if (live) { setResult(data); setError(''); onMetadata(data); }
    }).catch(err => { if (live) setError(errorMessage(err)); })
      .finally(() => { if (live) setSettled(refreshKey); });
    return () => { live = false; };
  }, [serialized, refreshKey, valid, onMetadata]);
  const fmt = value => result?.currency_required ? 'Choose currency' : value == null ? 'Not entered' : `${result?.currency || ''} ${Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (!valid) return <p role="alert" className="rounded-xl border border-amber-500/30 p-5 text-amber-300">Choose valid start and end dates, in order, within a ten-year span.</p>;
  const rows = customerRows(result?.customers || [], search, attentionOnly);
  const customersToCheck = (result?.customers || []).filter(row => attentionCount(row) > 0).length;
  const customerLink = (row, needsReview = false) => `/azure-billing?customer=${encodeURIComponent(row.customer_id)}&view=${filters.source === 'invoices' ? 'bills' : 'monthly'}${needsReview ? '&review=1' : filters.mode === 'month' ? `&month=${filters.from.slice(0, 7)}` : ''}`;
  const max = Math.max(1, ...(result?.months || []).map(row => Number(row.customer_amount) || 0));
  return <div className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><p className="flex items-center gap-2 text-sm text-slate-400"><CalendarDays size={16} />{filters.from} → {filters.to} · <strong className="text-slate-200">{days} days</strong> · Both dates included</p><button className={action} disabled={loading} onClick={() => setRefreshKey(v => v + 1)}><RefreshCw size={15} className={loading ? 'animate-spin' : ''} />Refresh</button></div>
    {loading && <p role="status" className="text-sm text-slate-400">Loading billing dashboard…</p>}
    {error && <p role="alert" className="rounded-xl border border-red-500/30 p-4 text-sm text-red-400">{error}</p>}
    {result && <>
      <div className="flex items-center gap-2 text-xs text-slate-400"><ShieldCheck size={14} />{result.can_edit ? 'You can manage billing' : 'View-only access'}</div>
      {result.currency_required && <p role="alert" className="rounded-xl border border-amber-500/30 p-4 text-sm text-amber-300">Multiple billing currencies found. Select one currency above to see monetary totals; currencies are never added together.</p>}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <SummaryCard label="Customer billed" value={fmt(result.totals.customer_amount)} icon={Wallet} hint={filters.source === 'ledger' ? 'From your monthly records' : 'From checked invoices, before tax'} />
        <SummaryCard label="Distributor cost" value={fmt(result.totals.distributor_amount)} icon={FileText} hint="What your distributor has billed" />
        <SummaryCard label="Profit / loss" value={result.totals.profit == null ? 'Not ready' : fmt(result.totals.profit)} icon={TrendingUp} accent="green" hint={result.totals.profit == null ? 'Complete missing costs and check tax basis.' : 'Customer billed minus distributor cost'} />
      </div>
      <dl className="grid gap-4 rounded-xl border border-slate-800 bg-slate-900 px-5 py-4 sm:grid-cols-3">
        <div><dt className="flex items-center gap-2 text-xs text-slate-400"><Building2 size={15} />Customers</dt><dd className="mt-1 font-semibold">{result.customer_count} <span className="text-xs font-normal text-slate-400">· {result.customers_with_records} with records</span></dd></div>
        <div><dt className="flex items-center gap-2 text-xs text-slate-400"><Layers size={15} />Subscriptions / services</dt><dd className="mt-1 font-semibold">{result.workload_count} <span className="text-xs font-normal text-slate-400">customer records</span></dd></div>
        <div><dt className="flex items-center gap-2 text-xs text-slate-400"><Cloud size={15} />Azure usage · reference only</dt><dd className="mt-1 font-semibold tabular-nums">{fmt(result.totals.usage_amount)}</dd></div>
      </dl>
      {(result.review_count > 0 || result.unallocated_count > 0) && <BillingNotice>{result.review_count > 0 && `${result.review_count} records need checking. `}{result.unallocated_count > 0 && `${result.unallocated_count} charges cannot be split into daily amounts. `}<button className="rounded font-medium text-blue-400 underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500" onClick={() => { setSearch(''); setAttentionOnly(true); }}>Show affected customers</button></BillingNotice>}
      {result.prorated_count > 0 && <p className="text-xs text-amber-300">Estimated for the selected days: {result.prorated_count} recurring monthly amounts have been prorated.</p>}
      <div className="space-y-5">
        <Card>
          <CardHeader><CardTitle className="text-base">Customers at a glance</CardTitle><CardDescription>Open a company to review its bills or update a month.</CardDescription></CardHeader>
          <CardContent>
            <div className="mb-4 flex flex-wrap items-center gap-3">
              <input className={`${control} mt-0 sm:max-w-xs`} aria-label="Find a customer in report" placeholder="Find a company…" value={search} onChange={e => setSearch(e.target.value)} />
              <label className="flex min-h-10 items-center gap-2 rounded-lg border border-slate-700 px-3 text-xs text-slate-400"><input className="accent-blue-500 focus-visible:ring-2 focus-visible:ring-blue-500" type="checkbox" checked={attentionOnly} onChange={e => setAttentionOnly(e.target.checked)} /> Needs attention only ({customersToCheck})</label>
              <label className="flex min-h-10 items-center gap-2 text-xs text-slate-400"><input className="accent-blue-500 focus-visible:ring-2 focus-visible:ring-blue-500" type="checkbox" checked={showUsage} onChange={e => setShowUsage(e.target.checked)} /> Show Azure usage</label>
              {(search || attentionOnly || showUsage) && <button className={`${action} sm:ml-auto`} onClick={() => { setSearch(''); setAttentionOnly(false); setShowUsage(false); }}>Reset table</button>}
            </div>
            <div className="overflow-x-auto"><table className="w-full text-left text-sm">
              <caption className="sr-only">Customer billing for the selected dates</caption>
              <thead><tr>{['Customer', 'Billed', 'Distributor', ...(showUsage ? ['Azure usage'] : []), 'To check'].map(label => <th key={label} className="whitespace-nowrap border-b border-slate-800 px-3 py-3 text-xs font-medium text-slate-400">{label}</th>)}</tr></thead>
              <tbody>{rows.map(row => <tr key={row.customer_id} className="border-b border-slate-800 last:border-0">
                <td className="min-w-44 px-3 py-4"><Link to={customerLink(row, attentionOnly)} className="group inline-flex flex-col gap-1 rounded font-medium text-blue-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"><span className="group-hover:underline">{row.name}</span><span className="inline-flex items-center gap-1 text-xs font-normal">Open customer <ArrowUpRight size={12} aria-hidden="true" /></span></Link></td>
                {['customer_amount', 'distributor_amount', ...(showUsage ? ['usage_amount'] : [])].map(field => <td key={field} className="whitespace-nowrap px-3 tabular-nums">{fmt(row[field])}</td>)}
                <td className="px-3">{attentionCount(row) > 0 ? <Link className="inline-flex whitespace-nowrap rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-xs text-amber-300 underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500" aria-label={`Review ${attentionCount(row)} records for ${row.name}`} to={customerLink(row, true)}>{attentionCount(row)} to check</Link> : <span aria-label="No flagged records">—</span>}</td>
              </tr>)}</tbody>
            </table></div>
            {!rows.length && <p className="py-8 text-sm text-slate-400">{search.trim() ? 'No customers match this search. Clear it or reset the table to try again.' : attentionOnly ? 'No customers need attention for these dates.' : 'No customers to show for these dates.'}</p>}
            <p role="status" className="mt-4 text-xs text-slate-400">Showing {rows.length} of {result.customers.length} customers{attentionOnly ? ' · Needs attention' : ''}</p>
            {filters.customer && <button className={`${action} mt-4`} onClick={() => onFilterChange({ customer: '' })}>Show all customers</button>}
          </CardContent>
        </Card>
        <details className="rounded-xl border border-slate-800 bg-slate-900 p-5">
          <summary className="cursor-pointer text-sm font-semibold">Monthly breakdown</summary>
          <p className="mt-2 text-xs text-slate-400">Amounts allocated only to days inside this selection.</p>
          <div className="mt-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">{!result.months.length && <p className="text-sm text-slate-400">No allocated amounts in this period.</p>}{result.months.map(row => <div key={row.period}><div className="flex justify-between gap-2 text-sm"><span>{row.period}</span><span className="tabular-nums">{fmt(row.customer_amount)}</span></div><div className="mt-2 h-2 rounded-full bg-slate-800" aria-hidden="true"><div className="h-2 rounded-full bg-blue-500" style={{ width: result.currency_required ? '0%' : `${Math.max(0, Number(row.customer_amount) || 0) / max * 100}%` }} /></div><p className="mt-1 text-xs text-slate-400">{row.selected_days} of {row.calendar_days} calendar days · Distributor {fmt(row.distributor_amount)}</p></div>)}</div>
        </details>
        <details className="rounded-xl border border-slate-800 px-5 py-4 text-sm text-slate-400"><summary className="cursor-pointer">How are these amounts calculated?</summary><p className="mt-3 leading-7">{result.basis}</p><p className="mt-2 leading-7">For 16 Oct–16 Nov, recurring amounts use 16/31 of October plus 16/30 of November. Monthly records and invoices are separate sources. Missing amounts are not zero, and different currencies are never combined. Azure usage is a reference, not an additional expense. Reviewed invoices do not confirm payment.</p></details>
      </div>
    </>}
  </div>;
}

export default function BillingDashboard() {
  const [params, setParams] = useSearchParams();
  const filters = dashboardFilters(params);
  const [metadata, setMetadata] = useState(null);
  const [customers, setCustomers] = useState([]);
  const [customerError, setCustomerError] = useState('');
  useEffect(() => {
    let live = true;
    listBillingCustomers().then(data => { if (live) setCustomers(data.items.filter(c => !c.archived)); })
      .catch(err => { if (live) setCustomerError(errorMessage(err)); });
    return () => { live = false; };
  }, []);
  const change = patch => {
    const next = { ...filters, ...patch };
    setParams(Object.fromEntries(Object.entries(next).filter(([, value]) => value !== '')));
  };
  const year = Number(filters.from.slice(0, 4)) || new Date().getFullYear();
  const month = Number(filters.from.slice(5, 7)) || 1;
  const nowYear = new Date().getFullYear();
  const years = [...new Set([year, ...Array.from({ length: 16 }, (_, index) => nowYear - 10 + index)])].sort((a, b) => b - a);
  return <BillingPage title="Billing overview" description="See what you billed, what it cost, and what needs your attention." actions={<Link to="/azure-billing" className={action}>View customers <ArrowUpRight size={16} /></Link>}>
    <Card><CardContent className="pt-5"><div className="flex flex-wrap items-end gap-4">
      <label className="text-xs text-slate-400">Show<select className={control} value={filters.mode} onChange={e => change({ mode: e.target.value, ...(e.target.value === 'month' ? monthRange(year, month) : {}) })}><option value="month">A month</option><option value="range">Custom dates</option></select></label>
      {filters.mode === 'month' ? <><label className="text-xs text-slate-400">Month<select className={control} value={month} onChange={e => change(monthRange(year, e.target.value))}>{Array.from({ length: 12 }, (_, i) => <option key={i + 1} value={i + 1}>{new Date(2000, i, 1).toLocaleString('en', { month: 'long' })}</option>)}</select></label><label className="text-xs text-slate-400">Year<select className={control} value={year} onChange={e => change(monthRange(e.target.value, month))}>{years.map(value => <option key={value}>{value}</option>)}</select></label></> : <><label className="text-xs text-slate-400">From date<input type="date" className={control} value={filters.from} onChange={e => change({ from: e.target.value })} /></label><label className="text-xs text-slate-400">To date (inclusive)<input type="date" className={control} value={filters.to} onChange={e => change({ to: e.target.value })} /></label></>}
      <label className="text-xs text-slate-400">Customer<select className={`${control} max-w-64`} value={filters.customer} onChange={e => change({ customer: e.target.value })}><option value="">All customers</option>{customers.map(customer => <option key={customer.id} value={customer.id}>{customer.name}</option>)}</select></label>
      <button className={action} onClick={() => setParams({})}>Reset</button>
    </div><details className="mt-4 text-sm text-slate-400" open={metadata?.currency_required || undefined}><summary className="cursor-pointer">More options · {filters.source === 'ledger' ? 'Monthly records' : 'Checked invoices'} · {filters.currency || metadata?.currency || 'As recorded'}</summary><div className="mt-3 flex flex-wrap gap-4"><label className="text-xs text-slate-400">Use amounts from<select className={control} value={filters.source} onChange={e => change({ source: e.target.value, currency: '' })}><option value="ledger">Monthly records</option><option value="invoices">Checked invoice uploads</option></select></label><label className="text-xs text-slate-400">Currency<select className={control} value={filters.currency} onChange={e => change({ currency: e.target.value })}><option value="">Automatic (one currency only)</option>{[...new Set([...(metadata?.currencies || []), filters.currency].filter(Boolean))].map(value => <option key={value}>{value}</option>)}</select></label></div><p className="mt-3 text-xs">Keep these sources separate: the same bill may also appear in your monthly records.</p></details></CardContent></Card>
    {customerError && <p role="alert" className="text-sm text-red-400">Customer filter unavailable: {customerError}</p>}
    <DashboardReport key={JSON.stringify(filters)} filters={filters} onFilterChange={change} onMetadata={setMetadata} />
  </BillingPage>;
}
