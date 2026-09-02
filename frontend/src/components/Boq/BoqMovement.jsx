/**
 * Why the bill moved, said next to the budget it moved against.
 *
 * The Compare page already answers "what changed between two months". It
 * answers it in service names and without a budget, so a reader who wants to
 * know whether a rise actually matters has to hold two pages in their head and
 * translate between them. This says the same thing in BOQ terms: which
 * categories moved, what drove each one, and whether the move crossed the line
 * the estimate drew.
 */
import { useMemo, useState } from 'react';
import { ArrowDownRight, ArrowUpRight, ChevronDown, Minus } from 'lucide-react';

import { bucketFor } from '../../utils/boqCompare';
import { movement } from '../../utils/boqTrend';
import { formatAmount } from '../../utils/currency';

const VERDICT = {
  'now-over': { label: 'Went over its BOQ line', tone: 'bg-rose-500/15 text-rose-300' },
  'still-over': { label: 'Still over its BOQ line', tone: 'bg-amber-500/15 text-amber-300' },
  'back-under': { label: 'Back under its BOQ line', tone: 'bg-emerald-500/15 text-emerald-300' },
  unbudgeted: { label: 'Not in the BOQ at all', tone: 'bg-rose-500/15 text-rose-300' },
  under: { label: 'Within its BOQ line', tone: 'bg-slate-700/40 text-slate-400' },
  none: { label: '', tone: '' },
};

export default function BoqMovement({ rows, report, currency, onFocusCategory }) {
  const [open, setOpen] = useState(null);
  // Which two months are being compared. Null means "the two most recent",
  // which is the question most people arrive with; naming a pair matters
  // because a rise that happened in March is not explained by comparing July
  // with June.
  const [pair, setPair] = useState({ from: null, to: null });
  const move = useMemo(
    () => movement(rows, bucketFor, report, pair),
    [rows, report, pair],
  );

  const fmt = (v) => formatAmount(v, currency);

  if (!move) {
    return (
      <div className="rounded-2xl border border-slate-800 bg-slate-900">
        <div className="border-b border-slate-800 px-5 py-3">
          <h2 className="text-sm font-semibold text-slate-200">Why the cost changed</h2>
        </div>
        <p className="px-5 py-8 text-center text-xs text-slate-500">
          Needs two months of usage to compare. Widen the date range and this fills in.
        </p>
      </div>
    );
  }

  const up = move.delta > 0;
  const Icon = Math.abs(move.delta) < 0.005 ? Minus : up ? ArrowUpRight : ArrowDownRight;
  const tone = Math.abs(move.delta) < 0.005 ? 'text-slate-400' : up ? 'text-rose-400' : 'text-emerald-400';

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-800 px-5 py-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-200">Why the cost changed</h2>
          <p className="mt-0.5 text-[11px] text-slate-500">
            Grouped the way the BOQ is written, so a rise can be read against the line that
            was meant to cover it.
          </p>
        </div>
        {/* Any two months in the range, not only the last two. Comparing a
            month with itself is not offered, because the answer would be a
            confident zero that means nothing. */}
        {move.months.length > 2 && (
          <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
            <label className="sr-only" htmlFor="boq-move-from">Compare from</label>
            <select
              id="boq-move-from"
              value={move.from}
              onChange={e => setPair(p => ({ ...p, from: e.target.value }))}
              className="rounded-lg border border-slate-700 bg-slate-800 px-2 py-1 text-slate-200 outline-none focus:border-sky-500"
            >
              {move.months.filter(m => m !== move.to).map(m => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
            <span aria-hidden>→</span>
            <label className="sr-only" htmlFor="boq-move-to">Compare to</label>
            <select
              id="boq-move-to"
              value={move.to}
              onChange={e => setPair(p => ({ ...p, to: e.target.value }))}
              className="rounded-lg border border-slate-700 bg-slate-800 px-2 py-1 text-slate-200 outline-none focus:border-sky-500"
            >
              {move.months.filter(m => m !== move.from).map(m => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-slate-800 px-5 py-3.5">
        <div>
          <p className="text-[10px] uppercase tracking-wide text-slate-500">{move.from}</p>
          <p className="mt-0.5 text-lg font-semibold tabular-nums text-slate-300">{fmt(move.fromTotal)}</p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wide text-slate-500">{move.to}</p>
          <p className="mt-0.5 text-lg font-semibold tabular-nums text-slate-100">{fmt(move.toTotal)}</p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wide text-slate-500">Change</p>
          <p className={`mt-0.5 flex items-center gap-1 text-lg font-semibold tabular-nums ${tone}`}>
            <Icon size={16} />
            {fmt(Math.abs(move.delta))}
            {move.deltaPct !== null && (
              <span className="text-xs font-normal">
                ({move.deltaPct > 0 ? '+' : ''}{move.deltaPct}%)
              </span>
            )}
          </p>
        </div>
      </div>

      {move.categories.length === 0 ? (
        <p className="px-5 py-8 text-center text-xs text-slate-500">
          No category moved by enough to be worth reporting.
        </p>
      ) : (
        <ul className="divide-y divide-slate-800">
          {move.categories.map((c) => {
            const verdict = VERDICT[c.verdict] || VERDICT.none;
            const rising = c.delta > 0;
            const expanded = open === c.key;
            return (
              <li key={c.key}>
                <button
                  onClick={() => setOpen(expanded ? null : c.key)}
                  className="flex w-full items-start gap-3 px-5 py-3 text-left transition hover:bg-slate-800/30"
                  aria-expanded={expanded}
                >
                  <ChevronDown
                    size={14}
                    className={`mt-0.5 shrink-0 text-slate-600 transition ${expanded ? 'rotate-180' : ''}`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium text-slate-100">{c.label}</p>
                      {verdict.label && (
                        <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-medium ${verdict.tone}`}>
                          {verdict.label}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-[11px] tabular-nums text-slate-500">
                      {fmt(c.from)} → {fmt(c.to)}
                      {c.budgeted > 0 && ` · BOQ allows ${fmt(c.budgeted)} a month`}
                    </p>
                  </div>
                  <p className={`shrink-0 text-sm font-semibold tabular-nums ${
                    rising ? 'text-rose-400' : 'text-emerald-400'}`}>
                    {rising ? '+' : '−'}{fmt(Math.abs(c.delta))}
                    {c.deltaPct !== null && (
                      <span className="ml-1 text-[10px] font-normal text-slate-500">
                        {c.deltaPct > 0 ? '+' : ''}{c.deltaPct}%
                      </span>
                    )}
                  </p>
                </button>

                {expanded && (
                  <div className="border-t border-slate-800/60 bg-slate-950/40 px-5 py-3">
                    {c.services.length === 0 ? (
                      <p className="text-[11px] text-slate-500">
                        The category moved but no single service accounts for it.
                      </p>
                    ) : (
                      <>
                        <p className="mb-1.5 text-[10px] uppercase tracking-wide text-slate-500">
                          What drove it
                        </p>
                        <ul className="space-y-1">
                          {c.services.map(s => (
                            <li key={s.name} className="flex items-baseline justify-between gap-3 text-xs">
                              <span className="truncate text-slate-300">{s.name}</span>
                              <span className="shrink-0 tabular-nums text-slate-500">
                                {fmt(s.from)} → {fmt(s.to)}
                                <span className={`ml-2 ${s.delta > 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                                  {s.delta > 0 ? '+' : '−'}{fmt(Math.abs(s.delta))}
                                </span>
                              </span>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                    {onFocusCategory && (
                      <button
                        onClick={() => onFocusCategory(c.key)}
                        className="mt-2.5 rounded-lg border border-slate-700 px-2.5 py-1 text-[11px] text-slate-300 transition hover:border-slate-500 hover:text-white"
                      >
                        See every charge in {c.label}
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
