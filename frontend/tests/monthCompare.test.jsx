import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import MonthCompare from '../src/components/Charts/MonthCompare';
import { comparisonMonths, resolveMonthPair, migrateExplorerView } from '../src/utils/monthCompare';
import { monthsFromRows } from '../src/utils/trendFilter';

const months = [
  { month: '2026-09', total_cost: 30, by_service: { New: 30 }, currency: 'USD' },
  { month: '2026-06', total_cost: 5, by_service: { Older: 5 }, currency: 'USD' },
  { month: '2026-08', total_cost: 10, by_service: { Old: 10 }, currency: 'USD' },
];
const render = props => renderToStaticMarkup(<MonthCompare months={months} currency="USD" currentMonth="2026-09" {...props} />);

describe('month comparison', () => {
  it('defaults to the last two chronological returned months without mutating input or filling gaps', () => {
    expect(resolveMonthPair(months)).toEqual({ baseline: '2026-08', selected: '2026-09' });
    expect(comparisonMonths(months).map(row => row.month)).toEqual(['2026-06', '2026-08', '2026-09']);
    expect(months[0].month).toBe('2026-09');
  });
  it('supports arbitrary and reverse comparisons and recovers from unavailable selections', () => {
    expect(resolveMonthPair(months, '2026-09', '2026-06')).toEqual({ baseline: '2026-09', selected: '2026-06' });
    expect(resolveMonthPair(months, '2026-07', '2026-01')).toEqual({ baseline: '2026-08', selected: '2026-09' });
    expect(resolveMonthPair(months, '2026-09', '2026-09')).toEqual({ baseline: '2026-08', selected: '2026-09' });
    expect(resolveMonthPair([])).toEqual({ baseline: '', selected: '' });
  });
  it('renders selectors, total delta, disappeared and new services and partial warning', () => {
    const html = render();
    for (const text of ['Baseline month', 'Selected month', '+USD 20.00', 'Old', 'New', 'USD -10.00', '+USD 30.00', 'Current month is partial']) expect(html).toContain(text);
    expect(html).not.toContain('2026-07');
  });
  it('prompts to widen the range rather than fabricating a baseline', () => {
    for (const returned of [[], [months[0]]]) {
      const html = render({ months: returned });
      expect(html).toContain('Widen the date range');
      expect(html).not.toContain('Billing comparison for');
    }
    expect(render({ loading: true })).toContain('Loading monthly comparison');
    expect(render({ loading: true })).not.toContain('Change:');
  });
  it('uses filtered monthly totals and communicates incomplete coverage', () => {
    const filtered = monthsFromRows([
      { month: '2026-08', service: 'Keep', cost: 2 },
      { month: '2026-09', service: 'Keep', cost: 7 },
      { month: '2026-09', service: 'Exclude', cost: 100 },
    ], { service: 'Keep' }, { allowed: ['2026-08', '2026-09'], currency: 'USD' });
    const html = render({ months: filtered, filtered: true, coverage: 0.8 });
    expect(html).toContain('+USD 5.00');
    expect(html).toContain('80%');
    expect(html).not.toContain('Exclude');
  });
  it('migrates legacy views and preserves explicit monthly choices and filters', () => {
    expect(migrateExplorerView({ name: 'Old', tab: 'breakdown', dimension: 'service', filters: { service: 'VM' } })).toEqual({ name: 'Old', tab: 'compare', timeline: 'daily', filters: { service: 'VM' } });
    expect(migrateExplorerView({ tab: 'resources' }).tab).toBe('trend');
    for (const tab of ['trend', 'groups', 'compare']) expect(migrateExplorerView({ tab, timeline: 'monthly' })).toEqual({ tab, timeline: 'monthly' });
  });
});