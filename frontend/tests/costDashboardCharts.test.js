import { describe, expect, it } from 'vitest';
import { buildSeries, dayLabel, monthLabel } from '../src/utils/costDashboardSeries';

const period = (key, total, byService) => ({ key, label: key, full: key, total, byService });

describe('buildSeries', () => {
  it('keeps the top six services and folds the rest into Other', () => {
    const services = Object.fromEntries(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((name, i) => [name, 80 - i * 10]));
    const { keys, rows } = buildSeries([period('2026-10-01', 360, services)]);
    expect(keys).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'Other']);
    expect(rows[0].Other).toBe(20 + 10);
  });

  it('stacks to the reported total and tracks a running total', () => {
    const { rows } = buildSeries([
      period('2026-10-01', 100, { VM: 60, Storage: 40 }),
      period('2026-10-02', 150, { VM: 100, Storage: 50 }),
    ]);
    expect(rows[1].VM + rows[1].Storage).toBe(rows[1].total);
    expect(rows.map(r => r.cumulative)).toEqual([100, 250]);
  });

  it('reports change only when there is a previous non-zero period', () => {
    const { rows } = buildSeries([
      period('m1', 0, {}),
      period('m2', 100, { VM: 100 }),
      period('m3', 150, { VM: 150 }),
    ]);
    expect(rows[0].change).toBeNull();
    expect(rows[1].change).toBeNull();
    expect(rows[2].change).toBe(50);
  });

  it('handles empty data without inventing services', () => {
    expect(buildSeries([])).toMatchObject({ rows: [], keys: [], share: [], total: 0 });
  });
});

describe('labels', () => {
  it('formats month and day keys', () => {
    expect(monthLabel('2026-10')).toBe('Oct 2026');
    expect(dayLabel('2026-10-05')).toBe('5 Oct');
  });
});
