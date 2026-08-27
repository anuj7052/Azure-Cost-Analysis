/**
 * The scroll lock exists to stop two specific complaints: the page jumping to
 * the top when a dialog opens, and the background scrolling underneath one.
 * Both are silent failures -- nothing throws -- so they are only caught by
 * asserting on the body's style and on where the window ends up.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { lockScroll, unlockScroll, resetScrollLock } from '../src/utils/scrollLock';

// The suite runs in Node, and pulling in a full DOM implementation to assert on
// four style properties would cost more than it explains. The module only ever
// touches `document.body.style`, `window.scrollY/innerWidth` and
// `window.scrollTo`, so those are all that need to exist.
function fakeDom(scrollY = 0) {
  document.body.style = { position: '', top: '', width: '', paddingRight: '' };
  window.scrollY = scrollY;
  window.innerWidth = 1000;
  document.documentElement.clientWidth = 1000;
  window.scrollTo = vi.fn();
}

describe('scrollLock', () => {
  beforeEach(() => {
    resetScrollLock();
    globalThis.document = { body: {}, documentElement: {} };
    globalThis.window = {};
    fakeDom();
  });

  it('pins the body without losing where the reader was', () => {
    fakeDom(1250);
    lockScroll();

    expect(document.body.style.position).toBe('fixed');
    // Held as a negative offset so the same content stays under the cursor.
    expect(document.body.style.top).toBe('-1250px');
    expect(document.body.style.width).toBe('100%');
  });

  it('returns the reader to the exact position on release', () => {
    fakeDom(1250);
    lockScroll();
    unlockScroll();

    expect(document.body.style.position).toBe('');
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 1250, left: 0, behavior: 'instant' });
  });

  it('does not release the page when a nested dialog closes', () => {
    fakeDom(400);
    lockScroll();   // details drawer
    lockScroll();   // confirmation dialog opened from inside it
    unlockScroll(); // confirmation dialog closes

    expect(document.body.style.position).toBe('fixed');
    expect(window.scrollTo).not.toHaveBeenCalled();

    unlockScroll(); // drawer closes
    expect(document.body.style.position).toBe('');
    expect(window.scrollTo).toHaveBeenCalledTimes(1);
  });

  it('captures the position once, not once per nested lock', () => {
    fakeDom(400);
    lockScroll();
    // A nested lock must not re-read scrollY: the body is already fixed, so
    // scrollY now reads 0 and would restore the reader to the top.
    window.scrollY = 0;
    lockScroll();
    unlockScroll();
    unlockScroll();

    expect(window.scrollTo).toHaveBeenCalledWith({ top: 400, left: 0, behavior: 'instant' });
  });

  it('ignores a release that was never locked', () => {
    expect(() => unlockScroll()).not.toThrow();
    expect(window.scrollTo).not.toHaveBeenCalled();
  });
});
