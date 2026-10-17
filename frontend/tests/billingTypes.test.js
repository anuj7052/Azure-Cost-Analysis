import { describe, expect, it } from 'vitest';
import { buildTypeIndex, typesFor } from '../src/utils/billingTypes';

describe('billing types', () => {
  const index = buildTypeIndex({
    ri: { rows: [{ resource_group: 'RG-A', meter: 'D4as v5' }] },
    payg: { rows: [{ resource_group: 'rg-a', meter: 'D4as v5' }, { resource_group: 'rg-b', meter: 'F2s v2' }] },
  });
  it('tags a charge with every pricing model Azure reported for its meter, case-insensitively', () => {
    expect(typesFor(index, { resource_group: 'rg-a', meter: 'D4as v5' }).sort()).toEqual(['payg', 'ri']);
    expect(typesFor(index, { resource_group: 'other', label: 'F2s v2 · Linux' })).toEqual(['payg']);
  });
  it('marks DR / ASR only from Site Recovery names and reports nothing it cannot see', () => {
    expect(typesFor(index, { meter: 'Protected Instance', service: 'Azure Site Recovery' })).toEqual(['asr']);
    expect(typesFor(index, { meter: 'Unknown meter' })).toEqual([]);
  });
});
