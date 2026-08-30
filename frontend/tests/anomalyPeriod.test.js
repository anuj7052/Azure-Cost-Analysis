/**
 * The period picker on the Anomalies page.
 *
 * These are date-arithmetic tests, which is exactly where a billing page gets
 * quietly wrong: a month boundary off by one day silently drops or double
 * counts a day of spend, and nothing on screen looks broken.
 */
import { describe, it, expect } from 'vitest';
import {
  ROLLING_MONTHS, daysInMonth, monthOptions, monthBounds, monthOf,
  periodValue, periodLabel, todayIso, rangeError, rangeUsable,
} from '../src/utils/anomalyView';

describe('month lengths', () => {
  it('knows the ordinary ones', () => {
    expect(daysInMonth(2026, 1)).toBe(31);
    expect(daysInMonth(2026, 4)).toBe(30);
    expect(daysInMonth(2026, 12)).toBe(31);
  });

  it('knows February in a common year', () => {
    expect(daysInMonth(2026, 2)).toBe(28);
  });

  it('knows February in a leap year', () => {
    // Getting this wrong drops 29 February's spend from the comparison.
    expect(daysInMonth(2024, 2)).toBe(29);
  });

  it('applies the century rule', () => {
    expect(daysInMonth(1900, 2)).toBe(28);
    expect(daysInMonth(2000, 2)).toBe(29);
  });
});

describe('the list of months offered', () => {
  const today = new Date(2026, 7, 30); // 30 August 2026, local time

  it('starts at the current month', () => {
    expect(monthOptions(today, 12)[0]).toEqual({ value: '2026-08', label: 'August 2026' });
  });

  it('runs backwards', () => {
    const opts = monthOptions(today, 3);
    expect(opts.map((o) => o.value)).toEqual(['2026-08', '2026-07', '2026-06']);
  });

  it('crosses the year boundary correctly', () => {
    const opts = monthOptions(today, 12);
    expect(opts).toHaveLength(12);
    expect(opts[7].value).toBe('2026-01');
    expect(opts[8]).toEqual({ value: '2025-12', label: 'December 2025' });
    expect(opts[11].value).toBe('2025-09');
  });

  it('does not skip a month when today is the 31st', () => {
    // Naive month arithmetic on a Date lands 31 March minus one month on
    // 3 March, which drops February from the list entirely.
    const opts = monthOptions(new Date(2026, 2, 31), 3);
    expect(opts.map((o) => o.value)).toEqual(['2026-03', '2026-02', '2026-01']);
  });
});

describe('turning a month into a date range', () => {
  it('covers the whole month', () => {
    expect(monthBounds('2026-08')).toEqual({ from: '2026-08-01', to: '2026-08-31' });
  });

  it('ends a 30 day month on the 30th', () => {
    expect(monthBounds('2026-04')).toEqual({ from: '2026-04-01', to: '2026-04-30' });
  });

  it('handles a leap February', () => {
    expect(monthBounds('2024-02')).toEqual({ from: '2024-02-01', to: '2024-02-29' });
  });

  it('zero pads single digit months', () => {
    expect(monthBounds('2026-01')).toEqual({ from: '2026-01-01', to: '2026-01-31' });
  });

  it('rejects nonsense rather than guessing', () => {
    expect(monthBounds('')).toBeNull();
    expect(monthBounds(null)).toBeNull();
    expect(monthBounds('2026-13')).toBeNull();
    expect(monthBounds('2026-00')).toBeNull();
    expect(monthBounds('August 2026')).toBeNull();
  });
});

describe('recognising a stored range as a whole month', () => {
  it('recognises one', () => {
    expect(monthOf('2026-08-01', '2026-08-31')).toBe('2026-08');
  });

  it('does not call a partial month a month', () => {
    // The picker would otherwise label 1-15 August as "August 2026", which
    // overstates what the figures cover.
    expect(monthOf('2026-08-01', '2026-08-15')).toBeNull();
  });

  it('does not call a mid month start a month', () => {
    expect(monthOf('2026-08-05', '2026-08-31')).toBeNull();
  });

  it('does not call a multi month span a month', () => {
    expect(monthOf('2026-07-01', '2026-08-31')).toBeNull();
  });

  it('is safe on missing input', () => {
    expect(monthOf(null, null)).toBeNull();
    expect(monthOf('2026-08-01', null)).toBeNull();
  });
});

describe('what the picker shows for the current state', () => {
  it('reports a rolling window', () => {
    expect(periodValue('rolling', 6, null, null)).toBe('rolling:6');
    expect(periodLabel('rolling', 6, null, null)).toBe('Last 6 months');
  });

  it('reports a whole month', () => {
    expect(periodValue('custom', 6, '2026-08-01', '2026-08-31')).toBe('month:2026-08');
    expect(periodLabel('custom', 6, '2026-08-01', '2026-08-31')).toBe('August 2026');
  });

  it('reports an arbitrary range as custom rather than snapping it', () => {
    expect(periodValue('custom', 6, '2026-08-03', '2026-08-19')).toBe('custom');
    expect(periodLabel('custom', 6, '2026-08-03', '2026-08-19')).toBe('2026-08-03 to 2026-08-19');
  });

  it('survives custom mode with no dates set', () => {
    expect(periodValue('custom', 6, null, null)).toBe('custom');
    expect(periodLabel('custom', 6, null, null)).toBe('Custom range');
  });

  it('round trips every offered month', () => {
    for (const opt of monthOptions(new Date(2026, 7, 30), 12)) {
      const b = monthBounds(opt.value);
      expect(periodValue('custom', 6, b.from, b.to)).toBe(`month:${opt.value}`);
    }
  });

  it('offers only rolling windows the store already supports', () => {
    expect(ROLLING_MONTHS).toEqual([3, 6, 12]);
    for (const n of ROLLING_MONTHS) {
      expect(periodValue('rolling', n, null, null)).toBe(`rolling:${n}`);
    }
  });
});

describe('validating a hand-picked date range', () => {
  const today = new Date(2026, 7, 30); // 30 August 2026

  it('accepts a sane range', () => {
    expect(rangeError('2026-06-01', '2026-08-15', today)).toBeNull();
    expect(rangeUsable('2026-06-01', '2026-08-15', today)).toBe(true);
  });

  it('accepts a single day', () => {
    expect(rangeError('2026-08-10', '2026-08-10', today)).toBeNull();
  });

  it('accepts a range ending today', () => {
    expect(rangeError('2026-08-01', '2026-08-30', today)).toBeNull();
  });

  it('asks for both dates before either is usable', () => {
    expect(rangeError('', '', today)).toMatch(/both/i);
    expect(rangeError('2026-08-01', '', today)).toMatch(/both/i);
    expect(rangeError(null, '2026-08-01', today)).toMatch(/both/i);
  });

  it('rejects a backwards range', () => {
    expect(rangeError('2026-08-20', '2026-08-01', today)).toMatch(/after/i);
  });

  it('rejects a start date in the future', () => {
    // Azure has no billing data for tomorrow. Allowing it returns an empty
    // result, which on this page reads as "nothing changed".
    expect(rangeError('2026-09-01', '2026-09-30', today)).toMatch(/future/i);
    expect(rangeUsable('2026-09-01', '2026-09-30', today)).toBe(false);
  });

  it('allows an end date past today, because the current month is still running', () => {
    // The month preset for August offers 1-31 while today is the 30th. The
    // backend returns data up to the last billed day and the page labels the
    // window as partial, so this is a real request, not a mistake.
    expect(rangeError('2026-08-01', '2026-08-31', today)).toBeNull();
  });

  it('rejects malformed dates', () => {
    expect(rangeError('01/08/2026', '2026-08-30', today)).toMatch(/valid/i);
    expect(rangeError('2026-8-1', '2026-08-30', today)).toMatch(/valid/i);
  });

  it('reports today in the local timezone', () => {
    // Built from local parts rather than toISOString(), which would roll back
    // a day for anyone west of UTC and silently forbid picking today.
    expect(todayIso(new Date(2026, 0, 5))).toBe('2026-01-05');
    expect(todayIso(new Date(2026, 11, 31))).toBe('2026-12-31');
  });

  it('accepts every whole month the picker offers', () => {
    for (const opt of monthOptions(today, 12)) {
      const b = monthBounds(opt.value);
      expect(rangeError(b.from, b.to, today)).toBeNull();
    }
  });
});
