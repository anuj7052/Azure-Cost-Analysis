import { describe, it, expect } from 'vitest';
import { hasTrendFilters, rowMatches, monthsFromRows, rowCoverage } from '../src/utils/trendFilter';

const row = (over = {}) => ({
  month: '2026-07',
  cost: 100,
  service: 'Virtual Machines',
  meter: 'D4s v5 Compute Units',
  resource_group: 'prod-rg',
  resource_name: 'vm-01',
  subscription_id: 'sub-a',
  region: 'eastus',
  ...over,
});

describe('noticing that a filter is set', () => {
  it('treats no filters as no filters', () => {
    expect(hasTrendFilters({ subscription: '', service: '', search: '' })).toBe(false);
  });

  it('survives being handed nothing at all', () => {
    expect(hasTrendFilters(null)).toBe(false);
    expect(hasTrendFilters(undefined)).toBe(false);
  });

  it('counts a single filter', () => {
    expect(hasTrendFilters({ service: 'Storage' })).toBe(true);
  });

  it('counts a search the same as a dropdown', () => {
    expect(hasTrendFilters({ search: 'vm' })).toBe(true);
  });
});

describe('deciding whether a meter row survives', () => {
  it('keeps a row when nothing is being asked of it', () => {
    expect(rowMatches(row(), {})).toBe(true);
    expect(rowMatches(row(), null)).toBe(true);
  });

  it('matches a subscription exactly', () => {
    expect(rowMatches(row(), { subscription: 'sub-a' })).toBe(true);
    expect(rowMatches(row(), { subscription: 'sub-b' })).toBe(false);
  });

  it('reads the filter\'s location against the row\'s region', () => {
    expect(rowMatches(row(), { location: 'eastus' })).toBe(true);
    expect(rowMatches(row(), { location: 'westus' })).toBe(false);
  });

  it('requires every filter to pass, not any of them', () => {
    const f = { subscription: 'sub-a', service: 'Storage' };
    expect(rowMatches(row(), f)).toBe(false);
  });

  it('searches the meter name, which no dropdown covers', () => {
    expect(rowMatches(row(), { search: 'd4s' })).toBe(true);
  });

  it('searches case-insensitively', () => {
    expect(rowMatches(row(), { search: 'VM-01' })).toBe(true);
  });

  it('rejects a row rather than throwing when it is missing', () => {
    expect(rowMatches(null, {})).toBe(false);
  });
});

describe('summing rows back into months', () => {
  const allowed = ['2026-06', '2026-07'];

  it('adds up the rows of each month separately', () => {
    const rows = [
      row({ month: '2026-06', cost: 10 }),
      row({ month: '2026-07', cost: 20 }),
      row({ month: '2026-07', cost: 5 }),
    ];
    const out = monthsFromRows(rows, {}, { allowed });
    expect(out.map((m) => m.total_cost)).toEqual([10, 25]);
  });

  it('keeps the months in the order it was given', () => {
    const out = monthsFromRows([], {}, { allowed });
    expect(out.map((m) => m.month)).toEqual(['2026-06', '2026-07']);
  });

  it('ignores rows from months outside the chosen range', () => {
    // Rows are fetched further back than the range on purpose; letting them
    // through would grow the chart a tail the moment a filter was set.
    const rows = [row({ month: '2026-01', cost: 999 }), row({ month: '2026-07', cost: 20 })];
    const out = monthsFromRows(rows, {}, { allowed });
    expect(out.find((m) => m.month === '2026-01')).toBeUndefined();
    expect(out.reduce((s, m) => s + m.total_cost, 0)).toBe(20);
  });

  it('keeps a matched-nothing month at zero instead of dropping it', () => {
    const rows = [row({ month: '2026-07', cost: 20 })];
    const out = monthsFromRows(rows, {}, { allowed });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ month: '2026-06', total_cost: 0 });
  });

  it('applies the filter before summing', () => {
    const rows = [
      row({ month: '2026-07', cost: 20, service: 'Storage' }),
      row({ month: '2026-07', cost: 80, service: 'Virtual Machines' }),
    ];
    const out = monthsFromRows(rows, { service: 'Storage' }, { allowed });
    expect(out[1].total_cost).toBe(20);
  });

  it('builds a service split so the month drill-down still works', () => {
    const rows = [
      row({ month: '2026-07', cost: 20, service: 'Storage' }),
      row({ month: '2026-07', cost: 80, service: 'Virtual Machines' }),
    ];
    const out = monthsFromRows(rows, {}, { allowed });
    expect(out[1].by_service).toEqual({ Storage: 20, 'Virtual Machines': 80 });
  });

  it('leaves a row with no service out of the split but in the total', () => {
    const rows = [row({ month: '2026-07', cost: 20, service: '' })];
    const out = monthsFromRows(rows, {}, { allowed });
    expect(out[1].total_cost).toBe(20);
    expect(out[1].by_service).toEqual({});
  });

  it('carries the currency onto every month', () => {
    const out = monthsFromRows([], {}, { allowed, currency: 'INR' });
    expect(out.every((m) => m.currency === 'INR')).toBe(true);
  });

  it('treats a non-numeric cost as nothing rather than NaN', () => {
    const rows = [row({ month: '2026-07', cost: null }), row({ month: '2026-07', cost: 5 })];
    expect(monthsFromRows(rows, {}, { allowed })[1].total_cost).toBe(5);
  });

  it('survives being handed no rows', () => {
    expect(monthsFromRows(null, {}, { allowed })).toHaveLength(2);
  });
});

describe('reporting how much of the real total the rows account for', () => {
  const allowed = ['2026-07'];
  const monthly = [{ month: '2026-07', total_cost: 100 }];

  it('is one when the rows add up to the real total', () => {
    const rows = [row({ cost: 100 })];
    expect(rowCoverage(rows, allowed, monthly)).toBe(1);
  });

  it('is a fraction when the rows fall short', () => {
    const rows = [row({ cost: 40 })];
    expect(rowCoverage(rows, allowed, monthly)).toBeCloseTo(0.4);
  });

  it('never exceeds one, because over-coverage is not a thing a reader can act on', () => {
    const rows = [row({ cost: 150 })];
    expect(rowCoverage(rows, allowed, monthly)).toBe(1);
  });

  it('says nothing rather than zero when there is no total to compare against', () => {
    expect(rowCoverage([], allowed, [])).toBeNull();
  });

  it('ignores months outside the range on both sides', () => {
    const rows = [row({ month: '2026-01', cost: 500 }), row({ cost: 50 })];
    expect(rowCoverage(rows, allowed, monthly)).toBeCloseTo(0.5);
  });
});
