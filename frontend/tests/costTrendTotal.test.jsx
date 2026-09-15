import React from 'react';
import { expect, it, vi } from 'vitest';
import CostTrendChart from '../src/components/Charts/CostTrendChart';
vi.mock('../src/store/useTheme', () => ({ useChartTheme: () => ({ series: ['blue'] }) }));

it('plots the headline total with full precision and a separate forecast series', () => {
  const root = CostTrendChart({ months: [{ month: '2026-08', total_cost: 448757.704,
    by_subscription: { first: 311207.37, second: 137550.334 } }],
    forecast: [{ month: '2026-09', total_cost: 450000 }] });
  const chart = root.props.children;
  expect(chart.props.data[0].total).toBe(448757.704);
  expect(chart.props.data[1].total).toBeUndefined();
  expect(chart.props.data[1].projected).toBe(450000);
  const children = React.Children.toArray(chart.props.children);
  expect(children.some(child => child.props?.dataKey === 'total')).toBe(true);
  expect(children.some(child => child.props?.dataKey === 'projected')).toBe(true);
});
