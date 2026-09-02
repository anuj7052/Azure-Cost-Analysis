/**
 * From a service name down to the individual machines under it.
 *
 * "Virtual Machines cost ₹4,20,000" is where every cost conversation starts
 * and none of them end. The next question is always which machines, and the
 * one after that is what happened to the expensive one. Both are answerable
 * from the meter-level rows the BOQ comparison already holds, so neither
 * requires another call to Azure and neither can disagree with the totals it
 * was opened from.
 *
 * What the billing data can say, it says here: what each resource cost, which
 * SKU it was billed as, which months it appeared in, and whether the SKU
 * changed underneath it. What billing cannot say -- who created it, when it
 * was modified, who resized it -- is not guessed at. That comes from the
 * resource timeline, and where the timeline cannot answer, the panel says so
 * rather than leaving a blank that reads as "nothing happened".
 */

const round2 = (n) => Math.round(n * 100) / 100;
const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
const norm = (s) => String(s || '').trim().toLowerCase();

/**
 * Every named resource billed under one service, dearest first.
 *
 * Rows with no resource name are counted but not invented: Cost Management
 * returns unattributed lines for some meters, and giving them a made-up name
 * would put a row in the list that cannot be clicked through to anything.
 * They are reported as a separate total instead.
 *
 * @param rows     meter-level usage rows
 * @param service  the service to open, matched case-insensitively
 */
export function resourcesInService(rows, service) {
  const want = norm(service);
  if (!want) return null;

  const mine = (Array.isArray(rows) ? rows : [])
    .filter(r => r && isNum(r.cost) && norm(r.service) === want);
  if (!mine.length) return null;

  const byResource = new Map();
  let unnamed = 0;
  let unnamedRows = 0;

  for (const row of mine) {
    const name = String(row.resource_name || '').trim();
    if (!name) {
      unnamed += row.cost;
      unnamedRows += 1;
      continue;
    }
    // Keyed on group as well as name, because two resource groups may hold a
    // resource of the same name and merging them would report one machine
    // costing twice what any machine costs.
    const key = `${norm(row.resource_group)}/${norm(name)}`;
    const held = byResource.get(key) || {
      key,
      name,
      group: row.resource_group || '',
      region: row.region || '',
      subscriptionId: row.subscription_id || '',
      service: row.service || service,
      total: 0,
      months: new Map(),
      meters: new Map(),
    };
    held.total += row.cost;
    if (!held.region && row.region) held.region = row.region;

    const month = String(row.month || '');
    const m = held.months.get(month) || { month, cost: 0, meters: new Map() };
    m.cost += row.cost;
    if (row.meter) m.meters.set(row.meter, (m.meters.get(row.meter) || 0) + row.cost);
    held.months.set(month, m);

    if (row.meter) {
      const meter = held.meters.get(row.meter)
        || { name: row.meter, cost: 0, quantity: 0, unit: row.unit_of_measure || '' };
      meter.cost += row.cost;
      if (isNum(row.quantity)) meter.quantity += row.quantity;
      held.meters.set(row.meter, meter);
    }
    byResource.set(key, held);
  }

  const total = round2(mine.reduce((s, r) => s + r.cost, 0));

  const resources = [...byResource.values()].map((r) => {
    const months = [...r.months.values()].sort((a, b) => a.month.localeCompare(b.month));
    return {
      key: r.key,
      name: r.name,
      group: r.group,
      region: r.region,
      subscriptionId: r.subscriptionId,
      service: r.service,
      total: round2(r.total),
      share: total > 0 ? round2((r.total / total) * 100) : 0,
      months: months.map(m => ({ month: m.month, cost: round2(m.cost) })),
      monthsBilled: months.length,
      firstMonth: months.length ? months[0].month : null,
      lastMonth: months.length ? months[months.length - 1].month : null,
      meters: [...r.meters.values()]
        .map(m => ({ ...m, cost: round2(m.cost), quantity: round2(m.quantity) }))
        .sort((a, b) => b.cost - a.cost),
      // The SKU it spent most of its money on, which is the one worth naming
      // when there is only room to name one.
      sku: [...r.meters.values()].sort((a, b) => b.cost - a.cost)[0]?.name || '',
      skuChanges: skuChangesOf(months),
    };
  }).sort((a, b) => b.total - a.total);

  return {
    service,
    total,
    resources,
    unnamed: round2(unnamed),
    unnamedRows,
    // Said plainly so a list that covers most of the money is not mistaken for
    // one that covers all of it.
    named: round2(total - unnamed),
  };
}

/**
 * Where the dominant meter changed from one month to the next.
 *
 * This is the one structural change billing can prove on its own: a machine
 * billed as D4s v5 in June and D8s v5 in July was resized, whatever the
 * Activity Log has or has not retained. It is not the whole change history and
 * is not presented as one.
 */
function skuChangesOf(months) {
  const changes = [];
  for (let i = 1; i < months.length; i += 1) {
    const before = dominantMeter(months[i - 1]);
    const after = dominantMeter(months[i]);
    if (before && after && before !== after) {
      changes.push({
        month: months[i].month,
        from: before,
        to: after,
        costBefore: round2(months[i - 1].cost),
        costAfter: round2(months[i].cost),
        delta: round2(months[i].cost - months[i - 1].cost),
      });
    }
  }
  return changes;
}

function dominantMeter(month) {
  let best = null;
  let most = -Infinity;
  for (const [name, cost] of month.meters) {
    if (cost > most) { most = cost; best = name; }
  }
  return best;
}

/** One resource out of the service listing, by the key the list carries. */
export function resourceByKey(listing, key) {
  if (!listing || !key) return null;
  return listing.resources.find(r => r.key === key) || null;
}

/**
 * Sort a resource timeline into the three things a reader is looking for.
 *
 * The endpoint returns a lifecycle block, a list of scan-to-scan events and a
 * cost series, each of which can be missing for its own reason. They are kept
 * apart rather than merged into one stream, because in a merged list an
 * absence is invisible — and the whole point of the lifecycle block is that it
 * distinguishes a date Azure vouched for from a date we inferred from when our
 * own scanning happened to start.
 */
export function summariseTimeline(timeline) {
  if (!timeline) return null;
  if (!timeline.resource) {
    return {
      known: false,
      notes: timeline.notes || [],
    };
  }

  const life = timeline.lifecycle || {};
  const events = Array.isArray(timeline.events) ? timeline.events : [];

  // Only the scans where something actually changed, newest first, which is
  // how the history already returns them.
  const modifications = events
    .filter(e => e.kind === 'modified' && Array.isArray(e.changes) && e.changes.length)
    .map(e => ({
      at: e.at,
      changes: e.changes.map(c => ({
        field: c.field || '',
        from: c.from ?? c.old ?? null,
        to: c.to ?? c.new ?? null,
      })),
      // The Activity Log entries that fall in the window between the two
      // scans. Candidates, not a culprit — the backend is careful about that
      // and so is this.
      candidates: Array.isArray(e.activity) ? e.activity : [],
      cost: e.cost || null,
    }));

  const removed = events.find(e => e.kind === 'removed') || null;

  return {
    known: true,
    resource: timeline.resource,
    // Each of these carries `{at, source, exact, by, detail}` — `exact: false`
    // means the date is a bound, not a birthday, and the UI must say so.
    created: life.created || null,
    lastChanged: life.last_changed || null,
    deleted: life.deleted || null,
    stillPresent: life.still_present !== false,
    activityCoversFrom: life.activity_covers_from || null,
    firstSeen: timeline.first_seen || null,
    lastSeen: timeline.last_seen || null,
    scanCount: timeline.scan_count || 0,
    modifications,
    changeCount: modifications.length,
    removedAt: removed ? removed.at : null,
    cost: timeline.cost || null,
    // Why a section is thin or empty, so an absence is never read as a fact.
    notes: Array.isArray(timeline.notes) ? timeline.notes : [],
  };
}
