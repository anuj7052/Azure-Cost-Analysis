import { expect, it } from 'vitest';
import { calendarMonths } from '../src/utils/boqCompare';

it('counts the calendar months selected, not Azure billing-month labels', () => {
  expect(calendarMonths('2026-08-01', '2026-08-31')).toBe(1);
  expect(calendarMonths('2026-08-16', '2026-09-15')).toBe(2);
  expect(calendarMonths('2026-11-01', '2027-01-31')).toBe(3);
});
