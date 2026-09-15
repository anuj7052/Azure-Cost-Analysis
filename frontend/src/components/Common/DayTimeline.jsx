/**
 * A period as a sequence of things that happened.
 *
 * Written for the BOQ page and moved here when the Cost Explorer needed the
 * same thing: a chart can only show that a day was expensive, and a row per
 * calendar day is a list, not a timeline — thirty unremarkable days hide the
 * two that matter. Only days that did something appear, each with what drove
 * it, so the reader is handed the two days rather than asked to find them.
 *
 * The event selection itself lives in `utils/boqTrend.dayTimeline`, which both
 * callers share, so the two pages cannot disagree about which day moved.
 */
import { useMemo, useState } from 'react';
import {
  ArrowDownRight, ArrowUpRight, CircleDot, Minus, PlayCircle, StopCircle, TrendingUp,
} from 'lucide-react';

import { dayTimeline } from '../../utils/boqTrend';
import { formatAmount } from '../../utils/currency';

const KIND = {
  spike: { icon: TrendingUp, tone: 'text-rose-400', ring: 'border-rose-500/40' },
  drop: { icon: ArrowDownRight, tone: 'text-emerald-400', ring: 'border-emerald-500/40' },
  started: { icon: PlayCircle, tone: 'text-sky-400', ring: 'border-sky-500/40' },
  stopped: { icon: StopCircle, tone: 'text-slate-400', ring: 'border-slate-600' },
  over: { icon: CircleDot, tone: 'text-amber-400', ring: 'border-amber-500/40' },
};

/** A signed money figure, where the sign is the message. */
export function Delta({ value, currency, className = '' }) {
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

export default function DayTimeline({
  days, budget = null, currency, onPick, onPickService, selected,
  empty = 'Nothing stands out across this period — no day moved far from the one before it.',
  className = 'px-5 py-3',
  footerClassName = 'px-5 pb-3',
  emptyClassName = 'px-5 py-6 text-center text-xs text-slate-500',
}) {
  const events = useMemo(() => dayTimeline(days, budget), [days, budget]);
  // A scrollbar inside a page that already scrolls is a trap: the wheel does
  // one of two things depending on where the pointer happens to be, and the
  // reader cannot tell which until it happens. The list opens at a readable
  // length instead and grows on request.
  const [showAll, setShowAll] = useState(false);
  const FIRST = 6;

  if (events.length === 0) return <p className={emptyClassName}>{empty}</p>;

  const shown = showAll ? events : events.slice(0, FIRST);

  return (
    <>
      <ol className={className}>
        {shown.map((e, i) => {
          const meta = KIND[e.kind] || KIND.spike;
          const Glyph = meta.icon;
          const active = selected === e.date;
          return (
            <li key={`${e.date}:${e.kind}`} className="relative flex gap-3 pb-3.5">
              {/* The rail, drawn between the markers rather than behind them, so
                  the last event does not trail a line into nothing. */}
              {i < shown.length - 1 && (
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
                <button onClick={() => onPick?.(e.date)} aria-pressed={active} className="w-full text-left">
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
                          onClick={() => onPickService?.(d.name, e.date)}
                          className="underline-offset-2 hover:text-sky-400 hover:underline"
                        >
                          {d.name} {d.delta > 0 ? '+' : ''}{formatAmount(d.delta, currency)}
                        </button>
                      </span>
                    ))}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {events.length > FIRST && (
        <div className={footerClassName}>
          <button
            onClick={() => setShowAll(v => !v)}
            className="w-full rounded-lg border border-slate-800 py-1.5 text-[11px] text-slate-400 transition hover:border-slate-600 hover:text-white"
          >
            {showAll
              ? `Show only the ${FIRST} most recent`
              : `Show all ${events.length} days that moved`}
          </button>
        </div>
      )}
    </>
  );
}
