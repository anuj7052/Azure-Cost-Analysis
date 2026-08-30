/**
 * How a diff is shaped for the change-tracking page.
 *
 * There is no DOM in this setup, so these test the decisions rather than the
 * markup: how a resource is grouped, what counts as a property, and what a
 * deleted resource's settings look like. Those are the parts that would
 * misreport somebody's estate if they were wrong; the table markup would not.
 */
import { describe, it, expect } from 'vitest';
import {
  GROUPINGS, UNASSIGNED, toEntries, groupBy, flattenBag, readable,
  toPropertyTree, countLeaves,
} from '../src/utils/changeTree';

const diff = {
  added: [{ resource_id: '/a', name: 'a', subscription_id: 's1', resource_group: 'rg1' }],
  removed: [{ resource_id: '/b', name: 'b', subscription_id: 's1', resource_group: 'rg2' }],
  modified: [{ resource_id: '/c', name: 'c', subscription_id: 's2', resource_group: 'rg1' }],
};

describe('flattening a diff', () => {
  it('tags every entry with the bucket it came from', () => {
    const entries = toEntries(diff);
    expect(entries.map(e => e.kind)).toEqual(['added', 'removed', 'modified']);
  });

  it('returns nothing for a missing response rather than throwing', () => {
    expect(toEntries(null)).toEqual([]);
    expect(toEntries({})).toEqual([]);
  });
});

describe('grouping', () => {
  it('counts each kind separately within a group', () => {
    const rows = groupBy(toEntries(diff), 'subscription_id');
    const s1 = rows.find(r => r.key === 's1');
    expect(s1.added).toBe(1);
    expect(s1.removed).toBe(1);
    expect(s1.modified).toBe(0);
    expect(s1.total).toBe(2);
  });

  it('puts the busiest group first, not the alphabetically first', () => {
    // The reason to group at all is to find where the activity was.
    const rows = groupBy(toEntries(diff), 'subscription_id');
    expect(rows[0].key).toBe('s1');
  });

  it('breaks ties by name so the order is stable between loads', () => {
    const entries = [
      { resource_id: '/1', kind: 'added', location: 'westus' },
      { resource_id: '/2', kind: 'added', location: 'eastus' },
    ];
    expect(groupBy(entries, 'location').map(r => r.key)).toEqual(['eastus', 'westus']);
  });

  it('names a resource with no value instead of dropping it', () => {
    const rows = groupBy([{ resource_id: '/1', kind: 'added', resource_group: '' }], 'resource_group');
    expect(rows[0].key).toBe(UNASSIGNED);
  });

  it('keeps the entries so the next column can be built from them', () => {
    const rows = groupBy(toEntries(diff), 'subscription_id');
    const nested = groupBy(rows.find(r => r.key === 's1').items, 'resource_group');
    expect(nested.map(r => r.key).sort()).toEqual(['rg1', 'rg2']);
  });

  it('offers exactly one grouping that needs a third column', () => {
    const withSecondary = GROUPINGS.filter(g => g.secondary);
    expect(withSecondary.map(g => g.key).sort()).toEqual(['location_rg', 'subscription']);
  });
});

describe('reading a value for a table cell', () => {
  it('writes booleans as words, not Python or JS capitals', () => {
    expect(readable(true)).toBe('true');
    expect(readable(false)).toBe('false');
  });

  it('treats absent as empty rather than as the text "null"', () => {
    expect(readable(null)).toBe('');
    expect(readable(undefined)).toBe('');
  });

  it('keeps a zero, which is a real value', () => {
    expect(readable(0)).toBe('0');
  });

  it('serialises a list rather than printing [object Object]', () => {
    expect(readable([1, 2])).toBe('[1,2]');
  });
});

describe('describing a resource that was added or deleted outright', () => {
  it('lists nested settings by their full path', () => {
    const rows = flattenBag({ networkAcls: { defaultAction: 'Deny' } });
    expect(rows).toEqual([{ field: 'networkAcls.defaultAction', value: 'Deny' }]);
  });

  it('keeps a list whole rather than numbering its elements', () => {
    // Azure reorders lists freely, so indices imply a stability that is absent.
    const rows = flattenBag({ rules: ['a', 'b'] });
    expect(rows).toEqual([{ field: 'rules', value: '["a","b"]' }]);
  });

  it('still reports a setting that was an empty object', () => {
    // It existed, and a deleted resource's inventory should say so.
    expect(flattenBag({ backupPolicy: {} })).toEqual([
      { field: 'backupPolicy', value: '{}' },
    ]);
  });

  it('returns nothing when no configuration was captured', () => {
    expect(flattenBag(null)).toEqual([]);
    expect(flattenBag(undefined)).toEqual([]);
  });

  it('sorts keys so two captures of the same shape read the same way', () => {
    expect(flattenBag({ b: 1, a: 2 }).map(r => r.field)).toEqual(['a', 'b']);
  });

  it('stops descending before an absurdly deep bag can hang the page', () => {
    let deep = { end: 1 };
    for (let i = 0; i < 20; i += 1) deep = { level: deep };
    expect(flattenBag(deep).length).toBeGreaterThan(0);
  });
});

describe('nesting property paths', () => {
  it('keeps a dotless field at the top, where people look first', () => {
    const tree = toPropertyTree([{ field: 'location', from: 'a', to: 'b' }]);
    expect(tree.leaves).toHaveLength(1);
    expect(tree.children.size).toBe(0);
  });

  it('files a dotted path under a parent', () => {
    const tree = toPropertyTree([{ field: 'networkAcls.defaultAction' }]);
    expect(tree.leaves).toHaveLength(0);
    expect(tree.children.get('networkAcls').leaves[0].leaf).toBe('defaultAction');
  });

  it('gathers siblings under one parent rather than repeating it', () => {
    const tree = toPropertyTree([
      { field: 'acls.a' }, { field: 'acls.b' },
    ]);
    expect(tree.children.size).toBe(1);
    expect(tree.children.get('acls').leaves).toHaveLength(2);
  });

  it('nests more than one level deep', () => {
    const tree = toPropertyTree([{ field: 'a.b.c' }]);
    expect(tree.children.get('a').children.get('b').leaves[0].leaf).toBe('c');
  });

  it('counts every leaf beneath a parent, so its badge is the real total', () => {
    const tree = toPropertyTree([
      { field: 'a.b.c' }, { field: 'a.d' }, { field: 'top' },
    ]);
    expect(countLeaves(tree.children.get('a'))).toBe(2);
    expect(countLeaves(tree)).toBe(3);
  });

  it('handles an empty change list without inventing a node', () => {
    const tree = toPropertyTree([]);
    expect(countLeaves(tree)).toBe(0);
    expect(toPropertyTree(undefined).children.size).toBe(0);
  });
});
