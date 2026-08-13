// Derives the same payload shapes the live API returns (cost summary +
// bandwidth report) from imported file rows, so every page, chart and filter
// behaves identically whether the data came from Azure or from an upload.

import { diskSpec, friendlyType } from './azureSku';

const GB = 1024 ** 3;
const TB = 1024 ** 4;

const BANDWIDTH_CATEGORIES = [
  'bandwidth', 'content delivery network', 'azure front door service',
  'vpn gateway', 'expressroute', 'traffic manager', 'nat gateway',
];

const TRANSFER_KEYWORDS = [
  'data transfer', 'data processed', 'data out', 'data in', 'egress',
  'ingress', 'bandwidth', 'routing rules', 'geo-replication data transfer',
];

const UNIT_TO_BYTES = [
  ['pb', 1024 ** 5], ['tib', TB], ['tb', TB], ['gib', GB], ['gb', GB],
  ['mb', 1024 ** 2], ['kb', 1024], ['byte', 1], ['b', 1],
];

const lower = (v) => (v || '').toString().trim().toLowerCase();

export function isBandwidthRow(row) {
  if (BANDWIDTH_CATEGORIES.includes(lower(row.meter_category))) return true;
  const hay = `${lower(row.meter)} ${lower(row.meter_subcategory)} ${lower(row.service)}`;
  return TRANSFER_KEYWORDS.some(k => hay.includes(k));
}

/** Resolve how many bytes one unit of `quantity` represents. */
export function unitBytes(row) {
  const unit = lower(row.unit_of_measure);
  // Azure writes units like "10 GB" or "100 GB/Month" — the leading number is a multiplier.
  const multiplier = parseFloat(unit) || 1;
  for (const [token, factor] of UNIT_TO_BYTES) {
    if (unit.includes(token)) return multiplier * factor;
  }
  const meter = lower(row.meter);
  for (const [token, factor] of UNIT_TO_BYTES) {
    if (meter.endsWith(token) || meter.includes(` ${token}`)) return factor;
  }
  return GB; // Azure network meters are billed in GB by default
}

export function classifyDirection(row) {
  const text = `${lower(row.meter)} ${lower(row.meter_subcategory)} ${lower(row.meter_category)}`;
  if (/intra[- ]region|availability zone|zone 1|same region/.test(text)) return 'intra';
  if (/\bout\b|egress|outbound|download|from /.test(text)) return 'egress';
  if (/\bin\b|ingress|inbound|upload|to /.test(text)) return 'ingress';
  return 'other';
}

const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

/** Rows for the selected subscriptions only — the single filter entry point. */
export function filterRows(rows, subscriptionIds) {
  if (!subscriptionIds?.length) return [];
  const wanted = new Set(subscriptionIds);
  return rows.filter(r => wanted.has(r.subscription_id));
}

/**
 * Bring an import saved before multi-file support up to the current shape.
 *
 * Such an import has no `files` list and its rows carry no `file` tag, so
 * merging a second month into it would keep the old rows while silently losing
 * the old file's entry — leaving a set whose row data and file list disagree.
 */
function adoptLegacy(existing) {
  if (!existing) return null;
  if (existing.files?.length) return existing;
  const name = existing.file_name || 'Previous import';
  return {
    ...existing,
    files: [{
      file_name: name,
      source_type: existing.source_type,
      rows_read: existing.rows_read || 0,
      rows_used: existing.rows_used || 0,
      months: existing.months || [],
      dated: existing.dated,
    }],
    rows: (existing.rows || []).map(r => (r.file ? r : { ...r, file: name })),
  };
}

/**
 * Fold a freshly parsed file into the set already imported.
 *
 * Month-over-month questions ("why did this go up?") need more than one billing
 * period loaded at once, and Azure exports one month per file. Re-uploading the
 * same file name replaces its rows rather than doubling them.
 *
 * Two files covering the same month for the same subscription would double-count
 * silently, so that overlap is detected and reported instead of hidden.
 */
export function mergeImports(existingRaw, incoming) {
  const existing = adoptLegacy(existingRaw);
  const name = incoming.file_name;
  const stamped = (incoming.rows || []).map(r => ({ ...r, file: name }));

  const files = [
    ...(existing?.files || []).filter(f => f.file_name !== name),
    {
      file_name: name,
      source_type: incoming.source_type,
      rows_read: incoming.rows_read,
      rows_used: incoming.rows_used,
      months: incoming.months || [],
      dated: incoming.dated,
    },
  ].sort((a, b) => (a.months[0] || '').localeCompare(b.months[0] || ''));

  const rows = [
    ...(existing?.rows || []).filter(r => r.file !== name),
    ...stamped,
  ];

  // Flag any month+subscription pair contributed by more than one file.
  const owners = new Map();
  for (const r of rows) {
    const key = `${r.month}::${r.subscription_id}`;
    let set = owners.get(key);
    if (!set) owners.set(key, (set = new Set()));
    set.add(r.file || name);
  }
  const overlaps = [...owners.entries()]
    .filter(([, set]) => set.size > 1)
    .map(([key, set]) => ({ month: key.split('::')[0], files: [...set] }));

  const subTotals = new Map();
  const subNames = new Map();
  for (const r of rows) {
    subTotals.set(r.subscription_id, (subTotals.get(r.subscription_id) || 0) + r.cost);
  }
  for (const s of [...(existing?.subscriptions || []), ...(incoming.subscriptions || [])]) {
    if (s.display_name) subNames.set(s.subscription_id, s.display_name);
  }

  return {
    source: 'upload',
    // The label the rest of the app shows for the active data source.
    file_name: files.length === 1 ? name : `${files.length} files`,
    files,
    source_type: incoming.source_type,
    rows_read: files.reduce((s, f) => s + (f.rows_read || 0), 0),
    rows_used: files.reduce((s, f) => s + (f.rows_used || 0), 0),
    columns: incoming.columns,
    dated: files.every(f => f.dated !== false),
    // An explicit correction the user made earlier must survive a new upload.
    currency: existing?.currency || incoming.currency,
    months: [...new Set(rows.map(r => r.month))].sort(),
    overlaps,
    subscriptions: [...subTotals.entries()]
      .map(([subscription_id, total]) => ({
        subscription_id,
        display_name: subNames.get(subscription_id) || subscription_id,
        state: 'Imported',
        total_cost: round(total),
      }))
      .sort((a, b) => b.total_cost - a.total_cost),
    rows,
  };
}

/** Builds the `/api/costs` response shape. */
export function buildCostSummary(rows, currency = 'USD') {
  const byMonth = new Map();

  for (const r of rows) {
    let m = byMonth.get(r.month);
    if (!m) {
      m = { month: r.month, total_cost: 0, by_service: {}, by_subscription: {}, by_resource_group: {}, currency };
      byMonth.set(r.month, m);
    }
    m.total_cost += r.cost;
    m.by_service[r.service] = (m.by_service[r.service] || 0) + r.cost;
    m.by_subscription[r.subscription_id] = (m.by_subscription[r.subscription_id] || 0) + r.cost;
    m.by_resource_group[r.resource_group] = (m.by_resource_group[r.resource_group] || 0) + r.cost;
  }

  const months = [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
  months.forEach(m => {
    m.total_cost = round(m.total_cost);
    for (const key of ['by_service', 'by_subscription', 'by_resource_group']) {
      Object.keys(m[key]).forEach(k => { m[key][k] = round(m[key][k]); });
    }
  });

  const latest = months.at(-1);
  const prev = months.at(-2);

  // Services ranked by total spend, with month-over-month movement.
  const totals = {};
  months.forEach(m => Object.entries(m.by_service).forEach(([svc, c]) => {
    totals[svc] = (totals[svc] || 0) + c;
  }));

  const top_services = Object.entries(totals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([service, total]) => {
      const current = latest?.by_service?.[service] || 0;
      const previous = prev?.by_service?.[service] || 0;
      return {
        service,
        total_cost: round(total),
        latest_month_cost: round(current),
        mom_change_pct: previous > 0 ? round((current - previous) / previous * 100, 1) : null,
      };
    });

  // Anomalies: a service jumping more than 20% versus the previous month.
  const anomalies = [];
  const savings = [];
  for (let i = 1; i < months.length; i++) {
    const curr = months[i];
    const before = months[i - 1];
    for (const [service, cost] of Object.entries(curr.by_service)) {
      const past = before.by_service[service] || 0;
      if (past <= 0) continue;
      const pct = (cost - past) / past * 100;
      if (pct > 20) {
        anomalies.push({
          service, month: curr.month,
          previous_cost: past, current_cost: cost,
          pct_change: round(pct, 1),
          subscription_id: null,
        });
      } else if (pct < -20) {
        savings.push({ service, month: curr.month, saved_amount: round(past - cost) });
      }
    }
  }
  anomalies.sort((a, b) => b.pct_change - a.pct_change);

  const total = months.reduce((s, m) => s + m.total_cost, 0);
  const mom_change_pct = prev?.total_cost > 0
    ? round((latest.total_cost - prev.total_cost) / prev.total_cost * 100, 1)
    : null;

  return {
    months,
    total_6m: round(total),
    mom_change_pct,
    top_services,
    anomalies,
    savings,
    currency,
    errors: [],
  };
}

/** Builds the `/api/bandwidth` response shape. */
export function buildBandwidthSummary(rows, currency = 'USD') {
  const directions = {
    egress: { bytes: 0, cost: 0 }, ingress: { bytes: 0, cost: 0 },
    intra: { bytes: 0, cost: 0 }, other: { bytes: 0, cost: 0 },
  };
  const meters = new Map();
  const months = new Map();
  const subs = new Map();

  for (const r of rows) {
    if (!isBandwidthRow(r)) continue;

    const bytes = (r.quantity || 0) * unitBytes(r);
    const direction = classifyDirection(r);
    const cost = r.cost || 0;

    directions[direction].bytes += bytes;
    directions[direction].cost += cost;

    const meterName = r.meter || r.meter_subcategory || r.service || 'Unknown meter';
    let meter = meters.get(meterName);
    if (!meter) {
      meter = { meter: meterName, category: r.meter_category || 'Bandwidth', direction, bytes: 0, cost: 0, quantity: 0 };
      meters.set(meterName, meter);
    }
    meter.bytes += bytes;
    meter.cost += cost;
    meter.quantity += r.quantity || 0;

    let month = months.get(r.month);
    if (!month) {
      month = { month: r.month, egress_bytes: 0, ingress_bytes: 0, intra_bytes: 0, other_bytes: 0, total_bytes: 0, cost: 0 };
      months.set(r.month, month);
    }
    month[`${direction}_bytes`] += bytes;
    month.total_bytes += bytes;
    month.cost += cost;

    let sub = subs.get(r.subscription_id);
    if (!sub) {
      sub = {
        subscription_id: r.subscription_id, bytes: 0, cost: 0,
        egress_bytes: 0, egress_cost: 0, ingress_bytes: 0, ingress_cost: 0,
        intra_bytes: 0, intra_cost: 0, other_bytes: 0, other_cost: 0,
        _meters: new Map(),
      };
      subs.set(r.subscription_id, sub);
    }
    sub.bytes += bytes;
    sub.cost += cost;
    sub[`${direction}_bytes`] += bytes;
    sub[`${direction}_cost`] += cost;
    sub._meters.set(meterName, (sub._meters.get(meterName) || 0) + cost);
  }

  const totalBytes = Object.values(directions).reduce((s, d) => s + d.bytes, 0);
  const totalCost = Object.values(directions).reduce((s, d) => s + d.cost, 0);

  const monthList = [...months.values()].sort((a, b) => a.month.localeCompare(b.month));
  const prev = monthList.at(-2)?.total_bytes;
  const curr = monthList.at(-1)?.total_bytes;

  return {
    currency,
    total_bytes: Math.round(totalBytes),
    total_cost: round(totalCost),
    cost_per_gb: totalBytes ? round(totalCost / (totalBytes / GB), 4) : 0,
    mom_change_pct: prev > 0 ? round((curr - prev) / prev * 100) : null,
    egress_bytes: Math.round(directions.egress.bytes),
    egress_cost: round(directions.egress.cost),
    ingress_bytes: Math.round(directions.ingress.bytes),
    ingress_cost: round(directions.ingress.cost),
    intra_bytes: Math.round(directions.intra.bytes),
    intra_cost: round(directions.intra.cost),
    other_bytes: Math.round(directions.other.bytes),
    other_cost: round(directions.other.cost),
    months: monthList.map(m => ({
      ...m,
      egress_bytes: Math.round(m.egress_bytes),
      ingress_bytes: Math.round(m.ingress_bytes),
      intra_bytes: Math.round(m.intra_bytes),
      other_bytes: Math.round(m.other_bytes),
      total_bytes: Math.round(m.total_bytes),
      cost: round(m.cost),
    })),
    meters: [...meters.values()]
      .map(m => ({ ...m, bytes: Math.round(m.bytes), cost: round(m.cost) }))
      .sort((a, b) => b.cost - a.cost),
    by_subscription: [...subs.values()]
      .map(({ _meters, ...s }) => ({
        ...s,
        bytes: Math.round(s.bytes),
        cost: round(s.cost),
        egress_bytes: Math.round(s.egress_bytes),
        egress_cost: round(s.egress_cost),
        ingress_bytes: Math.round(s.ingress_bytes),
        ingress_cost: round(s.ingress_cost),
        intra_bytes: Math.round(s.intra_bytes),
        intra_cost: round(s.intra_cost),
        other_bytes: Math.round(s.other_bytes),
        other_cost: round(s.other_cost),
        cost_per_gb: s.bytes ? round(s.cost / (s.bytes / GB), 4) : 0,
        meter_count: _meters.size,
        top_meter: [..._meters.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null,
      }))
      .sort((a, b) => b.cost - a.cost || b.bytes - a.bytes),
    errors: [],
  };
}

/** Builds the `/api/costs/rg` response shape. */
/**
 * Build the "active resources" list from an imported file.
 *
 * When the export carries a resource URI, each real ARM resource is listed with
 * its own name, type and size. Older exports without one fall back to the
 * service / resource-group pair so the Services page still works.
 */
export function buildServiceList(rows) {
  const seen = new Map();
  for (const r of rows) {
    const named = Boolean(r.resource_name);
    const key = named
      ? `${r.subscription_id}::${r.resource_group}::${r.resource_name}`
      : `${r.subscription_id}::${r.resource_group}::${r.service}`;
    let s = seen.get(key);
    if (!s) {
      s = {
        name: named ? r.resource_name : r.service,
        type: named ? (friendlyType(r.resource_type) || r.service) : (r.meter_category || r.service),
        resource_type: r.resource_type || '',
        service: r.service,
        resource_group: r.resource_group,
        subscription_id: r.subscription_id,
        location: r.region || '',
        meters: new Map(),
        tags: {},
        cost: 0,
      };
      seen.set(key, s);
    }
    s.cost += r.cost;
    if (r.meter) s.meters.set(r.meter, (s.meters.get(r.meter) || 0) + r.cost);
    if (!s.location && r.region) s.location = r.region;
  }
  return [...seen.values()]
    .map((s) => {
      // The priciest meter is the one that identifies the resource — a disk's
      // capacity charge outweighs its transaction charges.
      const meters = [...s.meters].sort((a, b) => b[1] - a[1]);
      const spec = diskSpec(meters[0]?.[0]);
      return {
        ...s,
        cost: round(s.cost),
        sku: spec?.sku || '',
        size: spec?.size || '',
        tier: spec?.family || '',
        meters: meters.map(([name, cost]) => ({ name, cost: round(cost) })),
      };
    })
    .sort((a, b) => b.cost - a.cost);
}

export function buildRgSummary(rows, currency = 'USD') {
  const groups = new Map();
  let total = 0;

  for (const r of rows) {
    total += r.cost;
    const key = `${r.subscription_id}::${r.resource_group}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        rg_name: r.resource_group || 'Ungrouped',
        subscription_id: r.subscription_id,
        currency,
        total: 0,
        by_month: {},
        by_service: {},
      };
      groups.set(key, g);
    }
    g.total += r.cost;
    g.by_month[r.month] = (g.by_month[r.month] || 0) + r.cost;
    g.by_service[r.service] = (g.by_service[r.service] || 0) + r.cost;
  }

  const resource_groups = [...groups.values()]
    .map(g => ({
      ...g,
      total: round(g.total),
      by_month: Object.fromEntries(Object.entries(g.by_month).map(([k, v]) => [k, round(v)])),
      by_service: Object.fromEntries(Object.entries(g.by_service).map(([k, v]) => [k, round(v)])),
    }))
    .sort((a, b) => b.total - a.total);

  return { resource_groups, total: round(total), currency, errors: [] };
}
