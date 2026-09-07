import { describe, it, expect } from 'vitest';
import {
  MISSING, annualised, commitmentDetail, costUnavailableReason, dateLabel,
  remainingValue,
} from '../src/utils/commitments';

/**
 * The full record behind one commitment.
 *
 * The inventory table shows one month's cost and calls it a day, which is
 * enough to spot a problem and not enough to decide anything about it. What is
 * pinned here is the rule the panel exists to keep: every value is either
 * something Azure returned or the words "Not available", and the three figures
 * extrapolated from a measured one are marked as extrapolations. On a page
 * about money, a derived number and a billed one must not read alike.
 */

const RI = {
  id: '/providers/Microsoft.Capacity/reservationOrders/abc/reservations/def',
  kind: 'reservation',
  name: 'vm-prod-ri',
  sku: 'Standard_D4s_v5',
  resource_type: 'VirtualMachines',
  term: 'P3Y',
  quantity: 4,
  quantity_unit: 'instances',
  state: 'Succeeded',
  scope_type: 'Shared',
  scopes: ['/subscriptions/aaa'],
  location: 'eastus',
  billing_plan: 'Monthly',
  renew: true,
  purchase_date: '2026-01-15T09:12:00Z',
  expiry: '2029-01-15T00:00:00Z',
  days_to_expiry: 300,
  expiry_band: 'watch',
  utilisation: { 1: 92, 7: 88, 30: 80 },
  monthly_cost: 1200,
  measured_wastage: null,
  currency: 'INR',
};

const rowsOf = (item, grain = 30) =>
  Object.fromEntries(
    commitmentDetail(item, grain).flatMap(s => s.rows.map(([label, value, note]) => [label, { value, note }])),
  );

describe('extrapolated amounts', () => {
  it('reports a year as twelve months of the measured figure', () => {
    expect(annualised(1200)).toBe(14400);
  });

  it('has nothing to extrapolate from when the cost is missing', () => {
    // A yearly figure invented from no monthly figure is indistinguishable on
    // screen from one built on a real invoice.
    expect(annualised(null)).toBeNull();
    expect(annualised(undefined)).toBeNull();
  });

  it('values the rest of the term at the rate it is running at', () => {
    // 300 days left at 1200 a month.
    expect(remainingValue(RI)).toBe(12000);
  });

  it('has nothing left to run once the term has ended', () => {
    // Not a negative amount, which is what multiplying a past date would give.
    expect(remainingValue({ ...RI, days_to_expiry: -40 })).toBe(0);
  });

  it('refuses to value the remainder without both halves', () => {
    expect(remainingValue({ ...RI, monthly_cost: null })).toBeNull();
    expect(remainingValue({ ...RI, days_to_expiry: null })).toBeNull();
  });
});

describe('dates', () => {
  it('says there is no date rather than showing an epoch', () => {
    expect(dateLabel(null)).toBe(MISSING);
    expect(dateLabel('')).toBe(MISSING);
    expect(dateLabel('not a date')).toBe(MISSING);
  });

  it('writes a real timestamp as a day', () => {
    expect(dateLabel('2026-01-15T09:12:00Z')).toMatch(/2026/);
  });
});

describe('the detail sections', () => {
  it('surfaces the fields the table has no room for', () => {
    const rows = rowsOf(RI);
    expect(rows['Purchased'].value).toMatch(/2026/);
    expect(rows['Billing plan'].value).toBe('Monthly');
    expect(rows['Scope'].value).toBe('Shared');
    expect(rows['State'].value).toBe('Succeeded');
    expect(rows['Region'].value).toBe('eastus');
    expect(rows['Quantity'].value).toBe('4 instances');
  });

  it('states auto-renew as a word, not a blank', () => {
    // The difference between a deadline and a note.
    expect(rowsOf(RI)['Renews automatically'].value).toBe('Yes');
    expect(rowsOf({ ...RI, renew: false })['Renews automatically'].value).toBe('No');
  });

  it('says a savings plan is not region-bound instead of leaving it empty', () => {
    expect(rowsOf({ ...RI, location: '' })['Region'].value).toBe('Not region-bound');
  });

  it('writes every absent field as words rather than a dash', () => {
    const bare = {
      id: '', kind: 'reservation', utilisation: {},
      monthly_cost: null, measured_wastage: null,
    };
    const rows = rowsOf(bare);
    for (const label of ['SKU', 'Covers', 'Quantity', 'State', 'Purchased', 'Ends',
      'Billing plan', 'Monthly cost', 'Yearly cost', 'Still to run', 'Scope',
      'Applied to', 'Commitment ID']) {
      expect(rows[label].value).toBe(MISSING);
    }
  });

  it('marks a billed waste figure differently from an inferred one', () => {
    const billed = rowsOf({ ...RI, measured_wastage: 210 })['Wasted per month'];
    expect(billed.note).toMatch(/[Bb]illed by Azure/);

    const inferred = rowsOf(RI)['Wasted per month'];
    expect(inferred.note).toMatch(/utilisation/);
    expect(inferred.note).not.toMatch(/[Bb]illed by Azure/);
  });

  it('says the yearly figures are not quotes', () => {
    const rows = rowsOf(RI);
    expect(rows['Yearly cost'].note).toMatch(/not a quote/);
    expect(rows['Still to run'].note).toMatch(/days left/);
  });

  it('counts multiple scopes instead of running one off the panel', () => {
    const many = { ...RI, scopes: ['/subscriptions/a', '/subscriptions/b'] };
    expect(rowsOf(many)['Applied to'].value).toBe('2 scopes');
  });

  it('returns nothing at all for no commitment', () => {
    expect(commitmentDetail(null)).toEqual([]);
  });
});

/**
 * Every amount reading "Not available" at once looks like a broken page. It
 * almost never is: amortised benefit charges land on the subscription that
 * consumed the benefit, so a tenant-shared reservation charges whichever
 * subscriptions ran the workload, and selecting only the one that bought it
 * returns nothing. That is a selection with a one-click fix, and the panel has
 * to say so rather than repeating two words five times.
 */
describe('explaining a missing amount', () => {
  it('says nothing when there is an amount to show', () => {
    expect(costUnavailableReason(RI)).toBe('');
  });

  it('points at the other subscriptions for a shared benefit', () => {
    const reason = costUnavailableReason({ ...RI, monthly_cost: null, scope_type: 'Shared' });
    expect(reason).toMatch(/shared across the tenant/i);
    expect(reason).toMatch(/select those subscriptions/i);
  });

  it('explains a management-group scope in its own terms', () => {
    const reason = costUnavailableReason({
      ...RI, monthly_cost: null, scope_type: 'ManagementGroup',
    });
    expect(reason).toMatch(/management group/i);
  });

  it('names the subscription a single-scoped commitment is tied to', () => {
    const reason = costUnavailableReason({
      ...RI, monthly_cost: null, scope_type: 'Single', scopes: ['/subscriptions/aaa'],
    });
    expect(reason).toMatch('/subscriptions/aaa');
  });

  it('falls back to the role when it cannot tell from the scope', () => {
    const reason = costUnavailableReason({ ...RI, monthly_cost: null, scope_type: '', scopes: [] });
    expect(reason).toMatch(/Cost Management Reader/);
  });

  it('drops the how-it-was-worked-out notes when there is no figure', () => {
    // "Twelve times the monthly figure" under the words "Not available"
    // describes a calculation that never happened.
    const rows = rowsOf({ ...RI, monthly_cost: null, utilisation: {} });
    expect(rows['Monthly cost'].value).toBe(MISSING);
    expect(rows['Monthly cost'].note).toBe('');
    expect(rows['Yearly cost'].note).toBe('');
    expect(rows['Still to run'].note).toBe('');
    expect(rows['Wasted per year'].note).toBe('');
  });

  it('keeps those notes where the figures are real', () => {
    expect(rowsOf(RI)['Yearly cost'].note).toMatch(/not a quote/);
  });
});
