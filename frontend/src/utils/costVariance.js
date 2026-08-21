// Explains *why* the bill moved between two months.
//
// A total like "+₹1.2L" says nothing actionable on its own. Azure bills every
// line as quantity × unit rate, so a rise is always one of four things: new
// resources appeared, old ones went away, existing ones were used more/less, or
// the rate they bill at changed (tier change, reservation expiry, region move,
// FX). This module attributes every rupee of the swing to one of those causes.

const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

/** Every month present in a set of imported rows, oldest first. */
export function monthsIn(rows) {
  return [...new Set(rows.map(r => r.month))].filter(Boolean).sort();
}

/**
 * The finest granularity we can attribute a change to.
 *
 * Meter is included because one resource can bill several meters (a disk has a
 * capacity charge and a transaction charge) and they move independently — an
 * increase in transactions must not be blamed on the capacity tier.
 */
function itemKey(r) {
  return [
    r.subscription_id || '',
    r.resource_group || '',
    r.resource_name || '',
    r.service || '',
    r.meter || '',
  ].join('\u0000');
}

const GROUPERS = {
  service: r => r.service || 'Unknown service',
  resource_group: r => r.resource_group || 'Ungrouped',
  resource: r => r.resource_name || r.service || 'Unknown resource',
  subscription: r => r.subscription_id || 'Unknown subscription',
  meter: r => r.meter || r.service || 'Unknown meter',
};

export const GROUP_OPTIONS = [
  { value: 'service', label: 'Service' },
  { value: 'resource', label: 'Resource' },
  { value: 'resource_group', label: 'Resource group' },
  { value: 'meter', label: 'Meter' },
  { value: 'subscription', label: 'Subscription' },
];

export const REASONS = {
  new: { label: 'New', hint: 'Did not exist in the earlier month' },
  removed: { label: 'Removed', hint: 'Was billing before, gone now' },
  usage: { label: 'Usage', hint: 'Same unit rate, different quantity' },
  rate: { label: 'Rate', hint: 'Same quantity, different unit price' },
  mixed: { label: 'Mixed', hint: 'Usage and rate both moved' },
  flat: { label: 'No change', hint: 'Cost held steady' },
};

/**
 * Split a change into the part caused by quantity and the part caused by rate.
 *
 *   Δcost = (q1 − q0)·p0  +  (p1 − p0)·q1
 *            ^ usage effect   ^ rate effect
 *
 * That identity is exact — the two effects always sum back to Δcost — so the
 * waterfall never leaves an unexplained remainder.
 */
function attribute(prev, curr) {
  const delta = curr.cost - prev.cost;

  if (prev.cost === 0 && curr.cost !== 0) {
    return { delta, usage: delta, rate: 0, reason: 'new' };
  }
  if (curr.cost === 0 && prev.cost !== 0) {
    return { delta, usage: delta, rate: 0, reason: 'removed' };
  }
  if (Math.abs(delta) < 0.005) {
    return { delta: 0, usage: 0, rate: 0, reason: 'flat' };
  }

  // Without a quantity column (many partner exports drop it) a rate cannot be
  // derived, so the whole move is reported as usage rather than invented.
  if (!(prev.qty > 0) || !(curr.qty > 0)) {
    return { delta, usage: delta, rate: 0, reason: 'usage' };
  }

  const p0 = prev.cost / prev.qty;
  const p1 = curr.cost / curr.qty;
  const usage = (curr.qty - prev.qty) * p0;
  const rate = (p1 - p0) * curr.qty;

  const au = Math.abs(usage);
  const ar = Math.abs(rate);
  let reason = 'mixed';
  if (ar < au * 0.2) reason = 'usage';
  else if (au < ar * 0.2) reason = 'rate';

  return { delta, usage, rate, reason, prev_rate: p0, curr_rate: p1 };
}

/**
 * Compare two months of imported rows and explain the difference.
 *
 * `rows` must already be filtered to the subscriptions the user cares about —
 * the caller owns filtering so this stays a pure function.
 */
export function buildVariance(rows, prevMonth, currMonth, { groupBy = 'service' } = {}) {
  const groupOf = GROUPERS[groupBy] || GROUPERS.service;
  const items = new Map();

  for (const r of rows) {
    const side = r.month === prevMonth ? 'prev' : r.month === currMonth ? 'curr' : null;
    if (!side) continue;

    const key = itemKey(r);
    let item = items.get(key);
    if (!item) {
      item = {
        key,
        group: groupOf(r),
        service: r.service || '',
        meter: r.meter || '',
        resource_name: r.resource_name || '',
        resource_group: r.resource_group || '',
        subscription_id: r.subscription_id || '',
        region: r.region || '',
        unit: r.unit_of_measure || '',
        prev: { cost: 0, qty: 0 },
        curr: { cost: 0, qty: 0 },
      };
      items.set(key, item);
    }
    item[side].cost += r.cost || 0;
    item[side].qty += r.quantity || 0;
    // A resource that only exists in the newer file still needs a label.
    if (side === 'curr') item.group = groupOf(r);
  }

  const detailed = [];
  for (const item of items.values()) {
    const a = attribute(item.prev, item.curr);
    if (a.reason === 'flat' && item.prev.cost === 0) continue;
    detailed.push({ ...item, ...a });
  }

  // Roll the line-level attribution up to whatever the user is grouping by.
  const groups = new Map();
  for (const d of detailed) {
    let g = groups.get(d.group);
    if (!g) {
      g = {
        key: d.group, label: d.group,
        prev: 0, curr: 0, delta: 0,
        added: 0, removed: 0, usage: 0, rate: 0,
        items: [],
      };
      groups.set(d.group, g);
    }
    g.prev += d.prev.cost;
    g.curr += d.curr.cost;
    g.delta += d.delta;
    // A group usually mixes causes — a service can gain a new VM *and* take a
    // rate rise on an old one. Keeping the four buckets apart is what lets the
    // row name the cause that actually dominates.
    if (d.reason === 'new') g.added += d.delta;
    else if (d.reason === 'removed') g.removed += d.delta;
    else { g.usage += d.usage; g.rate += d.rate; }
    g.items.push(d);
  }

  /** The bucket responsible for most of a group's movement. */
  const dominant = (g) => {
    const parts = [
      ['new', g.added], ['removed', g.removed], ['usage', g.usage], ['rate', g.rate],
    ].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    const [topName, topValue] = parts[0];
    if (Math.abs(topValue) < 0.005) return 'flat';
    // Only call it a single cause when it clearly outweighs the runner-up.
    return Math.abs(parts[1][1]) > Math.abs(topValue) * 0.6 ? 'mixed' : topName;
  };

  const groupList = [...groups.values()]
    .map(g => ({
      ...g,
      prev: round(g.prev),
      curr: round(g.curr),
      delta: round(g.delta),
      added: round(g.added),
      removed: round(g.removed),
      usage: round(g.usage),
      rate: round(g.rate),
      pct: g.prev > 0 ? round((g.curr - g.prev) / g.prev * 100, 1) : null,
      reason: dominant(g),
      items: g.items
        .filter(i => Math.abs(i.delta) >= 0.005)
        .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
        .map(i => ({
          key: i.key,
          label: i.resource_name || i.meter || i.service,
          meter: i.meter,
          service: i.service,
          resource_name: i.resource_name,
          resource_group: i.resource_group,
          subscription_id: i.subscription_id,
          // Region travels with the line because a published Azure price is
          // region-specific: quoting one region's list price against another
          // region's bill is a wrong comparison stated confidently.
          region: i.region,
          unit: i.unit,
          prev_cost: round(i.prev.cost),
          curr_cost: round(i.curr.cost),
          prev_qty: round(i.prev.qty, 3),
          curr_qty: round(i.curr.qty, 3),
          prev_rate: i.prev_rate != null ? round(i.prev_rate, 4) : null,
          curr_rate: i.curr_rate != null ? round(i.curr_rate, 4) : null,
          delta: round(i.delta),
          usage: round(i.usage),
          rate: round(i.rate),
          reason: i.reason,
        })),
    }))
    .filter(g => Math.abs(g.delta) >= 0.005 || g.prev > 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  const prevTotal = detailed.reduce((s, d) => s + d.prev.cost, 0);
  const currTotal = detailed.reduce((s, d) => s + d.curr.cost, 0);

  const bucket = { new: 0, removed: 0, usage: 0, rate: 0 };
  for (const d of detailed) {
    if (d.reason === 'new') bucket.new += d.delta;
    else if (d.reason === 'removed') bucket.removed += d.delta;
    else { bucket.usage += d.usage; bucket.rate += d.rate; }
  }

  return {
    prevMonth,
    currMonth,
    prev_total: round(prevTotal),
    curr_total: round(currTotal),
    delta: round(currTotal - prevTotal),
    pct: prevTotal > 0 ? round((currTotal - prevTotal) / prevTotal * 100, 1) : null,
    increase_total: round(detailed.reduce((s, d) => s + Math.max(d.delta, 0), 0)),
    decrease_total: round(detailed.reduce((s, d) => s + Math.min(d.delta, 0), 0)),
    drivers: {
      new: round(bucket.new),
      removed: round(bucket.removed),
      usage: round(bucket.usage),
      rate: round(bucket.rate),
    },
    groups: groupList,
  };
}

// ── Plain-English explanations ─────────────────────────────────────────────
//
// The numbers above are exact but not self-explanatory: "+₹1.04K, usage +₹1.10K,
// rate −₹58" still needs decoding. These helpers turn the same attribution into
// a sentence a human can act on, which is the whole point of the page.

/** Azure writes units like "1 Hour" or "10 GB/Month" — drop the leading count. */
const bareUnit = (unit) => (unit || '').replace(/^\s*\d+(\.\d+)?\s*/, '').trim();

function quantityStory(item) {
  const delta = item.curr_qty - item.prev_qty;
  if (Math.abs(delta) < 1e-6) return null;

  const unit = bareUnit(item.unit) || 'units';
  const more = delta > 0;
  const abs = Math.abs(delta);
  const range = `${item.prev_qty} → ${item.curr_qty}`;

  // Hours are the common case for VMs, and "ran 5 more days" is far more
  // actionable than "used 128 more units".
  if (/hour/i.test(unit)) {
    const days = abs / 24;
    return `it ran for ${abs.toFixed(1)} ${more ? 'more' : 'fewer'} hours (${range})`
      + (days >= 0.5 ? `, about ${days.toFixed(1)} ${more ? 'extra' : 'fewer'} days of uptime` : '');
  }
  if (/gb|gib|tb|tib|byte/i.test(unit)) {
    return `it ${more ? 'stored or moved more' : 'stored or moved less'} data — ${range} ${unit}`;
  }
  return `its quantity went ${more ? 'up' : 'down'}, ${range} ${unit}`;
}

function rateStory(item) {
  if (item.prev_rate == null || item.curr_rate == null) return null;
  const delta = item.curr_rate - item.prev_rate;
  if (Math.abs(delta) < 1e-9) return null;
  const pct = item.prev_rate ? (delta / item.prev_rate) * 100 : null;
  return `the unit rate ${delta > 0 ? 'rose' : 'fell'} from ${item.prev_rate} to ${item.curr_rate}`
    + (pct != null ? ` (${pct > 0 ? '+' : ''}${pct.toFixed(1)}%)` : '');
}

/** One sentence explaining a single line item. `money` formats an amount. */
export function explainItem(item, { money, prevMonth, currMonth }) {
  const m = (v) => money(Math.abs(v));

  if (item.reason === 'new') {
    return `Did not bill at all in ${prevMonth}. It appeared in ${currMonth} and added ${m(item.delta)}.`;
  }
  if (item.reason === 'removed') {
    return `Billed ${m(item.prev_cost)} in ${prevMonth} and nothing in ${currMonth} — it was stopped or deleted, saving ${m(item.delta)}.`;
  }

  const parts = [];
  const qty = quantityStory(item);
  const rate = rateStory(item);
  if (qty) parts.push(`${qty}, ${item.usage >= 0 ? 'adding' : 'saving'} ${m(item.usage)}`);
  if (rate) parts.push(`${rate}, ${item.rate >= 0 ? 'adding' : 'saving'} ${m(item.rate)}`);

  if (!parts.length) {
    return `Cost moved ${item.delta > 0 ? 'up' : 'down'} by ${m(item.delta)} with no quantity detail in the export.`;
  }
  return `Net ${item.delta > 0 ? 'increase' : 'decrease'} of ${m(item.delta)} because ${parts.join('; and ')}.`;
}

/** One sentence explaining a whole service / resource group / meter. */
export function explainGroup(group, { money, prevMonth }) {
  const m = (v) => money(Math.abs(v));
  const bits = [];
  if (Math.abs(group.added) >= 0.005) {
    bits.push(`${m(group.added)} from resources that did not exist in ${prevMonth}`);
  }
  if (Math.abs(group.removed) >= 0.005) {
    bits.push(`${m(group.removed)} saved from resources that stopped billing`);
  }
  if (Math.abs(group.usage) >= 0.005) {
    bits.push(`${m(group.usage)} ${group.usage > 0 ? 'added by higher usage' : 'saved by lower usage'}`);
  }
  if (Math.abs(group.rate) >= 0.005) {
    bits.push(`${m(group.rate)} ${group.rate > 0 ? 'added by higher unit rates' : 'saved by lower unit rates'}`);
  }
  if (!bits.length) return `${group.label} did not move.`;

  return `${group.label} ${group.delta > 0 ? 'rose' : 'fell'} ${m(group.delta)} — ${bits.join(', ')}.`;
}

/** The headline narrative for the whole comparison. */
export function explainTotal(variance, { money }) {
  const m = (v) => money(Math.abs(v));
  const { drivers, delta, prevMonth, currMonth, groups } = variance;

  if (Math.abs(delta) < 0.005) {
    return `Spend was effectively flat between ${prevMonth} and ${currMonth}.`;
  }

  const ranked = [
    ['newly added resources', drivers.new],
    ['resources that stopped billing', drivers.removed],
    ['usage going up or down', drivers.usage],
    ['unit-rate changes', drivers.rate],
  ].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));

  const top = groups[0];
  const lead = `Spend ${delta > 0 ? 'rose' : 'fell'} ${m(delta)} from ${prevMonth} to ${currMonth}.`;
  const cause = `The largest force was ${ranked[0][0]}, worth ${m(ranked[0][1])}.`;
  const where = top
    ? ` The single biggest mover was ${top.label} at ${m(top.delta)}.`
    : '';

  return `${lead} ${cause}${where}`;
}

/* ------------------------------------------------------------------ *
 * All-months trend
 * ------------------------------------------------------------------ */

/**
 * Spread every imported month across a single table instead of comparing just
 * two. Scales to however many files have been imported — three months, twelve,
 * whatever `rows` contains.
 *
 * Returns per-month totals, the month-over-month steps between them, and one
 * row per group carrying a cost for every month.
 */
export function buildTrend(rows, { groupBy = 'service' } = {}) {
  const groupOf = GROUPERS[groupBy] || GROUPERS.service;
  const months = monthsIn(rows);
  if (!months.length) return null;

  const index = new Map(months.map((m, i) => [m, i]));
  const zeros = () => months.map(() => 0);

  const totals = zeros();
  const groups = new Map();

  for (const r of rows) {
    const i = index.get(r.month);
    if (i === undefined) continue;
    const cost = Number(r.cost) || 0;

    totals[i] += cost;

    const key = groupOf(r);
    let g = groups.get(key);
    if (!g) {
      g = { key, label: key, costs: zeros() };
      groups.set(key, g);
    }
    g.costs[i] += cost;
  }

  // Month-over-month steps: one fewer than the number of months.
  const steps = months.slice(1).map((month, i) => {
    const from = totals[i];
    const to = totals[i + 1];
    const delta = to - from;
    return {
      from: months[i],
      to: month,
      prev: round(from),
      curr: round(to),
      delta: round(delta),
      pct: from > 0 ? round((delta / from) * 100, 1) : null,
    };
  });

  const list = [...groups.values()].map(g => {
    const costs = g.costs.map(c => round(c));
    const first = costs[0];
    const last = costs[costs.length - 1];
    const delta = round(last - first);
    // The largest single month-over-month jump, so a spike in the middle of the
    // range is not hidden by a first-to-last comparison that nets out.
    let peakStep = null;
    for (let i = 1; i < costs.length; i += 1) {
      const d = costs[i] - costs[i - 1];
      if (!peakStep || Math.abs(d) > Math.abs(peakStep.delta)) {
        peakStep = { from: months[i - 1], to: months[i], delta: round(d) };
      }
    }
    return {
      ...g,
      costs,
      total: round(costs.reduce((a, b) => a + b, 0)),
      avg: round(costs.reduce((a, b) => a + b, 0) / costs.length),
      first,
      last,
      delta,
      pct: first > 0 ? round((delta / first) * 100, 1) : null,
      peakStep,
    };
  });

  list.sort((a, b) => b.total - a.total);

  const grand = totals.reduce((a, b) => a + b, 0);
  return {
    months,
    totals: totals.map(t => round(t)),
    steps,
    groups: list,
    grand_total: round(grand),
    avg_month: round(grand / months.length),
    max_month: round(Math.max(...totals)),
    min_month: round(Math.min(...totals)),
  };
}

/** The name of the force behind a step, in words. */
function topDriver(variance) {
  const ranked = [
    ['new resources appearing', variance.drivers.new],
    ['resources shutting down', variance.drivers.removed],
    ['usage going up or down', variance.drivers.usage],
    ['unit-rate changes', variance.drivers.rate],
  ].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  return ranked[0];
}

/**
 * One sentence for a single month-over-month step in the trend, naming both
 * the force behind it and the group that moved most.
 */
export function explainStep(variance, { money }) {
  const m = (v) => money(Math.abs(v));
  const { delta, prevMonth, currMonth, groups } = variance;

  if (Math.abs(delta) < 0.005) {
    return `${prevMonth} → ${currMonth}: essentially flat.`;
  }
  const [name, value] = topDriver(variance);
  const top = groups[0];
  const where = top ? ` ${top.label} moved the most, at ${m(top.delta)}.` : '';
  return `${prevMonth} → ${currMonth}: spend ${delta > 0 ? 'rose' : 'fell'} ${m(delta)}, mostly from ${name} (${m(value)}).${where}`;
}

/** The headline narrative across every imported month. */
export function explainTrend(trend, variances, { money }) {
  const m = (v) => money(Math.abs(v));
  const { months, totals } = trend;

  if (months.length < 2) return `Only ${months[0]} is loaded, so there is nothing to compare yet.`;

  const first = totals[0];
  const last = totals[totals.length - 1];
  const delta = last - first;
  const pct = first > 0 ? Math.round((delta / first) * 1000) / 10 : null;

  const hi = totals.indexOf(Math.max(...totals));
  const lo = totals.indexOf(Math.min(...totals));

  const lead = Math.abs(delta) < 0.005
    ? `Spend ended ${months[months.length - 1]} at the same level it started in ${months[0]}.`
    : `Across ${months.length} months spend ${delta > 0 ? 'rose' : 'fell'} ${m(delta)}${pct == null ? '' : ` (${pct > 0 ? '+' : ''}${pct}%)`}, from ${money(first)} in ${months[0]} to ${money(last)} in ${months[months.length - 1]}.`;

  const range = `The most expensive month was ${months[hi]} at ${money(totals[hi])} and the cheapest ${months[lo]} at ${money(totals[lo])}.`;

  // Name the single largest swing and what caused it.
  let biggest = '';
  if (variances?.length) {
    const worst = [...variances].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0];
    if (worst && Math.abs(worst.delta) >= 0.005) {
      const [name, value] = topDriver(worst);
      biggest = ` The sharpest single move was ${worst.prevMonth} → ${worst.currMonth} at ${m(worst.delta)}, driven mainly by ${name} (${m(value)}).`;
    }
  }

  return `${lead} ${range}${biggest}`;
}

/**
 * Explain one group's whole journey: its direction overall, plus the step that
 * moved it most. `stepGroups` is that group's entry from each step variance,
 * aligned with `trend.steps` and possibly containing nulls.
 */
export function explainTrendGroup(group, stepGroups, { money }) {
  const m = (v) => money(Math.abs(v));
  const months = group.costs.length;
  const active = group.costs.filter(c => Math.abs(c) >= 0.005).length;

  if (active === 0) return `${group.label} did not bill in any loaded month.`;
  if (active === 1) {
    const i = group.costs.findIndex(c => Math.abs(c) >= 0.005);
    return `${group.label} only billed in one of the ${months} months, costing ${money(group.costs[i])}.`;
  }

  const lead = Math.abs(group.delta) < 0.005
    ? `${group.label} held steady, averaging ${money(group.avg)} a month.`
    : `${group.label} went from ${money(group.first)} to ${money(group.last)}, a ${group.delta > 0 ? 'rise' : 'drop'} of ${m(group.delta)}${group.pct == null ? '' : ` (${group.pct > 0 ? '+' : ''}${group.pct}%)`}, averaging ${money(group.avg)} a month.`;

  const withCause = (stepGroups || [])
    .filter(Boolean)
    .sort((a, b) => Math.abs(b.g.delta) - Math.abs(a.g.delta))[0];

  if (!withCause || Math.abs(withCause.g.delta) < 0.005) return lead;

  const g = withCause.g;
  const bits = [];
  if (Math.abs(g.added) >= 0.005) bits.push(`${m(g.added)} from resources that did not exist before`);
  if (Math.abs(g.removed) >= 0.005) bits.push(`${m(g.removed)} saved from resources that stopped billing`);
  if (Math.abs(g.usage) >= 0.005) bits.push(`${m(g.usage)} ${g.usage > 0 ? 'from higher usage' : 'saved by lower usage'}`);
  if (Math.abs(g.rate) >= 0.005) bits.push(`${m(g.rate)} ${g.rate > 0 ? 'from higher unit rates' : 'saved by lower unit rates'}`);

  const cause = bits.length ? ` — ${bits.join(', ')}` : '';
  return `${lead} Its biggest move was ${withCause.from} → ${withCause.to}, ${g.delta > 0 ? 'up' : 'down'} ${m(g.delta)}${cause}.`;
}
