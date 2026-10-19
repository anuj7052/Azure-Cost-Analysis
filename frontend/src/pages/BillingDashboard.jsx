import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowUpRight, Building2, CalendarDays, Cloud, FileText, Layers, RefreshCw, ShieldCheck, TrendingUp, Wallet } from 'lucide-react';
import { fetchBillingDashboard, listBillingCustomers } from '../api/client';
import { errorMessage } from '../utils/apiError';
import { dashboardFilters, dashboardPayload, exactDays, monthRange } from '../utils/billingDashboard';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../components/billing-ui/card';
import { BillingPage, BillingNotice } from '../components/billing-ui/workspace';
import { ShareBreakdown } from '../components/Charts/CostDashboardCharts';

const control = 'mt-1.5 h-10 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100 outline-none focus-visible:ring-2 focus-visible:ring-blue-500';
const action = 'inline-flex items-center justify-center gap-2 rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50';

function SummaryCard({ label, value, hint, icon: Icon, accent = 'blue' }) {
  return <Card><CardHeader className="pb-3"><div className="flex items-center justify-between gap-2"><CardTitle className="text-sm font-medium text-slate-400">{label}</CardTitle><Icon size={18} className={accent === 'green' ? 'text-emerald-400' : 'text-blue-400'} aria-hidden="true" /></div></CardHeader><CardContent><p className="text-2xl font-semibold tracking-tight tabular-nums">{value}</p><p className="mt-2 text-xs leading-5 text-slate-400">{hint}</p></CardContent></Card>;
}

function DashboardReport({ filters, onMetadata }) {
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [settled, setSettled] = useState(-1);
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
  const fmtShort = value => (value == null ? '—' : Number(value).toLocaleString('en-IN', { maximumFractionDigits: 0 }));
  const currency = result?.currency || 'INR';
  const customers = (result?.customers || []).filter(r => r.customer_amount != null || r.distributor_amount != null);
  const billingItems = customers.filter(r => Number(r.customer_amount) > 0).map(r => ({ key: r.customer_id, name: r.name, cost: Number(r.customer_amount) })).sort((x, y) => y.cost - x.cost);
  const distributorItems = (result?.distributors || []).map(d => ({ key: d.name, name: d.name, cost: Number(d.amount) })).filter(d => d.cost > 0);
  const totals = result?.totals || {};
  const profit = totals.customer_amount != null && totals.distributor_amount != null ? Number(totals.customer_amount) - Number(totals.distributor_amount) : null;
  const splitItems = profit == null ? [] : [
    { key: 'dist', name: 'Paid to distributors', cost: Math.max(0, Number(totals.distributor_amount)) },
    { key: 'profit', name: profit >= 0 ? 'Our profit' : 'Loss', cost: Math.abs(profit) },
  ];
  const tiles = [
    ['Customers', result ? `${result.customers_with_records} of ${result.customer_count}` : '—', 'with billing this period', Building2, 'text-slate-100'],
    ['Our billing', fmt(totals.customer_amount), 'what we billed customers', Wallet, 'text-slate-100'],
    ['Distributor', fmt(totals.distributor_amount), 'what distributors charged us', FileText, 'text-slate-100'],
    [profit == null || profit >= 0 ? 'Profit' : 'Loss', profit == null ? 'Not ready' : fmt(Math.abs(profit)), profit == null ? 'needs both amounts' : 'billing minus distributor', TrendingUp, profit == null ? 'text-slate-400' : profit >= 0 ? 'text-emerald-400' : 'text-rose-400'],
  ];
  return <div className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><p className="flex items-center gap-2 text-sm text-slate-400"><CalendarDays size={16} />{filters.from} → {filters.to} · {days} days</p><button className={action} disabled={loading} onClick={() => setRefreshKey(v => v + 1)}><RefreshCw size={15} className={loading ? 'animate-spin' : ''} />Refresh</button></div>
    {error && <p role="alert" className="rounded-xl border border-red-500/30 p-4 text-sm text-red-400">{error}</p>}
    {result?.currency_required && <p role="alert" className="rounded-xl border border-amber-500/30 p-4 text-sm text-amber-300">Several currencies found. Choose one under More options to see totals; currencies are never added together.</p>}
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {tiles.map(([label, value, hint, Icon, tone]) => (
        <Card key={label}><CardContent className="p-5">
          <div className="flex items-center justify-between"><p className="text-xs font-medium text-slate-400">{label}</p><span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#ffedd5] text-[#c2410c]"><Icon size={16} aria-hidden="true" /></span></div>
          <p className={`mt-2 truncate text-2xl font-bold tabular-nums ${tone}`}>{loading && !result ? '…' : value}</p>
          <p className="mt-1 text-xs text-slate-500">{hint}</p>
        </CardContent></Card>
      ))}
    </div>
    <div className="grid gap-5 xl:grid-cols-3">
      <ShareBreakdown title="Billing by customer" description={`Our billing, ${currency}. Hover a slice or row.`} icon={Building2} items={billingItems} loading={loading} currency={currency} emptyMessage="No billing entered for this period." stacked />
      <ShareBreakdown title="Distributor amount" description="Split by distributor." icon={FileText} items={distributorItems} loading={loading} currency={currency} emptyMessage="No distributor amounts for this period." stacked />
      <ShareBreakdown title="Where our billing goes" description="Distributor cost versus what we keep." icon={TrendingUp} items={splitItems} loading={loading} currency={currency} emptyMessage="Needs both billing and distributor amounts." stacked />
    </div>
    {customers.length > 0 && (
      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-base">By customer</CardTitle><CardDescription>Click a customer to open it.</CardDescription></CardHeader>
        <CardContent className="overflow-x-auto pt-0">
          <table className="w-full min-w-[34rem] text-sm">
            <thead><tr className="border-b border-slate-800 text-left text-xs text-slate-500">{['Customer', 'Our billing', 'Distributor', 'Profit / loss'].map(h => <th key={h} className={`px-3 py-2 font-medium ${h !== 'Customer' ? 'text-right' : ''}`}>{h}</th>)}</tr></thead>
            <tbody>{customers.map(r => {
              const p = r.customer_amount != null && r.distributor_amount != null ? Number(r.customer_amount) - Number(r.distributor_amount) : null;
              return <tr key={r.customer_id} className="border-b border-slate-800/60 last:border-0">
                <td className="px-3 py-2.5"><Link to={`/azure-billing/entries?customer=${encodeURIComponent(r.customer_id)}`} className="font-medium text-slate-200 hover:text-[#c2410c] hover:underline">{r.name}</Link></td>
                <td className="px-3 py-2.5 text-right tabular-nums">{fmtShort(r.customer_amount)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{fmtShort(r.distributor_amount)}</td>
                <td className={`px-3 py-2.5 text-right font-semibold tabular-nums ${p == null ? 'text-slate-500' : p >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{fmtShort(p)}</td>
              </tr>;
            })}</tbody>
          </table>
        </CardContent>
      </Card>
    )}
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
    <DashboardReport key={JSON.stringify(filters)} filters={filters} onMetadata={setMetadata} />
  </BillingPage>;
}
