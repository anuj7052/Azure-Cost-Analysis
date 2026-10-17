import { describe, expect, it } from 'vitest';
import { effectiveGroupBy, groupedDayPeriods, groupedMonthPeriods, groupNeedsRows, pricingMonthPeriods, splitDayPeriods } from '../src/utils/explorerGroupBy';

const months = [
  { month: '2026-07', total_cost: 100, by_service: { VM: 60, Storage: 40 }, by_subscription: { s1: 70, s2: 30 } },
  { month: '2026-08', total_cost: 50, by_service: { VM: 50 }, by_subscription: { s1: 50 } },
];
const rows = [
  { month: '2026-07', cost: 60, service: 'VM', resource_group: 'rg-a', meter: 'D2s', subscription_id: 's1' },
  { month: '2026-07', cost: 40, service: 'Storage', resource_group: '', meter: 'LRS', subscription_id: 's2' },
  { month: '2026-08', cost: 50, service: 'VM', resource_group: 'rg-a', meter: 'D2s', subscription_id: 's1' },
  { month: '2026-06', cost: 999, service: 'VM', resource_group: 'rg-old', meter: 'D2s', subscription_id: 's1' },
];

describe('explorer group by', () => {
  it('uses the monthly summary for service and subscription so totals match Azure', () => {
    expect(groupNeedsRows('service', months)).toBe(false);
    const subs = groupedMonthPeriods({ groupBy: 'subscription', months, names: { s1: 'Prod' } });
    expect(subs[0]).toMatchObject({ key: '2026-07', total: 100, byService: { Prod: 70, 'Unnamed subscription': 30 } });
  });

  it('builds resource group and meter splits from in-range rows that pass the filters', () => {
    expect(groupNeedsRows('resource_group', months)).toBe(true);
    const groups = groupedMonthPeriods({ groupBy: 'resource_group', months, rows });
    expect(groups.map(g => g.byService)).toEqual([{ 'rg-a': 60, Unassigned: 40 }, { 'rg-a': 50 }]);
    const meters = groupedMonthPeriods({ groupBy: 'meter', months, rows, filters: { service: 'VM' } });
    expect(meters.map(m => m.total)).toEqual([60, 50]);
  });

  it('keeps every grouping available day by day', () => {
    expect(effectiveGroupBy('meter')).toBe('meter');
    expect(effectiveGroupBy('bogus')).toBe('service');
    expect(effectiveGroupBy('none')).toBe('none');
    expect(splitDayPeriods([{ date: '2026-10-01', total: 5, split: { 'rg-a': 5 } }])[0].byService).toEqual({ 'rg-a': 5 });
    expect(pricingMonthPeriods([{ month: '2026-10', total: 9, reserved: 4, on_demand: 5, spot: 0 }])[0].byService).toEqual({ 'Reserved (RI)': 4, 'Pay-as-you-go': 5 });
    const days = groupedDayPeriods([{ date: '2026-08-01', total: 5, by_service: { VM: 5 } }, { date: '2026-08-02', total: null }]);
    expect(days).toHaveLength(1);
    expect(days[0]).toMatchObject({ key: '2026-08-01', byService: { VM: 5 } });
  });
});
