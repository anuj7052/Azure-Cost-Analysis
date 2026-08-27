import { useEffect, useRef } from 'react';
import { lockScroll, unlockScroll } from '../utils/scrollLock';

/**
 * The three things every dialog has to do and none of them were doing.
 *
 * 1. Stop the page behind from scrolling. Otherwise a scroll gesture that
 *    overruns the end of the dialog silently scrolls the page underneath, and
 *    closing the dialog leaves the reader somewhere they never navigated to.
 * 2. Close on Escape. Registered in the capture phase and stopped, so a dialog
 *    opened from inside a drawer closes itself rather than both at once.
 * 3. Move focus into the panel on open and back afterwards. This is the one
 *    that looks cosmetic and is not: keyboard events go to the focused
 *    element, so without it a real Escape press lands on the page behind and
 *    the dialog appears to ignore the key entirely.
 *
 * Returns the ref to put on the panel element, which must also carry
 * `tabIndex={-1}` for it to be focusable.
 */
export default function useDialogChrome({ onClose, busy = false } = {}) {
  const panel = useRef(null);
  const returnTo = useRef(null);

  useEffect(() => {
    lockScroll();
    return () => unlockScroll();
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape' || busy) return;
      e.stopPropagation();
      onClose?.();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, busy]);

  useEffect(() => {
    returnTo.current = document.activeElement;
    panel.current?.focus();
    return () => {
      const target = returnTo.current;
      // Only if it is still on the page. Restoring focus to a removed node
      // drops it on <body>, and the next Tab starts again from the top.
      if (target && document.contains(target)) target.focus?.();
    };
  }, []);

  return panel;
}
