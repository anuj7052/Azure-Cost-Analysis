import { describe, expect, it } from 'vitest';
import { reconcileCostRows } from '../src/utils/costReconciliation';
import { monthsFromSummary, summaryFilterSupported } from '../src/utils/trendFilter';
import { compareBoqToUsage } from '../src/utils/boqCompare';

describe('consistent actual costs', () => {
  const months = [{ month: '2026-08', total_cost: 100, by_service: { Storage: 70, Bandwidth: 30 }, currency: 'USD' }];
  it('preserves meter costs and explicitly reconciles missing detail to the dashboard', () => {
    const original = [{ month: '2026-07', service: 'Storage', cost: 500 }, { month: '2026-08', service: 'Storage', cost: 80 }];
    const result = reconcileCostRows(original, months, 'USD');
    expect(result.detailTotal).toBe(80);
    expect(result.adjustments[0].cost).toBe(20);
    const report = compareBoqToUsage([], result.rows, 1, 'USD', { perMonth: false });
    expect(report.actualTotal).toBe(100);
    expect(report.categories.find(c => c.key === 'reconciliation').actual).toBe(20);
    expect(report.notInBoqTotal).toBe(80);
    expect(original[1].cost).toBe(80);
  });
  it('keeps negative reconciliation out of claimed savings', () => {
    const result = reconcileCostRows([{ month: '2026-08', service: 'Storage', cost: 120 }], months);
    const report = compareBoqToUsage([], result.rows, 1, 'USD', { perMonth: false });
    expect(report.actualTotal).toBe(100);
    expect(report.savingTotal).toBe(0);
  });
  it('service-only filtering uses exact summary amounts instead of a second query', () => {
    expect(monthsFromSummary(months, { service: 'Bandwidth' })[0].total_cost).toBe(30);
    expect(monthsFromSummary(months, { service: 'Storage' })[0].by_service).toEqual({ Storage: 70 });
    expect(summaryFilterSupported({ service: 'Storage', subscription: 's' })).toBe(false);
    expect(monthsFromSummary(months, { service: 'Storage', resource_group: 'rg' })).toBeNull();
  });
});
