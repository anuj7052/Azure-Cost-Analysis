/**
 * Ordering the BOQ vs actual category table.
 *
 * The table arrives worst-overrun-first, and that order is the page's opening
 * argument. Sorting is a second question the reader asks on top of it, so what
 * matters here is that it answers the question asked: sorting by money must
 * put money at the top, not the rows where the figure is missing.
 */
import { describe, expect, it } from 'vitest';

import { sortCategories } from '../src/utils/boqCompare';

const cat = (over = {}) => ({
  key: over.label || 'k',
  label: 'compute',
  budgeted: 1000,
  actual: 1200,
  variance: 200,
  variancePct: 20,
  ...over,
});

describe('ordering the category table', () => {
  const rows = [
    cat({ key: 'b', label: 'storage', budgeted: 500, actual: 400, variance: -100, variancePct: -20 }),
    cat({ key: 'a', label: 'compute', budgeted: 1000, actual: 5000, variance: 4000, variancePct: 400 }),
    cat({ key: 'c', label: 'network', budgeted: 0, actual: 900, variance: 900, variancePct: null }),
  ];

  it('sorts a name alphabetically', () => {
    expect(sortCategories(rows, 'label', 'asc').map(r => r.label))
      .toEqual(['compute', 'network', 'storage']);
  });

  it('puts the worst overrun first', () => {
    expect(sortCategories(rows, 'variance', 'desc')[0].label).toBe('compute');
  });

  it('sorts variance signed, not by size', () => {
    // Spending a lot too much and a lot too little are opposite problems. An
    // absolute sort would interleave them and the column would say nothing.
    expect(sortCategories(rows, 'variance', 'asc')[0].label).toBe('storage');
  });

  it('sinks a category with no percentage to the bottom in both directions', () => {
    // Nothing was budgeted, so there is no "vs budget" to speak of. Those rows
    // are a separate problem and putting them first buries the answer.
    const up = sortCategories(rows, 'variancePct', 'asc');
    const down = sortCategories(rows, 'variancePct', 'desc');
    expect(up[up.length - 1].label).toBe('network');
    expect(down[down.length - 1].label).toBe('network');
  });

  it('sorts money as money', () => {
    expect(sortCategories(rows, 'actual', 'desc').map(r => r.label))
      .toEqual(['compute', 'network', 'storage']);
  });

  it('leaves the list alone for a column it does not know', () => {
    expect(sortCategories(rows, 'nonsense').map(r => r.label))
      .toEqual(['storage', 'compute', 'network']);
  });

  it('does not reorder the report in place', () => {
    const original = [...rows];
    sortCategories(rows, 'label', 'asc');
    expect(rows).toEqual(original);
  });

  it('survives an empty report', () => {
    expect(sortCategories(null, 'label')).toEqual([]);
  });
});
