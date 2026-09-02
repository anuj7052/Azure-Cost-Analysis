/**
 * Turning the orphan scan into something you can walk through.
 *
 * The API returns findings grouped by detection rule, which is the right shape
 * for "what kinds of waste do we have" and the wrong shape for "whose budget
 * is this on". Cleaning up is an organisational act before it is a technical
 * one, so this file regroups the same findings by subscription and resource
 * group without changing a single number.
 */

export const MISSING = 'Not available';

export const CERTAIN = 'certain';
export const LIKELY = 'likely';

export const SEVERITY_LABEL = {
  [CERTAIN]: 'Definite waste',
  [LIKELY]: 'Review needed',
};

export const SEVERITY_TONE = {
  [CERTAIN]: { dot: 'bg-rose-400', chip: 'bg-rose-500/15 text-rose-300' },
  [LIKELY]: { dot: 'bg-amber-400', chip: 'bg-amber-500/15 text-amber-300' },
};

export const FALLBACK_TONE = { dot: 'bg-slate-500', chip: 'bg-slate-800 text-slate-300' };

export function severityLabel(severity) {
  return SEVERITY_LABEL[severity] || 'Unclassified';
}

export function severityTone(severity) {
  return SEVERITY_TONE[severity] || FALLBACK_TONE;
}

/**
 * How the finding was proved.
 *
 * "Inventory-based" means Azure itself reports the resource as detached — a
 * fact, not an inference. A future metrics-based rule would mean "we observed
 * no traffic", which is a weaker claim, so the two must never read alike.
 */
export const METHOD_LABEL = {
  inventory: 'Inventory-based',
  metrics: 'Metrics-based',
};

export function methodLabel(method) {
  return METHOD_LABEL[method] || MISSING;
}

export function methodHelp(method) {
  if (method === 'inventory') {
    return 'Azure reports this resource as attached to nothing. It is a property of the resource, not a guess from usage.';
  }
  if (method === 'metrics') {
    return 'Inferred from observed activity over the metrics window, so it depends on that window being representative.';
  }
  return '';
}

/** Flatten the API's rule-grouped response back into one list of findings. */
export function flatten(data) {
  return (data?.categories || []).flatMap(c =>
    (c.items || []).map(item => ({
      ...item,
      rule: item.rule || c.key,
      rule_title: item.rule_title || c.title,
      severity: item.severity || c.severity,
      reason: item.reason || c.reason,
    })),
  );
}

/** Sum monthly cost, skipping unknowns rather than treating them as zero. */
export function sumCost(items) {
  return (items || []).reduce((total, i) => total + (Number(i.monthly_cost) || 0), 0);
}

/** How many findings carry no price at all. Shown so a total is never oversold. */
export function unpricedCount(items) {
  return (items || []).filter(i => i.monthly_cost === null || i.monthly_cost === undefined).length;
}

const byCostThenName = (a, b) => (b.cost - a.cost) || a.name.localeCompare(b.name);

/**
 * Subscription → resource group → resource.
 *
 * Sorted by money at every level, because the reader's attention is finite and
 * the first thing on screen should be the thing worth their time. Names are
 * resolved from the caller's subscription list; an unrecognised id keeps the
 * raw guid rather than being labelled "Unknown", which would look like a bug.
 */
export function groupTree(items, subscriptions = []) {
  const names = new Map(
    (subscriptions || []).map(s => [
      String(s.subscription_id || s.id || '').toLowerCase(),
      s.display_name || s.name || '',
    ]),
  );

  const subs = new Map();
  for (const item of items || []) {
    const subId = item.subscription_id || '';
    if (!subs.has(subId)) {
      subs.set(subId, {
        key: subId,
        name: names.get(subId.toLowerCase()) || subId || MISSING,
        cost: 0,
        count: 0,
        groups: new Map(),
      });
    }
    const sub = subs.get(subId);
    sub.cost += Number(item.monthly_cost) || 0;
    sub.count += 1;

    const rgName = item.resource_group || MISSING;
    if (!sub.groups.has(rgName)) {
      sub.groups.set(rgName, { key: rgName, name: rgName, cost: 0, count: 0, items: [] });
    }
    const rg = sub.groups.get(rgName);
    rg.cost += Number(item.monthly_cost) || 0;
    rg.count += 1;
    rg.items.push(item);
  }

  return [...subs.values()]
    .map(sub => ({
      ...sub,
      groups: [...sub.groups.values()]
        .map(rg => ({
          ...rg,
          items: [...rg.items].sort(
            (a, b) => (Number(b.monthly_cost) || 0) - (Number(a.monthly_cost) || 0)
              || a.name.localeCompare(b.name),
          ),
        }))
        .sort(byCostThenName),
    }))
    .sort(byCostThenName);
}

/** Distinct rules present, with counts, for the type filter. */
export function ruleOptions(items) {
  const seen = new Map();
  for (const item of items || []) {
    const key = item.rule || '';
    if (!seen.has(key)) {
      seen.set(key, { key, label: item.rule_title || key || MISSING, count: 0 });
    }
    seen.get(key).count += 1;
  }
  return [...seen.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/** Distinct severities present, with counts, for the status filter. */
export function severityOptions(items) {
  const seen = new Map();
  for (const item of items || []) {
    const key = item.severity || '';
    if (!seen.has(key)) {
      seen.set(key, { key, label: severityLabel(key), count: 0 });
    }
    seen.get(key).count += 1;
  }
  return [...seen.values()].sort((a, b) => b.count - a.count);
}

/**
 * Narrow the findings.
 *
 * `hideUnpriced` hides findings with no known cost, and is off by default. A
 * resource that Cost Management did not report is not necessarily free, so
 * hiding it must be a deliberate choice rather than the default view.
 */
export function filterItems(items, { rule = '', severity = '', query = '', hideUnpriced = false } = {}) {
  const q = (query || '').trim().toLowerCase();
  return (items || []).filter(item => {
    if (rule && item.rule !== rule) return false;
    if (severity && item.severity !== severity) return false;
    if (hideUnpriced && (item.monthly_cost === null || item.monthly_cost === undefined)) return false;
    if (!q) return true;
    const haystack = [
      item.name, item.type, item.resource_group, item.location,
      item.detail, item.rule_title,
    ].join(' ').toLowerCase();
    return haystack.includes(q);
  });
}

/**
 * The savings claim for one finding.
 *
 * `monthly` is what Azure actually billed this resource over the last period,
 * not a price-list estimate. `annual` is that figure times twelve and is
 * labelled a projection, because a resource deleted next week does not save
 * a year's worth and pretending otherwise inflates every business case built
 * on this screen.
 */
export function savings(item) {
  const monthly = item?.monthly_cost;
  if (monthly === null || monthly === undefined) {
    return {
      monthly: null,
      annual: null,
      basis: 'Cost Management did not report a charge for this resource in the last period. That is not the same as it being free.',
    };
  }
  return {
    monthly,
    annual: monthly * 12,
    basis: 'Actual amount billed to this resource over the last period. The annual figure is twelve times that, not a forecast.',
  };
}

/**
 * The evidence rows for the detail panel, including what is missing.
 *
 * The absent rows are the point. A panel that silently omits "how long has it
 * been orphaned" lets the reader assume it was checked; naming it and saying
 * why it is unavailable is the difference between a gap and a lie.
 */
export function evidenceRows(item) {
  const rows = [
    { label: 'Method', value: methodLabel(item?.method), hint: methodHelp(item?.method) },
  ];

  for (const [label, value] of Object.entries(item?.evidence || {})) {
    rows.push({ label, value: String(value) });
  }

  rows.push({
    label: 'Resource age',
    value: Number.isFinite(item?.age_days) ? `${item.age_days} days` : MISSING,
    hint: Number.isFinite(item?.age_days)
      ? 'How long the resource has existed — not how long it has been orphaned.'
      : 'Azure Resource Graph does not report an age for this resource type.',
  });

  rows.push({
    label: 'Orphaned since',
    value: MISSING,
    hint: 'Azure does not record when a resource became detached, and there is no scan history here to derive it from. Any date shown would be invented.',
  });

  rows.push({
    label: 'Previously attached to',
    value: MISSING,
    hint: 'The rule matches on the absence of a link, so the previous owner is not recoverable from it.',
  });

  return rows;
}

/**
 * One sentence stating what the numbers on screen do and do not cover.
 *
 * The aggregate total is the dangerous figure: it silently reads as zero for
 * every finding Cost Management did not price, so the count of those has to
 * travel with it.
 *
 * Which month the prices come from travels with it too. They are the last
 * complete billing month, not the month in progress, and on the rare occasion
 * only a part-month is available that is said outright rather than letting a
 * few days' spend pass for a monthly rate.
 */
export function coverageNote(items, { month = '', partial = false } = {}) {
  const total = (items || []).length;
  if (!total) return '';
  const unpriced = unpricedCount(items);

  const from = !month
    ? ''
    : partial
      ? ` Prices are ${month} so far this month, not a full month.`
      : ` Prices are for ${month}, the last complete billing month.`;

  if (!unpriced) return `All ${total} findings have a billed cost attached.${from}`;
  if (unpriced === total) {
    return `None of these ${total} findings has a billed cost attached, so the totals below read as zero. The findings are still real.${from}`;
  }
  return `${unpriced} of ${total} findings have no billed cost, so the totals below understate the true figure.${from}`;
}

/** The headline, or an honest blank. */
export function headline(items) {
  const total = (items || []).length;
  if (!total) return 'Nothing matched.';
  const certain = (items || []).filter(i => i.severity === CERTAIN).length;
  if (!certain) return `${total} findings, all needing review before removal.`;
  return `${total} findings — ${certain} attached to nothing at all.`;
}
