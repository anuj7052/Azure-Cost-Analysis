import { describe, expect, it } from 'vitest';
import { clickedPoint, compareServices, dailyRequest, previousDate, previousMonth, serviceSlice } from '../src/utils/dailyTimeline';
import { monthFromPoint } from '../src/utils/monthDrill';

const store = { selectedTenantId: 'tenant', selectedSubscriptionIds: ['a', 'b'], months: 12, dateMode: 'rolling' };
describe('daily query scope', () => {
  it('scopes subscriptions and RG remotely and caps rolling months', () => {
    expect(dailyRequest(store, { subscription: 'b', resource_group: 'prod', service: 'VM' }).payload).toEqual({
      tenant_id: 'tenant', subscription_ids: ['b'], months: 6, resource_group: 'prod',
    });
  });
  it('preserves custom dates and all selected subscriptions', () => {
    expect(dailyRequest({ ...store, dateMode: 'custom', fromDate: '2026-01-01', toDate: '2026-09-14' }, {}).payload).toMatchObject({
      from_date: '2026-01-01', to_date: '2026-09-14', subscription_ids: ['a', 'b'],
    });
  });
  it.each([{ location: 'eastus' }, { search: 'vm' }, { subscription: 'outside' }])('blocks unsupported scope %o', filters => {
    expect(dailyRequest(store, filters).blocked).toBeTruthy();
    expect(dailyRequest(store, filters).payload).toBeUndefined();
  });
  it('does not query Azure for imported data', () => {
    expect(dailyRequest({ ...store, imported: {} }, {}).blocked).toMatch(/imports/);
  });
});

describe('calendar and Recharts selection', () => {
  it('handles year boundaries, leap days and DST without local timezone arithmetic', () => {
    expect(previousDate('2026-01-01')).toBe('2025-12-31');
    expect(previousDate('2024-03-01')).toBe('2024-02-29');
    expect(previousDate('2026-03-09')).toBe('2026-03-08');
    expect(previousDate('')).toBe('');
    expect(previousMonth('2026-01')).toBe('2025-12');
  });
  it('accepts numeric and string indices including zero and legacy payloads', () => {
    const points = [{ date: '2026-01-01', _key: '2026-01' }, { _isForecast: true }];
    expect(clickedPoint({ activeTooltipIndex: 0 }, points)).toBe(points[0]);
    expect(clickedPoint({ activeTooltipIndex: '0' }, points)).toBe(points[0]);
    expect(clickedPoint({ activePayload: [{ payload: points[0] }] }, points)).toBe(points[0]);
    expect(clickedPoint({ activeTooltipIndex: null }, points)).toBeNull();
    expect(clickedPoint({ activeTooltipIndex: 8 }, points)).toBeNull();
    expect(monthFromPoint(clickedPoint({ activeTooltipIndex: 1 }, points))).toBe('');
    expect(monthFromPoint(clickedPoint({ activeTooltipIndex: 0 }, points))).toBe('2026-01');
  });
});

describe('billed service comparison', () => {
  const prior = { date: '2026-01-01', total: 100, currency: 'USD', by_service: { Old: 80, Shared: 20 } };
  const current = { date: '2026-01-03', total: 75, currency: 'USD', by_service: { New: 50, Shared: 25 } };
  it('includes appeared and disappeared services sorted by absolute delta', () => {
    const result = compareServices(current, prior);
    expect(result.rows.map(row => [row.name, row.delta])).toEqual([['Old', -80], ['New', 50], ['Shared', 5]]);
    expect(result.delta).toBe(-25);
    expect(result.percent).toBe(-25);
    expect(result.residual).toBe(0);
  });
  it('does not compare a missing calendar day to the previous returned row', () => {
    const days = [prior, current];
    const result = compareServices(current, days.find(day => day.date === previousDate(current.date)));
    expect(result.delta).toBeNull();
    expect(result.rows.every(row => row.delta === null && row.prior === null)).toBe(true);
  });
  it('distinguishes zero from missing and avoids an infinite percentage', () => {
    expect(compareServices(current, { total: 0, by_service: {} }).delta).toBe(75);
    expect(compareServices(current, { total: 0, by_service: {} }).percent).toBeNull();
    expect(compareServices({ total: null }, prior).delta).toBeNull();
    expect(compareServices(current, { ...prior, currency: 'INR' }).delta).toBeNull();
  });
  it('reports unattributed deltas and does not invent a missing service breakdown', () => {
    expect(compareServices({ ...current, total: 80 }, prior).residual).toBe(5);
    const result = compareServices({ ...current, by_service: null }, prior);
    expect(result.delta).toBe(-25);
    expect(result.rows.every(row => row.delta === null)).toBe(true);
  });
  it('filters services locally without creating missing days or mutating input', () => {
    const days = serviceSlice([current, prior], 'Old');
    expect(days.map(day => day.total)).toEqual([80, 0]);
    expect(days).toHaveLength(2);
    expect(current.total).toBe(75);
    expect(serviceSlice([{ ...prior, by_service: null }], 'Old')[0].total).toBeNull();
  });
  it('supports monthly totals with the same union logic', () => {
    expect(compareServices({ total_cost: 10, by_service: { VM: 10 } }, { total_cost: 5, by_service: { VM: 5 } }, 'total_cost').delta).toBe(5);
  });
});