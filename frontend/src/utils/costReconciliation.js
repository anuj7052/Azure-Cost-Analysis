/** Preserve returned meter charges; disclose the difference from Azure's summary
 * as its own row instead of scaling prices or inventing resource attribution. */
export function reconcileCostRows(rows = [], months = [], currency = 'USD') {
  const allowed = new Set(months.map(month => month.month));
  const scoped = rows.filter(row => allowed.has(row.month));
  const adjustments = [];
  for (const month of months) {
    const detail = scoped.filter(row => row.month === month.month).reduce((sum, row) => sum + (Number(row.cost) || 0), 0);
    const difference = month.total_cost - detail;
    if (Number.isFinite(difference) && Math.abs(difference) >= 0.005) {
      adjustments.push({ month: month.month, cost: difference, currency,
        service: 'Unallocated billing difference', meter: 'Summary / detail reconciliation',
        resource_name: '', subscription_id: '', quantity: 0, reconciliation: true });
    }
  }
  return { rows: [...scoped, ...adjustments], adjustments,
    detailTotal: scoped.reduce((sum, row) => sum + (Number(row.cost) || 0), 0),
    total: months.reduce((sum, month) => sum + month.total_cost, 0) };
}
