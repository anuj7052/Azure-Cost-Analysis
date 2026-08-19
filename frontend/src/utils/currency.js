// Format amount directly — Azure returns cost in the account's billing currency.
// If billing currency is INR, we get INR directly. No manual conversion needed.
// `currency` param comes from API response (e.g. "INR", "USD").

const SYMBOLS = { INR: '₹', USD: '$', EUR: '€', GBP: '£', JPY: '¥' };

/**
 * Compact ("₹1.24L") or exact ("₹1,23,456.79") amounts, app-wide.
 *
 * Abbreviating keeps tables readable but is useless when someone is checking a
 * figure against an invoice, and a hover tooltip is easy to miss and impossible
 * to compare side by side. So the choice belongs to the user rather than being
 * decided for them at render time.
 *
 * Held at module scope, not in React state, because every formatting call site
 * is a plain function — including chart axis formatters that never see props.
 */
const MODE_KEY = 'amount-display';
export const COMPACT = 'compact';
export const EXACT = 'exact';

let _mode = (() => {
  try {
    return localStorage.getItem(MODE_KEY) === EXACT ? EXACT : COMPACT;
  } catch {
    return COMPACT;
  }
})();

export function getAmountMode() {
  return _mode;
}

export function setAmountMode(mode) {
  _mode = mode === EXACT ? EXACT : COMPACT;
  try {
    localStorage.setItem(MODE_KEY, _mode);
  } catch {
    // A blocked localStorage only costs the preference across reloads.
  }
  return _mode;
}

/** Short prefix for chart axes, where a full formatted amount is too wide. */
export function currencySymbol(currency) {
  const cur = (currency || 'INR').toUpperCase();
  return SYMBOLS[cur] || `${cur} `;
}

/**
 * @param {number|null} amount
 * @param {string} currency
 * @param {boolean} forceCompact  Chart axes have a fixed width that a full
 *   figure overflows, so they opt out of the exact mode explicitly.
 */
export function formatAmount(amount, currency, forceCompact = false) {
  if (amount == null) return '—';

  // Treat missing currency as INR (most Indian Azure accounts bill in INR)
  const cur = (currency || 'INR').toUpperCase();

  if (_mode === EXACT && !forceCompact) {
    return formatAmountFull(amount, currency);
  }

  if (cur === 'INR') {
    return formatINRRaw(amount);
  }

  // Any other currency: show with currency code
  if (amount >= 1_000_000) return `${cur} ${(amount / 1_000_000).toFixed(2)}M`;
  if (amount >= 1_000)     return `${cur} ${(amount / 1_000).toFixed(2)}K`;
  return `${cur} ${amount.toFixed(2)}`;
}

// For backward-compat where currency isn't passed yet — assumes INR
export function formatINR(amount) {
  if (amount == null) return '—';
  return formatINRRaw(amount);
}

function formatINRRaw(inr) {
  if (inr >= 10_000_000) return `₹${(inr / 10_000_000).toFixed(2)} Cr`;
  if (inr >= 100_000)    return `₹${(inr / 100_000).toFixed(2)} L`;
  if (inr >= 1_000)      return `₹${(inr / 1_000).toFixed(2)}K`;
  return `₹${inr.toFixed(2)}`;
}

/**
 * A per-unit rate.
 *
 * Rates are tiny — a GB of egress is fractions of a rupee — so the two-decimal
 * formatting used for totals rounds most of them to "₹0.00", which reads as
 * "free" when it is nothing of the sort. Precision is therefore extended until
 * the figure actually carries information.
 */
export function formatRate(amount, currency) {
  if (amount == null) return '—';

  const value = Number(amount);
  if (!Number.isFinite(value)) return '—';

  const cur = (currency || 'INR').toUpperCase();
  const sym = cur === 'INR' ? '₹' : `${cur} `;

  if (value === 0) return `${sym}0`;

  // Two decimals suffice above a hundredth; below it they would show nothing,
  // so enough decimals are kept to reach the first significant digit.
  const decimals = Math.abs(value) >= 0.01
    ? 2
    : Math.min(8, Math.ceil(-Math.log10(Math.abs(value))) + 2);

  return `${sym}${value.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: decimals,
  })}`;
}

/**
 * The whole amount, grouped, with two decimals.
 *
 * Decimals are kept rather than rounded to whole units: a total that reads
 * "₹1,23,457" cannot be reconciled against an invoice showing ₹1,23,456.79,
 * and the mismatch looks like a data error rather than a rounding choice.
 */
export function formatAmountFull(amount, currency) {
  if (amount == null) return '—';
  const cur = (currency || 'INR').toUpperCase();
  const sym = cur === 'INR' ? '₹' : `${cur} `;
  return `${sym}${Number(amount).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
