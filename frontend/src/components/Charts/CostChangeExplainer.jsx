import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import { changeHeadline, explainChange } from '../../utils/costChange';
import { formatAmountFull } from '../../utils/currency';
import { Callout } from '../ui';

/**
 * "Why did this go up?" answered above the table that proves it.
 *
 * The delta table underneath is the evidence; this is the reading of it. They
 * are separate components because the table is also the thing you scan when you
 * already know the answer and want the exact figure.
 */
export default function CostChangeExplainer({
  current, prior, label, priorLabel, currency, totalKey = 'total',
  partial = false, priorPartial = false,
}) {
  const reading = explainChange(current, prior, { totalKey, label, priorLabel, partial, priorPartial });
  const money = (value) => (Number.isFinite(value) ? formatAmountFull(value, currency) : '—');

  if (reading.status !== 'ok') {
    return (
      <Callout tone={reading.status === 'incomparable' ? 'medium' : 'info'} title={`Why ${label} moved cannot be shown`}>
        {reading.notes[0]}
      </Callout>
    );
  }

  const up = reading.direction === 'up';
  const flat = reading.direction === 'flat';
  const Icon = flat ? Minus : up ? ArrowUpRight : ArrowDownRight;
  const tone = flat ? 'text-slate-300' : up ? 'text-amber-300' : 'text-emerald-300';
  const ring = flat ? 'border-slate-700' : up ? 'border-amber-500/40' : 'border-emerald-500/40';

  return (
    <section aria-label={`Why ${label} changed`} className={`rounded-2xl border ${ring} bg-slate-900/60 p-4`}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className={`inline-flex items-center gap-1.5 text-lg font-semibold ${tone}`}>
          <Icon className="h-5 w-5" aria-hidden="true" />
          {reading.delta > 0 ? '+' : ''}{money(reading.delta)}
        </span>
        {reading.percent !== null && (
          <span className={`text-sm ${tone}`}>{reading.percent > 0 ? '+' : ''}{reading.percent.toFixed(1)}%</span>
        )}
        <span className="text-xs text-slate-500">
          {priorLabel} {money(reading.priorTotal)} → {label} {money(reading.currentTotal)}
        </span>
      </div>

      <p className="mt-2 text-sm leading-relaxed text-slate-300">{changeHeadline(reading, money)}</p>

      {(reading.risers.length > 0 || reading.fallers.length > 0) && (
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Movers
            title="Pushed the bill up"
            rows={reading.risers}
            total={reading.grossUp}
            count={reading.riserCount}
            money={money}
            bar="bg-amber-400"
            text="text-amber-300"
          />
          <Movers
            title="Pulled the bill down"
            rows={reading.fallers}
            total={reading.grossDown}
            count={reading.fallerCount}
            money={money}
            bar="bg-emerald-400"
            text="text-emerald-300"
          />
        </div>
      )}

      {(reading.started.length > 0 || reading.stopped.length > 0) && (
        <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-xs">
          {reading.started.length > 0 && (
            <p className="text-slate-400">
              <span className="text-amber-300">Started billing:</span> {reading.started.join(', ')}
              <span className="text-slate-600"> — absent from {priorLabel}, charged in {label}.</span>
            </p>
          )}
          {reading.stopped.length > 0 && (
            <p className="text-slate-400">
              <span className="text-emerald-300">Stopped billing:</span> {reading.stopped.join(', ')}
              <span className="text-slate-600"> — charged in {priorLabel}, absent from {label}.</span>
            </p>
          )}
        </div>
      )}

      {reading.residual !== null && Math.abs(reading.residual) >= 0.01 && (
        <p className="mt-3 text-xs text-slate-400">
          Unattributed remainder: {reading.residual > 0 ? '+' : ''}{money(reading.residual)}
          {reading.residualShare !== null && ` (${Math.round(Math.abs(reading.residualShare) * 100)}% of the change)`}.
          {' '}This part of the movement carries no service name in Azure&rsquo;s grouped totals.
        </p>
      )}

      <ul className="mt-3 space-y-1 border-t border-slate-800 pt-3 text-[11px] leading-relaxed text-slate-500">
        {reading.notes.map((note) => <li key={note}>{note}</li>)}
      </ul>
    </section>
  );
}

function Movers({ title, rows, total, count, money, bar, text }) {
  if (!rows.length) return <div className="text-xs text-slate-600">{title}: nothing moved by more than a rounding amount.</div>;
  return (
    <div>
      <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        {title} · {money(total)}
      </h4>
      <ul className="mt-2 space-y-1.5">
        {rows.map((row) => (
          <li key={row.name} className="flex items-center gap-2 text-xs">
            <span className="min-w-0 flex-1 truncate text-slate-300" title={row.name}>{row.name}</span>
            <span className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-slate-800 sm:block">
              <span className={`block h-full rounded-full ${bar}`} style={{ width: `${Math.round((row.share || 0) * 100)}%` }} />
            </span>
            <span className={`w-24 shrink-0 text-right tabular-nums ${text}`}>
              {row.delta > 0 ? '+' : ''}{money(row.delta)}
            </span>
          </li>
        ))}
      </ul>
      {count > rows.length && (
        <p className="mt-1.5 text-[11px] text-slate-600">and {count - rows.length} more — the full list is in the table below.</p>
      )}
    </div>
  );
}
