import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { BadgeCheck, ChevronRight, Loader2, RefreshCw, RotateCcw, Search, ShieldCheck, SlidersHorizontal, Tag, X } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { usePageRefresh } from '../../store/usePageRefresh';
import { fetchBillingCategory } from '../../api/client';
import { errorMessage } from '../../utils/apiError';
import { dedupeRequest } from '../../utils/queryRequest';
import { BILLING_CATEGORIES, billingCategory } from '../../utils/billingCategories';
import { formatAmountFull } from '../../utils/currency';
import { buildSeries, dayLabel, monthLabel } from '../../utils/costDashboardSeries';
import { SpendOverTime } from './CostDashboardCharts';
import { Button, Input, Label, NativeSelect } from '../shadcn';
import { Card, CardContent } from '../billing-ui/card';
import { ErrorState } from '../ui';

/*
 * Billing categories — Pay-as-you-go, RI and DR / ASR — laid out like Trend &
 * forecast: category tabs with their totals, headline figures, a stacked
 * monthly chart that can be grouped, the share by service, then every
 * resource with the meters that billed it. All amounts are Azure actual cost
 * from the PricingModel dimension (RI, PAYG) or the Site Recovery service
 * (DR / ASR); nothing is inferred from names.
 */

const ICONS = { payg: Tag, ri: BadgeCheck, asr: ShieldCheck };
const GROUPS = [
  ['service', 'Service'],
  ['resource_group', 'Resource group'],
  ['subscription_id', 'Subscription'],
  ['meter', 'Meter'],
];
const PAGE = 25;

/**
 * All three categories, fetched one after another with the selected one first:
 * three resource-level queries across every subscription at once get
 * throttled by Azure and time out.
 */
function useCategories(base, first, version) {
  const serialized = JSON.stringify(base);
  const [state, setState] = useState({ key: '', results: {} });
  useEffect(() => {
    let live = true;
    const key = `${serialized}:${version}`;
    const order = [first, ...['payg', 'ri', 'asr'].filter(k => k !== first)];
    (async () => {
      for (const category of order) {
        const body = { ...JSON.parse(serialized), category };
        let entry;
        try {
          entry = { data: await dedupeRequest(`billing-category:${JSON.stringify(body)}:${version}`, () => fetchBillingCategory(body)), error: '' };
        } catch (err) {
          entry = { data: null, error: errorMessage(err) };
        }
        if (!live) return;
        setState(prev => ({ key, results: { ...(prev.key === key ? prev.results : {}), [category]: entry } }));
      }
    })();
    return () => { live = false; };
  }, [serialized, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const results = state.key === `${serialized}:${version}` ? state.results : {};
  const pick = k => ({ ...(results[k] || { data: null, error: '' }), loading: !results[k] });
  return { payg: pick('payg'), ri: pick('ri'), asr: pick('asr') };
}

function filterRows(rows, filters, names) {
  const needle = filters.search.trim().toLowerCase();
  return rows.filter(row =>
    (!filters.subscription || row.subscription_id === filters.subscription)
    && (!filters.resource_group || (row.resource_group || '') === filters.resource_group)
    && (!filters.service || row.service === filters.service)
    && (!needle || [row.resource_name, row.resource_group, row.service, row.meter, names[row.subscription_id]].join(' ').toLowerCase().includes(needle)));
}

function Report({ rows, currency, category, names, groupBy, daily }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(null);
  const [page, setPage] = useState(0);
  const money = v => formatAmountFull(v, currency);
  const total = rows.reduce((sum, row) => sum + row.cost, 0);
  const label = useCallback((row, key) => (key === 'subscription_id' ? names[row.subscription_id] || (row.subscription_id ? 'Unnamed subscription' : 'Not supplied') : row[key] || (key === 'resource_group' ? 'No resource group' : 'Not supplied')), [names]);

  const series = useMemo(() => {
    const periods = new Map();
    for (const row of rows) {
      const key = daily ? row.date || row.month : row.month;
      const m = periods.get(key) || { total: 0, split: {} };
      const name = label(row, groupBy);
      m.total += row.cost;
      m.split[name] = (m.split[name] || 0) + row.cost;
      periods.set(key, m);
    }
    const name = key => (daily && /^\d{4}-\d{2}-\d{2}$/.test(key) ? dayLabel(key) : monthLabel(key));
    return buildSeries([...periods.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, m]) => ({ key, label: name(key), full: name(key), total: m.total, byService: m.split })));
  }, [rows, groupBy, label, daily]);

  const resources = useMemo(() => {
    const map = new Map();
    for (const row of rows) {
      const key = row.resource_id ? row.resource_id.toLowerCase() : `none:${row.subscription_id}:${row.service}`;
      const item = map.get(key) || { key, name: row.resource_name || `${row.service} (no single resource)`, resource_id: row.resource_id, resource_group: row.resource_group, subscription_id: row.subscription_id, services: new Set(), meters: new Map(), cost: 0 };
      item.cost += row.cost;
      item.services.add(row.service);
      const meter = row.meter || 'Not supplied';
      item.meters.set(meter, (item.meters.get(meter) || 0) + row.cost);
      map.set(key, item);
    }
    const needle = query.trim().toLowerCase();
    return [...map.values()]
      .map(r => ({ ...r, services: [...r.services], meters: [...r.meters.entries()].sort((a, b) => b[1] - a[1]) }))
      .filter(r => !needle || [r.name, r.resource_group, names[r.subscription_id], ...r.services, ...r.meters.map(([m]) => m)].join(' ').toLowerCase().includes(needle))
      .sort((a, b) => b.cost - a.cost);
  }, [rows, query, names]);
  const pages = Math.max(1, Math.ceil(resources.length / PAGE));
  const shown = resources.slice(page * PAGE, (page + 1) * PAGE);

  if (!rows.length) {
    return <Card><CardContent className="p-10 text-center text-sm text-slate-400">No {category.label} charges for this selection.</CardContent></Card>;
  }

  return (
    <div className="space-y-5">
      <SpendOverTime
        key={`${category.key}:${groupBy}`}
        series={series}
        daily={daily}
        currency={currency}
        showSummary={false}
        groupLabel={GROUPS.find(([v]) => v === groupBy)[1]}
        description={`${category.label} actual cost each ${daily ? 'day' : 'month'}, split by ${GROUPS.find(([v]) => v === groupBy)[1].toLowerCase()}. Hover a ${daily ? "day" : "month"} for the breakdown.`}
      />

      <Card>
        <div className="flex flex-wrap items-end justify-between gap-3 border-b border-slate-800 p-5">
          <div>
            <h2 className="text-base font-semibold text-slate-100">{category.label} resources</h2>
            <p className="mt-1 text-sm text-slate-400">{resources.length} resources, highest first. Click one to see the meters it was billed on.</p>
          </div>
          <div className="relative w-full sm:w-72">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" aria-hidden="true" />
            <Input value={query} onChange={e => { setQuery(e.target.value); setPage(0); }} placeholder="Find in this list…" aria-label="Find a resource" className="pl-8 pr-8" />
            {query && <button type="button" aria-label="Clear search" onClick={() => setQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-200"><X className="h-4 w-4" /></button>}
          </div>
        </div>
        {!shown.length ? <p className="p-8 text-center text-sm text-slate-400">No resources match this search.</p> : (
          <ul className="divide-y divide-slate-800">
            {shown.map(r => {
              const isOpen = open === r.key;
              const share = total ? (r.cost / total) * 100 : 0;
              return (
                <li key={r.key}>
                  <button type="button" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : r.key)} className="flex w-full items-center gap-3 px-5 py-3 text-left hover:bg-slate-800/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#ea580c]">
                    <ChevronRight className={`h-4 w-4 shrink-0 text-[#ea580c] transition-transform ${isOpen ? 'rotate-90' : ''}`} aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-slate-100" title={r.resource_id || r.name}>{r.name}</p>
                      <p className="truncate text-[11px] text-slate-500">{r.services.join(', ')} · {r.resource_group || 'No resource group'} · {names[r.subscription_id] || 'Unnamed subscription'}</p>
                    </div>
                    <div className="hidden w-28 shrink-0 sm:block"><div className="h-1.5 rounded-full bg-slate-800"><div className="h-1.5 rounded-full bg-[#EA580C]" style={{ width: `${Math.max(share, 0.5)}%` }} /></div></div>
                    <span className="w-14 shrink-0 text-right text-[11px] text-slate-500">{share.toFixed(1)}%</span>
                    <span className="w-32 shrink-0 text-right text-sm font-semibold tabular-nums text-slate-100">{money(r.cost)}</span>
                  </button>
                  {isOpen && (
                    <div className="border-t border-slate-800 bg-slate-950/40 px-12 py-3">
                      <ul className="space-y-1.5">
                        {r.meters.map(([meter, cost]) => <li key={meter} className="flex justify-between gap-3 text-xs"><span className="truncate text-slate-300">{meter}</span><span className="tabular-nums text-slate-200">{money(cost)}</span></li>)}
                      </ul>
                      {r.resource_id && <p className="mt-2 break-all text-[11px] text-slate-500">{r.resource_id}</p>}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {pages > 1 && (
          <div className="flex items-center justify-between gap-3 border-t border-slate-800 px-5 py-3 text-xs text-slate-400">
            <span>Page {page + 1} of {pages}</span>
            <span className="flex gap-2">
              <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(v => v - 1)}>Previous</Button>
              <Button variant="outline" size="sm" disabled={page + 1 >= pages} onClick={() => setPage(v => v + 1)}>Next</Button>
            </span>
          </div>
        )}
      </Card>
      <p className="text-xs leading-5 text-slate-500">{category.description}</p>
    </div>
  );
}

const EMPTY = { search: '', subscription: '', resource_group: '', service: '' };

export default function BillingCategoryDetails() {
  const [params, setParams] = useSearchParams();
  const category = billingCategory(params.get('category'));
  const { selectedTenantId, selectedSubscriptionIds, months, dateMode, fromDate, toDate, imported, subscriptions } = useAppStore();
  const [version, setVersion] = useState(0);
  const register = usePageRefresh(s => s.register);
  const refresh = useCallback(() => setVersion(v => v + 1), []);
  useEffect(() => register(refresh), [register, refresh]);
  // One calendar month selected → ask Azure for days so the chart shows each day.
  const daily = dateMode === 'custom' && fromDate && toDate ? fromDate.slice(0, 7) === toDate.slice(0, 7) : months === 1;
  const base = { tenant_id: selectedTenantId, subscription_ids: selectedSubscriptionIds, months, granularity: daily ? 'Daily' : 'Monthly', ...(dateMode === 'custom' ? { from_date: fromDate, to_date: toDate } : {}) };
  const [first] = useState(category.key);
  const { payg, ri, asr } = useCategories(base, first, version);
  const all = { payg, ri, asr };
  const active = all[category.key];
  const names = useMemo(() => Object.fromEntries((subscriptions || []).map(s => [s.subscription_id, s.display_name || s.name || 'Unnamed subscription'])), [subscriptions]);
  const select = key => setParams(previous => { const next = new URLSearchParams(previous); next.set('tab', 'billing'); next.set('category', key); return next; });

  const [filters, setFilters] = useState(EMPTY);
  const [groupBy, setGroupBy] = useState('service');
  const filtered = useMemo(() => Object.fromEntries(Object.entries(all).map(([key, value]) => [key, value.data ? filterRows(value.data.rows || [], filters, names) : null])), [payg.data, ri.data, asr.data, filters, names]); // eslint-disable-line react-hooks/exhaustive-deps
  const options = useMemo(() => {
    const rows = [payg, ri, asr].flatMap(v => v.data?.rows || []);
    const uniq = pick => [...new Set(rows.map(pick).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    return {
      subscription: uniq(r => r.subscription_id).map(id => [id, names[id] || 'Unnamed subscription']),
      resource_group: uniq(r => r.resource_group).map(v => [v, v]),
      service: uniq(r => r.service).map(v => [v, v]),
    };
  }, [payg.data, ri.data, asr.data, names]); // eslint-disable-line react-hooks/exhaustive-deps
  const activeCount = Object.values(filters).filter(Boolean).length;
  const currency = payg.data?.currency || ri.data?.currency || asr.data?.currency || 'INR';

  if (imported) {
    return <p role="note" className="rounded-xl border border-amber-500/30 p-5 text-sm text-slate-300">This breakdown needs Azure PricingModel and resource billing dimensions. Exit imported-data mode and connect an Azure tenant to read these categories. Imported rows are not assumed to be PAYG.</p>;
  }

  return (
    <div className="space-y-5">
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-5 py-3">
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="h-4 w-4 text-[#ea580c]" aria-hidden="true" />
            <h2 className="text-sm font-semibold text-slate-100">Filters</h2>
            {activeCount > 0 && <span className="rounded-full bg-[#ffedd5] px-2 py-0.5 text-[11px] font-semibold text-[#9a3412]">{activeCount} active</span>}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" disabled={!activeCount} onClick={() => setFilters(EMPTY)}><RotateCcw aria-hidden="true" />Reset filters</Button>
            <Button variant="outline" size="sm" onClick={refresh}><RefreshCw aria-hidden="true" />Refresh</Button>
          </div>
        </div>
        <CardContent className="grid gap-3 p-5 sm:grid-cols-2 lg:grid-cols-5">
          <div className="space-y-1.5 sm:col-span-2 lg:col-span-1">
            <Label htmlFor="billing-search">Search</Label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" aria-hidden="true" />
              <Input id="billing-search" value={filters.search} onChange={e => setFilters({ ...filters, search: e.target.value })} placeholder="Resource, meter…" className="pl-8" />
            </div>
          </div>
          {[['subscription', 'Subscription', 'All subscriptions'], ['resource_group', 'Resource group', 'All groups'], ['service', 'Service', 'All services']].map(([key, text, all]) => (
            <div key={key} className="min-w-0 space-y-1.5">
              <Label htmlFor={`billing-${key}`}>{text}</Label>
              <NativeSelect id={`billing-${key}`} value={filters[key]} onChange={e => setFilters({ ...filters, [key]: e.target.value })} className={filters[key] ? 'border-[#fdba74]' : ''}>
                <option value="">{all}</option>
                {options[key].map(([value, name]) => <option key={value} value={value}>{name}</option>)}
              </NativeSelect>
            </div>
          ))}
          <div className="min-w-0 space-y-1.5">
            <Label htmlFor="billing-group-by">Group chart by</Label>
            <NativeSelect id="billing-group-by" value={groupBy} onChange={e => setGroupBy(e.target.value)}>
              {GROUPS.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
            </NativeSelect>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-3" role="radiogroup" aria-label="Billing category">
        {BILLING_CATEGORIES.map(item => {
          const Icon = ICONS[item.key];
          const state = all[item.key];
          const rows = filtered[item.key] || [];
          const amount = rows.reduce((sum, row) => sum + row.cost, 0);
          const count = new Set(rows.filter(r => r.resource_id).map(r => r.resource_id.toLowerCase())).size;
          const on = category.key === item.key;
          return (
            <button key={item.key} type="button" role="radio" aria-checked={on} onClick={() => select(item.key)}
              className={`rounded-xl border bg-slate-900 p-5 text-left shadow-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ea580c] ${on ? 'border-[#EA580C] ring-1 ring-[#EA580C]' : 'border-slate-800 hover:border-[#fdba74]'}`}>
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-semibold text-slate-100">{item.key === 'payg' ? 'Pay-as-you-go' : item.key === 'ri' ? 'Reserved (RI)' : 'DR / ASR'}</p>
                <span className={`flex h-9 w-9 items-center justify-center rounded-lg ${on ? 'bg-[#ffedd5] text-[#c2410c]' : 'bg-slate-800 text-slate-400'}`}><Icon className="h-4 w-4" aria-hidden="true" /></span>
              </div>
              <p className="mt-3 text-2xl font-bold tabular-nums text-slate-100">{state.error ? 'Unavailable' : state.data ? formatAmountFull(amount, currency) : <Loader2 className="h-5 w-5 animate-spin text-slate-500" aria-label="Loading" />}</p>
              <p className="mt-1 text-xs text-slate-500">{state.data ? `${count} resource${count === 1 ? '' : 's'}${state.data.coverage?.partial ? ` · partial (${state.data.coverage.succeeded_subscriptions} of ${state.data.coverage.requested_subscriptions} subscriptions)` : ''} · click to view` : state.error ? 'Could not load' : 'Reading from Azure…'}</p>
            </button>
          );
        })}
      </div>
      <p className="-mt-2 text-xs text-slate-500">DR / ASR charges are also Pay-as-you-go or RI, so the three cards are not added together.</p>

      {active.error ? <ErrorState title={`Could not load ${category.label}`} message={active.error} onRetry={refresh} />
        : active.loading ? <div className="flex items-center justify-center gap-2 rounded-2xl border border-slate-800 bg-slate-900 py-16 text-sm text-slate-400"><Loader2 className="h-4 w-4 animate-spin" />Reading {category.label} charges from Azure…</div>
          : <Report key={`${category.key}:${daily}`} rows={filtered[category.key]} currency={currency} category={category} names={names} groupBy={groupBy} daily={daily} />}
    </div>
  );
}
