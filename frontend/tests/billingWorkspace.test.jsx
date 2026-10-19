import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { BillingTopbar } from '../src/components/billing-ui/workspace';

vi.mock('../src/store/useTheme', () => ({ useTheme: selector => selector({ theme: 'light', toggleTheme: vi.fn() }) }));
vi.mock('../src/store/useNav', () => ({ useNav: selector => selector({ openNav: vi.fn() }) }));

describe('standalone billing shell', () => {
  it('provides mobile navigation, no theme switch and no misleading cloud scope filters', () => {
    const html = renderToStaticMarkup(<MemoryRouter><BillingTopbar /></MemoryRouter>);
    expect(html).toContain('Open navigation');
    expect(html).not.toContain('Switch to dark mode');
    expect(html).toContain('Azure Billing');
    expect(html).not.toContain('Search resources');
    expect(html).not.toContain('No subscription');
  });
});
