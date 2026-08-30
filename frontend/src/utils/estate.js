import { formatAmount, formatAmountFull } from './currency';

/**
 * Every decision the Estate Command Center makes, with no React in sight.
 *
 * The page is an aggregation of eight existing datasets, and aggregation is
 * exactly where invented numbers creep in: a section that adds up four sources
 * and quietly treats the two that failed as zero produces a total that looks
 * authoritative and is wrong. So the rules live here, in plain functions, and
 * are tested directly — the project has no jsdom, and UI behaviour that cannot
 * be tested is UI behaviour that silently rots.
 *
 * One principle governs the whole file: absent, zero and unknown are three
 * different answers. `null` means nobody asked or Azure would not say; `0`
 * means we asked and the answer really was none. They never render the same.
 */

// ── vocabulary ─────────────────────────────────────────────────────────────
//
// Fixed strings, so a section cannot invent its own phrasing for "we don't
// know" and leave the reader guessing whether it means something different.

export const NOT_AVAILABLE = 'Not available';
export const INSUFFICIENT = 'Insufficient data';
export const NO_DATA = 'No data available';
export const UNAVAILABLE = 'Data unavailable';
export const NOT_LOADED = 'Not loaded yet';
export const NO_COST = 'Cost impact not available';

/** Tones the UI already understands. There is no `warning`. */
export const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

export function isNum(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** A count, or the honest absence of one. Zero is a real answer and survives. */
export function displayCount(value) {
  return isNum(value) ? value.toLocaleString() : null;
}

/** Money, abbreviated. `null` when the figure was never established. */
export function displayMoney(value, currency, exact = false) {
  if (!isNum(value)) return null;
  return exact ? formatAmountFull(value, currency) : formatAmount(value, currency);
}

/** A signed percentage. Returns `null` rather than pretending 0% was measured. */
export function displayPct(value, digits = 1) {
  if (!isNum(value)) return null;
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(digits)}%`;
}

/** Which way a number moved, without asserting a direction for a flat line. */
export function direction(changePct) {
  if (!isNum(changePct)) return 'unknown';
  if (changePct > 0.5) return 'up';
  if (changePct < -0.5) return 'down';
  return 'flat';
}

/** Rising cost is bad news; falling cost is good. Flat and unknown are neither. */
export function costTone(changePct) {
  const dir = direction(changePct);
  if (dir === 'up') return 'high';
  if (dir === 'down') return 'good';
  return 'neutral';
}

// ── resource taxonomy ──────────────────────────────────────────────────────
//
// Resource Graph reports types like `microsoft.compute/virtualmachines`. The
// prefix alone is not enough — `microsoft.compute` covers both VMs and disks,
// which belong in different buckets — so the full type is matched first and
// the provider is only a fallback.

const TYPE_CATEGORY = [
  [/^microsoft\.compute\/(virtualmachines|virtualmachinescalesets|availabilitysets)/, 'compute'],
  [/^microsoft\.compute\/(disks|snapshots|images|galleries)/, 'storage'],
  [/^microsoft\.storage\//, 'storage'],
  [/^microsoft\.(network|cdn)\//, 'network'],
  [/^microsoft\.(sql|dbforpostgresql|dbformysql|dbformariadb|documentdb|cache|sqlvirtualmachine)\//, 'database'],
  [/^microsoft\.web\//, 'appservice'],
  [/^microsoft\.(containerservice|containerregistry|containerinstance|app)\//, 'containers'],
  [/^microsoft\.(keyvault|security|insights|operationalinsights|aadiam)\//, 'security'],
];

export const CATEGORY_TITLE = {
  compute: 'Compute',
  storage: 'Storage',
  network: 'Network',
  database: 'Database',
  appservice: 'App Service',
  containers: 'Containers',
  security: 'Security',
  other: 'Other',
};

/** Where a page should land when the reader clicks a category. */
export const CATEGORY_ROUTE = {
  compute: '/compute',
  storage: '/orphaned',
  network: '/bandwidth',
  database: '/explorer',
  appservice: '/explorer',
  containers: '/explorer',
  security: '/security',
  other: '/resource-groups',
};

export function categoryOf(type) {
  const t = String(type || '').toLowerCase();
  if (!t) return 'other';
  for (const [pattern, category] of TYPE_CATEGORY) {
    if (pattern.test(t)) return category;
  }
  return 'other';
}

/** `microsoft.compute/virtualmachines` reads badly in a table. */
export function shortType(type) {
  const t = String(type || '');
  if (!t) return NOT_AVAILABLE;
  const tail = t.split('/').pop();
  return tail || t;
}

// ── section 7: resource inventory ──────────────────────────────────────────

/**
 * Counts and cost per category, from the live inventory the Services endpoint
 * already returns. Built from one Resource Graph query, not one call per
 * resource — the N+1 shape this page must never grow.
 *
 * `cost` is `null` where Cost Management reported nothing for any resource in
 * the category. Summing `null` as zero would claim the category is free.
 */
export function inventorySummary(services) {
  if (!Array.isArray(services)) return null;

  const buckets = new Map();
  for (const key of Object.keys(CATEGORY_TITLE)) {
    buckets.set(key, { key, title: CATEGORY_TITLE[key], to: CATEGORY_ROUTE[key], count: 0, cost: null, priced: 0 });
  }

  for (const resource of services) {
    const bucket = buckets.get(categoryOf(resource?.type));
    if (!bucket) continue;
    bucket.count += 1;
    if (isNum(resource?.cost)) {
      bucket.cost = (bucket.cost || 0) + resource.cost;
      bucket.priced += 1;
    }
  }

  const categories = [...buckets.values()].filter(b => b.count > 0);
  categories.sort((a, b) => b.count - a.count);
  return { categories, total: services.length };
}

// ── section 8: most expensive resources ────────────────────────────────────

/**
 * The priced resources only. A resource Cost Management never mentioned is not
 * "the cheapest" — it is unmeasured, and ranking it last would be a lie the
 * reader has no way of spotting.
 */
export function topResources(services, limit = 10) {
  if (!Array.isArray(services)) return null;
  const priced = services.filter(r => isNum(r?.cost) && r.cost > 0);
  priced.sort((a, b) => b.cost - a.cost);
  return {
    rows: priced.slice(0, limit),
    priced: priced.length,
    unpriced: services.length - priced.length,
  };
}

// ── the current month is not a month yet ───────────────────────────────────

/**
 * True when a `YYYY-MM` bucket is the calendar month we are standing in.
 *
 * Cost Management happily returns the current month, but on the 3rd of the
 * month that bucket holds three days of charges. Comparing it against a full
 * previous month reports a 90% saving that nobody made, and every section that
 * divides by it — cost efficiency, service shares, per-subscription change —
 * inherits the lie. So every comparison in this file is made between *complete*
 * months, and the running month is reported separately as month-to-date.
 */
export function isCurrentMonth(key, now = new Date()) {
  if (typeof key !== 'string') return false;
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  return key.slice(0, 7) === ym;
}

/**
 * The monthly series with a running, incomplete month removed.
 *
 * `dayWindow` switches the guard off. When the user explicitly asks for the
 * last 7 or 30 days, the period they chose *is* the period, and Cost
 * Management returns it as one or two partial month buckets. Dropping those
 * would blank the page to protect against a comparison nobody asked for.
 */
export function completeMonths(costData, { now = new Date(), dayWindow = false } = {}) {
  const months = Array.isArray(costData?.months) ? costData.months : [];
  if (dayWindow) return months;
  const last = months[months.length - 1];
  return isCurrentMonth(last?.month, now) ? months.slice(0, -1) : months;
}

// ── section 4: spend overview ──────────────────────────────────────────────

/**
 * The last complete month against the one before it, straight from the monthly
 * series Cost Management returned. A running month is carried separately as
 * `monthToDate` and never used as either side of a comparison.
 *
 * There is no forecast here and there must not be one until a real forecast
 * source exists. Extrapolating a trend line and labelling it a forecast is the
 * single most common way a FinOps dashboard starts lying to its owner.
 */
export function spendOverview(costData, opts = {}) {
  const months = Array.isArray(costData?.months) ? costData.months : null;
  if (!months || months.length === 0) return null;

  const series = months.map(m => ({ month: m.month, total: isNum(m.total_cost) ? m.total_cost : null }));

  const forecastNote = 'No forecast is shown. This application has no Azure forecast data source, and a projected line drawn from these points would be a guess, not a forecast.';

  // A day window is a period, not a month. Cost Management still returns it as
  // one or two partial month buckets, so the last bucket is seven days of
  // spend and the one before it is a whole month. Dividing one by the other
  // produces the −96% that this page exists to avoid, so the comparison is
  // refused outright rather than computed and captioned.
  if (opts.dayWindow) {
    const totals = series.filter(s => isNum(s.total));
    return {
      series,
      periodMode: true,
      current: totals.length ? totals.reduce((sum, s) => sum + s.total, 0) : null,
      currentMonth: null,
      previous: null,
      previousMonth: null,
      changePct: null,
      direction: null,
      monthToDate: null,
      monthToDateMonth: null,
      monthToDateNote: null,
      periodNote: 'This is the total for the days you selected. Cost Management has no equivalent earlier period to compare it against, so no change is shown — a short window measured against a whole month would read as a collapse in spend.',
      hasForecast: false,
      forecastNote,
      partial: Boolean(costData?.coverage?.partial),
    };
  }

  const complete = completeMonths(costData, opts);
  const running = complete.length < months.length ? series[series.length - 1] : null;

  // With only a running month there is no complete month to report, and
  // month-to-date is the honest headline rather than a pretend monthly bill.
  const usable = complete.length ? series.slice(0, complete.length) : series;
  const current = complete.length ? usable[usable.length - 1] : null;
  const previous = usable.length > 1 ? usable[usable.length - 2] : null;

  let changePct = null;
  if (current && previous && isNum(current.total) && isNum(previous.total) && previous.total > 0) {
    changePct = ((current.total - previous.total) / previous.total) * 100;
  }

  return {
    series,
    periodMode: false,
    current: current?.total ?? null,
    currentMonth: current?.month ?? null,
    previous: previous?.total ?? null,
    previousMonth: previous?.month ?? null,
    changePct,
    direction: direction(changePct),
    monthToDate: running?.total ?? null,
    monthToDateMonth: running?.month ?? null,
    // Explains, in the UI, why the headline month is not the current one.
    monthToDateNote: running
      ? `${running.month} is still in progress and is shown as month-to-date only. Comparisons use complete months so a partial month cannot look like a saving.`
      : null,
    periodNote: null,
    // Stated explicitly so a reader never wonders whether the flat right-hand
    // edge of the chart is a projection.
    hasForecast: false,
    forecastNote,
    partial: Boolean(costData?.coverage?.partial),
  };
}

// ── section 5: cost by service ─────────────────────────────────────────────

/**
 * Service spend for the latest month, with each service's share and its
 * month-over-month move.
 *
 * The change is computed from the two monthly buckets rather than taken from
 * `top_services`, because that list is ordered by the whole window and a
 * service that only appeared last month is missing from it entirely.
 */
export function serviceBreakdown(costData, limit = 8, opts = {}) {
  const all = Array.isArray(costData?.months) ? costData.months : null;
  if (!all || all.length === 0) return null;

  // A day window spans one or two partial month buckets. The user asked for a
  // period, so the buckets are summed into that period and the change column
  // is dropped — there is no earlier equivalent period to compare against.
  if (opts.dayWindow) {
    const merged = new Map();
    for (const m of all) {
      for (const [name, cost] of Object.entries(m?.by_service || {})) {
        if (isNum(cost)) merged.set(name, (merged.get(name) || 0) + cost);
      }
    }
    const total = [...merged.values()].reduce((sum, v) => sum + v, 0);
    const rows = [...merged.entries()]
      .map(([name, cost]) => ({
        name,
        cost,
        previous: null,
        share: total > 0 ? (cost / total) * 100 : null,
        changePct: null,
        isNew: false,
      }))
      .sort((a, b) => b.cost - a.cost);
    return { rows: rows.slice(0, limit), total, month: null, periodMode: true, counted: rows.length };
  }

  // A running month would report every service as down ~95% purely because the
  // month is young, so the breakdown is taken from complete months.
  const usable = completeMonths(costData, opts);
  const months = usable.length ? usable : all;

  const latest = months[months.length - 1];
  const prior = months.length > 1 ? months[months.length - 2] : null;
  const byService = latest?.by_service || {};
  const priorByService = prior?.by_service || {};

  const total = Object.values(byService).reduce((sum, v) => sum + (isNum(v) ? v : 0), 0);

  const rows = Object.entries(byService)
    .filter(([, cost]) => isNum(cost))
    .map(([name, cost]) => {
      const before = priorByService[name];
      // No previous month, or a previous month of zero, means there is no
      // percentage to state. A jump from nothing is not "+100%".
      const changePct = prior && isNum(before) && before > 0
        ? ((cost - before) / before) * 100
        : null;
      return {
        name,
        cost,
        previous: prior && isNum(before) ? before : null,
        share: total > 0 ? (cost / total) * 100 : null,
        changePct,
        isNew: Boolean(prior) && !isNum(before),
      };
    });

  rows.sort((a, b) => b.cost - a.cost);
  return { rows: rows.slice(0, limit), total, month: latest?.month || null, periodMode: false, counted: rows.length };
}

// ── section 9: biggest cost changes ────────────────────────────────────────

/** The comparison filters the changes table offers. */
export const CHANGE_FILTERS = [
  { value: 'all', label: 'All changes' },
  { value: 'increased', label: 'Increased' },
  { value: 'decreased', label: 'Decreased' },
  { value: 'new', label: 'New services' },
  { value: 'removed', label: 'Stopped billing' },
];

/**
 * Where the bill actually moved, by absolute amount rather than percentage.
 *
 * Sorting by percentage puts a meter that went from ₹2 to ₹6 above one that
 * went from ₹40,000 to ₹55,000, which is the opposite of useful.
 *
 * Two months are needed for a comparison, and a brand-new subscription has
 * only one. Returning `null` in that case left the panel blank, which reads as
 * a failure rather than as "there is nothing yet to compare against". So a
 * single month is reported as a single month — `mode: 'single'`, the services
 * billed in it, and no invented change column.
 *
 * `opts.from` and `opts.to` let the caller compare any two months the response
 * contains. They default to the two most recent *complete* months; a running
 * month is offered in the list but is never chosen for you, so nobody ends up
 * comparing 26 days against 31 by accident.
 */
export function biggestChanges(costData, limit = 8, opts = {}) {
  const all = Array.isArray(costData?.months) ? costData.months : null;
  if (!all || all.length === 0) return null;

  const filter = opts.filter || 'all';
  const byKey = new Map(all.filter(m => m?.month).map(m => [m.month, m]));
  const allKeys = [...byKey.keys()].sort();
  const completeKeys = (opts.dayWindow ? [] : completeMonths(costData, opts))
    .map(m => m.month)
    .filter(Boolean);

  const servicesOf = (key) => (key ? (byKey.get(key)?.by_service || {}) : {});

  const base = {
    // Every month the response contains, so the UI can offer them all.
    months: allKeys,
    completeMonths: completeKeys,
    filter,
  };

  // A day window is one or two partial month buckets that together make up the
  // period the user asked for. Summing them is the only honest reading; the
  // buckets are not comparable with each other.
  if (opts.dayWindow) {
    const merged = new Map();
    for (const m of all) {
      for (const [name, cost] of Object.entries(m?.by_service || {})) {
        if (isNum(cost)) merged.set(name, (merged.get(name) || 0) + cost);
      }
    }
    const rows = [...merged.entries()]
      .map(([name, cost]) => ({
        name, current: cost, previous: null, delta: null, changePct: null,
        appeared: false, disappeared: false,
      }))
      .sort((a, b) => b.current - a.current);
    return {
      ...base, mode: 'single', periodMode: true, partialMonth: false,
      rows: rows.slice(0, limit), from: null, to: null,
      counted: rows.length, matched: rows.length,
    };
  }

  const to = (opts.to && byKey.has(opts.to))
    ? opts.to
    : (completeKeys[completeKeys.length - 1] || allKeys[allKeys.length - 1] || null);

  let from = null;
  if (opts.from === '') {
    // The UI's explicit "No comparison" choice. Distinct from not asking.
    from = null;
  } else if (opts.from && byKey.has(opts.from) && opts.from !== to) {
    from = opts.from;
  } else {
    // Either nothing was asked for, or the month asked for is not in this
    // response — widening the header range must not strand the table on a
    // month the new response no longer contains.
    const pool = completeKeys.includes(to) ? completeKeys : allKeys;
    const idx = pool.indexOf(to);
    from = idx > 0 ? pool[idx - 1] : null;
  }

  const partialMonth = Boolean(to) && !completeKeys.includes(to);

  // Only one month exists — a new subscription, or a one-month window. Report
  // it rather than reporting nothing.
  if (!from) {
    const rows = Object.entries(servicesOf(to))
      .filter(([, cost]) => isNum(cost))
      .map(([name, cost]) => ({
        name, current: cost, previous: null, delta: null, changePct: null,
        appeared: false, disappeared: false,
      }))
      .sort((a, b) => b.current - a.current);
    return {
      ...base, mode: 'single', periodMode: false, partialMonth,
      rows: rows.slice(0, limit), from: null, to,
      counted: rows.length, matched: rows.length,
    };
  }

  const latest = servicesOf(to);
  const prior = servicesOf(from);
  const names = new Set([...Object.keys(latest), ...Object.keys(prior)]);

  const rows = [];
  for (const name of names) {
    const now = latest[name];
    const before = prior[name];
    const current = isNum(now) ? now : 0;
    const past = isNum(before) ? before : 0;
    const delta = current - past;
    if (Math.abs(delta) < 0.01) continue;
    rows.push({
      name,
      current: isNum(now) ? now : null,
      previous: isNum(before) ? before : null,
      delta,
      changePct: past > 0 ? (delta / past) * 100 : null,
      appeared: !isNum(before),
      disappeared: !isNum(now),
    });
  }

  const matches = (row) => {
    switch (filter) {
      case 'increased': return row.delta > 0;
      case 'decreased': return row.delta < 0;
      case 'new': return row.appeared;
      case 'removed': return row.disappeared;
      default: return true;
    }
  };

  const filtered = rows.filter(matches);
  filtered.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  return {
    ...base,
    mode: 'compare',
    periodMode: false,
    partialMonth,
    rows: filtered.slice(0, limit),
    from,
    to,
    // `counted` is every service that moved; `matched` is how many survived
    // the filter, so an empty table can say which of the two it is.
    counted: rows.length,
    matched: filtered.length,
  };
}

// ── cost anomalies ─────────────────────────────────────────────────────────

/**
 * Grades a cost anomaly by how much money actually moved as well as by how far
 * it moved in percentage terms.
 *
 * The backend detector fires on any service above a percentage threshold and
 * attaches no severity, because percentage alone cannot tell them apart: a
 * ₹4 meter that tripled and a ₹40,000 service that rose 25% are both "spikes"
 * and only one of them is worth waking up for. Both axes are required here, so
 * the rupee amount is never inferred from the percentage or the other way
 * round.
 */
export function anomalySeverity(pctChange, delta) {
  if (!isNum(pctChange)) return 'low';
  const moved = isNum(delta) ? Math.abs(delta) : null;
  // Without a rupee figure the percentage is all there is, and it is not
  // enough to justify a high grade on its own.
  if (moved === null) return pctChange >= 100 ? 'medium' : 'low';
  if (pctChange >= 100 && moved >= 5000) return 'critical';
  if (pctChange >= 50 && moved >= 1000) return 'high';
  if (moved >= 500) return 'medium';
  return 'low';
}

/**
 * A compact restatement of the anomalies the cost module already detected.
 * Nothing is detected here.
 */
export function anomalySummary(costData, limit = 5) {
  const raw = Array.isArray(costData?.anomalies) ? costData.anomalies : null;
  if (!raw) return null;

  const rows = raw.map((a) => {
    const current = isNum(a.current_cost) ? a.current_cost : null;
    const previous = isNum(a.prev_cost) ? a.prev_cost : null;
    const delta = isNum(current) && isNum(previous) ? current - previous : null;
    return {
      key: `${a.service}::${a.month}`,
      service: a.service || NOT_AVAILABLE,
      month: a.month || null,
      previousMonth: a.prev_month || null,
      changePct: isNum(a.pct_change) ? a.pct_change : null,
      current,
      previous,
      delta,
      severity: anomalySeverity(a.pct_change, delta),
      reason: a.reason || null,
    };
  });

  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const row of rows) counts[row.severity] += 1;

  rows.sort((a, b) => (SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
    || ((isNum(b.delta) ? Math.abs(b.delta) : -1) - (isNum(a.delta) ? Math.abs(a.delta) : -1)));

  return { rows: rows.slice(0, limit), counts, total: rows.length };
}

// ── Azure Advisor ──────────────────────────────────────────────────────────

/**
 * Advisor's own recommendations, counted by its own severity and category.
 *
 * The saving is summed only across the recommendations where Azure actually
 * published `annual_saving` — Advisor attaches one to Cost recommendations and
 * to nothing else. Recommendations without a figure are counted separately
 * rather than folded in as zero, because a total that silently includes 400
 * unpriced items reads as "Advisor says we can save ₹X" when it does not.
 */
export function advisorSnapshot(advisor) {
  if (!advisor) return null;
  const findings = Array.isArray(advisor.findings) ? advisor.findings : [];

  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  const categories = new Map();
  let saving = null;
  let priced = 0;
  let currency = null;

  for (const f of findings) {
    const severity = SEVERITY_RANK[f?.severity] !== undefined ? f.severity : 'low';
    if (counts[severity] !== undefined) counts[severity] += 1;
    const category = f?.category || 'Uncategorised';
    categories.set(category, (categories.get(category) || 0) + 1);
    if (isNum(f?.annual_saving)) {
      saving = (saving ?? 0) + f.annual_saving;
      priced += 1;
      currency = currency || f.currency || null;
    }
  }

  return {
    total: findings.length,
    counts,
    categories: [...categories.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count),
    // Null, not zero, when Advisor priced nothing.
    annualSaving: saving,
    savingCurrency: currency,
    priced,
    unpriced: findings.length - priced,
    partial: Array.isArray(advisor.errors) && advisor.errors.length > 0,
  };
}

// ── resource groups ────────────────────────────────────────────────────────

/**
 * Top resource groups by cost, from the existing `/costs/rg` aggregation.
 *
 * The change column comes from that endpoint's own `by_month` buckets, so no
 * second Azure query is made and no figure is derived twice.
 */
export function resourceGroupSummary(rgData, services, limit = 8, opts = {}) {
  const groups = Array.isArray(rgData?.resource_groups) ? rgData.resource_groups : null;
  if (!groups) return null;

  // Resource counts come from the inventory that is already loaded. Where it
  // has not arrived, the column is absent rather than zero.
  const counts = new Map();
  const haveInventory = Array.isArray(services);
  for (const r of (haveInventory ? services : [])) {
    const name = (r?.resource_group || '').toLowerCase();
    if (!name) continue;
    counts.set(name, (counts.get(name) || 0) + 1);
  }

  const rows = groups.map((g) => {
    const byMonth = g?.by_month && typeof g.by_month === 'object' ? g.by_month : {};
    const keys = Object.keys(byMonth).sort();
    // The same running-month rule as everywhere else in this file. There is no
    // fallback to the partial month when only one complete month exists: a
    // 26-day bucket compared against a 31-day one reads as a 96% collapse, and
    // that is the single most misleading number this page could print.
    const monthKeys = opts.dayWindow
      ? keys
      : keys.filter(k => !isCurrentMonth(k, opts.now || new Date()));
    const current = monthKeys.length ? byMonth[monthKeys[monthKeys.length - 1]] : null;
    const previous = monthKeys.length > 1 ? byMonth[monthKeys[monthKeys.length - 2]] : null;

    return {
      name: g?.rg_name || NOT_AVAILABLE,
      // The whole-window total, kept for reference and for ordering.
      total: isNum(g?.total) ? g.total : null,
      current: isNum(current) ? current : null,
      previous: isNum(previous) ? previous : null,
      changePct: isNum(current) && isNum(previous) && previous > 0
        ? ((current - previous) / previous) * 100
        : null,
      resources: haveInventory ? (counts.get((g?.rg_name || '').toLowerCase()) || 0) : null,
      month: monthKeys[monthKeys.length - 1] || null,
    };
  });

  rows.sort((a, b) => (isNum(b.total) ? b.total : -1) - (isNum(a.total) ? a.total : -1));
  return {
    rows: rows.slice(0, limit),
    total: rows.length,
    haveInventory,
    currency: rgData?.currency || null,
  };
}

// ── compute summary ────────────────────────────────────────────────────────

/**
 * A restatement of the Compute Intelligence fleet summary. Every figure is read
 * straight from that module's response — nothing is recomputed, and where it
 * declined to publish a figure this returns null rather than a zero.
 */
export function computeSummary(compute) {
  const summary = compute?.summary;
  const vms = Array.isArray(compute?.vms) ? compute.vms : null;
  if (!summary && !vms) return null;

  const countVerdict = (verdict) => (vms
    ? vms.filter(v => v?.verdict === verdict).length
    : null);

  const num = (v) => (isNum(v) ? v : null);

  return {
    total: num(summary?.total),
    running: num(summary?.running),
    deallocated: num(summary?.deallocated),
    stopped: num(summary?.stopped),
    // "Could not measure" is a finding in its own right, not an absence.
    telemetryUnavailable: num(summary?.telemetry_unavailable),
    telemetryMeasured: num(summary?.telemetry_measured),
    oversized: countVerdict('underutilized'),
    idle: countVerdict('idle'),
    opportunities: num(summary?.rightsizing_opportunities),
    confidentMonthly: num(summary?.confident_monthly_savings),
    confidentAnnual: num(summary?.confident_annual_savings),
    // Compute Intelligence publishes this sentence itself when it has nothing
    // it is confident enough to quote. It is shown verbatim.
    noOpportunityNote: summary?.no_opportunity_note
      || 'No high-confidence optimization opportunity identified.',
    fleetMonthly: num(summary?.fleet_monthly_cost),
  };
}

// ── section 10: orphaned resources ─────────────────────────────────────────

/**
 * Consumes the orphaned module's own findings. No detection happens here —
 * a second implementation of "is this disk attached" would eventually disagree
 * with the first, and the user would have no way to know which was right.
 */
export function orphanSummary(orphaned) {
  if (!orphaned) return null;
  const categories = Array.isArray(orphaned.categories) ? orphaned.categories : [];
  const monthly = isNum(orphaned.total_monthly_cost) ? orphaned.total_monthly_cost : null;
  return {
    count: isNum(orphaned.total_count) ? orphaned.total_count : null,
    monthly,
    // Twelve times a monthly figure, and labelled as such — not a forecast.
    annual: isNum(monthly) ? monthly * 12 : null,
    categories: categories.map(c => ({
      key: c.key,
      title: c.title,
      count: isNum(c.count) ? c.count : null,
      monthly: isNum(c.monthly_cost) ? c.monthly_cost : null,
      severity: c.severity,
    })).filter(c => (c.count || 0) > 0),
    partial: Array.isArray(orphaned.errors) && orphaned.errors.length > 0,
  };
}

// ── section 12: governance ─────────────────────────────────────────────────

const GOVERNANCE_TAGS = [
  { key: 'owner', label: 'Owner', aliases: ['owner', 'ownername', 'resourceowner'] },
  { key: 'costcenter', label: 'CostCenter', aliases: ['costcenter', 'cost_center', 'cost-centre', 'costcentre'] },
  { key: 'environment', label: 'Environment', aliases: ['environment', 'env'] },
];

function hasTag(tags, aliases) {
  if (!tags || typeof tags !== 'object') return false;
  const lowered = Object.entries(tags)
    .filter(([, v]) => String(v ?? '').trim() !== '')
    .map(([k]) => k.toLowerCase().replace(/[\s_-]/g, ''));
  return aliases.some(a => lowered.includes(a.replace(/[\s_-]/g, '')));
}

/**
 * Tag coverage over the live inventory, plus Policy's own compliance figure.
 *
 * A resource with no tags is *untagged*, which is a governance gap. It is not
 * "non-compliant" — that word belongs to Azure Policy, which may have no rule
 * about tags at all. Conflating the two would report a policy violation that
 * Azure never raised.
 */
export function governanceSnapshot({ services, policy } = {}) {
  const haveInventory = Array.isArray(services) && services.length > 0;

  const tags = haveInventory
    ? GOVERNANCE_TAGS.map(({ key, label, aliases }) => {
      const present = services.filter(r => hasTag(r?.tags, aliases)).length;
      return {
        key,
        label,
        present,
        missing: services.length - present,
        coverage: (present / services.length) * 100,
      };
    })
    : null;

  const compliance = policy && isNum(policy.compliance_rate)
    ? {
      rate: policy.compliance_rate,
      compliant: isNum(policy.compliant_count) ? policy.compliant_count : null,
      evaluated: isNum(policy.evaluated_count) ? policy.evaluated_count : null,
      nonCompliant: Array.isArray(policy.non_compliant) ? policy.non_compliant.length : null,
      unenforced: isNum(policy.unenforced_count) ? policy.unenforced_count : null,
    }
    : null;

  if (!tags && !compliance) return null;

  return {
    tags,
    total: haveInventory ? services.length : null,
    compliance,
    // Policy was never asked, or answered with nothing it could evaluate.
    complianceState: compliance ? 'known' : (policy ? 'not_evaluated' : 'not_loaded'),
  };
}

// ── section 13: security ───────────────────────────────────────────────────

function severityCounts(summary) {
  const by = summary?.by_severity;
  if (!by || typeof by !== 'object') return null;
  return {
    critical: isNum(by.critical) ? by.critical : 0,
    high: isNum(by.high) ? by.high : 0,
    medium: isNum(by.medium) ? by.medium : 0,
    low: isNum(by.low) ? by.low : 0,
    total: isNum(summary.total) ? summary.total : null,
  };
}

/**
 * Defender, Policy, Advisor, Access Optimisation and Role Assignments side by
 * side. Each is independently optional: Defender is a paid tier many
 * subscriptions do not have, and reporting "0 findings" for a subscription
 * that was never scanned is the most dangerous false reassurance this page
 * could give.
 *
 * The two RBAC sources are counted but deliberately kept out of `totals`. An
 * access finding is a candidate for review, not an open vulnerability, and
 * adding it to a critical/high/medium tally would put "this service principal
 * may be over-privileged" in the same column as "this disk is unencrypted".
 */
export function securitySnapshot({ defender, policy, advisor, access, roles } = {}) {
  const defenderCounts = severityCounts(defender?.summary);
  const advisorCounts = severityCounts(advisor?.summary);

  const accessFindings = Array.isArray(access?.findings) ? access.findings : null;
  const accessHigh = isNum(access?.totals?.high_count) ? access.totals.high_count : null;

  const sources = [
    {
      key: 'defender',
      title: 'Defender for Cloud',
      to: '/defender',
      state: defender ? 'loaded' : 'not_loaded',
      counts: defenderCounts,
      extra: isNum(defender?.secure_score_overall) ? `Secure score ${defender.secure_score_overall}%` : null,
      alerts: Array.isArray(defender?.alerts) ? defender.alerts.length : null,
    },
    {
      key: 'policy',
      title: 'Policy compliance',
      to: '/policy',
      state: policy ? 'loaded' : 'not_loaded',
      counts: severityCounts(policy?.summary),
      extra: isNum(policy?.compliance_rate) ? `${policy.compliance_rate}% compliant` : null,
      alerts: null,
    },
    {
      key: 'advisor',
      title: 'Azure Advisor',
      to: '/advisor',
      state: advisor ? 'loaded' : 'not_loaded',
      counts: advisorCounts,
      extra: isNum(advisor?.summary?.total) ? `${advisor.summary.total} recommendations` : null,
      alerts: null,
    },
    {
      key: 'access',
      title: 'Access optimisation',
      to: '/access-identity?view=optimization',
      state: access ? 'loaded' : 'not_loaded',
      // Access findings carry their own severity axis, not Defender's.
      counts: null,
      rbac: accessFindings
        ? {
          findings: accessFindings.length,
          high: accessHigh,
          principals: isNum(access?.totals?.principals_with_findings) ? access.totals.principals_with_findings : null,
        }
        : null,
      extra: accessFindings ? `${accessFindings.length} grants to review` : null,
      alerts: null,
    },
    {
      key: 'roles',
      title: 'Role assignments',
      to: '/access-identity?view=assignments',
      state: roles ? 'loaded' : 'not_loaded',
      counts: null,
      rbac: roles?.totals
        ? {
          principals: isNum(roles.totals.principal_count) ? roles.totals.principal_count : null,
          assignments: isNum(roles.totals.assignment_count) ? roles.totals.assignment_count : null,
          critical: isNum(roles.totals.critical_count) ? roles.totals.critical_count : null,
        }
        : null,
      extra: isNum(roles?.totals?.critical_count)
        ? `${roles.totals.critical_count} owner-level principal(s)`
        : null,
      alerts: null,
    },
  ];

  const loaded = sources.filter(s => s.state === 'loaded' && s.counts);
  const totals = loaded.length
    ? loaded.reduce((acc, s) => ({
      critical: acc.critical + s.counts.critical,
      high: acc.high + s.counts.high,
      medium: acc.medium + s.counts.medium,
    }), { critical: 0, high: 0, medium: 0 })
    : null;

  return {
    sources,
    totals,
    loadedCount: loaded.length,
    // Reported separately from the severity totals, on purpose.
    rbac: {
      state: access || roles ? 'loaded' : 'not_loaded',
      accessFindings: accessFindings ? accessFindings.length : null,
      accessHigh,
      principals: isNum(roles?.totals?.principal_count) ? roles.totals.principal_count : null,
      ownerLevel: isNum(roles?.totals?.critical_count) ? roles.totals.critical_count : null,
    },
  };
}

// ── section 2: estate health ───────────────────────────────────────────────
//
// Every score below is a published arithmetic rule applied to figures that
// came from Azure. None of them is a judgement, a weighting somebody liked the
// look of, or a number chosen to make a dashboard feel reassuring. Where the
// inputs are missing the category returns `null` and says `Insufficient data`,
// because a health score computed from nothing is worse than no score at all.

function band(score) {
  if (!isNum(score)) return 'unknown';
  if (score >= 85) return 'good';
  if (score >= 60) return 'fair';
  return 'poor';
}

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function costEfficiency({ compute, orphaned, spend }) {
  const waste = [];
  if (isNum(compute?.summary?.confident_monthly_savings)) waste.push(compute.summary.confident_monthly_savings);
  if (isNum(orphaned?.total_monthly_cost)) waste.push(orphaned.total_monthly_cost);

  if (!waste.length || !isNum(spend) || spend <= 0) {
    return {
      key: 'cost', title: 'Cost Efficiency', score: null, status: 'unknown',
      reason: !isNum(spend) || spend <= 0
        ? 'Monthly spend has not been read, so identified waste cannot be expressed as a share of the bill.'
        : 'Neither Compute Intelligence nor the orphaned-resource sweep has run, so there is no measured waste to compare against spend.',
      affected: null,
      action: 'Run Compute Intelligence and the orphaned sweep, then reload.',
      to: '/compute',
    };
  }

  const wasted = waste.reduce((a, b) => a + b, 0);
  const score = clampScore(100 - (wasted / spend) * 100);
  const affected = (isNum(compute?.summary?.rightsizing_opportunities) ? compute.summary.rightsizing_opportunities : 0)
    + (isNum(orphaned?.total_count) ? orphaned.total_count : 0);

  return {
    key: 'cost', title: 'Cost Efficiency', score, status: band(score),
    reason: `Identified recoverable spend is ${((wasted / spend) * 100).toFixed(1)}% of the last complete month's bill. Score is 100 minus that share.`,
    affected,
    money: wasted,
    action: score >= 85 ? 'No material recoverable spend identified.' : 'Review right-sizing and orphaned resources.',
    to: '/orphaned',
  };
}

function computeEfficiency({ compute }) {
  const summary = compute?.summary;
  const measured = isNum(summary?.telemetry_measured) ? summary.telemetry_measured : null;
  const verifiablyOff = isNum(summary?.verifiably_off) ? summary.verifiably_off : 0;
  const conclusive = isNum(measured) ? measured + verifiablyOff : null;

  if (!summary || !isNum(conclusive) || conclusive === 0) {
    return {
      key: 'compute', title: 'Compute Efficiency', score: null, status: 'unknown',
      reason: summary
        ? 'Azure published no usable CPU telemetry for any virtual machine in scope, so utilisation cannot be scored.'
        : 'Compute Intelligence has not been loaded for this scope.',
      affected: isNum(summary?.total) ? summary.total : null,
      action: 'Open Compute Intelligence to see why telemetry is unavailable.',
      to: '/compute',
    };
  }

  const opportunities = isNum(summary.rightsizing_opportunities) ? summary.rightsizing_opportunities : 0;
  const score = clampScore(100 - (opportunities / conclusive) * 100);
  return {
    key: 'compute', title: 'Compute Efficiency', score, status: band(score),
    reason: `${opportunities} of ${conclusive} conclusively assessed machines carry a right-sizing or deallocation finding. Score is 100 minus that share.`,
    affected: opportunities,
    action: opportunities ? 'Review the flagged machines in Compute Intelligence.' : 'No sizing findings on the machines that could be assessed.',
    to: '/compute',
    note: isNum(summary.telemetry_unavailable) && summary.telemetry_unavailable > 0
      ? `${summary.telemetry_unavailable} machine(s) had no usable telemetry and are excluded from this score rather than counted as healthy.`
      : null,
  };
}

function resourceHygiene({ orphaned, services }) {
  const total = Array.isArray(services) ? services.length : null;
  const orphans = isNum(orphaned?.total_count) ? orphaned.total_count : null;

  if (!isNum(total) || total === 0 || !isNum(orphans)) {
    return {
      key: 'hygiene', title: 'Resource Hygiene', score: null, status: 'unknown',
      reason: !isNum(orphans)
        ? 'The orphaned-resource sweep has not run for this scope.'
        : 'The resource inventory has not been read, so orphans cannot be expressed as a share of the estate.',
      affected: orphans,
      action: 'Refresh the estate to run both the inventory and the orphan sweep.',
      to: '/orphaned',
    };
  }

  const score = clampScore(100 - (orphans / total) * 100);
  return {
    key: 'hygiene', title: 'Resource Hygiene', score, status: band(score),
    reason: `${orphans} of ${total} resources are attached to nothing. Score is 100 minus that share.`,
    affected: orphans,
    action: orphans ? 'Open Orphaned Resources to review and delete.' : 'Nothing unattached was found.',
    to: '/orphaned',
  };
}

function governanceHealth({ governance }) {
  const tags = governance?.tags;
  const compliance = governance?.compliance;

  const parts = [];
  if (tags && tags.length) parts.push(tags.reduce((sum, t) => sum + t.coverage, 0) / tags.length);
  if (compliance && isNum(compliance.rate)) parts.push(compliance.rate);

  if (!parts.length) {
    return {
      key: 'governance', title: 'Governance', score: null, status: 'unknown',
      reason: 'Neither the tagged inventory nor Azure Policy compliance has been read for this scope.',
      affected: null,
      action: 'Refresh the estate, or open Policy Governance.',
      to: '/policy',
    };
  }

  const score = clampScore(parts.reduce((a, b) => a + b, 0) / parts.length);
  const missing = tags ? Math.max(...tags.map(t => t.missing)) : null;
  return {
    key: 'governance', title: 'Governance', score, status: band(score),
    reason: parts.length === 2
      ? 'Mean of average tag coverage across Owner, CostCenter and Environment, and the Azure Policy compliance rate.'
      : (tags ? 'Average tag coverage across Owner, CostCenter and Environment. Policy compliance was not available.'
        : 'Azure Policy compliance rate. The tagged inventory was not available.'),
    affected: missing,
    action: 'Tag untagged resources and review policy assignments.',
    to: '/policy',
  };
}

/**
 * Weighted findings measured against the size of the estate: 10 points of
 * weight per critical, 5 per high, 1 per medium, divided by the number of
 * resources those sources could have flagged.
 *
 * A flat deduction per finding was tried first and is useless at real scale —
 * a 300-resource estate with a few hundred medium Advisor recommendations
 * saturates at zero immediately, so a genuinely dangerous estate and a merely
 * noisy one score identically. Dividing by the inventory makes the number a
 * density, which discriminates and stays comparable between subscriptions.
 *
 * This is a stated rule, not a risk model, and the UI says so. It exists to
 * rank scopes against each other consistently, not to tell anyone they are 78%
 * secure.
 */
function securityHealth({ security, services }) {
  const totals = security?.totals;
  if (!totals || !security.loadedCount) {
    return {
      key: 'security', title: 'Security', score: null, status: 'unknown',
      reason: 'No security source has been read for this scope. Defender is a paid tier and may not be enabled — an empty result is not a clean result.',
      affected: null,
      action: 'Open Security Overview to load Defender, Policy and Advisor.',
      to: '/security',
    };
  }

  const resources = Array.isArray(services) ? services.length : null;
  if (!isNum(resources) || resources <= 0) {
    return {
      key: 'security', title: 'Security', score: null, status: 'unknown',
      reason: 'Security findings were read, but the resource inventory was not, so they cannot be expressed as a density. A raw finding count says nothing without an estate size to measure it against.',
      affected: totals.critical + totals.high + totals.medium,
      affectedNoun: 'finding',
      action: 'Reload the estate so the inventory and the findings arrive together.',
      to: '/security',
    };
  }

  const weight = totals.critical * 10 + totals.high * 5 + totals.medium * 1;
  const perResource = weight / resources;
  // 3.0 weight per resource is treated as the floor of the scale: roughly one
  // high-severity finding on every resource, plus change.
  const SATURATION = 3;
  const score = clampScore(100 - (perResource / SATURATION) * 100);
  const affected = totals.critical + totals.high + totals.medium;
  return {
    key: 'security', title: 'Security', score, status: band(score),
    reason: `${totals.critical} critical, ${totals.high} high and ${totals.medium} medium findings across ${security.loadedCount} loaded source(s), weighted 10/5/1 and spread over ${resources} resources — ${perResource.toFixed(2)} points of weight per resource against a floor of 3.00.`,
    affected,
    affectedNoun: 'finding',
    action: affected ? 'Review the findings in Defender and Policy.' : 'No open findings in the sources that answered.',
    to: '/security',
  };
}

/**
 * The five health categories, and an overall figure that is the mean of only
 * the ones that could actually be scored.
 *
 * Categories with no data are not scored as zero and not scored as a hundred.
 * They are excluded and counted, and the overall figure states how many of the
 * five it rests on — so a "92" built from one category cannot be mistaken for
 * a clean bill of health.
 */
export function estateHealth({ compute, orphaned, costData, services, policy, defender, advisor, access, roles } = {}) {
  const spend = spendOverview(costData)?.current ?? null;
  const governance = governanceSnapshot({ services, policy });
  const security = securitySnapshot({ defender, policy, advisor, access, roles });

  const categories = [
    costEfficiency({ compute, orphaned, spend }),
    computeEfficiency({ compute }),
    resourceHygiene({ orphaned, services }),
    governanceHealth({ governance }),
    securityHealth({ security, services }),
  ];

  const scored = categories.filter(c => isNum(c.score));
  const overall = scored.length
    ? clampScore(scored.reduce((sum, c) => sum + c.score, 0) / scored.length)
    : null;

  return {
    categories,
    overall,
    status: band(overall),
    scoredCount: scored.length,
    totalCount: categories.length,
    basis: scored.length === categories.length
      ? `Mean of all ${categories.length} categories.`
      : (scored.length
        ? `Mean of ${scored.length} of ${categories.length} categories. The other ${categories.length - scored.length} reported insufficient data and were excluded rather than assumed healthy.`
        : 'None of the five categories had enough data to be scored.'),
  };
}

// ── section 3: what needs attention ────────────────────────────────────────

function findingKey(parts) {
  return parts.filter(Boolean).join('::');
}

/**
 * One ranked list drawn from every module that produces findings.
 *
 * Nothing is detected here. Each entry is a restatement of a finding another
 * module already made, carrying that module's own severity and its own
 * financial impact — and where that module could not price the finding, this
 * one says so rather than substituting a zero.
 */
export function attentionFindings({
  compute, orphaned, costData, defender, policy, advisor, activity, access,
  currency = 'USD', limit = 12,
} = {}) {
  const findings = [];

  // Compute Intelligence — consumed, never recalculated.
  for (const vm of (Array.isArray(compute?.vms) ? compute.vms : [])) {
    const severity = vm?.severity;
    if (!severity || severity === 'none') continue;
    const saving = vm?.savings?.monthly;
    findings.push({
      key: findingKey(['compute', vm.resource_id || vm.id]),
      severity,
      source: 'Compute Intelligence',
      resource: vm.name || NOT_AVAILABLE,
      resourceId: vm.resource_id || vm.id || null,
      subscriptionId: vm.subscription_id || null,
      region: vm.region || null,
      problem: vm.verdict_label || vm.verdict || 'Sizing finding',
      detail: vm.reason || '',
      impact: isNum(saving) ? saving : null,
      impactLabel: isNum(saving) ? `${displayMoney(saving, currency, true)} / month` : NO_COST,
      action: vm.recommended_sku ? `Review a resize to ${vm.recommended_sku}` : 'Review in Compute Intelligence',
      to: '/compute',
      cta: 'View Compute Intelligence',
    });
  }

  // Orphaned resources.
  for (const category of (Array.isArray(orphaned?.categories) ? orphaned.categories : [])) {
    for (const item of (Array.isArray(category.items) ? category.items : [])) {
      findings.push({
        key: findingKey(['orphaned', item.id]),
        // The orphan module grades its own certainty; a "likely" orphan must
        // not be presented with the same weight as a certain one.
        severity: category.severity === 'certain' ? 'medium' : 'low',
        source: 'Orphaned Resources',
        resource: item.name || NOT_AVAILABLE,
        resourceId: item.id || null,
        subscriptionId: item.subscription_id || null,
        region: item.location || null,
        problem: category.title || 'Unattached resource',
        detail: item.detail || category.reason || '',
        impact: isNum(item.monthly_cost) ? item.monthly_cost : null,
        impactLabel: isNum(item.monthly_cost) ? `${displayMoney(item.monthly_cost, currency, true)} / month` : NO_COST,
        action: 'Confirm it is unused, then delete',
        to: '/orphaned',
        cta: 'Open Orphaned Resources',
      });
    }
  }

  // Cost anomalies, as Cost Management's own analysis reported them.
  for (const anomaly of (Array.isArray(costData?.anomalies) ? costData.anomalies : [])) {
    findings.push({
      key: findingKey(['anomaly', anomaly.service, anomaly.month]),
      severity: 'high',
      source: 'Cost Anomalies',
      resource: anomaly.service || NOT_AVAILABLE,
      resourceId: null,
      subscriptionId: null,
      region: null,
      problem: 'Unusual cost increase',
      detail: anomaly.reason || '',
      impact: null,
      impactLabel: isNum(anomaly.pct_change) ? `${displayPct(anomaly.pct_change)} in ${anomaly.month}` : NO_COST,
      action: 'Investigate what changed that month',
      to: '/anomalies',
      cta: 'Open Anomalies',
    });
  }

  // Security findings, critical and high only — the estate page is a triage
  // surface, and a thousand medium Defender assessments would bury everything.
  for (const [data, source, route, cta] of [
    [defender, 'Defender for Cloud', '/defender', 'Open Defender'],
    [advisor, 'Azure Advisor', '/advisor', 'Open Advisor'],
  ]) {
    const items = Array.isArray(data?.assessments) ? data.assessments : (Array.isArray(data?.findings) ? data.findings : []);
    for (const item of items) {
      if (item?.severity !== 'critical' && item?.severity !== 'high') continue;
      findings.push({
        key: findingKey([source, item.key || item.id]),
        severity: item.severity,
        source,
        resource: item.resource_name || NOT_AVAILABLE,
        resourceId: item.resource_id || null,
        subscriptionId: item.subscription_id || null,
        region: null,
        problem: item.title || 'Security finding',
        detail: item.solution || item.description || '',
        impact: null,
        impactLabel: NO_COST,
        action: item.solution ? 'Apply the recommended remediation' : 'Review the finding',
        to: route,
        cta,
      });
    }
  }

  // Non-compliant policy states.
  const nonCompliant = Array.isArray(policy?.non_compliant) ? policy.non_compliant : [];
  for (const item of nonCompliant.slice(0, 20)) {
    findings.push({
      key: findingKey(['policy', item.key || item.id]),
      severity: item.severity === 'critical' || item.severity === 'high' ? item.severity : 'low',
      source: 'Policy Governance',
      resource: item.resource_name || NOT_AVAILABLE,
      resourceId: item.resource_id || null,
      subscriptionId: item.subscription_id || null,
      region: null,
      problem: item.title || 'Non-compliant with policy',
      detail: item.solution || item.description || '',
      impact: null,
      impactLabel: NO_COST,
      action: 'Bring the resource into compliance or exempt it deliberately',
      to: '/policy',
      cta: 'Open Policy Governance',
    });
  }

  // Failed control-plane operations. A deployment that errored is something
  // the owner almost certainly wants to know about today.
  const failedEvents = (Array.isArray(activity?.events) ? activity.events : []).filter(e => e && e.succeeded === false);
  for (const event of failedEvents.slice(0, 10)) {
    findings.push({
      key: findingKey(['activity', event.id]),
      severity: 'medium',
      source: 'Activity Log',
      resource: event.resource_id ? event.resource_id.split('/').pop() : NOT_AVAILABLE,
      resourceId: event.resource_id || null,
      subscriptionId: event.subscription_id || null,
      region: null,
      problem: `Failed operation — ${event.summary || event.operation || 'unknown'}`,
      detail: event.caller ? `Requested by ${event.caller}` : '',
      impact: null,
      impactLabel: NO_COST,
      action: 'Check why the operation failed',
      to: '/activity',
      cta: 'Open Activity Explorer',
    });
  }

  // Access optimisation. Only the high-severity grants reach this list, and
  // the wording stays conditional: the module itself is explicit that every
  // finding is a candidate for review rather than a verdict, because a service
  // principal that runs quarterly looks identical to dead access over a
  // thirty-day window.
  const accessHigh = (Array.isArray(access?.findings) ? access.findings : [])
    .filter(f => f?.severity === 'high');
  for (const finding of accessHigh.slice(0, 10)) {
    findings.push({
      key: findingKey(['access', finding.principal_id, finding.kind]),
      severity: 'high',
      source: 'Access Optimisation',
      resource: finding.principal_name || finding.principal_id || NOT_AVAILABLE,
      resourceId: finding.scope || null,
      subscriptionId: finding.subscription_id || null,
      region: null,
      problem: finding.title || finding.kind || 'Access finding',
      detail: finding.detail || finding.reason || '',
      impact: null,
      impactLabel: NO_COST,
      action: 'Review whether this grant is still needed',
      to: '/access-identity?view=optimization',
      cta: 'Open Access Optimization',
    });
  }

  // Most severe first; within a severity, the largest known financial impact.
  // An unpriced finding sorts below a priced one rather than being treated as
  // costing nothing.
  findings.sort((a, b) => {
    const rank = (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9);
    if (rank !== 0) return rank;
    const ai = isNum(a.impact) ? a.impact : -1;
    const bi = isNum(b.impact) ? b.impact : -1;
    return bi - ai;
  });

  // Bug 24: Advisor publishes the same recommendation once per subscription
  // and gives them the same key, so two findings could collide. Rather than
  // patch each source's key rule, uniqueness is guaranteed once, here — a
  // duplicate key silently drops a real finding from the rendered list.
  const seen = new Map();
  for (const finding of findings) {
    const count = (seen.get(finding.key) || 0) + 1;
    seen.set(finding.key, count);
    if (count > 1) finding.key = `${finding.key}#${count}`;
  }

  const priced = findings.filter(f => isNum(f.impact));
  return {
    findings: findings.slice(0, limit),
    total: findings.length,
    // Only the findings that carry a real number. Everything else is counted
    // separately so the reader knows the total is a floor, not the whole bill.
    knownImpact: priced.length ? priced.reduce((sum, f) => sum + f.impact, 0) : null,
    unpriced: findings.length - priced.length,
    bySeverity: findings.reduce((acc, f) => ({ ...acc, [f.severity]: (acc[f.severity] || 0) + 1 }), {}),
  };
}

// ── section 6: subscription health ─────────────────────────────────────────

/**
 * One row per subscription the user actually selected.
 *
 * Built by indexing each dataset by subscription id rather than by asking
 * Azure once per subscription. Cost, resources, VMs and orphans each fill in
 * what they know, and a subscription no dataset mentioned shows dashes rather
 * than a row of zeros implying it was examined and found empty.
 */
export function subscriptionHealth({
  subscriptions, selectedIds, costData, services, compute, orphaned, opts = {},
} = {}) {
  const chosen = Array.isArray(selectedIds) ? selectedIds : [];
  if (!chosen.length) return null;

  const nameOf = new Map((Array.isArray(subscriptions) ? subscriptions : [])
    .map(s => [s.subscription_id, s.display_name]));

  // Complete months only, for the same reason the spend overview uses them:
  // a per-subscription column comparing three days against thirty-one is noise.
  const all = Array.isArray(costData?.months) ? costData.months : [];
  const usable = completeMonths(costData, opts);
  const months = usable.length ? usable : all;

  // In a day window the buckets are summed into the period the user chose, and
  // the change column is dropped because there is no earlier equivalent period.
  let latest;
  let prior;
  if (opts.dayWindow) {
    latest = {};
    for (const m of months) {
      for (const [id, cost] of Object.entries(m?.by_subscription || {})) {
        if (isNum(cost)) latest[id] = (latest[id] || 0) + cost;
      }
    }
    prior = null;
  } else {
    latest = months[months.length - 1]?.by_subscription || {};
    prior = months.length > 1 ? (months[months.length - 2]?.by_subscription || {}) : null;
  }

  const resourceCount = new Map();
  for (const r of (Array.isArray(services) ? services : [])) {
    const id = r?.subscription_id;
    if (!id) continue;
    resourceCount.set(id, (resourceCount.get(id) || 0) + 1);
  }

  const vmRunning = new Map();
  const vmIssues = new Map();
  for (const vm of (Array.isArray(compute?.vms) ? compute.vms : [])) {
    const id = vm?.subscription_id;
    if (!id) continue;
    if (vm?.operational?.status === 'RUNNING') vmRunning.set(id, (vmRunning.get(id) || 0) + 1);
    if (vm?.severity && vm.severity !== 'none') vmIssues.set(id, (vmIssues.get(id) || 0) + 1);
  }

  const orphanCount = new Map();
  for (const category of (Array.isArray(orphaned?.categories) ? orphaned.categories : [])) {
    for (const item of (Array.isArray(category.items) ? category.items : [])) {
      const id = item?.subscription_id;
      if (!id) continue;
      orphanCount.set(id, (orphanCount.get(id) || 0) + 1);
    }
  }

  const haveCost = all.length > 0;
  const haveInventory = Array.isArray(services);
  const haveCompute = Array.isArray(compute?.vms);
  const haveOrphans = Array.isArray(orphaned?.categories);

  const rows = chosen.map((id) => {
    const cost = isNum(latest[id]) ? latest[id] : (haveCost ? 0 : null);
    const before = prior && isNum(prior[id]) ? prior[id] : null;
    const changePct = isNum(cost) && isNum(before) && before > 0 ? ((cost - before) / before) * 100 : null;
    const issues = haveCompute || haveOrphans
      ? (vmIssues.get(id) || 0) + (orphanCount.get(id) || 0)
      : null;

    return {
      subscriptionId: id,
      name: nameOf.get(id) || id,
      resources: haveInventory ? (resourceCount.get(id) || 0) : null,
      running: haveCompute ? (vmRunning.get(id) || 0) : null,
      cost,
      previous: before,
      changePct,
      issues,
      // A subscription can only be graded on what was actually read for it.
      health: issues === null ? 'unknown' : (issues === 0 ? 'good' : (issues > 5 ? 'poor' : 'fair')),
    };
  });

  rows.sort((a, b) => (isNum(b.cost) ? b.cost : -1) - (isNum(a.cost) ? a.cost : -1));
  return { rows, haveCost, haveInventory, haveCompute, haveOrphans };
}

// ── section 11: recent changes ─────────────────────────────────────────────

export function recentChanges(activity, limit = 10) {
  const events = Array.isArray(activity?.events) ? activity.events : null;
  if (!events) return null;
  return {
    rows: events.slice(0, limit),
    total: isNum(activity.total) ? activity.total : events.length,
    failed: isNum(activity.failed) ? activity.failed : null,
    windowDays: isNum(activity.windowDays) ? activity.windowDays : (isNum(activity.window_days) ? activity.window_days : null),
    partial: Array.isArray(activity.errors) && activity.errors.length > 0,
  };
}

// ── section 14: estate search ──────────────────────────────────────────────

/**
 * Filters the inventory already in memory.
 *
 * That inventory was fetched for the signed-in user's own tenant and only the
 * subscriptions they selected, so the result set is tenant-scoped by
 * construction — there is nothing here to leak, because nothing belonging to
 * anybody else was ever loaded.
 */
export function searchEstate(services, query, limit = 25) {
  const term = String(query || '').trim().toLowerCase();
  if (!term) return null;
  if (!Array.isArray(services)) return { rows: [], total: 0, ready: false };

  const rows = services.filter((r) => {
    if (!r) return false;
    return [r.name, r.type, r.resource_group, r.location, r.sku, r.service]
      .some(field => String(field || '').toLowerCase().includes(term));
  });

  return { rows: rows.slice(0, limit), total: rows.length, ready: true, truncated: rows.length > limit };
}

// ── section 1: the KPI strip ───────────────────────────────────────────────

/**
 * Eight headline figures. Each is `null` until the dataset behind it has
 * actually arrived, so the strip renders skeletons and dashes rather than a
 * confident row of zeros while the estate is still loading.
 */
export function kpiStrip({
  compute, costData, orphaned, services, activity, health, currency = 'USD',
  loading = {}, opts = {}, rangeLabel = null,
} = {}) {
  const spend = spendOverview(costData, opts);
  const inventory = inventorySummary(services);
  const attention = attentionFindings({ compute, orphaned, costData, currency, limit: 9999 });
  const savings = compute?.summary?.confident_monthly_savings;

  return [
    {
      key: 'resources',
      label: 'Total resources',
      value: inventory ? inventory.total.toLocaleString() : null,
      hint: inventory ? `${inventory.categories.length} categories` : NOT_LOADED,
      to: '/resource-groups',
      loading: Boolean(loading.services),
    },
    {
      key: 'running',
      label: 'Running VMs',
      value: isNum(compute?.summary?.running) ? compute.summary.running.toLocaleString() : null,
      hint: isNum(compute?.summary?.total)
        ? `${compute.summary.deallocated || 0} deallocated of ${compute.summary.total}`
        : NOT_LOADED,
      to: '/compute',
      loading: Boolean(loading.compute),
    },
    {
      key: 'spend',
      // In a day window the card is the total for the days the user asked for,
      // and it says so. Calling seven days of spend "monthly" would be a lie of
      // the same shape as reporting a month-to-date figure as a full month.
      label: spend?.periodMode ? 'Spend in period' : 'Monthly spend',
      // Deliberately the last *complete* month. A month-to-date figure under a
      // "Monthly spend" heading reads as a collapse in spending every time the
      // calendar turns over.
      value: displayMoney(isNum(spend?.current) ? spend.current : spend?.monthToDate, currency),
      hint: spend?.periodMode
        ? (rangeLabel || 'Selected period')
        : (spend?.currentMonth
          ? `Billed in ${spend.currentMonth}${isNum(spend?.monthToDate) ? ` · ${spend.monthToDateMonth} to date ${displayMoney(spend.monthToDate, currency)}` : ''}`
          : (isNum(spend?.monthToDate)
            ? `${spend.monthToDateMonth} to date — not a full month`
            : NOT_LOADED)),
      to: '/explorer',
      loading: Boolean(loading.cost),
    },
    {
      key: 'change',
      label: 'Cost change',
      value: displayPct(spend?.changePct),
      hint: spend?.periodMode
        ? 'No earlier period of equal length to compare against'
        : (spend?.previousMonth ? `vs ${spend.previousMonth}` : 'No previous month to compare'),
      tone: costTone(spend?.changePct),
      to: '/compare',
      loading: Boolean(loading.cost),
    },
    {
      key: 'opportunity',
      label: 'Optimization opportunity',
      // Compute reports `null`, not `0`, when nothing is high-confidence.
      value: isNum(savings) ? displayMoney(savings, currency) : null,
      hint: isNum(savings)
        ? `${compute?.summary?.rightsizing_opportunities || 0} machines flagged`
        : (compute ? 'No high-confidence optimization opportunity identified.' : NOT_LOADED),
      tone: isNum(savings) ? 'high' : 'neutral',
      to: '/compute',
      loading: Boolean(loading.compute),
    },
    {
      key: 'attention',
      label: 'Needs attention',
      value: attention.total ? attention.total.toLocaleString() : (compute || orphaned || costData ? '0' : null),
      hint: attention.total
        ? `${attention.bySeverity.critical || 0} critical · ${attention.bySeverity.high || 0} high`
        : (compute || orphaned || costData ? 'Nothing flagged in the loaded sources' : NOT_LOADED),
      tone: (attention.bySeverity.critical || attention.bySeverity.high) ? 'high' : 'neutral',
      loading: Boolean(loading.compute || loading.orphaned),
    },
    {
      key: 'changes',
      label: 'Recent changes',
      value: isNum(activity?.total) ? activity.total.toLocaleString() : null,
      hint: isNum(activity?.window_days) ? `Last ${activity.window_days} days` : NOT_LOADED,
      to: '/activity',
      loading: Boolean(loading.activity),
    },
    {
      key: 'health',
      label: 'Estate health',
      value: isNum(health?.overall) ? `${health.overall}` : null,
      hint: isNum(health?.overall)
        ? `${health.scoredCount} of ${health.totalCount} categories scored`
        : INSUFFICIENT,
      tone: health?.status === 'poor' ? 'high' : (health?.status === 'good' ? 'good' : 'neutral'),
      loading: false,
    },
  ];
}

// ── refresh progress ───────────────────────────────────────────────────────

/**
 * The seven stages the refresh reports, each derived from the store's own
 * loading and data flags rather than from a timer. A tick that appears on a
 * schedule instead of on an answer is decoration.
 */
export const REFRESH_STAGES = [
  { key: 'subscriptions', label: 'Subscriptions' },
  { key: 'inventory', label: 'Resource inventory' },
  { key: 'cost', label: 'Cost data' },
  { key: 'compute', label: 'Optimization' },
  { key: 'orphaned', label: 'Orphaned resources' },
  { key: 'activity', label: 'Activity' },
  { key: 'security', label: 'Governance & security' },
];

export function refreshStages(state = {}) {
  return REFRESH_STAGES.map(({ key, label }) => {
    const s = state[key] || {};
    let status = 'pending';
    if (s.loading) status = 'running';
    else if (s.error) status = 'failed';
    else if (s.done) status = 'done';
    return { key, label, status, error: s.error || null };
  });
}

/** Are any of the estate's datasets still in flight? */
export function isRefreshing(stages) {
  return stages.some(s => s.status === 'running');
}
