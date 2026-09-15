import React from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import CostAnalysisChart from '../src/components/Charts/CostAnalysisChart';

const state = vi.hoisted(() => ({ view: null, effects: [] }));
vi.mock('react', async original => ({
  ...await original(),
  useMemo: compute => compute(),
  useEffect: callback => state.effects.push(callback),
  useState: initial => [typeof initial === 'function' ? { ...initial(), ...state.view } : initial, vi.fn()],
}));
vi.mock('../src/store/useTheme', () => ({ useChartTheme: () => ({ series: ['blue'] }) }));

beforeEach(() => { state.view = {}; state.effects = []; });

it.each([
  ['monthly', 'service', 0, 0],
  ['monthly', 'resource_group', 1, 0],
  ['daily', 'service', 0, 1],
])('loads only the detail needed by %s / %s', (granularity, groupBy, rowsCalls, dayCalls) => {
  state.view = { granularity, groupBy };
  const onLoadRows = vi.fn();
  const onLoadDaily = vi.fn();
  const tree = CostAnalysisChart({ onLoadRows, onLoadDaily });
  expect(React.isValidElement(tree)).toBe(true);
  state.effects.forEach(run => run());
  expect(onLoadRows).toHaveBeenCalledTimes(rowsCalls);
  expect(onLoadDaily).toHaveBeenCalledTimes(dayCalls);
});
