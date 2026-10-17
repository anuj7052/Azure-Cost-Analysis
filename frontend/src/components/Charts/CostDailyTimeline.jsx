import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { fetchDailyCosts, fetchDailySplit } from '../../api/client';
import { readCache, writeCache } from '../../utils/persistCache';
import { dedupeRequest, partialResponse } from '../../utils/queryRequest';
import { useAppStore } from '../../store/useAppStore';
import { dailyRequest, serviceSlice } from '../../utils/dailyTimeline';
import { formatAmountFull } from '../../utils/currency';
import { Callout, EmptyState, ErrorState, TableSkeleton } from '../ui';
import SpendPanel from '../Boq/SpendPanel';
import { DayDetail, ServiceDetail } from '../Boq/BoqDayDetail';
import DayTimeline from '../Common/DayTimeline';
import { Link } from 'react-router-dom';
import { ArrowUpRight, CalendarDays, Gauge, ListTree, MousePointerClick, TrendingUp, Wallet } from 'lucide-react';
import { Button, Input, Label, NativeSelect } from '../shadcn';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../billing-ui/card';
import { SpendOverTime } from './CostDashboardCharts';
import { buildSeries } from '../../utils/costDashboardSeries';
import { DAILY_SPLIT, effectiveGroupBy, groupedDayPeriods, splitDayPeriods } from '../../utils/explorerGroupBy';
import { groupByLabel } from '../../utils/explorerGroupBy';
import { subscriptionText } from '../../utils/identity';


function Stat({ icon: Icon, label, value, hint, accent }) {
  return (
    <Card className={accent ? 'border-[#fdba74]' : ''}>
      <CardContent className="p-5">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-medium text-slate-400">{label}</p>
          <span className={`flex h-8 w-8 items-center justify-center rounded-lg ${accent ? 'bg-[#ffedd5] text-[#c2410c]' : 'bg-slate-800 text-slate-400'}`}><Icon className="h-4 w-4" aria-hidden="true" /></span>
        </div>
        <p className="mt-2 truncate text-2xl font-bold tracking-tight tabular-nums text-slate-100">{value}</p>
        <p className="mt-1 truncate text-xs text-slate-500">{hint}</p>
      </CardContent>
    </Card>
  );
}
const ExplorerServiceHistory = lazy(() => import('./ExplorerServiceHistory'));

function useDailySplit(request, splitBy) {
  const key = request ? JSON.stringify({ tenant_id: request.tenant_id, subscription_ids: request.subscription_ids, months: Math.min(Math.max(request.months || 1, 1), 6), from_date: request.from_date, to_date: request.to_date, split_by: splitBy }) : '';
  const [state, setState] = useState({ key: '', data: null, error: '' });
  useEffect(() => {
    if (!key) return undefined;
    let live = true;
    if (readCache(`split:${key}`)?.fresh) return undefined;
    dedupeRequest(`split:${key}`, () => fetchDailySplit(JSON.parse(key))).then(data => {
      writeCache(`split:${key}`, data, { stale: partialResponse(data) });
      if (live) setState({ key, data, error: '' });
    }).catch(err => { if (live) setState({ key, data: null, error: err.response?.data?.detail || err.message }); });
    return () => { live = false; };
  }, [key]);
  const cachedHit = key ? readCache(`split:${key}`) : null;
  const current = state.key === key ? state : { data: cachedHit?.fresh ? cachedHit.value : null, error: '' };
  return { data: current.data, error: current.error, loading: Boolean(key) && !current.data && !current.error };
}

export default function CostDailyTimeline({ filters, groupBy = 'service' }) {
  const store = useAppStore();
  const { payload, blocked } = dailyRequest(store, filters);
  if (blocked) return <Callout tone="medium" title="Daily timeline unavailable">{blocked}</Callout>;
  const requestKey = JSON.stringify(payload);
  return <DailyQuery key={requestKey} requestKey={requestKey} groupBy={effectiveGroupBy(groupBy)} service={filters.service} capped={store.dateMode !== 'custom' && store.months > 6} />;
}

function DailyQuery({ requestKey, service, capped, groupBy }) {
  const subscriptions = useAppStore(state => state.subscriptions);
  const cacheKey = `daily:${requestKey}`;
  const [result, setResult] = useState(() => {
    const hit = readCache(cacheKey);
    return hit ? { data: hit.value, revalidating: !hit.fresh } : { loading: true };
  });
  const [retry, setRetry] = useState(0);
  const [selected, setSelected] = useState('');
  const [pickedService, setPickedService] = useState(null);
  const [showTimeline, setShowTimeline] = useState(false);
  const dayRef = useRef(null);
  const timelineRef = useRef(null);
  const serviceRef = useRef(null);
  const request = JSON.parse(requestKey);
  const scrollTo = ref => requestAnimationFrame(() => requestAnimationFrame(() => ref.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })));
  const chooseDay = date => {
    setSelected(date);
    setPickedService(null);
    setShowTimeline(true);
    scrollTo(dayRef);
  };
  const chooseService = name => {
    setPickedService(name);
    scrollTo(serviceRef);
  };

  useEffect(() => {
    let live = true;
    const hit = readCache(cacheKey);
    if (hit?.fresh && !partialResponse(hit.value) && retry === 0) return;
    dedupeRequest(cacheKey, () => fetchDailyCosts(JSON.parse(requestKey))).then(data => {
      writeCache(cacheKey, data, { stale: partialResponse(data) });
      if (live) setResult({ data });
    }).catch(error => {
      const message = typeof error.response?.data?.detail === 'string' ? error.response.data.detail : error.message;
      if (live) setResult(previous => previous.data ? { ...previous, revalidating: false, refreshError: message } : { error: message });
    });
    return () => { live = false; };
  }, [requestKey, cacheKey, retry]);

  const days = useMemo(() => serviceSlice(result.data?.days || [], service), [result.data, service]);
  const currency = result.data?.currency || days[0]?.currency || 'USD';
  const money = value => Number.isFinite(value) ? formatAmountFull(value, currency) : '—';
  const billed = days.filter(day => Number.isFinite(day.total));
  const total = billed.length ? billed.reduce((sum, day) => sum + day.total, 0) : null;
  const peak = billed.reduce((best, day) => !best || day.total > best.total ? day : best, null);
  const services = [...new Set(days.flatMap(day => Object.keys(day.by_service || {})))].sort();
  const current = days.find(day => day.date === selected);
  const split = useDailySplit(DAILY_SPLIT.has(groupBy) && !service ? request : null, groupBy);
  const grouped = useMemo(() => {
    if (groupBy === 'none') return null;
    if (DAILY_SPLIT.has(groupBy) && !service) {
      if (!split.data) return null;
      const names = Object.fromEntries((subscriptions || []).map(sub => [sub.subscription_id, sub.display_name]));
      const days = groupBy === 'subscription'
        ? split.data.days.map(d => ({ ...d, split: Object.fromEntries(Object.entries(d.split).map(([k, v]) => [names[k] || subscriptionText(k, subscriptions), v])) }))
        : split.data.days;
      return buildSeries(splitDayPeriods(days));
    }
    return buildSeries(groupedDayPeriods(days, 'service'));
  }, [days, groupBy, split.data, service, subscriptions]);
  const from = request.from_date || days[0]?.date;
  const to = request.to_date || days.at(-1)?.date;
  const coverage = result.data?.coverage;

  return <div className="space-y-4">
    {capped && <Callout tone="info" title="Daily range limited to six months">Showing the most recent six months. Use Monthly for the full header range.</Callout>}
    {result.refreshError && <Callout tone="medium" title="Showing the last figures returned">{result.refreshError}</Callout>}
    {(coverage?.partial || (!result.loading && result.data && !coverage)) && <Callout tone="medium" title={coverage?.partial ? 'Partial daily coverage' : 'Daily subscription coverage unknown'}>
      {coverage ? `${coverage.succeeded_subscriptions} of ${coverage.requested_subscriptions} subscriptions succeeded.` : 'Azure did not report subscription coverage for this saved response.'}
      {coverage?.errors?.map((error, i) => <p key={i}>{error.error}</p>)}
    </Callout>}
    {result.error ? <ErrorState title="Could not load daily costs" message={result.error} onRetry={() => { setResult({ loading: true }); setRetry(v => v + 1); }} /> : result.loading ? <SpendPanel title="Daily Spend"><div className="p-5" role="status">Loading daily costs…<TableSkeleton rows={5} /></div></SpendPanel> : !days.length ? <EmptyState title="No daily billing data returned" description="A missing date is not a zero-cost date." /> : <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat icon={Wallet} label="Actual cost" value={money(total)} hint={`${from} → ${to}`} />
        <Stat icon={Gauge} label="Average billed day" value={money(billed.length ? total / billed.length : null)} hint={`${billed.length} returned days`} />
        <Stat icon={TrendingUp} label="Highest day" value={money(peak?.total)} hint={peak?.date} />
        <Stat icon={MousePointerClick} label="Selected day" value={current ? money(current.total) : 'Select a day'} hint={selected || 'Click the chart, pick a date, or open Timeline'} accent={Boolean(current)} />
      </div>
      {(grouped || split.loading || split.error) && <SpendOverTime
        series={grouped || buildSeries([])}
        daily
        currency={currency}
        groupLabel={groupBy === 'pricing_model' ? 'payment type' : groupByLabel(DAILY_SPLIT.has(groupBy) && service ? 'service' : groupBy)}
        showSummary={false}
        loading={split.loading}
        error={split.error}
        description={`Each returned day split by ${groupByLabel(DAILY_SPLIT.has(groupBy) && service ? 'service' : groupBy).toLowerCase()}. Hover for the breakdown, click a day to open its services below.${DAILY_SPLIT.has(groupBy) && service ? ' Service filter is set, so the split is by service.' : ''}`}
        onSelect={chooseDay}
      />}
      <div className={`grid items-start gap-4 ${pickedService ? 'xl:grid-cols-2' : ''}`}>
        <Card className="min-w-0 overflow-hidden">
          <CardHeader className="flex-row flex-wrap items-start justify-between gap-3 space-y-0 p-5 pb-3">
            <div className="min-w-0 space-y-1.5">
              <CardTitle className="text-base">Day and service detail</CardTitle>
              <CardDescription>Pick a date or a service, or click a day in the chart above. Dates use UTC.</CardDescription>
            </div>
            <Button size="sm" variant={showTimeline ? 'active' : 'outline'} aria-expanded={showTimeline} onClick={() => { setShowTimeline(v => !v); if (!showTimeline) scrollTo(timelineRef); }}><ListTree aria-hidden="true" />Timeline</Button>
          </CardHeader>
          <div className="grid gap-3 border-t border-slate-800 bg-slate-950/30 p-4 sm:grid-cols-[auto_minmax(0,16rem)_1fr] sm:items-end">
            <div className="space-y-1.5">
              <Label htmlFor="explorer-billing-date">Billing date</Label>
              <div className="relative">
                <CalendarDays className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" aria-hidden="true" />
                <Input id="explorer-billing-date" aria-label="Billing date" type="date" value={selected} min={from} max={to} className="pl-8" onChange={e => chooseDay(e.target.value)} onInput={e => { if (e.currentTarget.validity.valid && e.currentTarget.value) chooseDay(e.currentTarget.value); }} />
              </div>
            </div>
            <div className="min-w-0 space-y-1.5">
              <Label htmlFor="explorer-service-history">Service</Label>
              <NativeSelect id="explorer-service-history" aria-label="Inspect service history" value={pickedService || ''} onChange={e => chooseService(e.target.value || null)}>
                <option value="">Choose a service</option>
                {services.map(name => <option key={name}>{name}</option>)}
              </NativeSelect>
            </div>
            {selected && current && (
              <Link to={`/explorer?tab=day&date=${selected}`} className="inline-flex h-9 items-center justify-center gap-2 justify-self-start rounded-md bg-[#EA580C] px-4 text-sm font-medium text-white shadow-sm hover:bg-[#c2410c] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ea580c] sm:justify-self-end">
                Resources for {selected}<ArrowUpRight className="h-4 w-4" aria-hidden="true" />
              </Link>
            )}
          </div>
          {showTimeline && <div ref={timelineRef} className="scroll-mt-24 border-t border-slate-800">
            <div className="flex items-center justify-between gap-3 px-5 pt-3"><p className="text-xs text-slate-500">Only the days that moved. Pick a day or follow a service across the period.</p><Button size="sm" variant="ghost" onClick={() => setShowTimeline(false)}>Hide</Button></div>
            <DayTimeline days={days} currency={currency} selected={selected} onPick={chooseDay} onPickService={chooseService} />
          </div>}
          {selected && <div ref={dayRef} className="scroll-mt-24">
            {!current ? <div className="p-5"><Callout title={`No billing data returned for ${selected}`}>A missing date is not a zero-cost date.</Callout></div> : <DayDetail days={days} date={selected} currency={currency} onClose={() => { setSelected(''); setPickedService(null); }} onPickService={chooseService} />}
          </div>}
          {pickedService && <div ref={serviceRef} className="scroll-mt-24"><ServiceDetail days={days} name={pickedService} currency={currency} onClose={() => setPickedService(null)} onPickDay={date => { setSelected(date); setShowTimeline(true); scrollTo(dayRef); }} /></div>}
          <p className="border-t border-slate-800 px-5 py-2.5 text-[11px] text-slate-500">{result.revalidating ? 'Checking for updated daily costs… ' : coverage ? `${coverage.succeeded_subscriptions} of ${coverage.requested_subscriptions} subscriptions · ` : ''}Billing changes identify charges, not operational causes. Missing dates are not counted as zero.</p>
        </Card>
        {pickedService && <Suspense fallback={<SpendPanel title="Service resources"><p role="status" className="p-5 text-xs text-slate-400">Opening resource detail…</p></SpendPanel>}>
          <ExplorerServiceHistory key={`${requestKey}:${pickedService}`} resourcesOnly service={pickedService} days={days} query={{ ...request, from_date: from, to_date: to }} currency={currency} onPickDay={chooseDay} onClose={() => setPickedService(null)} />
        </Suspense>}
      </div>
    </>}
  </div>;
}
