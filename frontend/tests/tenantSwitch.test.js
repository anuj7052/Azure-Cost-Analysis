import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Switching tenant must not leave the previous tenant's money on screen.
 *
 * The bug this pins was not a wrong number — every figure was correct for the
 * tenant it came from. It was a wrong *label*: switching tenant cleared the
 * subscription selection, every loader then returned early because nothing was
 * selected, and the old totals stayed under the new tenant's name. On a cost
 * page that is worse than an error, because it is believable.
 *
 * The store is imported for real rather than reimplemented here. A copy of the
 * reset logic would pass this file for ever while the app kept the bug.
 */

vi.mock('../src/api/client', () => ({
  fetchSubscriptions: vi.fn(async () => []),
  fetchCosts: vi.fn(async () => ({})),
  fetchRgCosts: vi.fn(async () => ({})),
  fetchDailyCosts: vi.fn(async () => ({})),
  fetchCostRows: vi.fn(async () => ({})),
  fetchBandwidth: vi.fn(async () => ({})),
  fetchPricing: vi.fn(async () => ({})),
  fetchOrphaned: vi.fn(async () => ({})),
  fetchCompute: vi.fn(async () => ({})),
  fetchActivity: vi.fn(async () => ({})),
  fetchPolicyStates: vi.fn(async () => ({})),
  fetchDefenderAssessments: vi.fn(async () => ({})),
  fetchAdvisor: vi.fn(async () => ({})),
  fetchAccessReview: vi.fn(async () => ({})),
  fetchRoleDefinitions: vi.fn(async () => ({})),
  fetchTenants: vi.fn(async () => []),
  fetchMe: vi.fn(async () => ({})),
  uploadCSV: vi.fn(),
  fetchBoqs: vi.fn(async () => []),
}));

const { useAppStore } = await import('../src/store/useAppStore');

const OLD_MONEY = { months: [{ month: '2026-07', total_cost: 999, currency: 'INR' }] };

beforeEach(() => {
  useAppStore.setState({
    imported: null,
    tenants: [],
    selectedTenantId: 'tenant-a',
    selectedSubscriptionIds: ['sub-1', 'sub-2'],
    costData: OLD_MONEY,
    costError: 'Cost Management Reader is missing',
    orphanedData: { resources: [{ id: 'x' }] },
    bandwidthData: { total_cost: 5 },
    computeData: { vms: [] },
    accessData: { principals: [] },
    postureError: 'Defender is not enabled',
  });
});

describe('switching tenant', () => {
  it('drops the previous tenant totals', async () => {
    await useAppStore.getState().setSelectedTenant('tenant-b');

    expect(useAppStore.getState().selectedTenantId).toBe('tenant-b');
    expect(useAppStore.getState().costData).toBeNull();
  });

  it('drops every other tenant-scoped dataset, not just the cost one', async () => {
    await useAppStore.getState().setSelectedTenant('tenant-b');

    const s = useAppStore.getState();
    expect(s.orphanedData).toBeNull();
    expect(s.bandwidthData).toBeNull();
    expect(s.computeData).toBeNull();
    expect(s.accessData).toBeNull();
  });

  it('drops errors raised against the tenant being left', async () => {
    // An error about the old tenant is not a fact about the new one, and
    // leaving it renders a red panel on a page that has asked Azure nothing.
    await useAppStore.getState().setSelectedTenant('tenant-b');

    expect(useAppStore.getState().costError).toBeNull();
    expect(useAppStore.getState().postureError).toBeNull();
  });

  it('clears the subscription selection, since ids do not cross tenants', async () => {
    await useAppStore.getState().setSelectedTenant('tenant-b');

    expect(useAppStore.getState().selectedSubscriptionIds).toEqual([]);
  });
});

describe('emptying the subscription selection', () => {
  it('drops the totals for the selection that was just cleared', () => {
    const { toggleSubscription } = useAppStore.getState();
    toggleSubscription('sub-1');
    // One left, so the loaders will run and replace the data themselves.
    expect(useAppStore.getState().costData).toBe(OLD_MONEY);

    toggleSubscription('sub-2');
    // None left: every loader returns early, so nothing would replace it.
    expect(useAppStore.getState().selectedSubscriptionIds).toEqual([]);
    expect(useAppStore.getState().costData).toBeNull();
  });

  it('clears the same way when the whole selection is set at once', () => {
    useAppStore.getState().setAllSubscriptions([]);

    expect(useAppStore.getState().costData).toBeNull();
  });
});

describe('subscription ids as part of a cache key', () => {
  it('keeps the selection sorted whichever order it was picked in', () => {
    // Every cache key is the JSON of a payload holding this array, so an
    // unsorted one turns a repeat question into a guaranteed miss and a
    // needless second round trip to Azure.
    useAppStore.setState({ selectedSubscriptionIds: [] });
    const { toggleSubscription } = useAppStore.getState();

    toggleSubscription('sub-b');
    toggleSubscription('sub-a');

    expect(useAppStore.getState().selectedSubscriptionIds).toEqual(['sub-a', 'sub-b']);
  });

  it('sorts a selection set in one go', () => {
    useAppStore.getState().setAllSubscriptions(['sub-c', 'sub-a', 'sub-b']);

    expect(useAppStore.getState().selectedSubscriptionIds).toEqual(['sub-a', 'sub-b', 'sub-c']);
  });
});
