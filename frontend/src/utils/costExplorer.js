/**
 * A cost view the reader assembles themselves.
 *
 * The old Cost Trend chart answered exactly one question -- what did the whole
 * estate cost each month -- and every other question meant asking somebody to
 * open the Azure portal. The questions people actually arrive with are more
 * specific than that and there is no way to guess which one: cost by resource
 * group for one service, daily instead of monthly, the top five meters, this
 * subscription only. So the view is described by a small configuration object
 * and built here, and the reader can keep the ones they will want again.
 *
 * Everything in this file is a pure function of the data already on the page.
 * A view is a way of reading the numbers, never a second source of them, so a
 * saved view cannot drift away from what the rest of the app reports.
 */

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** The dimensions a view can be grouped or filtered by. */
export const DIMENSIONS = [
  { key: 'none', label: 'Total only', field: null },
  { key: 'service', label: 'Service', field: 'service' },
  { key: 'subscription', label: 'Subscription', field: 'subscription_id' },
  { key: 'resource_group', label: 'Resource group', field: 'resource_group' },
  { key: 'meter', label: 'Meter', field: 'meter' },
  { key: 'region', label: 'Region', field: 'region' },
  { key: 'resource', label: 'Resource', field: 'resource_name' },
];

export const CHART_TYPES = [
  { key: 'area', label: 'Area' },
  { key: 'bar', label: 'Column' },
  { key: 'line', label: 'Line' },
];

export const GRANULARITIES = [
  { key: 'monthly', label: 'Monthly' },
  { key: 'daily', label: 'Daily' },
];

/** The view a reader gets before they have chosen anything. */
export function defaultView() {
  return {
    name: '',
    granularity: 'monthly',
    chart: 'area',
    groupBy: 'service',
    // Ten is enough to see a shape and few enough to keep the legend readable.
    // Everything beyond it is summed into "Other" rather than dropped, so the
    // stack still adds up to the total the rest of the page reports.
    topN: 10,
    stacked: true,
    filters: {},
  };
}

const fieldOf = (key) => DIMENSIONS.find(d => d.key === key)?.field || null;

/**
 * Repair a view read back from storage.
 *
 * Saved views outlive the code that wrote them. A view naming a dimension that
 * no longer exists must fall back to something that renders rather than
 * throwing on load and taking the whole page with it.
 */
export function normaliseView(raw) {
  const base = defaultView();
  if (!raw || typeof raw !== 'object') return base;

  const pick = (value, options, fallback) =>
    (options.some(o => o.key === value) ? value : fallback);

  const filters = {};
  for (const [key, values] of Object.entries(raw.filters || {})) {
    if (!fieldOf(key)) continue;
    const list = (Array.isArray(values) ? values : [values]).filter(Boolean).map(String);
    if (list.length) filters[key] = list;
  }

  return {
    ...base,
    name: typeof raw.name === 'string' ? raw.name.slice(0, 60) : '',
    id: raw.id,
    granularity: pick(raw.granularity, GRANULARITIES, base.granularity),
    chart: pick(raw.chart, CHART_TYPES, base.chart),
    groupBy: pick(raw.groupBy, DIMENSIONS, base.groupBy),
    topN: Number.isFinite(Number(raw.topN))
      ? Math.min(Math.max(Math.round(Number(raw.topN)), 1), 25)
      : base.topN,
    stacked: raw.stacked !== false,
    filters,
  };
}

/** Does this row survive the view's filters? Every filter must match. */
function passes(row, filters) {
  for (const [key, values] of Object.entries(filters || {})) {
    const field = fieldOf(key);
    if (!field) continue;
    if (!values.includes(String(row[field] ?? ''))) return false;
  }
  return true;
}

/**
 * The values available to filter on, with what each is currently costing.
 *
 * Built from the rows *after* the other filters are applied, so the options
 * offered are the ones that would actually change the picture. Offering a
 * resource group that holds nothing under the chosen service is an invitation
 * to an empty chart.
 */
export function filterOptions(rows, dimension, filters = {}) {
  const field = fieldOf(dimension);
  if (!field) return [];

  const others = Object.fromEntries(
    Object.entries(filters).filter(([key]) => key !== dimension),
  );

  const totals = new Map();
  for (const row of rows || []) {
    if (!passes(row, others)) continue;
    const value = String(row[field] ?? '');
    if (!value) continue;
    totals.set(value, (totals.get(value) || 0) + (Number(row.cost) || 0));
  }

  return [...totals.entries()]
    .map(([value, cost]) => ({ value, cost: round2(cost) }))
    .sort((a, b) => b.cost - a.cost);
}

/**
 * Build the series a chart can be drawn from.
 *
 * `rows` are the meter-level rows: one per month, per meter, carrying every
 * dimension. `days` are the daily totals, which carry only the service split --
 * so a daily view can be grouped by service or not at all, and asking for
 * anything finer gets an honest refusal instead of a chart built from a
 * dimension the data does not have.
 */
export function buildView(view, { rows = [], days = [], currency = 'INR' } = {}) {
  const v = normaliseView(view);
  const daily = v.granularity === 'daily';

  if (daily && !days.length) {
    return empty(v, currency, 'No daily cost data for the selected period.');
  }
  if (!daily && !rows.length) {
    return empty(v, currency, 'No cost data for the selected period.');
  }
  if (daily && !['none', 'service'].includes(v.groupBy)) {
    return empty(
      v, currency,
      'Azure reports daily cost split by service only. Group by service, or switch to monthly for the other dimensions.',
    );
  }

  const points = daily ? dailyPoints(v, days) : monthlyPoints(v, rows);
  return summarise(v, points, currency);
}

function empty(view, currency, note) {
  return { view, points: [], keys: [], total: 0, currency, note, truncated: 0 };
}

/** Monthly, from the meter rows — every dimension is available here. */
function monthlyPoints(view, rows) {
  const field = fieldOf(view.groupBy);
  const buckets = new Map();

  for (const row of rows) {
    if (!passes(row, view.filters)) continue;
    const period = String(row.month || '');
    if (!period) continue;
    const key = field ? (String(row[field] ?? '') || 'Unattributed') : 'Total';
    const bucket = buckets.get(period) || new Map();
    bucket.set(key, (bucket.get(key) || 0) + (Number(row.cost) || 0));
    buckets.set(period, bucket);
  }

  return toPoints(buckets);
}

/**
 * Daily, from the daily totals.
 *
 * The filters cannot be honoured here beyond service, because a day carries no
 * other dimension. Applying the ones it can and ignoring the rest would report
 * a filtered figure that is not filtered, so a daily view only ever filters on
 * service -- and `buildView` has already refused anything else.
 */
function dailyPoints(view, days) {
  const grouped = view.groupBy === 'service';
  const wanted = view.filters.service || null;
  const buckets = new Map();

  for (const day of days) {
    const period = String(day.date || '');
    if (!period) continue;
    const bucket = buckets.get(period) || new Map();

    if (grouped || wanted) {
      for (const [service, cost] of Object.entries(day.by_service || {})) {
        if (wanted && !wanted.includes(service)) continue;
        const key = grouped ? service : 'Total';
        bucket.set(key, (bucket.get(key) || 0) + (Number(cost) || 0));
      }
    } else {
      bucket.set('Total', (bucket.get('Total') || 0) + (Number(day.total) || 0));
    }

    buckets.set(period, bucket);
  }

  return toPoints(buckets);
}

function toPoints(buckets) {
  return [...buckets.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([period, bucket]) => ({ period, bucket }));
}

/**
 * Rank the series, fold the tail into "Other" and flatten for recharts.
 *
 * The tail is kept rather than cut. A chart whose stack is quietly missing a
 * third of the spend is worse than no chart, because it invites the reader to
 * add the visible bars up and believe the answer.
 */
function summarise(view, points, currency) {
  const totals = new Map();
  for (const { bucket } of points) {
    for (const [key, cost] of bucket) {
      totals.set(key, (totals.get(key) || 0) + cost);
    }
  }

  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const kept = ranked.slice(0, view.groupBy === 'none' ? 1 : view.topN).map(([key]) => key);
  const tail = ranked.slice(kept.length);
  const keptSet = new Set(kept);
  const keys = tail.length ? [...kept, 'Other'] : kept;

  const flat = points.map(({ period, bucket }) => {
    const point = { period, label: labelOf(period), total: 0 };
    for (const key of keys) point[key] = 0;
    for (const [key, cost] of bucket) {
      const target = keptSet.has(key) ? key : 'Other';
      point[target] = round2((point[target] || 0) + cost);
      point.total = round2(point.total + cost);
    }
    return point;
  });

  return {
    view,
    points: flat,
    keys,
    total: round2(flat.reduce((s, p) => s + p.total, 0)),
    currency,
    note: '',
    // How many series were folded away, so the legend can say so rather than
    // leaving "Other" to be read as a single mysterious line item.
    truncated: tail.length,
  };
}

/** "2026-07" reads as "Jul 26"; a date reads as "07 Jul". */
function labelOf(period) {
  const s = String(period);
  if (/^\d{4}-\d{2}$/.test(s)) {
    const d = new Date(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, 1);
    return d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime())
      ? s.slice(5)
      : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
  }
  return s;
}

/** One sentence describing what a view shows, for the saved-view list. */
export function describeView(view) {
  const v = normaliseView(view);
  const dimension = DIMENSIONS.find(d => d.key === v.groupBy)?.label || 'Total';
  const grain = v.granularity === 'daily' ? 'daily' : 'monthly';
  const filters = Object.entries(v.filters)
    .map(([key, values]) => {
      const label = DIMENSIONS.find(d => d.key === key)?.label || key;
      return values.length === 1
        ? `${label} is ${values[0]}`
        : `${label} is one of ${values.length}`;
    });

  const base = v.groupBy === 'none'
    ? `${grain} total`
    : `${grain}, by ${dimension.toLowerCase()}`;
  return filters.length ? `${base} — ${filters.join(', ')}` : base;
}

/**
 * Add a view to the saved list, or replace one of the same name.
 *
 * Replacing by name rather than refusing the save: somebody who saves "Prod
 * storage" twice means the second one, and a list with two entries of the same
 * name is a list nobody can use.
 */
export function saveView(saved, view) {
  const v = normaliseView(view);
  if (!v.name.trim()) return saved || [];
  const name = v.name.trim();
  const entry = { ...v, name, id: v.id || `${Date.now()}` };
  const rest = (saved || []).filter(s => s.name.trim() !== name);
  return [...rest, entry];
}

export function removeView(saved, id) {
  return (saved || []).filter(s => s.id !== id);
}

/*
 * Saved views live outside the API cache, deliberately.
 *
 * `persistCache` expires what it holds after a day and drops everything when
 * the browser's quota is hit. That is right for a cached cost query and wrong
 * for something the reader named and expects to find next week, so these get
 * their own key -- the same decision the Cost Explorer page already made for
 * its own saved views.
 */
const STORE_KEY = 'aca:views:analysis';

export function readSavedViews() {
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed.map(normaliseView) : [];
  } catch {
    return [];
  }
}

export function writeSavedViews(views) {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(views || []));
  } catch {
    /* storage unavailable or full — the views simply will not persist */
  }
}
