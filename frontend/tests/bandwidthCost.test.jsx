import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import BandwidthCostPanel from '../src/components/Common/BandwidthCostPanel';
import CostExplorer from '../src/pages/CostExplorer';
import { usePageRefresh } from '../src/store/usePageRefresh';
import { migrateExplorerView } from '../src/utils/monthCompare';

const fixture = vi.hoisted(() => ({ store: {}, tab: 'trend', effects: [], requested: true }));
vi.mock('react', async original => ({
  ...await original(),
  useMemo: compute => compute(),
  useCallback: callback => callback,
  useRef: initial => ({ current: initial }),
  useEffect: effect => { fixture.effects.push(effect); },
  useState: initial => [initial === false ? fixture.requested : typeof initial === 'function' ? initial() : initial, vi.fn()],
}));
vi.mock('react-router-dom', () => ({ useSearchParams: () => [new URLSearchParams({ tab: fixture.tab }), vi.fn()] }));
vi.mock('../src/api/client', () => ({ fetchDailyCosts: vi.fn() }));
vi.mock('../src/store/useAppStore', () => ({ useAppStore: selector => selector ? selector(fixture.store) : fixture.store }));
vi.mock('../src/store/usePageRefresh', async original => {
  const actual = await original();
  const hook = selector => selector(actual.usePageRefresh.getState());
  Object.assign(hook, actual.usePageRefresh);
  return { usePageRefresh: hook };
});
vi.mock('../src/components/Common/BandwidthTables', () => ({
  MeterTable: () => <div>Meter drill</div>,
  SubscriptionBandwidthTable: () => <div>Subscription costs</div>,
}));
vi.mock('../src/components/Common/BandwidthTrackPanel', () => ({ default: () => <div>Resource charge tracking</div> }));
vi.mock('../src/components/Common/UnitRatePanel', () => ({ default: () => null }));

function nodes(node) {
  if (!React.isValidElement(node)) return [];
  return [node, ...React.Children.toArray(node.props.children).flatMap(nodes)];
}
const render = () => renderToStaticMarkup(<BandwidthCostPanel />);

beforeEach(() => {
  fixture.tab = 'trend';
  fixture.requested = true;
  fixture.effects = [];
  usePageRefresh.setState({ handler: null });
  fixture.store = {
    selectedTenantId: 'tenant-A', selectedSubscriptionIds: ['sub-A'], subscriptions: [],
    months: 3, dateKey: 'custom:2026-08-01:2026-09-14', dateMode: 'custom',
    fromDate: '2026-08-01', toDate: '2026-09-14', activeServices: [],
    loadCosts: vi.fn().mockResolvedValue(), loadServices: vi.fn().mockResolvedValue(),
    loadCostRows: vi.fn(), loadBandwidth: vi.fn().mockResolvedValue(),
    bandwidthData: { currency: 'USD', total_cost: 25, total_bytes: 1073741824, cost_per_gb: 25,
      months: [{ month: '2026-08', total_bytes: 1073741824, cost: 25 }], meters: [], by_subscription: [] },
  };
});

describe('bandwidth cost migration', () => {
  it('refreshes only month-comparison rows without loading other sections', async () => {
    fixture.tab = 'compare';
    CostExplorer();
    const cleanups = fixture.effects.map(effect => effect());
    await usePageRefresh.getState().handler();
    expect(fixture.store.loadCostRows).toHaveBeenCalledExactlyOnceWith({ force: true });
    expect(fixture.store.loadCosts).not.toHaveBeenCalled();
    expect(fixture.store.loadBandwidth).not.toHaveBeenCalled();
    expect(fixture.store.loadServices).not.toHaveBeenCalled();
    cleanups.forEach(cleanup => { if (typeof cleanup === 'function') cleanup(); });
    expect(usePageRefresh.getState().handler).toBeNull();
  });
  it('preserves recognized saved tabs and safely migrates invalid and legacy views', () => {
    for (const tab of ['trend', 'compare', 'groups', 'bandwidth']) expect(migrateExplorerView({ tab }).tab).toBe(tab);
    expect(migrateExplorerView({ tab: 'breakdown' }).tab).toBe('compare');
    expect(migrateExplorerView({ tab: 'invalid' }).tab).toBe('trend');
    expect(migrateExplorerView(null).tab).toBe('trend');
  });
  it('mounts the cost panel only for the URL bandwidth tab and avoids general cost queries there', () => {
    for (const tab of ['trend', 'groups', 'compare', 'bandwidth', 'invalid']) {
      fixture.tab = tab;
      fixture.effects = [];
      const root = CostExplorer();
      // The tab is a lazy chunk, so what the tree carries is the Suspense
      // boundary around it rather than the panel itself — the panel and the
      // volumes report only exist once that chunk has been fetched.
      const boundary = nodes(root).some(node => node.props?.fallback?.props?.what === 'the bandwidth report');
      expect(boundary).toBe(tab === 'bandwidth');
      expect(nodes(root).some(node => node.type === BandwidthCostPanel)).toBe(false);
      if (tab === 'bandwidth') {
        fixture.effects.forEach(effect => effect());
        expect(fixture.store.loadCosts).not.toHaveBeenCalled();
        expect(fixture.store.loadServices).not.toHaveBeenCalled();
        expect(fixture.store.loadCostRows).not.toHaveBeenCalled();
        expect(nodes(root).some(node => node.type === 'input')).toBe(false);
      }
    }
    expect(fixture.store.loadBandwidth).not.toHaveBeenCalled();
  });
  it('loads on panel mount and states header scope and unsupported local filters', () => {
    const html = render();
    fixture.effects.forEach(effect => effect());
    expect(fixture.store.loadBandwidth).toHaveBeenCalledOnce();
    for (const text of ['tenant-A', 'sub-A', '2026-08-01', '2026-09-14', 'filters do not apply', 'USD 25.00', '2026-08', 'Meter drill', 'Resource charge tracking']) expect(html).toContain(text);
  });
  it('keeps available money visible during refresh and offers a forced retry on errors', () => {
    fixture.store.bandwidthLoading = true;
    expect(render()).toContain('USD 25.00');
    fixture.store.bandwidthData = null;
    expect(render()).toContain('Loading bandwidth costs');
    expect(render()).not.toContain('USD 25.00');
    fixture.store.bandwidthError = 'Access denied';
    expect(render()).toContain('Access denied');
    expect(render()).not.toContain('USD 25.00');
    const retry = nodes(BandwidthCostPanel()).find(node => node.props.title === 'Could not load bandwidth costs');
    retry.props.onRetry();
    expect(fixture.store.loadBandwidth).toHaveBeenCalledWith({ force: true });
  });
  it('does not start monthly or inventory queries for the daily timeline or full comparison', () => {
    for (const tab of ['trend', 'compare']) {
      fixture.tab = tab;
      fixture.effects = [];
      CostExplorer();
      fixture.effects.forEach(effect => effect());
    }
    expect(fixture.store.loadCosts).not.toHaveBeenCalled();
    expect(fixture.store.loadServices).not.toHaveBeenCalled();
    expect(fixture.store.loadCostRows).not.toHaveBeenCalled();
  });
  it('reports partial data, preserves true zero, and never invents missing costs or currency', () => {
    fixture.store.bandwidthData.errors = [{ subscription_id: 'sub-B', error: 'Forbidden' }];
    expect(render()).toContain('Partial bandwidth costs');
    expect(render()).toContain('Forbidden');
    fixture.store.bandwidthData.total_cost = 0;
    expect(render()).toContain('USD 0.00');
    fixture.store.bandwidthData = { months: [], meters: [], total_cost: null, cost_per_gb: null };
    expect(render()).toContain('Currency unavailable');
    expect(render()).not.toContain('INR');
    expect(render()).not.toContain('USD 0.00');
    fixture.store.bandwidthData = null;
    expect(render()).toContain('Bandwidth costs unavailable');
  });
});
