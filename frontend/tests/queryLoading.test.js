import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dedupeRequest, partialResponse } from '../src/utils/queryRequest';
import { useAppStore } from '../src/store/useAppStore';
import { fetchCosts, fetchDailyCosts, fetchCostRows, fetchBandwidth } from '../src/api/client';
import { readCache, writeCache } from '../src/utils/persistCache';

vi.mock('../src/api/client', () => ({
  fetchTenants: vi.fn(), fetchSubscriptions: vi.fn(), fetchCosts: vi.fn(), fetchCostRows: vi.fn(),
  fetchServices: vi.fn(), fetchRgCosts: vi.fn(), fetchDailyCosts: vi.fn(), fetchBandwidth: vi.fn(),
  fetchMe: vi.fn(), fetchOrphaned: vi.fn(), fetchPricing: vi.fn(), fetchCompute: vi.fn(),
  fetchActivity: vi.fn(), fetchPolicy: vi.fn(), fetchDefender: vi.fn(), fetchAdvisor: vi.fn(),
  fetchAccessReview: vi.fn(), fetchRoleAssignments: vi.fn(),
}));
vi.mock('../src/utils/persistCache', () => ({
  readCache: vi.fn(() => null), readPrefs: () => null, writeCache: vi.fn(), writePrefs: vi.fn(),
  evictApiCache: vi.fn(), rememberAccount: vi.fn(),
}));

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

beforeEach(() => {
  vi.clearAllMocks();
  readCache.mockReset().mockReturnValue(null);
  useAppStore.getState().cancelThrottledCostRetry();
  useAppStore.setState({ selectedTenantId: 't', selectedSubscriptionIds: ['s'],
    months: 3, dateMode: 'rolling', dateKey: 'rolling:3', imported: null,
    costData: null, dailyData: null, rowsData: null, bandwidthData: null,
    costReadKey: null, dailyReadKey: null, rowsReadKey: null, bandwidthReadKey: null,
  });
});

describe('request sharing and progressive loading', () => {
  it('shows matching secondary summaries immediately without issuing requests', () => {
    readCache.mockImplementation(key => key.startsWith('bandwidth:') ? { value: { total_cost: 30 } } : { value: { total: 90 } });
    useAppStore.getState().primeDashboardCache();
    expect(useAppStore.getState().bandwidthData.total_cost).toBe(30);
    expect(useAppStore.getState().pricingData.total).toBe(90);
    expect(fetchBandwidth).not.toHaveBeenCalled();
    expect(fetchCosts).not.toHaveBeenCalled();
    readCache.mockReturnValue(null);
    useAppStore.setState({ selectedSubscriptionIds: ['different'] });
    useAppStore.getState().primeDashboardCache();
    expect(useAppStore.getState().pricingData).toBeNull();
    expect(useAppStore.getState().bandwidthData).toBeNull();
  });
  it('shares daily requests between the store and timeline', async () => {
    const answer = deferred();
    fetchDailyCosts.mockReturnValueOnce(answer.promise);
    const payload = { tenant_id: 't', subscription_ids: ['s'], months: 3, resource_group: null, include_reservation_context: true };
    const storeRead = useAppStore.getState().loadDailyCosts();
    const componentRead = dedupeRequest(`daily:${JSON.stringify(payload)}`, () => fetchDailyCosts(payload));
    await Promise.resolve();
    expect(fetchDailyCosts).toHaveBeenCalledOnce();
    answer.resolve({ days: [], total: 0 });
    await Promise.all([storeRead, componentRead]);
    expect(useAppStore.getState().dailyLoading).toBe(false);
  });

  it.each([
    ['cost', 'loadCosts', fetchCosts], ['daily', 'loadDailyCosts', fetchDailyCosts],
    ['rows', 'loadCostRows', fetchCostRows], ['bandwidth', 'loadBandwidth', fetchBandwidth],
  ])('ignores late %s data after the selection changes', async (name, loader, api) => {
    const old = deferred();
    api.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ total: 22 });
    const first = useAppStore.getState()[loader]();
    await Promise.resolve();
    useAppStore.setState({ selectedSubscriptionIds: ['new'] });
    await useAppStore.getState()[loader]();
    expect(useAppStore.getState()[`${name}Data`]).toEqual({ total: 22 });
    old.resolve({ total: 11 });
    await first;
    expect(useAppStore.getState()[`${name}Data`]).toEqual({ total: 22 });
  });

  it('shows a partial answer without retrying permanent permission failures', async () => {
    const data = { rows: [], errors: [{ error: 'Forbidden', retryable: false }] };
    fetchCostRows.mockResolvedValueOnce(data);
    await useAppStore.getState().loadCostRows();
    expect(fetchCostRows).toHaveBeenCalledOnce();
    expect(useAppStore.getState().rowsData).toBe(data);
    expect(writeCache).toHaveBeenCalledWith(expect.any(String), data, { stale: true });
  });

  it('keeps bandwidth visible while the same selection is refreshed', async () => {
    fetchBandwidth.mockResolvedValueOnce({ total: 9 });
    await useAppStore.getState().loadBandwidth();
    const next = deferred();
    fetchBandwidth.mockReturnValueOnce(next.promise);
    const refresh = useAppStore.getState().loadBandwidth({ force: true });
    expect(useAppStore.getState().bandwidthData).toEqual({ total: 9 });
    next.resolve({ total: 10 });
    await refresh;
    expect(useAppStore.getState().bandwidthData).toEqual({ total: 10 });
  });
  it('BOQ and filtered Explorer detail honour exact custom dates without widening', async () => {
    useAppStore.setState({ dateMode: 'custom', fromDate: '2026-08-15', toDate: '2026-09-10', dateKey: 'custom' });
    fetchCostRows.mockResolvedValueOnce({ rows: [] });
    await useAppStore.getState().loadCostRows({ selectedRange: true });
    expect(fetchCostRows).toHaveBeenCalledWith(expect.objectContaining({ from_date: '2026-08-15', to_date: '2026-09-10', months: 3 }));
  });

  it('recognizes coverage-based partial results, not only top-level errors', () => {
    expect(partialResponse({ coverage: { partial: true } })).toBe(true);
    expect(partialResponse({ coverage: { errors: [{}] } })).toBe(true);
    expect(partialResponse({ coverage: { partial: false, errors: [] } })).toBe(false);
  });

  it('allows retry after a rejected or synchronously throwing request', async () => {
    await expect(dedupeRequest('failure', () => { throw new Error('offline'); })).rejects.toThrow('offline');
    await expect(dedupeRequest('failure', () => Promise.resolve(7))).resolves.toBe(7);
  });
});
