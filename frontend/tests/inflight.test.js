/**
 * The in-flight tracker behind the global loading indicator.
 *
 * Two failures matter here and neither is cosmetic. A leaked counter leaves a
 * spinner running over an app that has finished, which teaches people to
 * ignore the indicator entirely -- at which point it is worse than not having
 * one. And an unstable snapshot makes `useSyncExternalStore` re-render without
 * end, because it compares snapshots by identity.
 */
import { describe as group, it, expect, beforeEach } from 'vitest';
import { begin, end, describe as label, getSnapshot, reset, subscribe } from '../src/api/inflight';

beforeEach(() => reset());

group('counting what is outstanding', () => {
  it('reports nothing in flight to begin with', () => {
    expect(getSnapshot().count).toBe(0);
  });

  it('counts a request that has started', () => {
    begin('/costs');
    expect(getSnapshot().count).toBe(1);
  });

  it('stops counting a request that has finished', () => {
    const id = begin('/costs');
    end(id);
    expect(getSnapshot().count).toBe(0);
  });

  it('tracks several at once', () => {
    begin('/costs');
    begin('/services');
    const third = begin('/orphaned');
    expect(getSnapshot().count).toBe(3);
    end(third);
    expect(getSnapshot().count).toBe(2);
  });

  it('ignores an unknown id rather than going negative', () => {
    begin('/costs');
    end(9999);
    end(undefined);
    expect(getSnapshot().count).toBe(1);
  });

  it('ignores the same id ended twice', () => {
    const a = begin('/costs');
    begin('/services');
    end(a);
    end(a);
    expect(getSnapshot().count).toBe(1);
  });
});

group('naming what is being waited on', () => {
  it('names the slowest read rather than the newest', async () => {
    begin('/costs');
    await new Promise((r) => setTimeout(r, 5));
    begin('/search');
    // The search finishing quickly should not relabel the indicator; the cost
    // query is what the user is still waiting for.
    expect(getSnapshot().label).toBe('Reading cost data from Azure');
  });

  it('prefers the more specific prefix', () => {
    expect(label('/security/role-assignments')).toBe('Reading access and security data');
    expect(label('/network/topology')).toBe('Mapping the network');
  });

  it('falls back to something honest for an unmapped route', () => {
    expect(label('/something-new')).toBe('Loading');
  });

  it('records when the oldest request started', () => {
    const before = Date.now();
    begin('/costs');
    expect(getSnapshot().since).toBeGreaterThanOrEqual(before);
  });
});

group('being safe to render from', () => {
  it('returns the same object while nothing changes', () => {
    begin('/costs');
    expect(getSnapshot()).toBe(getSnapshot());
  });

  it('returns the same object when idle', () => {
    expect(getSnapshot()).toBe(getSnapshot());
  });

  it('returns a different object once something changes', () => {
    const idle = getSnapshot();
    begin('/costs');
    expect(getSnapshot()).not.toBe(idle);
  });

  it('tells subscribers when something starts and finishes', () => {
    const seen = [];
    const stop = subscribe((s) => seen.push(s.count));
    const id = begin('/costs');
    end(id);
    stop();
    expect(seen).toEqual([1, 0]);
  });

  it('stops telling a subscriber that has unsubscribed', () => {
    const seen = [];
    const stop = subscribe((s) => seen.push(s.count));
    stop();
    begin('/costs');
    expect(seen).toEqual([]);
  });
});
