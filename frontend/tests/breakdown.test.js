import { describe, it, expect } from 'vitest';
import { aggregate, totalOf, linearForecast, currentMonthKey } from '../src/utils/breakdown';

const res = (over = {}) => ({
  name: 'vm1', type: 'Microsoft.Compute/virtualMachines', service: 'Virtual Machines',
  subscription_id: 'sub-a', resource_group: 'rg-a', location: 'eastus',
  cost: 10, meters: [], ...over,
});

describe('aggregate', () => {
  it('groups and totals by each dimension', () => {
    const rows = [
      res({ cost: 10, service: 'Virtual Machines' }),
      res({ cost: 5, service: 'Storage', resource_group: 'rg-b', location: 'westus' }),
      res({ cost: 7, service: 'Virtual Machines' }),
    ];
    expect(aggregate(rows, 'service')).toEqual([
      { key: 'Virtual Machines', cost: 17, count: 2, unpriced: 0 },
      { key: 'Storage', cost: 5, count: 1, unpriced: 0 },
    ]);
    expect(aggregate(rows, 'resource_group').map(r => r.key)).toEqual(['rg-a', 'rg-b']);
    expect(aggregate(rows, 'location').map(r => r.key)).toEqual(['eastus', 'westus']);
  });

  it('sorts most expensive first', () => {
    const rows = [res({ cost: 1, service: 'A' }), res({ cost: 99, service: 'B' })];
    expect(aggregate(rows, 'service').map(r => r.key)).toEqual(['B', 'A']);
  });

  it('never counts an unreported cost as zero', () => {
    const rows = [res({ cost: null, service: 'A' }), res({ cost: 4, service: 'A' })];
    const [a] = aggregate(rows, 'service');
    expect(a.cost).toBe(4);
    expect(a.count).toBe(2);
    expect(a.unpriced).toBe(1);
  });

  it('fans a resource out across its meters', () => {
    const rows = [res({ cost: 10, meters: [{ name: 'Compute', cost: 6 }, { name: 'Disk', cost: 4 }] })];
    expect(aggregate(rows, 'meter')).toEqual([
      { key: 'Compute', cost: 6, count: 1, unpriced: 0 },
      { key: 'Disk', cost: 4, count: 1, unpriced: 0 },
    ]);
  });

  it('keeps a row for resources with no meters rather than dropping them', () => {
    const out = aggregate([res({ meters: [] })], 'meter');
    expect(out).toEqual([{ key: 'No meter reported', cost: 0, count: 1, unpriced: 1 }]);
  });

  it('labels missing dimension values instead of grouping under empty string', () => {
    expect(aggregate([res({ resource_group: '' })], 'resource_group')[0].key).toBe('Unknown');
  });

  it('falls back to the service dimension for an unknown one', () => {
    expect(aggregate([res()], 'nonsense')[0].key).toBe('Virtual Machines');
  });

  it('handles no resources', () => {
    expect(aggregate([], 'service')).toEqual([]);
    expect(aggregate(undefined, 'service')).toEqual([]);
  });
});

describe('totalOf', () => {
  it('sums the breakdown', () => {
    expect(totalOf(aggregate([res({ cost: 3 }), res({ cost: 4 })], 'service'))).toBe(7);
  });
});

describe('linearForecast', () => {
  const flat = [
    { month: '2026-01', total_cost: 100 },
    { month: '2026-02', total_cost: 100 },
    { month: '2026-03', total_cost: 100 },
  ];

  it('projects a flat trend forward unchanged', () => {
    const out = linearForecast(flat, 2);
    expect(out.map(m => m.month)).toEqual(['2026-04', '2026-05']);
    out.forEach(m => expect(m.total_cost).toBeCloseTo(100));
  });

  it('follows a rising trend', () => {
    const rising = [
      { month: '2026-01', total_cost: 100 },
      { month: '2026-02', total_cost: 200 },
      { month: '2026-03', total_cost: 300 },
    ];
    expect(linearForecast(rising, 1)[0].total_cost).toBeCloseTo(400);
  });

  it('rolls the year over at December', () => {
    const late = [
      { month: '2026-10', total_cost: 100 },
      { month: '2026-11', total_cost: 100 },
      { month: '2026-12', total_cost: 100 },
    ];
    expect(linearForecast(late, 2).map(m => m.month)).toEqual(['2027-01', '2027-02']);
  });

  it('never projects negative spend', () => {
    const falling = [
      { month: '2026-01', total_cost: 300 },
      { month: '2026-02', total_cost: 150 },
      { month: '2026-03', total_cost: 10 },
    ];
    linearForecast(falling, 4).forEach(m => expect(m.total_cost).toBeGreaterThanOrEqual(0));
  });

  it('refuses to project from fewer than three complete months', () => {
    expect(linearForecast(flat.slice(0, 2), 2)).toEqual([]);
    expect(linearForecast([], 2)).toEqual([]);
  });

  it('excludes the month in progress so a partial month cannot drag the line down', () => {
    const withPartial = [...flat, { month: '2026-04', total_cost: 5 }];
    const out = linearForecast(withPartial, 1, { currentMonth: '2026-04' });
    expect(out[0].month).toBe('2026-04');
    expect(out[0].total_cost).toBeCloseTo(100);
  });

  it('marks every point as projected', () => {
    linearForecast(flat, 3).forEach(m => expect(m.projected).toBe(true));
  });
});

describe('currentMonthKey', () => {
  it('zero-pads the month', () => {
    expect(currentMonthKey(new Date(2026, 2, 15))).toBe('2026-03');
    expect(currentMonthKey(new Date(2026, 11, 1))).toBe('2026-12');
  });
});
