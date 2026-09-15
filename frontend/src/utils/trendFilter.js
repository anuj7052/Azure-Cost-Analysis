/*
 * Rebuilding the monthly trend from meter rows so it can be filtered.
 *
 * The trend used to refuse every filter, and the reason given was sound as far
 * as it went: `costData.months` carries marginal totals -- `by_service`,
 * `by_subscription`, `by_resource_group` -- and marginals cannot be crossed.
 * You cannot get "Virtual Machines in subscription A" out of a services map
 * and a subscriptions map, because neither knows what the other contains.
 *
 * But the marginals are not the only thing we hold. `/costs/rows` returns the
 * meter rows those totals were summed from, and every row names its own month,
 * service, resource group, subscription and region at once. Summing the rows
 * that survive a filter is the same arithmetic Azure did, minus the rows the
 * reader excluded -- so the filtered trend is a real answer rather than an
 * approximation, and any combination of filters is legitimate.
 *
 * The unfiltered trend still comes from `costData.months`. Rows are fetched
 * over a widened window and can be capped by the API, so re-deriving a total
 * we were handed directly would be a chance to disagree with Azure for no gain.
 */

/** Filters this module can honour. `search` is included; it reads the row's own names. */
const FIELDS = ['subscription', 'resource_group', 'location', 'service', 'search'];

/** True when at least one filter would actually narrow the rows. */
export function hasTrendFilters(filters) {
  if (!filters) return false;
  return FIELDS.some((key) => Boolean(filters[key]));
}

/** A single marginal can be read exactly from the same summary as Dashboard.
 * Two dimensions require intersecting meter rows; never cross marginal totals. */
export function summaryFilterSupported(filters = {}) {
  return !filters.search && !filters.location && !filters.resource_group
    && !(filters.service && filters.subscription);
}

export function monthsFromSummary(months = [], filters = {}) {
  if (!summaryFilterSupported(filters)) return null;
  if (!filters.service && !filters.subscription) return months;
  return months.map(month => {
    const split = filters.service ? month.by_service : month.by_subscription;
    const value = filters.service || filters.subscription;
    const total = split == null ? null : split[value] ?? 0;
    return { ...month, total_cost: total,
      by_service: filters.service && total !== null ? { [value]: total } : null,
      by_subscription: filters.subscription && total !== null ? { [value]: total } : {} };
  });
}

/**
 * Does one meter row survive the filters?
 *
 * `location` is matched against the row's `region`: the resource list calls it
 * one thing and the cost API the other, and the filter UI was built against
 * the resource list. Renaming either would break the other caller, so the
 * translation happens here, once.
 */
export function rowMatches(row, filters) {
  if (!row) return false;
  if (!filters) return true;
  if (filters.subscription && row.subscription_id !== filters.subscription) return false;
  if (filters.resource_group && row.resource_group !== filters.resource_group) return false;
  if (filters.location && row.region !== filters.location) return false;
  if (filters.service && row.service !== filters.service) return false;
  if (filters.search) {
    const q = filters.search.toLowerCase();
    const hay = `${row.resource_name || ''} ${row.service || ''} ${row.meter || ''} ${row.resource_group || ''}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

/**
 * Sum filtered meter rows into the month shape the trend chart already reads.
 *
 * `allowed` is the set of months the unfiltered trend is showing. Rows are
 * deliberately fetched further back than the chosen range so a month-over-month
 * comparison has something to compare against, and letting those extra months
 * through would silently widen the chart the moment somebody set a filter --
 * the line would grow a longer tail and look like new spending appeared.
 *
 * A month inside the range with no surviving rows is kept at zero rather than
 * dropped. The gap is the answer: it says this filter matched nothing that
 * month, where a missing point would just close up and hide it.
 */
export function monthsFromRows(rows, filters, { allowed = [], currency = '' } = {}) {
  const keep = new Set(allowed);
  const totals = new Map(allowed.map((m) => [m, { total: 0, services: new Map() }]));

  for (const row of rows || []) {
    if (!keep.has(row?.month)) continue;
    if (!rowMatches(row, filters)) continue;
    const bucket = totals.get(row.month);
    const cost = Number(row.cost) || 0;
    bucket.total += cost;
    if (row.service) {
      bucket.services.set(row.service, (bucket.services.get(row.service) || 0) + cost);
    }
  }

  return allowed.map((month) => {
    const bucket = totals.get(month);
    return {
      month,
      total_cost: bucket.total,
      currency,
      by_service: Object.fromEntries(bucket.services),
    };
  });
}

/**
 * How much of a month's real total the filtered view accounts for.
 *
 * Returned so the page can say what share is on screen. Meter rows can be
 * capped by the API on a large estate, so a filtered total is a floor, not a
 * guarantee -- and a reader comparing it against the unfiltered chart deserves
 * to know that rather than concluding their spend fell.
 *
 * Null when there is nothing to compare against: zero is a coverage figure,
 * and "we cannot tell" is not zero.
 */
export function rowCoverage(rows, allowed = [], monthly = []) {
  const keep = new Set(allowed);
  const real = monthly
    .filter((m) => keep.has(m.month))
    .reduce((sum, m) => sum + (Number(m.total_cost) || 0), 0);
  if (!real) return null;

  const seen = (rows || [])
    .filter((r) => keep.has(r?.month))
    .reduce((sum, r) => sum + (Number(r.cost) || 0), 0);

  return Math.min(seen / real, 1);
}
