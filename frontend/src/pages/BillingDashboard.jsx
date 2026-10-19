import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowUpRight, Building2, CalendarDays, ChevronDown, ChevronLeft, ChevronRight, Cloud, FileText, Layers, RefreshCw, ShieldCheck, TrendingUp, Wallet } from 'lucide-react';
import { fetchBillingDashboard, listBillingCustomers } from '../api/client';
import { errorMessage } from '../utils/apiError';
import { dashboardFilters, dashboardPayload, exactDays, monthRange, rollingRange } from '../utils/billingDashboard';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../components/billing-ui/card';
import { BillingPage, BillingNotice } from '../components/billing-ui/workspace';
import { ShareBreakdown } from '../components/Charts/CostDashboardCharts';

const control = 'mt-1.5 h-10 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100 outline-none focus-visible:ring-2 focus-visible:ring-blue-500';

function SummaryCard({ label, value, hint, icon: Icon, accent = 'blue' }) {
  return <Card><CardHeader className="pb-3"><div className="flex items-center justify-between gap-2"><CardTitle className="text-sm font-medium text-slate-400">{label}</CardTitle><Icon size={18} className={accent === 'green' ? 'text-emerald-400' : 'text-blue-400'} aria-hidden="true" /></div></CardHeader><CardContent><p className="text-2xl font-semibold tracking-tight tabular-nums">{value}</p><p className="mt-2 text-xs leading-5 text-slate-400">{hint}</p></CardContent></Card>;
}

function DashboardReport({ filters, onMetadata }) {
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const refreshKey = 0;
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
      <ShareBreakdown title="Billing by customer" description={`Our billing, ${currency}. Hover a slice or row.`} icon={Building2} items={billingItems} loading={loading} currency={currency} emptyMessage="No billing entered for this period." stacked listLimit={5} />
      <ShareBreakdown title="Distributor amount" description="Split by distributor." icon={FileText} items={distributorItems} loading={loading} currency={currency} emptyMessage="No distributor amounts for this period." stacked listLimit={5} />
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

const noop = () => {};

function periodLabel(filters) {
  const fmt = (d, opts) => new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', opts);
  if (filters.mode === 'rolling') return `Last ${filters.rolling || 1} month${filters.rolling > 1 ? 's' : ''}`;
  if (filters.mode === 'month') return fmt(filters.from, { month: 'short', year: 'numeric' });
  return `${fmt(filters.from, { day: 'numeric', month: 'short', year: 'numeric' })} – ${fmt(filters.to, { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

function CustomerPicker({ value, onChange }) {
  const [customers, setCustomers] = useState([]);
  useEffect(() => {
    let live = true;
    listBillingCustomers().then(data => { if (live) setCustomers((data.items || []).filter(c => !c.archived)); }).catch(() => {});
    return () => { live = false; };
  }, []);
  return <label className="relative inline-flex items-center">
    <span className="sr-only">Customer</span>
    <Building2 size={16} className="pointer-events-none absolute left-3 text-[#ea580c]" />
    <select value={value} onChange={e => onChange(e.target.value)}
      className="h-10 max-w-64 appearance-none rounded-lg border border-slate-700 bg-slate-900 pl-9 pr-8 text-sm font-semibold text-slate-200 shadow-sm hover:border-[#ea580c] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ea580c]">
      <option value="">All customers</option>
      {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
    </select>
    <ChevronDown size={14} className="pointer-events-none absolute right-3 text-slate-400" />
  </label>;
}

function PeriodPicker({ filters, year, month, change, tab }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState(filters.mode);
  const [pickYear, setPickYear] = useState(year);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = e => { if (e.type === 'keydown' ? e.key === 'Escape' : !ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close); document.addEventListener('keydown', close);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close); };
  }, [open]);
  const pick = patch => { change(patch); setOpen(false); };
  return <div ref={ref} className="relative w-fit">
    <button type="button" aria-haspopup="dialog" aria-expanded={open} onClick={() => { setView(filters.mode); setPickYear(year); setOpen(!open); }}
      className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm font-semibold text-slate-200 shadow-sm hover:border-[#ea580c] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ea580c]">
      <CalendarDays size={16} className="text-[#ea580c]" />{periodLabel(filters)}<ChevronDown size={14} className={`transition ${open ? 'rotate-180' : ''}`} />
    </button>
    {open && <div role="dialog" aria-label="Choose period" className="absolute right-0 z-30 mt-2 w-80 space-y-3 rounded-xl border border-slate-700 bg-slate-900 p-3 shadow-xl">
      <div className="grid grid-cols-3 rounded-lg bg-slate-800/60 p-1" role="tablist">
        {[['rolling', 'Rolling'], ['month', 'By Month'], ['range', 'Custom']].map(([value, label]) => <button key={value} type="button" role="tab" aria-selected={view === value} className={tab(view === value)} onClick={() => setView(value)}>{label}</button>)}
      </div>
      {view === 'rolling' && <div className="grid grid-cols-4 gap-2">{[1, 3, 6, 12].map(n => <button key={n} type="button" className={tab(filters.mode === 'rolling' && filters.rolling === n, 'border border-slate-700 py-2 text-sm')} onClick={() => pick({ mode: 'rolling', rolling: n, ...rollingRange(n) })}>{n}M</button>)}</div>}
      {view === 'month' && <div className="space-y-2">
        <div className="flex items-center justify-between"><button type="button" aria-label="Previous year" className={tab(false)} onClick={() => setPickYear(pickYear - 1)}><ChevronLeft size={16} /></button><span className="text-sm font-semibold text-slate-200">{pickYear}</span><button type="button" aria-label="Next year" className={tab(false)} onClick={() => setPickYear(pickYear + 1)}><ChevronRight size={16} /></button></div>
        <div className="grid grid-cols-4 gap-2">{Array.from({ length: 12 }, (_, i) => <button key={i} type="button" className={tab(filters.mode === 'month' && year === pickYear && month === i + 1, 'border border-slate-700 py-2')} onClick={() => pick({ mode: 'month', rolling: 0, ...monthRange(pickYear, i + 1) })}>{new Date(2000, i, 1).toLocaleString('en', { month: 'short' })}</button>)}</div>
      </div>}
      {view === 'range' && <CustomRange filters={filters} onApply={(from, to) => pick({ mode: 'range', rolling: 0, from, to })} />}
    </div>}
  </div>;
}

function CustomRange({ filters, onApply }) {
  const [from, setFrom] = useState(filters.from);
  const [to, setTo] = useState(filters.to);
  const valid = from && to && from <= to;
  return <div className="space-y-2">
    <div className="grid grid-cols-2 gap-2"><label className="text-xs text-slate-400">From<input type="date" className={control} value={from} onChange={e => setFrom(e.target.value)} /></label><label className="text-xs text-slate-400">To<input type="date" className={control} value={to} onChange={e => setTo(e.target.value)} /></label></div>
    <button type="button" disabled={!valid} className="w-full rounded-md bg-[#ea580c] py-2 text-sm font-semibold text-[#ffffff] disabled:opacity-50" onClick={() => onApply(from, to)}>Apply</button>
  </div>;
}

export default function BillingDashboard() {
  const [params, setParams] = useSearchParams();
  const filters = dashboardFilters(params);
  const change = patch => {
    const next = { ...filters, ...patch };
    setParams(Object.fromEntries(Object.entries(next).filter(([, value]) => value !== '' && value !== 0)));
  };
  const year = Number(filters.from.slice(0, 4)) || new Date().getFullYear();
  const month = Number(filters.from.slice(5, 7)) || 1;
  const tab = (on, extra = '') => `rounded-md px-3 py-1.5 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ea580c] ${on ? 'bg-[#ea580c] text-[#ffffff] shadow-sm' : 'text-slate-500 hover:bg-[#ffedd5] hover:text-[#9a3412]'} ${extra}`;
  return <BillingPage title="Billing overview" actions={<div className="flex flex-wrap items-center gap-2"><CustomerPicker value={filters.customer} onChange={customer => change({ customer })} /><PeriodPicker filters={filters} year={year} month={month} change={change} tab={tab} /></div>}>
    <DashboardReport key={JSON.stringify(filters)} filters={filters} onMetadata={noop} />
  </BillingPage>;
}
