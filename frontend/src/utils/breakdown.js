/**
 * Aggregating billed resources along whichever dimension is being asked about,
 * and projecting the trend forward.
 *
 * Both jobs live here rather than in the page because they are the two places
 * this app is most likely to quietly lie: summing a cost that was never
 * reported as if it were zero, and drawing a forecast that looks like
 * measurement. The rules for both are written once, and tested.
 */

/**
 * The dimensions a cost can be split by.
 *
 * Every one of these reads a field Resource Graph and Cost Management actually
 * return, so a breakdown is never invented from a field that does not exist.
 * `meter` has no `get` because it is one-to-many — a resource bills several
 * meters — and is fanned out separately below.
 */
export const DIMENSIONS = [
  { value: 'service', label: 'Service', get: (r) => r.service || r.type || 'Unknown' },
  { value: 'subscription', label: 'Subscription', get: (r) => r.subscription_id || 'Unknown' },
  { value: 'resource_group', label: 'Resource group', get: (r) => r.resource_group || 'Unknown' },
  { value: 'location', label: 'Region', get: (r) => r.location || 'Unknown' },
  { value: 'type', label: 'Resource type', get: (r) => r.type || 'Unknown' },
  { value: 'resource', label: 'Resource', get: (r) => r.name || 'Unknown' },
  { value: 'meter', label: 'Meter', get: null },
];

/**
 * Group resources by `dimension` and total their cost.
 *
 * A resource whose cost is `null` has not been billed yet, or the caller lacks
 * the permission to read it. It is counted in `count` and `unpriced` but adds
 * nothing to `cost`, so "we don't know" never masquerades as "zero".
 *
 * Returns `[{ key, cost, count, unpriced }]`, most expensive first.
 */
export function aggregate(resources, dimension) {
  const dim = DIMENSIONS.find((d) => d.value === dimension) || DIMENSIONS[0];
  const map = new Map();

  const bump = (key, cost, priced) => {
    const entry = map.get(key) || { key, cost: 0, count: 0, unpriced: 0 };
    if (priced) entry.cost += cost;
    else entry.unpriced += 1;
    entry.count += 1;
    map.set(key, entry);
  };

  if (dimension === 'meter') {
    (resources || []).forEach((r) => {
      if (!r.meters?.length) {
        // Still worth a row: "this resource bills nothing we can see" is a
        // finding, and dropping it would make the meter view silently
        // disagree with every other breakdown's resource count.
        bump('No meter reported', 0, false);
        return;
      }
      r.meters.forEach((m) => bump(m.name || 'Unnamed meter', m.cost ?? 0, m.cost != null));
    });
  } else {
    (resources || []).forEach((r) => bump(dim.get(r), r.cost ?? 0, r.cost != null));
  }

  return [...map.values()].sort((a, b) => b.cost - a.cost);
}

/** Total of a breakdown, for working out each row's share. */
export function totalOf(rows) {
  return rows.reduce((sum, r) => sum + r.cost, 0);
}

/**
 * Project the next `count` months by least-squares fit over the months given.
 *
 * Deliberately a straight line, and deliberately labelled as a projection
 * everywhere it is shown. Azure's own forecast endpoint knows about
 * reservations expiring and commitments starting; this knows only what has
 * been spent. Presenting it with more confidence than that would be a lie
 * about where the number came from.
 *
 * The month in progress is dropped before fitting: it is short by however many
 * days remain, and including it drags the whole line down.
 *
 * Fewer than three complete months returns nothing — two points always fit a
 * line perfectly, which produces a confident-looking projection from no
 * evidence at all.
 */
export function linearForecast(months, count = 3, { currentMonth } = {}) {
  const complete = (months || []).filter((m) => m.month !== currentMonth);
  if (complete.length < 3) return [];

  const n = complete.length;
  const ys = complete.map((m) => m.total_cost);
  const xs = complete.map((_, i) => i);
  const sx = xs.reduce((a, b) => a + b, 0);
  const sy = ys.reduce((a, b) => a + b, 0);
  const sxy = xs.reduce((a, x, i) => a + x * ys[i], 0);
  const sx2 = xs.reduce((a, x) => a + x * x, 0);

  const denom = n * sx2 - sx * sx;
  if (!denom) return [];

  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;

  const [ly, lm] = complete[n - 1].month.split('-').map(Number);
  return Array.from({ length: count }, (_, i) => {
    const offset = i + 1;
    const d = new Date(ly, lm - 1 + offset, 1);
    return {
      month: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      // Spend cannot go negative, however steep the downward fit.
      total_cost: Math.max(0, slope * (n - 1 + offset) + intercept),
      projected: true,
    };
  });
}

/** `YYYY-MM` for the month currently being billed. */
export function currentMonthKey(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}
