import { describe, it, expect } from 'vitest';
import { elevationAge, elevationState, STALE_AFTER_MS } from '../src/utils/elevation';

const NOW = Date.parse('2026-09-14T12:00:00Z');
const ago = (ms) => new Date(NOW - ms).toISOString();

describe('elevationAge', () => {
  it('says just now for something taken moments ago', () => {
    expect(elevationAge(ago(5_000), NOW).label).toBe('just now');
  });

  it('survives a clock that runs ahead of Azure', () => {
    // Skew can put a fresh elevation slightly in the future. "just now" is
    // true enough; "-1 minutes ago" reads as a bug.
    const age = elevationAge(new Date(NOW + 30_000).toISOString(), NOW);
    expect(age.label).toBe('just now');
    expect(age.ms).toBe(0);
  });

  it('counts in minutes, then hours, then days', () => {
    expect(elevationAge(ago(5 * 60_000), NOW).label).toBe('5 minutes ago');
    expect(elevationAge(ago(3 * 3600_000), NOW).label).toBe('3 hours ago');
    expect(elevationAge(ago(4 * 86_400_000), NOW).label).toBe('4 days ago');
  });

  it('does not write "1 hours ago"', () => {
    expect(elevationAge(ago(3600_000), NOW).label).toBe('1 hour ago');
    expect(elevationAge(ago(86_400_000), NOW).label).toBe('1 day ago');
  });

  it('returns null rather than inventing a duration it does not have', () => {
    // "0 minutes ago" for an unknown date is a lie that reads as a fact.
    expect(elevationAge('', NOW)).toBeNull();
    expect(elevationAge(null, NOW)).toBeNull();
    expect(elevationAge('not a date', NOW)).toBeNull();
  });

  it('marks an elevation stale once it has outlived its task', () => {
    expect(elevationAge(ago(STALE_AFTER_MS - 1000), NOW).stale).toBe(false);
    expect(elevationAge(ago(STALE_AFTER_MS + 1000), NOW).stale).toBe(true);
  });
});

describe('elevationState', () => {
  it('treats a missing answer as unknown, not as "not elevated"', () => {
    // Offering Elevate here would invite somebody to take access they may
    // already hold.
    const view = elevationState(null);
    expect(view.state).toBe('unknown');
    expect(view.canElevate).toBe(false);
    expect(view.canRemove).toBe(false);
  });

  it('carries the reason forward when Azure could not be asked', () => {
    const view = elevationState({ unknown: true, error: 'Azure could not be reached.' });
    expect(view.state).toBe('unknown');
    expect(view.error).toBe('Azure could not be reached.');
  });

  it('offers only removal to somebody already elevated', () => {
    const view = elevationState({ elevated: true, created_on: ago(60_000), assignment_id: '/ra-1' });
    expect(view.state).toBe('elevated');
    expect(view.canRemove).toBe(true);
    expect(view.canElevate).toBe(false);
    expect(view.assignmentId).toBe('/ra-1');
  });

  it('stays quiet about a recent elevation', () => {
    const view = elevationState({ elevated: true, created_on: new Date().toISOString() });
    expect(view.tone).toBe('info');
  });

  it('raises its own finding about an elevation nobody removed', () => {
    const view = elevationState({
      elevated: true,
      created_on: new Date(Date.now() - STALE_AFTER_MS - 60_000).toISOString(),
    });
    expect(view.tone).toBe('medium');
    expect(view.age.stale).toBe(true);
  });

  it('is loud when the subscription list is empty, which is the whole point', () => {
    const view = elevationState({ elevated: false }, { subscriptionCount: 0 });
    expect(view.state).toBe('needed');
    expect(view.tone).toBe('medium');
    expect(view.canElevate).toBe(true);
  });

  it('stays quiet when the estate is already visible', () => {
    const view = elevationState({ elevated: false }, { subscriptionCount: 7 });
    expect(view.state).toBe('offer');
    expect(view.tone).toBe('info');
    expect(view.canElevate).toBe(true);
  });

  it('does not warn while the subscription list is still loading', () => {
    // Null is "not answered yet". Guessing "none" would flash a warning at
    // somebody whose estate is about to appear.
    const view = elevationState({ elevated: false }, { subscriptionCount: null });
    expect(view.state).toBe('offer');
  });

  it('defaults to offer when nothing is known about the subscriptions', () => {
    expect(elevationState({ elevated: false }).state).toBe('offer');
  });

  it('never offers both buttons at once', () => {
    const cases = [
      null,
      { unknown: true },
      { elevated: true, created_on: ago(60_000) },
      { elevated: false },
    ];
    for (const status of cases) {
      const view = elevationState(status, { subscriptionCount: 0 });
      expect(view.canElevate && view.canRemove).toBe(false);
    }
  });
});
