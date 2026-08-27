import { describe, it, expect } from 'vitest';

/**
 * The scheduling rules for healing a partial cost result.
 *
 * The store's own scheduler is bound to zustand, timers and the network, so
 * the decision it makes is extracted here and pinned directly. What matters is
 * not that a timer fires but *whether one should*, and for how long: retrying
 * a permission failure is a spin loop, and retrying after one second is how a
 * retry becomes a second throttle.
 */

const MAX_COST_RETRIES = 3;
const MIN_COST_RETRY_SECONDS = 5;

function planRetry(errors, retriesLeft = MAX_COST_RETRIES) {
  if (!Array.isArray(errors)) return null;
  const waits = errors.filter(e => e?.retryable).map(e => Number(e.retry_after_seconds) || 0);
  if (waits.length === 0) return null;
  if (retriesLeft <= 0) return null;
  return { seconds: Math.max(...waits, MIN_COST_RETRY_SECONDS), subscriptions: waits.length };
}

const throttled = (id, wait) => ({ subscription_id: id, retryable: true, retry_after_seconds: wait });
const denied = (id) => ({ subscription_id: id, retryable: false, retry_after_seconds: 0 });

describe('healing a partial cost result', () => {
  it('waits for a throttled subscription instead of asking the reader to', () => {
    expect(planRetry([throttled('a', 40)])).toEqual({ seconds: 40, subscriptions: 1 });
  });

  it('never comes back sooner than the floor', () => {
    // Azure asking for one second is not a reason to believe one second is
    // enough; returning immediately renews the throttle.
    expect(planRetry([throttled('a', 1)]).seconds).toBe(MIN_COST_RETRY_SECONDS);
  });

  it('waits out the longest cooldown, not the shortest', () => {
    // Coming back on the shortest wait retries a subscription still inside its
    // own cooldown, which renews the throttle rather than clearing it.
    expect(planRetry([throttled('a', 10), throttled('b', 45)]).seconds).toBe(45);
  });

  it('does not retry a missing role for ever', () => {
    expect(planRetry([denied('a')])).toBeNull();
  });

  it('still retries when only some of the failures are temporary', () => {
    expect(planRetry([denied('a'), throttled('b', 20)])).toEqual({ seconds: 20, subscriptions: 1 });
  });

  it('schedules nothing when everything succeeded', () => {
    expect(planRetry([])).toBeNull();
  });

  it('gives up rather than querying a throttled tenant all afternoon', () => {
    expect(planRetry([throttled('a', 20)], 0)).toBeNull();
  });

  it('tolerates a response with no coverage errors at all', () => {
    expect(planRetry(undefined)).toBeNull();
  });
});
