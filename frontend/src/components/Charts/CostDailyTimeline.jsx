import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { fetchDailyCosts } from '../../api/client';
import { readCache, writeCache } from '../../utils/persistCache';
import { dedupeRequest, partialResponse } from '../../utils/queryRequest';
import { useAppStore } from '../../store/useAppStore';
import { useChartTheme } from '../../store/useTheme';
import { clickedPoint, dailyRequest, previousDate, serviceSlice } from '../../utils/dailyTimeline';
import { formatAmount, formatAmountFull } from '../../utils/currency';
import { Callout, EmptyState, ErrorState, TableSkeleton } from '../ui';
import SpendPanel from '../Boq/SpendPanel';
import { DayDetail, ServiceDetail } from '../Boq/BoqDayDetail';
import DayTimeline from '../Common/DayTimeline';
const ExplorerServiceHistory = lazy(() => import('./ExplorerServiceHistory'));

export default function CostDailyTimeline({ filters }) {
  const store = useAppStore();
  const { payload, blocked } = dailyRequest(store, filters);
  if (blocked) return <Callout tone="medium" title="Daily timeline unavailable">{blocked}</Callout>;
  const requestKey = JSON.stringify(payload);
  return <DailyQuery key={requestKey} requestKey={requestKey} service={filters.service} capped={store.dateMode !== 'custom' && store.months > 6} />;
}

function DailyQuery({ requestKey, service, capped }) {
  const cacheKey = `daily:${requestKey}`;
  const [result, setResult] = useState(() => {
    const hit = readCache(cacheKey);
    return hit ? { data: hit.value, revalidating: !hit.fresh } : { loading: true };
  });
  const [retry, setRetry] = useState(0);
  const [selected, setSelected] = useState('');
  const [pickedService, setPickedService] = useState(null);
  const [showTimeline, setShowTimeline] = useState(false);
  const [cumulative, setCumulative] = useState(false);
  const dayRef = useRef(null);
  const timelineRef = useRef(null);
  const serviceRef = useRef(null);
  const theme = useChartTheme();
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
  const points = useMemo(() => {
    let sum = 0;
    const output = [];
    days.forEach((day, i) => {
      if (i && previousDate(day.date) !== days[i - 1].date) output.push({ date: previousDate(day.date), total: null, running: null });
      if (Number.isFinite(day.total)) sum += day.total;
      output.push({ ...day, running: Number.isFinite(day.total) ? sum : null });
    });
    return output;
  }, [days]);
  const current = days.find(day => day.date === selected);
  const from = request.from_date || days[0]?.date;
  const to = request.to_date || days.at(-1)?.date;
  const coverage = result.data?.coverage;
  const control = 'rounded-lg border border-slate-700 px-2.5 py-1 text-[11px] text-slate-300 transition hover:border-slate-500 hover:text-white';

  return <div className="space-y-4">
    {capped && <Callout tone="info" title="Daily range limited to six months">Showing the most recent six months. Use Monthly for the full header range.</Callout>}
    {result.refreshError && <Callout tone="medium" title="Showing the last figures returned">{result.refreshError}</Callout>}
    {(coverage?.partial || (!result.loading && result.data && !coverage)) && <Callout tone="medium" title={coverage?.partial ? 'Partial daily coverage' : 'Daily subscription coverage unknown'}>
      {coverage ? `${coverage.succeeded_subscriptions} of ${coverage.requested_subscriptions} subscriptions succeeded.` : 'Azure did not report subscription coverage for this saved response.'}
      {coverage?.errors?.map((error, i) => <p key={i}>{error.error}</p>)}
    </Callout>}
    {result.error ? <ErrorState title="Could not load daily costs" message={result.error} onRetry={() => { setResult({ loading: true }); setRetry(v => v + 1); }} /> : result.loading ? <SpendPanel title="Daily Spend"><div className="p-5" role="status">Loading daily costs…<TableSkeleton rows={5} /></div></SpendPanel> : !days.length ? <EmptyState title="No daily billing data returned" description="A missing date is not a zero-cost date." /> : <>
      <div className="grid grid-cols-2 divide-x divide-slate-800 rounded-2xl border border-slate-800 bg-slate-900 lg:grid-cols-4">
        {[
          ['Actual cost', money(total), `${from} → ${to}`],
          ['Average billed day', money(billed.length ? total / billed.length : null), `${billed.length} returned days`],
          ['Highest day', money(peak?.total), peak?.date],
          ['Selected day', current ? money(current.total) : 'Select a day', selected || 'Click the chart or Timeline'],
        ].map(([label, value, hint]) => <div key={label} className="min-w-0 px-5 py-4"><p className="text-[11px] uppercase tracking-wide text-slate-500">{label}</p><p className="mt-1 text-xl font-semibold tabular-nums text-slate-100">{value}</p><p className="mt-1 text-[11px] text-slate-500">{hint}</p></div>)}
      </div>
      <div className={`grid items-start gap-4 ${pickedService ? 'xl:grid-cols-2' : ''}`}>
        <SpendPanel title="Daily Spend" subtitle="Click a day to see every service charged, then a service to follow its costs and resources. Dates use UTC."
          action={<div className="flex gap-1.5">
            <button className={`${control} ${showTimeline ? 'border-sky-500/50 bg-sky-500/10 text-sky-300' : ''}`} aria-expanded={showTimeline} onClick={() => { setShowTimeline(v => !v); if (!showTimeline) scrollTo(timelineRef); }}>Timeline</button>
            <button className={control} aria-pressed={cumulative} onClick={() => setCumulative(v => !v)}>{cumulative ? 'Per day' : 'Running total'}</button>
          </div>}>
          <div className="px-2 py-4">
            <ResponsiveContainer width="100%" height={250}>
              <AreaChart data={points} margin={{ top: 5, right: 16, left: 4, bottom: 0 }} style={{ cursor: 'pointer' }} onClick={state => { const day = clickedPoint(state, points); if (day?.date) chooseDay(day.date); }}>
                <defs><linearGradient id="explorerActualFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={theme.series[0]} stopOpacity={0.35} /><stop offset="100%" stopColor={theme.series[0]} stopOpacity={0.02} /></linearGradient></defs>
                <CartesianGrid strokeDasharray="3 3" stroke={theme.grid} vertical={false} />
                <XAxis dataKey="date" tickFormatter={value => value.slice(5)} tick={{ fill: theme.axis, fontSize: 10 }} axisLine={false} tickLine={false} minTickGap={20} />
                <YAxis width={68} tick={{ fill: theme.axis, fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={value => formatAmount(value, currency, true)} />
                <Tooltip contentStyle={theme.tooltip} formatter={value => [money(value), cumulative ? 'Running total' : 'Actual']} />
                {selected && <ReferenceLine x={selected} stroke={theme.series[0]} strokeDasharray="4 3" />}
                <Area dataKey={cumulative ? 'running' : 'total'} name="Actual" stroke={theme.series[0]} fill="url(#explorerActualFill)" strokeWidth={2} dot={false} activeDot={{ r: 4 }} connectNulls={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <div className="flex flex-wrap items-center gap-3 border-t border-slate-800 px-5 py-3">
            <label className="text-xs text-slate-400">Billing date <input aria-label="Billing date" type="date" value={selected} min={from} max={to} className="ml-2 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-slate-200" onChange={e => chooseDay(e.target.value)} onInput={e => { if (e.currentTarget.validity.valid && e.currentTarget.value) chooseDay(e.currentTarget.value); }} /></label>
            <label className="text-xs text-slate-400">Service <select aria-label="Inspect service history" value={pickedService || ''} onChange={e => chooseService(e.target.value || null)} className="ml-2 max-w-56 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-slate-200"><option value="">Choose a service</option>{services.map(name => <option key={name}>{name}</option>)}</select></label>
          </div>
          {showTimeline && <div ref={timelineRef} className="scroll-mt-24 border-t border-slate-800">
            <div className="flex justify-between gap-3 px-5 pt-3"><p className="text-[11px] text-slate-500">Only the days that moved. Pick a day or follow a service across the period.</p><button className={control} onClick={() => setShowTimeline(false)}>Hide</button></div>
            <DayTimeline days={days} currency={currency} selected={selected} onPick={chooseDay} onPickService={chooseService} />
          </div>}
          {selected && <div ref={dayRef} className="scroll-mt-24">
            {!current ? <div className="p-5"><Callout title={`No billing data returned for ${selected}`}>A missing date is not a zero-cost date.</Callout></div> : <DayDetail days={days} date={selected} currency={currency} onClose={() => { setSelected(''); setPickedService(null); }} onPickService={chooseService} />}
          </div>}
          {pickedService && <div ref={serviceRef} className="scroll-mt-24"><ServiceDetail days={days} name={pickedService} currency={currency} onClose={() => setPickedService(null)} onPickDay={date => { setSelected(date); setShowTimeline(true); scrollTo(dayRef); }} /></div>}
          <p className="border-t border-slate-800 px-5 py-2 text-[10px] text-slate-500">{result.revalidating ? 'Checking for updated daily costs…' : coverage ? `${coverage.succeeded_subscriptions} of ${coverage.requested_subscriptions} subscriptions · ` : ''}Billing changes identify charges, not operational causes. Missing dates are not counted as zero.</p>
        </SpendPanel>
        {pickedService && <Suspense fallback={<SpendPanel title="Service resources"><p role="status" className="p-5 text-xs text-slate-400">Opening resource detail…</p></SpendPanel>}>
          <ExplorerServiceHistory key={`${requestKey}:${pickedService}`} resourcesOnly service={pickedService} days={days} query={{ ...request, from_date: from, to_date: to }} currency={currency} onPickDay={chooseDay} onClose={() => setPickedService(null)} />
        </Suspense>}
      </div>
    </>}
  </div>;
}
