/**
 * From a service name down to the machines under it.
 *
 * Two things are easy to get wrong here and both mislead in the same
 * direction, by making the list look more complete than it is. Merging two
 * resources that share a name across resource groups reports one machine
 * costing double; silently dropping the rows Cost Management returns without
 * a resource name reports a list that does not add up to the service total it
 * was opened from. Neither is allowed to happen quietly.
 */
import { describe, expect, it } from 'vitest';

import { resourceByKey, resourcesInService, summariseTimeline } from '../src/utils/boqResources';

const row = (over = {}) => ({
  month: '2026-07',
  cost: 100,
  quantity: 730,
  unit_of_measure: 'Hours',
  service: 'Virtual Machines',
  meter: 'D4s v5',
  resource_group: 'rg-prod',
  resource_name: 'vm-web-01',
  subscription_id: 'sub-a',
  region: 'centralindia',
  ...over,
});

describe('the machines under a service', () => {
  it('lists one entry per resource, dearest first', () => {
    const listing = resourcesInService([
      row({ resource_name: 'vm-web-01', cost: 100 }),
      row({ resource_name: 'vm-db-01', cost: 400 }),
      row({ resource_name: 'vm-web-01', cost: 50, month: '2026-08' }),
    ], 'Virtual Machines');
    expect(listing.resources.map(r => r.name)).toEqual(['vm-db-01', 'vm-web-01']);
    expect(listing.resources[1].total).toBe(150);
  });

  it('keeps two resources of the same name in different groups apart', () => {
    // Merging them would report one machine costing twice what any machine
    // costs, and clicking it would open a history for only one of the two.
    const listing = resourcesInService([
      row({ resource_group: 'rg-prod', cost: 100 }),
      row({ resource_group: 'rg-test', cost: 60 }),
    ], 'Virtual Machines');
    expect(listing.resources).toHaveLength(2);
    expect(listing.resources.map(r => r.total)).toEqual([100, 60]);
  });

  it('counts the rows with no resource name instead of dropping them', () => {
    const listing = resourcesInService([
      row({ cost: 300 }),
      row({ resource_name: '', cost: 90 }),
    ], 'Virtual Machines');
    expect(listing.total).toBe(390);
    expect(listing.named).toBe(300);
    expect(listing.unnamed).toBe(90);
    expect(listing.unnamedRows).toBe(1);
    // The listed rows must still add up to the named total exactly.
    expect(listing.resources.reduce((s, r) => s + r.total, 0)).toBe(listing.named);
  });

  it('ignores every other service', () => {
    const listing = resourcesInService([
      row({ cost: 100 }),
      row({ service: 'Storage', resource_name: 'disk-a', cost: 900 }),
    ], 'Virtual Machines');
    expect(listing.total).toBe(100);
    expect(listing.resources).toHaveLength(1);
  });

  it('matches the service name whatever its casing', () => {
    expect(resourcesInService([row()], 'virtual machines').total).toBe(100);
  });

  it('names the SKU the resource spent most of its money on', () => {
    const listing = resourcesInService([
      row({ meter: 'D4s v5', cost: 300 }),
      row({ meter: 'Premium SSD', cost: 40 }),
    ], 'Virtual Machines');
    expect(listing.resources[0].sku).toBe('D4s v5');
    expect(listing.resources[0].meters.map(m => m.name)).toEqual(['D4s v5', 'Premium SSD']);
  });

  it('adds quantities up per meter', () => {
    const listing = resourcesInService([
      row({ quantity: 730 }),
      row({ quantity: 720, month: '2026-08' }),
    ], 'Virtual Machines');
    expect(listing.resources[0].meters[0].quantity).toBe(1450);
    expect(listing.resources[0].meters[0].unit).toBe('Hours');
  });

  it('reports the months it was billed in, oldest first', () => {
    const listing = resourcesInService([
      row({ month: '2026-08', cost: 90 }),
      row({ month: '2026-06', cost: 80 }),
      row({ month: '2026-07', cost: 100 }),
    ], 'Virtual Machines');
    const r = listing.resources[0];
    expect(r.months.map(m => m.month)).toEqual(['2026-06', '2026-07', '2026-08']);
    expect(r.firstMonth).toBe('2026-06');
    expect(r.lastMonth).toBe('2026-08');
    expect(r.monthsBilled).toBe(3);
  });

  it('shares add up to the service', () => {
    const listing = resourcesInService([
      row({ resource_name: 'a', cost: 250 }),
      row({ resource_name: 'b', cost: 750 }),
    ], 'Virtual Machines');
    expect(listing.resources.map(r => r.share)).toEqual([75, 25]);
  });

  it('spots a resize from the meters it was billed on', () => {
    // The one structural change billing can prove without the Activity Log.
    const listing = resourcesInService([
      row({ month: '2026-06', meter: 'D4s v5', cost: 100 }),
      row({ month: '2026-07', meter: 'D8s v5', cost: 200 }),
    ], 'Virtual Machines');
    expect(listing.resources[0].skuChanges).toEqual([{
      month: '2026-07', from: 'D4s v5', to: 'D8s v5',
      costBefore: 100, costAfter: 200, delta: 100,
    }]);
  });

  it('does not call a second meter a resize', () => {
    // A VM that gained a disk is not a VM that changed size; the dominant
    // meter is still the same one.
    const listing = resourcesInService([
      row({ month: '2026-06', meter: 'D4s v5', cost: 100 }),
      row({ month: '2026-07', meter: 'D4s v5', cost: 100 }),
      row({ month: '2026-07', meter: 'Premium SSD', cost: 20 }),
    ], 'Virtual Machines');
    expect(listing.resources[0].skuChanges).toEqual([]);
  });

  it('returns nothing rather than an empty list for a service with no rows', () => {
    expect(resourcesInService([row()], 'Kubernetes')).toBeNull();
    expect(resourcesInService([], 'Virtual Machines')).toBeNull();
    expect(resourcesInService([row()], '')).toBeNull();
  });

  it('finds a resource again by the key the list handed out', () => {
    const listing = resourcesInService([row()], 'Virtual Machines');
    const key = listing.resources[0].key;
    expect(resourceByKey(listing, key).name).toBe('vm-web-01');
    expect(resourceByKey(listing, 'nothing')).toBeNull();
  });
});

describe('what the timeline knows about a resource', () => {
  it('says plainly when the resource was never scanned', () => {
    const s = summariseTimeline({ resource: null, notes: ['never scanned'] });
    expect(s.known).toBe(false);
    expect(s.notes).toEqual(['never scanned']);
  });

  it('carries the creation date together with how sure Azure is of it', () => {
    // An inexact date is a bound, not a birthday, and the flag is the only
    // thing standing between the two readings.
    const s = summariseTimeline({
      resource: { name: 'vm-web-01' },
      lifecycle: {
        created: { at: '2026-01-04T00:00:00Z', source: 'snapshot', exact: false },
        last_changed: { at: '2026-07-02T00:00:00Z', exact: true, by: 'anuj@x.com' },
        still_present: true,
      },
      events: [],
    });
    expect(s.created.exact).toBe(false);
    expect(s.lastChanged.by).toBe('anuj@x.com');
    expect(s.stillPresent).toBe(true);
  });

  it('keeps only the scans where something actually changed', () => {
    const s = summariseTimeline({
      resource: { name: 'vm' },
      events: [
        { kind: 'modified', at: '2026-07-02', changes: [{ field: 'size', from: 'D4', to: 'D8' }] },
        { kind: 'modified', at: '2026-07-01', changes: [] },
        { kind: 'first_seen', at: '2026-06-01', changes: [] },
      ],
    });
    expect(s.modifications).toHaveLength(1);
    expect(s.changeCount).toBe(1);
    expect(s.modifications[0].changes[0]).toEqual({ field: 'size', from: 'D4', to: 'D8' });
  });

  it('keeps Activity Log entries as candidates rather than as a culprit', () => {
    const s = summariseTimeline({
      resource: { name: 'vm' },
      events: [{
        kind: 'modified', at: '2026-07-02',
        changes: [{ field: 'size', from: 'D4', to: 'D8' }],
        activity: [{ caller: 'a@x.com' }, { caller: 'b@x.com' }],
      }],
    });
    expect(s.modifications[0].candidates).toHaveLength(2);
  });

  it('reports a deletion as a deletion', () => {
    const s = summariseTimeline({
      resource: { name: 'vm' },
      lifecycle: { still_present: false, deleted: { at: '2026-08-01', exact: true } },
      events: [{ kind: 'removed', at: '2026-08-02', changes: [] }],
    });
    expect(s.stillPresent).toBe(false);
    expect(s.deleted.at).toBe('2026-08-01');
    expect(s.removedAt).toBe('2026-08-02');
  });

  it('passes the notes through so an absence is never read as a fact', () => {
    const s = summariseTimeline({
      resource: { name: 'vm' },
      events: [],
      notes: ['The Azure Activity Log could not be read.'],
    });
    expect(s.notes).toHaveLength(1);
    expect(s.changeCount).toBe(0);
  });

  it('returns nothing at all when there is no response', () => {
    expect(summariseTimeline(null)).toBeNull();
  });
});
