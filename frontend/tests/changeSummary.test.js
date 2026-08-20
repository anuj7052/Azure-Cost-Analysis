/**
 * Plain-English change descriptions.
 *
 * A raw field diff is precise and unreadable, so these sentences are what most
 * people actually consume. The risk is overstating what a snapshot diff knows —
 * particularly claiming a resource was "deleted" when the data cannot tell
 * deletion apart from lost access.
 */
import { describe, expect, it } from 'vitest';

import {
  describeFieldChange,
  describeTagChange,
  shortType,
  summariseChange,
} from '../src/utils/changeSummary';

describe('shortType', () => {
  it('turns an Azure type id into something readable and singular', () => {
    expect(shortType('microsoft.compute/virtualmachines')).toBe('virtualmachine');
    expect(shortType('Microsoft.Compute/virtualMachines')).toBe('virtual machine');
  });

  it('does not mangle plurals into non-words', () => {
    // A naive trailing-s strip gives "addresse" and "policie", which read as
    // typos and undermine the sentence they appear in.
    expect(shortType('Microsoft.Network/publicIPAddresses')).toBe('public ipaddress');
    expect(shortType('Microsoft.Authorization/policies')).toBe('policy');
  });

  it('falls back to a generic noun rather than an empty sentence', () => {
    expect(shortType('')).toBe('resource');
    expect(shortType(null)).toBe('resource');
  });
});

describe('describeFieldChange', () => {
  it('says what a size change means', () => {
    expect(describeFieldChange({ field: 'sku', from: 'D2s v3', to: 'D4s v3' }))
      .toBe('Resized from D2s v3 to D4s v3');
  });

  it('says what a region change means', () => {
    expect(describeFieldChange({ field: 'location', from: 'eastus', to: 'westeurope' }))
      .toBe('Moved region from eastus to westeurope');
  });

  it('marks an empty value rather than printing nothing', () => {
    // "Renamed from  to vm-01" reads as a rendering bug.
    expect(describeFieldChange({ field: 'name', from: '', to: 'vm-01' }))
      .toContain('(empty)');
  });

  it('falls back to the field label for anything unrecognised', () => {
    expect(describeFieldChange({ field: 'odd', label: 'Odd thing', from: 'a', to: 'b' }))
      .toBe('Odd thing changed from a to b');
  });
});

describe('describeTagChange', () => {
  it('names the tags rather than saying "tags changed"', () => {
    const text = describeTagChange({
      added: { team: 'platform' },
      removed: { owner: 'anna' },
      changed: { env: { from: 'dev', to: 'prod' } },
    });

    expect(text).toContain('added team');
    expect(text).toContain('removed owner');
    expect(text).toContain('updated env');
  });

  it('degrades to a generic sentence when there is no detail', () => {
    expect(describeTagChange(null)).toBe('Tags changed');
  });
});

describe('summariseChange', () => {
  it('describes a new resource with where it appeared', () => {
    const text = summariseChange(
      { type: 'microsoft.compute/virtualmachines', resource_group: 'rg-prod', location: 'eastus' },
      'added',
    );

    expect(text).toContain('rg-prod');
    expect(text).toContain('eastus');
  });

  it('does not claim a removed resource was deleted', () => {
    // A snapshot diff cannot tell deletion apart from a resource moving out of
    // scope or the credential losing access. Stating "deleted" would present a
    // guess as a fact, and the access case is the one people never consider.
    const text = summariseChange(
      { type: 'microsoft.compute/virtualmachines', resource_group: 'rg-prod' },
      'removed',
    );

    expect(text).toContain('no longer present');
    expect(text).toContain('lost access');
  });

  it('uses the single change as the sentence when only one thing moved', () => {
    const text = summariseChange(
      {
        type: 'microsoft.compute/virtualmachines',
        changes: [{ field: 'sku', from: 'D2s v3', to: 'D4s v3' }],
      },
      'modified',
    );

    expect(text).toBe('Resized from D2s v3 to D4s v3');
  });

  it('counts them instead of concatenating when several moved', () => {
    const text = summariseChange(
      {
        type: 'microsoft.compute/virtualmachines',
        changes: [
          { field: 'sku', from: 'a', to: 'b' },
          { field: 'location', from: 'c', to: 'd' },
        ],
      },
      'modified',
    );

    expect(text).toContain('2 properties changed');
  });
});
