/**
 * Amount formatting and the compact/exact display mode.
 *
 * The mode is app-wide and lives outside React, so the risk is a call site that
 * quietly ignores it — or a chart axis that respects it and overflows. Both are
 * pinned here.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  COMPACT,
  EXACT,
  formatAmount,
  formatAmountFull,
  formatRate,
  getAmountMode,
  setAmountMode,
} from '../src/utils/currency';

afterEach(() => setAmountMode(COMPACT));

describe('compact mode', () => {
  it('abbreviates so a table column stays readable', () => {
    setAmountMode(COMPACT);
    expect(formatAmount(123456.789, 'INR')).toBe('₹1.23 L');
    expect(formatAmount(3204.56, 'USD')).toBe('USD 3.20K');
  });
});

describe('exact mode', () => {
  it('shows the whole grouped figure instead of an abbreviation', () => {
    setAmountMode(EXACT);
    expect(formatAmount(123456.789, 'INR')).toBe('₹1,23,456.79');
    expect(formatAmount(3204.56, 'USD')).toBe('USD 3,204.56');
  });

  it('keeps decimals, so a total reconciles against an invoice', () => {
    // "₹1,23,457" against an invoice reading ₹1,23,456.79 looks like a data
    // error rather than the rounding choice it actually is.
    setAmountMode(EXACT);
    expect(formatAmount(123456.79, 'INR')).toBe('₹1,23,456.79');
  });

  it('never applies to chart axes, which a full figure would overflow', () => {
    setAmountMode(EXACT);
    expect(formatAmount(123456.789, 'INR', true)).toBe('₹1.23 L');
  });
});

describe('mode persistence', () => {
  it('remembers the choice so it survives a reload', () => {
    setAmountMode(EXACT);
    expect(getAmountMode()).toBe(EXACT);
  });

  it('falls back to compact for an unrecognised value', () => {
    setAmountMode('nonsense');
    expect(getAmountMode()).toBe(COMPACT);
  });

  it('still works where storage is unavailable', () => {
    // Private browsing and blocked third-party storage both throw here. Losing
    // the preference across reloads is acceptable; crashing every amount on the
    // page is not.
    expect(() => setAmountMode(EXACT)).not.toThrow();
    expect(getAmountMode()).toBe(EXACT);
  });
});

describe('rates', () => {
  it('never rounds a real rate away to zero', () => {
    // ₹0.0912 per GB shown as "₹0.09" is fine, but ₹0.004 shown as "₹0.00"
    // reads as free — which is how these figures came to look blank.
    expect(formatRate(0.004, 'INR')).toBe('₹0.004');
    expect(formatRate(0.00012, 'INR')).toBe('₹0.00012');
  });

  it('keeps ordinary rates at two decimals', () => {
    expect(formatRate(0.09, 'INR')).toBe('₹0.09');
    expect(formatRate(7.5, 'USD')).toBe('USD 7.50');
  });

  it('distinguishes a genuine zero from a missing rate', () => {
    // "no charge" and "not measured" are different claims.
    expect(formatRate(0, 'INR')).toBe('₹0');
    expect(formatRate(null, 'INR')).toBe('—');
  });
});

describe('missing amounts', () => {
  it('shows a dash rather than a zero that was never charged', () => {
    expect(formatAmount(null, 'INR')).toBe('—');
    expect(formatAmountFull(null, 'INR')).toBe('—');
  });
});
