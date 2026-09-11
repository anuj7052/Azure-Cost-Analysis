/**
 * Running a page's loaders concurrently without arriving as a spike.
 *
 * The Estate page used to load in four sequential waves, so the page took the
 * sum of four round trips rather than the length of the longest one. The waves
 * were never a data dependency -- nothing in wave 4 reads anything wave 2
 * produced -- they were a hand-rolled rate limiter, spreading load by making
 * the user wait.
 *
 * This does the same job without the idle time. Every loader is started, but
 * only a few are ever in flight, so Azure still sees a steady stream rather
 * than a burst. A burst is what actually earns a 429; total concurrency over a
 * minute is not.
 */

/** How many loaders may be in flight at once. */
export const DEFAULT_LIMIT = 4;

/**
 * Run tasks with at most `limit` in flight, in the order given.
 *
 * Settles rather than rejects, like the Promise.allSettled it replaces: one
 * provider timing out must not cancel the six that would have succeeded. Each
 * loader already records its own failure in the store, so a rejection here is
 * a value to report, not an error to raise.
 *
 * `onSettled` fires as each task finishes rather than at the end, so the page
 * can fill in progressively instead of appearing all at once when the slowest
 * item lands.
 */
export async function runGated(tasks, { limit = DEFAULT_LIMIT, onSettled } = {}) {
  const list = (tasks || []).filter(Boolean);
  const results = new Array(list.length);
  // A shared cursor rather than fixed slices: slicing the list into `limit`
  // chunks would leave a worker idle once its own chunk ran out, which is the
  // wave problem again at a smaller scale.
  let next = 0;

  const worker = async () => {
    while (next < list.length) {
      const index = next;
      next += 1;
      try {
        results[index] = { status: 'fulfilled', value: await list[index]() };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
      if (onSettled) onSettled(index, results[index]);
    }
  };

  const size = Math.max(1, Math.min(limit, list.length));
  await Promise.all(Array.from({ length: size }, worker));
  return results;
}
