/**
 * BOQ vs Actual -- the dashboard band above the detail.
 *
 * Four panels, arranged the way the question gets asked: what did we commit to
 * versus what did we pay (FinOps Analysis), how did that play out day by day
 * (Daily Spend), where did the money go (Top 5), and what should be done about
 * it (Recommendations).
 *
 * Every number is taken from the same report object the table below renders, so
 * the band cannot contradict the detail it sits on top of.
 */
import { useMemo, useRef, useState } from 'react';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ComposedChart, Legend, Line, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import {
  AlertTriangle, ArrowDownRight, ArrowUpRight, CheckCircle, ChevronDown, ChevronRight,
  Info, Lightbulb, Minus, BarChart3, Layers, LineChart as LineIcon, TrendingUp, Columns3,
} from 'lucide-react';
import { OTHER_COLOR, SERIES_COLORS, TOP_SERVICES } from '../../utils/costDashboardSeries';

const CHART_TYPES = [
  { value: 'stacked', label: 'Stacked bars', icon: BarChart3, needsServices: true },
  { value: 'area', label: 'Stacked area', icon: Layers, needsServices: true },
  { value: 'line', label: 'Total line', icon: LineIcon },
  { value: 'bars', label: 'Bars', icon: Columns3 },
  { value: 'running', label: 'Running total', icon: TrendingUp },
];

import { useChartTheme } from '../../store/useTheme';
import { formatAmount } from '../../utils/currency';
import { dailySeries, clickedDay, finops, monthlySeries, recommend } from '../../utils/boqDashboard';
import { DayDetail, DayTimeline, ServiceDetail } from './BoqDayDetail';
import { ResourceDetail, ServiceResources } from './BoqResourcePanel';
import Panel from './SpendPanel';

const SEVERITY = {
  critical: { icon: AlertTriangle, tone: 'text-rose-400', chip: 'bg-rose-500/15 text-rose-300', border: 'border-rose-500/30', label: 'Act on this' },
  warning: { icon: AlertTriangle, tone: 'text-amber-400', chip: 'bg-amber-500/15 text-amber-300', border: 'border-amber-500/25', label: 'Look into it' },
  info: { icon: Info, tone: 'text-sky-400', chip: 'bg-sky-500/15 text-sky-300', border: 'border-sky-500/25', label: 'Worth knowing' },
  good: { icon: CheckCircle, tone: 'text-emerald-400', chip: 'bg-emerald-500/15 text-emerald-300', border: 'border-emerald-500/25', label: 'Good news' },
};

function Quadrant({ label, value, tone = 'text-white', hint, onClick, actionLabel }) {
  const body = (
    <>
      <p className="text-[11px] uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${tone}`}>{value}</p>
      {hint && <p className="mt-1 text-[11px] leading-relaxed text-slate-500">{hint}</p>}
    </>
  );
  if (!onClick) return <div className="px-5 py-4">{body}</div>;
  return (
    <button
      onClick={onClick}
      className="group px-5 py-4 text-left transition hover:bg-slate-800/40"
      title={actionLabel}
    >
      {body}
      <span className="mt-1 inline-flex items-center gap-1 text-[11px] text-sky-400 opacity-0 transition group-hover:opacity-100">
        {actionLabel} <ChevronRight size={11} />
      </span>
    </button>
  );
}

export default function BoqDashboard({
  report, months, days, rows, resourceQuery, tenantId, onShowOverruns,
}) {
  const t = useChartTheme();
  const [chartType, setChartType] = useState('stacked');
  const [planLine, setPlanLine] = useState(null);
  // Which day the reader asked about, and whether they want the sequence of
  // events rather than the chart. Both default off: the chart is the summary,
  // and opening every explanation at once is not a summary.
  const [pickedDay, setPickedDay] = useState(null);
  const [showTimeline, setShowTimeline] = useState(false);
  const timelineRef = useRef(null);
  const dayRef = useRef(null);

  // Opening the timeline used to look like it had done nothing: it renders
  // under a 250px chart, so on a laptop the whole thing was below the fold and
  // the reader had to guess that scrolling was the next move.
  function openTimeline() {
    setShowTimeline(v => !v);
    requestAnimationFrame(() =>
      timelineRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }),
    );
  }
  // A service followed across the whole period. Reached from a day, because
  // the question "is this normal for this service" only ever comes up after
  // seeing it on one day.
  const [pickedService, setPickedService] = useState(null);
  // The drill-down on the right: either the list of resources under a service,
  // or one of them. Kept apart from `pickedService` because the two answer
  // different questions about the same name -- how it behaved over time, and
  // which machines it is made of.
  const [picked, setPicked] = useState(null);
  // Advice is collapsed until asked for; see the panel below for why.
  const [showAdvice, setShowAdvice] = useState(false);

  // Clicking a service name asks both questions at once, so both are answered:
  // the shape of its spend on the left, the machines under it on the right.
  function chooseService(name) {
    setPickedService(name);
    setPicked(name ? { kind: 'service', service: name } : null);
  }

  // Choosing a day and reading the sequence of events are the same enquiry, so
  // picking a day on the chart opens the timeline beside it rather than making
  // the reader find the toggle. Clearing the day leaves the timeline open --
  // they asked for it, however they got there.
  //
  // The breakdown is then scrolled to, for the same reason the Timeline button
  // does it: both panels render under a 250px chart and a timeline, so on a
  // laptop a click on the chart put the answer entirely below the fold and read
  // as nothing having happened. The scroll is what makes the click look like it
  // did something.
  function chooseDay(date) {
    const next = pickedDay === date ? null : date;
    setPickedDay(next);
    setPickedService(null);
    if (!next) return;
    setShowTimeline(true);
    // Two frames, not one. The panel does not exist in the DOM until the state
    // change has rendered, and scrolling to a ref that is still null is the
    // silent no-op this was added to fix.
    requestAnimationFrame(() => requestAnimationFrame(() =>
      dayRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }),
    ));
  }

  const currency = report?.currency || 'INR';
  const fmt = (v) => formatAmount(v, currency);

  // How every figure in this band is qualified. Taken from the report rather
  // than assumed, because the same comparison can be built per month or across
  // the whole selected period.
  const span = report?.months || 1;
  const per = report?.perMonth ? 'per month' : `over ${span} month${span > 1 ? 's' : ''}`;
  // The chart is always drawn day by day, so its budget line is always the
  // monthly estimate divided by the days in that month -- never the period
  // total, which would sit three times too high over a three-month selection.
  const monthlyBudget = report ? report.budgetTotal / (report.budgetFactor || 1) : 0;

  const head = useMemo(() => finops(report, months), [report, months]);
  const daily = useMemo(() => dailySeries(days, monthlyBudget), [days, monthlyBudget]);
  const monthly = useMemo(() => monthlySeries(months, monthlyBudget), [months, monthlyBudget]);
  // Overruns are ranked by variance, which only exists where something was
  // budgeted; an unbudgeted category has no variance to rank by and shows up in
  // its own recommendation instead.

  const advice = useMemo(() => recommend(report ? { ...report, categories: report.categories.filter(c => c.key !== 'reconciliation') } : report, { per }), [report, per]);
  // Summed for the collapsed header, so the reader can judge whether opening
  // the panel is worth it without opening it.
  const adviceTotal = useMemo(
    () => advice.reduce((s, a) => s + (a.impact || 0), 0),
    [advice],
  );

  // The BOQ's share of a single day, used by both the drill-down and the
  // timeline so "over budget" means the same thing in each. Taken from the
  // series the chart is drawn from rather than recomputed, because the series
  // already divides by the real length of each month.
  const dailyBudget = useMemo(() => {
    const withBudget = daily.filter(d => d.budget !== null);
    if (!withBudget.length) return null;
    if (pickedDay) {
      const exact = withBudget.find(d => d.full === pickedDay);
      if (exact) return exact.budget;
    }
    return withBudget[withBudget.length - 1].budget;
  }, [daily, pickedDay]);

  const split = useMemo(() => {
    const totals = {};
    for (const d of days || []) for (const [k, v] of Object.entries(d.by_service || {})) totals[k] = (totals[k] || 0) + (Number(v) || 0);
    const ranked = Object.entries(totals).sort((a, b) => b[1] - a[1]);
    const top = ranked.slice(0, TOP_SERVICES).map(([k]) => k);
    const keys = ranked.length > TOP_SERVICES ? [...top, 'Other'] : top;
    const colors = Object.fromEntries(keys.map((k, i) => [k, k === 'Other' ? OTHER_COLOR : SERIES_COLORS[i % SERIES_COLORS.length]]));
    const byDate = Object.fromEntries((days || []).map(d => [String(d.date), d.by_service || {}]));
    return { keys, colors, byDate, top };
  }, [days]);

  if (!report || !head) return null;

  // Daily data is the better read, but an imported usage file has no day grain.
  // Falling back to months is honest; inventing days from a monthly total would
  // draw a flat line that looks like a measurement.
  const usingDaily = daily.length > 0;
  const baseSeries = usingDaily ? daily : monthly;
  const series = usingDaily ? baseSeries.map(point => {
    const row = { ...point };
    let other = 0;
    for (const [k, v] of Object.entries(split.byDate[point.full] || {})) {
      if (split.top.includes(k)) row[k] = (row[k] || 0) + (Number(v) || 0); else other += Number(v) || 0;
    }
    if (split.keys.includes('Other')) row.Other = other;
    return row;
  }) : baseSeries;
  const types = CHART_TYPES.filter(type => (!type.needsServices || (usingDaily && split.keys.length)) && (type.value !== 'running' || usingDaily));
  const kind = types.some(type => type.value === chartType) ? chartType : 'line';
  // The axis label for the picked day, so the marker on the chart is placed by
  // the same value the axis is drawn from rather than by a second formatting of
  // the date that could disagree with it.
  const selectedLabel = pickedDay
    ? (series.find(d => d.full === pickedDay)?.date ?? null)
    : null;
  // Whether there is a budget line to draw at all, read off the series rather
  // than off the report, so the chart and the legend agree with the points.
  const hasBudget = series.some(d => d.budget !== null && d.budget !== undefined);
  const peakActual = Math.max(0, ...series.map(point => Number(point.actual) || 0));
  const peakBudget = Math.max(0, ...series.map(point => Number(point.budget) || 0));
  const planFar = hasBudget && peakActual > 0 && peakBudget > peakActual * 3;
  const showPlan = hasBudget && (planLine ?? !planFar);

  const trend = head.trendPct;
  const TrendIcon = trend === null ? Minus : trend > 0 ? ArrowUpRight : ArrowDownRight;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 items-start gap-4">
        {/* The chart leads on the left because it is the thing people read
            first and then click into; the four figures on the right are the
            summary they check it against. Ordered rather than reordered in the
            markup so the summary still comes first when the two stack on a
            narrow screen. */}
        <div className="space-y-4 order-2">
        {/* ── FinOps analysis ─────────────────────────────────────────────── */}
        <Panel
          title="FinOps Analysis"
          subtitle={report.perMonth
            ? `Monthly BOQ commitment against what Azure charged${
              span > 1 ? `, averaged over ${span} months` : ''}`
            : `BOQ commitment × ${span} against what Azure charged across those ${span} months`}
        >
          <div className="grid grid-cols-2 divide-x divide-y divide-slate-800">
            <Quadrant
              label="BOQ commitment"
              value={fmt(head.budget)}
              hint={report.perMonth
                ? 'what the estimate said one month would cost'
                : `the monthly estimate multiplied by ${span}`}
            />
            <Quadrant
              label="Actual cost"
              value={fmt(head.actual)}
              hint={head.consumedPct !== null
                ? `${head.consumedPct}% of the budget consumed`
                : 'no budget to compare against'}
            />
            <Quadrant
              label={head.overspend ? 'Over budget' : 'Under budget'}
              value={`${head.overspend ? '+' : '−'}${fmt(Math.abs(head.variance))}`}
              tone={head.overspend ? 'text-rose-400' : 'text-emerald-400'}
              hint={head.variancePct !== null
                ? `${head.variancePct > 0 ? '+' : ''}${head.variancePct}% against the estimate`
                : 'no estimate to measure against'}
              onClick={head.overspend && onShowOverruns ? onShowOverruns : undefined}
              actionLabel="Show what is over"
            />
            <Quadrant
              label="Trend vs previous period"
              value={trend === null ? 'Not available' : `${trend > 0 ? '+' : ''}${trend}%`}
              tone={trend === null ? 'text-slate-500' : trend > 0 ? 'text-rose-400' : 'text-emerald-400'}
              hint={trend === null
                ? 'needs two months of cost data'
                : `${head.trendFrom} → ${head.trendTo}`}
            />
          </div>
          <div className="flex items-center gap-2 border-t border-slate-800 px-5 py-2.5">
            <TrendIcon size={13} className={trend === null ? 'text-slate-500'
              : trend > 0 ? 'text-rose-400' : 'text-emerald-400'} />
            <p className="text-[11px] text-slate-500">
              {head.overspend
                ? `${fmt(head.variance)} ${per} more than the estimate allowed for.`
                : `${fmt(Math.abs(head.variance))} ${per} less than the estimate allowed for.`}
            </p>
          </div>
        </Panel>

        {/* The drill-down from a service name, filling the space under the
            four figures rather than pushing the chart down the page. */}
        {picked?.kind === 'service' && (
          <ServiceResources
            service={picked.service}
            rows={rows}
            query={resourceQuery}
            currency={currency}
            onPick={(r) => setPicked({ kind: 'resource', service: picked.service, resource: r })}
            onClose={() => setPicked(null)}
          />
        )}
        {picked?.kind === 'resource' && (
          <ResourceDetail
            resource={picked.resource}
            tenantId={tenantId}
            currency={currency}
            onBack={() => setPicked({ kind: 'service', service: picked.service })}
            onClose={() => setPicked(null)}
          />
        )}
        </div>

        <div className="space-y-4 order-1">
        {/* ── Spend against budget over time ──────────────────────────────── */}
        <Panel
          title={usingDaily ? 'Daily Spend' : 'Monthly Spend'}
          subtitle={usingDaily
            ? 'Actual against the daily share of the BOQ. Click any day to see what made it that amount.'            : 'No daily detail available — showing months'}
          action={usingDaily ? (
            <div className="flex gap-1.5">
              <button
                onClick={openTimeline}
                aria-expanded={showTimeline}
                className={`rounded-lg border px-2.5 py-1 text-[11px] transition ${
                  showTimeline
                    ? 'border-sky-500/50 bg-sky-500/10 text-sky-300'
                    : 'border-slate-700 text-slate-300 hover:border-slate-600 hover:text-white'
                }`}
              >
                Timeline
              </button>
            </div>
          ) : null}
        >
          <div className="px-2 py-4">
            {series.length === 0 ? (
              <p className="px-3 py-10 text-center text-xs text-slate-500">
                No cost data for the selected period.
              </p>
            ) : (
              <>
              <div role="radiogroup" aria-label="Chart type" className="mb-3 flex flex-wrap gap-1 px-3">
                {types.map(type => {
                  const on = kind === type.value;
                  return (
                    <button key={type.value} type="button" role="radio" aria-checked={on} onClick={() => setChartType(type.value)}
                      className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ea580c] ${on ? 'bg-[#ffedd5] text-[#9a3412] ring-1 ring-[#fdba74]' : 'text-slate-400 hover:bg-slate-800 hover:text-slate-100'}`}>
                      <type.icon className="h-3.5 w-3.5" aria-hidden="true" />{type.label}
                    </button>
                  );
                })}
              </div>
              <ResponsiveContainer width="100%" height={360}>
                <ComposedChart
                  data={series}
                  margin={{ top: 5, right: 16, left: 4, bottom: 0 }}
                  onClick={usingDaily ? (e) => {
                    const full = clickedDay(e, series);
                    if (full) chooseDay(full);
                  } : undefined}
                  style={usingDaily ? { cursor: 'pointer' } : undefined}
                >
                  <defs>
                    <linearGradient id="boqActualFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#EA580C" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="#EA580C" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke={t.grid} vertical={false} />
                  {usingDaily && selectedLabel && (
                    <ReferenceLine x={selectedLabel} stroke="#EA580C" strokeWidth={1.5} strokeDasharray="4 3" ifOverflow="extendDomain" />
                  )}
                  <XAxis dataKey="date" tick={{ fill: t.axis, fontSize: 10 }} axisLine={false} tickLine={false} minTickGap={20} />
                  <YAxis tick={{ fill: t.axis, fontSize: 10 }} axisLine={false} tickLine={false} width={58}
                    tickFormatter={v => (v >= 1000 ? `${(v / 1000).toFixed(0)}K` : v)} />
                  <Tooltip cursor={{ fill: 'rgba(234,88,12,0.08)', stroke: '#EA580C' }} contentStyle={t.tooltip} labelStyle={t.tooltipLabel}
                    formatter={(val, key) => [val === null ? 'Not available' : fmt(val), key]} />
                  <Legend iconType="circle" iconSize={8} wrapperStyle={{ color: t.axis, fontSize: 11 }} />
                  {kind === 'stacked' && split.keys.map((k, i) => <Bar key={k} name={k} dataKey={k} stackId="svc" fill={split.colors[k]} maxBarSize={26} radius={i === split.keys.length - 1 ? [4, 4, 0, 0] : 0} />)}
                  {kind === 'area' && split.keys.map(k => <Area key={k} type="monotone" name={k} dataKey={k} stackId="svc" stroke={split.colors[k]} fill={split.colors[k]} fillOpacity={0.8} />)}
                  {kind === 'bars' && <Bar name="Actual" dataKey="actual" fill="#EA580C" maxBarSize={26} radius={[4, 4, 0, 0]}>
                    {series.map(point => <Cell key={point.date} fill={point.over ? '#e11d48' : '#EA580C'} />)}
                  </Bar>}
                  {(kind === 'line' || kind === 'running') && (
                    <Area type="monotone" name={kind === 'running' ? 'Actual (running total)' : 'Actual'} dataKey={kind === 'running' ? 'cumulativeActual' : 'actual'}
                      stroke="#EA580C" fill="url(#boqActualFill)" strokeWidth={2.5} dot={false} activeDot={{ r: 4 }} />
                  )}
                  {showPlan && (
                    <Line type="monotone" name={kind === 'running' ? 'BOQ budget (running total)' : 'BOQ budget'} dataKey={kind === 'running' ? 'cumulativeBudget' : 'budget'}
                      stroke="var(--color-slate-400)" strokeWidth={2} strokeDasharray="5 4" dot={false} connectNulls={false} />
                  )}
                </ComposedChart>
              </ResponsiveContainer>
              {hasBudget && (
                <div className="flex flex-wrap items-center gap-3 px-3 pt-2 text-[11px] text-slate-500">
                  <label className="inline-flex items-center gap-1.5 text-slate-300"><input type="checkbox" className="accent-[#ea580c]" checked={showPlan} onChange={e => setPlanLine(e.target.checked)} />Show plan line</label>
                  {planFar && !showPlan && <span>Hidden by default: the plan ({fmt(peakBudget)}/day) is far above daily spend (up to {fmt(peakActual)}/day), which would flatten the bars.</span>}
                </div>
              )}
              {kind === 'bars' && hasBudget && <p className="px-3 pt-1 text-[11px] text-slate-500">Red bars are days that cost more than the plan allows per day.</p>}
              </>
            )}
          </div>

          {/* The sequence of things that happened, for a reader who wants the
              period rather than one day of it. Scrolled to on opening, because
              it appears below a 250px chart and otherwise opens off-screen --
              the button looked like it had done nothing. */}
          {usingDaily && showTimeline && (
            <div className="border-t border-slate-800" ref={timelineRef}>
              <div className="flex items-start justify-between gap-3 px-5 pt-3">
                <p className="text-[11px] text-slate-500">
                  Only the days that moved. Pick one to see everything charged on it, or a
                  service name to follow it across the period.
                </p>
                <button
                  onClick={() => setShowTimeline(false)}
                  className="shrink-0 rounded-lg border border-slate-700 px-2 py-0.5 text-[11px] text-slate-400 transition hover:text-white"
                >
                  Hide
                </button>
              </div>
              <DayTimeline
                days={days}
                budget={dailyBudget}
                currency={currency}
                selected={pickedDay}
                onPick={chooseDay}
                onPickService={chooseService}
              />
            </div>
          )}

          {usingDaily && pickedDay && (
            <div ref={dayRef}>
              <DayDetail
                days={days}
                date={pickedDay}
                budget={dailyBudget}
                currency={currency}
                onClose={() => { setPickedDay(null); setPickedService(null); }}
                onPickService={chooseService}
              />
            </div>
          )}

          {usingDaily && pickedService && (
            <ServiceDetail
              days={days}
              name={pickedService}
              budget={dailyBudget}
              currency={currency}
              onClose={() => setPickedService(null)}
              onPickDay={(date) => { setPickedDay(date); setShowTimeline(true); }}
            />
          )}
        </Panel>
        </div>
      </div>

      {/* ── Recommendations ───────────────────────────────────────────────── */}
      {/* Collapsed by default. Advice is read once and acted on later, so it
          does not deserve to sit permanently between the reader and the
          numbers; the count in the header is enough to say whether opening it
          is worth doing. */}
      <Panel
        title="Recommendations"
        subtitle={advice.length
          ? `${advice.length} thing${advice.length > 1 ? 's' : ''} worth acting on, worth ${fmt(adviceTotal)} ${per}`
          : 'Nothing to flag on this comparison.'}
        action={advice.length > 0 ? (
          <button
            onClick={() => setShowAdvice(v => !v)}
            className="flex items-center gap-1 rounded-lg border border-slate-700 px-2.5 py-1 text-[11px] text-slate-300 transition hover:border-slate-500 hover:text-white"
            aria-expanded={showAdvice}
          >
            {showAdvice ? 'Hide' : 'Show'}
            <ChevronDown size={12} className={showAdvice ? 'rotate-180 transition' : 'transition'} />
          </button>
        ) : null}
      >
        {advice.length === 0 ? (
          <p className="px-5 py-8 text-center text-xs text-slate-500">
            Every category is inside its budget and every charge has a matching BOQ line.
          </p>
        ) : !showAdvice ? (
          <button
            onClick={() => setShowAdvice(true)}
            className="w-full px-5 py-3.5 text-left text-xs text-slate-500 transition hover:bg-slate-800/30 hover:text-slate-300"
          >
            {advice[0].title}
            {advice.length > 1 && ` — and ${advice.length - 1} more.`}
            {' '}Each one names the money it is about.
          </button>
        ) : (
          <ul className="divide-y divide-slate-800">
            {advice.map((rec) => {
              const meta = SEVERITY[rec.severity] || SEVERITY.info;
              const Glyph = meta.icon;
              return (
                <li key={rec.id} className="flex items-start gap-3 px-5 py-3.5">
                  <Glyph size={15} className={`mt-0.5 shrink-0 ${meta.tone}`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium text-slate-100">{rec.title}</p>
                      <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-medium ${meta.chip}`}>
                        {meta.label}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-slate-400">{rec.detail}</p>
                    <p className="mt-1 flex items-start gap-1.5 text-[11px] leading-relaxed text-slate-500">
                      <Lightbulb size={11} className="mt-0.5 shrink-0" />
                      {rec.action}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className={`text-sm font-semibold tabular-nums ${meta.tone}`}>
                      {fmt(rec.impact)}
                    </p>
                    <p className="text-[10px] text-slate-600">{per}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </div>
  );
}
