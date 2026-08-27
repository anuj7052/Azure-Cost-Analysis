import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import useDialogChrome from '../../hooks/useDialogChrome';

/**
 * The shell every dialog in this app sits in.
 *
 * Each modal used to centre itself with `flex items-center` inside a fixed
 * overlay and then simply render its content. That works exactly until the
 * content is taller than the window — at which point the box grows past the
 * top and bottom edges of the screen, and because the overlay is `fixed` there
 * is nothing to scroll. The heading disappears upwards, the Save button
 * disappears downwards, and the form is not merely awkward to use but
 * genuinely impossible to submit. On a 13" laptop the session-token dialog was
 * doing precisely this.
 *
 * The layout here makes that structurally impossible rather than unlikely:
 *
 *   - the panel is a column capped at the viewport height, so it can never
 *     exceed the screen no matter how much is inside it;
 *   - the header and footer are fixed-size, so the title and the buttons are
 *     always on screen — the two things a reader needs in order to know what
 *     they are doing and to stop doing it;
 *   - the body is the only part that scrolls, and `min-h-0` is what actually
 *     permits it. Without it a flex child refuses to shrink below its content
 *     and `overflow-y-auto` silently does nothing, which is the usual reason a
 *     dialog "has scrolling" and still cannot be scrolled.
 *
 * `dvh` rather than `vh` because mobile Safari's `vh` includes the address bar
 * that is covering the bottom of the dialog.
 *
 * Behaviour that used to be missing everywhere and is now unavoidable: the
 * page behind does not scroll, Escape and the backdrop close, and focus moves
 * into the dialog on open and back to whatever opened it on close. Focus
 * matters more than it looks: without it a real Escape key press goes to the
 * page behind and the dialog ignores it.
 *
 * Rendered through a portal onto `document.body`, which is not cosmetic.
 * `position: fixed` resolves against the viewport only while no ancestor
 * establishes a containing block, and `transform`, `filter`, `backdrop-filter`
 * and `contain` all establish one. This app uses `animate-fade-up` on the page
 * wrapper and `backdrop-blur` on several surfaces, so a dialog rendered in
 * place would anchor itself to whichever card it happened to be declared
 * inside -- landing part-way down the page instead of over it, and scrolling
 * with the content rather than above it. The portal removes that dependency
 * on where the dialog is written.
 */
export default function Modal({
  title,
  subtitle,
  icon: Icon,
  onClose,
  children,
  footer,
  size = 'lg',
  // While a dialog is mid-flight the accidental exits are switched off. A
  // stray Escape between "sending" and "sent" leaves the reader with no idea
  // whether it happened.
  busy = false,
}) {
  const panel = useDialogChrome({ onClose, busy });

  const width = {
    sm: 'max-w-sm',
    md: 'max-w-md',
    lg: 'max-w-lg',
    xl: 'max-w-2xl',
    '2xl': 'max-w-4xl',
  }[size] || 'max-w-lg';

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-fade-in">
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={() => { if (!busy) onClose?.(); }}
      />

      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        className={`relative flex max-h-[calc(100dvh-2rem)] w-full ${width} flex-col overflow-hidden rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl outline-none animate-scale-in`}
      >
        {(title || onClose) && (
          <div className="flex shrink-0 items-start justify-between gap-3 border-b border-slate-800 px-4 py-3.5 sm:gap-4 sm:px-6 sm:py-4">
            <div className="min-w-0">
              <h2 className="flex items-center gap-2 text-base font-semibold text-white sm:text-lg">
                {Icon && <Icon className="h-5 w-5 shrink-0 text-blue-400" />}
                {title}
              </h2>
              {subtitle && <p className="mt-0.5 text-xs leading-relaxed text-slate-500">{subtitle}</p>}
            </div>
            {onClose && (
              <button
                type="button"
                onClick={() => { if (!busy) onClose(); }}
                aria-label="Close"
                className="shrink-0 rounded-lg p-1 text-slate-400 transition hover:bg-slate-800 hover:text-white"
              >
                <X className="h-5 w-5" />
              </button>
            )}
          </div>
        )}

        {/* min-h-0 is load-bearing: without it this never scrolls. */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6 sm:py-5">
          {children}
        </div>

        {footer && (
          <div className="shrink-0 border-t border-slate-800 bg-slate-900 px-4 py-3.5 sm:px-6 sm:py-4">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
