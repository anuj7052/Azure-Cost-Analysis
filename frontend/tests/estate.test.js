import { describe, it, expect } from 'vitest';
import {
  INSUFFICIENT, NO_COST, NOT_AVAILABLE, advisorSnapshot, anomalySeverity,
  anomalySummary, attentionFindings, biggestChanges, categoryOf, completeMonths,
  computeSummary, costTone, direction, displayMoney, displayPct, estateHealth,
  governanceSnapshot, inventorySummary, isCurrentMonth, isNum, isRefreshing,
  kpiStrip, orphanSummary, recentChanges, refreshStages, resourceGroupSummary,
  searchEstate, securitySnapshot, serviceBreakdown, shortType, spendOverview,
  subscriptionHealth, topResources,
} from '../src/utils/estate';

/**
 * The Estate Command Center aggregates eight independent datasets, and
 * aggregation is precisely where invented numbers appear: a total assembled
 * from four sources of which two failed still looks exactly like an answer.
 *
 * So most of what follows is not testing that the arithmetic is right. It is
 * testing that the page refuses to produce arithmetic at all when the inputs
 * are missing — that "nobody asked", "Azure would not say" and "the answer was
 * genuinely none" survive all the way to the screen as three different things.
 */

// ── fixtures ───────────────────────────────────────────────────────────────

const COST = {
  months: [
    { month: '2026-06', total_cost: 10000, currency: 'INR', by_service: { 'Virtual Machines': 6000, Storage: 4000 }, by_subscription: { 'sub-a': 7000, 'sub-b': 3000 } },
    { month: '2026-07', total_cost: 12000, currency: 'INR', by_service: { 'Virtual Machines': 9000, Storage: 2000, Bandwidth: 1000 }, by_subscription: { 'sub-a': 9000, 'sub-b': 3000 } },
  ],
  total_6m: 22000,
  mom_change_pct: 20,
  top_services: [],
  anomalies: [{ service: 'Virtual Machines', month: '2026-07', pct_change: 50, reason: 'Fifty percent above the trailing mean.' }],
  savings: [],
  coverage: { partial: false },
};

const SERVICES = [
  { name: 'vm-web', type: 'microsoft.compute/virtualMachines', resource_group: 'rg-web', subscription_id: 'sub-a', location: 'centralindia', cost: 6000, tags: { Owner: 'dana', Environment: 'prod' } },
  { name: 'disk-old', type: 'microsoft.compute/disks', resource_group: 'rg-web', subscription_id: 'sub-a', location: 'centralindia', cost: 400, tags: {} },
  { name: 'stor01', type: 'microsoft.storage/storageAccounts', resource_group: 'rg-data', subscription_id: 'sub-b', location: 'westeurope', cost: null, tags: { Owner: 'ops' } },
  { name: 'nic-1', type: 'microsoft.network/networkInterfaces', resource_group: 'rg-web', subscription_id: 'sub-a', location: 'centralindia', cost: 0, tags: {} },
];

const COMPUTE = {
  currency: 'INR',
  vms: [
    {
      id: '/subscriptions/sub-a/rg/vm-web', resource_id: '/subscriptions/sub-a/rg/vm-web',
      name: 'vm-web', subscription_id: 'sub-a', region: 'centralindia',
      severity: 'high', verdict: 'underutilized', verdict_label: 'Oversized',
      reason: 'P95 CPU is 6%.', recommended_sku: 'Standard_D2as_v5',
      savings: { monthly: 3200 }, operational: { status: 'RUNNING' },
    },
    {
      id: '/subscriptions/sub-b/rg/vm-idle', resource_id: '/subscriptions/sub-b/rg/vm-idle',
      name: 'vm-idle', subscription_id: 'sub-b', region: 'westeurope',
      severity: 'medium', verdict: 'idle', verdict_label: 'Idle',
      reason: 'No measurable CPU.', recommended_sku: null,
      savings: {}, operational: { status: 'RUNNING' },
    },
    {
      id: '/subscriptions/sub-a/rg/vm-off', resource_id: '/subscriptions/sub-a/rg/vm-off',
      name: 'vm-off', subscription_id: 'sub-a', region: 'centralindia',
      severity: 'none', verdict: 'deallocated', verdict_label: 'Deallocated',
      savings: {}, operational: { status: 'DEALLOCATED' },
    },
  ],
  summary: {
    total: 3, running: 2, deallocated: 1, stopped: 0,
    telemetry_measured: 2, verifiably_off: 1, telemetry_unavailable: 0,
    rightsizing_opportunities: 2,
    confident_monthly_savings: 3200, confident_annual_savings: 38400,
    monthly_savings: 3200, fleet_monthly_cost: 9000,
  },
};

const ORPHANED = {
  currency: 'INR',
  total_count: 2,
  total_monthly_cost: 700,
  categories: [
    {
      key: 'disks', title: 'Unattached managed disks', severity: 'certain',
      reason: 'Attached to nothing.', count: 1, monthly_cost: 400,
      items: [{ id: '/d/1', name: 'disk-old', subscription_id: 'sub-a', location: 'centralindia', monthly_cost: 400, detail: 'Detached 40 days ago.' }],
    },
    {
      key: 'nics', title: 'Unattached network interfaces', severity: 'likely',
      reason: 'No parent VM.', count: 1, monthly_cost: 300,
      items: [{ id: '/n/1', name: 'nic-1', subscription_id: 'sub-a', location: 'centralindia', monthly_cost: null }],
    },
  ],
  errors: [],
};

const ACTIVITY = {
  events: [
    { id: 'e1', at: '2026-08-25T10:00:00Z', caller: 'dana@contoso.com', operation: 'Microsoft.Compute/virtualMachines/write', summary: 'VM resized', succeeded: true, status: 'Succeeded', resource_id: '/subscriptions/sub-a/rg/vm-web', subscription_id: 'sub-a' },
    { id: 'e2', at: '2026-08-24T09:00:00Z', caller: 'sp-deployer', operation: 'Microsoft.Network/publicIPAddresses/delete', summary: 'Public IP deleted', succeeded: false, status: 'Failed', resource_id: '/subscriptions/sub-b/rg/ip-1', subscription_id: 'sub-b' },
  ],
  total: 2, failed: 1, window_days: 7, errors: [],
};

const DEFENDER = {
  assessments: [
    { key: 'd1', severity: 'critical', title: 'Disks are not encrypted', resource_name: 'vm-web', resource_id: '/x', subscription_id: 'sub-a', solution: 'Enable encryption at host.' },
    { key: 'd2', severity: 'medium', title: 'Diagnostics off', resource_name: 'vm-idle', subscription_id: 'sub-b' },
  ],
  summary: { total: 2, by_severity: { critical: 1, medium: 1 }, high_count: 0 },
  secure_score_overall: 61,
  alerts: [],
};

const POLICY = {
  non_compliant: [{ key: 'p1', severity: 'low', title: 'Missing tag CostCenter', resource_name: 'disk-old', subscription_id: 'sub-a' }],
  assignments: [], exemptions: [], expiring_exemptions: [],
  summary: { total: 1, by_severity: { low: 1 }, high_count: 0 },
  evaluated_count: 100, compliant_count: 80, compliance_rate: 80, unenforced_count: 1,
};

// ── the running month ends up in every comparison if you let it ────────────

describe('a month that is still running is never compared against a complete one', () => {
  // Cost Management returns the current month happily, and on the 3rd it holds
  // three days of charges. Comparing it against a full previous month reports
  // a 96% saving nobody made — and cost efficiency, service shares and the
  // per-subscription change column all inherit it.
  const NOW = new Date('2026-08-26T12:00:00Z');
  const RUNNING = {
    months: [
      ...COST.months,
      { month: '2026-08', total_cost: 2560, currency: 'INR', by_service: { 'Virtual Machines': 300, Storage: 260 }, by_subscription: { 'sub-a': 2000, 'sub-b': 560 } },
    ],
  };

  it('recognises the calendar month it is standing in', () => {
    expect(isCurrentMonth('2026-08', NOW)).toBe(true);
    expect(isCurrentMonth('2026-07', NOW)).toBe(false);
    expect(isCurrentMonth(null, NOW)).toBe(false);
  });

  it('drops the running month from the comparable series', () => {
    expect(completeMonths(RUNNING, { now: NOW }).map(m => m.month)).toEqual(['2026-06', '2026-07']);
    expect(completeMonths(COST, { now: NOW }).map(m => m.month)).toEqual(['2026-06', '2026-07']);
  });

  it('keeps the running month when the window is measured in days', () => {
    // 7D/30D ask for a period, not a month. The partial bucket IS the answer.
    expect(completeMonths(RUNNING, { now: NOW, dayWindow: true }).map(m => m.month))
      .toEqual(['2026-06', '2026-07', '2026-08']);
  });

  it('headlines the last complete month and carries month-to-date separately', () => {
    const spend = spendOverview(RUNNING, { now: NOW });
    expect(spend.currentMonth).toBe('2026-07');
    expect(spend.current).toBe(12000);
    expect(spend.previousMonth).toBe('2026-06');
    expect(spend.monthToDate).toBe(2560);
    expect(spend.monthToDateMonth).toBe('2026-08');
    // July against June — up 20%, not down 79%.
    expect(spend.changePct).toBeCloseTo(20);
    expect(spend.direction).toBe('up');
  });

  it('still charts the running month so it is not hidden, only labelled', () => {
    const spend = spendOverview(RUNNING, { now: NOW });
    expect(spend.series.map(s => s.month)).toContain('2026-08');
    expect(spend.monthToDateNote).toMatch(/still in progress/);
  });

  it('reports month-to-date honestly when there is no complete month at all', () => {
    const spend = spendOverview({ months: [RUNNING.months[2]] }, { now: NOW });
    expect(spend.current).toBeNull();
    expect(spend.currentMonth).toBeNull();
    expect(spend.monthToDate).toBe(2560);
    expect(spend.changePct).toBeNull();
  });

  it('keeps the service breakdown on complete months', () => {
    const result = serviceBreakdown(RUNNING, 8, { now: NOW });
    expect(result.month).toBe('2026-07');
    expect(result.rows[0].changePct).toBeCloseTo(50);
  });

  it('keeps biggest-changes on complete months', () => {
    const result = biggestChanges(RUNNING, 8, { now: NOW });
    expect(result.from).toBe('2026-06');
    expect(result.to).toBe('2026-07');
    expect(result.rows[0].delta).toBe(3000);
  });

  it('does not divide identified waste by a partial bill', () => {
    // Against 2,560 of month-to-date the 3,900 of measured waste is 152% of
    // the bill and cost efficiency floors at zero for no real reason.
    const category = estateHealth({ compute: COMPUTE, orphaned: ORPHANED, costData: RUNNING, opts: { now: NOW } })
      .categories.find(c => c.key === 'cost');
    expect(category.score).toBe(68);
    expect(category.reason).toMatch(/last complete month/);
  });

  it('keeps the per-subscription change column on complete months', () => {
    const row = subscriptionHealth({ selectedIds: ['sub-a'], costData: RUNNING, opts: { now: NOW } }).rows[0];
    expect(row.cost).toBe(9000);
    expect(row.changePct).toBeCloseTo(28.6, 0);
  });
});

// ── formatting primitives ──────────────────────────────────────────────────

describe('a missing number never becomes a zero', () => {
  it('tells a real zero apart from an absent value', () => {
    expect(isNum(0)).toBe(true);
    expect(isNum(null)).toBe(false);
    expect(isNum(undefined)).toBe(false);
    expect(isNum(NaN)).toBe(false);
    expect(isNum(Infinity)).toBe(false);
  });

  it('returns null rather than formatting a non-number as money', () => {
    expect(displayMoney(null, 'INR')).toBeNull();
    expect(displayMoney(undefined, 'INR')).toBeNull();
    expect(displayMoney(NaN, 'INR')).toBeNull();
    expect(displayMoney(0, 'INR')).not.toBeNull();
  });

  it('refuses to render an unmeasured change as 0%', () => {
    expect(displayPct(null)).toBeNull();
    expect(displayPct(NaN)).toBeNull();
    expect(displayPct(12.34)).toBe('+12.3%');
    expect(displayPct(-4)).toBe('-4.0%');
  });

  it('does not claim a direction for a movement nobody measured', () => {
    expect(direction(null)).toBe('unknown');
    expect(direction(0.1)).toBe('flat');
    expect(direction(9)).toBe('up');
    expect(direction(-9)).toBe('down');
  });

  it('treats rising cost as bad news and falling cost as good', () => {
    expect(costTone(20)).toBe('high');
    expect(costTone(-20)).toBe('good');
    expect(costTone(null)).toBe('neutral');
  });
});

// ── taxonomy ───────────────────────────────────────────────────────────────

describe('resource categories', () => {
  it('splits microsoft.compute between compute and storage', () => {
    // Both live under the same provider, and bucketing by provider alone would
    // report every managed disk as a virtual machine.
    expect(categoryOf('microsoft.compute/virtualMachines')).toBe('compute');
    expect(categoryOf('microsoft.compute/disks')).toBe('storage');
  });

  it('files an unrecognised provider as other rather than dropping it', () => {
    expect(categoryOf('microsoft.somethingnew/widgets')).toBe('other');
    expect(categoryOf('')).toBe('other');
    expect(categoryOf(undefined)).toBe('other');
  });

  it('shortens a type for display without inventing one', () => {
    expect(shortType('microsoft.compute/virtualMachines')).toBe('virtualMachines');
    expect(shortType(null)).toBe(NOT_AVAILABLE);
  });
});

// ── scope: 0 / 1 / many / all subscriptions ────────────────────────────────

describe('the subscription selection is honoured everywhere', () => {
  it('shows no subscription table when nothing is selected', () => {
    expect(subscriptionHealth({ selectedIds: [], costData: COST })).toBeNull();
    expect(subscriptionHealth({ selectedIds: null, costData: COST })).toBeNull();
  });

  it('reports exactly one row for one selected subscription', () => {
    const result = subscriptionHealth({
      subscriptions: [{ subscription_id: 'sub-a', display_name: 'Production' }],
      selectedIds: ['sub-a'], costData: COST, services: SERVICES,
      compute: COMPUTE, orphaned: ORPHANED,
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].name).toBe('Production');
    expect(result.rows[0].cost).toBe(9000);
  });

  it('never includes a subscription the user did not select', () => {
    const result = subscriptionHealth({
      selectedIds: ['sub-a'], costData: COST, services: SERVICES, compute: COMPUTE, orphaned: ORPHANED,
    });
    expect(result.rows.map(r => r.subscriptionId)).toEqual(['sub-a']);
    // sub-b costs 9,000 in the same dataset and must not leak into the table.
    expect(JSON.stringify(result)).not.toContain('sub-b');
  });

  it('covers every selected subscription when all are chosen', () => {
    const result = subscriptionHealth({
      selectedIds: ['sub-a', 'sub-b'], costData: COST, services: SERVICES, compute: COMPUTE, orphaned: ORPHANED,
    });
    expect(result.rows).toHaveLength(2);
    // Sorted by spend, so the expensive one leads.
    expect(result.rows[0].subscriptionId).toBe('sub-a');
  });

  it('shows a selected subscription that no dataset mentioned as dashes, not zeros', () => {
    const result = subscriptionHealth({
      selectedIds: ['sub-ghost'], costData: null, services: null, compute: null, orphaned: null,
    });
    const row = result.rows[0];
    expect(row.cost).toBeNull();
    expect(row.resources).toBeNull();
    expect(row.running).toBeNull();
    expect(row.issues).toBeNull();
    expect(row.health).toBe('unknown');
  });

  it('counts issues per subscription from the modules that own them', () => {
    const result = subscriptionHealth({
      selectedIds: ['sub-a', 'sub-b'], costData: COST, services: SERVICES, compute: COMPUTE, orphaned: ORPHANED,
    });
    const a = result.rows.find(r => r.subscriptionId === 'sub-a');
    // one oversized VM + two orphans, both of which live in sub-a
    expect(a.issues).toBe(3);
    expect(a.running).toBe(1);
  });
});

// ── spend ──────────────────────────────────────────────────────────────────

describe('spend overview', () => {
  it('returns null rather than an empty chart when cost is unavailable', () => {
    expect(spendOverview(null)).toBeNull();
    expect(spendOverview({ months: [] })).toBeNull();
  });

  it('compares the last two months', () => {
    const spend = spendOverview(COST);
    expect(spend.current).toBe(12000);
    expect(spend.previous).toBe(10000);
    expect(spend.changePct).toBeCloseTo(20);
    expect(spend.direction).toBe('up');
  });

  it('states no change when there is no previous month to compare', () => {
    const spend = spendOverview({ months: [COST.months[1]] });
    expect(spend.previous).toBeNull();
    expect(spend.changePct).toBeNull();
    expect(spend.direction).toBe('unknown');
  });

  it('never offers a forecast', () => {
    // Extrapolating a trend line and calling it a forecast is the single most
    // common way a FinOps dashboard starts lying to its owner.
    const spend = spendOverview(COST);
    expect(spend.hasForecast).toBe(false);
    expect(spend.forecastNote).toMatch(/no forecast/i);
  });

  it('flags a partial answer so the total is read as a floor', () => {
    const spend = spendOverview({ ...COST, coverage: { partial: true } });
    expect(spend.partial).toBe(true);
  });
});

describe('cost by service', () => {
  it('ranks by spend and computes each share of the latest month', () => {
    const result = serviceBreakdown(COST);
    expect(result.rows[0].name).toBe('Virtual Machines');
    expect(result.rows[0].share).toBeCloseTo(75);
    expect(result.rows[0].changePct).toBeCloseTo(50);
  });

  it('marks a service that only appeared this month as new, not +100%', () => {
    const bandwidth = serviceBreakdown(COST).rows.find(r => r.name === 'Bandwidth');
    expect(bandwidth.isNew).toBe(true);
    expect(bandwidth.changePct).toBeNull();
  });

  it('returns null when there is no cost data at all', () => {
    expect(serviceBreakdown(null)).toBeNull();
  });
});

describe('biggest cost changes', () => {
  it('ranks by the amount moved, not the percentage', () => {
    // Storage fell 2,000; Virtual Machines rose 3,000. A percentage ranking
    // would put a meter that went from 2 to 6 above either of them.
    const result = biggestChanges(COST);
    expect(result.rows[0].name).toBe('Virtual Machines');
    expect(result.rows[0].delta).toBe(3000);
    expect(result.rows[1].name).toBe('Storage');
    expect(result.rows[1].delta).toBe(-2000);
  });

  it('reports a lone month instead of blanking the panel', () => {
    // A brand-new subscription has exactly one month of billing. Returning null
    // left the panel empty, which reads as a failed read rather than as
    // "there is nothing to compare against yet".
    const result = biggestChanges({ months: [COST.months[0]] });
    expect(result.mode).toBe('single');
    expect(result.from).toBeNull();
    expect(result.to).toBe(COST.months[0].month);
    expect(result.rows.length).toBeGreaterThan(0);
    // No change column is invented for a month with nothing behind it.
    expect(result.rows.every(r => r.delta === null && r.changePct === null)).toBe(true);
  });

  it('still returns null when there is no cost data at all', () => {
    expect(biggestChanges(null)).toBeNull();
    expect(biggestChanges({ months: [] })).toBeNull();
  });

  it('marks a newly appeared service rather than dividing by zero', () => {
    const bandwidth = biggestChanges(COST).rows.find(r => r.name === 'Bandwidth');
    expect(bandwidth.appeared).toBe(true);
    expect(bandwidth.changePct).toBeNull();
    expect(Number.isNaN(bandwidth.delta)).toBe(false);
  });
});

// ── inventory ──────────────────────────────────────────────────────────────

describe('resource inventory', () => {
  it('returns null when the inventory was never read', () => {
    expect(inventorySummary(null)).toBeNull();
    expect(inventorySummary(undefined)).toBeNull();
  });

  it('reports an empty estate as empty, not as unread', () => {
    const result = inventorySummary([]);
    expect(result.total).toBe(0);
    expect(result.categories).toEqual([]);
  });

  it('leaves a category cost null when nothing in it was billed', () => {
    const result = inventorySummary([SERVICES[2]]);
    const storage = result.categories.find(c => c.key === 'storage');
    expect(storage.count).toBe(1);
    expect(storage.cost).toBeNull();
  });

  it('counts a genuine zero charge as priced', () => {
    const result = inventorySummary([SERVICES[3]]);
    const network = result.categories.find(c => c.key === 'network');
    expect(network.cost).toBe(0);
    expect(network.priced).toBe(1);
  });
});

describe('most expensive resources', () => {
  it('excludes unpriced resources instead of ranking them as cheapest', () => {
    const result = topResources(SERVICES);
    expect(result.rows.map(r => r.name)).toEqual(['vm-web', 'disk-old']);
    // stor01 has no charge and nic-1 charges zero; neither is "the cheapest".
    expect(result.unpriced).toBe(2);
  });

  it('returns null when the inventory is unavailable', () => {
    expect(topResources(null)).toBeNull();
  });
});

// ── orphans ────────────────────────────────────────────────────────────────

describe('orphaned resources', () => {
  it('consumes the orphan module rather than re-detecting anything', () => {
    const result = orphanSummary(ORPHANED);
    expect(result.count).toBe(2);
    expect(result.monthly).toBe(700);
    expect(result.annual).toBe(8400);
  });

  it('returns null when the sweep never ran', () => {
    expect(orphanSummary(null)).toBeNull();
  });

  it('carries a category through with no monthly cost as null', () => {
    const nics = orphanSummary(ORPHANED).categories.find(c => c.key === 'nics');
    expect(nics.monthly).toBe(300);
    const unpriced = orphanSummary({ total_count: 1, categories: [{ key: 'x', title: 'X', count: 1, monthly_cost: null, items: [] }] });
    expect(unpriced.categories[0].monthly).toBeNull();
    expect(unpriced.monthly).toBeNull();
    expect(unpriced.annual).toBeNull();
  });
});

// ── governance ─────────────────────────────────────────────────────────────

describe('governance snapshot', () => {
  it('returns null when neither inventory nor policy was read', () => {
    expect(governanceSnapshot({})).toBeNull();
    expect(governanceSnapshot({ services: [], policy: null })).toBeNull();
  });

  it('measures tag coverage over the live inventory', () => {
    const result = governanceSnapshot({ services: SERVICES });
    const owner = result.tags.find(t => t.key === 'owner');
    expect(owner.present).toBe(2);
    expect(owner.missing).toBe(2);
    expect(owner.coverage).toBeCloseTo(50);
  });

  it('ignores a tag whose value is blank', () => {
    const result = governanceSnapshot({ services: [{ tags: { Owner: '   ' } }] });
    expect(result.tags.find(t => t.key === 'owner').present).toBe(0);
  });

  it('matches common spellings of the same governance tag', () => {
    const result = governanceSnapshot({ services: [{ tags: { cost_center: 'CC-1', env: 'prod' } }] });
    expect(result.tags.find(t => t.key === 'costcenter').present).toBe(1);
    expect(result.tags.find(t => t.key === 'environment').present).toBe(1);
  });

  it('distinguishes policy that was not loaded from policy that evaluated nothing', () => {
    expect(governanceSnapshot({ services: SERVICES }).complianceState).toBe('not_loaded');
    expect(governanceSnapshot({ services: SERVICES, policy: { compliance_rate: null } }).complianceState).toBe('not_evaluated');
    expect(governanceSnapshot({ services: SERVICES, policy: POLICY }).complianceState).toBe('known');
  });
});

// ── security ───────────────────────────────────────────────────────────────

describe('security snapshot', () => {
  it('never reports an unscanned source as clear', () => {
    // Defender is a paid tier. "Nothing came back" and "nothing is wrong" are
    // the two answers this page must never merge.
    const result = securitySnapshot({});
    expect(result.loadedCount).toBe(0);
    expect(result.totals).toBeNull();
    expect(result.sources.every(s => s.state === 'not_loaded')).toBe(true);
  });

  it('totals only the sources that actually answered', () => {
    const result = securitySnapshot({ defender: DEFENDER });
    expect(result.loadedCount).toBe(1);
    expect(result.totals).toEqual({ critical: 1, high: 0, medium: 1 });
    expect(result.sources.find(s => s.key === 'advisor').state).toBe('not_loaded');
  });

  it('keeps a loaded source that genuinely found nothing distinct from an absent one', () => {
    const clean = securitySnapshot({ defender: { summary: { total: 0, by_severity: {} } } });
    expect(clean.loadedCount).toBe(1);
    expect(clean.totals).toEqual({ critical: 0, high: 0, medium: 0 });
  });
});

// ── health ─────────────────────────────────────────────────────────────────

describe('estate health is measured, never invented', () => {
  it('scores nothing at all when no dataset has arrived', () => {
    const health = estateHealth({});
    expect(health.overall).toBeNull();
    expect(health.scoredCount).toBe(0);
    expect(health.categories).toHaveLength(5);
    expect(health.categories.every(c => c.score === null && c.status === 'unknown')).toBe(true);
  });

  it('gives every unscored category a reason a human can act on', () => {
    for (const category of estateHealth({}).categories) {
      expect(category.reason.length).toBeGreaterThan(20);
      expect(category.action.length).toBeGreaterThan(5);
      expect(category.to).toMatch(/^\//);
    }
  });

  it('excludes unscored categories from the mean instead of assuming them healthy', () => {
    const health = estateHealth({ compute: COMPUTE, orphaned: ORPHANED, costData: COST, services: SERVICES });
    expect(health.scoredCount).toBeLessThan(health.totalCount);
    expect(health.basis).toMatch(/excluded rather than assumed healthy/);
    const scored = health.categories.filter(c => typeof c.score === 'number');
    const mean = Math.round(scored.reduce((s, c) => s + c.score, 0) / scored.length);
    expect(health.overall).toBe(mean);
  });

  it('derives cost efficiency from measured waste against the real bill', () => {
    // 3,200 of compute saving + 700 of orphans = 3,900 of 12,000 = 32.5%.
    const category = estateHealth({ compute: COMPUTE, orphaned: ORPHANED, costData: COST })
      .categories.find(c => c.key === 'cost');
    expect(category.score).toBe(68);
    expect(category.status).toBe('fair');
  });

  it('cannot score cost efficiency without a bill to measure waste against', () => {
    const category = estateHealth({ compute: COMPUTE, orphaned: ORPHANED, costData: null })
      .categories.find(c => c.key === 'cost');
    expect(category.score).toBeNull();
    expect(category.reason).toMatch(/monthly spend has not been read/i);
  });

  it('scores compute only against machines it could actually conclude about', () => {
    const category = estateHealth({ compute: COMPUTE }).categories.find(c => c.key === 'compute');
    // 2 findings across 3 conclusive machines (2 measured + 1 verifiably off).
    expect(category.score).toBe(33);
    expect(category.reason).toMatch(/conclusively assessed/);
  });

  it('refuses to score compute when Azure published no usable telemetry', () => {
    const blind = { summary: { total: 4, telemetry_measured: 0, verifiably_off: 0, telemetry_unavailable: 4, rightsizing_opportunities: 0 } };
    const category = estateHealth({ compute: blind }).categories.find(c => c.key === 'compute');
    expect(category.score).toBeNull();
    expect(category.reason).toMatch(/no usable CPU telemetry/i);
  });

  it('says so when machines were excluded from the compute score', () => {
    const partial = { summary: { total: 4, telemetry_measured: 2, verifiably_off: 0, telemetry_unavailable: 2, rightsizing_opportunities: 1 } };
    const category = estateHealth({ compute: partial }).categories.find(c => c.key === 'compute');
    expect(category.note).toMatch(/excluded from this score rather than counted as healthy/);
  });

  it('measures security findings as a density over the estate, not a flat deduction', () => {
    // A flat deduction saturates at zero on any real estate, so a dangerous
    // estate and a merely noisy one would score identically.
    const category = estateHealth({ defender: DEFENDER, services: SERVICES }).categories.find(c => c.key === 'security');
    // (1 critical x10) + (1 medium x1) = 11 of weight over 4 resources = 2.75,
    // against a saturation floor of 3.00.
    expect(category.score).toBe(8);
    expect(category.reason).toMatch(/weighted 10\/5\/1 and spread over 4 resources/);
  });

  it('still discriminates between a noisy estate and a dangerous one', () => {
    const many = Array.from({ length: 300 }, (_, i) => ({ name: `r${i}`, type: 'microsoft.storage/storageAccounts' }));
    const noisy = { summary: { total: 400, by_severity: { medium: 400 } } };
    const dangerous = { summary: { total: 400, by_severity: { critical: 120, high: 120 } } };
    const noisyScore = estateHealth({ defender: noisy, services: many }).categories.find(c => c.key === 'security').score;
    const dangerScore = estateHealth({ defender: dangerous, services: many }).categories.find(c => c.key === 'security').score;
    expect(noisyScore).toBeGreaterThan(dangerScore);
    expect(noisyScore).toBeGreaterThan(0);
  });

  it('will not express findings as a density without an inventory to divide by', () => {
    const category = estateHealth({ defender: DEFENDER }).categories.find(c => c.key === 'security');
    expect(category.score).toBeNull();
    expect(category.reason).toMatch(/resource inventory was not/i);
  });

  it('never scores security from an absence of findings', () => {
    const category = estateHealth({}).categories.find(c => c.key === 'security');
    expect(category.score).toBeNull();
    expect(category.reason).toMatch(/an empty result is not a clean result/i);
  });

  it('counts security findings as findings, not as resources', () => {
    // One resource can carry a dozen findings, so reporting 1,446 findings as
    // "1,446 resources affected" overstates the size of the problem.
    const security = estateHealth({ defender: DEFENDER, services: SERVICES }).categories.find(c => c.key === 'security');
    expect(security.affectedNoun).toBe('finding');
    const hygiene = estateHealth({ orphaned: ORPHANED, services: SERVICES }).categories.find(c => c.key === 'hygiene');
    expect(hygiene.affectedNoun).toBeUndefined();
  });

  it('is deterministic — the same inputs always give the same score', () => {
    const args = { compute: COMPUTE, orphaned: ORPHANED, costData: COST, services: SERVICES, policy: POLICY, defender: DEFENDER };
    expect(estateHealth(args)).toEqual(estateHealth(args));
  });

  it('keeps every score inside 0–100 even when waste exceeds the bill', () => {
    const runaway = { summary: { ...COMPUTE.summary, confident_monthly_savings: 999999 } };
    const category = estateHealth({ compute: runaway, costData: COST }).categories.find(c => c.key === 'cost');
    expect(category.score).toBe(0);
  });
});

// ── attention queue ────────────────────────────────────────────────────────

describe('what needs attention', () => {
  it('is empty and priced-at-nothing when no module has reported', () => {
    const result = attentionFindings({});
    expect(result.total).toBe(0);
    expect(result.knownImpact).toBeNull();
  });

  it('restates each module’s own severity rather than re-grading it', () => {
    const result = attentionFindings({ compute: COMPUTE, currency: 'INR' });
    const oversized = result.findings.find(f => f.resource === 'vm-web');
    expect(oversized.severity).toBe('high');
    expect(oversized.source).toBe('Compute Intelligence');
    expect(oversized.to).toBe('/compute');
  });

  it('never lists a VM Compute Intelligence considered fine', () => {
    const result = attentionFindings({ compute: COMPUTE });
    expect(result.findings.map(f => f.resource)).not.toContain('vm-off');
  });

  it('says the cost impact is unavailable instead of showing zero', () => {
    const result = attentionFindings({ compute: COMPUTE, currency: 'INR' });
    const idle = result.findings.find(f => f.resource === 'vm-idle');
    expect(idle.impact).toBeNull();
    expect(idle.impactLabel).toBe(NO_COST);
  });

  it('grades a likely orphan below a certain one', () => {
    const result = attentionFindings({ orphaned: ORPHANED });
    expect(result.findings.find(f => f.resource === 'disk-old').severity).toBe('medium');
    expect(result.findings.find(f => f.resource === 'nic-1').severity).toBe('low');
  });

  it('sorts by severity, then by the largest known impact', () => {
    const result = attentionFindings({ compute: COMPUTE, orphaned: ORPHANED, defender: DEFENDER, currency: 'INR' });
    const severities = result.findings.map(f => f.severity);
    const ranked = [...severities].sort((a, b) => ({ critical: 0, high: 1, medium: 2, low: 3 }[a] - { critical: 0, high: 1, medium: 2, low: 3 }[b]));
    expect(severities).toEqual(ranked);
    expect(result.findings[0].severity).toBe('critical');
  });

  it('totals only the findings that carry a real number, and counts the rest', () => {
    const result = attentionFindings({ compute: COMPUTE, orphaned: ORPHANED, currency: 'INR' });
    // 3,200 (vm-web) + 400 (disk-old). vm-idle and nic-1 are unpriced.
    expect(result.knownImpact).toBe(3600);
    expect(result.unpriced).toBe(2);
  });

  it('surfaces a cost anomaly without inventing a rupee figure for it', () => {
    const result = attentionFindings({ costData: COST });
    const anomaly = result.findings.find(f => f.source === 'Cost Anomalies');
    expect(anomaly.severity).toBe('high');
    expect(anomaly.impact).toBeNull();
    expect(anomaly.impactLabel).toContain('+50.0%');
  });

  it('raises failed control-plane operations', () => {
    const result = attentionFindings({ activity: ACTIVITY });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].problem).toMatch(/Failed operation/);
    expect(result.findings[0].to).toBe('/activity');
  });

  it('ignores medium and low security noise on a triage surface', () => {
    const result = attentionFindings({ defender: DEFENDER });
    expect(result.total).toBe(1);
    expect(result.findings[0].severity).toBe('critical');
  });

  it('gives every finding a working destination and a call to action', () => {
    const result = attentionFindings({
      compute: COMPUTE, orphaned: ORPHANED, costData: COST, defender: DEFENDER,
      policy: POLICY, activity: ACTIVITY, limit: 99,
    });
    const routes = ['/compute', '/orphaned', '/anomalies', '/defender', '/advisor', '/policy', '/activity'];
    for (const finding of result.findings) {
      expect(routes).toContain(finding.to);
      expect(finding.cta).toBeTruthy();
      expect(finding.key).toBeTruthy();
    }
  });

  it('caps the list but reports the true total', () => {
    const result = attentionFindings({ compute: COMPUTE, orphaned: ORPHANED, limit: 1 });
    expect(result.findings).toHaveLength(1);
    expect(result.total).toBe(4);
  });
});

// ── KPI strip ──────────────────────────────────────────────────────────────

describe('the KPI strip', () => {
  it('shows dashes, not zeros, before anything has loaded', () => {
    const kpis = kpiStrip({});
    const nulled = ['resources', 'running', 'spend', 'change', 'opportunity', 'changes', 'health'];
    for (const key of nulled) {
      expect(kpis.find(k => k.key === key).value).toBeNull();
    }
  });

  it('reports no high-confidence saving without printing a fake zero', () => {
    // Compute Intelligence returns null rather than 0 for exactly this reason,
    // and the strip must carry that through.
    const noSaving = { summary: { ...COMPUTE.summary, confident_monthly_savings: null } };
    const card = kpiStrip({ compute: noSaving }).find(k => k.key === 'opportunity');
    expect(card.value).toBeNull();
    expect(card.hint).toBe('No high-confidence optimization opportunity identified.');
  });

  it('surfaces estate health as insufficient rather than as a number', () => {
    const card = kpiStrip({ health: estateHealth({}) }).find(k => k.key === 'health');
    expect(card.value).toBeNull();
    expect(card.hint).toBe(INSUFFICIENT);
  });

  it('produces eight cards, each with a label and no NaN anywhere', () => {
    const kpis = kpiStrip({
      compute: COMPUTE, costData: COST, orphaned: ORPHANED, services: SERVICES,
      activity: ACTIVITY, health: estateHealth({ compute: COMPUTE, costData: COST }), currency: 'INR',
    });
    expect(kpis).toHaveLength(8);
    for (const card of kpis) {
      expect(card.label).toBeTruthy();
      expect(String(card.value)).not.toMatch(/NaN|undefined|null/);
      expect(String(card.hint)).not.toMatch(/NaN|undefined/);
    }
  });

  it('distinguishes an examined estate with nothing wrong from an unexamined one', () => {
    const clean = kpiStrip({ compute: { vms: [], summary: {} } }).find(k => k.key === 'attention');
    expect(clean.value).toBe('0');
    expect(kpiStrip({}).find(k => k.key === 'attention').value).toBeNull();
  });
});

// ── loading, error, partial, refresh ───────────────────────────────────────

describe('refresh progress reflects answers, not a timer', () => {
  it('starts every stage pending', () => {
    const stages = refreshStages({});
    expect(stages).toHaveLength(7);
    expect(stages.every(s => s.status === 'pending')).toBe(true);
    expect(isRefreshing(stages)).toBe(false);
  });

  it('shows a stage as running while its request is in flight', () => {
    const stages = refreshStages({ cost: { loading: true } });
    expect(stages.find(s => s.key === 'cost').status).toBe('running');
    expect(isRefreshing(stages)).toBe(true);
  });

  it('shows a failed stage with its message rather than silently marking it done', () => {
    const stages = refreshStages({ compute: { error: 'Azure Monitor throttled the request.', done: true } });
    const compute = stages.find(s => s.key === 'compute');
    expect(compute.status).toBe('failed');
    expect(compute.error).toMatch(/throttled/);
  });

  it('lets one stage fail while the others complete', () => {
    const stages = refreshStages({
      cost: { done: true },
      compute: { error: 'no access' },
      orphaned: { done: true },
    });
    expect(stages.find(s => s.key === 'cost').status).toBe('done');
    expect(stages.find(s => s.key === 'compute').status).toBe('failed');
    expect(stages.find(s => s.key === 'orphaned').status).toBe('done');
    // Nothing is running, so a duplicate Refresh click is not blocked forever.
    expect(isRefreshing(stages)).toBe(false);
  });
});

describe('partial Azure responses', () => {
  it('marks an orphan sweep that lost subscriptions as a floor', () => {
    expect(orphanSummary({ ...ORPHANED, errors: [{ error: '429' }] }).partial).toBe(true);
  });

  it('marks activity that lost subscriptions as partial', () => {
    expect(recentChanges({ ...ACTIVITY, errors: [{ error: '403' }] }).partial).toBe(true);
  });

  it('returns null for activity that was never requested', () => {
    expect(recentChanges(null)).toBeNull();
    expect(recentChanges({})).toBeNull();
  });

  it('reads the window and failure count without inventing either', () => {
    const recent = recentChanges(ACTIVITY);
    expect(recent.windowDays).toBe(7);
    expect(recent.failed).toBe(1);
    expect(recentChanges({ events: [] }).failed).toBeNull();
  });
});

// ── search ─────────────────────────────────────────────────────────────────

describe('estate search', () => {
  it('shows nothing until something is typed', () => {
    expect(searchEstate(SERVICES, '')).toBeNull();
    expect(searchEstate(SERVICES, '   ')).toBeNull();
  });

  it('says the inventory is not ready rather than reporting no matches', () => {
    // "Nothing matched" and "we have not loaded anything to match against" send
    // the user in completely different directions.
    const result = searchEstate(null, 'vm');
    expect(result.ready).toBe(false);
    expect(result.rows).toEqual([]);
  });

  it('matches name, type, resource group, region and SKU', () => {
    expect(searchEstate(SERVICES, 'vm-web').total).toBe(1);
    expect(searchEstate(SERVICES, 'rg-web').total).toBe(3);
    expect(searchEstate(SERVICES, 'westeurope').total).toBe(1);
    expect(searchEstate(SERVICES, 'storageaccounts').total).toBe(1);
  });

  it('is case-insensitive', () => {
    expect(searchEstate(SERVICES, 'VM-WEB').total).toBe(1);
  });

  it('only ever searches what was loaded for the caller’s own scope', () => {
    // The inventory handed in was fetched for the signed-in user's tenant and
    // their selected subscriptions, so there is nothing here to leak.
    const result = searchEstate(SERVICES.filter(r => r.subscription_id === 'sub-a'), 'stor01');
    expect(result.total).toBe(0);
  });

  it('caps the result set and says it did', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ name: `vm-${i}`, type: 'microsoft.compute/virtualMachines' }));
    const result = searchEstate(many, 'vm-', 25);
    expect(result.rows).toHaveLength(25);
    expect(result.total).toBe(40);
    expect(result.truncated).toBe(true);
  });
});

// ── whole-page invariants ──────────────────────────────────────────────────

describe('no section ever emits a broken value', () => {
  const EVERYTHING = {
    compute: COMPUTE, orphaned: ORPHANED, costData: COST, services: SERVICES,
    policy: POLICY, defender: DEFENDER, activity: ACTIVITY,
  };

  it('produces no NaN, undefined or null strings anywhere with full data', () => {
    const payload = JSON.stringify({
      health: estateHealth(EVERYTHING),
      kpis: kpiStrip({ ...EVERYTHING, health: estateHealth(EVERYTHING), currency: 'INR' }),
      attention: attentionFindings({ ...EVERYTHING, currency: 'INR' }),
      spend: spendOverview(COST),
      services: serviceBreakdown(COST),
      changes: biggestChanges(COST),
      inventory: inventorySummary(SERVICES),
      expensive: topResources(SERVICES),
      orphans: orphanSummary(ORPHANED),
      governance: governanceSnapshot({ services: SERVICES, policy: POLICY }),
      security: securitySnapshot({ defender: DEFENDER, policy: POLICY }),
      recent: recentChanges(ACTIVITY),
      subs: subscriptionHealth({ selectedIds: ['sub-a', 'sub-b'], ...EVERYTHING, compute: COMPUTE }),
    });
    expect(payload).not.toMatch(/"NaN"|"undefined"|"\$NaN"|NaN,/);
  });

  it('survives every dataset being missing without throwing', () => {
    expect(() => {
      estateHealth({});
      kpiStrip({});
      attentionFindings({});
      spendOverview(null);
      serviceBreakdown(null);
      biggestChanges(null);
      inventorySummary(null);
      topResources(null);
      orphanSummary(null);
      governanceSnapshot({});
      securitySnapshot({});
      recentChanges(null);
      subscriptionHealth({});
      searchEstate(null, 'x');
      refreshStages({});
    }).not.toThrow();
  });

  it('survives malformed datasets without throwing', () => {
    const junk = { vms: 'nope', summary: null, categories: 7, months: {}, events: null };
    expect(() => {
      estateHealth({ compute: junk, orphaned: junk, costData: junk, services: junk });
      attentionFindings({ compute: junk, orphaned: junk, costData: junk, activity: junk });
      inventorySummary(junk);
      subscriptionHealth({ selectedIds: ['a'], costData: junk, services: junk, compute: junk, orphaned: junk });
    }).not.toThrow();
  });
});

/**
 * The sections added in the second pass: Advisor, anomalies, resource groups,
 * compute and RBAC. Each of these restates a figure another module produced,
 * so what is worth testing is not the arithmetic but the refusals — the cases
 * where Azure published nothing and the answer has to stay absent.
 */
describe('cost anomalies', () => {
  it('grades on the amount that moved as well as the percentage', () => {
    // A small meter that tripled is not the same event as a large one that did.
    expect(anomalySeverity(300, 12000)).toBe('critical');
    expect(anomalySeverity(300, 40)).toBe('low');
    expect(anomalySeverity(60, 2000)).toBe('high');
    expect(anomalySeverity(25, 900)).toBe('medium');
  });

  it('will not grade high on a percentage alone', () => {
    expect(anomalySeverity(400, null)).toBe('medium');
    expect(anomalySeverity(30, null)).toBe('low');
    expect(anomalySeverity(null, 99999)).toBe('low');
  });

  it('restates the detector output without re-detecting anything', () => {
    const result = anomalySummary({
      anomalies: [
        { service: 'Storage', month: '2026-07', prev_month: '2026-06', pct_change: 25, current_cost: 1400, prev_cost: 1120, reason: 'up 25%' },
        { service: 'Compute', month: '2026-07', prev_month: '2026-06', pct_change: 210, current_cost: 18000, prev_cost: 5800 },
      ],
    });
    expect(result.total).toBe(2);
    expect(result.counts.critical).toBe(1);
    // Sorted by severity, so the critical one leads.
    expect(result.rows[0].service).toBe('Compute');
    expect(result.rows[0].delta).toBe(12200);
    expect(result.rows[1].reason).toBe('up 25%');
  });

  it('separates "no anomalies" from "cost never loaded"', () => {
    expect(anomalySummary(null)).toBeNull();
    expect(anomalySummary({ months: [] })).toBeNull();
    expect(anomalySummary({ anomalies: [] }).total).toBe(0);
  });
});

describe('Azure Advisor snapshot', () => {
  const ADVISOR = {
    findings: [
      { severity: 'high', category: 'Cost', annual_saving: 1200, currency: 'INR' },
      { severity: 'high', category: 'Cost', annual_saving: 800, currency: 'INR' },
      { severity: 'medium', category: 'Security' },
      { severity: 'low', category: 'Reliability' },
    ],
    errors: [],
  };

  it('counts by Advisor severity and category', () => {
    const snap = advisorSnapshot(ADVISOR);
    expect(snap.total).toBe(4);
    expect(snap.counts).toEqual({ critical: 0, high: 2, medium: 1, low: 1 });
    expect(snap.categories[0]).toEqual({ name: 'Cost', count: 2 });
  });

  it('sums only the recommendations Azure actually priced', () => {
    const snap = advisorSnapshot(ADVISOR);
    expect(snap.annualSaving).toBe(2000);
    expect(snap.priced).toBe(2);
    // The other two are excluded, not counted as zero saving.
    expect(snap.unpriced).toBe(2);
    expect(snap.savingCurrency).toBe('INR');
  });

  it('reports no saving as null rather than as a fake zero', () => {
    const snap = advisorSnapshot({ findings: [{ severity: 'medium', category: 'Security' }] });
    expect(snap.annualSaving).toBeNull();
    expect(snap.priced).toBe(0);
  });

  it('flags a partial read so the totals are not read as complete', () => {
    expect(advisorSnapshot({ findings: [], errors: ['sub-2 denied'] }).partial).toBe(true);
    expect(advisorSnapshot(null)).toBeNull();
  });
});

describe('resource group summary', () => {
  const RG = {
    currency: 'INR',
    resource_groups: [
      { rg_name: 'rg-prod', total: 9000, by_month: { '2026-06': 3000, '2026-07': 4000, '2026-08': 2000 } },
      { rg_name: 'rg-dev', total: 1500, by_month: { '2026-07': 1500 } },
    ],
  };
  const NOW_AUG = new Date('2026-08-26T00:00:00Z');

  it('ranks by cost and uses the endpoint\'s own monthly buckets', () => {
    const result = resourceGroupSummary(RG, null, 8, { now: NOW_AUG });
    expect(result.rows[0].name).toBe('rg-prod');
    // 2026-08 is still running, so July is compared against June.
    expect(result.rows[0].month).toBe('2026-07');
    expect(result.rows[0].changePct).toBeCloseTo(33.33, 1);
  });

  it('shows no change for a group billed in only one month', () => {
    const result = resourceGroupSummary(RG, null, 8, { now: NOW_AUG });
    expect(result.rows[1].changePct).toBeNull();
  });

  it('never falls back to the running month when only one complete month exists', () => {
    // Bug 22: a 26-day bucket against a 31-day one read as a 96% collapse.
    const short = {
      resource_groups: [{ rg_name: 'rg-a', total: 6000, by_month: { '2026-07': 4000, '2026-08': 130 } }],
    };
    const result = resourceGroupSummary(short, null, 8, { now: NOW_AUG });
    expect(result.rows[0].month).toBe('2026-07');
    expect(result.rows[0].current).toBe(4000);
    expect(result.rows[0].changePct).toBeNull();
  });

  it('leaves the resource count absent when the inventory has not loaded', () => {
    expect(resourceGroupSummary(RG, null, 8, { now: NOW_AUG }).rows[0].resources).toBeNull();
    const withInv = resourceGroupSummary(RG, [{ resource_group: 'rg-prod' }, { resource_group: 'RG-PROD' }], 8, { now: NOW_AUG });
    expect(withInv.rows[0].resources).toBe(2);
  });

  it('returns null when the endpoint was never called', () => {
    expect(resourceGroupSummary(null, [])).toBeNull();
  });
});

describe('compute summary', () => {
  it('restates the fleet summary without recomputing it', () => {
    const fleet = computeSummary({
      summary: {
        total: 13, running: 5, deallocated: 8, telemetry_unavailable: 2,
        telemetry_measured: 3, rightsizing_opportunities: 4,
        confident_monthly_savings: 1200, confident_annual_savings: 14400,
      },
      vms: [
        { verdict: 'underutilized' }, { verdict: 'underutilized' },
        { verdict: 'idle' }, { verdict: 'right_sized' },
      ],
    });
    expect(fleet.running).toBe(5);
    expect(fleet.oversized).toBe(2);
    expect(fleet.idle).toBe(1);
    expect(fleet.confidentMonthly).toBe(1200);
  });

  it('keeps an unpublished saving null instead of quoting zero', () => {
    const fleet = computeSummary({ summary: { total: 3, running: 0 } });
    expect(fleet.confidentMonthly).toBeNull();
    expect(fleet.noOpportunityNote).toBe('No high-confidence optimization opportunity identified.');
    // No VM list means no verdict tally, and that is absent rather than zero.
    expect(fleet.oversized).toBeNull();
  });

  it('returns null when Compute Intelligence was never read', () => {
    expect(computeSummary(null)).toBeNull();
    expect(computeSummary({})).toBeNull();
  });
});

describe('RBAC in the security snapshot', () => {
  const ACCESS = {
    findings: [{ severity: 'high' }, { severity: 'high' }, { severity: 'medium' }],
    totals: { principals_with_findings: 2, finding_count: 3, high_count: 2 },
  };
  const ROLES = { totals: { principal_count: 41, assignment_count: 88, critical_count: 6 } };

  it('adds access and role assignments as their own sources', () => {
    const snap = securitySnapshot({ access: ACCESS, roles: ROLES });
    const keys = snap.sources.map(s => s.key);
    expect(keys).toContain('access');
    expect(keys).toContain('roles');
    expect(snap.rbac.principals).toBe(41);
    expect(snap.rbac.ownerLevel).toBe(6);
    expect(snap.rbac.accessFindings).toBe(3);
    expect(snap.rbac.accessHigh).toBe(2);
  });

  it('keeps RBAC out of the severity totals', () => {
    // A broad grant is a candidate for review, not an open vulnerability, so
    // it must never inflate the Defender/Policy/Advisor severity roll-up.
    const snap = securitySnapshot({ access: ACCESS, roles: ROLES });
    expect(snap.totals).toBeNull();
    expect(snap.loadedCount).toBe(0);
  });

  it('reports RBAC as not loaded rather than as clean', () => {
    const snap = securitySnapshot({});
    expect(snap.rbac.state).toBe('not_loaded');
    expect(snap.rbac.principals).toBeNull();
    expect(snap.rbac.accessFindings).toBeNull();
  });
});

describe('attention list keys', () => {
  it('never emits a duplicate key, so no finding is silently dropped', () => {
    // Advisor publishes the same recommendation once per subscription and
    // reuses its key across all of them.
    const advisor = {
      findings: Array.from({ length: 4 }, (_, i) => ({
        severity: 'high',
        key: 'owners-rule',
        title: 'A maximum of 3 owners should be designated',
        subscription_id: `sub-${i}`,
      })),
    };
    const result = attentionFindings({ advisor, limit: 20 });
    const keys = result.findings.map(f => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(result.total).toBe(4);
  });
});

/**
 * Bug 26. A 7- or 30-day window arrives from Cost Management as one or two
 * partial month buckets. Comparing the last of them against the one before it
 * divides seven days by thirty-one and prints a 96% collapse in spend, which
 * is the same failure the running-month guard was written to prevent.
 */
describe('day windows are periods, not months', () => {
  const NOW_AUG = new Date('2026-08-26T00:00:00Z');
  const WINDOW = {
    months: [
      { month: '2026-07', total_cost: 65664, by_service: { Storage: 40000, Compute: 25664 }, by_subscription: { 'sub-1': 65664 } },
      { month: '2026-08', total_cost: 2560, by_service: { Storage: 1600, Compute: 960 }, by_subscription: { 'sub-1': 2560 } },
    ],
  };
  const DAY = { now: NOW_AUG, dayWindow: true };

  it('totals the period instead of headlining a partial month', () => {
    const spend = spendOverview(WINDOW, DAY);
    expect(spend.periodMode).toBe(true);
    expect(spend.current).toBe(68224);
    expect(spend.currentMonth).toBeNull();
  });

  it('refuses the month-over-month comparison outright', () => {
    const spend = spendOverview(WINDOW, DAY);
    expect(spend.changePct).toBeNull();
    expect(spend.previous).toBeNull();
    expect(spend.direction).toBeNull();
    expect(spend.periodNote).toMatch(/no change is shown/);
  });

  it('still refuses to invent a forecast in period mode', () => {
    expect(spendOverview(WINDOW, DAY).hasForecast).toBe(false);
  });

  it('sums the service breakdown across the window and drops the change', () => {
    const result = serviceBreakdown(WINDOW, 8, DAY);
    expect(result.periodMode).toBe(true);
    expect(result.rows.find(r => r.name === 'Storage').cost).toBe(41600);
    expect(result.rows.every(r => r.changePct === null)).toBe(true);
    expect(result.month).toBeNull();
  });

  it('shows the period breakdown, not a month comparison, in a day window', () => {
    const result = biggestChanges(WINDOW, 8, DAY);
    expect(result.mode).toBe('single');
    expect(result.periodMode).toBe(true);
    // The two partial buckets are summed into the period the user asked for.
    expect(result.rows.find(r => r.name === 'Storage').current).toBe(41600);
    expect(result.from).toBeNull();
    expect(result.rows.every(r => r.delta === null)).toBe(true);
  });

  it('sums subscription cost over the period and shows no change column', () => {
    const result = subscriptionHealth({
      subscriptions: [{ subscription_id: 'sub-1', display_name: 'Prod' }],
      selectedIds: ['sub-1'],
      costData: WINDOW,
      opts: DAY,
    });
    expect(result.rows[0].cost).toBe(68224);
    expect(result.rows[0].changePct).toBeNull();
  });

  it('labels the KPI card as a period rather than as a month', () => {
    const cards = kpiStrip({ costData: WINDOW, opts: DAY, rangeLabel: 'Last 7 days', currency: 'INR' });
    const spend = cards.find(c => c.key === 'spend');
    expect(spend.label).toBe('Spend in period');
    expect(spend.hint).toBe('Last 7 days');
    expect(cards.find(c => c.key === 'change').hint).toMatch(/No earlier period/);
  });

  it('still behaves monthly when the window is measured in months', () => {
    const spend = spendOverview(WINDOW, { now: NOW_AUG });
    expect(spend.periodMode).toBe(false);
    expect(spend.currentMonth).toBe('2026-07');
    expect(spend.monthToDate).toBe(2560);
  });
});

/**
 * The comparison controls on the changes table. The month pair is chosen by
 * the caller, so the rule that matters is that a bad or stale choice falls
 * back to a safe default rather than producing a comparison nobody can read.
 */
describe('comparing any two months', () => {
  const NOW_SEP = new Date('2026-09-05T00:00:00Z');
  const SERIES = {
    months: [
      { month: '2026-06', total_cost: 100, by_service: { Storage: 60, Compute: 40 } },
      { month: '2026-07', total_cost: 150, by_service: { Storage: 50, Compute: 90, Backup: 10 } },
      { month: '2026-08', total_cost: 200, by_service: { Storage: 120, Compute: 80 } },
      { month: '2026-09', total_cost: 12, by_service: { Storage: 12 } },
    ],
  };
  const M = { now: NOW_SEP };

  it('defaults to the two most recent complete months', () => {
    const result = biggestChanges(SERIES, 8, M);
    expect(result.mode).toBe('compare');
    expect(result.from).toBe('2026-07');
    expect(result.to).toBe('2026-08');
    // The running month is offered but never chosen for you.
    expect(result.months).toContain('2026-09');
    expect(result.completeMonths).not.toContain('2026-09');
    expect(result.partialMonth).toBe(false);
  });

  it('compares any pair the caller asks for', () => {
    const result = biggestChanges(SERIES, 8, { ...M, from: '2026-06', to: '2026-08' });
    expect(result.from).toBe('2026-06');
    expect(result.to).toBe('2026-08');
    expect(result.rows.find(r => r.name === 'Storage').delta).toBe(60);
    expect(result.rows.find(r => r.name === 'Compute').delta).toBe(40);
  });

  it('marks a partial month as partial when it is deliberately chosen', () => {
    const result = biggestChanges(SERIES, 8, { ...M, from: '2026-08', to: '2026-09' });
    expect(result.partialMonth).toBe(true);
  });

  it('falls back to the default pair when a stale month is requested', () => {
    // Widening the header range must not strand the table on a month the new
    // response does not contain.
    const result = biggestChanges(SERIES, 8, { ...M, from: '2025-01', to: '2025-02' });
    expect(result.from).toBe('2026-07');
    expect(result.to).toBe('2026-08');
  });

  it('falls back to the default pair when from and to are the same month', () => {
    // The UI excludes `to` from the "from" list, so this only arises from a
    // stale pick. Comparing a month against itself would show nothing moved.
    const result = biggestChanges(SERIES, 8, { ...M, from: '2026-08', to: '2026-08' });
    expect(result.mode).toBe('compare');
    expect(result.from).toBe('2026-07');
    expect(result.to).toBe('2026-08');
  });

  it('treats an explicit empty "from" as no comparison at all', () => {
    // The UI"s "No comparison" option. Distinct from not asking, which defaults.
    const result = biggestChanges(SERIES, 8, { ...M, from: '', to: '2026-07' });
    expect(result.mode).toBe('single');
    expect(result.to).toBe('2026-07');
  });

  it('filters to increases, decreases, new and stopped services', () => {
    const opts = { ...M, from: '2026-06', to: '2026-07' };
    const up = biggestChanges(SERIES, 8, { ...opts, filter: 'increased' });
    expect(up.rows.every(r => r.delta > 0)).toBe(true);
    expect(up.rows.map(r => r.name).sort()).toEqual(['Backup', 'Compute']);

    const down = biggestChanges(SERIES, 8, { ...opts, filter: 'decreased' });
    expect(down.rows.map(r => r.name)).toEqual(['Storage']);

    const fresh = biggestChanges(SERIES, 8, { ...opts, filter: 'new' });
    expect(fresh.rows.map(r => r.name)).toEqual(['Backup']);
    expect(fresh.rows[0].appeared).toBe(true);

    const gone = biggestChanges(SERIES, 8, { ...opts, from: '2026-07', to: '2026-08', filter: 'removed' });
    expect(gone.rows.map(r => r.name)).toEqual(['Backup']);
    expect(gone.rows[0].disappeared).toBe(true);
  });

  it('separates "nothing moved" from "nothing matched the filter"', () => {
    const opts = { ...M, from: '2026-06', to: '2026-07' };
    const all = biggestChanges(SERIES, 8, opts);
    const fresh = biggestChanges(SERIES, 8, { ...opts, filter: 'new' });
    // `counted` is everything that moved; `matched` is what survived the filter.
    expect(fresh.counted).toBe(all.counted);
    expect(fresh.matched).toBe(1);
    expect(fresh.matched).toBeLessThan(fresh.counted);
  });
});
