import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity, AlertTriangle, ArrowRight, Boxes, Coins, FolderTree, Gauge, Layers,
  Lightbulb, RefreshCw, Search, Server, Shield, ShieldCheck, TrendingUp, Unlink,
  Users, Wallet, GitCompare,
} from 'lucide-react';
import { Breadcrumb, KpiCard, Panel } from '../components/Layout/HubKit';
import ScopeStrip from '../components/Layout/ScopeStrip';
import {
  DataTable, Delta, Figure, FindingRow, HealthCategory, RefreshProgress, SectionState, Severity,
} from '../components/Estate/EstateKit';
import { useAppStore } from '../store/useAppStore';
import { formatAmount, formatAmountFull } from '../utils/currency';
import {
  CATEGORY_ROUTE, CHANGE_FILTERS, INSUFFICIENT, NOT_AVAILABLE, advisorSnapshot,
  anomalySummary, attentionFindings, biggestChanges, computeSummary, estateHealth,
  governanceSnapshot, inventorySummary, isRefreshing, kpiStrip, orphanSummary,
  recentChanges, refreshStages, resourceGroupSummary, searchEstate,
  securitySnapshot, serviceBreakdown, shortType, spendOverview,
  subscriptionHealth, topResources,
} from '../utils/estate';

/**
 * Azure Estate Command Center.
 *
 * This page owns no data and detects no findings. Every figure is either read
 * from a dataset another module already produced, or derived from those
 * datasets by a pure function in `utils/estate.js` that is tested directly.
 *
 * Two design rules run through the whole thing.
 *
 * First, the loads are staged rather than fired together. Seven Azure
 * fan-outs launched simultaneously do not arrive seven times faster — Cost
 * Management and Azure Monitor both throttle, and the requests start failing
 * each other. Cheap inventory and cost go first so the page becomes useful
 * within seconds; the minute-scale fan-outs follow behind them.
 *
 * Second, nothing here turns an absent answer into a number. A section whose
 * data never arrived says so, in the same words everywhere, and offers a
 * retry. That matters more on this page than on any other: an aggregate
 * assembled from four sources of which two failed still looks exactly like
 * an answer.
 */

/**
 * Cost windows offered in the header.
 *
 * Cost Management bills by month, so the two day windows are expressed as an
 * explicit from/to range rather than as a number of months. They also switch
 * off the running-month guard used everywhere else in this page: when someone
 * asks for the last 7 days, a partial month bucket is the answer they wanted,
 * not a comparison hazard.
 */
const RANGES = [
  { value: 'd7', label: 'Last 7 days', days: 7 },
  { value: 'd30', label: 'Last 30 days', days: 30 },
  { value: 'm3', label: '3 months', months: 3 },
  { value: 'm6', label: '6 months', months: 6 },
  { value: 'm12', label: '12 months', months: 12 },
];

const isoDay = (offset = 0) => {
  const d = new Date();
  d.setDate(d.getDate() - offset);
  return d.toISOString().slice(0, 10);
};

/** Cross-section destinations. Every route here is registered in App.jsx. */
const QUICK_ACTIONS = [
  { to: '/explorer', label: 'Cost Explorer', icon: Wallet },
  { to: '/compute', label: 'Compute Intelligence', icon: Gauge },
  { to: '/anomalies', label: 'Anomalies', icon: AlertTriangle },
  { to: '/activity', label: 'Activity Explorer', icon: Activity },
  { to: '/changes', label: 'Change Tracking', icon: GitCompare },
  { to: '/orphaned', label: 'Orphaned Resources', icon: Unlink },
  { to: '/resource-groups', label: 'Resource Groups', icon: Layers },
  { to: '/advisor', label: 'Azure Advisor', icon: Lightbulb },
  { to: '/defender', label: 'Microsoft Defender', icon: Shield },
  { to: '/policy', label: 'Policy Governance', icon: ShieldCheck },
  { to: '/access-optimization', label: 'Access Optimization', icon: Boxes },
  { to: '/role-assignments', label: 'Role Assignments', icon: Users },
];

const isNumLike = (v) => typeof v === 'number' && Number.isFinite(v);

function Muted({ children }) {
  return <span className="text-[11px] italic text-slate-600">{children}</span>;
}

export default function Estate() {
  // ── scope ──
  const tenantId = useAppStore(s => s.selectedTenantId);
  const subscriptions = useAppStore(s => s.subscriptions);
  const selectedIds = useAppStore(s => s.selectedSubscriptionIds);
  const months = useAppStore(s => s.months);
  const dateMode = useAppStore(s => s.dateMode);
  const fromDate = useAppStore(s => s.fromDate);
  const dateKey = useAppStore(s => s.dateKey);
  const setMonths = useAppStore(s => s.setMonths);
  const setCustomDateRange = useAppStore(s => s.setCustomDateRange);
  const setSelectedSubscriptionIds = useAppStore(s => s.setAllSubscriptions);
  const imported = useAppStore(s => s.imported);

  // ── datasets ──
  const costData = useAppStore(s => s.costData);
  const costLoading = useAppStore(s => s.costLoading);
  const costError = useAppStore(s => s.costError);
  const services = useAppStore(s => s.activeServices);
  const servicesLoading = useAppStore(s => s.servicesLoading);
  const servicesError = useAppStore(s => s.servicesError);
  const computeData = useAppStore(s => s.computeData);
  const computeLoading = useAppStore(s => s.computeLoading);
  const computeError = useAppStore(s => s.computeError);
  const orphanedData = useAppStore(s => s.orphanedData);
  const orphanedLoading = useAppStore(s => s.orphanedLoading);
  const orphanedError = useAppStore(s => s.orphanedError);
  const activityData = useAppStore(s => s.activityData);
  const activityLoading = useAppStore(s => s.activityLoading);
  const activityError = useAppStore(s => s.activityError);
  const policyData = useAppStore(s => s.policyData);
  const defenderData = useAppStore(s => s.defenderData);
  const advisorData = useAppStore(s => s.advisorData);
  const postureLoading = useAppStore(s => s.postureLoading);
  const postureError = useAppStore(s => s.postureError);
  const rgData = useAppStore(s => s.rgData);
  const rgLoading = useAppStore(s => s.rgLoading);
  const rgError = useAppStore(s => s.rgError);
  const accessData = useAppStore(s => s.accessData);
  const rolesData = useAppStore(s => s.rolesData);
  const accessLoading = useAppStore(s => s.accessLoading);
  const accessError = useAppStore(s => s.accessError);

  // ── loaders ──
  const loadCosts = useAppStore(s => s.loadCosts);
  const loadServices = useAppStore(s => s.loadServices);
  const loadCompute = useAppStore(s => s.loadCompute);
  const loadOrphaned = useAppStore(s => s.loadOrphaned);
  const loadActivity = useAppStore(s => s.loadActivity);
  const loadPosture = useAppStore(s => s.loadPosture);
  const loadRgCosts = useAppStore(s => s.loadRgCosts);
  const loadAccess = useAppStore(s => s.loadAccess);

  const [lastUpdated, setLastUpdated] = useState(null);
  const [query, setQuery] = useState('');
  // Comparison controls for the changes table. `null` means "follow the two
  // most recent complete months", so widening the header range keeps working
  // without the user having to clear a stale month they picked earlier.
  const [compareFrom, setCompareFrom] = useState(null);
  const [compareTo, setCompareTo] = useState(null);
  const [changeFilter, setChangeFilter] = useState('all');

  const scoped = Boolean(tenantId) && selectedIds.length > 0;

  // A second Refresh while the first is still running would double every
  // request in flight, and the throttled ones would start failing each other.
  // But a dropped request is worse than a delayed one: changing the date range
  // mid-load used to be discarded outright, leaving the page showing the old
  // window's numbers under the new window's label. A run requested while one
  // is in flight is therefore queued and executed the moment the first ends.
  const running = useRef(false);
  const pending = useRef(null);

  const run = useCallback(async (force) => {
    if (!scoped) return;
    if (running.current) { pending.current = { force }; return; }
    running.current = true;
    try {
      let request = { force };
      while (request) {
        pending.current = null;
        const opts = request.force ? { force: true } : {};
        // Wave 1 — cheap, and the page is readable the moment it lands.
        await Promise.allSettled([loadCosts(opts), loadServices(opts), loadRgCosts(opts)]);
        // Wave 2 — the minute-scale fan-outs across every subscription.
        await Promise.allSettled([loadCompute(opts), loadOrphaned(opts)]);
        // Wave 3 — the Activity Log, then the three posture providers.
        await Promise.allSettled([loadActivity(opts)]);
        await loadPosture(opts);
        // Wave 4 — RBAC last. Both endpoints walk every role assignment in
        // every subscription and the access review reads the Activity Log too.
        await loadAccess(opts);
        setLastUpdated(new Date());
        request = pending.current;
      }
    } finally {
      running.current = false;
      pending.current = null;
    }
  }, [scoped, loadCosts, loadServices, loadRgCosts, loadCompute, loadOrphaned,
    loadActivity, loadPosture, loadAccess]);

  // Deferred by a tick so the effect body never calls a state-setting callback
  // directly, and so a rapid scope change coalesces into a single run.
  useEffect(() => {
    if (!scoped) return undefined;
    const id = setTimeout(() => { run(false); }, 0);
    return () => clearTimeout(id);
  }, [scoped, dateKey, run]);

  // ── derived ──
  const currency = costData?.months?.[0]?.currency
    || orphanedData?.currency
    || computeData?.currency
    || 'INR';

  // Which header range is active, and whether it is a day window. A day window
  // suppresses the running-month guard — see RANGES.
  const rangeValue = useMemo(() => {
    if (dateMode === 'custom') {
      const match = RANGES.find(r => r.days && fromDate === isoDay(r.days));
      return match ? match.value : 'custom';
    }
    return RANGES.find(r => r.months === months)?.value || 'custom';
  }, [dateMode, fromDate, months]);

  const dayWindow = rangeValue === 'd7' || rangeValue === 'd30';
  const rangeOpts = useMemo(() => ({ dayWindow }), [dayWindow]);

  const onRangeChange = useCallback((value) => {
    const range = RANGES.find(r => r.value === value);
    if (!range) return;
    if (range.days) setCustomDateRange(isoDay(range.days), isoDay(0));
    else setMonths(range.months);
  }, [setCustomDateRange, setMonths]);

  const health = useMemo(
    () => estateHealth({
      compute: computeData, orphaned: orphanedData, costData, services,
      policy: policyData, defender: defenderData, advisor: advisorData,
      access: accessData, roles: rolesData,
    }),
    [computeData, orphanedData, costData, services, policyData, defenderData,
      advisorData, accessData, rolesData],
  );

  const kpis = useMemo(
    () => kpiStrip({
      compute: computeData, costData, orphaned: orphanedData, services,
      activity: activityData, health, currency, opts: rangeOpts,
      rangeLabel: RANGES.find(r => r.value === rangeValue)?.label || null,
      loading: {
        cost: costLoading, services: servicesLoading, compute: computeLoading,
        orphaned: orphanedLoading, activity: activityLoading,
      },
    }),
    [computeData, costData, orphanedData, services, activityData, health, currency,
      rangeOpts, rangeValue,
      costLoading, servicesLoading, computeLoading, orphanedLoading, activityLoading],
  );

  const attention = useMemo(
    () => attentionFindings({
      compute: computeData, orphaned: orphanedData, costData,
      defender: defenderData, policy: policyData, advisor: advisorData,
      activity: activityData, access: accessData, currency,
    }),
    [computeData, orphanedData, costData, defenderData, policyData, advisorData,
      activityData, accessData, currency],
  );

  const spend = useMemo(() => spendOverview(costData, rangeOpts), [costData, rangeOpts]);
  const byService = useMemo(() => serviceBreakdown(costData, 8, rangeOpts), [costData, rangeOpts]);
  const changes = useMemo(
    () => biggestChanges(costData, 8, {
      ...rangeOpts, from: compareFrom, to: compareTo, filter: changeFilter,
    }),
    [costData, rangeOpts, compareFrom, compareTo, changeFilter],
  );
  const anomalies = useMemo(() => anomalySummary(costData), [costData]);
  const inventory = useMemo(() => inventorySummary(services), [services]);
  const expensive = useMemo(() => topResources(services), [services]);
  const orphans = useMemo(() => orphanSummary(orphanedData), [orphanedData]);
  const advisor = useMemo(() => advisorSnapshot(advisorData), [advisorData]);
  const fleet = useMemo(() => computeSummary(computeData), [computeData]);
  const rgs = useMemo(
    () => resourceGroupSummary(rgData, services, 8, rangeOpts),
    [rgData, services, rangeOpts],
  );
  const governance = useMemo(
    () => governanceSnapshot({ services, policy: policyData }),
    [services, policyData],
  );
  const security = useMemo(
    () => securitySnapshot({
      defender: defenderData, policy: policyData, advisor: advisorData,
      access: accessData, roles: rolesData,
    }),
    [defenderData, policyData, advisorData, accessData, rolesData],
  );
  const recent = useMemo(() => recentChanges(activityData), [activityData]);
  const subs = useMemo(
    () => subscriptionHealth({
      subscriptions, selectedIds, costData, services, compute: computeData,
      orphaned: orphanedData, opts: rangeOpts,
    }),
    [subscriptions, selectedIds, costData, services, computeData, orphanedData, rangeOpts],
  );
  const results = useMemo(() => searchEstate(services, query), [services, query]);

  // Clicking a subscription row narrows the global selection, so every other
  // page follows. Nothing here filters locally — a second, page-local notion of
  // "selected" would drift out of step with the selector in the bar above.
  const focusSubscription = useCallback((id) => {
    setSelectedSubscriptionIds(selectedIds.length === 1 && selectedIds[0] === id
      ? subscriptions.map(s => s.subscription_id)
      : [id]);
  }, [setSelectedSubscriptionIds, selectedIds, subscriptions]);

  const stages = useMemo(() => refreshStages({
    subscriptions: { done: scoped },
    inventory: { loading: servicesLoading, error: servicesError, done: Array.isArray(services) && services.length > 0 },
    cost: { loading: costLoading, error: costError, done: Boolean(costData) },
    compute: { loading: computeLoading, error: computeError, done: Boolean(computeData) },
    orphaned: { loading: orphanedLoading, error: orphanedError, done: Boolean(orphanedData) },
    activity: { loading: activityLoading, error: activityError, done: Boolean(activityData) },
    security: {
      loading: postureLoading || accessLoading,
      error: postureError && accessError ? postureError : (postureError || accessError),
      done: Boolean(policyData || defenderData || advisorData || accessData || rolesData),
    },
  }), [scoped, services, servicesLoading, servicesError, costData, costLoading, costError,
    computeData, computeLoading, computeError, orphanedData, orphanedLoading, orphanedError,
    activityData, activityLoading, activityError, policyData, defenderData, advisorData,
    postureLoading, postureError, accessData, rolesData, accessLoading, accessError]);

  const busy = isRefreshing(stages);

  const money = useCallback((v, exact = false) => (
    typeof v === 'number' && Number.isFinite(v)
      ? (exact ? formatAmountFull(v, currency) : formatAmount(v, currency))
      : null
  ), [currency]);

  return (
    <div className="mx-auto max-w-screen-2xl space-y-5 p-4 sm:p-6">
      <Breadcrumb items={[{ label: 'Home', to: '/' }, { label: 'Estate Command Center' }]} />

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3.5">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-slate-800 bg-slate-900">
            <Gauge className="h-5 w-5 text-blue-400" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">
              Azure Estate Command Center
            </h1>
            <p className="mt-1 max-w-3xl text-sm leading-relaxed text-slate-400">
              Real-time overview of resources, cost, health, security and operational
              changes across your Azure estate.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={rangeValue}
            onChange={(e) => onRangeChange(e.target.value)}
            aria-label="Cost window"
            className="rounded-xl border border-slate-800 bg-slate-900 px-3 py-2.5 text-sm text-slate-200 focus:border-blue-500 focus:outline-none"
          >
            {RANGES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
            {rangeValue === 'custom' && <option value="custom">Custom range</option>}
          </select>
          <button
            type="button"
            onClick={() => run(true)}
            disabled={!scoped || busy}
            className="flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:opacity-60"
          >
            <RefreshCw className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} aria-hidden="true" />
            {busy ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      <div className="rounded-2xl border border-slate-800 bg-slate-900 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <RefreshProgress stages={stages} />
          <p className="font-mono text-[11px] text-slate-500">
            {lastUpdated
              ? `Last updated ${lastUpdated.toLocaleTimeString()}`
              : (busy ? 'Loading…' : 'Not loaded yet')}
          </p>
        </div>
      </div>

      <ScopeStrip />

      {imported && (
        <p className="rounded-2xl border border-amber-500/25 bg-amber-950/20 px-4 py-3 text-xs leading-relaxed text-amber-200">
          An uploaded usage file is active. A billing export lists charges, not what a
          resource is attached to or what its CPU did, so inventory, optimization,
          orphans, activity and security stay empty until you clear the import.
        </p>
      )}

      {/* ── 14. estate search ── */}
      <div className="relative">
        <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" aria-hidden="true" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search resources by name, type, resource group, region or SKU…"
          aria-label="Search the estate"
          className="w-full rounded-2xl border border-slate-800 bg-slate-900 py-3 pl-10 pr-4 text-sm text-slate-200 placeholder:text-slate-600 focus:border-blue-500 focus:outline-none"
        />
      </div>

      {results && (
        <Panel title={`Search — ${results.total.toLocaleString()} match${results.total === 1 ? '' : 'es'}`} icon={Search}>
          {!results.ready ? (
            <p className="py-4 text-center text-xs text-slate-500">
              The resource inventory has not loaded yet, so there is nothing to search.
            </p>
          ) : results.rows.length === 0 ? (
            <p className="py-4 text-center text-xs text-slate-500">
              Nothing in the selected subscriptions matches “{query}”.
            </p>
          ) : (
            <>
              <DataTable
                rowKey={(r, i) => `${r.name}-${i}`}
                rows={results.rows}
                columns={[
                  { key: 'name', header: 'Name', render: r => <span className="font-medium text-slate-200">{r.name}</span> },
                  { key: 'type', header: 'Type', render: r => <span className="font-mono text-[11px] text-slate-400">{shortType(r.type)}</span> },
                  { key: 'rg', header: 'Resource group', render: r => <span className="text-[11px] text-slate-400">{r.resource_group || <Muted>{NOT_AVAILABLE}</Muted>}</span> },
                  { key: 'region', header: 'Region', render: r => <span className="text-[11px] text-slate-400">{r.location || <Muted>{NOT_AVAILABLE}</Muted>}</span> },
                  { key: 'sub', header: 'Subscription', render: r => <span className="font-mono text-[10px] text-slate-500">{(r.subscription_id || '—').slice(0, 8)}…</span> },
                  { key: 'cost', header: 'Cost / month', align: 'right', render: r => <Figure value={money(r.cost, true)} fallback="Not billed" /> },
                ]}
              />
              {results.truncated && (
                <p className="mt-3 text-[11px] text-slate-500">
                  Showing the first {results.rows.length} of {results.total}. Narrow the search to see the rest.
                </p>
              )}
            </>
          )}
        </Panel>
      )}

      {/* ── 1. executive KPI strip ── */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {kpis.map(kpi => (
          <KpiCard
            key={kpi.key}
            label={kpi.label}
            value={kpi.value}
            hint={kpi.hint}
            loading={kpi.loading}
            to={kpi.to}
            tone={kpi.tone === 'high' ? 'warn' : (kpi.tone === 'good' ? 'good' : 'neutral')}
            hintTone={kpi.tone === 'high' ? 'warn' : (kpi.tone === 'good' ? 'good' : 'muted')}
          />
        ))}
      </div>

      {/* ── 3. what needs attention ── */}
      <Panel
        title="What needs attention"
        icon={AlertTriangle}
        action={(
          <span className="font-mono text-[11px] text-slate-500">
            {attention.total ? `${attention.total} finding${attention.total === 1 ? '' : 's'}` : ''}
          </span>
        )}
      >
        <SectionState
          loading={busy && attention.total === 0}
          empty={!busy && attention.total === 0}
          emptyText={
            computeData || orphanedData || costData
              ? 'Nothing was flagged by the sources that answered. Any source that did not answer is marked in the progress strip above.'
              : 'Nothing loaded yet.'
          }
          skeletonRows={5}
        />

        {attention.total > 0 && (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-2 border-b border-slate-800 pb-3">
              {['critical', 'high', 'medium', 'low'].map(level => (
                attention.bySeverity[level]
                  ? <Severity key={level} level={level}>{level} {attention.bySeverity[level]}</Severity>
                  : null
              ))}
              <span className="ml-auto font-mono text-[11px] text-slate-400">
                {attention.knownImpact !== null
                  ? `Known impact ${formatAmountFull(attention.knownImpact, currency)} / month`
                  : <Muted>No finding carries a known cost impact</Muted>}
                {attention.unpriced > 0 && (
                  <span className="ml-2 text-slate-600">· {attention.unpriced} unpriced</span>
                )}
              </span>
            </div>

            <ul>
              {attention.findings.map(f => <FindingRow key={f.key} finding={f} />)}
            </ul>

            {attention.total > attention.findings.length && (
              <p className="mt-3 text-[11px] text-slate-500">
                Showing the {attention.findings.length} most severe of {attention.total}.
              </p>
            )}
          </>
        )}
      </Panel>

      {/* ── 2. estate health ── */}
      <Panel
        title="Estate health"
        icon={Gauge}
        action={(
          <span className="font-mono text-[11px] text-slate-500">
            {typeof health.overall === 'number' ? `${health.overall} / 100` : INSUFFICIENT}
          </span>
        )}
      >
        <p className="mb-3 text-[11px] leading-relaxed text-slate-500">{health.basis}</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {health.categories.map(c => <HealthCategory key={c.key} category={c} />)}
        </div>
      </Panel>

      {/* ── 4 + 5. spend and services ── */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Panel
          title="Spend overview"
          icon={TrendingUp}
          action={<Link to="/explorer" className="flex items-center gap-1 font-mono text-xs text-blue-400 hover:text-blue-300">Cost Explorer <ArrowRight className="h-3.5 w-3.5" /></Link>}
        >
          <SectionState
            loading={costLoading && !costData}
            error={costError}
            onRetry={() => loadCosts({ force: true })}
            empty={!costLoading && !spend}
            emptyText="Cost Management returned no monthly data for this scope."
          />
          {spend && (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-wide text-slate-500">
                    {spend.periodMode ? 'Selected period' : 'Last complete month'}
                  </p>
                  <p className="mt-1 text-xl font-bold text-white"><Figure value={money(spend.current)} /></p>
                  <p className="text-[11px] text-slate-500">
                    {spend.periodMode
                      ? RANGES.find(r => r.value === rangeValue)?.label
                      : (spend.currentMonth || 'No complete month yet')}
                  </p>
                </div>
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-wide text-slate-500">Previous</p>
                  {spend.periodMode ? (
                    <p className="mt-1 text-sm font-semibold text-slate-500">Not comparable</p>
                  ) : (
                    <>
                      <p className="mt-1 text-xl font-bold text-slate-300"><Figure value={money(spend.previous)} /></p>
                      <p className="text-[11px] text-slate-500">{spend.previousMonth || 'No previous month'}</p>
                    </>
                  )}
                </div>
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-wide text-slate-500">Change</p>
                  {spend.periodMode ? (
                    <p className="mt-1 text-sm font-semibold text-slate-500">Not comparable</p>
                  ) : (
                    <>
                      <p className="mt-1 text-xl font-bold"><Delta pct={spend.changePct} /></p>
                      <p className="text-[11px] capitalize text-slate-500">{spend.direction}</p>
                    </>
                  )}
                </div>
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-wide text-slate-500">
                    {spend.monthToDateMonth ? 'This month to date' : 'Forecast'}
                  </p>
                  {spend.monthToDateMonth ? (
                    <>
                      <p className="mt-1 text-xl font-bold text-slate-300"><Figure value={money(spend.monthToDate)} /></p>
                      <p className="text-[11px] text-slate-500">{spend.monthToDateMonth} · partial</p>
                    </>
                  ) : (
                    <p className="mt-1 text-sm font-semibold text-slate-500">Not available</p>
                  )}
                </div>
              </div>

              <ul className="mt-4 space-y-1.5">
                {spend.series.slice(-6).map((point) => {
                  const max = Math.max(...spend.series.map(p => p.total || 0), 1);
                  const width = point.total ? (point.total / max) * 100 : 0;
                  return (
                    <li key={point.month} className="flex items-center gap-3">
                      <span className="w-16 shrink-0 font-mono text-[11px] text-slate-500">{point.month}</span>
                      <span className="h-2 flex-1 overflow-hidden rounded-full bg-slate-800">
                        <span className="block h-full rounded-full bg-blue-500" style={{ width: `${width}%` }} />
                      </span>
                      <span className="w-24 shrink-0 text-right font-mono text-[11px] tabular-nums text-slate-300">
                        <Figure value={money(point.total)} />
                      </span>
                    </li>
                  );
                })}
              </ul>

              <p className="mt-3 border-t border-slate-800 pt-2 text-[11px] leading-relaxed text-slate-500">
                {spend.forecastNote}
              </p>
              {spend.monthToDateNote && (
                <p className="mt-1 text-[11px] leading-relaxed text-slate-500">{spend.monthToDateNote}</p>
              )}
              {spend.periodNote && (
                <p className="mt-1 text-[11px] leading-relaxed text-slate-500">{spend.periodNote}</p>
              )}
              {spend.partial && (
                <p className="mt-1 text-[11px] leading-relaxed text-amber-300/80">
                  Some subscriptions did not answer, so these totals are a floor, not the whole bill.
                </p>
              )}
            </>
          )}
        </Panel>

        <Panel
          title="Cost by service"
          icon={Coins}
          action={<Link to="/explorer" className="flex items-center gap-1 font-mono text-xs text-blue-400 hover:text-blue-300">Break down <ArrowRight className="h-3.5 w-3.5" /></Link>}
        >
          <SectionState
            loading={costLoading && !costData}
            error={costError}
            onRetry={() => loadCosts({ force: true })}
            empty={!costLoading && (!byService || byService.rows.length === 0)}
            emptyText="No service-level cost was returned for this scope."
          />
          {byService && byService.rows.length > 0 && (
            <DataTable
              rowKey={r => r.name}
              rows={byService.rows}
              columns={[
                {
                  key: 'name',
                  header: byService.periodMode
                    ? `Service — ${RANGES.find(r => r.value === rangeValue)?.label || 'selected period'}`
                    : `Service — ${byService.month || ''}`,
                  render: r => <span className="font-medium text-slate-200">{r.name}</span>,
                },
                { key: 'cost', header: 'Cost', align: 'right', render: r => <span className="text-slate-200">{money(r.cost, true)}</span> },
                {
                  key: 'share',
                  header: 'Share',
                  align: 'right',
                  render: r => (typeof r.share === 'number'
                    ? <span className="font-mono text-[11px] text-slate-500">{r.share.toFixed(1)}%</span>
                    : <Muted>—</Muted>),
                },
                // A day window has no earlier equivalent period, so the column
                // is removed rather than filled with dashes or with a ratio of
                // seven days to a whole month.
                ...(byService.periodMode ? [] : [{
                  key: 'change',
                  header: 'Change',
                  align: 'right',
                  render: r => (r.isNew
                    ? <span className="font-mono text-[10px] text-sky-300">New</span>
                    : <Delta pct={r.changePct} />),
                }]),
              ]}
            />
          )}
        </Panel>
      </div>

      {/* ── 6. subscription health ── */}
      <Panel title="Subscription health" icon={Layers}>
        <SectionState
          loading={busy && !subs}
          empty={!subs}
          emptyText="Select at least one subscription in the bar above."
        />
        {subs && (
          <>
            <DataTable
              rowKey={r => r.subscriptionId}
              rows={subs.rows}
              columns={[
                {
                  key: 'name',
                  header: 'Subscription',
                  render: r => (
                    <button
                      type="button"
                      onClick={() => focusSubscription(r.subscriptionId)}
                      className="min-w-0 text-left transition hover:text-blue-300"
                      title={selectedIds.length === 1 && selectedIds[0] === r.subscriptionId
                        ? 'Restore the full subscription selection'
                        : 'Narrow the whole estate to this subscription'}
                    >
                      <p className="truncate font-medium text-slate-200">{r.name}</p>
                      <p className="truncate font-mono text-[10px] text-slate-600">{r.subscriptionId}</p>
                    </button>
                  ),
                },
                { key: 'resources', header: 'Resources', align: 'right', render: r => <Figure value={r.resources?.toLocaleString()} fallback="—" className="text-slate-300" /> },
                { key: 'cost', header: 'Cost / month', align: 'right', render: r => <Figure value={money(r.cost, true)} fallback="—" className="text-slate-200" /> },
                { key: 'change', header: 'Change', align: 'right', render: r => <Delta pct={r.changePct} /> },
                { key: 'running', header: 'Running VMs', align: 'right', render: r => <Figure value={r.running?.toLocaleString()} fallback="—" className="text-slate-300" /> },
                { key: 'issues', header: 'Issues', align: 'right', render: r => <Figure value={r.issues?.toLocaleString()} fallback="—" className={r.issues ? 'text-amber-300' : 'text-slate-400'} /> },
                {
                  key: 'health',
                  header: 'Health',
                  align: 'right',
                  render: r => (
                    <Severity level={r.health === 'good' ? 'good' : (r.health === 'poor' ? 'high' : (r.health === 'fair' ? 'medium' : 'neutral'))}>
                      {r.health}
                    </Severity>
                  ),
                },
              ]}
            />
            {(!subs.haveInventory || !subs.haveCompute || !subs.haveOrphans) && (
              <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
                Dashes mark a column whose dataset has not been read for this scope. They are
                not zeros — a subscription is never graded on data nobody fetched.
              </p>
            )}
            <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
              Selecting a subscription name narrows the global selection, so every other page
              follows. Select it again to restore the full set.
            </p>
          </>
        )}
      </Panel>

      {/* ── compute summary + cost anomalies ── */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Panel
          title="Compute summary"
          icon={Server}
          action={<Link to="/compute" className="flex items-center gap-1 font-mono text-xs text-blue-400 hover:text-blue-300">Compute Intelligence <ArrowRight className="h-3.5 w-3.5" /></Link>}
        >
          <SectionState
            loading={computeLoading && !fleet}
            error={computeError}
            onRetry={() => loadCompute({ force: true })}
            notLoadedText={!computeLoading && !computeError && !fleet
              ? 'Compute Intelligence has not been read for this scope.' : undefined}
          />
          {fleet && (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {[
                  { label: 'Running', value: fleet.running, tone: 'text-white' },
                  { label: 'Deallocated', value: fleet.deallocated, tone: 'text-slate-300' },
                  { label: 'Oversized', value: fleet.oversized, tone: 'text-amber-300' },
                  { label: 'Idle', value: fleet.idle, tone: 'text-amber-300' },
                  { label: 'No telemetry', value: fleet.telemetryUnavailable, tone: 'text-slate-300' },
                  { label: 'Opportunities', value: fleet.opportunities, tone: 'text-blue-300' },
                ].map(item => (
                  <div key={item.label}>
                    <p className="font-mono text-[10px] uppercase tracking-wide text-slate-500">{item.label}</p>
                    <p className={`mt-1 text-xl font-bold ${item.tone}`}>
                      <Figure value={item.value?.toLocaleString()} />
                    </p>
                  </div>
                ))}
              </div>
              <p className="mt-3 border-t border-slate-800 pt-2 text-[11px] leading-relaxed text-slate-400">
                {fleet.confidentMonthly === null
                  // Verbatim from Compute Intelligence. Never a fabricated ₹0.
                  ? fleet.noOpportunityNote
                  : `High-confidence opportunity: ${money(fleet.confidentMonthly, true)} / month${
                    fleet.confidentAnnual === null ? '' : ` · ${money(fleet.confidentAnnual, true)} / year`}.`}
              </p>
              {fleet.telemetryUnavailable > 0 && (
                <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
                  {fleet.telemetryUnavailable} machine(s) published no usable CPU telemetry and are
                  reported as unmeasured rather than as healthy.
                </p>
              )}
            </>
          )}
        </Panel>

        <Panel
          title="Cost anomalies"
          icon={TrendingUp}
          action={<Link to="/anomalies" className="flex items-center gap-1 font-mono text-xs text-blue-400 hover:text-blue-300">Anomalies <ArrowRight className="h-3.5 w-3.5" /></Link>}
        >
          <SectionState
            loading={costLoading && !anomalies}
            error={costError}
            onRetry={() => loadCosts({ force: true })}
            notLoadedText={!costLoading && !costError && !anomalies
              ? 'Cost Management has not been read for this scope.' : undefined}
            empty={Boolean(anomalies) && anomalies.total === 0}
            emptyText="No service moved far enough month over month to be flagged."
          />
          {anomalies && anomalies.total > 0 && (
            <>
              <div className="flex flex-wrap gap-2">
                {['critical', 'high', 'medium', 'low'].map(level => (
                  anomalies.counts[level] > 0 && (
                    <Severity key={level} level={level}>{level} {anomalies.counts[level]}</Severity>
                  )
                ))}
              </div>
              <ul className="mt-3 space-y-2">
                {anomalies.rows.map(row => (
                  <li key={row.key} className="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="truncate text-sm font-medium text-slate-200">{row.service}</p>
                      <Delta pct={row.changePct} tone="cost" />
                    </div>
                    <p className="mt-1 font-mono text-[11px] text-slate-500">
                      {row.previousMonth} → {row.month} ·{' '}
                      <Figure value={money(row.previous, true)} /> → <Figure value={money(row.current, true)} />
                    </p>
                    {row.reason && (
                      <p className="mt-1 text-[11px] leading-relaxed text-slate-500">{row.reason}</p>
                    )}
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
                Severity weighs the rupee amount that moved as well as the percentage, so a small
                meter that tripled does not outrank a large service that rose a quarter.
              </p>
            </>
          )}
        </Panel>
      </div>

      {/* ── Azure Advisor + resource groups ── */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Panel
          title="Azure Advisor"
          icon={Lightbulb}
          action={<Link to="/advisor" className="flex items-center gap-1 font-mono text-xs text-blue-400 hover:text-blue-300">All recommendations <ArrowRight className="h-3.5 w-3.5" /></Link>}
        >
          <SectionState
            loading={postureLoading && !advisor}
            error={postureError}
            onRetry={() => loadPosture({ force: true })}
            notLoadedText={!postureLoading && !postureError && !advisor
              ? 'Advisor has not been read for this scope.' : undefined}
            empty={Boolean(advisor) && advisor.total === 0}
            emptyText="Advisor returned no recommendations for the subscriptions that answered."
          />
          {advisor && advisor.total > 0 && (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-wide text-slate-500">Total</p>
                  <p className="mt-1 text-xl font-bold text-white">{advisor.total.toLocaleString()}</p>
                </div>
                {['critical', 'high', 'medium', 'low'].map(level => (
                  <div key={level}>
                    <p className="font-mono text-[10px] uppercase tracking-wide text-slate-500">{level}</p>
                    <p className="mt-1 text-xl font-bold text-slate-300">{advisor.counts[level].toLocaleString()}</p>
                  </div>
                ))}
              </div>

              <div className="mt-3 flex flex-wrap gap-1.5">
                {advisor.categories.map(cat => (
                  <span key={cat.name} className="rounded-lg border border-slate-800 bg-slate-900/60 px-2 py-1 text-[11px] text-slate-400">
                    {cat.name} <span className="font-mono text-slate-300">{cat.count}</span>
                  </span>
                ))}
              </div>

              <p className="mt-3 border-t border-slate-800 pt-2 text-[11px] leading-relaxed text-slate-400">
                {advisor.annualSaving === null
                  // Advisor prices Cost recommendations only. Nothing is inferred.
                  ? 'Azure Advisor published no savings figure for any of these recommendations.'
                  : `Advisor projects ${formatAmountFull(advisor.annualSaving, advisor.savingCurrency || currency)} per year across ${advisor.priced} priced recommendation(s).`}
              </p>
              {advisor.unpriced > 0 && advisor.annualSaving !== null && (
                <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
                  The remaining {advisor.unpriced} carry no savings figure from Azure and are excluded
                  from that total rather than counted as zero.
                </p>
              )}
            </>
          )}
        </Panel>

        <Panel
          title="Top resource groups"
          icon={FolderTree}
          action={<Link to="/resource-groups" className="flex items-center gap-1 font-mono text-xs text-blue-400 hover:text-blue-300">Resource Groups <ArrowRight className="h-3.5 w-3.5" /></Link>}
        >
          <SectionState
            loading={rgLoading && !rgs}
            error={rgError}
            onRetry={() => loadRgCosts({ force: true })}
            notLoadedText={!rgLoading && !rgError && !rgs
              ? 'Resource group costs have not been read for this scope.' : undefined}
            empty={Boolean(rgs) && rgs.rows.length === 0}
            emptyText="Cost Management attributed no charge to a resource group in this window."
          />
          {rgs && rgs.rows.length > 0 && (
            <>
              <DataTable
                rowKey={r => r.name}
                rows={rgs.rows}
                columns={[
                  { key: 'name', header: 'Resource group', render: r => <span className="truncate font-medium text-slate-200">{r.name}</span> },
                  { key: 'resources', header: 'Resources', align: 'right', render: r => <Figure value={r.resources?.toLocaleString()} fallback="—" className="text-slate-300" /> },
                  { key: 'month', header: 'Month', align: 'right', render: r => <Figure value={r.month} fallback="—" className="font-mono text-[11px] text-slate-500" /> },
                  { key: 'cost', header: 'Cost', align: 'right', render: r => <Figure value={money(r.current, true)} className="text-slate-200" /> },
                  { key: 'change', header: 'Change', align: 'right', render: r => <Delta pct={r.changePct} tone="cost" /> },
                ]}
              />
              <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
                Cost and change are both taken from the last complete month this endpoint
                returned, so they are comparable. A group with only one complete month shows a
                dash rather than a percentage — the running month is never used as a comparison.
              </p>
            </>
          )}
        </Panel>
      </div>

      {/* ── 7 + 10. inventory and orphans ── */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Panel title="Resource inventory" icon={Boxes}>
          <SectionState
            loading={servicesLoading && !inventory}
            error={servicesError}
            onRetry={() => loadServices({ force: true })}
            empty={!servicesLoading && (!inventory || inventory.categories.length === 0)}
            emptyText="Resource Graph returned no resources for this scope."
          />
          {inventory && inventory.categories.length > 0 && (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {inventory.categories.map(cat => (
                <Link
                  key={cat.key}
                  to={CATEGORY_ROUTE[cat.key] || '/resource-groups'}
                  className="group rounded-xl border border-slate-800 bg-slate-900/60 p-3 transition hover:border-blue-500/30 hover:bg-slate-800/50"
                >
                  <p className="font-mono text-[10px] uppercase tracking-wide text-slate-500">{cat.title}</p>
                  <p className="mt-1 text-xl font-bold text-white">{cat.count.toLocaleString()}</p>
                  <p className="mt-0.5 font-mono text-[11px] text-slate-500">
                    {cat.cost === null
                      ? <Muted>Not billed</Muted>
                      : `${formatAmount(cat.cost, currency)} · ${cat.priced}/${cat.count} priced`}
                  </p>
                </Link>
              ))}
            </div>
          )}
        </Panel>

        <Panel
          title="Orphaned resources"
          icon={Unlink}
          action={<Link to="/orphaned" className="flex items-center gap-1 font-mono text-xs text-blue-400 hover:text-blue-300">Review <ArrowRight className="h-3.5 w-3.5" /></Link>}
        >
          <SectionState
            loading={orphanedLoading && !orphans}
            error={orphanedError}
            onRetry={() => loadOrphaned({ force: true })}
            empty={!orphanedLoading && !orphans}
            emptyText="The orphaned sweep has not run for this scope."
          />
          {orphans && (
            <>
              <div className="grid grid-cols-3 gap-3 border-b border-slate-800 pb-3">
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-wide text-slate-500">Found</p>
                  <p className="mt-1 text-xl font-bold text-white"><Figure value={orphans.count?.toLocaleString()} /></p>
                </div>
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-wide text-slate-500">Per month</p>
                  <p className="mt-1 text-xl font-bold text-amber-300"><Figure value={money(orphans.monthly, true)} /></p>
                </div>
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-wide text-slate-500">Annualised</p>
                  <p className="mt-1 text-xl font-bold text-amber-300/80"><Figure value={money(orphans.annual)} /></p>
                </div>
              </div>

              {orphans.categories.length === 0 ? (
                <p className="py-4 text-center text-xs text-slate-500">Nothing unattached was found.</p>
              ) : (
                <ul className="mt-3 space-y-1.5">
                  {orphans.categories.map(c => (
                    <li key={c.key} className="flex items-center justify-between gap-3 text-sm">
                      <span className="flex min-w-0 items-center gap-2">
                        <Severity level={c.severity === 'certain' ? 'medium' : 'low'}>{c.severity}</Severity>
                        <span className="truncate text-slate-300">{c.title}</span>
                      </span>
                      <span className="shrink-0 font-mono text-[11px] tabular-nums text-slate-400">
                        {c.count} · <Figure value={money(c.monthly, true)} fallback="not priced" />
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              <p className="mt-3 border-t border-slate-800 pt-2 text-[11px] leading-relaxed text-slate-500">
                Annualised is twelve times the monthly figure, not a forecast.
                {orphans.partial ? ' Some subscriptions did not answer, so this is a floor.' : ''}
              </p>
            </>
          )}
        </Panel>
      </div>

      {/* ── 8 + 9. expensive resources and cost movement ── */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Panel title="Most expensive resources" icon={Wallet}>
          <SectionState
            loading={servicesLoading && !expensive}
            error={servicesError}
            onRetry={() => loadServices({ force: true })}
            empty={!servicesLoading && (!expensive || expensive.rows.length === 0)}
            emptyText="Cost Management reported no billed resources for this scope."
          />
          {expensive && expensive.rows.length > 0 && (
            <>
              <DataTable
                rowKey={(r, i) => `${r.name}-${i}`}
                rows={expensive.rows}
                columns={[
                  {
                    key: 'name',
                    header: 'Resource',
                    render: r => (
                      <div className="min-w-0">
                        <p className="truncate font-medium text-slate-200">{r.name}</p>
                        <p className="truncate font-mono text-[10px] text-slate-500">
                          {shortType(r.type)} · {r.resource_group || '—'}
                        </p>
                      </div>
                    ),
                  },
                  { key: 'region', header: 'Region', render: r => <span className="text-[11px] text-slate-400">{r.location || <Muted>{NOT_AVAILABLE}</Muted>}</span> },
                  { key: 'cost', header: 'Cost / month', align: 'right', render: r => <span className="text-slate-200">{money(r.cost, true)}</span> },
                ]}
              />
              {expensive.unpriced > 0 && (
                <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
                  {expensive.unpriced} of {expensive.unpriced + expensive.priced} resources carry no
                  Cost Management charge. They are excluded from this ranking rather than listed as free.
                </p>
              )}
            </>
          )}
        </Panel>

        <Panel
          title="Biggest cost changes"
          icon={TrendingUp}
          action={changes && !changes.periodMode && changes.months.length > 1 && (
            <div className="flex items-center gap-1.5">
              <select
                value={changes.from || ''}
                onChange={(e) => setCompareFrom(e.target.value)}
                aria-label="Compare from month"
                className="rounded-lg border border-slate-800 bg-slate-900 px-2 py-1 font-mono text-[11px] text-slate-300 focus:border-blue-500 focus:outline-none"
              >
                <option value="">No comparison</option>
                {changes.months.filter(m => m !== changes.to).map(m => (
                  <option key={m} value={m}>
                    {m}{changes.completeMonths.includes(m) ? '' : ' (partial)'}
                  </option>
                ))}
              </select>
              <ArrowRight className="h-3 w-3 shrink-0 text-slate-600" aria-hidden="true" />
              <select
                value={changes.to || ''}
                onChange={(e) => setCompareTo(e.target.value || null)}
                aria-label="Compare to month"
                className="rounded-lg border border-slate-800 bg-slate-900 px-2 py-1 font-mono text-[11px] text-slate-300 focus:border-blue-500 focus:outline-none"
              >
                {changes.months.map(m => (
                  <option key={m} value={m}>
                    {m}{changes.completeMonths.includes(m) ? '' : ' (partial)'}
                  </option>
                ))}
              </select>
            </div>
          )}
        >
          <SectionState
            loading={costLoading && !changes}
            error={costError}
            onRetry={() => loadCosts({ force: true })}
            empty={!costLoading && (!changes || changes.rows.length === 0)}
            emptyText={
              // Three different empty reasons, and they are not interchangeable.
              !changes
                ? 'Cost Management returned no monthly data for this scope.'
                : (changes.mode === 'compare' && changes.counted > 0
                  ? `No service matches this filter. ${changes.counted} service(s) moved between ${changes.from} and ${changes.to}.`
                  : (changes.mode === 'compare'
                    ? `Nothing moved between ${changes.from} and ${changes.to}.`
                    : 'Cost Management attributed no service spend to this period.'))
            }
          />

          {changes && changes.mode === 'compare' && (
            <div className="mb-3 flex flex-wrap gap-1.5">
              {CHANGE_FILTERS.map(f => (
                <button
                  key={f.value}
                  type="button"
                  onClick={() => setChangeFilter(f.value)}
                  className={`rounded-lg border px-2 py-1 font-mono text-[11px] transition ${
                    changeFilter === f.value
                      ? 'border-blue-500/40 bg-blue-500/10 text-blue-300'
                      : 'border-slate-800 bg-slate-900/60 text-slate-400 hover:border-slate-700'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          )}

          {changes && changes.rows.length > 0 && changes.mode === 'compare' && (
            <DataTable
              rowKey={r => r.name}
              rows={changes.rows}
              columns={[
                { key: 'name', header: `${changes.from} → ${changes.to}`, render: r => <span className="font-medium text-slate-200">{r.name}</span> },
                { key: 'previous', header: 'Previous', align: 'right', render: r => <Figure value={money(r.previous, true)} fallback="none" className="text-slate-400" /> },
                { key: 'current', header: 'Current', align: 'right', render: r => <Figure value={money(r.current, true)} fallback="none" className="text-slate-200" /> },
                {
                  key: 'delta',
                  header: 'Change',
                  align: 'right',
                  render: r => (
                    <span className={r.delta > 0 ? 'text-rose-300' : 'text-emerald-300'}>
                      {r.delta > 0 ? '+' : ''}{formatAmountFull(r.delta, currency)}
                    </span>
                  ),
                },
                {
                  key: 'pct',
                  header: '%',
                  align: 'right',
                  render: r => (r.appeared
                    ? <span className="font-mono text-[10px] text-sky-300">New</span>
                    : (r.disappeared
                      ? <span className="font-mono text-[10px] text-slate-500">Stopped</span>
                      : <Delta pct={r.changePct} />)),
                },
              ]}
            />
          )}

          {/* Only one month exists — a new subscription, or a one-month window.
              The month is reported on its own rather than leaving a blank panel
              that reads as a failure. No change column is invented for it. */}
          {changes && changes.rows.length > 0 && changes.mode === 'single' && (
            <DataTable
              rowKey={r => r.name}
              rows={changes.rows}
              columns={[
                {
                  key: 'name',
                  header: changes.periodMode
                    ? `Service — ${RANGES.find(r => r.value === rangeValue)?.label || 'selected period'}`
                    : `Service — ${changes.to}`,
                  render: r => <span className="font-medium text-slate-200">{r.name}</span>,
                },
                { key: 'current', header: 'Cost', align: 'right', render: r => <Figure value={money(r.current, true)} className="text-slate-200" /> },
              ]}
            />
          )}

          {changes && changes.mode === 'single' && changes.rows.length > 0 && (
            <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
              {changes.periodMode
                ? 'A day window is a single period, so there is no earlier period of equal length to compare it against. Choose a month range in the header to compare months.'
                : changes.months.length > 1
                  ? `Showing ${changes.to} on its own. Pick a month on the left to compare it against.`
                  : `Only ${changes.to} was billed in this scope, so there is nothing to compare it against yet — this is what a new subscription looks like, not a failed read.`}
              {changes.partialMonth && ' That month is still running, so its total is a month-to-date figure.'}
            </p>
          )}

          {changes && changes.mode === 'compare' && changes.rows.length > 0 && (
            <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
              Ordered by the amount the bill moved, not by percentage — a meter that went from
              ₹2 to ₹6 is not a bigger event than one that went from ₹40,000 to ₹55,000.
              Showing {changes.rows.length} of {changes.matched} matching change(s).
              {changes.partialMonth && ` ${changes.to} is still running, so it is a partial month.`}
            </p>
          )}
        </Panel>
      </div>

      {/* ── 11. recent changes ── */}
      <Panel
        title="Recent Azure changes"
        icon={Activity}
        action={<Link to="/activity" className="flex items-center gap-1 font-mono text-xs text-blue-400 hover:text-blue-300">Activity Explorer <ArrowRight className="h-3.5 w-3.5" /></Link>}
      >
        <SectionState
          loading={activityLoading && !recent}
          error={activityError}
          onRetry={() => loadActivity({ force: true })}
          empty={!activityLoading && (!recent || recent.rows.length === 0)}
          emptyText="No control-plane operations were recorded in this window."
        />
        {recent && recent.rows.length > 0 && (
          <>
            <DataTable
              rowKey={(r, i) => r.id || i}
              rows={recent.rows}
              columns={[
                { key: 'caller', header: 'Who', render: r => <span className="truncate font-mono text-[11px] text-slate-300">{r.caller || 'Unknown'}</span> },
                { key: 'op', header: 'Operation', render: r => <span className="text-slate-200">{r.summary || r.operation || '—'}</span> },
                { key: 'resource', header: 'Resource', render: r => <span className="truncate font-mono text-[11px] text-slate-400" title={r.resource_id}>{r.resource_id ? r.resource_id.split('/').pop() : '—'}</span> },
                { key: 'sub', header: 'Subscription', render: r => <span className="font-mono text-[10px] text-slate-500">{(r.subscription_id || '—').slice(0, 8)}…</span> },
                { key: 'at', header: 'When', render: r => <span className="font-mono text-[11px] text-slate-500">{r.at ? new Date(r.at).toLocaleString() : '—'}</span> },
                { key: 'status', header: 'Status', align: 'right', render: r => <Severity level={r.succeeded ? 'good' : 'high'}>{r.status || (r.succeeded ? 'ok' : 'failed')}</Severity> },
              ]}
            />
            <p className="mt-3 text-[11px] text-slate-500">
              {recent.total.toLocaleString()} operation{recent.total === 1 ? '' : 's'}
              {recent.windowDays ? ` in the last ${recent.windowDays} days` : ''}
              {recent.failed !== null ? ` · ${recent.failed} failed` : ''}.
              Azure retains the Activity Log for about 90 days.
            </p>
          </>
        )}
      </Panel>

      {/* ── 12 + 13. governance and security ── */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Panel
          title="Governance snapshot"
          icon={ShieldCheck}
          action={<Link to="/policy" className="flex items-center gap-1 font-mono text-xs text-blue-400 hover:text-blue-300">Policy <ArrowRight className="h-3.5 w-3.5" /></Link>}
        >
          <SectionState
            loading={postureLoading && !governance}
            empty={!postureLoading && !governance}
            emptyText="Neither the tagged inventory nor Azure Policy has been read for this scope."
          />
          {governance && (
            <>
              {governance.tags ? (
                <ul className="space-y-2.5">
                  {governance.tags.map(t => (
                    <li key={t.key}>
                      <div className="flex items-baseline justify-between gap-2 text-sm">
                        <span className="text-slate-300">{t.label} tag</span>
                        <span className="font-mono text-[11px] tabular-nums text-slate-400">
                          {t.present}/{governance.total} · {t.coverage.toFixed(0)}%
                        </span>
                      </div>
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-800">
                        <div className="h-full rounded-full bg-blue-500" style={{ width: `${t.coverage}%` }} />
                      </div>
                      <p className="mt-0.5 text-[11px] text-slate-500">
                        {t.missing} resource{t.missing === 1 ? '' : 's'} missing this tag.
                      </p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-slate-500">
                  The resource inventory has not loaded, so tag coverage cannot be measured.
                </p>
              )}

              <div className="mt-4 border-t border-slate-800 pt-3">
                <p className="font-mono text-[10px] uppercase tracking-wide text-slate-500">Azure Policy</p>
                {governance.compliance ? (
                  <p className="mt-1 text-sm text-slate-300">
                    <span className="text-lg font-bold text-white">{governance.compliance.rate}%</span> compliant
                    <span className="ml-2 font-mono text-[11px] text-slate-500">
                      {governance.compliance.compliant} of {governance.compliance.evaluated} evaluations
                      {' · '}{governance.compliance.nonCompliant} non-compliant
                      {' · '}{governance.compliance.unenforced} unenforced assignment(s)
                    </span>
                  </p>
                ) : (
                  <p className="mt-1 text-xs text-slate-500">
                    {governance.complianceState === 'not_evaluated'
                      ? 'Azure Policy returned no evaluations for this scope. That is not the same as compliant.'
                      : 'Not loaded.'}
                  </p>
                )}
                <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
                  An untagged resource is a governance gap, not a policy violation — Azure Policy
                  may have no rule about tags at all — so the two are reported separately.
                </p>
              </div>
            </>
          )}
        </Panel>

        <Panel
          title="Security snapshot"
          icon={Shield}
          action={<Link to="/security" className="flex items-center gap-1 font-mono text-xs text-blue-400 hover:text-blue-300">Security <ArrowRight className="h-3.5 w-3.5" /></Link>}
        >
          <SectionState
            loading={(postureLoading || accessLoading) && security.loadedCount === 0 && security.rbac.state !== 'loaded'}
            error={postureError}
            onRetry={() => loadPosture({ force: true })}
          />
          <div className="space-y-2">
            {security.sources.map(source => (
              <Link
                key={source.key}
                to={source.to}
                className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900/60 p-3 transition hover:border-blue-500/30 hover:bg-slate-800/50"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-200">{source.title}</p>
                  <p className="mt-0.5 text-[11px] text-slate-500">
                    {source.state !== 'loaded'
                      ? 'Not loaded'
                      // RBAC sources carry no severity counts by design, so the
                      // absence of counts is not evidence they returned nothing.
                      : (source.extra
                        || (source.counts ? `${source.counts.total ?? 0} findings` : 'Returned nothing it could classify'))}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {source.state !== 'loaded' && <Severity level="neutral">no data</Severity>}
                  {source.state === 'loaded' && source.counts && (
                    <>
                      {source.counts.critical > 0 && <Severity level="critical">{source.counts.critical}</Severity>}
                      {source.counts.high > 0 && <Severity level="high">{source.counts.high}</Severity>}
                      {source.counts.medium > 0 && <Severity level="medium">{source.counts.medium}</Severity>}
                      {!source.counts.critical && !source.counts.high && !source.counts.medium && (
                        <Severity level="good">clear</Severity>
                      )}
                    </>
                  )}
                  {/* RBAC sources are graded on their own axis: a broad grant is
                      a candidate for review, not an open vulnerability, so it is
                      never folded into the severity totals above. */}
                  {source.state === 'loaded' && !source.counts && source.rbac && (
                    <>
                      {source.rbac.critical > 0 && <Severity level="high">{source.rbac.critical} owner</Severity>}
                      {source.rbac.high > 0 && <Severity level="high">{source.rbac.high} high</Severity>}
                      {isNumLike(source.rbac.principals) && <Severity level="info">{source.rbac.principals} principals</Severity>}
                      {!source.rbac.critical && !source.rbac.high && !isNumLike(source.rbac.principals) && (
                        <Severity level="neutral">reviewed</Severity>
                      )}
                    </>
                  )}
                  {source.state === 'loaded' && !source.counts && !source.rbac && (
                    <Severity level="neutral">no data</Severity>
                  )}
                </div>
              </Link>
            ))}
          </div>
          <p className="mt-3 border-t border-slate-800 pt-2 text-[11px] leading-relaxed text-slate-500">
            Defender for Cloud is a paid tier. A subscription that was never scanned reports
            nothing, and “nothing” is shown here as no data — never as a clean result.
          </p>
          {security.rbac.state === 'loaded' && (
            <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
              {security.rbac.principals === null
                ? 'Role assignments have not been read for this scope.'
                : `${security.rbac.principals.toLocaleString()} principal(s) hold access${
                  security.rbac.ownerLevel === null ? '' : `, ${security.rbac.ownerLevel} of them at owner level`}.`}
              {security.rbac.accessFindings !== null
                && ` Access review flagged ${security.rbac.accessFindings} grant(s)${
                  security.rbac.accessHigh ? `, ${security.rbac.accessHigh} high severity` : ''}.`}
              {' '}These are excluded from the severity totals above: a broad grant is a candidate
              for review, not a confirmed vulnerability.
            </p>
          )}
          {accessError && security.rbac.state !== 'loaded' && (
            <p className="mt-1 text-[11px] leading-relaxed text-slate-500">{accessError}</p>
          )}
        </Panel>
      </div>

      {/* ── 15. quick actions ── */}
      <Panel title="Quick actions" icon={ArrowRight}>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {QUICK_ACTIONS.map((action) => {
            const Icon = action.icon;
            return (
              <Link
                key={action.to}
                to={action.to}
                className="group flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-2.5 text-xs font-medium text-slate-300 transition hover:border-blue-500/30 hover:bg-slate-800/50 hover:text-white"
              >
                <Icon className="h-4 w-4 shrink-0 text-slate-500 transition group-hover:text-blue-400" aria-hidden="true" />
                <span className="truncate">{action.label}</span>
              </Link>
            );
          })}
        </div>
      </Panel>
    </div>
  );
}
