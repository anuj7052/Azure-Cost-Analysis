import { useEffect } from 'react';
import { X } from 'lucide-react';

/**
 * Right-hand slide-over used by every hero card to show its drill-down.
 * Closes on backdrop click or Escape.
 */
export default function DetailPanel({ open, title, subtitle, onClose, children }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div
        className="absolute inset-0 bg-[rgb(2_6_23/0.6)] backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative w-full max-w-2xl h-full bg-slate-900 border-l border-slate-800 elevated-xl flex flex-col animate-[slideIn_.2s_ease-out]"
      >
        <style>{`@keyframes slideIn { from { transform: translateX(24px); opacity: 0 } to { transform: none; opacity: 1 } }`}</style>
        <header className="flex items-start justify-between gap-4 px-6 py-5 border-b border-slate-800 shrink-0">
          <div className="min-w-0">
            <h2 className="text-lg font-bold text-white truncate">{title}</h2>
            {subtitle && <p className="text-xs text-slate-500 mt-1">{subtitle}</p>}
          </div>
          <button
            onClick={onClose}
            aria-label="Close details"
            className="w-9 h-9 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 flex items-center justify-center transition-colors shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">{children}</div>
      </aside>
    </div>
  );
}

/** Small labelled stat used inside detail panels. */
export function DetailStat({ label, value, hint }) {
  return (
    <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-4">
      <p className="text-[11px] uppercase tracking-wide text-slate-500 font-semibold">{label}</p>
      <p className="text-xl font-bold text-white mt-1 break-words">{value}</p>
      {hint && <p className="text-[11px] text-slate-500 mt-1">{hint}</p>}
    </div>
  );
}
