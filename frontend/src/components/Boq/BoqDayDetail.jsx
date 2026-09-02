/**
 * Why a single day cost what it did, and what has happened across the period.
 *
 * Sits under the Daily Spend chart. The chart can only ever show that a day was
 * expensive; these two panels say what made it expensive, which is the point at
 * which somebody can actually do something. Both read the same daily series the
 * chart is drawn from, so neither can contradict the line above them.
 */
import { useMemo } from 'react';
import {
  ArrowDownRight, ArrowUpRight, CalendarDays, ChevronRight, CircleDot, Minus,
  PlayCircle, StopCircle, TrendingUp, X,
} from 'lucide-react';
import {
  Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';

import { useChartTheme } from '../../store/useTheme';
import { dayDetail, dayTimeline, serviceDetail } from '../../utils/boqTrend';
import { formatAmount } from '../../utils/currency';

const KIND = {
  spike: { icon: TrendingUp, tone: 'text-rose-400', ring: 'border-rose-500/40' },
  drop: { icon: ArrowDownRight, tone: 'text-emerald-400', ring: 'border-emerald-500/40' },
  started: { icon: PlayCircle, tone: 'text-sky-400', ring: 'border-sky-500/40' },
  stopped: { icon: StopCircle, tone: 'text-slate-400', ring: 'border-slate-600' },
  over: { icon: CircleDot, tone: 'text-amber-400', ring: 'border-amber-500/40' },
};

/** A signed money figure, where the sign is the message. */
function Delta({ value, currency, className = '' }) {
  if (value === null || value === undefined) {
    return <span className={`text-slate-600 ${className}`}>Not available</span>;
  }
  const up = value > 0;
  const flat = Math.abs(value) < 0.005;
  const Icon = flat ? Minus : up ? ArrowUpRight : ArrowDownRight;
  const tone = flat ? 'text-slate-500' : up ? 'text-rose-400' : 'text-emerald-400';
  return (
    <span className={`inline-flex items-center gap-0.5 tabular-nums ${tone} ${className}`}>
      <Icon size={12} />
      {formatAmount(Math.abs(value), currency)}
    </span>
  );
}

/**
 * The full breakdown of one day.
 *
 * Every service is listed, not a top five: the question being asked is "why is
 * this day this amount", and an answer that omits a third of the money is not
 * an answer. The change column is against the previous day rather than an
 * average, because a spike is caused by something that was not there yesterday.
 */
export function DayDetail({ days, date, budget, currency, onClose, onPickService }) {
  const detail = useMemo(() => dayDetail(days, date, budget), [days, date, budget]);
  if (!detail) return null;

  const fmt = (v) => formatAmount(v, currency);

  return (
    <div className="border-t border-slate-800">
      <div className="flex items-start justify-between gap-3 px-5 py-3">
        <div>
          <p className="flex items-center gap-1.5 text-sm font-semibold text-slate-200">
            <CalendarDays size={14} /> {detail.date}
          </p>
          <p className="mt-0.5 text-[11px] text-slate-500">
            {detail.previousDate
              ? <>Charged {fmt(detail.total)} — <Delta value={detail.change} currency={currency} />{' '}
                against {detail.previousDate}
                {detail.changePct !== null && ` (${detail.changePct > 0 ? '+' : ''}${detail.changePct}%)`}</>
              : `Charged ${fmt(detail.total)}. This is the first day in the period, so there is nothing to compare it with.`}
          </p>
          {detail.budget !== null && (
            <p className={`mt-0.5 text-[11px] ${detail.overBudget ? 'text-rose-400' : 'text-emerald-400'}`}>
              {detail.overBudget ? 'Above' : 'Within'} the BOQ’s daily share of {fmt(detail.budget)}.
            </p>
          )}
        </div>
        <button
          onClick={onClose}
          className="rounded-lg border border-slate-700 p-1 text-slate-400 transition hover:border-slate-500 hover:text-white"
          aria-label="Close day detail"
        >
          <X size={13} />
        </button>
      </div>

      {detail.movers.length > 0 && (
        <div className="mx-5 mb-3 rounded-xl border border-slate-800 bg-slate-950/50 px-3.5 py-2.5">
          <p className="text-[10px] uppercase tracking-wide text-slate-500">What moved</p>
          <ul className="mt-1.5 space-y-1">
            {detail.movers.map(m => (
              <li key={m.name} className="flex items-baseline justify-between gap-3 text-xs">
                <button
                  onClick={() => onPickService?.(m.name)}
                  className="min-w-0 truncate text-left text-slate-300 underline-offset-2 hover:text-sky-300 hover:underline"
                >
                  {m.name}
                  {m.isNew && <span className="ml-1.5 rounded bg-sky-500/15 px-1 py-0.5 text-[9px] text-sky-300">new</span>}
                  {m.stopped && <span className="ml-1.5 rounded bg-slate-700/40 px-1 py-0.5 text-[9px] text-slate-400">stopped</span>}
                </button>
                <Delta value={m.delta} currency={currency} className="shrink-0 text-xs" />
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="max-h-72 overflow-y-auto">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-slate-900 text-[10px] uppercase tracking-wide text-slate-500">
            <tr className="border-y border-slate-800">
              <th className="px-5 py-2 font-medium">Service</th>              <th className="px-3 py-2 text-right font-medium">Cost</th>
              <th className="px-3 py-2 text-right font-medium">Share</th>
              <th className="px-5 py-2 text-right font-medium">
                {detail.previousDate ? 'vs day before' : 'Change'}
              </th>
            </tr>
          </thead>
          <tbody>
            {detail.services.map(s => (              <tr key={s.name} className="border-b border-slate-800/50 last:border-0 hover:bg-slate-800/30">
                <td className="max-w-[16rem] px-5 py-1.5" title={s.name}>
                  <button
                    onClick={() => onPickService?.(s.name)}
                    className="group flex w-full min-w-0 items-center gap-1 text-left text-slate-300 transition hover:text-sky-300"
                  >
                    <span className="truncate">{s.name}</span>
                    {s.isNew && <span className="shrink-0 rounded bg-sky-500/15 px-1 py-0.5 text-[9px] text-sky-300">new</span>}
                    {s.stopped && <span className="shrink-0 rounded bg-slate-700/40 px-1 py-0.5 text-[9px] text-slate-400">stopped</span>}
                    <ChevronRight size={11} className="shrink-0 opacity-0 transition group-hover:opacity-100" />
                  </button>
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums text-slate-200">{fmt(s.cost)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-slate-500">
                  {s.share > 0 ? `${s.share}%` : '—'}
                </td>
                <td className="px-5 py-1.5 text-right">
                  <Delta value={s.delta} currency={currency} className="text-xs" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * The period as a sequence of things that happened.
 *
 * Only days that did something appear. A timeline of every day is a list, and a
 * list of thirty unremarkable days hides the two that matter.
 */
export function DayTimeline({ days, budget, currency, onPick, onPickService, selected }) {
  const events = useMemo(() => dayTimeline(days, budget), [days, budget]);
  if (events.length === 0) {
    return (
      <p className="px-5 py-6 text-center text-xs text-slate-500">
        Nothing stands out across this period — no day moved far from the one before it.
      </p>
    );
  }

  return (
    <ol className="max-h-96 overflow-y-auto px-5 py-3">
      {events.map((e, i) => {
        const meta = KIND[e.kind] || KIND.spike;
        const Glyph = meta.icon;
        const active = selected === e.date;
        return (
          <li key={`${e.date}:${e.kind}`} className="relative flex gap-3 pb-3.5">
            {/* The rail, drawn between the markers rather than behind them, so
                the last event does not trail a line into nothing. */}
            {i < events.length - 1 && (
              <span className="absolute left-[11px] top-6 h-full w-px bg-slate-800" aria-hidden />
            )}
            <span className={`relative z-10 mt-0.5 flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border bg-slate-900 ${meta.ring}`}>
              <Glyph size={12} className={meta.tone} />
            </span>
            <div
              className={`min-w-0 flex-1 rounded-xl border px-3 py-2 transition ${
                active
                  ? 'border-sky-500/50 bg-sky-500/5'
                  : 'border-transparent hover:border-slate-700 hover:bg-slate-800/40'
              }`}
            >
              <button onClick={() => onPick?.(e.date)} className="w-full text-left">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-xs font-medium text-slate-200">{e.title}</p>
                  <span className="text-[10px] tabular-nums text-slate-500">{e.date}</span>
                </div>
                <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500">
                  <span className="tabular-nums">{formatAmount(e.total, currency)} that day</span>
                  <span>·</span>
                  <Delta value={e.delta} currency={currency} className="text-[11px]" />
                  {e.deltaPct !== null && (
                    <span className="tabular-nums">({e.deltaPct > 0 ? '+' : ''}{e.deltaPct}%)</span>
                  )}
                </p>
              </button>
              {/* The drivers sit outside the day button so each one can be its
                  own target — the name is usually what the reader wants next,
                  not the day it happened on. */}
              {e.drivers.length > 0 && (
                <p className="mt-1 flex flex-wrap gap-x-1.5 gap-y-0.5 text-[11px] text-slate-600">
                  {e.drivers.map((d, n) => (
                    <span key={d.name} className="inline-flex items-center gap-1.5">
                      {n > 0 && <span aria-hidden>·</span>}
                      <button
                        onClick={() => onPickService?.(d.name)}
                        className="underline-offset-2 hover:text-sky-400 hover:underline"
                      >
                        {d.name} {d.delta > 0 ? '+' : ''}{formatAmount(d.delta, currency)}
                      </button>
                    </span>
                  ))}
                </p>
              )}
            </div>          </li>
        );
      })}
    </ol>
  );
}

/**
 * One service, followed across the whole period.
 *
 * Reached by clicking a service in the day breakdown, and it answers the
 * question that immediately follows the day: is this what the service always
 * costs, or was that day unusual? A single day cannot say. The chart keeps
 * every day in the range including the ones with no charge, because a service
 * billed on nine days out of ninety is a different finding from one billed on
 * all ninety, and dropping the empty days makes the two look the same.
 */
export function ServiceDetail({ days, name, budget, currency, onClose, onPickDay }) {
  const t = useChartTheme();
  const detail = useMemo(() => serviceDetail(days, name, budget), [days, name, budget]);
  if (!detail) return null;

  const fmt = (v) => formatAmount(v, currency);
  const growing = detail.drift > 0;

  return (
    <div className="border-t border-slate-800 bg-slate-950/30">
      <div className="flex items-start justify-between gap-3 px-5 py-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-slate-100" title={detail.name}>
            {detail.name}
          </p>
          <p className="mt-0.5 text-[11px] text-slate-500">
            {fmt(detail.total)} across the period — {detail.share}% of everything charged.
          </p>
        </div>
        <button
          onClick={onClose}
          className="rounded-lg border border-slate-700 p-1 text-slate-400 transition hover:border-slate-500 hover:text-white"
          aria-label="Close service detail"
        >
          <X size={13} />
        </button>
      </div>

      {/* The figures somebody needs before deciding whether to act. */}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 px-5 pb-3 sm:grid-cols-4">
        <div>
          <dt className="text-[10px] uppercase tracking-wide text-slate-500">Typical day</dt>
          <dd className="mt-0.5 text-sm font-semibold tabular-nums text-slate-200">
            {fmt(detail.average)}
          </dd>
          <dd className="text-[10px] text-slate-600">averaged over days it was billed</dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-wide text-slate-500">Most expensive day</dt>
          <dd className="mt-0.5 text-sm font-semibold tabular-nums text-slate-200">
            {fmt(detail.peak.cost)}
          </dd>
          <dd className="text-[10px] text-slate-600">
            <button
              onClick={() => onPickDay?.(detail.peak.date)}
              className="underline-offset-2 hover:text-sky-400 hover:underline"
            >
              {detail.peak.date}
            </button>
            {detail.peakShare !== null && ` · ${detail.peakShare}% of that day`}
          </dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-wide text-slate-500">Days billed</dt>
          <dd className="mt-0.5 text-sm font-semibold tabular-nums text-slate-200">
            {detail.daysBilled} of {detail.daysInPeriod}
          </dd>
          <dd className="text-[10px] text-slate-600">
            {detail.everyDay ? 'every day in the period' : `first ${detail.first}, last ${detail.last}`}
          </dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-wide text-slate-500">Direction</dt>
          <dd className={`mt-0.5 flex items-center gap-1 text-sm font-semibold tabular-nums ${
            Math.abs(detail.drift) < 0.005
              ? 'text-slate-400'
              : growing ? 'text-rose-400' : 'text-emerald-400'}`}>
            {Math.abs(detail.drift) < 0.005
              ? <Minus size={14} />
              : growing ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}
            {fmt(Math.abs(detail.drift))}
          </dd>
          <dd className="text-[10px] text-slate-600">
            second half against first
            {detail.driftPct !== null && ` · ${detail.driftPct > 0 ? '+' : ''}${detail.driftPct}%`}
          </dd>
        </div>
      </dl>

      <div className="px-2 pb-2">
        <ResponsiveContainer width="100%" height={150}>
          <AreaChart
            data={detail.points}
            margin={{ top: 4, right: 16, left: 4, bottom: 0 }}
            onClick={(e) => {
              const d = e?.activePayload?.[0]?.payload?.date;
              if (d) onPickDay?.(d);
            }}
            style={{ cursor: 'pointer' }}
          >
            <defs>
              <linearGradient id="boqServiceFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={t.series[1]} stopOpacity={0.35} />
                <stop offset="100%" stopColor={t.series[1]} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={t.grid} vertical={false} />
            <XAxis dataKey="date" tick={{ fill: t.axis, fontSize: 9 }} axisLine={false}
              tickLine={false} minTickGap={24}
              tickFormatter={v => String(v).slice(5)} />
            <YAxis tick={{ fill: t.axis, fontSize: 9 }} axisLine={false} tickLine={false}
              width={54}
              tickFormatter={v => (v >= 1000 ? `${(v / 1000).toFixed(0)}K` : v)} />
            <Tooltip cursor={t.tooltipCursor} contentStyle={t.tooltip} labelStyle={t.tooltipLabel}
              formatter={(val) => [fmt(val), detail.name]} />
            <Area type="monotone" dataKey="cost" stroke={t.series[1]}
              fill="url(#boqServiceFill)" strokeWidth={2} dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {detail.gaps.length > 0 && (
        <div className="mx-5 mb-3 rounded-xl border border-amber-500/25 bg-amber-500/5 px-3.5 py-2.5">
          <p className="text-[10px] uppercase tracking-wide text-amber-400/80">
            Not billed on every day
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
            {detail.gaps.map(g => (g.days === 1 ? g.from : `${g.from} to ${g.to} (${g.days} days)`)).join(', ')}.
            {' '}A gap is either the resource being off or the meter not being charged — worth
            knowing before treating the average as a monthly run rate.
          </p>
        </div>
      )}

      {detail.moves.length > 0 && (
        <div className="mx-5 mb-4 rounded-xl border border-slate-800 bg-slate-950/50 px-3.5 py-2.5">
          <p className="text-[10px] uppercase tracking-wide text-slate-500">
            Biggest day-to-day changes
          </p>
          <ul className="mt-1.5 space-y-1">
            {detail.moves.map(m => (
              <li key={m.date} className="flex items-baseline justify-between gap-3 text-xs">
                <button
                  onClick={() => onPickDay?.(m.date)}
                  className="text-slate-400 underline-offset-2 hover:text-sky-300 hover:underline"
                >
                  {m.date}
                </button>
                <span className="shrink-0 tabular-nums text-slate-500">
                  {fmt(m.from)} → {fmt(m.to)}
                  <Delta value={m.delta} currency={currency} className="ml-2 text-xs" />
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

