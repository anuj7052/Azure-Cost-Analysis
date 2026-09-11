import { describe, it, expect } from 'vitest';
import { runGated, DEFAULT_LIMIT } from '../src/utils/loadGate';

/** A task that resolves after `ms`, recording when it starts and stops. */
function tracked(log, name, ms = 0) {
  return () => {
    log.push(`start:${name}`);
    return new Promise((resolve) => {
      setTimeout(() => { log.push(`end:${name}`); resolve(name); }, ms);
    });
  };
}

/** How many were running at once, at the busiest moment. */
function peak(log) {
  let live = 0;
  let high = 0;
  for (const entry of log) {
    if (entry.startsWith('start:')) { live += 1; high = Math.max(high, live); }
    else live -= 1;
  }
  return high;
}

describe('running the loaders under a gate', () => {
  it('runs every task', async () => {
    const results = await runGated([
      () => Promise.resolve('a'),
      () => Promise.resolve('b'),
      () => Promise.resolve('c'),
    ]);
    expect(results.map(r => r.value)).toEqual(['a', 'b', 'c']);
  });

  it('never has more than the limit in flight', async () => {
    // The whole reason the gate exists. A burst is what earns a 429; eight
    // loaders firing at once against one tenant is that burst.
    const log = [];
    await runGated(
      Array.from({ length: 8 }, (_, i) => tracked(log, i, 5)),
      { limit: 3 },
    );
    expect(peak(log)).toBe(3);
  });

  it('does run them concurrently, which is the point', async () => {
    // Guards against a regression to one-at-a-time, which would pass the
    // limit test above while being slower than the waves it replaced.
    const log = [];
    await runGated(
      Array.from({ length: 4 }, (_, i) => tracked(log, i, 5)),
      { limit: 4 },
    );
    expect(peak(log)).toBe(4);
  });

  it('starts the next task the moment a slot frees, not when the batch ends', async () => {
    // Slicing the list into fixed chunks would leave a worker idle once its
    // own chunk ran out -- the wave problem again, just smaller.
    const log = [];
    await runGated([
      tracked(log, 'slow', 30),
      tracked(log, 'quick', 1),
      tracked(log, 'third', 1),
    ], { limit: 2 });
    expect(log.indexOf('start:third')).toBeLessThan(log.indexOf('end:slow'));
  });

  it('keeps going when one task fails', async () => {
    // One provider timing out must not cancel the six that would have
    // succeeded. Each loader records its own failure in the store.
    const boom = new Error('posture timed out');
    const results = await runGated([
      () => Promise.resolve('costs'),
      () => Promise.reject(boom),
      () => Promise.resolve('access'),
    ]);
    expect(results[0]).toEqual({ status: 'fulfilled', value: 'costs' });
    expect(results[1]).toEqual({ status: 'rejected', reason: boom });
    expect(results[2]).toEqual({ status: 'fulfilled', value: 'access' });
  });

  it('catches a task that throws before it returns a promise', async () => {
    const results = await runGated([() => { throw new Error('sync'); }]);
    expect(results[0].status).toBe('rejected');
  });

  it('reports each result as it lands, not all at the end', async () => {
    // So the page fills in progressively rather than appearing all at once
    // when the slowest item finishes.
    const seen = [];
    await runGated([
      tracked([], 'slow', 20),
      tracked([], 'quick', 1),
    ], { limit: 2, onSettled: (i) => seen.push(i) });
    expect(seen).toEqual([1, 0]);
  });

  it('holds results in the order given, whatever order they finish in', async () => {
    const results = await runGated([
      tracked([], 'slow', 20),
      tracked([], 'quick', 1),
    ], { limit: 2 });
    expect(results.map(r => r.value)).toEqual(['slow', 'quick']);
  });

  it('survives an empty or absent list', async () => {
    expect(await runGated([])).toEqual([]);
    expect(await runGated(undefined)).toEqual([]);
  });

  it('skips holes rather than calling undefined', async () => {
    const results = await runGated([null, () => Promise.resolve('a'), false]);
    expect(results.map(r => r.value)).toEqual(['a']);
  });

  it('does not spawn more workers than there are tasks', async () => {
    const log = [];
    await runGated([tracked(log, 'only', 1)], { limit: 8 });
    expect(peak(log)).toBe(1);
  });

  it('treats a limit below one as one rather than stalling forever', async () => {
    // A zero-width gate would hang the page with no error to explain it.
    const results = await runGated([() => Promise.resolve('a')], { limit: 0 });
    expect(results[0].value).toBe('a');
  });

  it('defaults to a limit that is neither serial nor a spike', () => {
    expect(DEFAULT_LIMIT).toBeGreaterThan(1);
    expect(DEFAULT_LIMIT).toBeLessThan(8);
  });
});
