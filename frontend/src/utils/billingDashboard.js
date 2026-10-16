const pad = value => String(value).padStart(2, '0');
export function monthRange(year, month) {
  const days = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  return { from: `${year}-${pad(month)}-01`, to: `${year}-${pad(month)}-${pad(days)}` };
}

export function dashboardFilters(params, now = new Date()) {
  const defaults = monthRange(now.getFullYear(), now.getMonth() + 1);
  return { mode: params.get('mode') === 'range' ? 'range' : 'month',
    from: params.get('from') || defaults.from, to: params.get('to') || defaults.to,
    source: params.get('source') === 'invoices' ? 'invoices' : 'ledger',
    currency: params.get('currency') || '', customer: params.get('customer') || '' };
}

export function exactDays(from, to) {
  const first = Date.parse(`${from}T00:00:00Z`), last = Date.parse(`${to}T00:00:00Z`);
  return Number.isFinite(first) && Number.isFinite(last) && last >= first ? Math.round((last - first) / 86400000) + 1 : null;
}

export function dashboardPayload(filters) {
  return { from_date: filters.from, to_date: filters.to, currency: filters.currency, source: filters.source, customer_id: filters.customer };
}
