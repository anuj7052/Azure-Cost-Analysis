import { describe, it, expect } from 'vitest';
import { monthRange, exactDays, dashboardFilters, dashboardPayload } from '../src/utils/billingDashboard';

describe('billing dashboard dates', () => {
  it('counts exact inclusive dates rather than whole touched months', () => {
    expect(exactDays('2026-10-16', '2026-11-16')).toBe(32);
    expect(exactDays('2026-10-16', '2026-10-16')).toBe(1);
    expect(exactDays('2026-11-16', '2026-10-16')).toBeNull();
    expect(exactDays('', '')).toBeNull();
  });
  it('handles calendar month lengths and leap years', () => {
    expect(monthRange(2024, 2)).toEqual({ from: '2024-02-01', to: '2024-02-29' });
    expect(monthRange(2026, 11).to).toBe('2026-11-30');
  });
  it('restores deep linked filters and does not accept a caller-supplied workspace role', () => {
    const filters = dashboardFilters(new URLSearchParams('mode=range&from=2026-10-16&to=2026-11-16&source=invoices&currency=INR&role=admin&owner_id=2'));
    expect(dashboardPayload(filters)).toEqual({ from_date: '2026-10-16', to_date: '2026-11-16', source: 'invoices', currency: 'INR', customer_id: '' });
  });
});

import { rollingRange } from '../src/utils/billingDashboard';
describe('rolling billing periods', () => {
  it('covers whole months back from the current one', () => {
    const now = new Date(2026, 9, 19);
    expect(rollingRange(1, now)).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(rollingRange(3, now)).toEqual({ from: '2026-08-01', to: '2026-10-31' });
    expect(rollingRange(12, now)).toEqual({ from: '2025-11-01', to: '2026-10-31' });
  });
});
