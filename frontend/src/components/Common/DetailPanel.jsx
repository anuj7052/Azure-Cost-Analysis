import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { lockScroll, unlockScroll } from '../../utils/scrollLock';

/**
 * Right-hand slide-over used by every hero card to show its drill-down.
 * Closes on backdrop click or Escape.
 *
 * Portalled onto `document.body` for the same reason as `Modal`: `transform`,
 * `filter`, `backdrop-filter` and `contain` on any ancestor make that ancestor
 * the containing block for `position: fixed`, and this app applies
 * `animate-fade-up` to the page wrapper and `backdrop-blur` to several
 * surfaces. Rendered in place, the panel anchors to the card that opened it
 * rather than to the viewport.
 */
export default function DetailPanel({ open, title, subtitle, onClose, children }) {
  const panel = useRef(null);
  const returnTo = useRef(null);

  useEffect(() => {
    if (!open) return;
    // Escape is captured rather than bubbled so that the topmost dialog wins
    // when one is opened from inside another.
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    lockScroll();
    return () => {
      window.removeEventListener('keydown', onKey, true);
      unlockScroll();
    };
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return undefined;
    // Without this the keyboard stays on whatever was behind the panel: Tab
    // walks the page underneath, screen readers carry on announcing it, and
    // Escape never arrives because nothing in the dialog has focus. Testing
    // with a real key press was what exposed it -- a synthetic event dispatched
    // on window closed the panel perfectly while a genuine one did nothing.
    returnTo.current = document.activeElement;
    panel.current?.focus();
    return () => {
      // Returning focus to the button that opened the panel is what lets
      // someone reading by keyboard carry on from where they were rather than
      // being dropped back at the top of the document.
      const target = returnTo.current;
      if (target && typeof target.focus === 'function' && document.contains(target)) {
        target.focus();
      }
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end">
      <div
        className="absolute inset-0 bg-[rgb(2_6_23/0.6)] backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        // Focusable but not in the tab order: the panel takes focus when it
        // opens, and Tab moves on to the controls inside it.
        tabIndex={-1}
        // `dvh` rather than `%`/`vh`: on a phone the browser's own chrome
        // shrinks the visible area, and `vh` keeps sizing to the *unshrunk*
        // height, so the last part of the panel sits under the address bar
        // where it cannot be reached.
        className="relative flex h-[100dvh] max-h-[100dvh] w-full max-w-2xl flex-col overflow-hidden border-l border-slate-800 bg-slate-900 elevated-xl animate-[slideIn_.2s_ease-out] outline-none"
      >
        <style>{`@keyframes slideIn { from { transform: translateX(24px); opacity: 0 } to { transform: none; opacity: 1 } }`}</style>
        <header className="flex items-start justify-between gap-3 border-b border-slate-800 px-4 py-4 shrink-0 sm:gap-4 sm:px-6 sm:py-5">
          <div className="min-w-0">
            <h2 className="text-base font-bold text-white truncate sm:text-lg">{title}</h2>
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
        {/* min-h-0 is load-bearing. A flex child defaults to `min-height:auto`,
            which refuses to shrink below its content, so `flex-1` grows to the
            full content height and `overflow-y-auto` never has anything to
            scroll -- the bottom of a long panel simply becomes unreachable.
            overscroll-contain stops the page behind scrolling once this hits
            its end. */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 space-y-6 sm:px-6 sm:py-5">{children}</div>
      </aside>
    </div>,
    document.body,
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
