/**
 * Regroup the BOQ comparison by any dimension the user cares about.
 *
 * The category table answers "is Storage over budget". It cannot answer "which
 * resource group is bleeding" or "which service has the most spend nobody
 * budgeted for", because a category is not a place — Storage charges are spread
 * across every resource group you own.
 *
 * What is deliberately *not* done here: inventing a budget per resource group.
 * An Azure Pricing Calculator estimate has no resource group, no subscription
 * and no resource name in it, so any "RG budget" figure would be a number this
 * app made up. Instead each group is split by how much of its spend a BOQ line
 * actually accounts for. That is a real, checkable statement, and it is the one
 * worth acting on.
 */

const round = (n) => Math.round(n * 100) / 100;

const BLANK = '(none)';

/**
 * The dimensions a usage row can be grouped by.
 *
 * `budgeted` marks the one dimension where the estimate genuinely carries the
 * same field, so a budget-versus-actual variance can be shown without guessing.
 */
export const DIMENSIONS = [
  {
    key: 'category',
    label: 'Category',
    field: (r) => r.category || BLANK,
    budgeted: true,
    note: 'The comparison buckets used above — the only grouping where the estimate carries a matching figure.',
  },
  {
    key: 'resource_group',
    label: 'Resource group',
    field: (r) => r.resource_group || BLANK,
    note: 'Estimates have no resource group, so there is no budget to compare against. What is shown instead is how much of each group\u2019s spend a BOQ line accounts for.',
  },
  {
    key: 'service',
    label: 'Service',
    field: (r) => r.service || BLANK,
    note: 'Azure\u2019s own service names, not the comparison buckets. One estimate line can bill under several services, so no per-service budget is claimed.',
  },
  {
    key: 'resource_name',
    label: 'Resource',
    field: (r) => r.resource_name || BLANK,
    note: 'Individual resources. Charges Azure reports without a resource name \u2014 subscription-level fees, some marketplace items \u2014 collect under (none).',
  },
  {
    key: 'meter',
    label: 'Meter',
    field: (r) => r.meter || BLANK,
    note: 'The finest detail Cost Management exposes: the exact thing being charged for.',
  },
  {
    key: 'region',
    label: 'Region',
    field: (r) => r.region || BLANK,
    note: 'Where the money is being spent. Estimates do carry a region, but they spell it differently to the bill, so matching them would be guesswork \u2014 no budget is claimed here.',
  },
  {
    key: 'subscription_id',
    label: 'Subscription',
    field: (r) => r.subscription_id || BLANK,
    note: 'Useful when one estimate covers several subscriptions.',
  },
];

export const COVERAGE_FILTERS = [
  { key: 'all', label: 'All charges' },
  { key: 'none', label: 'Not in BOQ' },
  { key: 'line', label: 'Matched to a BOQ line' },
  { key: 'pooled', label: 'Covered by pooled budget' },
];

/** Distinct values of a field across the rows, cheapest possible filter source. */
export function optionsFor(attributions, dimensionKey) {
  const dim = DIMENSIONS.find(d => d.key === dimensionKey);
  if (!dim) return [];
  const seen = new Set();
  for (const row of attributions) seen.add(dim.field(row));
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/**
 * Apply the active filters to the row-level attributions.
 *
 * Every filter is an intersection, which is what people expect from a filter
 * bar: picking a resource group and a service means "this service, in this
 * group", not "either of these".
 */
export function filterAttributions(attributions, filters = {}) {
  const { resourceGroups, services, regions, subscriptions, coverage, search } = filters;
  const term = String(search || '').trim().toLowerCase();

  const inSet = (set, value) => !set || set.size === 0 || set.has(value || BLANK);

  return attributions.filter((row) => {
    if (!inSet(resourceGroups, row.resource_group)) return false;
    if (!inSet(services, row.service)) return false;
    if (!inSet(regions, row.region)) return false;
    if (!inSet(subscriptions, row.subscription_id)) return false;
    if (coverage && coverage !== 'all' && row.coverage !== coverage) return false;
    if (term) {
      const haystack = [
        row.resource_name, row.resource_group, row.service,
        row.meter, row.region, row.category, row.boqLine,
      ].join(' ').toLowerCase();
      if (!haystack.includes(term)) return false;
    }
    return true;
  });
}

/**
 * Roll filtered rows up into one line per group.
 *
 * `budgetByCategory` is only supplied for the category dimension. Passing it
 * anywhere else would produce a variance against a budget that was never
 * expressed in those terms.
 */
export function groupAttributions(attributions, dimensionKey, budgetByCategory = null) {
  const dim = DIMENSIONS.find(d => d.key === dimensionKey) || DIMENSIONS[0];
  const groups = new Map();
  let total = 0;

  for (const row of attributions) {
    const name = dim.field(row);
    const entry = groups.get(name) || {
      key: name,
      label: name,
      actual: 0,
      matched: 0,
      pooled: 0,
      notInBoq: 0,
      rows: [],
      resourceGroups: new Set(),
      services: new Set(),
      resources: new Set(),
    };

    const cost = row.monthlyCost || 0;
    entry.actual += cost;
    if (row.coverage === 'line') entry.matched += cost;
    else if (row.coverage === 'pooled') entry.pooled += cost;
    else entry.notInBoq += cost;

    entry.rows.push(row);
    if (row.resource_group) entry.resourceGroups.add(row.resource_group);
    if (row.service) entry.services.add(row.service);
    if (row.resource_name) entry.resources.add(row.resource_name);

    groups.set(name, entry);
    total += cost;
  }

  const rolled = [...groups.values()].map((g) => {
    const budgeted = dim.budgeted && budgetByCategory ? (budgetByCategory.get(g.label) || 0) : null;
    const actual = round(g.actual);
    return {
      key: g.key,
      label: g.label,
      actual,
      matched: round(g.matched),
      pooled: round(g.pooled),
      notInBoq: round(g.notInBoq),
      // Share of the *filtered* total, so the percentages always add to 100
      // of what is on screen rather than of some hidden larger number.
      share: total > 0 ? round((g.actual / total) * 100) : 0,
      budgeted: budgeted === null ? null : round(budgeted),
      variance: budgeted === null ? null : round(actual - budgeted),
      resourceGroupCount: g.resourceGroups.size,
      serviceCount: g.services.size,
      resourceCount: g.resources.size,
      rows: g.rows.sort((a, b) => (b.monthlyCost || 0) - (a.monthlyCost || 0)),
    };
  });

  return {
    dimension: dim,
    groups: rolled.sort((a, b) => b.actual - a.actual),
    total: round(total),
    notInBoqTotal: round(rolled.reduce((s, g) => s + g.notInBoq, 0)),
    matchedTotal: round(rolled.reduce((s, g) => s + g.matched, 0)),
    pooledTotal: round(rolled.reduce((s, g) => s + g.pooled, 0)),
    rowCount: attributions.length,
  };
}

/** Flat CSV of whatever is currently on screen, filters included. */
export function breakdownCsv(result, currency) {
  const header = [
    result.dimension.label, `Actual per month (${currency})`,
    `Matched to BOQ (${currency})`, `Pooled budget (${currency})`,
    `Not in BOQ (${currency})`, 'Share %', 'Resources', 'Services',
  ];
  const escape = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = result.groups.map(g => [
    g.label, g.actual, g.matched, g.pooled, g.notInBoq, g.share,
    g.resourceCount, g.serviceCount,
  ].map(escape).join(','));
  return [header.map(escape).join(','), ...lines].join('\n');
}
