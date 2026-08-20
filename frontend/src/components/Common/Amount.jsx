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
 * A metered quantity, optionally with the duration an hour count represents.
 *
 * `showDuration` is off where the comparison is already about two quantities:
 * "372.08 Hours (~15.5 days) → 500.5 Hours (~20.9 days)" puts four numbers in
 * one cell to say what two would. The day count earns its place on a single
 * figure, not on both sides of an arrow.
 */
export function Quantity({ value, unit, className = '', showDuration = true }) {
  const hint = showDuration ? describeHours(value, unit) : null;
  const text = showDuration
    ? formatQuantity(value, unit)
    : formatQuantity(value, unit, { duration: false });

  return (
    <span
      className={`tabular-nums ${hint ? 'cursor-help decoration-dotted decoration-slate-600 underline underline-offset-4' : ''} ${className}`}
      title={hint || undefined}
    >
      {text}
    </span>
  );
}

export default Amount;
