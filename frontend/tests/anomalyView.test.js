/**
 * The view pipeline behind the anomalies table.
 *
 * The rules being protected here are the ones that make the page honest:
 * money outranks percentage, an absence is not a zero, and the cards must
 * always describe the same rows the table is showing.
 */
import { describe, it, expect } from 'vitest';
import {
  applyFilters, sortRows, paginate, summarise, severityCounts,
  toExportRows, possibleCauses, filtersToParams, filtersFromParams,
  SORT_PCT, SORT_SERVICE, DEFAULT_FILTERS,
} from '../src/utils/anomalyView';

const row = (over = {}) => ({
  service: 'Storage',
  resource_name: 'stprod',
  resource_group: 'rg-prod',
  subscription_id: 'sub-a',
  subscription_name: 'kredily',
  region: 'centralindia',
  previous_cost: 100,
  current_cost: 200,
  delta: 100,
  pct_change: 100,
  direction: 'increase',
  severity: 'medium',
  status: 'new',
  note: '',
  ...over,
});

describe('sorting', () => {
  it('ranks by money, not percentage', () => {
    const small = row({ service: 'Functions', delta: 101, pct_change: 2020 });
    const large = row({ service: 'Postgres', delta: 18241, pct_change: 320 });

    const sorted = sortRows([small, large]);

    // The old page put Functions first because 2020% > 320%, which sent people
    // to investigate ₹101 while ₹18,241 sat below the fold.
    expect(sorted[0].service).toBe('Postgres');
  });

  it('can still rank by percentage when asked', () => {
    const small = row({ service: 'Functions', delta: 101, pct_change: 2020 });
    const large = row({ service: 'Postgres', delta: 18241, pct_change: 320 });

    expect(sortRows([small, large], SORT_PCT)[0].service).toBe('Functions');
  });

  it('sinks rows with no percentage rather than treating them as zero', () => {
    const known = row({ pct_change: 5 });
    const unknown = row({ service: 'New thing', pct_change: null });

    expect(sortRows([unknown, known], SORT_PCT)[0].service).toBe('Storage');
  });

  it('sorts by name alphabetically in both directions', () => {
    const rows = [row({ service: 'Zeta' }), row({ service: 'Alpha' })];

    expect(sortRows(rows, SORT_SERVICE, true)[0].service).toBe('Alpha');
    expect(sortRows(rows, SORT_SERVICE, false)[0].service).toBe('Zeta');
  });

  it('does not mutate the array it was given', () => {
    const rows = [row({ delta: 1 }), row({ delta: 9 })];
    sortRows(rows);

    expect(rows[0].delta).toBe(1);
  });
});

describe('filters', () => {
  const rows = [
    row({ service: 'Storage', severity: 'critical', status: 'new', subscription_id: 'sub-a' }),
    row({ service: 'Postgres', severity: 'low', status: 'resolved', subscription_id: 'sub-b' }),
    row({ service: 'Bandwidth', severity: 'critical', status: 'investigating', subscription_id: 'sub-b', direction: 'decrease' }),
  ];

  it('returns everything by default', () => {
    expect(applyFilters(rows, DEFAULT_FILTERS)).toHaveLength(3);
  });

  it('filters by severity', () => {
    expect(applyFilters(rows, { severity: 'critical' })).toHaveLength(2);
  });

  it('filters by status', () => {
    expect(applyFilters(rows, { status: 'resolved' })[0].service).toBe('Postgres');
  });

  it('filters by subscription', () => {
    expect(applyFilters(rows, { subscription: 'sub-a' })).toHaveLength(1);
  });

  it('filters by direction', () => {
    expect(applyFilters(rows, { direction: 'decrease' })[0].service).toBe('Bandwidth');
  });

  it('combines filters rather than replacing them', () => {
    const out = applyFilters(rows, { severity: 'critical', subscription: 'sub-b' });

    expect(out).toHaveLength(1);
    expect(out[0].service).toBe('Bandwidth');
  });

  it('searches names case-insensitively across every visible column', () => {
    expect(applyFilters(rows, { search: 'POSTG' })).toHaveLength(1);
    expect(applyFilters(rows, { search: 'kredily' })).toHaveLength(3);
    expect(applyFilters(rows, { search: 'centralindia' })).toHaveLength(3);
  });

  it('searches the subscription id too, for anyone pasting a GUID', () => {
    expect(applyFilters(rows, { search: 'sub-a' })).toHaveLength(1);
  });

  it('returns nothing rather than everything when a search matches nothing', () => {
    expect(applyFilters(rows, { search: 'nothing-here' })).toHaveLength(0);
  });
});

describe('summary', () => {
  it('reports an absence as not-available rather than zero', () => {
    const s = summarise([]);

    // A zero here reads as "we checked and nothing changed", which is a
    // different and much stronger claim than "we have no data".
    expect(s.increase).toBeNull();
    expect(s.reduction).toBeNull();
    expect(s.netChange).toBeNull();
    expect(s.count).toBe(0);
  });

  it('separates increases from reductions instead of netting them away', () => {
    const s = summarise([row({ delta: 40000 }), row({ delta: -39000 })]);

    expect(s.increase).toBe(40000);
    expect(s.reduction).toBe(39000);
    expect(s.netChange).toBe(1000);
  });

  it('picks the largest change by amount, including a reduction', () => {
    const s = summarise([row({ service: 'Small', delta: 500 }), row({ service: 'Big', delta: -9000 })]);

    expect(s.largest.service).toBe('Big');
  });

  it('counts only unhandled serious rows as needing attention', () => {
    const s = summarise([
      row({ severity: 'critical', status: 'new' }),
      row({ severity: 'critical', status: 'resolved' }),
      row({ severity: 'high', status: 'ignored' }),
      row({ severity: 'low', status: 'new' }),
    ]);

    expect(s.needsAttention).toBe(1);
  });

  it('describes exactly the rows it was handed, so cards match the table', () => {
    const rows = [row({ delta: 100, severity: 'low' }), row({ delta: 5000, severity: 'critical' })];
    const filtered = applyFilters(rows, { severity: 'critical' });

    expect(summarise(filtered).increase).toBe(5000);
  });
});

describe('severity counts', () => {
  it('reports every band, including empty ones', () => {
    const counts = severityCounts([row({ severity: 'critical' })]);

    expect(counts.critical).toBe(1);
    expect(counts.low).toBe(0);
    expect(Object.keys(counts)).toContain('none');
  });
});

describe('paging', () => {
  const rows = Array.from({ length: 25 }, (_, i) => row({ service: `s${i}` }));

  it('slices to the requested page', () => {
    const p = paginate(rows, 2, 10);

    expect(p.rows).toHaveLength(10);
    expect(p.rows[0].service).toBe('s10');
    expect(p.totalPages).toBe(3);
  });

  it('clamps a page beyond the end rather than showing nothing', () => {
    // Filtering down while on page 9 must not leave a blank table.
    const p = paginate(rows, 99, 10);

    expect(p.page).toBe(3);
    expect(p.rows).toHaveLength(5);
  });

  it('always reports at least one page for an empty list', () => {
    expect(paginate([], 1, 10).totalPages).toBe(1);
  });
});

describe('causes', () => {
  it('never asserts a cause it cannot show evidence for', () => {
    const causes = possibleCauses(row({ current_quantity: null, previous_quantity: null }));

    expect(causes[0]).toBe('Cause could not be determined from available data.');
  });

  it('separates more usage from a rate change using metered quantity', () => {
    const moreUsage = possibleCauses(row({ previous_quantity: 100, current_quantity: 200 }));
    const rateChange = possibleCauses(row({ previous_quantity: 100, current_quantity: 101 }));

    expect(moreUsage.join(' ')).toContain('more consumption');
    expect(rateChange.join(' ')).toContain('rate, tier, discount or reservation');
  });

  it('states a new cost as a fact about the data, not a diagnosis', () => {
    const causes = possibleCauses(row({ direction: 'new' }));

    expect(causes[0]).toContain('did not exist in the previous period');
    expect(causes[0]).toContain('consistent with');
  });
});

describe('export', () => {
  it('exports the filtered rows so the file matches the screen', () => {
    const rows = [row({ service: 'Storage', severity: 'critical' }), row({ service: 'Postgres', severity: 'low' })];
    const out = toExportRows(applyFilters(rows, { severity: 'critical' }), 'INR');

    expect(out).toHaveLength(1);
    expect(out[0].Service).toBe('Storage');
  });

  it('writes Not available rather than a blank or a zero percentage', () => {
    const out = toExportRows([row({ pct_change: null })], 'INR');

    expect(out[0]['Percentage change']).toBe('Not available');
  });

  it('leads with the subscription name and keeps the id searchable', () => {
    const out = toExportRows([row()], 'INR');

    expect(out[0].Subscription).toBe('kredily');
  });
});

describe('url filters', () => {
  it('round-trips a filtered view', () => {
    const filters = { ...DEFAULT_FILTERS, severity: 'critical', search: 'postgres' };
    const params = new URLSearchParams(filtersToParams(filters)).toString();

    expect(filtersFromParams(params)).toEqual(filters);
  });

  it('leaves defaults out of the url', () => {
    expect(filtersToParams(DEFAULT_FILTERS)).toEqual({});
  });

  it('ignores unknown parameters', () => {
    expect(filtersFromParams('nonsense=1')).toEqual(DEFAULT_FILTERS);
  });
});
