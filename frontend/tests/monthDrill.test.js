import { describe, it, expect } from 'vitest';
import {
  monthFromPoint, monthByKey, servicesInMonth, unattributed,
} from '../src/utils/monthDrill';

const month = (over = {}) => ({
  month: '2026-08',
  total_cost: 100,
  by_service: { 'Virtual Machines': 60, Storage: 30, Bandwidth: 10 },
  ...over,
});

describe('deciding which month was clicked', () => {
  it('reads the raw key, not the label', () => {
    // "Sep 26" cannot be looked up again, and two years sharing a month name
    // would collide.
    expect(monthFromPoint({ _key: '2026-09', month: 'Sep 26' })).toBe('2026-09');
  });

  it('refuses a forecast point', () => {
    // A projection has no services behind it. Breaking one down would put a
    // guess in the same table that elsewhere shows invoices.
    expect(monthFromPoint({ _key: '2026-12', _isForecast: true })).toBe('');
  });

  it('refuses a click that landed on nothing', () => {
    expect(monthFromPoint(null)).toBe('');
    expect(monthFromPoint({})).toBe('');
  });
});

describe('finding the clicked month', () => {
  it('returns the matching month', () => {
    const months = [month({ month: '2026-07' }), month({ month: '2026-08' })];
    expect(monthByKey(months, '2026-08').month).toBe('2026-08');
  });

  it('returns nothing for a month that is not there', () => {
    // Narrowing the date range can drop the month that was open. Nothing is
    // the honest answer; the first month would silently retitle the panel.
    expect(monthByKey([month()], '2020-01')).toBe(null);
  });

  it('survives an empty or absent list', () => {
    expect(monthByKey([], '2026-08')).toBe(null);
    expect(monthByKey(undefined, '2026-08')).toBe(null);
    expect(monthByKey([month()], '')).toBe(null);
  });
});

describe('the services behind one month', () => {
  it('lists them largest first', () => {
    expect(servicesInMonth(month()).map(r => r.name))
      .toEqual(['Virtual Machines', 'Storage', 'Bandwidth']);
  });

  it('breaks ties by name so the order does not wander between renders', () => {
    const rows = servicesInMonth(month({ by_service: { Beta: 5, Alpha: 5 } }));
    expect(rows.map(r => r.name)).toEqual(['Alpha', 'Beta']);
  });

  it('takes each share against the month, not the range', () => {
    // The question is what made *this* month. A percentage of a number that
    // is not on screen means nothing.
    const rows = servicesInMonth(month());
    expect(rows[0].share).toBeCloseTo(60);
    expect(rows[1].share).toBeCloseTo(30);
  });

  it('reports no share rather than NaN when the month is empty of cost', () => {
    const rows = servicesInMonth(month({ by_service: { Free: 0 } }));
    expect(rows[0].share).toBe(null);
  });

  it('returns nothing for a month with no breakdown', () => {
    expect(servicesInMonth(month({ by_service: {} }))).toEqual([]);
    expect(servicesInMonth(null)).toEqual([]);
  });
});

describe('what the services do not account for', () => {
  it('reports nothing when they add up', () => {
    expect(unattributed(month())).toBe(0);
  });

  it('reports the gap when Azure named fewer charges than it billed', () => {
    // Grouped totals can omit charges carrying no service name. Saying so is
    // the difference between a reader trusting the table and quietly noticing
    // it does not add up.
    expect(unattributed(month({ total_cost: 120 }))).toBeCloseTo(20);
  });

  it('does not report floating-point noise as a finding', () => {
    expect(unattributed(month({ total_cost: 100.001 }))).toBe(0);
  });

  it('reports a negative gap rather than hiding it', () => {
    // Rows summing to more than the headline is a real contradiction and the
    // reader should see it, not a reassuring zero.
    expect(unattributed(month({ total_cost: 90 }))).toBeCloseTo(-10);
  });

  it('says nothing about a month it does not have', () => {
    expect(unattributed(null)).toBe(0);
  });
});
