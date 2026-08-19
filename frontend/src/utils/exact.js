/**
 * Exact values behind the compact ones.
 *
 * Every amount on screen is abbreviated (₹1.24L, USD 3.20K) because full
 * figures do not fit in a table cell and make columns unreadable. That
 * abbreviation loses precision, which matters the moment somebody is
 * reconciling against an invoice — so the exact number has to stay reachable
 * on hover rather than being thrown away at render time.
 */

/** Hours in a day. Azure meters compute in hours, humans reason in days. */
const HOURS_PER_DAY = 24;

/**
 * Azure's standard billing month: 365 * 24 / 12. Reservation and savings-plan
 * pricing is quoted against this figure, so it turns up constantly and is worth
 * naming rather than reporting as an odd 30.4 days.
 */
const AZURE_MONTH_HOURS = 730;

/**
 * The full amount, unabbreviated, with its currency code.
 *
 * The currency code is always shown here even though the compact form uses a
 * symbol. A bill can be issued in USD while the reader assumes INR, and the
 * symbol alone ("$" vs "₹") is exactly the detail people misread when checking
 * a number against an invoice.
 *
 * Four decimals, not two: Azure meters price per-unit at fractions of a cent,
 * so rounding to two here would make a line item fail to reconcile against the
 * portal by a visible margin once quantities are large.
 */
export function exactAmount(amount, currency) {
  if (amount == null) return 'Not billed in this period';

  const cur = (currency || 'INR').toUpperCase();
  const exact = Number(amount).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });

  return `${cur} ${exact}`;
}

/**
 * Turn a metered hour count into the duration it represents.
 *
 * Azure bills compute in hours, so a full month reads as "744" — a number that
 * means nothing at a glance and is easily mistaken for a cost. Saying "31 days"
 * alongside it immediately answers the question people actually have: did this
 * thing run for the whole month, or only part of it?
 *
 * Returns null unless the unit explicitly says hours, so a GB or transaction
 * count is printed exactly as billed rather than being dressed up as a duration.
 */
export function hoursToDuration(hours, unit) {
  if (hours == null) return null;

  // The unit must positively identify hours. Treating a missing unit as
  // hour-based turned bandwidth meters — which are GB, and often carry no unit
  // string at all — into a day count, which is simply false.
  //
  // Azure spells the hour unit several ways: "Hours", "1 Hour", "10 Hours".
  if (!unit || !/hour/i.test(unit)) return null;

  const value = Number(hours);
  if (!Number.isFinite(value) || value <= 0) return null;

  // 730 is Azure's quoted month, not 30 days and 10 hours of real elapsed time.
  // Reporting the arithmetic instead of the convention makes a perfectly normal
  // full-month meter look like an oddity.
  if (value === AZURE_MONTH_HOURS) return '1 month';

  const days = value / HOURS_PER_DAY;

  // A whole number of days is the common case for anything that ran all month,
  // and it is the case worth stating plainly: 744 -> "31 days".
  if (Number.isInteger(days)) {
    return `${days} day${days === 1 ? '' : 's'}`;
  }

  // Under a day, days-with-decimals is less useful than the hours already
  // shown, so describe the part-day instead.
  if (days < 1) {
    return `${value.toFixed(1)} hours`;
  }

  // "~30 days" rather than "30 days": the tilde is what stops a rounded figure
  // being copied into a reconciliation as though it were exact.
  return `~${days.toFixed(1)} days`;
}

/**
 * A metered quantity with its unit, and the duration when that unit is hours.
 *
 * e.g. 744 hours -> "744 Hours (31 days)"
 *      512 GB    -> "512 GB"
 */
export function formatQuantity(quantity, unit) {
  if (quantity == null) return '—';

  const value = Number(quantity);
  const shown = Number.isFinite(value)
    ? value.toLocaleString('en-IN', { maximumFractionDigits: 2 })
    : String(quantity);

  const label = unit ? `${shown} ${unit}` : shown;
  const duration = hoursToDuration(quantity, unit);

  return duration ? `${label} (${duration})` : label;
}

/**
 * Explain a full-month hour count in a sentence, for tooltips.
 *
 * Month lengths differ, so "730 hours" is a full month in a 30-day month and
 * 20 hours short of one in a 31-day month. Stating the day count lets the
 * reader make that judgement instead of guessing.
 */
export function describeHours(hours, unit) {
  const duration = hoursToDuration(hours, unit);
  if (!duration) return null;

  const value = Number(hours);

  if (value === AZURE_MONTH_HOURS) {
    return `${hours} hours = Azure's standard month (730 h = 365 × 24 ÷ 12), about 30.4 days`;
  }

  const days = value / HOURS_PER_DAY;

  // A whole month of wall-clock time is the fact people are checking for:
  // did this resource run continuously, or only part of the period?
  if (Number.isInteger(days) && days >= 28 && days <= 31) {
    return `${hours} hours = ${duration} — ran for the full month`;
  }

  return `${hours} hours = ${duration}`;
}
