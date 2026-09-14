/*
 * Resource groups, and the services inside them.
 *
 * Built from meter rows rather than the `/costs/rg` summary, so a group total
 * here always agrees with the trend line above it and honours the same
 * filters. Two endpoints answering the same question in slightly different
 * ways is how a page ends up contradicting itself.
 *
 * The `by_service` split that endpoint returns is a marginal anyway: it cannot
 * be crossed with a region or subscription filter. Rows can.
 */

import { rowMatches } from './trendFilter';

/** The label for a charge that names no resource group. */
export const UNGROUPED = 'No resource group';

/**
 * Total the filtered rows per resource group, biggest first.
 *
 * A charge with no group is kept under an explicit label rather than dropped.
 * Subscription-level charges are real money, and a group list whose totals
 * quietly fail to reach the invoice is worse than one that names the gap.
 *
 * `subscriptions` collects every subscription seen contributing to the group,
 * because a group name is only unique within a subscription -- two teams with
 * a `prod-rg` are not one group, and a row that says so prevents the reader
 * concluding their group costs twice what it does.
 */
export function groupsFromRows(rows, filters, { allowed = [] } = {}) {
  const months = allowed.length ? new Set(allowed) : null;
  const groups = new Map();

  for (const row of rows || []) {
    if (months && !months.has(row?.month)) continue;
    if (!rowMatches(row, filters)) continue;

    const name = row.resource_group || UNGROUPED;
    let group = groups.get(name);
    if (!group) {
      group = { name, cost: 0, services: new Map(), subscriptions: new Set() };
      groups.set(name, group);
    }
    const cost = Number(row.cost) || 0;
    group.cost += cost;
    if (row.subscription_id) group.subscriptions.add(row.subscription_id);
    const service = row.service || 'Unattributed';
    group.services.set(service, (group.services.get(service) || 0) + cost);
  }

  const total = [...groups.values()].reduce((sum, g) => sum + g.cost, 0);

  return [...groups.values()]
    .map((g) => ({
      name: g.name,
      cost: g.cost,
      // Null rather than zero when there is no total: a share of nothing is
      // not 0%, it is a question that cannot be answered.
      share: total ? g.cost / total : null,
      serviceCount: g.services.size,
      subscriptions: [...g.subscriptions],
      services: [...g.services.entries()]
        .map(([name, cost]) => ({
          name,
          cost,
          share: g.cost ? cost / g.cost : null,
        }))
        .sort((a, b) => b.cost - a.cost || a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => b.cost - a.cost || a.name.localeCompare(b.name));
}

/** The combined cost of a group list, for the header figure. */
export function groupsTotal(groups) {
  return (groups || []).reduce((sum, g) => sum + (Number(g.cost) || 0), 0);
}
