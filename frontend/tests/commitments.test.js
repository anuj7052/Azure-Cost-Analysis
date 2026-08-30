import { describe, it, expect } from 'vitest';
import {
  MISSING, percent, money, termLabel, expiryLabel, filterCommitments, usedAt,
  wastageOf, byResourceType, worstWaste, utilisationTone, utilisationBar,
  utilisationVerdict, GRAINS, TYPE_FILTERS, KIND_LABEL, KIND_FULL,
  EXPIRY_TONE, EXPIRY_LABEL, POOR_BELOW, GOOD_ABOVE,
} from '../src/utils/commitments';

const item = (over = {}) => ({
  id: over.id || `/ri/${over.name || 'ri-a'}`,
  kind: 'reservation',
  name: 'ri-a',
  sku: 'Standard_D8s_v5',
  resource_type: 'VirtualMachines',
  term: 'P3Y',
  quantity: 10,
  quantity_unit: 'instances',
  scope_type: 'Shared',
  days_to_expiry: 200,
  expiry_band: '',
  utilisation: { 1: 90, 7: 88, 30: 89 },
  monthly_cost: 1000,
  currency: 'USD',
  ...over,
});

describe('showing a number, or admitting there is not one', () => {
  it('formats a percentage', () => {
    expect(percent(90.34)).toBe('90.3%');
  });

  it('keeps a genuine zero', () => {
    // Azure reporting a commitment as 0% used is one of the most important
    // things this page can say. A helper that treated it as missing would
    // delete exactly that.
    expect(percent(0)).toBe('0.0%');
  });

  it('says so when there is no percentage', () => {
    expect(percent(null)).toBe(MISSING);
    expect(percent(undefined)).toBe(MISSING);
    expect(percent(NaN)).toBe(MISSING);
  });

  it('says so when there is no amount', () => {
    // A dash would read as a zero on a page about money.
    expect(money(null, 'USD')).toBe(MISSING);
    expect(money(undefined, 'USD')).toBe(MISSING);
  });

  it('formats an amount it does have', () => {
    expect(money(1000, 'USD')).toMatch(/1/);
  });
});

describe('phrasing Azure terms the way people say them', () => {
  it('turns an ISO duration into years', () => {
    expect(termLabel('P3Y')).toBe('3-Year');
    expect(termLabel('P1Y')).toBe('1-Year');
  });

  it('handles a term in months', () => {
    expect(termLabel('P6M')).toBe('6-Month');
  });

  it('passes an unrecognised term through rather than inventing one', () => {
    expect(termLabel('WEIRD')).toBe('WEIRD');
    expect(termLabel('')).toBe(MISSING);
  });
});

describe('how long is left', () => {
  it('counts days for anything inside a quarter', () => {
    // "in 21 days" prompts an action; a date prompts a mental subtraction that
    // often does not happen.
    expect(expiryLabel(21)).toBe('21 days');
  });

  it('reads naturally at the edges', () => {
    expect(expiryLabel(0)).toBe('Expires today');
    expect(expiryLabel(1)).toBe('Expires tomorrow');
  });

  it('says plainly when something has already lapsed', () => {
    expect(expiryLabel(-5)).toBe('Expired 5 days ago');
  });

  it('switches to months once days stop being useful', () => {
    expect(expiryLabel(365)).toBe('12 months');
  });

  it('admits an unknown expiry instead of implying it is far off', () => {
    expect(expiryLabel(null)).toBe(MISSING);
    expect(expiryLabel(undefined)).toBe(MISSING);
  });
});

describe('reading utilisation for the chosen window', () => {
  it('finds the window', () => {
    expect(usedAt(item(), 7)).toBe(88);
  });

  it('reads keys JSON turned into strings', () => {
    // The backend keys these by number. Reading only the numeric form would
    // report every commitment as unmeasured, which looks exactly like a page
    // that is still loading.
    expect(usedAt({ utilisation: { '30': 91 } }, 30)).toBe(91);
  });

  it('a window Azure did not publish is unknown, not zero', () => {
    expect(usedAt({ utilisation: { 1: 50 } }, 30)).toBe(null);
  });

  it('a genuine zero survives', () => {
    expect(usedAt({ utilisation: { 30: 0 } }, 30)).toBe(0);
  });

  it('a malformed item does not throw', () => {
    expect(usedAt(null, 30)).toBe(null);
    expect(usedAt({}, 30)).toBe(null);
  });
});

describe('what is being paid for and not used', () => {
  it('is the unused share of a measured cost', () => {
    expect(wastageOf(item({ monthly_cost: 1000, utilisation: { 30: 90 } }), 30)).toBe(100);
  });

  it('is nothing when the commitment is fully consumed', () => {
    expect(wastageOf(item({ utilisation: { 30: 100 } }), 30)).toBe(0);
  });

  it('is unknown without a cost', () => {
    // This is the number somebody quotes when they propose cancelling a
    // reservation. An estimate would look identical on screen to a measurement.
    expect(wastageOf(item({ monthly_cost: null }), 30)).toBe(null);
  });

  it('is unknown without a utilisation figure', () => {
    expect(wastageOf(item({ utilisation: {} }), 30)).toBe(null);
  });

  it('never goes negative when Azure reports over a hundred percent', () => {
    expect(wastageOf(item({ utilisation: { 30: 120 } }), 30)).toBe(0);
  });
});

describe('narrowing the inventory', () => {
  const rows = [
    item({ name: 'ri-a', kind: 'reservation', days_to_expiry: 100 }),
    item({ name: 'sp-a', kind: 'savings-plan', days_to_expiry: 100, id: '/sp/a' }),
    item({ name: 'ri-old', kind: 'reservation', days_to_expiry: -10, id: '/ri/old' }),
  ];

  it('hides expired commitments by default', () => {
    expect(filterCommitments(rows).map(r => r.name)).toEqual(['ri-a', 'sp-a']);
  });

  it('shows them when asked', () => {
    expect(filterCommitments(rows, { hideExpired: false })).toHaveLength(3);
  });

  it('filters by type', () => {
    const out = filterCommitments(rows, { type: 'savings-plan' });
    expect(out.map(r => r.name)).toEqual(['sp-a']);
  });

  it('searches name and SKU', () => {
    expect(filterCommitments(rows, { query: 'D8s' })).toHaveLength(2);
    expect(filterCommitments(rows, { query: 'sp-' }).map(r => r.name)).toEqual(['sp-a']);
  });

  it('an empty search does not blank the page', () => {
    expect(filterCommitments(rows, { query: '   ' })).toHaveLength(2);
  });

  it('survives an empty inventory', () => {
    expect(filterCommitments(null)).toEqual([]);
  });
});

describe('grouping by what the commitment covers', () => {
  it('averages within a group', () => {
    const out = byResourceType([
      item({ resource_type: 'VirtualMachines', utilisation: { 30: 80 } }),
      item({ resource_type: 'VirtualMachines', utilisation: { 30: 90 }, id: '/b' }),
    ], 30);
    expect(out).toEqual([{ name: 'VirtualMachines', used: 85, count: 2, cost: 2000 }]);
  });

  it('leaves unmeasured commitments out of the average', () => {
    // A bar drawn over a mix of measured and assumed values is a bar nobody
    // can act on.
    const out = byResourceType([
      item({ utilisation: { 30: 80 } }),
      item({ utilisation: {}, id: '/b' }),
    ], 30);
    expect(out[0].count).toBe(1);
    expect(out[0].used).toBe(80);
  });

  it('drops a group where nothing was measured rather than drawing it at zero', () => {
    expect(byResourceType([item({ utilisation: {} })], 30)).toEqual([]);
  });

  it('puts the worst group first', () => {
    const out = byResourceType([
      item({ resource_type: 'A', utilisation: { 30: 95 } }),
      item({ resource_type: 'B', utilisation: { 30: 40 }, id: '/b' }),
    ], 30);
    expect(out.map(g => g.name)).toEqual(['B', 'A']);
  });
});

describe('ranking what to look at first', () => {
  it('ranks by money lost, not by percentage', () => {
    // A 60%-used reservation costing a little is a smaller problem than an
    // 88%-used one costing a great deal, and only one is worth an afternoon.
    const cheapAndIdle = item({ name: 'cheap', monthly_cost: 100, utilisation: { 30: 60 }, id: '/a' });
    const dearAndBusy = item({ name: 'dear', monthly_cost: 50000, utilisation: { 30: 88 }, id: '/b' });
    const out = worstWaste([cheapAndIdle, dearAndBusy], 30);
    expect(out[0].item.name).toBe('dear');
  });

  it('leaves out commitments whose waste cannot be measured', () => {
    const out = worstWaste([item({ monthly_cost: null })], 30);
    expect(out).toEqual([]);
  });

  it('leaves out commitments wasting nothing', () => {
    expect(worstWaste([item({ utilisation: { 30: 100 } })], 30)).toEqual([]);
  });

  it('honours the limit', () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      item({ id: `/x${i}`, utilisation: { 30: 10 } }));
    expect(worstWaste(many, 30, 3)).toHaveLength(3);
  });
});

describe('colouring by utilisation', () => {
  it('flags anything under the break-even band', () => {
    expect(utilisationTone(POOR_BELOW - 1)).toContain('rose');
    expect(utilisationBar(POOR_BELOW - 1)).toContain('rose');
  });

  it('is calm once nearly everything is consumed', () => {
    expect(utilisationTone(GOOD_ABOVE + 1)).toContain('emerald');
  });

  it('an unmeasured commitment is grey, not red', () => {
    // "Unmeasured" and "unused" call for opposite reactions, so they must not
    // share a colour.
    expect(utilisationTone(null)).toContain('slate');
    expect(utilisationBar(null)).toContain('slate');
  });
});

describe('the headline sentence', () => {
  it('describes what the number is', () => {
    expect(utilisationVerdict({ utilisation: 95 }, 30)).toContain('95.0%');
    expect(utilisationVerdict({ utilisation: 95 }, 30)).toContain('30 days');
  });

  it('is never a grade', () => {
    // A grade implies the page weighed everything bearing on the decision. It
    // weighed utilisation and nothing else -- not the migration that makes an
    // underused reservation the correct choice.
    for (const value of [10, 55, 85, 99]) {
      const line = utilisationVerdict({ utilisation: value }, 30);
      expect(line).not.toMatch(/healthy|excellent|poor grade|score/i);
    }
  });

  it('says nothing was published rather than reporting zero', () => {
    expect(utilisationVerdict({ utilisation: null }, 30)).toMatch(/not published/);
    expect(utilisationVerdict({}, 30)).toMatch(/not published/);
  });
});

describe('the option lists', () => {
  it('offers only the windows Azure publishes', () => {
    // A fourth window would invite a question this data cannot answer.
    expect(GRAINS.map(g => g.key)).toEqual([1, 7, 30]);
  });

  it('covers both kinds of commitment', () => {
    expect(TYPE_FILTERS.map(t => t.key)).toEqual(['all', 'reservation', 'savings-plan']);
  });

  it('every kind has a short and a full name', () => {
    for (const kind of ['reservation', 'savings-plan']) {
      expect(KIND_LABEL[kind]).toBeTruthy();
      expect(KIND_FULL[kind]).toBeTruthy();
    }
  });

  it('every expiry band has a colour and a word', () => {
    for (const band of ['expired', 'critical', 'warning', 'watch']) {
      expect(EXPIRY_TONE[band]).toBeTruthy();
      expect(EXPIRY_LABEL[band]).toBeTruthy();
    }
  });
});
