import { rowMatches } from './trendFilter';
import { dayLabel, monthLabel } from './costDashboardSeries';

/** Group-by options for Cost Explorer. `daily` marks what daily Azure data can split by. */
export const GROUP_BY_OPTIONS = [
  { value: 'none', label: 'No grouping (total)', daily: true },
  { value: 'service', label: 'Service', daily: true },
  { value: 'subscription', label: 'Subscription', daily: true },
  { value: 'resource_group', label: 'Resource group', daily: true },
  { value: 'meter', label: 'Meter', daily: true },
  { value: 'pricing_model', label: 'Payment type (RI / PAYG)', daily: true },
];

export function groupByLabel(value) {
  return GROUP_BY_OPTIONS.find(option => option.value === value)?.label || 'Service';
}

/** Every option works day by day; unknown values fall back to service. */
export function effectiveGroupBy(groupBy) {
  return GROUP_BY_OPTIONS.some(o => o.value === groupBy) ? groupBy : 'service';
}

/** Splits the plain daily response cannot give and must be fetched separately. */
export const DAILY_SPLIT = new Set(['subscription', 'resource_group', 'meter', 'pricing_model']);

/** Daily periods from the /costs/daily-split response. */
export function splitDayPeriods(days = []) {
  return days.map(day => ({ key: day.date, label: dayLabel(day.date), full: dayLabel(day.date), total: day.total, byService: day.split || {} }));
}

/** Monthly periods split by payment type, from the pricing-model summary. */
export function pricingMonthPeriods(months = []) {
  return months.map(m => ({
    key: m.month, label: monthLabel(m.month), full: monthLabel(m.month), total: Number(m.total) || 0,
    byService: Object.fromEntries([['Reserved (RI)', m.reserved], ['Pay-as-you-go', m.on_demand], ['Savings plan', m.savings_plan], ['Spot', m.spot]].filter(([, v]) => Number(v))),
  }));
}

/** True when the monthly split has to be built from meter rows rather than Azure's monthly summary. */
export function groupNeedsRows(groupBy, months = []) {
  if (groupBy === 'pricing_model') return false;
  if (groupBy === 'resource_group' || groupBy === 'meter') return true;
  if (groupBy === 'subscription') return months.some(month => month.by_subscription == null || !Object.keys(month.by_subscription).length);
  return false;
}

/**
 * Monthly periods split by the chosen dimension, in the shape buildSeries reads.
 *
 * Service and subscription come straight from the (possibly filtered) monthly
 * summary so totals still match Azure. Resource group and meter only exist in
 * meter rows; those periods are re-summed from rows that pass the filters.
 */
export function groupedMonthPeriods({ groupBy, months = [], rows = [], filters = {}, names = {} }) {
  const label = key => (groupBy === 'subscription' ? names[key] || names[String(key).toLowerCase()] || 'Unnamed subscription' : key || 'Unassigned');
  if (groupBy === 'none' || !groupNeedsRows(groupBy, months)) {
    const field = groupBy === 'subscription' ? 'by_subscription' : groupBy === 'none' ? '' : 'by_service';
    return months.map(month => ({
      key: month.month,
      label: monthLabel(month.month),
      full: monthLabel(month.month),
      total: Number(month.total_cost) || 0,
      byService: Object.fromEntries(Object.entries((field && month[field]) || {}).map(([key, cost]) => [label(key), cost])),
    }));
  }
  const field = groupBy === 'subscription' ? 'subscription_id' : groupBy;
  const buckets = new Map(months.map(month => [month.month, { total: 0, split: {} }]));
  for (const row of rows) {
    const bucket = buckets.get(row?.month);
    if (!bucket || !rowMatches(row, filters)) continue;
    const cost = Number(row.cost) || 0;
    const name = label(row[field]);
    bucket.total += cost;
    bucket.split[name] = (bucket.split[name] || 0) + cost;
  }
  return months.map(month => {
    const bucket = buckets.get(month.month);
    return { key: month.month, label: monthLabel(month.month), full: monthLabel(month.month), total: bucket.total, byService: bucket.split };
  });
}

/** Daily periods split by service (or unsplit for "none"). */
export function groupedDayPeriods(days = [], groupBy = 'service') {
  return days
    .filter(day => Number.isFinite(day.total))
    .map(day => ({
      key: day.date,
      label: dayLabel(day.date),
      full: dayLabel(day.date),
      total: day.total,
      byService: groupBy === 'none' ? {} : day.by_service || {},
    }));
}
