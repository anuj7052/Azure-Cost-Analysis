/**
 * Exact-value helpers.
 *
 * These back the hover tooltips people use to reconcile a figure against an
 * Azure invoice, so the failure that matters is a number that looks right and
 * is not. The rounding rules and the hours->days conversion are pinned here.
 */
import { describe, expect, it } from 'vitest';

import {
  describeHours,
  displayUnit,
  exactAmount,
  formatQuantity,
  hoursToDuration,
} from '../src/utils/exact';

describe('exactAmount', () => {
  it('keeps the precision the compact form throws away', () => {
    // ₹1.24L on screen must still reconcile to the paise behind it.
    expect(exactAmount(123456.789, 'INR')).toBe('INR 1,23,456.789');
  });

  it('names the currency, because the symbol alone is what people misread', () => {
    expect(exactAmount(10, 'USD')).toBe('USD 10.00');
    expect(exactAmount(10, 'INR')).toBe('INR 10.00');
  });

  it('does not round sub-cent meter rates away', () => {
    // Azure prices per-unit at fractions of a cent. Rounding to 2dp here would
    // make a large-quantity line item fail to match the portal.
    expect(exactAmount(0.0001234, 'USD')).toBe('USD 0.0001');
  });

  it('says "not billed" rather than showing a zero that was never charged', () => {
    // A missing price means the query returned nothing for this resource; that
    // is not the same claim as "this costs nothing".
    expect(exactAmount(null, 'USD')).toBe('Not billed in this period');
  });
});

describe('hoursToDuration', () => {
  it('reads a full month of compute as whole days', () => {
    expect(hoursToDuration(744, 'Hours')).toBe('31 days');
    expect(hoursToDuration(672, 'Hours')).toBe('28 days');
    expect(hoursToDuration(720, 'Hours')).toBe('30 days');
  });

  it("names Azure's 730-hour month instead of reporting 30.4 days", () => {
    // 730 = 365 * 24 / 12. It is the figure reservation pricing is quoted
    // against, so a full-month meter would otherwise look like an oddity.
    expect(hoursToDuration(730, 'Hours')).toBe('1 month');
  });

  it('marks a rounded day count so it is not copied as exact', () => {
    // 100h is 4.1666… days. Printing a bare "4.2 days" invites it into a
    // reconciliation as though it were the billed figure.
    expect(hoursToDuration(100, 'Hours')).toBe('~4.2 days');
  });

  it('keeps a single day singular', () => {
    expect(hoursToDuration(24, 'Hours')).toBe('1 day');
  });

  it('describes a part-day in hours, since days-with-decimals says less', () => {
    expect(hoursToDuration(6, 'Hours')).toBe('6.0 hours');
  });

  it('refuses to convert units that are not time', () => {
    // Converting 744 GB into "31 days" would be a fabrication.
    expect(hoursToDuration(744, 'GB')).toBeNull();
    expect(hoursToDuration(744, 'Transactions')).toBeNull();
    expect(hoursToDuration(744, 'GB/Month')).toBeNull();
  });

  it('refuses to convert when the unit is unknown', () => {
    // Bandwidth meters are GB and frequently carry no unit string. Treating a
    // missing unit as hours turned data volume into a day count, which is
    // simply false — the unit has to positively identify hours.
    expect(hoursToDuration(744, '')).toBeNull();
    expect(hoursToDuration(744, null)).toBeNull();
    expect(hoursToDuration(744, undefined)).toBeNull();
  });

  it('accepts the several ways Azure spells the hour unit', () => {
    expect(hoursToDuration(48, 'Hours')).toBe('2 days');
    expect(hoursToDuration(48, '1 Hour')).toBe('2 days');
    expect(hoursToDuration(48, '10 Hours')).toBe('2 days');
  });

  it('ignores quantities that cannot represent elapsed time', () => {
    expect(hoursToDuration(0, 'Hours')).toBeNull();
    expect(hoursToDuration(-5, 'Hours')).toBeNull();
    expect(hoursToDuration(null, 'Hours')).toBeNull();
  });
});

describe('formatQuantity', () => {
  it('spells out the duration behind an hour count', () => {
    // "744" alone reads like a cost; the day count is the answer people want.
    expect(formatQuantity(744, 'Hours')).toBe('744 Hours (31 days)');
    expect(formatQuantity(730, 'Hours')).toBe('730 Hours (1 month)');
  });

  it('can omit the duration where two quantities are already compared', () => {
    // "372.08 Hours (~15.5 days) -> 500.5 Hours (~20.9 days)" puts four numbers
    // in one cell to say what two would.
    expect(formatQuantity(372.084, '1 Hour', { duration: false })).toBe('372.08 Hours');
  });

  it("tidies Azure's \"1 Hour\" unit so two numbers do not collide", () => {
    // Raw, this renders as "372.08 1 Hour", which reads like a typo.
    expect(formatQuantity(372.084, '1 Hour')).toBe('372.08 Hours (~15.5 days)');
  });

  it('leaves non-time units exactly as billed', () => {
    expect(formatQuantity(512, 'GB')).toBe('512 GB');
  });

  it('leaves an unlabelled quantity as a plain number', () => {
    // A bandwidth meter with no unit must read "744", never "744 (31 days)".
    expect(formatQuantity(744, '')).toBe('744');
    expect(formatQuantity(744, null)).toBe('744');
  });

  it('marks a missing quantity rather than printing zero', () => {
    expect(formatQuantity(null, 'Hours')).toBe('—');
  });
});


describe('describeHours', () => {
  it('shows the division, not just its result', () => {
    // "~20.9 days" invites the question "from what?". A derived figure with no
    // working shown cannot be checked.
    const text = describeHours(500.5, '1 Hour');

    expect(text).toContain('500.5 hours ÷ 24 hours per day');
    expect(text).toContain('= 20.8542 days');
    expect(text).toContain('shown as ~20.9 days');
  });

  it("explains where Azure's 730-hour month comes from", () => {
    const text = describeHours(730, 'Hours');

    expect(text).toContain('365 days × 24 hours ÷ 12 months');
    expect(text).toContain('30.4167 days');
  });

  it('says outright when a resource ran the whole month', () => {
    expect(describeHours(744, 'Hours')).toContain('ran for the full period');
  });

  it('has nothing to explain for a non-time unit', () => {
    expect(describeHours(512, 'GB')).toBeNull();
  });
});

describe('displayUnit', () => {
  it('strips the leading count Azure puts in the unit', () => {
    expect(displayUnit('1 Hour')).toBe('Hours');
    expect(displayUnit('10 Hours')).toBe('Hours');
    expect(displayUnit('1 GB')).toBe('GB');
  });

  it('leaves a plain unit alone', () => {
    expect(displayUnit('GB')).toBe('GB');
    expect(displayUnit('')).toBe('');
  });
});
