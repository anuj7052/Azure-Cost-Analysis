/**
 * Regrouping the BOQ comparison.
 *
 * The danger with a second view of the same money is that it quietly disagrees
 * with the first. A user who sees "Not in your BOQ: ₹40K" at the top of the
 * page and then adds up ₹52K of unbudgeted charges in the breakdown below has
 * no way to know which number to believe, and will reasonably stop believing
 * both. Most of what follows exists to pin the two together.
 */
import { describe, expect, it } from 'vitest';

import { compareBoqToUsage } from '../src/utils/boqCompare';
import {
  DIMENSIONS, breakdownCsv, filterAttributions, groupAttributions, optionsFor,
} from '../src/utils/boqBreakdown';

const boq = (items, extra = {}) => ({
  name: 'Estimate',
  file_name: 'estimate.csv',
  currency: 'INR',
  items,
  ...extra,
});

const item = (over = {}) => ({
  service_category: 'Storage',
  service_type: 'Managed Disks',
  custom_name: '',
  region: 'East US',
  description: 'Premium SSD, LRS Redundancy, P20 Disk Type 1 Disks',
  monthly_cost: 1000,
  ...over,
});

const row = (over = {}) => ({
  month: '2026-07',
  cost: 1000,
  quantity: 1,
  unit_of_measure: '1/Month',
  service: 'Storage',
  meter: 'P20 LRS Disk',
  resource_group: 'rg-prod',
  resource_name: 'disk-a',
  subscription_id: 'sub-1',
  region: 'eastus',
  ...over,
});

describe('attribution', () => {
  it('gives every usage row a verdict', () => {
    const report = compareBoqToUsage([boq([item()])], [row(), row({ resource_name: 'disk-b' })], 1);
    expect(report.attributions).toHaveLength(2);
    for (const a of report.attributions) {
      expect(['line', 'pooled', 'none']).toContain(a.coverage);
    }
  });

  it('marks a charge no estimate line claims as not in the BOQ', () => {
    const report = compareBoqToUsage(
      [boq([item()])],
      [row({ service: 'Azure DNS', meter: 'Zone', resource_name: 'dns-a', cost: 500 })],
      1,
    );
    const dns = report.attributions.find(a => a.service === 'Azure DNS');
    expect(dns.coverage).toBe('none');
  });

  it('names the estimate line that claimed a matched charge', () => {
    const report = compareBoqToUsage(
      [boq([item({ custom_name: 'Primary data disk' })])],
      [row()],
      1,
    );
    const matched = report.attributions.find(a => a.coverage === 'line');
    expect(matched.boqLine).toBe('Primary data disk');
  });

  it('averages over the period so it matches the monthly estimate', () => {
    // Two months of the same charge is one month of spend, not two.
    const report = compareBoqToUsage(
      [boq([item()])],
      [row({ month: '2026-06' }), row({ month: '2026-07' })],
      2,
    );
    const total = report.attributions.reduce((s, a) => s + a.monthlyCost, 0);
    expect(total).toBeCloseTo(1000, 2);
  });

  it('treats leftovers as covered when the category has a budget that cannot be split', () => {
    // A backup policy is real budgeted money that names no SKU, so charges it
    // pays for must not be reported as unbudgeted.
    const report = compareBoqToUsage(
      [boq([item({ service_category: 'Backup', service_type: 'Azure Backup', description: 'Backup policy', monthly_cost: 800 })])],
      [row({ service: 'Backup', meter: 'Protected Instances', resource_name: 'vault-a' })],
      1,
    );
    expect(report.attributions[0].coverage).toBe('pooled');
    expect(report.notInBoqTotal).toBe(0);
  });
});

describe('agreement with the headline figures', () => {
  const report = compareBoqToUsage(
    [boq([item()])],
    [
      row(),
      row({ resource_name: 'disk-b', resource_group: 'rg-dev' }),
      row({ service: 'Azure DNS', meter: 'Zone', resource_name: 'dns-a', resource_group: 'rg-dev', cost: 300 }),
      row({ service: 'Bandwidth', meter: 'Data Transfer Out', resource_name: '', resource_group: '', cost: 200 }),
    ],
    1,
  );

  it('sums to the same actual spend as the report header', () => {
    const grouped = groupAttributions(report.attributions, 'resource_group');
    expect(grouped.total).toBeCloseTo(report.actualTotal, 2);
  });

  it('reaches the same actual total whichever way it is grouped', () => {
    const totals = DIMENSIONS.map(d => groupAttributions(report.attributions, d.key).total);
    for (const t of totals) expect(t).toBeCloseTo(totals[0], 2);
  });

  it('sums to the same not-in-BOQ figure as the report header', () => {
    const grouped = groupAttributions(report.attributions, 'service');
    expect(grouped.notInBoqTotal).toBeCloseTo(report.notInBoqTotal, 2);
  });

  it('splits each group into matched, pooled and unbudgeted with nothing lost', () => {
    const grouped = groupAttributions(report.attributions, 'resource_group');
    for (const g of grouped.groups) {
      expect(g.matched + g.pooled + g.notInBoq).toBeCloseTo(g.actual, 2);
    }
  });
});

describe('grouping', () => {
  const report = compareBoqToUsage(
    [boq([item()])],
    [
      row({ resource_group: 'rg-prod', cost: 600 }),
      row({ resource_group: 'rg-prod', resource_name: 'disk-b', cost: 400 }),
      row({ resource_group: 'rg-dev', resource_name: 'disk-c', cost: 200 }),
    ],
    1,
  );

  it('rolls charges up by resource group, largest first', () => {
    const grouped = groupAttributions(report.attributions, 'resource_group');
    expect(grouped.groups.map(g => g.label)).toEqual(['rg-prod', 'rg-dev']);
    expect(grouped.groups[0].actual).toBe(1000);
  });

  it('shares add up to a hundred percent of what is on screen', () => {
    const grouped = groupAttributions(report.attributions, 'resource_group');
    const sum = grouped.groups.reduce((s, g) => s + g.share, 0);
    expect(sum).toBeCloseTo(100, 1);
  });

  it('labels a missing resource group rather than dropping the charge', () => {
    const orphan = compareBoqToUsage([boq([item()])], [row({ resource_group: '' })], 1);
    const grouped = groupAttributions(orphan.attributions, 'resource_group');
    expect(grouped.groups[0].label).toBe('(none)');
    expect(grouped.total).toBeCloseTo(orphan.actualTotal, 2);
  });

  it('claims a budget only for the category dimension', () => {
    // An Azure estimate has no resource group in it. A budget column here would
    // be a number this app invented, so there must not be one.
    const budgets = new Map([['Storage & Managed Disks', 1000]]);
    expect(groupAttributions(report.attributions, 'category', budgets).dimension.budgeted).toBe(true);
    for (const key of ['resource_group', 'service', 'region', 'subscription_id', 'resource_name', 'meter']) {
      const grouped = groupAttributions(report.attributions, key, budgets);
      expect(grouped.dimension.budgeted).toBeFalsy();
      for (const g of grouped.groups) expect(g.budgeted).toBeNull();
    }
  });

  it('carries a real variance through on the category dimension', () => {
    const budgets = new Map([['Storage & Managed Disks', 800]]);
    const grouped = groupAttributions(report.attributions, 'category', budgets);
    const storage = grouped.groups.find(g => g.label === 'Storage & Managed Disks');
    expect(storage.budgeted).toBe(800);
    expect(storage.variance).toBeCloseTo(storage.actual - 800, 2);
  });

  it('falls back to the first dimension rather than throwing on an unknown one', () => {
    expect(groupAttributions(report.attributions, 'nonsense').dimension.key).toBe('category');
  });
});

describe('filters', () => {
  const report = compareBoqToUsage(
    [boq([item()])],
    [
      row({ resource_group: 'rg-prod', region: 'eastus' }),
      row({ resource_group: 'rg-dev', resource_name: 'disk-b', region: 'westus' }),
      row({ service: 'Azure DNS', meter: 'Zone', resource_name: 'dns-a', resource_group: 'rg-dev', cost: 300 }),
    ],
    1,
  );
  const all = report.attributions;

  it('narrows to the selected resource groups', () => {
    const out = filterAttributions(all, { resourceGroups: new Set(['rg-dev']) });
    expect(out).toHaveLength(2);
    expect(out.every(r => r.resource_group === 'rg-dev')).toBe(true);
  });

  it('intersects filters rather than adding them together', () => {
    const out = filterAttributions(all, {
      resourceGroups: new Set(['rg-dev']),
      services: new Set(['Azure DNS']),
    });
    expect(out).toHaveLength(1);
    expect(out[0].resource_name).toBe('dns-a');
  });

  it('an empty selection means no filter, not no results', () => {
    expect(filterAttributions(all, { resourceGroups: new Set() })).toHaveLength(all.length);
  });

  it('isolates spend with no budget line behind it', () => {
    const out = filterAttributions(all, { coverage: 'none' });
    expect(out.every(r => r.coverage === 'none')).toBe(true);
    expect(out.some(r => r.service === 'Azure DNS')).toBe(true);
  });

  it('searches across resource, group, service and meter', () => {
    expect(filterAttributions(all, { search: 'dns-a' })).toHaveLength(1);
    expect(filterAttributions(all, { search: 'DNS' })).toHaveLength(1);
    expect(filterAttributions(all, { search: 'rg-prod' })).toHaveLength(1);
    expect(filterAttributions(all, { search: 'nothing here' })).toHaveLength(0);
  });

  it('ignores case and stray whitespace in the search box', () => {
    expect(filterAttributions(all, { search: '  P20 lrs  ' })).toHaveLength(2);
  });

  it('offers every distinct value as an option, blanks included', () => {
    const blank = compareBoqToUsage([boq([item()])], [row({ region: '' })], 1);
    expect(optionsFor(blank.attributions, 'region')).toEqual(['(none)']);
    expect(optionsFor(all, 'resource_group')).toEqual(['rg-dev', 'rg-prod']);
  });

  it('returns nothing for a dimension that does not exist', () => {
    expect(optionsFor(all, 'nonsense')).toEqual([]);
  });
});

describe('csv export', () => {
  const report = compareBoqToUsage([boq([item()])], [row({ resource_group: 'rg, prod' })], 1);

  it('quotes a group name containing a comma', () => {
    // Resource group names are user-chosen. Unquoted, every following column
    // shifts by one and the file reads as plausible nonsense.
    const csv = breakdownCsv(groupAttributions(report.attributions, 'resource_group'), 'INR');
    expect(csv).toContain('"rg, prod"');
  });

  it('names the grouping column after the dimension in view', () => {
    const csv = breakdownCsv(groupAttributions(report.attributions, 'service'), 'INR');
    expect(csv.split('\n')[0].startsWith('Service,')).toBe(true);
  });
});
