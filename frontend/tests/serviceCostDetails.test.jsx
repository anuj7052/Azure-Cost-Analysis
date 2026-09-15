import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import ServiceCostDetails from '../src/components/Charts/ServiceCostDetails';
vi.mock('../src/components/Charts/ServiceMeterChanges', () => ({ default: () => null }));

it('shows service-specific amounts, not whole-estate totals, and offers meter explanation', () => {
  const html = renderToStaticMarkup(<ServiceCostDetails currency="USD" query={{ tenant_id: 't' }} periods={[
    { month: '2026-07', total_cost: 100, by_service: { Storage: 80, Bandwidth: 20 } },
    { month: '2026-08', total_cost: 150, by_service: { Storage: 110, Bandwidth: 40 } },
  ]} />);
  expect(html).toContain('Storage · USD 190.00 in range');
  expect(html).toContain('+USD 30.00');
  expect(html).toContain('Explain usage, rates &amp; meter changes');
  expect(html).not.toContain('USD 250.00');
});

it('does not invent a prior month when only one month was returned', () => {
  const html = renderToStaticMarkup(<ServiceCostDetails currency="USD" periods={[
    { month: '2026-08', total_cost: 20, by_service: { Bandwidth: 20 } },
  ]} />);
  expect(html).toContain('Previous calendar period unavailable');
  expect(html).toContain('Bandwidth service vs transfer report');
});
