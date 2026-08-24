import { AlertTriangle, Info, Lock, RefreshCw, ShieldAlert } from 'lucide-react';
import { when } from './securityData';

/**
 * Shared pieces for the Access & Security pages.
 *
 * All five pages ask the same question of the backend — "read these providers
 * across these subscriptions" — and every one of them has to say the same three
 * things afterwards: how much of the estate was actually covered, which
 * subscriptions were refused, and what changed since the previous reading.
 *
 * Those are exactly the parts that are tempting to skip when copying a page,
 * and they are the parts that must never be skipped. An empty security screen
 * with no coverage line reads as "nothing is wrong", which is the most
 * dangerous thing this app could imply. Keeping them here makes the honest
 * version the easy one.
 */

const SEVERITY_TONE = {
  high: 'bg-red-950/50 text-red-300 border-red-500/30',
  medium: 'bg-amber-950/40 text-amber-300 border-amber-500/30',
  low: 'bg-slate-800 text-slate-300 border-slate-700',
  informational: 'bg-slate-800 text-slate-400 border-slate-700',
};

export function PageHeader({ title, subtitle, onRun, loading, disabled }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-bold text-white">{title}</h1>
        <p className="text-slate-400 text-sm mt-1 max-w-3xl leading-relaxed">{subtitle}</p>
      </div>
      <button
        onClick={() => onRun()}
        disabled={loading || disabled}
        className="flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:opacity-60"
      >
        <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
        {loading ? 'Reading Azure…' : 'Run scan'}
      </button>
    </div>
  );
}

/** No tenant or no subscription selected — a state, not an error. */
export function NeedsSelection({ hasTenant }) {
  return (
    <div className="bg-blue-950/40 border border-blue-500/30 rounded-2xl p-6 text-center">
      <p className="text-blue-200 text-sm">
        {hasTenant
          ? 'Select at least one subscription in the bar above to scan.'
          : 'Connect and select an Azure tenant to use this page.'}
      </p>
    </div>
  );
}

export function ErrorCard({ message }) {
  return (
    <div className="bg-amber-950/30 border border-amber-500/30 rounded-2xl p-6">
      <div className="flex items-start gap-3">
        <AlertTriangle size={18} className="text-amber-400 shrink-0 mt-0.5" />
        <p className="text-sm text-amber-200 leading-relaxed">{message}</p>
      </div>
    </div>
  );
}

/**
 * How much of the estate this answer covers, and what was refused.
 *
 * Rendered even when everything succeeded. "All 8 subscriptions read" is a
 * meaningful statement; its absence is what makes an empty page ambiguous.
 */
export function Coverage({ coverage, errors = [] }) {
  const denied = errors.filter(e => e.kind === 'permission');
  const other = errors.filter(e => e.kind !== 'permission');

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
      <div className="flex items-start gap-2.5">
        <Info size={16} className="text-slate-500 shrink-0 mt-0.5" />
        <p className="text-sm text-slate-300 leading-relaxed">{coverage}</p>
      </div>

      {denied.length > 0 && (
        <div className="space-y-1.5">
          {denied.map((e, i) => (
            <div key={i} className="flex items-start gap-2.5 border border-slate-800 bg-slate-800/30 rounded-xl p-3">
              <Lock size={14} className="text-amber-400 shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="text-xs font-mono text-slate-400 truncate">{e.subscription_id}</p>
                <p className="text-xs text-slate-300 mt-1 leading-relaxed">{e.message}</p>
                {e.permission && (
                  <p className="text-[11px] text-amber-300/80 mt-1">Needs: {e.permission}</p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {other.length > 0 && (
        <p className="text-xs text-slate-500">
          {other.length} subscription(s) failed for other reasons — retrying usually clears these.
        </p>
      )}
    </div>
  );
}

/**
 * What moved since the previous snapshot.
 *
 * The verdict wording comes from the backend on purpose. A count going down is
 * not automatically progress — it also happens when read access is lost — and
 * that judgement belongs next to the data that produced it, not restated here.
 */
export function ChangeStrip({ change }) {
  if (!change) {
    return (
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
        <p className="text-sm text-slate-400 leading-relaxed">
          This is the first reading, so there is nothing to compare it against.
          It has been stored — run this again later and the difference will
          appear here. Azure keeps no history of its own, so this record is the
          only one that will exist.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="New" value={change.new_count} tone="text-red-300" />
        <Stat label="Resolved" value={change.resolved_count} tone="text-emerald-300" />
        <Stat label="Still open" value={change.persisting_count} tone="text-amber-300" />
        <Stat label="Net change" value={change.net_change > 0 ? `+${change.net_change}` : change.net_change} />
      </div>
      <p className="text-xs text-slate-400 leading-relaxed">{change.verdict}</p>
      {change.caveat && (
        <p className="text-xs text-amber-300/90 leading-relaxed">{change.caveat}</p>
      )}
      {change.baseline_at && (
        <p className="text-[11px] text-slate-600">Compared against the snapshot taken {when(change.baseline_at)}.</p>
      )}
    </div>
  );
}

export function Stat({ label, value, hint, tone = 'text-white' }) {
  return (
    <div className="border border-slate-800 bg-slate-800/30 rounded-xl p-3">
      <p className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">{label}</p>
      <p className={`text-xl font-bold mt-1 ${tone}`}>{value ?? '—'}</p>
      {hint && <p className="text-[11px] text-slate-500 mt-1 leading-snug">{hint}</p>}
    </div>
  );
}

export function Severity({ level }) {
  const tone = SEVERITY_TONE[level] || SEVERITY_TONE.low;
  return (
    <span className={`px-2 py-0.5 rounded-md border text-[10px] font-semibold uppercase tracking-wide ${tone}`}>
      {level}
    </span>
  );
}

export function Empty({ title, children }) {
  return (
    <div className="border border-slate-800 bg-slate-800/30 rounded-xl p-6 text-center">
      <ShieldAlert size={20} className="mx-auto text-slate-600" />
      <p className="text-sm font-semibold text-slate-300 mt-2">{title}</p>
      <p className="text-xs text-slate-500 mt-1 leading-relaxed max-w-lg mx-auto">{children}</p>
    </div>
  );
}

/**
 * Notes the reader must see before acting on anything above.
 *
 * Not a footnote by accident: every one of these describes a way the data can
 * be right and the conclusion still wrong.
 */
export function Caveats({ items }) {
  if (!items?.length) return null;
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        Before you act on this
      </p>
      <ul className="mt-2 space-y-1.5">
        {items.map((item, i) => (
          <li key={i} className="text-xs text-slate-400 leading-relaxed flex gap-2">
            <span className="text-slate-600">•</span>
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Filter chips with counts, used by every findings list. */
export function Chips({ options, value, onChange }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map(({ key, label, count }) => (
        <button
          key={key}
          onClick={() => onChange(key)}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
            value === key
              ? 'bg-blue-600/25 text-blue-300 border border-blue-500/30'
              : 'text-slate-400 border border-slate-800 hover:text-white hover:bg-slate-800/60'
          }`}
        >
          {label}
          {count !== undefined && <span className="ml-1.5 text-slate-500">{count}</span>}
        </button>
      ))}
    </div>
  );
}
