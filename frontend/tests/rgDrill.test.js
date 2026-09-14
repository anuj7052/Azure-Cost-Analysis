import { describe, it, expect } from 'vitest';
import { groupsFromRows, groupsTotal, UNGROUPED } from '../src/utils/rgDrill';

const row = (over = {}) => ({
  month: '2026-07',
  cost: 100,
  service: 'Virtual Machines',
  resource_group: 'prod-rg',
  resource_name: 'vm-01',
  subscription_id: 'sub-a',
  region: 'eastus',
  ...over,
});

describe('totalling resource groups', () => {
  it('adds the rows of each group together', () => {
    const out = groupsFromRows([
      row({ resource_group: 'prod-rg', cost: 60 }),
      row({ resource_group: 'prod-rg', cost: 40 }),
      row({ resource_group: 'test-rg', cost: 10 }),
    ], {});
    expect(out.map((g) => [g.name, g.cost])).toEqual([['prod-rg', 100], ['test-rg', 10]]);
  });

  it('puts the most expensive group first', () => {
    const out = groupsFromRows([
      row({ resource_group: 'small', cost: 1 }),
      row({ resource_group: 'big', cost: 99 }),
    ], {});
    expect(out[0].name).toBe('big');
  });

  it('breaks a tie by name so the order does not wander between renders', () => {
    const out = groupsFromRows([
      row({ resource_group: 'bravo', cost: 50 }),
      row({ resource_group: 'alpha', cost: 50 }),
    ], {});
    expect(out.map((g) => g.name)).toEqual(['alpha', 'bravo']);
  });

  it('names the charges that belong to no group rather than dropping them', () => {
    const out = groupsFromRows([row({ resource_group: '', cost: 25 })], {});
    expect(out[0]).toMatchObject({ name: UNGROUPED, cost: 25 });
  });

  it('gives each group its share of the whole', () => {
    const out = groupsFromRows([
      row({ resource_group: 'a', cost: 75 }),
      row({ resource_group: 'b', cost: 25 }),
    ], {});
    expect(out[0].share).toBeCloseTo(0.75);
    expect(out[1].share).toBeCloseTo(0.25);
  });

  it('says nothing rather than zero for a share of no money', () => {
    const out = groupsFromRows([row({ cost: 0 })], {});
    expect(out[0].share).toBeNull();
  });

  it('records every subscription contributing to a group name', () => {
    // The same group name in two subscriptions is two groups, and a reader
    // must be able to tell before concluding their group costs double.
    const out = groupsFromRows([
      row({ resource_group: 'shared', subscription_id: 'sub-a' }),
      row({ resource_group: 'shared', subscription_id: 'sub-b' }),
    ], {});
    expect(out[0].subscriptions.sort()).toEqual(['sub-a', 'sub-b']);
  });

  it('treats a non-numeric cost as nothing', () => {
    const out = groupsFromRows([row({ cost: null }), row({ cost: 5 })], {});
    expect(out[0].cost).toBe(5);
  });

  it('survives being handed no rows', () => {
    expect(groupsFromRows(null, {})).toEqual([]);
  });
});

describe('the services inside a group', () => {
  it('lists them with the biggest first', () => {
    const out = groupsFromRows([
      row({ service: 'Storage', cost: 20 }),
      row({ service: 'Virtual Machines', cost: 80 }),
    ], {});
    expect(out[0].services.map((s) => s.name)).toEqual(['Virtual Machines', 'Storage']);
  });

  it('sums repeated meters of one service into a single line', () => {
    const out = groupsFromRows([
      row({ service: 'Storage', meter: 'read', cost: 20 }),
      row({ service: 'Storage', meter: 'write', cost: 30 }),
    ], {});
    expect(out[0].services).toHaveLength(1);
    expect(out[0].services[0].cost).toBe(50);
  });

  it('shares each service against its own group, not the whole estate', () => {
    const out = groupsFromRows([
      row({ resource_group: 'a', service: 'Storage', cost: 25 }),
      row({ resource_group: 'a', service: 'Virtual Machines', cost: 75 }),
      row({ resource_group: 'b', service: 'Storage', cost: 900 }),
    ], {});
    const a = out.find((g) => g.name === 'a');
    expect(a.services.find((s) => s.name === 'Storage').share).toBeCloseTo(0.25);
  });

  it('names a charge with no service rather than hiding it', () => {
    const out = groupsFromRows([row({ service: '', cost: 10 })], {});
    expect(out[0].services[0].name).toBe('Unattributed');
  });

  it('counts the services so the row can say so before being opened', () => {
    const out = groupsFromRows([
      row({ service: 'Storage' }),
      row({ service: 'Virtual Machines' }),
    ], {});
    expect(out[0].serviceCount).toBe(2);
  });
});

describe('honouring the page filters', () => {
  it('excludes rows the filter rejects', () => {
    const out = groupsFromRows([
      row({ resource_group: 'a', service: 'Storage', cost: 10 }),
      row({ resource_group: 'a', service: 'Virtual Machines', cost: 90 }),
    ], { service: 'Storage' });
    expect(out[0].cost).toBe(10);
  });

  it('drops a group entirely when nothing in it survives', () => {
    const out = groupsFromRows([
      row({ resource_group: 'a', subscription_id: 'sub-a' }),
      row({ resource_group: 'b', subscription_id: 'sub-b' }),
    ], { subscription: 'sub-a' });
    expect(out.map((g) => g.name)).toEqual(['a']);
  });

  it('crosses two filters at once, which a marginal split cannot', () => {
    const out = groupsFromRows([
      row({ resource_group: 'a', service: 'Storage', region: 'eastus', cost: 10 }),
      row({ resource_group: 'a', service: 'Storage', region: 'westus', cost: 90 }),
    ], { service: 'Storage', location: 'eastus' });
    expect(out[0].cost).toBe(10);
  });

  it('ignores months outside the chosen range', () => {
    const out = groupsFromRows([
      row({ month: '2026-01', cost: 999 }),
      row({ month: '2026-07', cost: 10 }),
    ], {}, { allowed: ['2026-07'] });
    expect(out[0].cost).toBe(10);
  });

  it('accepts every month when no range is given', () => {
    const out = groupsFromRows([row({ month: '2026-01', cost: 5 })], {});
    expect(out[0].cost).toBe(5);
  });
});

describe('the combined total', () => {
  it('adds the groups up', () => {
    expect(groupsTotal([{ cost: 10 }, { cost: 5 }])).toBe(15);
  });

  it('survives being handed nothing', () => {
    expect(groupsTotal(null)).toBe(0);
  });
});
