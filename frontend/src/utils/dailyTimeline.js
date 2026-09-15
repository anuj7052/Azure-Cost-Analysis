/** Calendar arithmetic is UTC: local DST must not skip a billing date. */
export function previousDate(date) {
  const value = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(value.getTime())) return '';
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

export function previousMonth(month) {
  return previousDate(`${month}-01`).slice(0, 7);
}

/** Recharts 3 exposes an index; older versions expose activePayload. */
export function clickedPoint(state, points) {
  const index = state?.activeTooltipIndex;
  if (index !== null && index !== undefined && index !== '' && Number.isInteger(Number(index))) {
    return points[Number(index)] || null;
  }
  return state?.activePayload?.[0]?.payload || null;
}

export function dailyRequest({ selectedTenantId, selectedSubscriptionIds, months, dateMode, fromDate, toDate, imported }, filters) {
  if (imported) return { blocked: 'Imported data has no daily granularity. Daily Azure queries are disabled for imports.' };
  if (filters.location || filters.search) return { blocked: 'Daily costs cannot apply Region or Search filters. Clear those filters or use Monthly.' };
  if (!selectedTenantId || !selectedSubscriptionIds.length) return { blocked: 'Choose a tenant and subscription.' };
  if (filters.subscription && !selectedSubscriptionIds.includes(filters.subscription)) {
    return { blocked: 'The subscription filter is outside the header selection. Clear it or select that subscription in the header.' };
  }
  return { payload: {
    tenant_id: selectedTenantId,
    subscription_ids: filters.subscription ? [filters.subscription] : selectedSubscriptionIds,
    months: Math.min(6, Math.max(1, months || 1)),
    ...(dateMode === 'custom' && fromDate && toDate ? { from_date: fromDate, to_date: toDate } : {}),
    resource_group: filters.resource_group || null,
    include_reservation_context: true,
  } };
}

export function serviceSlice(days, service) {
  return [...days].sort((a, b) => a.date.localeCompare(b.date)).map(day => !service ? day : {
    ...day,
    total: day.by_service ? (day.by_service[service] ?? 0) : null,
    by_service: day.by_service ? { [service]: day.by_service[service] ?? 0 } : null,
    reservation_context: day.reservation_context?.[service] ? { [service]: day.reservation_context[service] } : {},
  });
}

/** Never substitute a missing period for a zero bill. Include disappeared services. */
export function compareServices(current, prior, totalKey = 'total') {
  const compatible = Boolean(current && prior && (!current.currency || !prior.currency || current.currency === prior.currency));
  const available = compatible && Number.isFinite(current[totalKey]) && Number.isFinite(prior[totalKey]);
  const delta = available ? current[totalKey] - prior[totalKey] : null;
  const detailed = compatible && current.by_service != null && prior.by_service != null;
  const names = new Set([...Object.keys(current?.by_service || {}), ...Object.keys(prior?.by_service || {})]);
  const rows = [...names].map(name => ({
    name,
    current: current?.by_service ? (current.by_service[name] ?? 0) : null,
    prior: prior?.by_service ? (prior.by_service[name] ?? 0) : null,
    delta: detailed ? (current.by_service[name] ?? 0) - (prior.by_service[name] ?? 0) : null,
  })).sort((a, b) => Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0) || a.name.localeCompare(b.name));
  return { delta, rows, percent: available && prior[totalKey] !== 0 ? delta / Math.abs(prior[totalKey]) * 100 : null,
    residual: available && detailed ? delta - rows.reduce((sum, row) => sum + row.delta, 0) : null };
}
