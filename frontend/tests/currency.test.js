/**
 * Amount formatting and the app-wide display currency.
 *
 * Two risks live here. The first is a call site that quietly ignores the
 * display currency, which would put a ₹ figure and a $ figure in the same
 * column. The second is worse: a figure converted but still labelled with the
 * currency it was billed in, which is undetectable by eye. Both are pinned.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  canConvert,
  convertAmount,
  currencySymbol,
  formatAmount,
  formatAmountFull,
  formatRate,
  getDisplayCurrency,
  setDisplayCurrency,
  setRates,
  subscribeCurrency,
} from '../src/utils/currency';
import { exactAmount } from '../src/utils/exact';

// One dollar buys this much of each. Deliberately unrounded so a conversion
// that silently used 1.0 could not pass.
const RATES = { USD: 1, INR: 80, EUR: 0.9, GBP: 0.8 };

afterEach(() => setDisplayCurrency(null));

describe('as billed, the default', () => {
  it('leaves every amount in the currency Azure invoiced it in', () => {
    expect(getDisplayCurrency()).toBe(null);
    expect(formatAmount(123456.789, 'INR')).toBe('₹1,23,456.79');
    expect(formatAmount(3204.56, 'USD')).toBe('USD 3,204.56');
  });

  it('keeps decimals, so a total reconciles against an invoice', () => {
    // "₹1,23,457" against an invoice reading ₹1,23,456.79 looks like a data
    // error rather than the rounding choice it actually is.
    expect(formatAmount(123456.79, 'INR')).toBe('₹1,23,456.79');
  });

  it('abbreviates for chart axes, which a full figure would overflow', () => {
    expect(formatAmount(123456.789, 'INR', true)).toBe('₹1.23 L');
    expect(formatAmount(3204.56, 'USD', true)).toBe('USD 3.20K');
  });
});

describe('a chosen display currency', () => {
  it('converts and relabels together, never one without the other', () => {
    // The failure this guards against is a converted number still wearing the
    // billed currency's symbol, which no reader could ever catch.
    setRates(RATES, { as_of: '2026-09-01' });
    setDisplayCurrency('USD');
    expect(formatAmount(8000, 'INR')).toBe('USD 100.00');
    expect(formatAmountFull(8000, 'INR')).toBe('USD 100.00');
  });

  it('converts through the dollar, so any pair works', () => {
    setRates(RATES);
    setDisplayCurrency('EUR');
    // 8000 INR is 100 USD is 90 EUR.
    expect(convertAmount(8000, 'INR').value).toBeCloseTo(90, 6);
    expect(convertAmount(8000, 'INR').currency).toBe('EUR');
  });

  it('leaves an amount alone when it is already in the display currency', () => {
    setRates(RATES);
    setDisplayCurrency('INR');
    expect(convertAmount(8000, 'INR')).toEqual({ value: 8000, currency: 'INR' });
  });

  it('brings two billing currencies onto one scale', () => {
    // The whole point: a tenant with a US and an Indian subscription had ₹ and
    // $ figures in the same table, and a total that added them together.
    setRates(RATES);
    setDisplayCurrency('USD');
    expect(formatAmount(8000, 'INR')).toBe('USD 100.00');
    expect(formatAmount(100, 'USD')).toBe('USD 100.00');
  });

  it('applies to unit rates as well as totals', () => {
    setRates(RATES);
    setDisplayCurrency('USD');
    expect(formatRate(80, 'INR')).toBe('USD 1.00');
  });

  it('applies to chart axis symbols', () => {
    setRates(RATES);
    setDisplayCurrency('USD');
    expect(currencySymbol('INR')).toBe('$');
  });
});

describe('when a rate is missing', () => {
  it('leaves the amount billed rather than inventing a conversion', () => {
    // A figure converted at a guessed rate is indistinguishable from a real
    // one. Refusing is the only honest option.
    setRates({ USD: 1, INR: 80 });
    setDisplayCurrency('JPY');
    expect(formatAmount(8000, 'INR')).toBe('₹8,000.00');
    expect(convertAmount(8000, 'INR').unconverted).toBe(true);
  });

  it('says in advance which currencies it can convert', () => {
    setRates({ USD: 1, INR: 80 });
    setDisplayCurrency('USD');
    expect(canConvert('INR')).toBe(true);
    expect(canConvert('JPY')).toBe(false);
  });
});

describe('the hover tooltip', () => {
  it('always shows what was billed, and says the figure above was converted', () => {
    // This is the one place that deliberately disagrees with the number beside
    // it, because it exists to be checked against an invoice — and an invoice
    // is issued in the billed currency.
    setRates(RATES);
    setDisplayCurrency('USD');
    expect(exactAmount(8000, 'INR'))
      .toBe('INR 8,000.00 as billed — shown above converted to USD');
  });

  it('says nothing extra when no conversion is in force', () => {
    expect(exactAmount(8000, 'INR')).toBe('INR 8,000.00');
  });
});

describe('propagating a change', () => {
  it('notifies subscribers, which is what re-renders the page', () => {
    // Formatting happens in plain functions that never see props, so without
    // this every figure would keep its old currency until a navigation.
    const seen = vi.fn();
    const stop = subscribeCurrency(seen);
    setDisplayCurrency('USD');
    expect(seen).toHaveBeenCalledTimes(1);
    stop();
    setDisplayCurrency('EUR');
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('remembers the choice so it survives a reload', () => {
    setDisplayCurrency('EUR');
    expect(getDisplayCurrency()).toBe('EUR');
  });

  it('still works where storage is unavailable', () => {
    // Private browsing and blocked third-party storage both throw here. Losing
    // the preference across reloads is acceptable; crashing every amount on
    // the page is not.
    expect(() => setDisplayCurrency('USD')).not.toThrow();
    expect(getDisplayCurrency()).toBe('USD');
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
