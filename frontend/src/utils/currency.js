// Format amount directly — Azure returns cost in the account's billing currency.
// If billing currency is INR, we get INR directly. No manual conversion needed.
// `currency` param comes from API response (e.g. "INR", "USD").

const FALLBACK_USD_TO_INR = 84; // only used if currency info is missing

const SYMBOLS = { INR: '₹', USD: '$', EUR: '€', GBP: '£', JPY: '¥' };

/** Short prefix for chart axes, where a full formatted amount is too wide. */
export function currencySymbol(currency) {
  const cur = (currency || 'INR').toUpperCase();
  return SYMBOLS[cur] || `${cur} `;
}

export function formatAmount(amount, currency) {
  if (amount == null) return '—';

  // Treat missing currency as INR (most Indian Azure accounts bill in INR)
  const cur = (currency || 'INR').toUpperCase();

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

export function formatAmountFull(amount, currency) {
  if (amount == null) return '—';
  const cur = (currency || 'INR').toUpperCase();
  const sym = cur === 'INR' ? '₹' : cur + ' ';
  return `${sym}${Math.round(amount).toLocaleString('en-IN')}`;
}
