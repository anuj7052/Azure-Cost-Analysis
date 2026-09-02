/**
 * The cost view builder.
 *
 * The risk in a chart the reader configures is that it quietly stops adding
 * up. A top-N that drops the tail, a filter the daily data cannot honour, a
 * saved view naming a dimension that no longer exists -- each of them produces
 * a chart that looks fine and is wrong. Those are what these pin down.
 */
import { describe, expect, it } from 'vitest';

import {
  buildView, defaultView, describeView, filterOptions,
  normaliseView, removeView, saveView,
} from '../src/utils/costExplorer';

const row = (over = {}) => ({
  month: '2026-07',
  cost: 100,
  service: 'Virtual Machines',
  subscription_id: 'sub-a',
  resource_group: 'rg-prod',
  meter: 'D4s v5',
  region: 'centralindia',
  resource_name: 'vm-1',
  ...over,
});

const day = (date, by_service, total) => ({ date, by_service, total });

describe('building a monthly view', () => {
  it('groups by the chosen dimension and orders periods in time', () => {
    const built = buildView(
      { granularity: 'monthly', groupBy: 'service' },
      {
        rows: [
          row({ month: '2026-08', service: 'Storage', cost: 50 }),
          row({ month: '2026-07', service: 'Storage', cost: 30 }),
          row({ month: '2026-07', service: 'Virtual Machines', cost: 100 }),
        ],
      },
    );
    expect(built.points.map(p => p.period)).toEqual(['2026-07', '2026-08']);
    expect(built.keys).toEqual(['Virtual Machines', 'Storage']);
    expect(built.points[0]['Virtual Machines']).toBe(100);
    expect(built.total).toBe(180);
  });

  it('totals only, when asked for a total', () => {
    const built = buildView(
      { groupBy: 'none' },
      { rows: [row({ cost: 40 }), row({ service: 'Storage', cost: 60 })] },
    );
    expect(built.keys).toEqual(['Total']);
    expect(built.points[0].Total).toBe(100);
  });

  it('groups by resource group, meter and region as well', () => {
    const rows = [
      row({ resource_group: 'rg-a', meter: 'P10', region: 'westeurope', cost: 10 }),
      row({ resource_group: 'rg-b', meter: 'P30', region: 'centralindia', cost: 20 }),
    ];
    expect(buildView({ groupBy: 'resource_group' }, { rows }).keys).toEqual(['rg-b', 'rg-a']);
    expect(buildView({ groupBy: 'meter' }, { rows }).keys).toEqual(['P30', 'P10']);
    expect(buildView({ groupBy: 'region' }, { rows }).keys).toEqual(['centralindia', 'westeurope']);
  });

  it('names an empty dimension rather than dropping the money', () => {
    // A charge Azure did not attribute is still a charge. Silently omitting it
    // would leave the chart short of the total by an unexplained amount.
    const built = buildView(
      { groupBy: 'resource_group' },
      { rows: [row({ resource_group: '', cost: 70 })] },
    );
    expect(built.keys).toEqual(['Unattributed']);
    expect(built.total).toBe(70);
  });
});

describe('the top-N tail', () => {
  const many = Array.from({ length: 12 }, (_, i) =>
    row({ service: `svc-${i}`, cost: (12 - i) * 10 }));

  it('folds everything past the limit into Other instead of dropping it', () => {
    const built = buildView({ groupBy: 'service', topN: 3 }, { rows: many });
    expect(built.keys).toEqual(['svc-0', 'svc-1', 'svc-2', 'Other']);
    expect(built.truncated).toBe(9);
    // The whole point: the visible stack still sums to the real total.
    const drawn = built.keys.reduce((s, k) => s + built.points[0][k], 0);
    expect(drawn).toBeCloseTo(built.total, 2);
  });

  it('says nothing about a tail when there is none', () => {
    const built = buildView({ groupBy: 'service', topN: 25 }, { rows: many });
    expect(built.keys).not.toContain('Other');
    expect(built.truncated).toBe(0);
  });
});

describe('filters', () => {
  const rows = [
    row({ service: 'Virtual Machines', resource_group: 'rg-a', cost: 100 }),
    row({ service: 'Storage', resource_group: 'rg-a', cost: 40 }),
    row({ service: 'Storage', resource_group: 'rg-b', cost: 25 }),
  ];

  it('narrows the chart to the values chosen', () => {
    const built = buildView(
      { groupBy: 'service', filters: { resource_group: ['rg-a'] } },
      { rows },
    );
    expect(built.total).toBe(140);
  });

  it('requires every filter to match, not any of them', () => {
    const built = buildView(
      { groupBy: 'service', filters: { resource_group: ['rg-b'], service: ['Virtual Machines'] } },
      { rows },
    );
    expect(built.total).toBe(0);
  });

  it('offers filter values ranked by cost', () => {
    expect(filterOptions(rows, 'service')).toEqual([
      { value: 'Virtual Machines', cost: 100 },
      { value: 'Storage', cost: 65 },
    ]);
  });

  it('offers only values the other filters leave reachable', () => {
    // Offering rg-b under a Virtual Machines filter would be an invitation to
    // an empty chart.
    const options = filterOptions(rows, 'resource_group', { service: ['Virtual Machines'] });
    expect(options.map(o => o.value)).toEqual(['rg-a']);
  });

  it('does not narrow a dimension by its own filter', () => {
    // The list has to keep showing what else could be picked, or a chosen
    // value becomes the only one you can ever choose.
    const options = filterOptions(rows, 'service', { service: ['Storage'] });
    expect(options.map(o => o.value)).toEqual(['Virtual Machines', 'Storage']);
  });
});

describe('the daily grain', () => {
  const days = [
    day('2026-07-01', { 'Virtual Machines': 10, Storage: 5 }, 15),
    day('2026-07-02', { 'Virtual Machines': 12 }, 12),
  ];

  it('splits by service, which is the only split Azure gives a day', () => {
    const built = buildView({ granularity: 'daily', groupBy: 'service' }, { days });
    expect(built.keys).toEqual(['Virtual Machines', 'Storage']);
    expect(built.total).toBe(27);
  });

  it('refuses a dimension the daily data does not carry, and says why', () => {
    // Drawing this from the service split would report a resource-group chart
    // that is not grouped by resource group.
    const built = buildView({ granularity: 'daily', groupBy: 'resource_group' }, { days });
    expect(built.points).toEqual([]);
    expect(built.note).toMatch(/service only/i);
  });

  it('says plainly when there is no daily data at all', () => {
    const built = buildView({ granularity: 'daily' }, { days: [] });
    expect(built.note).toMatch(/no daily cost data/i);
  });
});

describe('saved views', () => {
  it('repairs a view naming something that no longer exists', () => {
    // A saved view outlives the code that wrote it; it must degrade to
    // something that renders rather than take the page down on load.
    const v = normaliseView({ granularity: 'hourly', chart: 'pie', groupBy: 'nonsense', topN: 900 });
    expect(v.granularity).toBe('monthly');
    expect(v.chart).toBe('area');
    expect(v.groupBy).toBe('service');
    expect(v.topN).toBe(25);
  });

  it('drops filters on dimensions that no longer exist', () => {
    const v = normaliseView({ filters: { service: ['Storage'], gone: ['x'], empty: [] } });
    expect(v.filters).toEqual({ service: ['Storage'] });
  });

  it('survives being handed nothing at all', () => {
    expect(normaliseView(null)).toEqual(defaultView());
    expect(normaliseView('nonsense')).toEqual(defaultView());
  });

  it('replaces a view of the same name rather than duplicating it', () => {
    const first = saveView([], { name: 'Prod storage', groupBy: 'service' });
    const second = saveView(first, { name: 'Prod storage', groupBy: 'meter' });
    expect(second).toHaveLength(1);
    expect(second[0].groupBy).toBe('meter');
  });

  it('refuses to save a view with no name', () => {
    expect(saveView([], { name: '   ' })).toEqual([]);
  });

  it('removes by id', () => {
    const saved = saveView([], { name: 'One' });
    expect(removeView(saved, saved[0].id)).toEqual([]);
    expect(removeView(saved, 'other')).toHaveLength(1);
  });

  it('describes what a view shows, filters included', () => {
    expect(describeView({ granularity: 'daily', groupBy: 'service' }))
      .toBe('daily, by service');
    expect(describeView({ groupBy: 'none' })).toBe('monthly total');
    expect(describeView({ groupBy: 'meter', filters: { service: ['Storage'] } }))
      .toBe('monthly, by meter — Service is Storage');
  });
});
