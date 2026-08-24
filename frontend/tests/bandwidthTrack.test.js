import { describe, it, expect } from 'vitest';
import { resourcesForMeter } from '../src/hooks/useBandwidthTraffic';

/**
 * Attributing one meter to the resources that were billed for it.
 *
 * The rule that matters: a row shows only that meter's share of the resource's
 * cost. A VM charged for three meters must never appear, in the view of one
 * meter, to have spent all of it there — that would overstate the cause by
 * however many other meters it happens to carry.
 */

const row = (name, meters, extra = {}) => ({
  key: name,
  name,
  kind: 'Virtual machine',
  resource_group: 'rg-web',
  region: 'centralindia',
  is_resource: true,
  cost: meters.reduce((s, m) => s + m.cost, 0),
  meters,
  ...extra,
});

const meter = (name, cost, gb) => ({
  meter: name,
  category: 'Bandwidth',
  unit: '1 GB',
  quantity: gb,
  gb,
  cost,
  unit_rate: gb ? cost / gb : null,
});

describe('resourcesForMeter', () => {
  it('returns only the resources billed for that meter', () => {
    const data = {
      rows: [
        row('web01', [meter('Standard Data Transfer Out', 900, 90)]),
        row('db01', [meter('Analytics Logs Data Ingestion', 112, 0.42)]),
      ],
    };
    const rows = resourcesForMeter(data, 'Standard Data Transfer Out');
    expect(rows.map((r) => r.name)).toEqual(['web01']);
  });

  it('reports the meter share, not the resource total', () => {
    const data = {
      rows: [
        row('web01', [
          meter('Standard Data Transfer Out', 900, 90),
          meter('Intra Continent Data Transfer Out', 3000, 300),
        ]),
      ],
    };
    const [only] = resourcesForMeter(data, 'Standard Data Transfer Out');
    expect(only.cost).toBe(900);
    expect(only.gb).toBe(90);
  });

  it('carries the resource group and service name through', () => {
    const data = { rows: [row('web01', [meter('Standard Data Transfer Out', 900, 90)])] };
    const [only] = resourcesForMeter(data, 'Standard Data Transfer Out');
    expect(only.resource_group).toBe('rg-web');
    expect(only.kind).toBe('Virtual machine');
  });

  it('sorts the biggest spender first', () => {
    const data = {
      rows: [
        row('small', [meter('Standard Data Transfer Out', 10, 1)]),
        row('large', [meter('Standard Data Transfer Out', 900, 90)]),
      ],
    };
    expect(resourcesForMeter(data, 'Standard Data Transfer Out').map((r) => r.name))
      .toEqual(['large', 'small']);
  });

  it('matches meter names irrespective of case and padding', () => {
    const data = { rows: [row('web01', [meter('  Standard Data Transfer Out ', 900, 90)])] };
    expect(resourcesForMeter(data, 'standard data transfer out')).toHaveLength(1);
  });

  it('does not match a meter whose name merely contains the query', () => {
    /** "Data Transfer In" must not be swept up by a search for "Data Transfer". */
    const data = { rows: [row('web01', [meter('Standard Data Transfer In', 5, 1)])] };
    expect(resourcesForMeter(data, 'Standard Data Transfer')).toEqual([]);
  });

  it('keeps a cost with no volume rather than dropping the row', () => {
    /** Hourly gateway meters cost money and move no measured bytes. */
    const data = { rows: [row('gw', [meter('Gateway hours', 800, 0)])] };
    const [only] = resourcesForMeter(data, 'Gateway hours');
    expect(only.cost).toBe(800);
    expect(only.gb).toBe(0);
    expect(only.unit_rate).toBeNull();
  });

  it('is safe before the data has loaded', () => {
    expect(resourcesForMeter(null, 'Standard Data Transfer Out')).toEqual([]);
    expect(resourcesForMeter({ rows: [] }, 'Standard Data Transfer Out')).toEqual([]);
    expect(resourcesForMeter({ rows: [] }, undefined)).toEqual([]);
  });
});
