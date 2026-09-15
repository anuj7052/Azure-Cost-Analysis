/** Only returned months are eligible; gaps are never filled with invented bills. */
export function comparisonMonths(months = []) {
  return [...months].sort((a, b) => a.month.localeCompare(b.month));
}

export function resolveMonthPair(months, baseline, selected) {
  const keys = comparisonMonths(months).map(row => row.month);
  const current = keys.includes(selected) ? selected : keys.at(-1) || '';
  const prior = keys.includes(baseline) && baseline !== current
    ? baseline : keys.filter(key => key !== current).at(-1) || '';
  return { baseline: prior, selected: current };
}

export function migrateExplorerView(view = {}) {
  if (!view || typeof view !== 'object') view = {};
  const rest = { ...view };
  delete rest.dimension;
  return {
    ...rest,
    tab: view.tab === 'breakdown' ? 'compare'
      : ['trend', 'groups', 'compare', 'bandwidth'].includes(view.tab) ? view.tab : 'trend',
    timeline: view.timeline === 'monthly' ? 'monthly' : 'daily',
  };
}