import { ArrowUpRight, TrendingDown, TrendingUp } from 'lucide-react';

const ACCENTS = {
  blue:    { ring: 'hover:border-blue-500/50',    icon: 'bg-blue-500/15 text-blue-400',       bar: 'bg-blue-500',    glow: 'from-blue-500/10' },
  emerald: { ring: 'hover:border-emerald-500/50', icon: 'bg-emerald-500/15 text-emerald-400', bar: 'bg-emerald-500', glow: 'from-emerald-500/10' },
  amber:   { ring: 'hover:border-amber-500/50',   icon: 'bg-amber-500/15 text-amber-400',     bar: 'bg-amber-500',   glow: 'from-amber-500/10' },
  violet:  { ring: 'hover:border-violet-500/50',  icon: 'bg-violet-500/15 text-violet-400',   bar: 'bg-violet-500',  glow: 'from-violet-500/10' },
  rose:    { ring: 'hover:border-rose-500/50',    icon: 'bg-rose-500/15 text-rose-400',       bar: 'bg-rose-500',    glow: 'from-rose-500/10' },
  slate:   { ring: 'hover:border-slate-600',      icon: 'bg-slate-700/60 text-slate-300',     bar: 'bg-slate-500',   glow: 'from-slate-500/10' },
};

/**
 * Large clickable hero tile: headline value + unit, secondary amount,
 * share-of-total bar and a MoM trend chip. Clicking opens the detail view.
 */
export default function HeroCard({
  title,
  value,
  unit,
  amount,
  subtitle,
  footnote,
  sharePct,
  momChange,
  icon: Icon,
  accent = 'blue',
  loading = false,
  onClick,
  active = false,
  // The unabbreviated figure behind `value`. A tile showing "₹1.24L" is fine
  // for scanning and useless for reconciling against an invoice, so the exact
  // number stays reachable on hover instead of being discarded at render time.
  exact,
  amountExact,
}) {
  const a = ACCENTS[accent] || ACCENTS.blue;
  const clickable = typeof onClick === 'function';
  const TrendIcon = momChange > 0 ? TrendingUp : TrendingDown;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!clickable}
      aria-pressed={active}
      className={`group relative overflow-hidden text-left w-full bg-slate-900 border rounded-2xl p-5 elevated transition-all duration-200
        ${active ? 'border-blue-500/60 ring-1 ring-blue-500/30' : 'border-slate-800'}
        ${clickable ? `${a.ring} hover:-translate-y-0.5 hover:elevated-lg cursor-pointer` : 'cursor-default'}`}
    >
      <div className={`pointer-events-none absolute inset-0 bg-gradient-to-br ${a.glow} to-transparent opacity-0 group-hover:opacity-100 transition-opacity`} />

      <div className="relative flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-slate-400 text-xs font-semibold uppercase tracking-wide truncate">{title}</p>
          {subtitle && <p className="text-[11px] text-slate-500 mt-0.5 truncate">{subtitle}</p>}
        </div>
        {Icon && (
          <span className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${a.icon}`}>
            <Icon className="w-5 h-5" />
          </span>
        )}
      </div>

      {loading ? (
        <div className="relative mt-4 h-9 bg-slate-800 rounded-lg animate-pulse" />
      ) : (
        <div className="relative mt-4 flex items-baseline gap-2 flex-wrap">
          <span className="text-3xl font-bold text-white tracking-tight tabular-nums" title={exact}>{value}</span>
          {unit && <span className="text-sm font-semibold text-slate-400">{unit}</span>}
          {amount && (
            <span
              className="ml-auto text-sm font-semibold text-slate-200 bg-slate-800/70 px-2 py-0.5 rounded-lg tabular-nums"
              title={amountExact}
            >
              {amount}
            </span>
          )}
        </div>
      )}

      {sharePct != null && (
        <div className="relative mt-4 flex items-center gap-2">
          <div className="flex-1 h-1.5 rounded-full bg-slate-800 overflow-hidden">
            <div className={`h-full rounded-full ${a.bar} transition-all`} style={{ width: `${Math.min(100, Math.max(0, sharePct))}%` }} />
          </div>
          <span className="text-[11px] text-slate-400 tabular-nums">{sharePct.toFixed(1)}%</span>
        </div>
      )}

      <div className="relative mt-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {momChange != null && (
            <span className={`flex items-center gap-1 text-xs font-semibold ${momChange > 0 ? 'text-red-400' : 'text-emerald-400'}`}>
              <TrendIcon className="w-3.5 h-3.5" />
              {Math.abs(momChange).toFixed(1)}%
            </span>
          )}
          {footnote && <span className="text-[11px] text-slate-500 truncate">{footnote}</span>}
        </div>
        {clickable && (
          <span className="flex items-center gap-1 text-[11px] font-medium text-blue-400 opacity-70 group-hover:opacity-100 shrink-0">
            Details <ArrowUpRight className="w-3.5 h-3.5" />
          </span>
        )}
      </div>
    </button>
  );
}
