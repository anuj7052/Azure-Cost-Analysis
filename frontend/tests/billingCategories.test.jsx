import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { BILLING_CATEGORIES, billingCategoryUrl, billingCategory } from '../src/utils/billingCategories';
import { migrateExplorerView } from '../src/utils/monthCompare';

vi.mock('../src/store/useAppStore', () => ({ useAppStore: () => ({ selectedTenantId: 'tenant', selectedSubscriptionIds: ['sub'], subscriptions: [], months: 3, imported: false }) }));
vi.mock('../src/api/client', () => ({ fetchBillingCategory: vi.fn() }));
import BillingCategoryDetails from '../src/components/Charts/BillingCategoryDetails';

describe('billing category navigation', () => {
  it('opens the PAYG view and preserves it through Explorer view migration', () => {
    const params = new URLSearchParams(billingCategoryUrl().split('?')[1]);
    expect(migrateExplorerView({ tab: params.get('tab') }).tab).toBe('billing');
    expect(params.get('category')).toBe('payg');
    expect(billingCategory('unknown').key).toBe('payg');
  });
  it('renders just the three category filters and restores a deep-linked choice', () => {
    expect(BILLING_CATEGORIES.map(item => item.key)).toEqual(['payg', 'ri', 'asr']);
    const html = renderToStaticMarkup(<MemoryRouter initialEntries={['/explorer?tab=billing&category=ri']}><BillingCategoryDetails /></MemoryRouter>);
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('RI details');
    expect(html).toContain('DR / ASR');
    expect(html).not.toContain('<select');
    expect(html).not.toContain('Search name');
    expect(html).toContain('not amortized cost');
  });
});
