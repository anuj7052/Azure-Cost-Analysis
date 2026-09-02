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
import { useMemo, useState } from 'react';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts';
import {
  AlertTriangle, ArrowDownRight, ArrowUpRight, CheckCircle, ChevronDown, ChevronRight,
  Info, Lightbulb, Minus,
} from 'lucide-react';

import { useChartTheme } from '../../store/useTheme';
import { formatAmount } from '../../utils/currency';
import { dailySeries, finops, monthlySeries, recommend, topSpend } from '../../utils/boqDashboard';
import { DayDetail, DayTimeline, ServiceDetail } from './BoqDayDetail';
import { ResourceDetail, ServiceResources } from './BoqResourcePanel';

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

function Panel({ title, subtitle, children, action }) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900">
      <div className="flex items-start justify-between gap-3 border-b border-slate-800 px-5 py-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-200">{title}</h2>
          {subtitle && <p className="mt-0.5 text-[11px] text-slate-500">{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

export default function BoqDashboard({
  report, months, days, rows, resourceQuery, tenantId, onFocusCategory, onShowOverruns,
}) {
  const t = useChartTheme();
  const [cumulative, setCumulative] = useState(false);
  // Which day the reader asked about, and whether they want the sequence of
  // events rather than the chart. Both default off: the chart is the summary,
  // and opening every explanation at once is not a summary.
  const [pickedDay, setPickedDay] = useState(null);
  const [showTimeline, setShowTimeline] = useState(false);
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
  function chooseDay(date) {
    setPickedDay(prev => (prev === date ? null : date));
    setPickedService(null);
    if (date) setShowTimeline(true);
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
  const spendTop = useMemo(() => topSpend(report, 'actual', 5), [report]);
  // Overruns are ranked by variance, which only exists where something was
  // budgeted; an unbudgeted category has no variance to rank by and shows up in
  // its own recommendation instead.
  const overTop = useMemo(
    () => topSpend({ categories: (report?.categories || []).filter(c => c.variance > 0) }, 'variance', 5),
    [report],
  );
  const advice = useMemo(() => recommend(report, { per }), [report, per]);
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

  if (!report || !head) return null;

  // Daily data is the better read, but an imported usage file has no day grain.
  // Falling back to months is honest; inventing days from a monthly total would
  // draw a flat line that looks like a measurement.
  const usingDaily = daily.length > 0;
  const series = usingDaily ? daily : monthly;

  const trend = head.trendPct;
  const TrendIcon = trend === null ? Minus : trend > 0 ? ArrowUpRight : ArrowDownRight;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
        {/* The chart leads on the left because it is the thing people read
            first and then click into; the four figures on the right are the
            summary they check it against. Ordered rather than reordered in the
            markup so the summary still comes first when the two stack on a
            narrow screen. */}
        <div className="space-y-4 xl:order-2">
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

        <div className="space-y-4 xl:order-1">
        {/* ── Spend against budget over time ──────────────────────────────── */}
        <Panel
          title={usingDaily ? 'Daily Spend' : 'Monthly Spend'}
          subtitle={usingDaily
            ? 'Actual against the daily share of the BOQ. Click any day to see what made it that amount.'            : 'No daily detail available — showing months'}
          action={usingDaily ? (
            <div className="flex gap-1.5">
              <button
                onClick={() => setShowTimeline(v => !v)}
                className={`rounded-lg border px-2.5 py-1 text-[11px] transition ${
                  showTimeline
                    ? 'border-sky-500/50 bg-sky-500/10 text-sky-300'
                    : 'border-slate-700 text-slate-300 hover:border-slate-600 hover:text-white'
                }`}
              >
                Timeline
              </button>
              <button
                onClick={() => setCumulative(v => !v)}
                className="rounded-lg border border-slate-700 px-2.5 py-1 text-[11px] text-slate-300 hover:border-slate-600 hover:text-white"
              >
                {cumulative ? 'Per day' : 'Running total'}
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
              <ResponsiveContainer width="100%" height={250}>
                <AreaChart
                  data={series}
                  margin={{ top: 5, right: 16, left: 4, bottom: 0 }}
                  onClick={usingDaily ? (e) => {
                    const full = e?.activePayload?.[0]?.payload?.full;
                    if (full) chooseDay(full);
                  } : undefined}
                  style={usingDaily ? { cursor: 'pointer' } : undefined}
                >
                  <defs>
                    <linearGradient id="boqActualFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={t.series[0]} stopOpacity={0.35} />
                      <stop offset="100%" stopColor={t.series[0]} stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke={t.grid} vertical={false} />
                  <XAxis dataKey="date" tick={{ fill: t.axis, fontSize: 10 }} axisLine={false}
                    tickLine={false} minTickGap={20} />
                  <YAxis tick={{ fill: t.axis, fontSize: 10 }} axisLine={false} tickLine={false}
                    width={58}
                    tickFormatter={v => (v >= 1000 ? `${(v / 1000).toFixed(0)}K` : v)} />
                  <Tooltip cursor={t.tooltipCursor} contentStyle={t.tooltip}
                    labelStyle={t.tooltipLabel}
                    formatter={(val, key) => [val === null ? 'Not available' : fmt(val), key]} />
                  <Legend iconType="circle" iconSize={8}
                    wrapperStyle={{ color: t.axis, fontSize: 11 }} />
                  <Area
                    type="monotone"
                    name="Actual"
                    dataKey={cumulative && usingDaily ? 'cumulativeActual' : 'actual'}
                    stroke={t.series[0]}
                    fill="url(#boqActualFill)"
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4 }}
                  />
                  <Line
                    type="monotone"
                    name="BOQ budget"
                    dataKey={cumulative && usingDaily ? 'cumulativeBudget' : 'budget'}
                    stroke={t.series[4]}
                    strokeWidth={2}
                    strokeDasharray="5 4"
                    dot={false}
                    connectNulls={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>

          {/* The sequence of things that happened, for a reader who wants the
              period rather than one day of it. */}
          {usingDaily && showTimeline && (
            <div className="border-t border-slate-800">
              <p className="px-5 pt-3 text-[11px] text-slate-500">
                Only the days that moved. Pick one to see everything charged on it, or a
                service name to follow it across the period.
              </p>
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
            <DayDetail
              days={days}
              date={pickedDay}
              budget={dailyBudget}
              currency={currency}
              onClose={() => { setPickedDay(null); setPickedService(null); }}
              onPickService={chooseService}
            />
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

      {/* ── Where the money went ──────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Panel title="Top 5 Spend by Category"
          subtitle="Actual charges. Red where the category is over its BOQ line.">
          <TopChart data={spendTop} t={t} fmt={fmt} onPick={onFocusCategory} empty="Nothing charged yet." />
        </Panel>
        <Panel title="Top 5 Overruns"
          subtitle="How much each category is costing above what the BOQ budgeted.">
          <TopChart data={overTop} t={t} fmt={fmt} onPick={onFocusCategory}
            allOver empty="Nothing is over budget." />
        </Panel>
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

function TopChart({ data, t, fmt, onPick, allOver = false, empty }) {
  if (!data.length) {
    return <p className="px-5 py-12 text-center text-xs text-slate-500">{empty}</p>;
  }
  return (
    <div className="px-2 py-4">
      <ResponsiveContainer width="100%" height={250}>
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 24, left: 8, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={t.grid} horizontal={false} />
          <XAxis type="number" tick={{ fill: t.axis, fontSize: 10 }} axisLine={false}
            tickLine={false}
            tickFormatter={v => (v >= 1000 ? `${(v / 1000).toFixed(0)}K` : v)} />
          <YAxis type="category" dataKey="name" width={160} tick={{ fill: t.axis, fontSize: 10 }}
            axisLine={false} tickLine={false} />
          <Tooltip cursor={t.tooltipCursor} contentStyle={t.tooltip} labelStyle={t.tooltipLabel}
            formatter={(val) => [fmt(val), 'Amount']} />
          <Bar dataKey="value" radius={[0, 3, 3, 0]} barSize={18}
            onClick={(d) => !d?.payload?.rest && onPick?.(d?.payload?.key)}
            cursor={onPick ? 'pointer' : 'default'}>
            {data.map((d, i) => (
              <Cell key={i} fill={d.rest ? t.grid : (allOver || d.over) ? '#ef4444' : t.series[0]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
