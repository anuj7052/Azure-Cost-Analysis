import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { billingMoney, billingMonth, customerRows, documentStatus, usefulBillingMonth } from '../src/utils/billingPresentation';
import { BillingPage, BillingEmpty } from '../src/components/billing-ui/workspace';

vi.mock('../src/store/useTheme', () => ({ useTheme: selector => selector({ theme: 'light', toggleTheme: vi.fn() }) }));
vi.mock('../src/store/useNav', () => ({ useNav: selector => selector({ openNav: vi.fn() }) }));

describe('finance-facing billing language', () => {
  it('never presents missing amounts as zero or paid', () => {
    expect(billingMoney(null)).toBe('Not entered');
    expect(billingMoney('')).toBe('Not entered');
    expect(billingMoney('0')).toContain('0.00');
    expect(billingMoney('-1234.50')).toContain('1,234.50');
    expect(documentStatus('confirmed')).toBe('Reviewed');
    expect(documentStatus('needs_review')).toBe('Check amounts');
    expect(documentStatus('void')).toBe('Excluded');
  });
  it('uses readable months without timezone-dependent day shifts', () => {
    expect(billingMonth('2026-10')).toBe('Oct 2026');
    expect(billingMonth('')).toBe('Month not entered');
  });
  it('filters customer attention without altering financial totals', () => {
    const rows = [{ name: 'Example', review_count: 2 }, { name: 'Other', unallocated_count: 1 }, { name: 'Complete', review_count: 0 }];
    expect(customerRows(rows, '', true)).toHaveLength(2);
    expect(customerRows(rows, '  EXAMPLE  ', true)).toEqual([rows[0]]);
    expect(rows).toHaveLength(3);
  });
  it('opens a month with data instead of a future empty slot and respects selected months', () => {
    const months = [
      { period: '2026-12', customer_amount: null, distributor_amount: null, review_count: 0 },
      { period: '2026-08', customer_amount: '100', distributor_amount: null, review_count: 1 },
      { period: '2026-09', customer_amount: '0', distributor_amount: '0', review_count: 0 },
    ];
    expect(usefulBillingMonth(months, '')).toBe('2026-09');
    expect(usefulBillingMonth(months, '', true)).toBe('2026-08');
    expect(usefulBillingMonth(months, '2026-12')).toBe('2026-12');
    expect(usefulBillingMonth([], '')).toBe('');
    expect(months[0].period).toBe('2026-12');
  });
  it('separates finance navigation from technical Azure filters', () => {
    const html = renderToStaticMarkup(<MemoryRouter initialEntries={['/azure-billing/settings']}><BillingPage title="Billing settings"><BillingEmpty title="No bills yet">Upload your first bill.</BillingEmpty></BillingPage></MemoryRouter>);
    expect(html).toContain('Dashboard');
    expect(html).toContain('Add entry');
    expect(html).toContain('Customers');
    expect(html).toContain('Settings');
    expect(html).toContain('aria-current="page"');
    expect(html).not.toContain('SubscriptionPicker');
    expect(html).toContain('No bills yet');
  });
});
