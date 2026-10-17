import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import BoqDashboard from '../src/components/Boq/BoqDashboard';

vi.mock('recharts', async original => ({ ...await original(), ResponsiveContainer: ({ children }) => children }));

const report = {
  currency: 'INR', months: 1, perMonth: false, budgetFactor: 1, budgetTotal: 31000, actualTotal: 200, variance: -30800, variancePct: -93.5,
  categories: [{ key: 'compute', label: 'Compute', budgeted: 31000, actual: 200, variance: -30800 }], notInBoq: [], notInBoqTotal: 0, extraTotal: 0,
};
const days = [
  { date: '2026-08-01', total: 100, by_service: { VM: 70, Storage: 30 } },
  { date: '2026-08-02', total: 100, by_service: { VM: 60, Storage: 40 } },
];

it('renders the chart-type switcher and hides a plan line far above spend', () => {
  const html = renderToStaticMarkup(<BoqDashboard report={report} months={[{ month: '2026-08', total_cost: 200 }]} days={days} rows={[]} />);
  for (const label of ['Stacked bars', 'Stacked area', 'Total line', 'Bars', 'Running total']) expect(html).toContain(label);
  expect(html).toContain('Show plan line');
  expect(html).toContain('Hidden by default');
  expect(html).not.toContain('Biggest spend by category');
});
