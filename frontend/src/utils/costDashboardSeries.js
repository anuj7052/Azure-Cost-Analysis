/*
 * Data shaping for the Cost dashboard graphs. Every series is read from data
 * the page already loaded; nothing is estimated or interpolated.
 */

// Palette from the Stitch Cost dashboard review (project 15126684122816412549):
// brand orange first, then hues that alternate warm/cool so adjacent stacked
// segments stay distinct on both light and dark cards.
export const SERIES_COLORS = ['#EA580C', '#0284C7', '#F59E0B', '#0D9488', '#4F46E5', '#8B5CF6'];
export const OTHER_COLOR = '#94A3B8';
export const TOP_SERVICES = 6;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function monthLabel(key) {
  const [year, month] = String(key).split('-');
  const name = MONTHS[Number(month) - 1];
  return name ? `${name} ${year}` : String(key);
}

export function dayLabel(iso) {
  const [, month, day] = String(iso).split('-');
  const name = MONTHS[Number(month) - 1];
  return name ? `${Number(day)} ${name}` : String(iso);
}

export function weekday(iso) {
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? '' : WEEKDAYS[date.getUTCDay()];
}

/** Periods with a per-service split, folded to the top services plus "Other". */
export function buildSeries(periods) {
  const totals = {};
  for (const period of periods) {
    for (const [service, cost] of Object.entries(period.byService || {})) {
      totals[service] = (totals[service] || 0) + (Number(cost) || 0);
    }
  }
  const ranked = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  const top = ranked.slice(0, TOP_SERVICES).map(([service]) => service);
  const hasOther = ranked.length > TOP_SERVICES;
  const keys = hasOther ? [...top, 'Other'] : top;

  let running = 0;
  const rows = periods.map((period, index) => {
    const row = { key: period.key, label: period.label, full: period.full, total: Number(period.total) || 0 };
    let other = 0;
    for (const [service, cost] of Object.entries(period.byService || {})) {
      if (top.includes(service)) row[service] = (row[service] || 0) + (Number(cost) || 0);
      else other += Number(cost) || 0;
    }
    if (hasOther) row.Other = other;
    for (const key of keys) row[key] = Math.round((row[key] || 0) * 100) / 100;
    running += row.total;
    row.cumulative = Math.round(running * 100) / 100;
    const previous = periods[index - 1];
    row.change = previous && Number(previous.total) > 0
      ? ((row.total - Number(previous.total)) / Number(previous.total)) * 100
      : null;
    return row;
  });

  const colors = Object.fromEntries(keys.map((key, index) => [key, key === 'Other' ? OTHER_COLOR : SERIES_COLORS[index % SERIES_COLORS.length]]));
  const share = ranked.map(([service, cost]) => ({ service, cost }));
  return { rows, keys, colors, share, total: ranked.reduce((sum, [, cost]) => sum + cost, 0) };
}
