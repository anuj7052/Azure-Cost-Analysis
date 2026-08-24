import { Link } from 'react-router-dom';
import { ArrowRight, ChevronRight, TriangleAlert } from 'lucide-react';

/**
 * Presentation primitives shared by the four section overview pages.
 *
 * These exist so the overviews look like one product rather than four pages
 * that happened to be written on different days. They carry no data-fetching
 * and no business rules — every number they display is handed to them by the
 * page, which is the only place that knows whether the number is real.
 *
 * Everything here uses the app's slate token vocabulary, which `index.css`
 * remaps under `html[data-theme="light"]`. That is deliberate: the same markup
 * renders as the dark console and as the light Azure-style surface, so
 * adopting this design does not cost us the theme toggle.
 *
 * This module exports components only, so Fast Refresh stays happy.
 */

/** Ancestry for the current page. Items may be `{label, to}` or `{label}`. */
export function Breadcrumb({ items = [] }) {
  if (items.length === 0) return null;
  return (
    <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1 font-mono text-[11px] text-slate-500">
      {items.map((item, i) => {
        const last = i === items.length - 1;
        return (
          <span key={`${item.label}-${i}`} className="flex items-center gap-1">
            {i > 0 && <ChevronRight className="h-3 w-3 text-slate-700" aria-hidden="true" />}
            {item.to && !last
              ? <Link to={item.to} className="transition hover:text-blue-400">{item.label}</Link>
              : <span className={last ? 'font-semibold text-slate-300' : ''} aria-current={last ? 'page' : undefined}>{item.label}</span>}
          </span>
        );
      })}
    </nav>
  );
}

const TONES = {
  neutral: 'border-slate-800',
  info: 'border-l-4 border-l-blue-500 border-slate-800',
  warn: 'border-l-4 border-l-amber-500 border-slate-800',
  danger: 'border-l-4 border-l-rose-500 border-slate-800',
  good: 'border-l-4 border-l-emerald-500 border-slate-800',
};

/**
 * A single headline figure.
 *
 * `value` is rendered verbatim — pass an already-formatted string or `null`.
 * A `null` value renders a dash rather than a zero, because "not loaded" and
 * "genuinely nothing" must not look the same.
 *
 * Pass `to` and the whole card becomes a link to the page that can act on the
 * figure. A number that raises a question should sit next to the answer: a
 * count of orphaned resources that cannot be clicked is a dead end.
 */
export function KpiCard({ label, value, icon: Icon, hint, tone = 'neutral', hintTone = 'muted', loading = false, to }) {
  const hintClass = {
    muted: 'text-slate-500',
    good: 'text-emerald-400',
    warn: 'text-amber-400',
    danger: 'text-rose-400',
  }[hintTone] || 'text-slate-500';

  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <p className="font-mono text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
        {Icon && <Icon className="h-4 w-4 shrink-0 text-slate-600" aria-hidden="true" />}
      </div>
      <p className="mt-2 text-3xl font-bold leading-tight text-white">
        {loading ? <span className="inline-block h-7 w-24 animate-pulse rounded bg-slate-800" /> : (value ?? '—')}
      </p>
      <div className="mt-1.5 flex items-center justify-between gap-2">
        {hint ? <p className={`font-mono text-[11px] ${hintClass}`}>{hint}</p> : <span />}
        {to && (
          <ArrowRight className="h-3.5 w-3.5 shrink-0 text-slate-700 transition group-hover:translate-x-0.5 group-hover:text-blue-400" />
        )}
      </div>
    </>
  );

  const shell = `rounded-2xl border bg-slate-900 p-4 elevated ${TONES[tone] || TONES.neutral}`;

  if (!to) return <div className={shell}>{body}</div>;

  return (
    <Link to={to} className={`group block transition hover:border-blue-500/30 hover:bg-slate-800/60 ${shell}`}>
      {body}
    </Link>
  );
}

/** A titled card. `action` sits opposite the title. */
export function Panel({ title, icon: Icon, action, children, className = '' }) {
  return (
    <section className={`rounded-2xl border border-slate-800 bg-slate-900 elevated ${className}`}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 border-b border-slate-800 px-4 py-3">
          <h2 className="flex items-center gap-2 text-base font-semibold text-white">
            {Icon && <Icon className="h-4 w-4 text-blue-400" aria-hidden="true" />}
            {title}
          </h2>
          {action}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

/** A labelled horizontal progress bar. `pct` is clamped to 0–100. */
export function MeterRow({ label, pct, note, noteTone = 'muted', colour = 'bg-blue-500' }) {
  const width = Math.max(0, Math.min(100, Number(pct) || 0));
  const noteClass = {
    muted: 'text-slate-400',
    good: 'text-emerald-400',
    warn: 'text-amber-400',
    danger: 'text-rose-400',
  }[noteTone] || 'text-slate-400';

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3 font-mono text-xs">
        <span className="text-slate-300">{label}</span>
        <span className={noteClass}>{note}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
        <div className={`h-full rounded-full ${colour}`} style={{ width: `${width}%` }} />
      </div>
    </div>
  );
}

/** A full-width callout. Used for one important thing, never for a list. */
export function Callout({ title, children, action, tone = 'warn' }) {
  const bar = { warn: 'border-l-amber-500', danger: 'border-l-rose-500', info: 'border-l-blue-500' }[tone] || 'border-l-amber-500';
  const ink = { warn: 'text-amber-400', danger: 'text-rose-400', info: 'text-blue-400' }[tone] || 'text-amber-400';
  return (
    <div className={`flex items-start gap-3 rounded-2xl border border-slate-800 border-l-4 bg-slate-900 p-4 elevated ${bar}`}>
      <TriangleAlert className={`mt-0.5 h-5 w-5 shrink-0 ${ink}`} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-white">{title}</p>
        <div className="mt-1 text-sm leading-relaxed text-slate-400">{children}</div>
      </div>
      {action}
    </div>
  );
}

/** Placeholder used wherever a panel has nothing to show yet. */
export function PanelEmpty({ children }) {
  return <p className="py-6 text-center text-sm text-slate-500">{children}</p>;
}
