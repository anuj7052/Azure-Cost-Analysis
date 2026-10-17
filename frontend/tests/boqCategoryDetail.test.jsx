import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import BoqCategoryDetail from '../src/components/Boq/BoqCategoryDetail';

vi.mock('../src/utils/billingTypes', async original => {
  const real = await original();
  return { ...real, useBillingTypes: () => ({ loading: false, error: '', index: real.buildTypeIndex({
    ri: { rows: [{ resource_group: 'rg-app', meter: 'D4s v5' }] },
    payg: { rows: [{ resource_group: 'rg-dr', meter: 'Protected Instance' }] },
  }) }) };
});
vi.mock('../src/store/useAppStore', () => ({
  useAppStore: pick => pick({
    imported: false, pricingLoading: false, loadPricing: () => {},
    pricingData: { has_pricing_data: true, services: [
      { service: 'Virtual Machines', reserved: 300, on_demand: 100, savings_plan: 0 },
      { service: 'Azure Site Recovery', reserved: 0, on_demand: 40, savings_plan: 0 },
    ] },
  }),
}));

const fmt = v => `₹${Number(v).toFixed(2)}`;
const category = {
  key: 'compute', label: 'Compute', budgeted: 500, actual: 440, variance: -60, unmatchedTotal: 40, unused: false,
  lines: [{ id: 'a:0', custom_name: 'App VM', service_type: 'Virtual Machines', monthly_cost: 500, actual: 400, variance: -100, matched: true, billedCount: 2, budgetQty: 1, hasSku: true, matches: [{}] }],
  pooledLines: [],
  unmatched: [
    { id: 'x', label: 'Protected Instance', meter: 'Protected Instance', service: 'Azure Site Recovery', resource_name: 'dr-vm', resource_group: 'rg-dr', cost: 40 },
    { id: 'y', label: 'D4s v5', meter: 'D4s v5', service: 'Virtual Machines', resource_name: 'app-vm', resource_group: 'RG-APP', cost: 0.5 },
  ],
  actualServices: [{ name: 'Virtual Machines', cost: 400 }, { name: 'Azure Site Recovery', cost: 40 }],
};

it('explains covered, not-covered and RI/PAYG/ASR billing for a category', () => {
  const html = renderToStaticMarkup(<BoqCategoryDetail category={category} fmt={fmt} per="per month" />);
  expect(html).toContain('₹400.00</strong> matches lines in your estimate');
  expect(html).toContain('Not in BOQ');
  expect(html).toContain('dr-vm');
  expect(html).toContain('DR / ASR');
  expect(html).toContain('>RI<');
  expect(html).toContain('>PAYG<');
  expect(html).toContain('2 resources billed, 1 planned');
  expect(html).toContain('75%');
  expect(html).not.toContain('>Virtual Machines</span>');
  expect((html.match(/>RI</g) || []).length).toBeGreaterThanOrEqual(2);
  expect((html.match(/>PAYG</g) || []).length).toBeGreaterThanOrEqual(2);
  expect(html).toContain('25%');
});

it('explains the billing difference row without inventing resources', () => {
  const html = renderToStaticMarkup(<BoqCategoryDetail category={{ key: 'reconciliation', actual: 12 }} fmt={fmt} per="per month" />);
  expect(html).toContain('not a resource or a saving');
});

it('treats backup and site-recovery charges as compared with group lines, not as missing from the BOQ', () => {
  const html = renderToStaticMarkup(<BoqCategoryDetail category={{ ...category, key: 'backup', label: 'Backup', pooledBudget: 30, lines: [], pooledLines: [{ id: 'b:0', custom_name: 'ASR', service_type: 'Azure Site Recovery', monthly_cost: 30, hasSku: false, matches: [] }] }} fmt={fmt} per="per month" />);
  expect(html).toContain('Compared with your group lines');
  expect(html).toContain('Group line');
  expect(html).not.toContain('>Not in BOQ<');
  expect(html).toContain('₹10.00 over</strong> those lines');
});
