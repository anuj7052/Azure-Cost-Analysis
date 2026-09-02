/**
 * The dashboard band on BOQ vs Actual.
 *
 * Its only real obligation is not to disagree with the table below it, so most
 * of what follows checks that the summary, the charts and the recommendations
 * are all reading the same report rather than each doing their own arithmetic.
 */
import { describe, expect, it } from 'vitest';

import {
  dailySeries, daysInMonth, finops, monthlySeries, recommend, topSpend,
} from '../src/utils/boqDashboard';

const cat = (over = {}) => ({
  key: 'compute',
  label: 'Virtual Machines & Compute',
  budgeted: 1000,
  actual: 1000,
  variance: 0,
  variancePct: 0,
  unbudgeted: false,
  unused: false,
  lines: [],
  ...over,
});

const report = (over = {}) => ({
  currency: 'INR',
  months: 1,
  categories: [cat()],
  budgetTotal: 1000,
  actualTotal: 1000,
  variance: 0,
  variancePct: 0,
  extraTotal: 0,
  notInBoq: [],
  notInBoqTotal: 0,
  unbudgetedTotal: 0,
  savingTotal: 0,
  ...over,
});

describe('finops summary', () => {
  it('reports the same variance the report already computed', () => {
    const head = finops(report({ actualTotal: 1500, variancePct: 50 }), []);
    expect(head.variance).toBe(500);
    expect(head.overspend).toBe(true);
    expect(head.consumedPct).toBe(150);
  });

  // "Flat" and "we cannot tell" are different answers, and a 0% that means the
  // latter is the kind of number somebody quotes in a meeting.
  it('has no trend with only one month', () => {
    const head = finops(report(), [{ month: '2026-07', total_cost: 900 }]);
    expect(head.trendPct).toBeNull();
  });

  it('compares the last two months for the trend', () => {
    const head = finops(report(), [
      { month: '2026-06', total_cost: 1000 },
      { month: '2026-07', total_cost: 1250 },
    ]);
    expect(head.trendPct).toBe(25);
    expect(head.trendFrom).toBe('2026-06');
    expect(head.trendTo).toBe('2026-07');
  });

  it('will not divide by a zero budget', () => {
    const head = finops(report({ budgetTotal: 0, variancePct: null }), []);
    expect(head.consumedPct).toBeNull();
  });
});

describe('daily series', () => {
  // A monthly budget divided by 30 makes February look overspent every year.
  it('divides the budget by the real length of the month', () => {
    expect(daysInMonth('2026-02-10')).toBe(28);
    expect(daysInMonth('2024-02-10')).toBe(29);
    const [day] = dailySeries([{ date: '2026-02-10', total: 100 }], 2800);
    expect(day.budget).toBe(100);
    expect(day.over).toBe(false);
  });

  it('accumulates both sides so a drift is visible before month end', () => {
    const series = dailySeries([
      { date: '2026-06-01', total: 40 },
      { date: '2026-06-02', total: 80 },
    ], 3000);
    expect(series[1].cumulativeActual).toBe(120);
    expect(series[1].cumulativeBudget).toBe(200);
  });

  it('reports no budget line rather than a zero one when there is no BOQ', () => {
    const [day] = dailySeries([{ date: '2026-06-01', total: 40 }], 0);
    expect(day.budget).toBeNull();
    expect(day.cumulativeBudget).toBeNull();
  });

  it('sorts by date regardless of the order Azure returned them', () => {
    const series = dailySeries([
      { date: '2026-06-03', total: 30 },
      { date: '2026-06-01', total: 10 },
    ], 300);
    expect(series.map(d => d.date)).toEqual(['06-01', '06-03']);
  });

  it('falls back to months without inventing days', () => {
    const series = monthlySeries([{ month: '2026-06', total_cost: 1200 }], 1000);
    expect(series).toEqual([{ date: '2026-06', actual: 1200, budget: 1000, over: true }]);
  });
});

describe('top spend', () => {
  const many = report({
    categories: [
      cat({ key: 'a', label: 'A', actual: 600 }),
      cat({ key: 'b', label: 'B', actual: 500 }),
      cat({ key: 'c', label: 'C', actual: 400 }),
      cat({ key: 'd', label: 'D', actual: 300 }),
      cat({ key: 'e', label: 'E', actual: 200 }),
      cat({ key: 'f', label: 'F', actual: 100 }),
      cat({ key: 'g', label: 'G', actual: 50 }),
    ],
  });

  // A "top 5" that silently drops the rest of the bill misleads by omission.
  it('keeps the remainder as its own bar', () => {
    const top = topSpend(many, 'actual', 5);
    expect(top).toHaveLength(6);
    expect(top[5].name).toBe('Other (2)');
    expect(top[5].value).toBe(150);
  });

  it('adds up to the same total as the categories it came from', () => {
    const top = topSpend(many, 'actual', 5);
    const charted = top.reduce((s, d) => s + d.value, 0);
    const source = many.categories.reduce((s, c) => s + c.actual, 0);
    expect(charted).toBe(source);
  });

  it('drops categories with nothing to show', () => {
    const top = topSpend(report({ categories: [cat({ actual: 0 })] }), 'actual', 5);
    expect(top).toEqual([]);
  });
});

describe('recommendations', () => {
  it('says nothing when everything matches the estimate', () => {
    expect(recommend(report())).toEqual([]);
  });

  it('leads with an unbudgeted category over an ordinary overrun', () => {
    const advice = recommend(report({
      categories: [
        cat({ key: 'compute', budgeted: 1000, actual: 1400, variance: 400, variancePct: 40 }),
        cat({ key: 'network', label: 'Networking', budgeted: 0, actual: 300, variance: 300, unbudgeted: true }),
      ],
    }));
    expect(advice[0].id).toBe('unbudgeted:network');
    expect(advice[0].severity).toBe('critical');
  });

  it('escalates an overrun past half the budget', () => {
    const [top] = recommend(report({
      categories: [cat({ budgeted: 1000, actual: 1600, variance: 600, variancePct: 60 })],
    }));
    expect(top.severity).toBe('critical');
  });

  // Budget bought and never spent never causes a bill to rise, so nobody goes
  // looking for it -- which is exactly why it has to be volunteered.
  it('flags budget that was never deployed', () => {
    const advice = recommend(report({
      budgetTotal: 1000,
      actualTotal: 0,
      variance: -1000,
      categories: [cat({ actual: 0, variance: -1000, unused: true })],
    }));
    expect(advice.map(a => a.id)).toContain('unused:compute');
  });

  it('separates a quantity overrun from a rate overrun', () => {
    const line = {
      id: 'e:0', sku: 'P20', service_type: 'Managed Disks', variance: 900,
      drivers: {
        qty: 1, billedCount: 3, extraUnits: 2, unitBudget: 500, unitActual: 600,
        quantityEffect: 1000, rateEffect: 300,
      },
    };
    const advice = recommend(report({
      categories: [cat({ budgeted: 500, actual: 1800, variance: 1300, variancePct: 260, lines: [line] })],
    }));
    const ids = advice.map(a => a.id);
    expect(ids).toContain('qty:e:0');
    // Rate is present too, but it is the smaller of the two and must not be the
    // headline -- counting the disks is the action, not renegotiating the price.
    const qty = advice.find(a => a.id === 'qty:e:0');
    expect(qty.impact).toBe(1000);
  });

  it('ignores differences too small to act on', () => {
    const advice = recommend(report({
      categories: [cat({ budgeted: 1000, actual: 1050, variance: 50, variancePct: 5 })],
    }));
    expect(advice).toEqual([]);
  });

  it('reports being under budget rather than only ever bad news', () => {
    const advice = recommend(report({
      actualTotal: 600, variance: -400, variancePct: -40,
      categories: [cat({ actual: 600, variance: -400, variancePct: -40 })],
    }));
    expect(advice.map(a => a.id)).toContain('under-budget');
    expect(advice.find(a => a.id === 'under-budget').severity).toBe('good');
  });

  it('orders by severity first and money second', () => {
    const advice = recommend(report({
      categories: [
        cat({ key: 'a', label: 'A', budgeted: 1000, actual: 1200, variance: 200, variancePct: 20 }),
        cat({ key: 'b', label: 'B', budgeted: 1000, actual: 1900, variance: 900, variancePct: 90 }),
      ],
    }));
    expect(advice[0].id).toBe('over:b');
  });
});
