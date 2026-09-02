/**
 * Compare an Azure Pricing Calculator estimate (BOQ) against real usage.
 *
 * The two sides never use the same vocabulary: an estimate says "Managed Disks"
 * where a bill says "Storage", and "Azure Backup" where a bill says "Backup".
 * Everything is therefore folded into a small set of comparison buckets so the
 * numbers line up instead of every line looking like an unbudgeted surprise.
 */

import { isBandwidthRow, unitBytes, classifyDirection } from './importAnalytics';
import { diskSpec } from './azureSku';

const round = (n) => Math.round(n * 100) / 100;

/**
 * Percentages blow up when a budget line is a rounding error (a ₹7 bandwidth
 * estimate against ₹20K of real traffic reads as 273,661%). Cap the display so
 * the number stays legible; the absolute difference tells the real story.
 */
function variancePct(variance, budgeted) {
  if (!budgeted) return null;
  const pct = round((variance / budgeted) * 100);
  return Math.abs(pct) > 999 ? (pct > 0 ? 999 : -999) : pct;
}

/** Canonical buckets, with the estimate and billing names that map into them. */
const BUCKETS = [
  { key: 'compute',   label: 'Virtual Machines & Compute', match: ['virtual machine', 'compute', 'vm', 'app service', 'functions', 'container', 'kubernetes', 'batch'] },
  { key: 'storage',   label: 'Storage & Managed Disks',    match: ['managed disk', 'storage', 'disk', 'blob', 'file', 'data lake'] },
  { key: 'backup',    label: 'Backup & Site Recovery',     match: ['backup', 'site recovery', 'recovery service', 'azure backup'] },
  { key: 'network',   label: 'Networking',                 match: ['ip address', 'virtual network', 'network', 'load balancer', 'firewall', 'vpn', 'application gateway', 'dns', 'front door', 'expressroute'] },
  { key: 'bandwidth', label: 'Bandwidth & Data Transfer',  match: ['bandwidth', 'data transfer'] },
  { key: 'database',  label: 'Databases',                  match: ['sql', 'database', 'cosmos', 'mysql', 'postgres', 'redis'] },
  { key: 'analytics', label: 'Analytics & AI',             match: ['fabric', 'synapse', 'databricks', 'machine learning', 'cognitive', 'openai', 'analytics', 'stream'] },
  { key: 'security',  label: 'Security & Identity',        match: ['defender', 'sentinel', 'key vault', 'security', 'entra', 'active directory'] },
  { key: 'management',label: 'Management & Monitoring',    match: ['monitor', 'log analytics', 'automation', 'advisor', 'management'] },
  { key: 'licensing', label: 'Licences & Support',         match: ['licen', 'support', 'managed service'] },
];

const OTHER = { key: 'other', label: 'Other services' };
const BANDWIDTH_BUCKET = BUCKETS.find(b => b.key === 'bandwidth');
const BACKUP_BUCKET = BUCKETS.find(b => b.key === 'backup');

/**
 * Azure Backup snapshots and Site Recovery cache are billed under the
 * "Storage" service even though the money is spent on protection, which makes
 * Storage look overspent and Backup look cheap. They are identifiable by the
 * resources Azure creates for them, so route them to the Backup bucket.
 *
 * Deliberately narrow: an `-asrreplica` disk is a real managed disk that an
 * estimate budgets for under storage, so it must stay where it is.
 */
function isBackupRow(row) {
  const name = String(row.resource_name || '').toLowerCase();
  const group = String(row.resource_group || '').toLowerCase();
  return name.startsWith('azurebackup')
    || name.includes('asrcache')
    || group.startsWith('azurebackuprg');
}

/**
 * Pull the identifying hardware SKUs out of a piece of text.
 *
 * This is what makes a per-resource comparison possible: an estimate line reads
 * "Managed Disks, Premium SSD, LRS Redundancy, P20 Disk Type 1 Disks" and the
 * matching bill line reads "P20 LRS Disk". Neither shares a resource name, but
 * both name the SKU, so the SKU is the join key.
 */
const DISK_SKU = /\b([PSE])(\d{1,3})\b/gi;                          // P20, S40, E10
const VM_SIZE = /\b([a-z]{1,2}\d{1,3}[a-z]*(?:-\d{1,3}[a-z]*)?\s+v\d)\b/gi;  // E16s v5, E32-16s v5
const TIER_WORDS = ['premium ssd', 'standard hdd', 'standard ssd', 'ultra disk', 'premium', 'standard'];
const REDUNDANCY = /\b(lrs|zrs|grs|ragrs|gzrs)\b/gi;

export function skuKeys(text) {
  const source = String(text || '');
  const cached = SKU_CACHE.get(source);
  if (cached) return cached;
  const keys = new Set();
  for (const m of source.matchAll(VM_SIZE)) keys.add(`vm:${m[1].toLowerCase().replace(/\s+/g, ' ')}`);
  for (const m of source.matchAll(DISK_SKU)) keys.add(`disk:${m[1].toLowerCase()}${m[2]}`);
  for (const m of source.matchAll(REDUNDANCY)) keys.add(`red:${m[1].toLowerCase()}`);
  const lower = source.toLowerCase();
  for (const tier of TIER_WORDS) {
    if (lower.includes(tier)) { keys.add(`tier:${tier}`); break; }
  }
  // Four regex passes over every one of tens of thousands of usage rows was
  // the single largest cost in building this report, and almost all of it was
  // repeated work: the same meter description recurs on every resource on every
  // day of the period. The result is immutable and read-only downstream, so it
  // is safe to hand the same Set back each time.
  if (SKU_CACHE.size >= SKU_CACHE_LIMIT) SKU_CACHE.clear();
  SKU_CACHE.set(source, keys);
  return keys;
}

const SKU_CACHE = new Map();
// Bounded so a long session over many tenants cannot grow it without limit.
// Cleared wholesale rather than evicted one by one: the set is rebuilt from a
// single pass over the rows, so a cold cache costs one report, not many.
const SKU_CACHE_LIMIT = 20000;

/** Weighted overlap — a matching disk/VM SKU is worth far more than a shared tier. */
function matchScore(budgetKeys, usageKeys) {
  let score = 0;
  for (const key of usageKeys) {
    if (!budgetKeys.has(key)) continue;
    if (key.startsWith('disk:') || key.startsWith('vm:')) score += 100;
    else if (key.startsWith('red:')) score += 5;
    else score += 2;
  }
  return score;
}

/** The SKU to show as the badge for a line, e.g. "P40" or "E16s v5". */
function skuLabel(keys) {
  for (const key of keys) {
    if (key.startsWith('disk:')) return key.slice(5).toUpperCase();
    if (key.startsWith('vm:')) return key.slice(3).replace(/\b\w/g, c => c.toUpperCase());
  }
  return null;
}

/** How many units the estimate paid for — "P40 Disk Type 1 Disks" means one. */
function budgetQty(description) {
  // The lookbehind keeps the SKU's own number out of it: in "S40 Disk Type 1
  // Disks" the quantity is 1, not 40 (and not 0 by matching mid-number).
  const m = String(description || '').match(
    /(?<![A-Za-z0-9])(\d+)\s+(?:x\s*)?(?:disks?|instance\(s\)|instances?|vms?)\b/i,
  );
  return m ? Number(m[1]) : null;
}

const usageLabel = (row) =>
  [row.meter, row.meter_subcategory].filter(Boolean).join(' · ') || row.service;

/** Shared empty result, so the common "nothing could claim this row" path
 *  allocates nothing at all. */
const EMPTY_LINES = [];

/** Everything needed to identify a charge without opening the Azure portal. */
function meterIdentity(row) {
  const spec = diskSpec(row.meter);
  return {
    label: usageLabel(row),
    resource_group: row.resource_group || '',
    resource_name: row.resource_name || '',
    sku: spec?.sku || '',
    size: spec?.size || '',
    tier: spec?.family || '',
  };
}

/** Group meters by the resource they belong to, so one disk is one entry. */
const meterKey = (row) => `${row.resource_name || ''}::${usageLabel(row)}::${row.resource_group || ''}`;

/**
 * Record the individual monthly charge behind a rolled-up meter total, so a
 * figure like "Backup ₹10.48K" can always be opened up and read as the bills it
 * was averaged from. Costs here are the real amount billed in that month, not
 * the per-month average, otherwise the detail would not tie back to the invoice.
 */
function addPart(entry, row) {
  const month = row.month || '';
  const cost = Number(row.cost) || 0;
  const quantity = Number(row.quantity) || 0;
  const found = entry.parts.find(p => p.month === month);
  if (found) {
    found.cost += cost;
    found.quantity += quantity;
  } else {
    entry.parts.push({ month, cost, quantity, unit: row.unit_of_measure || '' });
  }
}

/** Monthly charges oldest first, rounded for display. */
const shapeParts = (parts = []) =>
  parts
    .map(p => ({ ...p, cost: round(p.cost), quantity: round(p.quantity) }))
    .sort((a, b) => String(a.month).localeCompare(String(b.month)));

/** Bytes moved by a row, when the meter is measured in data volume. */
const rowBytes = (row) =>
  isBandwidthRow(row) ? (Number(row.quantity) || 0) * unitBytes(row) : 0;

/**
 * Egress/ingress split for a category, so bandwidth can be read as data moved
 * and not just money spent.
 */
function trafficSummary(rows, span) {
  const buckets = new Map();
  let bytes = 0;
  let cost = 0;
  for (const row of rows) {
    if (!isBandwidthRow(row)) continue;
    const dir = classifyDirection(row);
    const entry = buckets.get(dir) || { direction: dir, bytes: 0, cost: 0, meters: [] };
    const b = rowBytes(row) / span;
    const c = row.cost / span;
    entry.bytes += b;
    entry.cost += c;
    const label = usageLabel(row);
    const seen = entry.meters.find(m => m.label === label);
    if (seen) { seen.bytes += b; seen.cost += c; }
    else entry.meters.push({ label, bytes: b, cost: c });
    buckets.set(dir, entry);
    bytes += b;
    cost += c;
  }
  if (!buckets.size) return null;
  const order = { egress: 0, ingress: 1, intra: 2, other: 3 };
  return {
    totalBytes: bytes,
    totalCost: round(cost),
    directions: [...buckets.values()]
      .map(d => ({
        ...d,
        cost: round(d.cost),
        meters: d.meters
          .map(m => ({ ...m, cost: round(m.cost) }))
          .sort((a, b) => b.cost - a.cost),
      }))
      .sort((a, b) => (order[a.direction] ?? 9) - (order[b.direction] ?? 9)),
  };
}

/**
 * Split a line's overrun into the two things that can cause it: more resources
 * running than were paid for (quantity), and each one costing a different
 * amount than estimated (rate). The two always add back up to the variance, so
 * the explanation can never disagree with the headline number.
 */
function costDrivers(line, billedCount) {
  if (!billedCount || !line.monthly_cost) return null;
  const qty = line.budgetQty || 1;
  const unitBudget = line.monthly_cost / qty;
  const unitActual = line.actual / billedCount;
  const extraUnits = billedCount - qty;
  const quantityEffect = extraUnits * unitBudget;
  return {
    qty,
    billedCount,
    extraUnits,
    unitBudget: round(unitBudget),
    unitActual: round(unitActual),
    quantityEffect: round(quantityEffect),
    rateEffect: round(line.actual - line.monthly_cost - quantityEffect),
  };
}

/**
 * Attribute each actual meter to the estimate line that budgeted for it, so
 * every BOQ row can be shown with what it really cost.
 */
function compareLines(budgetLines, usageRows, span) {
  const lines = budgetLines.map((line, i) => {
    const keys = skuKeys(`${line.custom_name} ${line.description} ${line.service_type}`);
    return {
      ...line,
      id: `${line.boq}:${i}`,
      keys,
      // Only lines naming a disk or VM SKU can be tied to a specific meter.
      // Backup policies, site recovery and support have nothing to join on.
      hasSku: [...keys].some(k => k.startsWith('disk:') || k.startsWith('vm:')),
      sku: skuLabel(keys),
      budgetQty: budgetQty(line.description),
      actual: 0,
      matches: [],
    };
  });

  const matchable = lines.filter(l => l.hasSku);
  const unmatched = new Map();

  // A row can only be claimed at a score of 100 or more, and only a shared
  // `disk:` or `vm:` key is worth that much. So a line that shares no strong key
  // with the row can never win, and scoring it is wasted work -- which it was,
  // once per row per line, on estates with tens of thousands of rows. Indexing
  // the lines by their strong keys turns that scan into a lookup of the handful
  // of lines that could actually claim the row. The winner is unchanged: the
  // candidates are scored in their original order, so ties break the same way.
  const strongIndex = new Map();
  matchable.forEach((line, order) => {
    line.order = order;
    for (const key of line.keys) {
      if (!key.startsWith('disk:') && !key.startsWith('vm:')) continue;
      const held = strongIndex.get(key);
      if (held) held.push(line);
      else strongIndex.set(key, [line]);
    }
  });

  function candidatesFor(keys) {
    let found = null;
    for (const key of keys) {
      const lot = strongIndex.get(key);
      if (!lot) continue;
      if (found === null) found = lot.slice();
      else for (const line of lot) if (!found.includes(line)) found.push(line);
    }
    if (found === null) return EMPTY_LINES;
    return found.length > 1 ? found.sort((a, b) => a.order - b.order) : found;
  }

  // One record per usage row saying which estimate line claimed it. The
  // category table can only ever be read by category; this keeps the same
  // verdict attached to the row itself so the identical numbers can be
  // regrouped by resource group, service or region without re-running — and
  // therefore without any risk of a second grouping disagreeing with the first.
  const attributions = [];

  for (const row of usageRows) {
    const keys = skuKeys(`${row.meter || ''} ${row.meter_subcategory || ''} ${row.service || ''}`);
    let best = null;
    let bestScore = 0;
    for (const line of candidatesFor(keys)) {
      const score = matchScore(line.keys, keys);
      if (score > bestScore) { best = line; bestScore = score; }
    }

    const cost = row.cost / span;
    const bytes = rowBytes(row) / span;
    const id = meterKey(row);
    const claimedBy = best && bestScore >= 100 ? best : null;

    if (claimedBy) {
      claimedBy.actual += cost;
      const existing = claimedBy.matches.find(m => m.id === id);
      if (existing) { existing.cost += cost; existing.bytes += bytes; addPart(existing, row); }
      else {
        const entry = { id, ...meterIdentity(row), cost, bytes, parts: [] };
        addPart(entry, row);
        claimedBy.matches.push(entry);
      }
    } else if (cost > 0) {
      // Charged, but no estimate line claims this SKU.
      // Zero-cost meters (prepaid reservations, included quotas) are noise here.
      const entry = unmatched.get(id) || { id, ...meterIdentity(row), cost: 0, bytes: 0, parts: [] };
      entry.cost += cost;
      entry.bytes += bytes;
      addPart(entry, row);
      unmatched.set(id, entry);
    }

    attributions.push({
      row,
      monthlyCost: cost,
      bytes,
      matched: Boolean(claimedBy),
      boqLine: claimedBy ? (claimedBy.custom_name || claimedBy.service_type || '') : '',
      boqName: claimedBy ? (claimedBy.boq || '') : '',
    });
  }

  // `keys` is the internal SKU match set; it is dropped rather than shipped to
  // the UI, which has no use for it.
  const shape = (source) => {
    const line = { ...source };
    delete line.keys;
    delete line.order;
    const variance = line.actual - line.monthly_cost;
    const billedCount = line.matches.length;
    return {
      ...line,
      actual: round(line.actual),
      variance: round(variance),
      variancePct: variancePct(variance, line.monthly_cost),
      matched: billedCount > 0,
      // How many separate resources are billed against a line the estimate sized
      // for `budgetQty` — this is usually the whole story behind an overrun.
      billedCount,
      drivers: costDrivers(line, billedCount),
      matches: line.matches
        .map(m => ({ ...m, cost: round(m.cost), parts: shapeParts(m.parts) }))
        .sort((a, b) => b.cost - a.cost),
    };
  };

  const unmatchedList = [...unmatched.values()]
    .map(u => ({ ...u, cost: round(u.cost), parts: shapeParts(u.parts) }))
    .sort((a, b) => b.cost - a.cost);
  const unmatchedTotal = round(unmatchedList.reduce((s, u) => s + u.cost, 0));

  // Lines with nothing to join on are compared as a group against whatever is
  // left over, which is honest about the limits of the match.
  const pooledLines = lines.filter(l => !l.hasSku).map(shape);
  const pooledBudget = round(pooledLines.reduce((s, l) => s + l.monthly_cost, 0));

  return {
    lines: lines.filter(l => l.hasSku).map(shape).sort((a, b) => b.variance - a.variance),
    pooledLines,
    pooledBudget,
    pooledVariance: round(unmatchedTotal - pooledBudget),
    unmatched: unmatchedList,
    unmatchedTotal,
    attributions,
  };
}


/** Fold a service name from either side into a comparison bucket. */
export function bucketFor(name) {
  const text = String(name || '').toLowerCase();
  if (!text) return OTHER;
  // Longest match wins, so "Virtual Machines Licenses" lands in Licences and
  // not in Compute just because "virtual machine" appeared first.
  let best = null;
  let bestLen = 0;
  for (const bucket of BUCKETS) {
    for (const token of bucket.match) {
      if (text.includes(token) && token.length > bestLen) {
        best = bucket;
        bestLen = token.length;
      }
    }
  }
  return best || OTHER;
}

/**
 * Build the variance report.
 *
 * @param boqs   parsed estimates (each already filtered to the ones in use)
 * @param rows   usage rows already filtered by subscription and date
 * @param months how many distinct months those rows span
 * @param currency the currency both sides are quoted in
 * @param opts.perMonth  true to average actuals down to one month; false to
 *   multiply the estimate up to the whole selected period instead.
 * @param opts.days  how many days the usage actually covers, and
 * @param opts.daysInPeriod  how many days those calendar months hold in full.
 *   Given both, the estimate is scaled by the fraction of the period that was
 *   really billed. A four-day window otherwise compares four days of spend
 *   against a whole month of budget and reports a 90% underspend that means
 *   nothing. When they are equal this reduces exactly to the month count, so
 *   a complete selection behaves as before.
 *
 * The two bases answer different questions and both are legitimate. Per month
 * is the right way to compare estimates written at different times. Full period
 * is the right way to answer "what did this quarter cost against what we said
 * it would", and it is the only one whose actual figure ties back to an
 * invoice. What is not legitimate is mixing them, so the basis is decided once,
 * here, and every number in the report -- headline, category, line, driver and
 * traffic -- is on it.
 */
export function compareBoqToUsage(boqs, rows, months = 1, currency = 'INR', opts = {}) {
  const span = Math.max(months, 1);
  const perMonth = opts.perMonth !== false;

  // How much of the selected period the usage actually covers. Only trusted
  // when both halves are known and the covered part is genuinely shorter --
  // a partial figure larger than the period would mean the inputs disagree,
  // and stretching the budget to fit would hide that rather than show it.
  const days = Number(opts.days) || 0;
  const daysInPeriod = Number(opts.daysInPeriod) || 0;
  const partial = days > 0 && daysInPeriod > 0 && days < daysInPeriod
    ? days / daysInPeriod
    : 1;

  // Only one of these is ever not 1. Either actuals come down to a month, or
  // the estimate goes up to the period -- never both, which would cancel out
  // and silently produce the per-month answer under a full-period heading.
  const divisor = perMonth ? span : 1;
  const budgetFactor = perMonth ? 1 : span * partial;

  // The estimate is a monthly figure, so one side has to move to meet the
  // other before anything can be compared.
  const budget = new Map();
  let budgetTotal = 0;
  for (const boq of boqs) {
    for (const item of boq.items || []) {
      const bucket = bucketFor(`${item.service_type} ${item.service_category}`);
      const entry = budget.get(bucket.key) || { label: bucket.label, amount: 0, lines: [] };
      const scaled = item.monthly_cost * budgetFactor;
      entry.amount += scaled;
      // Scaled at the source so every downstream consumer -- lines, pooled
      // budgets, unit prices, drivers -- is on the same basis without each
      // having to remember to apply the factor itself.
      entry.lines.push({ ...item, monthly_cost: scaled, boq: boq.name });
      budget.set(bucket.key, entry);
      budgetTotal += scaled;
    }
    // Managed services / support are real budgeted money, so include them.
    if (boq.managed_services) {
      const entry = budget.get('licensing') || { label: 'Licences & Support', amount: 0, lines: [] };
      const scaled = boq.managed_services * budgetFactor;
      entry.amount += scaled;
      entry.lines.push({
        service_category: 'Support', service_type: 'Managed Services',
        custom_name: '', region: '', description: 'Managed services retainer',
        monthly_cost: scaled, boq: boq.name,
      });
      budget.set('licensing', entry);
      budgetTotal += scaled;
    }
  }

  const actual = new Map();
  let actualTotal = 0;
  for (const row of rows) {
    // Egress meters hide under many services (Virtual Network, CDN, Storage),
    // so any data-transfer row is pulled into Bandwidth regardless of service.
    const bucket = isBandwidthRow(row)
      ? BANDWIDTH_BUCKET
      : isBackupRow(row)
        ? BACKUP_BUCKET
        : bucketFor(row.service);
    const entry = actual.get(bucket.key) || { label: bucket.label, amount: 0, services: new Map(), rows: [] };
    entry.amount += row.cost;
    entry.services.set(row.service, (entry.services.get(row.service) || 0) + row.cost);
    entry.rows.push(row);
    actual.set(bucket.key, entry);
    actualTotal += row.cost;
  }

  const keys = new Set([...budget.keys(), ...actual.keys()]);
  const categories = [...keys].map((key) => {
    const b = budget.get(key);
    const a = actual.get(key);
    const budgeted = round(b?.amount || 0);
    const spent = round((a?.amount || 0) / divisor);
    const variance = round(spent - budgeted);
    const detail = compareLines(b?.lines || [], a?.rows || [], divisor);
    const label = b?.label || a?.label || OTHER.label;
    // Where a category budgets things that cannot be split per resource
    // (a backup policy, a support retainer), leftover charges are covered by
    // that pooled budget rather than being unbudgeted. The row-level verdict
    // has to agree with that, or the breakdown totals would contradict the
    // headline "Not in your BOQ" figure sitting directly above them.
    const pooled = detail.pooledLines.length > 0;
    return {
      key,
      label,
      budgeted,
      actual: spent,
      variance,
      variancePct: budgeted > 0 ? variancePct(variance, budgeted) : null,
      // Nothing was budgeted for it at all — the clearest kind of extra charge.
      unbudgeted: budgeted === 0 && spent > 0,
      unused: spent === 0 && budgeted > 0,
      budgetLines: b?.lines || [],
      // Per-resource breakdown: every estimate line with what it really cost,
      // plus anything charged that no line accounts for.
      lines: detail.lines,
      pooledLines: detail.pooledLines,
      pooledBudget: detail.pooledBudget,
      pooledVariance: detail.pooledVariance,
      unmatched: detail.unmatched,
      unmatchedTotal: detail.unmatchedTotal,
      // Charges no BOQ line pays for. Where the category has budget lines that
      // simply can't be split per resource, the leftover is covered by that
      // pooled budget instead, so it isn't counted as "not in the BOQ".
      notInBoqTotal: detail.pooledLines.length ? 0 : detail.unmatchedTotal,
      // Every usage row in this category, carrying the verdict the category
      // table reached, so the same money can be regrouped by any dimension.
      attributions: detail.attributions.map(item => ({
        ...item.row,
        categoryKey: key,
        category: label,
        monthlyCost: item.monthlyCost,
        bytes: item.bytes,
        boqLine: item.boqLine,
        boqName: item.boqName,
        coverage: item.matched ? 'line' : pooled ? 'pooled' : 'none',
      })),
      traffic: trafficSummary(a?.rows || [], divisor),
      actualServices: [...(a?.services || new Map())]
        .map(([name, cost]) => ({ name, cost: round(cost / divisor) }))
        .sort((x, y) => y.cost - x.cost),
    };
  }).sort((x, y) => y.variance - x.variance);

  const monthlyActual = round(actualTotal / divisor);
  const overspend = categories.filter(c => c.variance > 0);

  // Every individual charge with no BOQ line behind it, flattened so it can be
  // shown as one list regardless of which category it landed in.
  const notInBoq = categories
    .filter(c => c.notInBoqTotal > 0)
    .flatMap(c => c.unmatched.map(u => ({ ...u, category: c.label, categoryKey: c.key })))
    .sort((a, b) => b.cost - a.cost);

  return {
    currency,
    months: span,
    // Which question this report answers. Every figure in it is on this basis,
    // and the page says which one out loud rather than leaving a reader to
    // work out whether a number is a month or a quarter.
    perMonth,
    budgetFactor,
    // The fraction of the period that was actually billed, so the page can say
    // "4 of 31 days" rather than presenting a part-month as a whole one.
    partial,
    days: days || null,
    daysInPeriod: daysInPeriod || null,
    categories,
    // Flat, row-level view of exactly the same money the categories describe.
    attributions: categories.flatMap(c => c.attributions),
    budgetTotal: round(budgetTotal),
    actualTotal: monthlyActual,
    variance: round(monthlyActual - budgetTotal),
    variancePct: budgetTotal > 0 ? variancePct(monthlyActual - budgetTotal, budgetTotal) : null,
    // "What is extra" — the number the user actually asked for.
    extraTotal: round(overspend.reduce((sum, c) => sum + c.variance, 0)),
    notInBoq,
    notInBoqTotal: round(categories.reduce((sum, c) => sum + c.notInBoqTotal, 0)),
    unbudgetedTotal: round(
      categories.filter(c => c.unbudgeted).reduce((sum, c) => sum + c.actual, 0),
    ),
    savingTotal: round(
      categories.filter(c => c.variance < 0).reduce((sum, c) => sum - c.variance, 0),
    ),
  };
}
