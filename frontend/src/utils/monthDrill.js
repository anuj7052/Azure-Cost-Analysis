/**
 * Reading one month out of the trend.
 *
 * The trend chart already holds everything needed to answer "what made that
 * month" -- each point carries its own `by_service` map -- so the drill-down
 * is arithmetic on data already on the page rather than another round trip to
 * Azure. That matters beyond speed: a second query for the same month can
 * disagree with the chart above it, and two different totals for one month is
 * worse than one slow one.
 */

/** The raw month key for a clicked point, or '' if it cannot be drilled. */
export function monthFromPoint(point) {
  // Forecast points are computed, not billed. They have no services behind
  // them, and offering a breakdown of a projection would present a guess in
  // the same table that elsewhere shows invoices.
  if (!point || point._isForecast) return '';
  return point._key || '';
}

/** Find one month in the trend by its raw key. */
export function monthByKey(months, key) {
  if (!key) return null;
  return (months || []).find((m) => m.month === key) || null;
}

/**
 * Every service billed in one month, largest first.
 *
 * `share` is against the month's own total rather than the range's, because
 * the question being asked is what made *this* month, and a percentage of a
 * number not on screen means nothing.
 */
export function servicesInMonth(month) {
  if (!month) return [];
  const entries = Object.entries(month.by_service || {});
  const total = entries.reduce((sum, [, cost]) => sum + (Number(cost) || 0), 0);
  return entries
    .map(([name, cost]) => ({
      name,
      cost: Number(cost) || 0,
      // A zero total would make every share NaN and render as "NaN%". With no
      // total there is no share, and the caller renders it as absent.
      share: total > 0 ? ((Number(cost) || 0) / total) * 100 : null,
    }))
    .sort((a, b) => b.cost - a.cost || a.name.localeCompare(b.name));
}

/**
 * Whether the services add up to the month's reported total.
 *
 * Azure's grouped totals can omit charges that carry no service name, so the
 * rows can legitimately sum to less than the headline. Saying so is the
 * difference between a reader trusting the table and quietly noticing it does
 * not add up.
 */
export function unattributed(month) {
  if (!month) return 0;
  const rows = servicesInMonth(month).reduce((sum, r) => sum + r.cost, 0);
  const total = Number(month.total_cost) || 0;
  const gap = total - rows;
  // Floating-point noise is not a finding.
  return Math.abs(gap) < 0.005 ? 0 : gap;
}
