// Format amount directly — Azure returns cost in the account's billing currency.
// If billing currency is INR, we get INR directly. No manual conversion needed.
// `currency` param comes from API response (e.g. "INR", "USD").

const SYMBOLS = { INR: '₹', USD: '$', EUR: '€', GBP: '£', JPY: '¥' };

/**
 * The display currency, and why converting at format time is the right place.
 *
 * An estate can bill in more than one currency — a tenant with a US and an
 * Indian subscription genuinely does — and the pages were happy to put ₹ and $
 * figures in the same table and, worse, in the same total. Adding two
 * currencies together produces a number that means nothing, and nothing on the
 * screen said so.
 *
 * So the reader picks one unit and every figure is converted into it. The
 * conversion happens in the formatter rather than in the store because the
 * store holds what Azure billed, which must stay exactly as invoiced: a
 * converted figure is a *view* of the money, not a restatement of it. Doing it
 * here also means one switch changes the entire application at once, including
 * chart axes, without refetching anything — there is nothing to refetch, since
 * the underlying amounts have not changed.
 *
 * Held at module scope, not in React state, because every formatting call site
 * is a plain function — including chart axis formatters that never see props.
 */
const DISPLAY_KEY = 'aca:display-currency';
const RATES_KEY = 'aca:fx-rates';

// `null` means "leave every amount in whatever currency Azure billed it in",
// which is the honest default and the only mode that needs no exchange rate.
let _display = (() => {
  try {
    return localStorage.getItem(DISPLAY_KEY) || null;
  } catch {
    return null;
  }
})();

// USD-based: `_rates[X]` is how many X one dollar buys. Seeded from the last
// response so a reload converts immediately rather than showing billed
// currency for a moment and then jumping.
let _rates = (() => {
  try {
    const raw = JSON.parse(localStorage.getItem(RATES_KEY) || 'null');
    return raw && typeof raw === 'object' ? raw : { USD: 1 };
  } catch {
    return { USD: 1 };
  }
})();

let _rateMeta = { as_of: '', stale: false, source: '' };

const _listeners = new Set();

/** Subscribe to display-currency changes. Returns an unsubscribe function. */
export function subscribeCurrency(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

function announce() {
  _listeners.forEach(fn => fn());
}

export function getDisplayCurrency() {
  return _display;
}

export function getRateMeta() {
  return { ..._rateMeta, rates: { ..._rates } };
}

/** Whether a currency can be converted into the current display unit. */
export function canConvert(currency) {
  const from = (currency || 'INR').toUpperCase();
  if (!_display || from === _display) return true;
  return Number.isFinite(_rates[from]) && Number.isFinite(_rates[_display]);
}

export function setDisplayCurrency(code) {
  _display = code ? String(code).toUpperCase() : null;
  try {
    if (_display) localStorage.setItem(DISPLAY_KEY, _display);
    else localStorage.removeItem(DISPLAY_KEY);
  } catch {
    // A blocked localStorage only costs the preference across reloads.
  }
  announce();
  return _display;
}

export function setRates(rates, meta = {}) {
  if (rates && typeof rates === 'object') {
    _rates = { USD: 1, ...rates };
    try {
      localStorage.setItem(RATES_KEY, JSON.stringify(_rates));
    } catch {
      /* the rates are re-fetched on the next load anyway */
    }
  }
  _rateMeta = {
    as_of: meta.as_of || '',
    stale: !!meta.stale,
    source: meta.source || '',
  };
  announce();
}

/**
 * An amount and the currency it should now be labelled with.
 *
 * When no rate exists for the pair, the amount is returned untouched and still
 * labelled with the currency it was billed in. That is deliberate: a figure
 * shown under the wrong symbol is worse than one that admits it could not be
 * converted, because only the second can be spotted.
 */
export function convertAmount(amount, currency) {
  const from = (currency || 'INR').toUpperCase();
  if (amount == null || !_display || from === _display) {
    return { value: amount, currency: from };
  }
  const fromRate = _rates[from];
  const toRate = _rates[_display];
  if (!Number.isFinite(fromRate) || !Number.isFinite(toRate) || !fromRate) {
    return { value: amount, currency: from, unconverted: true };
  }
  return { value: (Number(amount) / fromRate) * toRate, currency: _display };
}

/** Short prefix for chart axes, where a full formatted amount is too wide. */
export function currencySymbol(currency) {
  const cur = _display || (currency || 'INR').toUpperCase();
  return SYMBOLS[cur] || `${cur} `;
}

/**
 * @param {number|null} amount
 * @param {string} currency
 * @param {boolean} forceCompact  Chart axes have a fixed width that a full
 *   figure overflows, so they opt out of the full form explicitly.
 */
export function formatAmount(amount, currency, forceCompact = false) {
  if (amount == null) return '—';
  const { value, currency: cur } = convertAmount(amount, currency);

  if (!forceCompact) {
    return formatAmountFull(value, cur);
  }

  if (cur === 'INR') {
    return formatINRRaw(value);
  }

  // Any other currency: show with currency code
  const sym = `${cur} `;
  if (value >= 1_000_000) return `${sym}${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000)     return `${sym}${(value / 1_000).toFixed(2)}K`;
  return `${sym}${value.toFixed(2)}`;
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

  const converted = convertAmount(Number(amount), currency);
  const value = converted.value;
  if (!Number.isFinite(value)) return '—';

  const cur = converted.currency;
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
  const { value, currency: cur } = convertAmount(amount, currency);
  const sym = cur === 'INR' ? '₹' : `${cur} `;
  return `${sym}${Number(value).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
