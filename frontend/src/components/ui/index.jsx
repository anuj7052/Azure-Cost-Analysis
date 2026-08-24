/**
 * The design system.
 *
 * One file, because the failure mode of a component library spread across
 * twenty files is that nobody finds the existing `Badge` and writes a
 * twenty-first. Everything here is presentational and stateless unless the
 * state is purely local (a sort order, an open tab).
 *
 * Two rules hold the language together:
 *
 * 1. **Colour is authored dark-first against the Tailwind slate ramp.** The
 *    light theme is produced by remapping those tokens in `index.css`, so
 *    writing `bg-slate-900 border-slate-800` yields a white card with a grey
 *    hairline in light mode automatically. Never hard-code a hex value here.
 *
 * 2. **Severity has exactly one vocabulary** — `critical | high | medium | low
 *    | info | good | neutral` — and one colour per level, defined once in
 *    `TONE`. A page that invents its own red teaches the user that red means
 *    nothing.
 *
 * The palette itself lives in `./tokens` because Fast Refresh requires a module
 * to export components or plain values, never both. Re-export it from here so
 * callers only ever import from one place.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertCircle, ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight,
  Info, Loader2, Minus, ShieldAlert, TriangleAlert,
} from 'lucide-react';
import { BUTTON_SIZE, BUTTON_VARIANT, tone } from './tokens';

/* ══════════════════════════════ button ══════════════════════════════ */

/* ══════════════════════════════ tokens ══════════════════════════════ */

export function Button({
  variant = 'secondary', size = 'md', loading = false, disabled = false,
  icon: Icon, className = '', children, ...rest
}) {
  return (
    <button
      disabled={disabled || loading}
      className={`inline-flex shrink-0 items-center justify-center rounded-lg font-medium
        transition disabled:cursor-not-allowed disabled:opacity-50
        ${BUTTON_VARIANT[variant]} ${BUTTON_SIZE[size]} ${className}`}
      {...rest}
    >
      {loading
        ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden="true" />
        : Icon && <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
      {children}
    </button>
  );
}

/* ══════════════════════════════ badges ══════════════════════════════ */

export function Badge({ tone: t = 'neutral', children, className = '' }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5
      font-mono text-[10px] font-semibold uppercase tracking-wide ${tone(t).chip} ${className}`}>
      {children}
    </span>
  );
}

/** A severity dot plus its word. Used wherever a row has a status column. */
export function Status({ tone: t = 'neutral', label, className = '' }) {
  const conf = tone(t);
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs ${conf.text} ${className}`}>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${conf.dot}`} aria-hidden="true" />
      {label || conf.label}
    </span>
  );
}

/**
 * A signed percentage with direction.
 *
 * `goodDirection` exists because up is not universally good: rising cost is
 * bad, rising savings is good, and colouring both green would be misleading.
 */
export function Trend({ value, goodDirection = 'down', className = '' }) {
  if (value == null || Number.isNaN(value)) {
    return <span className={`text-xs text-slate-600 ${className}`}>—</span>;
  }

  const flat = Math.abs(value) < 0.05;
  const up = value > 0;
  const good = flat ? null : (up ? goodDirection === 'up' : goodDirection === 'down');
  const Icon = flat ? Minus : (up ? ArrowUp : ArrowDown);

  const colour = flat ? 'text-slate-500'
    : good ? 'text-emerald-400' : 'text-red-400';

  return (
    <span className={`inline-flex items-center gap-0.5 text-xs font-medium tabular-nums ${colour} ${className}`}>
      <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
      {Math.abs(value).toFixed(1)}%
    </span>
  );
}

/* ══════════════════════════════ surfaces ══════════════════════════════ */

/** The standard bordered surface. Everything on a page sits in one of these. */
export function Card({ className = '', children, ...rest }) {
  return (
    <div className={`rounded-2xl border border-slate-800 bg-slate-900 ${className}`} {...rest}>
      {children}
    </div>
  );
}

/**
 * A card with a titled header.
 *
 * `hint` is deliberately not a tooltip: an explanation nobody can see until
 * they hover is an explanation most people never read.
 */
export function Panel({ title, hint, actions, tone: t, className = '', bodyClassName = 'p-4', children }) {
  return (
    <Card className={`${t ? `border-l-2 ${tone(t).bar}` : ''} ${className}`}>
      {(title || actions) && (
        <div className="flex items-start justify-between gap-3 border-b border-slate-800 px-4 py-3">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-semibold text-slate-100">{title}</h2>}
            {hint && <p className="mt-0.5 text-xs leading-relaxed text-slate-500">{hint}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
        </div>
      )}
      <div className={bodyClassName}>{children}</div>
    </Card>
  );
}

/**
 * The headline number on a page.
 *
 * `value` is rendered as `—` when null rather than `0`, because "we could not
 * read this" and "this is zero" are different facts and conflating them is how
 * a dashboard quietly lies.
 */
export function Metric({
  label, value, unit, trend, goodDirection = 'down', hint, icon: Icon, to,
  tone: t, loading = false, className = '',
}) {
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <p className="font-mono text-[10px] font-semibold uppercase tracking-wide text-slate-500">
          {label}
        </p>
        {Icon && <Icon className="h-3.5 w-3.5 shrink-0 text-slate-600" aria-hidden="true" />}
      </div>

      {loading ? (
        <Skeleton className="mt-2 h-8 w-28" />
      ) : (
        <div className="mt-1.5 flex items-baseline gap-1.5">
          <span className="text-2xl font-bold tabular-nums tracking-tight text-slate-100">
            {value ?? '—'}
          </span>
          {unit && <span className="text-xs text-slate-500">{unit}</span>}
        </div>
      )}

      <div className="mt-1 flex items-center gap-2">
        {trend != null && <Trend value={trend} goodDirection={goodDirection} />}
        {hint && <p className="truncate text-[11px] text-slate-500">{hint}</p>}
      </div>
    </>
  );

  const shell = `rounded-2xl border border-slate-800 bg-slate-900 p-4 ${
    t ? `border-l-2 ${tone(t).bar}` : ''
  } ${to ? 'transition hover:border-blue-500/30 hover:bg-slate-800/50' : ''} ${className}`;

  return to ? <Link to={to} className={`block ${shell}`}>{body}</Link> : <div className={shell}>{body}</div>;
}

/* ══════════════════════════════ states ══════════════════════════════ */

export function Skeleton({ className = 'h-4 w-full' }) {
  return (
    <div
      className={`animate-pulse rounded-md bg-slate-800/70 ${className}`}
      aria-hidden="true"
    />
  );
}

/** A placeholder shaped like the table it is standing in for. */
export function TableSkeleton({ rows = 6, cols = 5 }) {
  return (
    <div className="space-y-2 p-4" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-3">
          {Array.from({ length: cols }).map((__, c) => (
            <Skeleton key={c} className={`h-4 ${c === 0 ? 'w-1/3' : 'flex-1'}`} />
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * Nothing to show — and, importantly, a way out.
 *
 * An empty state without an action is a dead end. The most common cause of an
 * empty cloud console is a filter or a subscription selection, so those are
 * what the actions usually reset.
 */
export function EmptyState({ icon, title, description, actions, className = '' }) {
  const Icon = icon || Info;
  return (
    <div className={`flex flex-col items-center justify-center px-6 py-12 text-center ${className}`}>
      <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-slate-800 bg-slate-800/50">
        <Icon className="h-5 w-5 text-slate-500" aria-hidden="true" />
      </div>
      <p className="mt-3 text-sm font-semibold text-slate-200">{title}</p>
      {description && (
        <p className="mt-1 max-w-md text-xs leading-relaxed text-slate-500">{description}</p>
      )}
      {actions && <div className="mt-4 flex flex-wrap justify-center gap-2">{actions}</div>}
    </div>
  );
}

/** Something failed. Says what, and offers the retry. */
export function ErrorState({ title = 'Could not load this', message, onRetry, className = '' }) {
  return (
    <div className={`flex flex-col items-center justify-center px-6 py-12 text-center ${className}`}>
      <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-red-500/30 bg-red-500/10">
        <AlertCircle className="h-5 w-5 text-red-400" aria-hidden="true" />
      </div>
      <p className="mt-3 text-sm font-semibold text-slate-200">{title}</p>
      {message && (
        <p className="mt-1 max-w-md text-xs leading-relaxed text-slate-500">{message}</p>
      )}
      {onRetry && (
        <Button variant="secondary" size="sm" onClick={onRetry} className="mt-4">Try again</Button>
      )}
    </div>
  );
}

/**
 * The caller is authenticated but not entitled.
 *
 * Distinct from ErrorState on purpose: this is not a fault and retrying will
 * not help. It names the exact Azure role needed so the reader can forward it
 * to whoever grants roles, without translating a stack trace first.
 */
export function NoPermissionState({ permission, what = 'this data', className = '' }) {
  return (
    <div className={`flex flex-col items-center justify-center px-6 py-12 text-center ${className}`}>
      <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-amber-500/30 bg-amber-500/10">
        <ShieldAlert className="h-5 w-5 text-amber-400" aria-hidden="true" />
      </div>
      <p className="mt-3 text-sm font-semibold text-slate-200">
        This account cannot read {what}
      </p>
      <p className="mt-1 max-w-md text-xs leading-relaxed text-slate-500">
        Azure refused the request rather than returning nothing, so this is a missing
        role and not an empty estate.
      </p>
      {permission && (
        <code className="mt-3 rounded-lg border border-slate-800 bg-slate-950 px-2.5 py-1.5 text-[11px] text-amber-300">
          {permission}
        </code>
      )}
    </div>
  );
}

/** An inline notice. Not a toast — this one stays on the page. */
export function Callout({ tone: t = 'info', title, children, className = '' }) {
  const conf = tone(t);
  const Icon = t === 'critical' || t === 'high' ? TriangleAlert : Info;
  return (
    <div className={`flex items-start gap-2.5 rounded-xl border ${conf.ring} bg-slate-900/60 px-3.5 py-3 ${className}`}>
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${conf.text}`} aria-hidden="true" />
      <div className="min-w-0 text-xs leading-relaxed text-slate-400">
        {title && <p className={`font-semibold ${conf.text}`}>{title}</p>}
        {children}
      </div>
    </div>
  );
}

/* ══════════════════════════════ tabs ══════════════════════════════ */

export function Tabs({ tabs, active, onChange, className = '' }) {
  return (
    <div className={`flex items-center gap-1 border-b border-slate-800 ${className}`} role="tablist">
      {tabs.map(tab => {
        const on = tab.key === active;
        return (
          <button
            key={tab.key}
            role="tab"
            aria-selected={on}
            onClick={() => onChange(tab.key)}
            className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium transition ${
              on
                ? 'border-blue-500 text-slate-100'
                : 'border-transparent text-slate-500 hover:text-slate-300'
            }`}
          >
            {tab.icon && <tab.icon className="h-3.5 w-3.5" aria-hidden="true" />}
            {tab.label}
            {tab.count != null && (
              <span className="rounded bg-slate-800 px-1 font-mono text-[10px] text-slate-400">
                {tab.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Segmented control. For switching a view, not for navigating. */
export function SegmentedControl({ options, value, onChange, className = '' }) {
  return (
    <div className={`inline-flex items-center gap-0.5 rounded-lg border border-slate-800 bg-slate-950/50 p-0.5 ${className}`}>
      {options.map(opt => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          aria-pressed={opt.value === value}
          className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
            opt.value === value
              ? 'bg-slate-800 text-slate-100'
              : 'text-slate-500 hover:text-slate-300'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/* ══════════════════════════════ filters ══════════════════════════════ */

/** A row of filter controls with a reset. */
export function FilterBar({ children, onReset, active = 0, className = '' }) {
  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`}>
      {children}
      {active > 0 && onReset && (
        <Button variant="ghost" size="sm" onClick={onReset}>
          Clear {active} filter{active === 1 ? '' : 's'}
        </Button>
      )}
    </div>
  );
}

export function Select({ label, value, onChange, options, className = '' }) {
  return (
    <label className={`inline-flex items-center gap-1.5 text-xs text-slate-500 ${className}`}>
      {label && <span className="shrink-0">{label}</span>}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 rounded-lg border border-slate-700 bg-slate-900 px-2 text-xs text-slate-200"
      >
        {options.map(o => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}

/** Filter chips. Multi-select by clicking; each carries its own count. */
export function ChipFilter({ options, value, onChange, className = '' }) {
  return (
    <div className={`flex flex-wrap gap-1.5 ${className}`}>
      {options.map(opt => {
        const on = opt.value === value;
        return (
          <button
            key={opt.value}
            onClick={() => onChange(on ? '' : opt.value)}
            aria-pressed={on}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs font-medium transition ${
              on
                ? 'border-blue-500/40 bg-blue-500/15 text-blue-300'
                : 'border-slate-800 bg-slate-900 text-slate-400 hover:text-slate-200'
            }`}
          >
            {opt.tone && (
              <span className={`h-1.5 w-1.5 rounded-full ${tone(opt.tone).dot}`} aria-hidden="true" />
            )}
            {opt.label}
            {opt.count != null && (
              <span className="font-mono text-[10px] text-slate-500">{opt.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/* ══════════════════════════════ table ══════════════════════════════ */

/**
 * The table.
 *
 * Sorting and paging are held here rather than by each caller, because six
 * pages each implementing their own sort is six chances to sort a numeric
 * column as a string. Columns declare `align: 'right'` for numbers, which also
 * switches on tabular figures so digits line up.
 *
 * `columns`: `{ key, header, align?, width?, sortable?, render?, sortValue? }`
 */
export function DataTable({
  columns, rows, rowKey = (r, i) => r.id ?? i, onRowClick, selectedKey,
  pageSize = 25, initialSort, empty, dense = false, className = '',
}) {
  const [sort, setSort] = useState(initialSort || { key: null, dir: 'asc' });
  const [page, setPage] = useState(0);

  const sorted = useMemo(() => {
    if (!sort.key) return rows;
    const col = columns.find(c => c.key === sort.key);
    if (!col) return rows;
    const value = col.sortValue || ((r) => r[col.key]);

    return [...rows].sort((a, b) => {
      const av = value(a);
      const bv = value(b);
      // Nulls sort last in both directions: a missing number is not a small
      // one, and letting it float to the top of a "most expensive" list is
      // actively misleading.
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      const cmp = typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av).localeCompare(String(bv), undefined, { numeric: true });
      return sort.dir === 'asc' ? cmp : -cmp;
    });
  }, [rows, sort, columns]);

  const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const current = Math.min(page, pages - 1);
  const visible = sorted.slice(current * pageSize, (current + 1) * pageSize);

  const toggle = (key) => {
    setSort(s => s.key === key
      ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: 'asc' });
    setPage(0);
  };

  if (!rows.length) return empty || <EmptyState title="Nothing to show" />;

  const pad = dense ? 'px-3 py-1.5' : 'px-3 py-2.5';

  return (
    <div className={className}>
      {/* Horizontal scroll rather than column hiding: on a narrow screen a
          cloud engineer would rather scroll than lose the cost column. */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-left">
          <thead>
            <tr className="border-b border-slate-800">
              {columns.map(col => (
                <th
                  key={col.key}
                  style={col.width ? { width: col.width } : undefined}
                  className={`${pad} font-mono text-[10px] font-semibold uppercase tracking-wide text-slate-500
                    ${col.align === 'right' ? 'text-right' : ''}`}
                >
                  {col.sortable === false ? col.header : (
                    <button
                      onClick={() => toggle(col.key)}
                      className={`inline-flex items-center gap-1 transition hover:text-slate-300 ${
                        col.align === 'right' ? 'flex-row-reverse' : ''
                      }`}
                    >
                      {col.header}
                      {sort.key === col.key
                        ? (sort.dir === 'asc'
                          ? <ArrowUp className="h-3 w-3" aria-hidden="true" />
                          : <ArrowDown className="h-3 w-3" aria-hidden="true" />)
                        : <ArrowUpDown className="h-3 w-3 text-slate-700" aria-hidden="true" />}
                    </button>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((row, i) => {
              const key = rowKey(row, i);
              return (
                <tr
                  key={key}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={`border-b border-slate-800/60 transition last:border-0 ${
                    onRowClick ? 'cursor-pointer hover:bg-slate-800/40' : ''
                  } ${selectedKey === key ? 'bg-blue-500/10' : ''}`}
                >
                  {columns.map(col => (
                    <td
                      key={col.key}
                      className={`${pad} text-xs text-slate-300 ${
                        col.align === 'right' ? 'text-right tabular-nums' : ''
                      }`}
                    >
                      {col.render ? col.render(row) : row[col.key]}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {pages > 1 && (
        <div className="flex items-center justify-between border-t border-slate-800 px-3 py-2">
          <p className="text-[11px] text-slate-500">
            {current * pageSize + 1}–{Math.min((current + 1) * pageSize, sorted.length)} of {sorted.length}
          </p>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost" size="sm" icon={ChevronLeft}
              disabled={current === 0}
              onClick={() => setPage(p => Math.max(0, p - 1))}
            >
              Prev
            </Button>
            <span className="px-1 font-mono text-[11px] text-slate-500">
              {current + 1}/{pages}
            </span>
            <Button
              variant="ghost" size="sm"
              disabled={current >= pages - 1}
              onClick={() => setPage(p => Math.min(pages - 1, p + 1))}
            >
              Next <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
