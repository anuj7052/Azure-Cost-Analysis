import { describe, it, expect } from 'vitest';
import {
  MISSING, CERTAIN, LIKELY, severityLabel, severityTone, FALLBACK_TONE,
  methodLabel, methodHelp, flatten, sumCost, unpricedCount, groupTree,
  ruleOptions, severityOptions, filterItems, savings, evidenceRows,
  coverageNote, headline,
} from '../src/utils/orphaned';

const item = (over = {}) => ({
  id: '/subscriptions/s1/resourceGroups/rg-a/providers/Microsoft.Compute/disks/disk-1',
  name: 'disk-1',
  type: 'microsoft.compute/disks',
  resource_group: 'rg-a',
  subscription_id: 's1',
  location: 'eastus',
  detail: '128 GB · Premium_LRS',
  monthly_cost: 100,
  rule: 'unattached_disks',
  rule_title: 'Unattached managed disks',
  severity: CERTAIN,
  reason: 'A managed disk is billed whether or not a VM is using it.',
  method: 'inventory',
  evidence: { 'Size (GB)': 128, SKU: 'Premium_LRS' },
  age_days: null,
  ...over,
});

describe('naming the severity', () => {
  it('calls certain findings definite waste', () => {
    expect(severityLabel(CERTAIN)).toBe('Definite waste');
  });

  it('calls likely findings something needing review', () => {
    expect(severityLabel(LIKELY)).toBe('Review needed');
  });

  it('admits when it does not recognise one', () => {
    expect(severityLabel('made-up')).toBe('Unclassified');
    expect(severityLabel(undefined)).toBe('Unclassified');
  });

  it('gives the two severities different colours', () => {
    expect(severityTone(CERTAIN).chip).not.toBe(severityTone(LIKELY).chip);
  });

  it('falls back rather than crashing', () => {
    expect(severityTone('nope')).toBe(FALLBACK_TONE);
  });
});

describe('naming how a finding was proved', () => {
  it('distinguishes inventory from metrics', () => {
    // These are different strengths of claim and must never read alike.
    expect(methodLabel('inventory')).toBe('Inventory-based');
    expect(methodLabel('metrics')).toBe('Metrics-based');
  });

  it('does not invent a method when none was reported', () => {
    expect(methodLabel('')).toBe(MISSING);
    expect(methodLabel(undefined)).toBe(MISSING);
  });

  it('explains that inventory is a fact rather than an inference', () => {
    expect(methodHelp('inventory')).toContain('not a guess');
  });

  it('explains that metrics depend on the window', () => {
    expect(methodHelp('metrics')).toContain('window');
  });

  it('says nothing about an unknown method', () => {
    expect(methodHelp('other')).toBe('');
  });
});

describe('flattening the rule-grouped response', () => {
  const data = {
    categories: [
      { key: 'r1', title: 'Rule one', severity: CERTAIN, reason: 'because', items: [item()] },
      { key: 'r2', title: 'Rule two', severity: LIKELY, reason: 'maybe', items: [item({ id: 'b' })] },
    ],
  };

  it('returns every finding across every category', () => {
    expect(flatten(data)).toHaveLength(2);
  });

  it('carries the category down onto items that lack it', () => {
    const bare = { categories: [{ key: 'r9', title: 'Nine', severity: LIKELY, reason: 'why', items: [{ id: 'x' }] }] };
    const [only] = flatten(bare);
    expect(only.rule).toBe('r9');
    expect(only.rule_title).toBe('Nine');
    expect(only.severity).toBe(LIKELY);
    expect(only.reason).toBe('why');
  });

  it('prefers what the item already says over the category', () => {
    const [first] = flatten(data);
    expect(first.rule_title).toBe('Unattached managed disks');
  });

  it('handles nothing at all', () => {
    expect(flatten(null)).toEqual([]);
    expect(flatten({})).toEqual([]);
  });
});

describe('adding up money', () => {
  it('sums what is known', () => {
    expect(sumCost([item(), item({ monthly_cost: 50 })])).toBe(150);
  });

  it('skips unknowns rather than counting them as zero cost findings', () => {
    expect(sumCost([item(), item({ monthly_cost: null })])).toBe(100);
  });

  it('counts how many have no price', () => {
    expect(unpricedCount([item(), item({ monthly_cost: null }), item({ monthly_cost: undefined })])).toBe(2);
  });

  it('does not treat a genuine zero as missing', () => {
    expect(unpricedCount([item({ monthly_cost: 0 })])).toBe(0);
  });

  it('survives an empty list', () => {
    expect(sumCost([])).toBe(0);
    expect(sumCost(null)).toBe(0);
  });
});

describe('regrouping by who owns the bill', () => {
  const items = [
    item({ id: 'a', subscription_id: 's1', resource_group: 'rg-a', monthly_cost: 10 }),
    item({ id: 'b', subscription_id: 's1', resource_group: 'rg-b', monthly_cost: 50 }),
    item({ id: 'c', subscription_id: 's2', resource_group: 'rg-c', monthly_cost: 5 }),
  ];

  it('nests subscription then resource group then resource', () => {
    const tree = groupTree(items);
    expect(tree).toHaveLength(2);
    expect(tree[0].groups).toHaveLength(2);
    expect(tree[0].groups[0].items).toHaveLength(1);
  });

  it('puts the most expensive subscription first', () => {
    const tree = groupTree(items);
    expect(tree[0].key).toBe('s1');
    expect(tree[0].cost).toBe(60);
  });

  it('puts the most expensive resource group first', () => {
    const tree = groupTree(items);
    expect(tree[0].groups[0].key).toBe('rg-b');
  });

  it('rolls counts up as well as cost', () => {
    expect(groupTree(items)[0].count).toBe(2);
  });

  it('resolves the subscription name when it knows it', () => {
    const tree = groupTree(items, [{ subscription_id: 's1', display_name: 'Production' }]);
    expect(tree[0].name).toBe('Production');
  });

  it('matches the subscription id regardless of case', () => {
    const tree = groupTree(items, [{ subscription_id: 'S1', display_name: 'Production' }]);
    expect(tree[0].name).toBe('Production');
  });

  it('keeps the raw id rather than labelling it Unknown', () => {
    // "Unknown" reads like a bug. The guid at least lets somebody look it up.
    expect(groupTree(items)[0].name).toBe('s1');
  });

  it('marks a missing resource group honestly', () => {
    const tree = groupTree([item({ resource_group: '' })]);
    expect(tree[0].groups[0].name).toBe(MISSING);
  });

  it('sorts resources within a group by cost', () => {
    const tree = groupTree([
      item({ id: 'x', monthly_cost: 1 }),
      item({ id: 'y', monthly_cost: 9 }),
    ]);
    expect(tree[0].groups[0].items[0].id).toBe('y');
  });

  it('handles an empty list', () => {
    expect(groupTree([])).toEqual([]);
    expect(groupTree(null)).toEqual([]);
  });
});

describe('the filter options', () => {
  const items = [item(), item({ id: 'b' }), item({ id: 'c', rule: 'old_snapshots', rule_title: 'Old snapshots', severity: LIKELY })];

  it('counts each rule present', () => {
    const opts = ruleOptions(items);
    expect(opts[0]).toMatchObject({ key: 'unattached_disks', count: 2 });
  });

  it('puts the commonest rule first', () => {
    expect(ruleOptions(items)[0].count).toBe(2);
  });

  it('counts each severity present', () => {
    const opts = severityOptions(items);
    expect(opts.find(o => o.key === CERTAIN).count).toBe(2);
    expect(opts.find(o => o.key === LIKELY).count).toBe(1);
  });

  it('labels severities the way the page does', () => {
    expect(severityOptions(items)[0].label).toBe('Definite waste');
  });

  it('returns nothing for nothing', () => {
    expect(ruleOptions([])).toEqual([]);
    expect(severityOptions(null)).toEqual([]);
  });
});

describe('narrowing the findings', () => {
  const items = [
    item(),
    item({
      id: 'b',
      name: 'pip-unused-1',
      type: 'microsoft.network/publicipaddresses',
      rule: 'unassociated_public_ips',
      rule_title: 'Unassociated public IP addresses',
      detail: '20.1.2.3 · Standard',
      severity: LIKELY,
      monthly_cost: null,
    }),
  ];

  it('returns everything by default', () => {
    expect(filterItems(items)).toHaveLength(2);
  });

  it('filters by rule', () => {
    expect(filterItems(items, { rule: 'unattached_disks' })).toHaveLength(1);
  });

  it('filters by severity', () => {
    expect(filterItems(items, { severity: LIKELY })).toHaveLength(1);
  });

  it('searches the name', () => {
    expect(filterItems(items, { query: 'pip' })).toHaveLength(1);
  });

  it('searches the resource group and location too', () => {
    expect(filterItems(items, { query: 'eastus' })).toHaveLength(2);
  });

  it('ignores case', () => {
    expect(filterItems(items, { query: 'DISK-1' })).toHaveLength(1);
  });

  it('shows unpriced findings by default, because unpriced is not free', () => {
    expect(filterItems(items, {})).toHaveLength(2);
  });

  it('hides them only when asked', () => {
    expect(filterItems(items, { hideUnpriced: true })).toHaveLength(1);
  });

  it('keeps a genuine zero when hiding unpriced', () => {
    const zero = [item({ monthly_cost: 0 })];
    expect(filterItems(zero, { hideUnpriced: true })).toHaveLength(1);
  });

  it('combines filters', () => {
    expect(filterItems(items, { severity: CERTAIN, query: 'disk' })).toHaveLength(1);
    expect(filterItems(items, { severity: LIKELY, query: 'disk' })).toHaveLength(0);
  });
});

describe('what removing it saves', () => {
  it('reports the billed monthly figure', () => {
    expect(savings(item()).monthly).toBe(100);
  });

  it('projects the year as twelve times the month', () => {
    expect(savings(item()).annual).toBe(1200);
  });

  it('labels the annual figure a projection rather than a forecast', () => {
    expect(savings(item()).basis).toContain('not a forecast');
  });

  it('says the monthly figure is what was actually billed', () => {
    expect(savings(item()).basis).toContain('Actual amount billed');
  });

  it('returns nulls rather than zero when there is no price', () => {
    const out = savings(item({ monthly_cost: null }));
    expect(out.monthly).toBeNull();
    expect(out.annual).toBeNull();
  });

  it('explains that no price is not the same as free', () => {
    expect(savings(item({ monthly_cost: null })).basis).toContain('not the same as it being free');
  });

  it('keeps a genuine zero as a number', () => {
    expect(savings(item({ monthly_cost: 0 })).monthly).toBe(0);
  });

  it('handles a missing item', () => {
    expect(savings(null).monthly).toBeNull();
  });
});

describe('the evidence panel', () => {
  it('leads with how the finding was proved', () => {
    expect(evidenceRows(item())[0].label).toBe('Method');
    expect(evidenceRows(item())[0].value).toBe('Inventory-based');
  });

  it('includes the projected columns behind the finding', () => {
    const labels = evidenceRows(item()).map(r => r.label);
    expect(labels).toContain('Size (GB)');
    expect(labels).toContain('SKU');
  });

  it('names what it does not know instead of leaving it out', () => {
    // Omitting these silently lets the reader assume they were checked.
    const rows = evidenceRows(item());
    const orphanedSince = rows.find(r => r.label === 'Orphaned since');
    expect(orphanedSince.value).toBe(MISSING);
    expect(orphanedSince.hint).toContain('would be invented');
  });

  it('explains why the previous owner is unavailable', () => {
    const row = evidenceRows(item()).find(r => r.label === 'Previously attached to');
    expect(row.value).toBe(MISSING);
    expect(row.hint).toContain('absence of a link');
  });

  it('shows a resource age when one was computed', () => {
    const row = evidenceRows(item({ age_days: 115 })).find(r => r.label === 'Resource age');
    expect(row.value).toBe('115 days');
  });

  it('does not confuse resource age with orphan age', () => {
    const row = evidenceRows(item({ age_days: 115 })).find(r => r.label === 'Resource age');
    expect(row.hint).toContain('not how long it has been orphaned');
  });

  it('marks the age unavailable when the query did not compute one', () => {
    const row = evidenceRows(item()).find(r => r.label === 'Resource age');
    expect(row.value).toBe(MISSING);
  });

  it('survives an item with no evidence at all', () => {
    expect(evidenceRows({}).length).toBeGreaterThan(0);
    expect(evidenceRows(null).length).toBeGreaterThan(0);
  });
});

describe('saying what the totals cover', () => {
  it('confirms full coverage when everything is priced', () => {
    expect(coverageNote([item(), item()])).toContain('All 2 findings');
  });

  it('warns that the total understates when some are unpriced', () => {
    const note = coverageNote([item(), item({ monthly_cost: null })]);
    expect(note).toContain('1 of 2');
    expect(note).toContain('understate');
  });

  it('is blunt when nothing is priced', () => {
    const note = coverageNote([item({ monthly_cost: null })]);
    expect(note).toContain('read as zero');
    expect(note).toContain('still real');
  });

  it('says nothing when there is nothing', () => {
    expect(coverageNote([])).toBe('');
  });
});

describe('the headline', () => {
  it('separates definite waste from the rest', () => {
    const out = headline([item(), item({ severity: LIKELY })]);
    expect(out).toContain('2 findings');
    expect(out).toContain('1 attached to nothing at all');
  });

  it('says so when everything needs review', () => {
    expect(headline([item({ severity: LIKELY })])).toContain('all needing review');
  });

  it('handles nothing', () => {
    expect(headline([])).toBe('Nothing matched.');
    expect(headline(null)).toBe('Nothing matched.');
  });
});
