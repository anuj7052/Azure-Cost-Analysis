/**
 * Holding the page still while a modal is open.
 *
 * The obvious implementation -- `document.body.style.overflow = 'hidden'` --
 * has two faults that show up as bug reports rather than as errors.
 *
 * First, removing the scrollbar narrows the viewport by its width, so every
 * centred element on the page shifts sideways at the moment the dialog opens.
 * It reads as the page flinching. Compensating with padding of exactly the
 * scrollbar's width keeps the layout still.
 *
 * Second, `overflow: hidden` is ignored by Safari on iOS, where the background
 * carries on scrolling underneath the dialog. The fix there is to take the body
 * out of flow with `position: fixed`, which does work everywhere -- but that
 * collapses the page to the top, so the scroll offset has to be captured first,
 * held as a negative `top`, and scrolled back on release. Restoring it is the
 * part that is easy to forget and the reason dialogs get a reputation for
 * "jumping to the top".
 *
 * Third, and the reason this is a module rather than a hook body: locks nest.
 * A confirmation dialog opened from inside a details drawer would, with two
 * independent locks, release on the inner one's close and leave the outer
 * drawer over a scrolling page -- and would restore the offset twice. Counting
 * the locks means only the first one captures the position and only the last
 * one restores it.
 */

let depth = 0;
let savedY = 0;
let savedTop = '';
let savedPosition = '';
let savedWidth = '';
let savedPadding = '';

export function lockScroll() {
  depth += 1;
  if (depth > 1) return;

  const body = document.body;
  savedY = window.scrollY;
  savedPosition = body.style.position;
  savedTop = body.style.top;
  savedWidth = body.style.width;
  savedPadding = body.style.paddingRight;

  // Only compensate when a scrollbar actually takes up space. Overlay
  // scrollbars (macOS default, all touch devices) have zero width, and padding
  // the body by zero is harmless but padding it by a guess is not.
  const gap = window.innerWidth - document.documentElement.clientWidth;
  if (gap > 0) body.style.paddingRight = `${gap}px`;

  body.style.position = 'fixed';
  body.style.top = `${-savedY}px`;
  body.style.width = '100%';
}

export function unlockScroll() {
  if (depth === 0) return;
  depth -= 1;
  if (depth > 0) return;

  const body = document.body;
  body.style.position = savedPosition;
  body.style.top = savedTop;
  body.style.width = savedWidth;
  body.style.paddingRight = savedPadding;

  // `scrollTo` rather than assigning `scrollY`, and with the smooth behaviour
  // explicitly overridden: a global `scroll-behavior: smooth` would otherwise
  // animate the restoration, which looks exactly like the page scrolling itself
  // for no reason.
  window.scrollTo({ top: savedY, left: 0, behavior: 'instant' });
}

/** Test seam: forget any lock left behind by an unmounted component. */
export function resetScrollLock() {
  depth = 0;
}
