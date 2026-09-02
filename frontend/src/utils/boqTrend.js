/**
 * Explaining a number on the BOQ page rather than only stating it.
 *
 * The dashboard says what a day cost and what a month cost. It does not say
 * why, and "why" is the only question anybody asks twice. Three answers live
 * here, and all three are built from data the page already holds so that none
 * of them can disagree with the totals they sit under:
 *
 *   dayDetail   -- what made up one day, and what moved since the day before
 *   dayTimeline -- the days worth noticing, and what happened on each
 *   movement    -- why this month differs from the last, service by service
 *
 * Every one of them reports a change against a named comparison. A figure with
 * nothing to compare it to is returned as null rather than as zero, because on
 * a page about variance those two read identically and mean opposite things.
 */

const round2 = (n) => Math.round(n * 100) / 100;
const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

/** Sorted ascending, and only the days that actually carry a number. */
function usable(days) {
  return (Array.isArray(days) ? days : [])
    .filter(d => d && d.date && isNum(d.total))
    .slice()
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

/**
 * Everything charged on one day, and what changed since the previous one.
 *
 * The previous day is the right comparison rather than the period average: a
 * spike is caused by something that was not there yesterday, and an average
 * hides exactly that. When there is no previous day the deltas are null, not
 * zero -- the first day of a series has not "stayed flat", it is simply the
 * first thing measured.
 *
 * @param days      the daily series, each `{date, total, by_service}`
 * @param date      which day to explain
 * @param budget    the BOQ's budget for a single day, or null if there is none
 */
export function dayDetail(days, date, budget = null) {
  const list = usable(days);
  const index = list.findIndex(d => String(d.date) === String(date));
  if (index === -1) return null;

  const day = list[index];
  const before = index > 0 ? list[index - 1] : null;
  const prior = (before && before.by_service) || null;
  const total = round2(day.total);

  const services = Object.entries(day.by_service || {})
    .filter(([, cost]) => isNum(cost))
    .map(([name, cost]) => {
      const was = prior && isNum(prior[name]) ? prior[name] : null;
      const delta = prior === null ? null : round2(cost - (was || 0));
      return {
        name,
        cost: round2(cost),
        // Share of the day, which is what makes a list of forty services
        // readable -- the eye goes to the two that are most of the bill.
        share: total > 0 ? round2((cost / total) * 100) : 0,
        was: was === null ? null : round2(was),
        delta,
        // A service that was not billed yesterday and is billed today is the
        // single most useful thing this panel can point at.
        isNew: prior !== null && was === null,
      };
    })
    .sort((a, b) => b.cost - a.cost);

  // Services that stopped: they are part of the explanation for a day that
  // fell, and they are invisible if only today's services are listed.
  const gone = prior
    ? Object.entries(prior)
      .filter(([name, cost]) => isNum(cost) && cost > 0 && !(name in (day.by_service || {})))
      .map(([name, cost]) => ({
        name,
        cost: 0,
        share: 0,
        was: round2(cost),
        delta: round2(-cost),
        isNew: false,
        stopped: true,
      }))
    : [];

  const all = [...services, ...gone];
  const change = before ? round2(day.total - before.total) : null;

  return {
    date: day.date,
    total,
    services: all,
    previousDate: before ? before.date : null,
    previousTotal: before ? round2(before.total) : null,
    change,
    changePct: before && before.total > 0 ? round2((change / before.total) * 100) : null,
    budget: isNum(budget) ? round2(budget) : null,
    overBudget: isNum(budget) ? day.total > budget : null,
    // What actually moved, largest first, so the day can be explained in a
    // sentence instead of a table.
    movers: all
      .filter(s => s.delta !== null && Math.abs(s.delta) > 0.5)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
      .slice(0, 5),
  };
}

/**
 * The days worth looking at, newest first.
 *
 * A timeline of every day is a list, not a timeline. Only days that did
 * something are kept: a jump or drop against the previous day, a day over the
 * BOQ's daily budget, a service billed for the first time or the last. The
 * threshold is a share of the median day rather than a fixed amount, because a
 * ₹5,000 swing is an emergency on one estate and rounding on another.
 *
 * @param days   the daily series
 * @param budget the BOQ's budget for a single day, or null
 * @param opts.sensitivity  fraction of the median day that counts as a jump
 */
export function dayTimeline(days, budget = null, { sensitivity = 0.25, limit = 40 } = {}) {
  const list = usable(days);
  if (list.length < 2) return [];

  const totals = list.map(d => d.total).sort((a, b) => a - b);
  const median = totals[Math.floor(totals.length / 2)] || 0;
  const threshold = Math.max(median * sensitivity, 1);

  const events = [];
  for (let i = 1; i < list.length; i += 1) {
    const day = list[i];
    const before = list[i - 1];
    const delta = day.total - before.total;
    const services = day.by_service || {};
    const prior = before.by_service || {};

    const appeared = Object.keys(services)
      .filter(name => isNum(services[name]) && services[name] > threshold * 0.2 && !(name in prior));
    const vanished = Object.keys(prior)
      .filter(name => isNum(prior[name]) && prior[name] > threshold * 0.2 && !(name in services));

    // Ranked so one day produces one entry: the biggest thing that happened.
    // Several entries for the same date reads as several days.
    if (Math.abs(delta) >= threshold) {
      const movers = Object.keys({ ...services, ...prior })
        .map(name => ({ name, delta: (services[name] || 0) - (prior[name] || 0) }))
        .filter(m => Math.abs(m.delta) > 0.5)
        .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
        .slice(0, 3);
      events.push({
        date: day.date,
        kind: delta > 0 ? 'spike' : 'drop',
        total: round2(day.total),
        delta: round2(delta),
        deltaPct: before.total > 0 ? round2((delta / before.total) * 100) : null,
        title: `${delta > 0 ? 'Jumped' : 'Fell'} against the day before`,
        drivers: movers.map(m => ({ name: m.name, delta: round2(m.delta) })),
      });
    } else if (appeared.length) {
      events.push({
        date: day.date,
        kind: 'started',
        total: round2(day.total),
        delta: round2(delta),
        deltaPct: before.total > 0 ? round2((delta / before.total) * 100) : null,
        title: appeared.length === 1
          ? `${appeared[0]} was billed for the first time`
          : `${appeared.length} services were billed for the first time`,
        drivers: appeared.slice(0, 3).map(name => ({ name, delta: round2(services[name]) })),
      });
    } else if (vanished.length) {
      events.push({
        date: day.date,
        kind: 'stopped',
        total: round2(day.total),
        delta: round2(delta),
        deltaPct: before.total > 0 ? round2((delta / before.total) * 100) : null,
        title: vanished.length === 1
          ? `${vanished[0]} stopped being billed`
          : `${vanished.length} services stopped being billed`,
        drivers: vanished.slice(0, 3).map(name => ({ name, delta: round2(-prior[name]) })),
      });
    } else if (isNum(budget) && budget > 0 && day.total > budget && before.total <= budget) {
      // Only the crossing, not every day above the line. A budget exceeded for
      // three weeks is one event that has not been dealt with, not twenty-one.
      events.push({
        date: day.date,
        kind: 'over',
        total: round2(day.total),
        delta: round2(delta),
        deltaPct: before.total > 0 ? round2((delta / before.total) * 100) : null,
        title: 'Went above the BOQ’s daily budget',
        drivers: [],
      });
    }
  }

  return events.reverse().slice(0, limit);
}

/**
 * One service across the whole period, rather than on one day.
 *
 * The day panel answers "what made today expensive". The answer is usually a
 * service name, and the immediate next question is whether that service is
 * always like this or whether today was unusual. That cannot be read from a
 * single day, so this pulls the same service out of every day in the range and
 * says how it behaves: what it normally costs, when it peaked, and whether it
 * stopped anywhere in between.
 *
 * Days on which the service was not billed at all are kept in the series as
 * zero, because the gaps are the interesting part -- a service billed on nine
 * days out of ninety is a very different finding from one billed on all
 * ninety, and dropping the empty days makes the two look identical.
 *
 * @param days         the daily series, each `{date, total, by_service}`
 * @param name         the service to follow
 * @param dailyBudget  the BOQ's budget for a single day, or null
 */
export function serviceDetail(days, name, dailyBudget = null) {
  const list = usable(days);
  if (!list.length || !name) return null;

  const points = list.map(d => ({
    date: d.date,
    cost: isNum(d.by_service?.[name]) ? round2(d.by_service[name]) : 0,
    dayTotal: round2(d.total),
  }));

  const billed = points.filter(p => p.cost > 0);
  if (!billed.length) return null;

  const total = round2(billed.reduce((s, p) => s + p.cost, 0));
  const periodTotal = round2(list.reduce((s, d) => s + d.total, 0));
  const sorted = billed.slice().sort((a, b) => b.cost - a.cost);

  // Day-to-day movement within this one service. A service can be flat in
  // total while swinging wildly underneath, and that is worth seeing.
  const moves = [];
  for (let i = 1; i < points.length; i += 1) {
    const delta = round2(points[i].cost - points[i - 1].cost);
    if (Math.abs(delta) > 0.5) {
      moves.push({ date: points[i].date, from: points[i - 1].cost, to: points[i].cost, delta });
    }
  }

  // Runs of days with no charge, between the first and last day it was billed.
  // Leading and trailing zeroes are not gaps -- they are simply before it
  // started and after it stopped, which the dates already say.
  const firstIndex = points.findIndex(p => p.cost > 0);
  const lastIndex = points.length - 1 - points.slice().reverse().findIndex(p => p.cost > 0);
  const gaps = [];
  let run = null;
  for (let i = firstIndex; i <= lastIndex; i += 1) {
    if (points[i].cost === 0) {
      if (run) run.to = points[i].date;
      else run = { from: points[i].date, to: points[i].date, days: 0 };
      run.days += 1;
    } else if (run) {
      gaps.push(run);
      run = null;
    }
  }
  if (run) gaps.push(run);

  // First half against second half, which says whether it is growing without
  // pretending a straight line was fitted to it.
  const half = Math.floor(points.length / 2);
  const early = round2(points.slice(0, half).reduce((s, p) => s + p.cost, 0));
  const late = round2(points.slice(half).reduce((s, p) => s + p.cost, 0));
  const drift = round2(late - early);

  return {
    name,
    total,
    // Share of everything charged in the period, which is the figure that says
    // whether this service is worth anybody's attention at all.
    share: periodTotal > 0 ? round2((total / periodTotal) * 100) : 0,
    points,
    daysBilled: billed.length,
    daysInPeriod: points.length,
    everyDay: billed.length === points.length,
    average: round2(total / billed.length),
    peak: sorted[0],
    quietest: sorted[sorted.length - 1],
    first: billed[0].date,
    last: billed[billed.length - 1].date,
    gaps,
    // The service's own share of the day it peaked on -- "it was 80% of that
    // day" explains a spike far better than the amount does.
    peakShare: sorted[0].dayTotal > 0
      ? round2((sorted[0].cost / sorted[0].dayTotal) * 100)
      : null,
    moves: moves.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 5),
    drift,
    driftPct: early > 0 ? round2((drift / early) * 100) : null,
    // Only meaningful when it is the whole of the budget line, so this is
    // offered as context rather than as a verdict.
    dailyBudget: isNum(dailyBudget) ? round2(dailyBudget) : null,
  };
}

/** Every month present in the rows, oldest first. */
export function monthsOf(rows) {
  const list = Array.isArray(rows) ? rows.filter(r => r && r.month && isNum(r.cost)) : [];
  return [...new Set(list.map(r => String(r.month)))].sort();
}

/**
 * Why this month costs more or less than another, in BOQ terms.
 *
 * The Compare page answers this for services. This answers it beside the
 * budget, which is the version somebody defending an estimate actually needs:
 * not "Storage rose 12%", but "Storage rose 12% and it was already over its
 * BOQ line". The budget shown is always the monthly figure, whatever basis the
 * report is on, because a month-to-month change can only be read against one
 * month of budget.
 *
 * Defaults to the two most recent months, which is the question most people
 * arrive with, but any two months in the range can be named instead -- a rise
 * that happened in March is not explained by comparing July with June.
 *
 * Returns null when there are not two months to compare -- with one month there
 * is no change, and reporting 0% would claim the cost was measured and found
 * flat.
 *
 * @param rows        usage rows carrying `month`, `service` and `cost`
 * @param bucketOf    the same bucketing function the comparison itself uses
 * @param report      the comparison, for each category's monthly budget
 * @param opts.from   the earlier month to compare, defaulting to the last but one
 * @param opts.to     the later month, defaulting to the most recent
 */
export function movement(rows, bucketOf, report, opts = {}) {
  const list = Array.isArray(rows) ? rows.filter(r => r && r.month && isNum(r.cost)) : [];
  if (!list.length) return null;

  const months = [...new Set(list.map(r => String(r.month)))].sort();
  if (months.length < 2) return null;

  // A named month is only honoured if it is actually in the data and the two
  // are different; otherwise the panel would compare a month with itself and
  // report a confident zero.
  const wanted = (v, fallback) => (v && months.includes(String(v)) ? String(v) : fallback);
  let to = wanted(opts.to, months[months.length - 1]);
  let from = wanted(opts.from, months[months.length - 2]);
  if (from === to) {
    const other = months.filter(m => m !== to);
    from = other[other.length - 1];
  }
  // Read left to right in time, whichever way round they were chosen.
  if (from > to) [from, to] = [to, from];

  // Two passes would mean two chances to disagree; one pass fills both months.
  const byCategory = new Map();
  for (const row of list) {
    const month = String(row.month);
    if (month !== to && month !== from) continue;
    const bucket = bucketOf(row.service);
    const held = byCategory.get(bucket.key)
      || { key: bucket.key, label: bucket.label, from: 0, to: 0, services: new Map() };
    if (month === to) held.to += row.cost; else held.from += row.cost;
    const svc = held.services.get(row.service) || { name: row.service, from: 0, to: 0 };
    if (month === to) svc.to += row.cost; else svc.from += row.cost;
    held.services.set(row.service, svc);
    byCategory.set(bucket.key, held);
  }

  // The monthly budget per category, taken from the report and divided back out
  // of whatever basis it was built on, so it is a month either way.
  const factor = report?.budgetFactor || 1;
  const budgetOf = new Map(
    (report?.categories || []).map(c => [c.key, c.budgeted / factor]),
  );

  const categories = [...byCategory.values()].map((c) => {
    const delta = c.to - c.from;
    const budgeted = budgetOf.has(c.key) ? round2(budgetOf.get(c.key)) : 0;
    return {
      key: c.key,
      label: c.label,
      from: round2(c.from),
      to: round2(c.to),
      delta: round2(delta),
      deltaPct: c.from > 0 ? round2((delta / c.from) * 100) : null,
      budgeted,
      // Whether the change pushed it over the line, stayed over, came back
      // under, or was never a problem. This is the whole reason the movement is
      // shown here rather than on the Compare page.
      verdict: verdictFor(c.from, c.to, budgeted),
      services: [...c.services.values()]
        .map(s => ({
          name: s.name,
          from: round2(s.from),
          to: round2(s.to),
          delta: round2(s.to - s.from),
        }))
        .filter(s => Math.abs(s.delta) > 0.5)
        .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
        .slice(0, 5),
    };
  }).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  const fromTotal = round2(categories.reduce((s, c) => s + c.from, 0));
  const toTotal = round2(categories.reduce((s, c) => s + c.to, 0));
  const delta = round2(toTotal - fromTotal);

  return {
    from,
    to,
    // Offered so the page can let the reader pick a different pair without
    // scanning the rows a second time and possibly disagreeing about which
    // months exist.
    months,
    fromTotal,
    toTotal,
    delta,
    deltaPct: fromTotal > 0 ? round2((delta / fromTotal) * 100) : null,
    categories: categories.filter(c => Math.abs(c.delta) > 0.5),
    // Named separately because "what went up" and "what came down" are two
    // different conversations and merging them buries the smaller one.
    rose: categories.filter(c => c.delta > 0.5).slice(0, 5),
    fell: categories.filter(c => c.delta < -0.5).slice(0, 5),
  };
}

/** Where a category stood before and after, against its monthly BOQ line. */
function verdictFor(from, to, budgeted) {
  if (!budgeted) return to > 0 ? 'unbudgeted' : 'none';
  const wasOver = from > budgeted;
  const isOver = to > budgeted;
  if (isOver && wasOver) return 'still-over';
  if (isOver && !wasOver) return 'now-over';
  if (!isOver && wasOver) return 'back-under';
  return 'under';
}
