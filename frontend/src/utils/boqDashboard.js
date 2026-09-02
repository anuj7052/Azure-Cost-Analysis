/**
 * BOQ vs Actual -- the dashboard read of the same comparison.
 *
 * The detail table below it answers "which line is wrong". This answers the two
 * questions somebody asks before they get that far: how far off the estimate
 * are we in total, and what should I do about it. Both are derived from the
 * report `compareBoqToUsage` already produced, never from a second pass over
 * the raw rows -- a dashboard that recomputed its own totals could disagree
 * with the table underneath it, and then neither is believable.
 *
 * The budget is a monthly figure. Every series here therefore states the budget
 * it is drawn against at the same grain as the actuals it sits beside, so a
 * daily line is compared with a daily budget and not with a monthly one.
 */

const round2 = (n) => Math.round(n * 100) / 100;
const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

/** Days in the calendar month a date falls in — a daily budget needs the real
 *  divisor, not 30, or February reads as an overrun every year. */
export function daysInMonth(iso) {
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}

/**
 * The headline panel: budget, actual, the gap, and which way it is moving.
 *
 * `trend` compares the last complete pair of months in the cost data. With only
 * one month there is no trend, and it is reported as null rather than 0% —
 * "flat" and "unknown" are different answers.
 */
export function finops(report, months) {
  if (!report) return null;
  const budget = report.budgetTotal;
  const actual = report.actualTotal;
  const variance = round2(actual - budget);
  const series = Array.isArray(months) ? months.filter(m => isNum(m?.total_cost)) : [];
  let trendPct = null;
  if (series.length >= 2) {
    const prev = series[series.length - 2].total_cost;
    const curr = series[series.length - 1].total_cost;
    if (prev > 0) trendPct = round2(((curr - prev) / prev) * 100);
  }
  return {
    budget,
    actual,
    variance,
    variancePct: report.variancePct,
    // Above 100% means the estimate is being exceeded; the figure is the same
    // one the variance card states, expressed as consumption of the budget.
    consumedPct: budget > 0 ? round2((actual / budget) * 100) : null,
    overspend: variance > 0,
    trendPct,
    trendFrom: series.length >= 2 ? series[series.length - 2].month : null,
    trendTo: series.length >= 2 ? series[series.length - 1].month : null,
  };
}

/**
 * Daily actual spend against the daily share of the BOQ, plus the two running
 * totals — the pair that shows a month drifting over budget before it does.
 */
export function dailySeries(days, monthlyBudget) {
  const list = (Array.isArray(days) ? days : [])
    .filter(d => d && d.date && isNum(d.total))
    .slice()
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (!list.length) return [];
  let runActual = 0;
  let runBudget = 0;
  return list.map((d) => {
    const span = daysInMonth(d.date) || 30;
    const budget = isNum(monthlyBudget) && monthlyBudget > 0 ? monthlyBudget / span : null;
    runActual += d.total;
    if (budget !== null) runBudget += budget;
    return {
      date: String(d.date).slice(5),
      // The axis shows MM-DD because a full ISO date is unreadable at ninety
      // points wide, but the drill-down needs the real one to look the day up.
      full: String(d.date),
      actual: round2(d.total),
      budget: budget === null ? null : round2(budget),
      cumulativeActual: round2(runActual),
      cumulativeBudget: budget === null ? null : round2(runBudget),
      over: budget !== null && d.total > budget,
    };
  });
}

/** The same shape at month grain, for imported data with no daily detail. */
export function monthlySeries(months, monthlyBudget) {
  return (Array.isArray(months) ? months : [])
    .filter(m => m && m.month && isNum(m.total_cost))
    .map(m => ({
      date: m.month,
      actual: round2(m.total_cost),
      budget: isNum(monthlyBudget) && monthlyBudget > 0 ? round2(monthlyBudget) : null,
      over: isNum(monthlyBudget) && m.total_cost > monthlyBudget,
    }));
}

/**
 * Top N by a chosen measure, with everything else summed into one bar rather
 * than dropped — a "top 5" that quietly hides 40% of the bill is a chart that
 * misleads by omission.
 */
export function topSpend(report, measure = 'actual', limit = 5) {
  const cats = (report?.categories || []).filter(c => (c[measure] || 0) > 0);
  const sorted = cats.slice().sort((a, b) => (b[measure] || 0) - (a[measure] || 0));
  const head = sorted.slice(0, limit).map(c => ({
    key: c.key,
    name: c.label,
    value: round2(c[measure] || 0),
    budgeted: c.budgeted,
    actual: c.actual,
    variance: c.variance,
    over: c.variance > 0,
  }));
  const rest = sorted.slice(limit);
  if (rest.length) {
    head.push({
      key: '__rest__',
      name: `Other (${rest.length})`,
      value: round2(rest.reduce((s, c) => s + (c[measure] || 0), 0)),
      over: false,
      rest: true,
    });
  }
  return head;
}

const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2, good: 3 };

/**
 * The base recommendations.
 *
 * Each one names the money it is about and the category it came from, so it can
 * be traced back to a row in the table below. Nothing here is a generic tip:
 * a recommendation that would be true of any Azure estate is noise, and it
 * crowds out the one that is true of this one.
 *
 * Thresholds exist so a ₹40 rounding difference does not present itself as an
 * action. `minImpact` is in the report's currency and applies to every money
 * test below it. `per` is the phrase every figure is qualified with -- it comes
 * from the page rather than being assumed here, because the same report can be
 * built per month or across a whole quarter and a recommendation that says
 * "a month" about a quarter's money is simply wrong.
 */
export function recommend(report, { minImpact = 100, per = 'a month' } = {}) {
  if (!report) return [];
  const out = [];
  const cats = report.categories || [];

  // 1. Categories charging more than the estimate allowed, worst first. This is
  //    the whole point of the page, so it leads.
  for (const c of cats.filter(x => x.variance > minImpact && x.budgeted > 0)) {
    const pct = c.variancePct;
    out.push({
      id: `over:${c.key}`,
      severity: pct !== null && pct >= 50 ? 'critical' : 'warning',
      category: c.key,
      title: `${c.label} is over the estimate`,
      detail: `Budgeted ${c.budgeted} ${per}, charged ${c.actual}`
        + `${pct !== null ? ` — ${pct > 0 ? '+' : ''}${pct}%` : ''}.`,
      action: driverAdvice(c),
      impact: c.variance,
    });
  }

  // 2. Whole categories the estimate never mentioned. Different from an
  //    overrun: there is no budget line to compare against at all.
  for (const c of cats.filter(x => x.unbudgeted && x.actual > minImpact)) {
    out.push({
      id: `unbudgeted:${c.key}`,
      severity: 'critical',
      category: c.key,
      title: `${c.label} was never budgeted`,
      detail: `${c.actual} ${per} is being spent in a category the BOQ has no line for.`,
      action: 'Decide whether this was meant to be deployed. If it was, add it to the '
        + 'estimate so next month\'s comparison is honest; if not, it is a decommission '
        + 'candidate.',
      impact: c.actual,
    });
  }

  // 3. Individual charges inside a budgeted category that no line pays for.
  if (report.notInBoqTotal > minImpact) {
    const worst = (report.notInBoq || []).slice(0, 3);
    out.push({
      id: 'not-in-boq',
      severity: 'warning',
      title: 'Charges with no matching budget line',
      detail: `${report.notInBoqTotal} ${per} across ${report.notInBoq.length} charge`
        + `${report.notInBoq.length === 1 ? '' : 's'}`
        + `${worst.length ? `, led by ${worst.map(w => w.label).join(', ')}` : ''}.`,
      action: 'These sit inside categories the BOQ does budget for, so they do not show as '
        + 'unbudgeted — but nothing in the estimate pays for them specifically.',
      impact: report.notInBoqTotal,
    });
  }

  // 4. Budget bought and never used. The opposite failure, and the one nobody
  //    goes looking for, because it never causes a bill to rise.
  for (const c of cats.filter(x => x.unused && x.budgeted > minImpact)) {
    out.push({
      id: `unused:${c.key}`,
      severity: 'info',
      category: c.key,
      title: `${c.label} was budgeted but never deployed`,
      detail: `${c.budgeted} ${per} is set aside for something that is not being charged for.`,
      action: 'Either the deployment is outstanding or the budget can be released. Both are '
        + 'worth knowing before the next estimate is signed off.',
      impact: c.budgeted,
    });
  }

  // 5. Line level: more resources running than the estimate paid for. This is
  //    usually the single most actionable thing on the page, because it names
  //    a count rather than a category.
  for (const c of cats) {
    for (const line of c.lines || []) {
      const d = line.drivers;
      if (!d || d.extraUnits <= 0 || d.quantityEffect <= minImpact) continue;
      out.push({
        id: `qty:${line.id}`,
        severity: 'warning',
        category: c.key,
        title: `${d.billedCount} × ${line.sku || line.service_type} billed, ${d.qty} estimated`,
        detail: `${d.extraUnits} more than the BOQ paid for, worth ${d.quantityEffect} ${per} `
          + `at the estimated unit price of ${d.unitBudget}.`,
        action: 'Count the resources before you question the rate — this part of the overrun '
          + 'is quantity, not price.',
        impact: d.quantityEffect,
      });
    }
  }

  // 6. Line level: right number of resources, wrong price. Almost always a
  //    region, a tier, or a missing reservation.
  for (const c of cats) {
    for (const line of c.lines || []) {
      const d = line.drivers;
      if (!d || d.rateEffect <= minImpact) continue;
      if (d.extraUnits > 0 && d.rateEffect < d.quantityEffect) continue;
      out.push({
        id: `rate:${line.id}`,
        severity: 'warning',
        category: c.key,
        title: `${line.sku || line.service_type} costs more per unit than estimated`,
        detail: `Estimated ${d.unitBudget} each, billed ${d.unitActual} each — ${d.rateEffect} `
          + `${per} of the overrun is rate, not quantity.`,
        action: 'Check the region, the tier and whether a reservation or savings plan that '
          + 'the estimate assumed is actually in place.',
        impact: d.rateEffect,
      });
    }
  }

  // 7. Under budget overall, said plainly. Without it the page can only ever
  //    deliver bad news, which trains people to stop opening it.
  if (report.variance < 0 && Math.abs(report.variance) > minImpact) {
    out.push({
      id: 'under-budget',
      severity: 'good',
      title: 'Spending under the estimate',
      detail: `${Math.abs(report.variance)} ${per} less than the BOQ allowed for`
        + `${report.variancePct !== null ? ` (${report.variancePct}%)` : ''}.`,
      action: 'Worth confirming everything in the estimate was actually deployed before '
        + 'treating this as a saving.',
      impact: Math.abs(report.variance),
    });
  }

  return out.sort((a, b) => {
    const s = (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9);
    return s !== 0 ? s : b.impact - a.impact;
  });
}

/** Point an overrun at its cause when the line detail knows one. */
function driverAdvice(category) {
  const lines = (category.lines || []).filter(l => l.drivers && l.variance > 0);
  if (!lines.length) {
    return 'Open the category below to see which charges make up the difference.';
  }
  const qty = lines.reduce((s, l) => s + Math.max(0, l.drivers.quantityEffect), 0);
  const rate = lines.reduce((s, l) => s + Math.max(0, l.drivers.rateEffect), 0);
  if (qty > rate * 1.5) return 'Mostly quantity — more resources are running than were estimated.';
  if (rate > qty * 1.5) return 'Mostly rate — each resource costs more than the estimate assumed.';
  return 'Both quantity and rate are contributing; the line breakdown below splits them.';
}
