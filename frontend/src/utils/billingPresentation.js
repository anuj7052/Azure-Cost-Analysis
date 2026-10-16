export function billingMoney(value, currency = 'INR') {
  if (value == null || value === '') return 'Not entered';
  const amount = Number(value);
  if (!Number.isFinite(amount)) return 'Not available';
  try { return new Intl.NumberFormat('en-IN', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount); }
  catch { return `${currency} ${amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`; }
}

export function billingMonth(period) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period || '')) return period || 'Month not entered';
  return new Date(`${period}-01T00:00:00Z`).toLocaleDateString('en', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function documentStatus(status) {
  return { needs_review: 'Check amounts', confirmed: 'Reviewed', void: 'Excluded' }[status] || status;
}

export function attentionCount(row) {
  return (row.review_count || 0) + (row.unallocated_count || 0);
}

export function customerRows(rows, search, attentionOnly) {
  const query = search.trim().toLowerCase();
  return rows.filter(row => row.name.toLowerCase().includes(query) && (!attentionOnly || attentionCount(row) > 0));
}

export function usefulBillingMonth(months, selected, reviewOnly = false) {
  if (months.some(row => row.period === selected)) return selected;
  const sorted = [...months].sort((a, b) => a.period.localeCompare(b.period));
  return (reviewOnly && sorted.find(row => row.review_count > 0)?.period)
    || sorted.filter(row => row.customer_amount !== null || row.distributor_amount !== null || row.review_count > 0).at(-1)?.period
    || sorted.at(-1)?.period || '';
}
