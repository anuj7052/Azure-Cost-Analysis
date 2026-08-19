import { formatAmount } from '../../utils/currency';
import { exactAmount, formatQuantity, describeHours } from '../../utils/exact';

/**
 * A monetary amount: compact on screen, exact on hover.
 *
 * Tables and KPI tiles cannot fit full figures, so every amount is abbreviated.
 * That is fine for scanning and useless for reconciling, which is why the exact
 * value stays one hover away instead of being discarded at render time.
 *
 * `title` is deliberate rather than a custom tooltip: it works on every element,
 * survives inside table cells and SVG, needs no positioning logic, and is the
 * one tooltip a screen reader and a keyboard user both already get.
 */
export function Amount({ value, currency, className = '', full = false }) {
  const text = full
    ? exactAmount(value, currency)
    : formatAmount(value, currency);

  return (
    <span className={`tabular-nums ${className}`} title={exactAmount(value, currency)}>
      {text}
    </span>
  );
}

/**
 * A metered quantity, with the duration spelled out when it is measured in hours.
 *
 * "744" is meaningless at a glance and reads like a cost. "744 Hours (31 days)"
 * answers the question the number is actually being consulted for: whether the
 * resource ran for the whole month or only part of it.
 */
export function Quantity({ value, unit, className = '' }) {
  const hint = describeHours(value, unit);

  return (
    <span className={`tabular-nums ${className}`} title={hint || undefined}>
      {formatQuantity(value, unit)}
    </span>
  );
}

export default Amount;
