/**
 * Turning a list of classified cost changes into what the page shows.
 *
 * All of it is pure and lives outside React on purpose: filtering, searching,
 * sorting and paging are where a table quietly starts lying -- a KPI computed
 * from the unfiltered list above a table showing the filtered one is the most
 * common way a cost page loses a reader's trust. Keeping the pipeline in one
 * function means the cards, the chart and the rows are all derived from the
 * same array, and a test can prove it.
 *
 * Nothing here invents a number. Where a figure cannot be derived from the
 * data returned by Azure it is reported as null, and the page renders
 * "Not available" rather than a zero that reads like a measurement.
 */

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'none'];

export const STATUSES = ['new', 'investigating', 'acknowledged', 'resolved', 'ignored'];

export const SORT_IMPACT = 'impact';
export const SORT_PCT = 'pct';
export const SORT_CURRENT = 'current';
export const SORT_SERVICE = 'service';

export const DEFAULT_FILTERS = {
  severity: 'all',
  status: 'all',
  subscription: 'all',
  direction: 'all',
  search: '',
};

/**
 * Severity in words rather than a colour.
 *
 * A red dot tells somebody that a row matters but not why, and the "why" here
 * is always the same: how much of the bill this one change accounts for.
 */
export function severityLabel(severity) {
  switch (severity) {
    case 'critical': return 'Critical';
    case 'high': return 'High';
    case 'medium': return 'Medium';
    case 'low': return 'Low';
    default: return 'Not significant';
  }
}

export function severityHint(severity) {
  switch (severity) {
    case 'critical': return 'A large share of the total bill moved.';
    case 'high': return 'A noticeable share of the total bill moved.';
    case 'medium': return 'A small but real share of the total bill moved.';
    case 'low': return 'A very small share of the total bill moved.';
    default: return 'Too small to affect the bill.';
  }
}

export function directionLabel(direction) {
  switch (direction) {
    case 'increase': return 'Increased';
    case 'decrease': return 'Decreased';
    case 'new': return 'New cost';
    case 'removed': return 'Stopped';
    default: return 'No change';
  }
}

/**
 * What can honestly be said about why a cost moved.
 *
 * Billing data records that spend changed, never why. Anything stronger than
 * "this is consistent with" would be a guess presented as a finding, and a
 * wrong cause is more expensive than no cause because somebody acts on it.
 */
export function possibleCauses(row) {
  if (!row) return [];
  const causes = [];
  const qtyKnown = row.previous_quantity != null && row.current_quantity != null;

  if (row.direction === 'new') {
    causes.push('This cost did not exist in the previous period, which is consistent with something newly deployed or newly billed.');
  }
  if (row.direction === 'removed') {
    causes.push('This cost stopped during the current period, which is consistent with something deleted, stopped, or moved elsewhere.');
  }
  if (qtyKnown && row.current_quantity > row.previous_quantity * 1.05) {
    causes.push('Metered usage went up as well as cost, which is consistent with more consumption rather than a price change.');
  }
  if (qtyKnown && Math.abs(row.current_quantity - row.previous_quantity) <= row.previous_quantity * 0.05
      && Math.abs(row.delta) > 0) {
    causes.push('Cost moved while metered usage stayed close to flat, which is consistent with a rate, tier, discount or reservation change rather than more consumption.');
  }
  if (!causes.length) {
    causes.push('Cause could not be determined from available data.');
  }
  return causes;
}

function matchesSearch(row, needle) {
  if (!needle) return true;
  const q = needle.toLowerCase();
  return [
    row.service, row.resource_name, row.resource_group,
    row.subscription_name, row.subscription_id, row.region,
  ].some((v) => (v || '').toLowerCase().includes(q));
}

/** Apply every active filter. One function, so nothing can disagree. */
export function applyFilters(rows, filters = DEFAULT_FILTERS) {
  const f = { ...DEFAULT_FILTERS, ...filters };
  return (rows || []).filter((r) => {
    if (f.severity !== 'all' && r.severity !== f.severity) return false;
    if (f.status !== 'all' && (r.status || 'new') !== f.status) return false;
    if (f.subscription !== 'all' && r.subscription_id !== f.subscription) return false;
    if (f.direction !== 'all' && r.direction !== f.direction) return false;
    return matchesSearch(r, f.search);
  });
}

/**
 * Sort, defaulting to money.
 *
 * The old page ranked by percentage, which put a ₹101 increase above an
 * ₹18,000 one because the small number had grown 2000%. Percentage answers
 * "how unusual", amount answers "how much this costs you", and only the second
 * belongs at the top of a table somebody opens to decide what to do today.
 */
export function sortRows(rows, key = SORT_IMPACT, ascending = false) {
  const dir = ascending ? 1 : -1;
  const value = (r) => {
    switch (key) {
      case SORT_PCT: return r.pct_change == null ? -Infinity : r.pct_change;
      case SORT_CURRENT: return r.current_cost || 0;
      case SORT_SERVICE: return null;
      default: return Math.abs(r.delta || 0);
    }
  };
  return [...(rows || [])].sort((a, b) => {
    if (key === SORT_SERVICE) {
      return dir * String(a.service || '').localeCompare(String(b.service || ''));
    }
    return dir * (value(a) - value(b));
  });
}

export function paginate(rows, page, pageSize) {
  const list = rows || [];
  const total = Math.max(1, Math.ceil(list.length / pageSize));
  const safe = Math.min(Math.max(1, page), total);
  return {
    rows: list.slice((safe - 1) * pageSize, safe * pageSize),
    page: safe,
    totalPages: total,
    totalRows: list.length,
  };
}

/**
 * Headline figures for whatever is currently in view.
 *
 * `netChange` is deliberately signed and separate from the two totals: an
 * increase of ₹40,000 alongside a reduction of ₹39,000 is a very different
 * month from one with neither, and a single net figure hides both.
 */
export function summarise(rows) {
  const list = rows || [];
  if (!list.length) {
    // Null, not zero. Zero is a measurement; this is an absence of one.
    return {
      count: 0,
      increase: null,
      reduction: null,
      netChange: null,
      largest: null,
      needsAttention: 0,
    };
  }
  let increase = 0;
  let reduction = 0;
  let largest = null;
  for (const r of list) {
    const d = r.delta || 0;
    if (d > 0) increase += d;
    if (d < 0) reduction += -d;
    if (!largest || Math.abs(d) > Math.abs(largest.delta || 0)) largest = r;
  }
  return {
    count: list.length,
    increase,
    reduction,
    netChange: increase - reduction,
    largest,
    needsAttention: list.filter(
      (r) => (r.severity === 'critical' || r.severity === 'high')
        && !['resolved', 'ignored'].includes(r.status || 'new'),
    ).length,
  };
}

/** How many rows sit in each severity band, for the summary chart. */
export function severityCounts(rows) {
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  for (const r of rows || []) {
    if (counts[r.severity] != null) counts[r.severity] += 1;
  }
  return counts;
}

/**
 * Rows for export -- the filtered set, matching what is on screen.
 *
 * Exporting everything while the table shows a filtered view is how a
 * spreadsheet ends up contradicting the page it came from.
 */
export function toExportRows(rows, currency) {
  return (rows || []).map((r) => ({
    Service: r.service || '',
    Resource: r.resource_name || '',
    'Resource group': r.resource_group || '',
    Subscription: r.subscription_name || r.subscription_id || '',
    Region: r.region || '',
    Currency: currency || '',
    'Previous period cost': r.previous_cost ?? '',
    'Current period cost': r.current_cost ?? '',
    'Cost change': r.delta ?? '',
    'Percentage change': r.pct_change == null ? 'Not available' : r.pct_change.toFixed(1),
    Direction: directionLabel(r.direction),
    Severity: severityLabel(r.severity),
    Note: r.note || '',
    Status: r.status || 'new',
  }));
}

/** Filters as URL search params, so a filtered view can be sent to someone. */
export function filtersToParams(filters) {
  const params = {};
  for (const [k, v] of Object.entries({ ...DEFAULT_FILTERS, ...filters })) {
    if (v && v !== 'all') params[k] = v;
  }
  return params;
}

export function filtersFromParams(search) {
  const params = new URLSearchParams(search || '');
  const out = { ...DEFAULT_FILTERS };
  for (const key of Object.keys(DEFAULT_FILTERS)) {
    const value = params.get(key);
    if (value) out[key] = value;
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * Choosing the period being analysed.
 *
 * The period lives in the global store (the Topbar date pill writes it), but a
 * reader on this page is asking "did last month spike?" and should not have to
 * discover that the answer is controlled by a header control two sections
 * away. These helpers back an on-page picker that writes to the *same* store,
 * so the two controls cannot disagree.
 *
 * Dates are assembled as strings rather than via `new Date('2026-08-01')`,
 * which parses as UTC midnight and can land on the previous month once a
 * local timezone west of UTC is applied — an off-by-one month on a billing
 * page is not a cosmetic bug.
 * ------------------------------------------------------------------------ */

export const ROLLING_MONTHS = [3, 6, 12];

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const pad = (n) => String(n).padStart(2, '0');

/** Days in a month, honouring leap years. `month` is 1-based. */
export function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * The last `count` months, most recent first, as 'YYYY-MM'.
 *
 * `today` is injected so the list is testable; a helper that reads the clock
 * internally can only be tested by mocking time.
 */
export function monthOptions(today = new Date(), count = 12) {
  const out = [];
  let year = today.getFullYear();
  let month = today.getMonth() + 1; // 1-based
  for (let i = 0; i < count; i += 1) {
    out.push({ value: `${year}-${pad(month)}`, label: `${MONTH_NAMES[month - 1]} ${year}` });
    month -= 1;
    if (month === 0) { month = 12; year -= 1; }
  }
  return out;
}

/** 'YYYY-MM' -> the inclusive first and last day of that month. */
export function monthBounds(value) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(value || ''));
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return {
    from: `${year}-${pad(month)}-01`,
    to: `${year}-${pad(month)}-${pad(daysInMonth(year, month))}`,
  };
}

/** The reverse: a from/to pair that spans exactly one whole month, or null. */
export function monthOf(fromDate, toDate) {
  const f = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(fromDate || ''));
  if (!f || f[3] !== '01') return null;
  const value = `${f[1]}-${f[2]}`;
  const bounds = monthBounds(value);
  // A range starting on the 1st but ending mid-month is a custom range, not a
  // month — labelling it "August 2026" would overstate what is being compared.
  return bounds && bounds.to === toDate ? value : null;
}

/**
 * The value the on-page picker should show for the current store state.
 *
 * Returns `rolling:N`, `month:YYYY-MM`, or `custom` for a hand-picked range
 * that is not a whole month. `custom` is reported rather than silently
 * snapped to the nearest month so the picker never misdescribes the figures.
 */
export function periodValue(dateMode, months, fromDate, toDate) {
  if (dateMode !== 'custom') return `rolling:${months}`;
  const month = monthOf(fromDate, toDate);
  return month ? `month:${month}` : 'custom';
}

/** Plain-language description of the same state, for the picker's summary. */
export function periodLabel(dateMode, months, fromDate, toDate) {
  const value = periodValue(dateMode, months, fromDate, toDate);
  if (value.startsWith('rolling:')) {
    const n = Number(value.slice(8));
    return `Last ${n} months`;
  }
  if (value.startsWith('month:')) {
    const opt = monthBounds(value.slice(6));
    const [y, m] = value.slice(6).split('-');
    return opt ? `${MONTH_NAMES[Number(m) - 1]} ${y}` : 'Custom range';
  }
  return fromDate && toDate ? `${fromDate} to ${toDate}` : 'Custom range';
}

/* ---------------------------------------------------------------------------
 * A hand-picked from/to range.
 *
 * Validated before it is applied rather than after. An invalid range sent to
 * Cost Management comes back either as an error the reader has to decode or,
 * worse, as an empty result that looks like "no anomalies" — which is the one
 * answer this page must never give by accident.
 * ------------------------------------------------------------------------ */

/** Today as 'YYYY-MM-DD' in the reader's own timezone, for the `max` attribute. */
export function todayIso(today = new Date()) {
  return `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Why a from/to pair cannot be used, or null when it is fine.
 *
 * The message is what the reader sees, so it says what to do rather than
 * naming the rule that failed.
 */
export function rangeError(fromDate, toDate, today = new Date()) {
  if (!fromDate || !toDate) return 'Pick both a start and an end date.';
  if (!ISO_DATE.test(fromDate) || !ISO_DATE.test(toDate)) return 'Use a valid date.';
  if (fromDate > toDate) return 'The start date is after the end date.';
  // Only the *start* has to be in the past. An end date beyond today is normal
  // — picking the current month means asking for a month that is still
  // running — and Azure simply returns data up to the last billed day, which
  // the page already labels as a partial period. Rejecting it here would make
  // the month presets fail their own validation.
  if (fromDate > todayIso(today)) {
    return 'The start date is in the future — there is no billing data yet.';
  }
  return null;
}

/** Whether a from/to pair is safe to apply. */
export function rangeUsable(fromDate, toDate, today = new Date()) {
  return rangeError(fromDate, toDate, today) === null;
}
