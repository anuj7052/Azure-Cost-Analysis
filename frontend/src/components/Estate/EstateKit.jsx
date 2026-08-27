import { Link } from 'react-router-dom';
import { AlertCircle, ArrowRight, Check, Circle, Loader2, Minus, RotateCw, TrendingDown, TrendingUp, X } from 'lucide-react';

/**
 * Dense presentation primitives for the Estate Command Center.
 *
 * None of these components decide anything. They are handed a value and a
 * state, and their only job is to make sure the four states an operational
 * dashboard actually has — loading, empty, unavailable, and a real answer —
 * never render as each other. A skeleton that resolves into "0" when the
 * request failed is worse than an error message, because the reader believes
 * it.
 *
 * This module exports components only, so Fast Refresh stays happy.
 */

const SEVERITY_STYLE = {
  critical: 'bg-rose-500/15 text-rose-300 ring-rose-500/30',
  high: 'bg-orange-500/15 text-orange-300 ring-orange-500/30',
  medium: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
  low: 'bg-sky-500/15 text-sky-300 ring-sky-500/30',
  info: 'bg-slate-500/15 text-slate-300 ring-slate-500/30',
  good: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
  neutral: 'bg-slate-500/15 text-slate-400 ring-slate-500/30',
};

const HEALTH_STYLE = {
  good: 'text-emerald-400',
  fair: 'text-amber-400',
  poor: 'text-rose-400',
  unknown: 'text-slate-500',
};

const HEALTH_BAR = {
  good: 'bg-emerald-500',
  fair: 'bg-amber-500',
  poor: 'bg-rose-500',
  unknown: 'bg-slate-700',
};

/** A severity chip. Unknown severities fall back to neutral rather than vanishing. */
export function Severity({ level, children }) {
  const style = SEVERITY_STYLE[level] || SEVERITY_STYLE.neutral;
  return (
    <span className={`inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide ring-1 ring-inset ${style}`}>
      {children || level || 'unknown'}
    </span>
  );
}

/**
 * A figure that may not exist.
 *
 * `value` of `null` renders the supplied `fallback` in muted type, never a
 * zero and never an empty cell that looks like a rendering bug.
 */
export function Figure({ value, fallback = 'Not available', className = '', title }) {
  if (value === null || value === undefined || value === '') {
    return <span className="text-[11px] italic text-slate-600" title={title}>{fallback}</span>;
  }
  return <span className={className} title={title}>{value}</span>;
}

/** A signed movement, coloured by whether spending more is the news. */
export function Delta({ pct, tone = 'cost', className = '' }) {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) {
    return <span className="text-[11px] italic text-slate-600">—</span>;
  }
  const up = pct > 0.5;
  const down = pct < -0.5;
  const Icon = up ? TrendingUp : (down ? TrendingDown : Minus);
  const good = tone === 'cost' ? down : up;
  const bad = tone === 'cost' ? up : down;
  const colour = good ? 'text-emerald-400' : (bad ? 'text-rose-400' : 'text-slate-500');
  return (
    <span className={`inline-flex items-center gap-1 tabular-nums ${colour} ${className}`}>
      <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
      {pct > 0 ? '+' : ''}{pct.toFixed(1)}%
    </span>
  );
}

/** Grey blocks that stand in for a figure while its request is in flight. */
export function Skeleton({ rows = 3, className = '' }) {
  return (
    <div className={`space-y-2 ${className}`} aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-4 animate-pulse rounded bg-slate-800" style={{ width: `${100 - i * 12}%` }} />
      ))}
    </div>
  );
}

/**
 * The one place a section's non-answer is rendered.
 *
 * Returns `null` when there is real data to show, so a caller can write
 * `<SectionState .../> ?? <Table/>` and cannot accidentally render a table of
 * zeros over the top of a failed request.
 */
export function SectionState({ loading, error, empty, onRetry, emptyText = 'No data available', notLoadedText, skeletonRows = 3 }) {
  if (loading) return <Skeleton rows={skeletonRows} />;

  if (error) {
    return (
      <div className="flex flex-col items-start gap-2 rounded-xl border border-rose-500/25 bg-rose-950/20 px-3 py-3">
        <p className="flex items-start gap-2 text-xs leading-relaxed text-rose-200">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </p>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/30 px-2.5 py-1 font-mono text-[11px] font-semibold text-rose-200 transition hover:bg-rose-500/10"
          >
            <RotateCw className="h-3 w-3" aria-hidden="true" /> Retry
          </button>
        )}
      </div>
    );
  }

  if (notLoadedText) {
    return <p className="py-4 text-center text-xs text-slate-500">{notLoadedText}</p>;
  }

  if (empty) {
    return <p className="py-4 text-center text-xs text-slate-500">{emptyText}</p>;
  }

  return null;
}

/** A compact enterprise table. Columns are `{key, header, render, align, width}`. */
export function DataTable({ columns, rows, rowKey, onRowClick, dense = true }) {
  return (
    <div className="-mx-4 overflow-x-auto px-4">
      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="border-b border-slate-800 text-left font-mono text-[10px] uppercase tracking-wide text-slate-500">
            {columns.map(col => (
              <th
                key={col.key}
                scope="col"
                className={`pb-2 pr-3 font-semibold last:pr-0 ${col.align === 'right' ? 'text-right' : ''}`}
                style={col.width ? { width: col.width } : undefined}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={rowKey ? rowKey(row, i) : i}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={`border-b border-slate-800/60 last:border-0 ${onRowClick ? 'cursor-pointer transition hover:bg-slate-800/40' : ''}`}
            >
              {columns.map(col => (
                <td
                  key={col.key}
                  className={`${dense ? 'py-2' : 'py-3'} pr-3 align-middle last:pr-0 ${col.align === 'right' ? 'text-right tabular-nums' : ''}`}
                >
                  {col.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * One health category.
 *
 * An unscored category renders its reason at the same visual weight as a
 * scored one. "We could not measure this" is a finding the owner needs to act
 * on, not a gap to be hidden behind a greyed-out card.
 */
export function HealthCategory({ category }) {
  const scored = typeof category.score === 'number';
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-xs font-semibold text-slate-200">{category.title}</p>
        <p className={`font-mono text-lg font-bold leading-none ${HEALTH_STYLE[category.status]}`}>
          {scored ? category.score : '—'}
        </p>
      </div>

      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-800">
        <div
          className={`h-full rounded-full transition-all ${HEALTH_BAR[category.status]}`}
          style={{ width: scored ? `${category.score}%` : '100%' }}
        />
      </div>

      <p className={`mt-2 font-mono text-[10px] font-semibold uppercase tracking-wide ${HEALTH_STYLE[category.status]}`}>
        {scored ? category.status : 'Insufficient data'}
      </p>
      <p className="mt-1 text-[11px] leading-relaxed text-slate-400">{category.reason}</p>
      {category.note && (
        <p className="mt-1 text-[11px] leading-relaxed text-amber-300/80">{category.note}</p>
      )}

      <div className="mt-2 flex items-center justify-between gap-2 border-t border-slate-800 pt-2">
        <p className="text-[11px] text-slate-500">
          {typeof category.affected === 'number'
            // Each category names its own unit. Security counts findings, not
            // resources, and one resource can carry a dozen of them.
            ? `${category.affected.toLocaleString()} ${category.affectedNoun || 'resource'}${category.affected === 1 ? '' : 's'} affected`
            : 'Affected count not available'}
        </p>
        {category.to && (
          <Link to={category.to} className="inline-flex shrink-0 items-center gap-1 font-mono text-[11px] text-blue-400 transition hover:text-blue-300">
            Open <ArrowRight className="h-3 w-3" aria-hidden="true" />
          </Link>
        )}
      </div>
    </div>
  );
}

/** Live progress for a refresh. Each tick reflects an answer, never a timer. */
export function RefreshProgress({ stages }) {
  const ICON = {
    done: <Check className="h-3 w-3 text-emerald-400" aria-hidden="true" />,
    running: <Loader2 className="h-3 w-3 animate-spin text-blue-400" aria-hidden="true" />,
    failed: <X className="h-3 w-3 text-rose-400" aria-hidden="true" />,
    pending: <Circle className="h-3 w-3 text-slate-700" aria-hidden="true" />,
  };
  const TEXT = {
    done: 'text-slate-300',
    running: 'text-blue-300',
    failed: 'text-rose-300',
    pending: 'text-slate-600',
  };

  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1.5">
      {stages.map(stage => (
        <li key={stage.key} className={`flex items-center gap-1.5 font-mono text-[11px] ${TEXT[stage.status]}`}>
          {ICON[stage.status]}
          <span>{stage.label}</span>
          {stage.status === 'failed' && stage.error && (
            <span className="max-w-[16rem] truncate text-rose-400/70" title={stage.error}>— {stage.error}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** One finding in the attention queue. */
export function FindingRow({ finding }) {
  return (
    <li className="flex flex-col gap-2 border-b border-slate-800/60 py-2.5 last:border-0 sm:flex-row sm:items-start sm:gap-3">
      <div className="flex shrink-0 items-center gap-2 sm:w-24">
        <Severity level={finding.severity} />
      </div>

      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium leading-snug text-slate-200">
          {finding.problem}
          <span className="ml-2 font-mono text-[11px] font-normal text-slate-500">{finding.source}</span>
        </p>
        <p className="mt-0.5 truncate font-mono text-[11px] text-slate-400" title={finding.resourceId || finding.resource}>
          {finding.resource}
          {finding.region ? ` · ${finding.region}` : ''}
          {finding.subscriptionId ? ` · ${finding.subscriptionId.slice(0, 8)}…` : ''}
        </p>
        {finding.detail && (
          <p className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-slate-500">{finding.detail}</p>
        )}
        <p className="mt-0.5 text-[11px] text-slate-400">{finding.action}</p>
      </div>

      <div className="flex shrink-0 items-center justify-between gap-3 sm:w-56 sm:flex-col sm:items-end sm:gap-1">
        <p className={`font-mono text-xs tabular-nums ${finding.impact === null ? 'italic text-slate-600' : 'text-slate-200'}`}>
          {finding.impactLabel}
        </p>
        <Link
          to={finding.to}
          className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-slate-700 px-2 py-1 font-mono text-[11px] text-blue-400 transition hover:border-blue-500/40 hover:text-blue-300"
        >
          {finding.cta} <ArrowRight className="h-3 w-3" aria-hidden="true" />
        </Link>
      </div>
    </li>
  );
}
