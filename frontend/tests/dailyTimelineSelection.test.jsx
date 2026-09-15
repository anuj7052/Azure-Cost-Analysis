import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import CostDailyTimeline from '../src/components/Charts/CostDailyTimeline';
import { DayDetail, ServiceDetail } from '../src/components/Boq/BoqDayDetail';
import DayTimeline from '../src/components/Common/DayTimeline';

const state = vi.hoisted(() => ({ selected: '', setSelected: vi.fn(), service: null, setService: vi.fn(), data: null }));
vi.mock('react', async original => ({
  ...await original(), useEffect: () => {}, useMemo: fn => fn(), useRef: () => ({ current: null }),
  useState: initial => initial === '' ? [state.selected, state.setSelected]
    : initial === null ? [state.service, state.setService]
    : typeof initial === 'function' ? [{ data: state.data }, vi.fn()]
    : [initial, vi.fn()],
}));
vi.mock('../src/api/client', () => ({ fetchDailyCosts: vi.fn() }));
vi.mock('../src/store/useAppStore', () => ({ useAppStore: () => ({ selectedTenantId: 't', selectedSubscriptionIds: ['s'], months: 3 }) }));
vi.mock('../src/store/useTheme', () => ({ useChartTheme: () => ({ series: ['blue', 'green'] }) }));
vi.mock('recharts', () => ({ ResponsiveContainer: () => null, AreaChart: () => null, Area: () => null, CartesianGrid: () => null, ReferenceLine: () => null, Tooltip: () => null, XAxis: () => null, YAxis: () => null }));
function nodes(node) { return React.isValidElement(node) ? [node, ...React.Children.toArray(node.props.children).flatMap(nodes)] : []; }
function tree() { const query = CostDailyTimeline({ filters: {} }); return query.type(query.props); }
beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', cb => cb());
  state.selected = ''; state.service = null; state.setSelected.mockClear(); state.setService.mockClear();
  state.data = { currency: 'USD', days: [{ date: '2026-08-01', total: 10, by_service: { Storage: 10 } }, { date: '2026-08-02', total: 15, by_service: { Storage: 15 } }] };
});
it('opens with the BOQ compact chart and collapsed timeline, without duplicate drilldowns', () => {
  const root = tree();
  expect(nodes(root).some(n => n.type === DayTimeline)).toBe(false);
  expect(nodes(root).some(n => n.type === DayDetail)).toBe(false);
  const html = renderToStaticMarkup(root);
  expect(html).toContain('Running total');
  expect(html).toContain('Timeline');
  expect(html).not.toContain('All returned dates');
});
it('date selection opens the same BOQ day detail component', () => {
  const input = nodes(tree()).find(n => n.type === 'input');
  input.props.onInput({ currentTarget: { value: '2026-08-02', validity: { valid: true } } });
  expect(state.setSelected).toHaveBeenCalledWith('2026-08-02');
  state.selected = '2026-08-02';
  const detail = nodes(tree()).find(n => n.type === DayDetail);
  expect(detail.props.date).toBe('2026-08-02');
  detail.props.onPickService('Storage');
  expect(state.setService).toHaveBeenCalledWith('Storage');
});
it('reuses BOQ service details across the full range and keeps missing dates distinct', () => {
  state.selected = '2026-08-03';
  expect(renderToStaticMarkup(tree())).toContain('A missing date is not a zero-cost date');
  state.service = 'Storage';
  const detail = nodes(tree()).find(n => n.type === ServiceDetail);
  expect(detail.props.days).toHaveLength(2);
  expect(detail.props.name).toBe('Storage');
});
