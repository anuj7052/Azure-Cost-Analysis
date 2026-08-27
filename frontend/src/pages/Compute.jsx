import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, Cpu, Gauge, Play, PowerOff, RefreshCw, Server, TrendingDown, Wallet,
} from 'lucide-react';
import { fetchResizeHistory } from '../api/client';
import ResizeModal from '../components/Compute/ResizeModal';
import { useAppStore } from '../store/useAppStore';
import { formatAmount, formatAmountFull } from '../utils/currency';
import { actionLabel, isResizable, isReviewable } from '../utils/resize';
import {
  Badge, Button, Callout, ChipFilter, DataTable, EmptyState, ErrorState,
  Metric, NoPermissionState, Panel, Status, TableSkeleton,
} from '../components/ui';

/**
 * Compute Intelligence — the VM fleet, judged.
 *
 * The page exists to answer one question per machine: is this the right size?
 * Everything on it is evidence for that answer, which is why every row can be
 * expanded to the sentence that produced its verdict. A recommendation a cloud
 * engineer cannot defend in a change review is a recommendation they will not
 * act on.
 *
 * One action on this page does mutate Azure: the resize. It is deliberately
 * two clicks away from the table — "Review Resize" opens a read-only preview,
 * and only an explicit acknowledgement inside that modal starts anything. A
 * row is offered the button only when the server recommended a specific target
 * size with HIGH confidence; a MEDIUM verdict is worth reading, not worth
 * stopping a production machine for on one click.
 *
 * Telemetry confidence and infrastructure availability are kept apart. Quota
 * being free says nothing about whether we measured the VM long enough to know
 * it is oversized, and merging the two would let an empty region talk us into
 * a resize.
 */

const VERDICT_TONE = {
  stopped_but_billed: 'critical',
  idle: 'high',
  underutilized: 'medium',
  overutilized: 'medium',
  deallocated: 'neutral',
  right_sized: 'good',
  insufficient_data: 'neutral',
};

const ACTION_LABEL = {
  deallocate: 'Deallocate',
  review_for_deletion: 'Review for deletion',
  resize: 'Resize',
  investigate: 'Investigate',
  review: 'Review',
  none: '—',
};

const FILTERS = [
  { value: 'stopped_but_billed', label: 'Stopped but billing', tone: 'critical' },
  { value: 'idle', label: 'Idle', tone: 'high' },
  { value: 'underutilized', label: 'Oversized', tone: 'medium' },
  { value: 'overutilized', label: 'Under pressure', tone: 'medium' },
  { value: 'deallocated', label: 'Deallocated', tone: 'neutral' },
  { value: 'right_sized', label: 'Right-sized', tone: 'good' },
  { value: 'insufficient_data', label: 'No telemetry', tone: 'neutral' },
];

const POWER_TONE = {
  running: 'good',
  deallocated: 'neutral',
  stopped: 'critical',
  unknown: 'neutral',
};

/**
 * Why a number is missing, in one short phrase.
 *
 * A dash in a CPU column is ambiguous: it could mean the machine is off, that
 * the account cannot read metrics, that Azure was throttling, or that this
 * resource simply does not publish the metric. The backend distinguishes all
 * of those, so the table must not flatten them back into one blank cell.
 *
 * These keys are the backend's telemetry status enum verbatim. Never invent a
 * phrase here that the backend cannot justify — "Not supported" was removed
 * precisely because it described a limitation of this app rather than a fact
 * about the resource.
 */
const TELEMETRY_SHORT = {
  VALID: '',
  PARTIAL_DATA: 'Partial telemetry',
  INSUFFICIENT_DATA: 'Insufficient data',
  // "Published · No data" and "Not published" are deliberately different
  // sentences. One says Azure offers the metric and the window came back
  // empty; the other says the metric does not exist for this machine. They
  // call for different actions and must never share a label.
  NO_DATA: 'Published · No data',
  NO_METRIC: 'Not published',
  NO_ACCESS: 'Access denied',
  THROTTLED: 'Throttled',
  API_ERROR: 'Query error',
  NOT_RUNNING: 'Not running',
};

const TELEMETRY_TONE = {
  VALID: 'good',
  PARTIAL_DATA: 'medium',
  INSUFFICIENT_DATA: 'medium',
  NO_DATA: 'neutral',
  NO_METRIC: 'medium',
  NO_ACCESS: 'high',
  THROTTLED: 'medium',
  API_ERROR: 'high',
  NOT_RUNNING: 'neutral',
};

const OPERATIONAL_TONE = {
  RUNNING: 'good',
  DEALLOCATED: 'neutral',
  STOPPED: 'critical',
  UNKNOWN: 'neutral',
};

const RIGHTSIZING_TONE = {
  OVERSIZED: 'medium',
  UNDERSIZED: 'medium',
  RIGHT_SIZED: 'good',
  IDLE: 'high',
  DEALLOCATE: 'critical',
  CANNOT_DETERMINE: 'neutral',
  NOT_APPLICABLE: 'neutral',
};

const CONFIDENCE_TONE = {
  HIGH: 'good',
  MEDIUM: 'medium',
  LOW: 'neutral',
  NONE: 'neutral',
};

/** A percentage that knows the difference between zero and unmeasured. */
function Pct({ value, telemetry }) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return <span className="tabular-nums">{value.toFixed(1)}%</span>;
  }
  const why = TELEMETRY_SHORT[telemetry?.status];
  if (!why) return <span className="text-slate-600">—</span>;
  return <span className="text-[11px] text-slate-500" title={telemetry?.reason || why}>{why}</span>;
}

/** A titled group of label/value pairs in the detail panel. */
function Section({ title, children }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-3">
      <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{title}</p>
      <dl className="mt-2 space-y-1.5">{children}</dl>
    </div>
  );
}

/**
 * One fact. Renders "Unavailable" rather than a blank when the value is
 * missing, so a reader can tell an absent field from an unread one.
 */
function Row({ label, value, mono }) {
  const shown = value === null || value === undefined || value === '' ? null : value;
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <dt className="shrink-0 text-slate-500">{label}</dt>
      <dd className={`truncate text-right ${shown ? 'text-slate-300' : 'text-slate-600'} ${mono ? 'font-mono text-[11px]' : ''}`}>
        {shown ?? 'Unavailable'}
      </dd>
    </div>
  );
}

/** A raw diagnostic line. Omitted entirely when there is nothing to show. */
function Diag({ label, value }) {
  if (value === null || value === undefined || value === '') return null;
  return (
    <div className="flex gap-2">
      <dt className="shrink-0 text-slate-600">{label}</dt>
      <dd className="break-all text-slate-400">{String(value)}</dd>
    </div>
  );
}

/** A percentage for a Metric tile, or null so the tile shows its own dash. */
const pct = (v) => (typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(1)}%` : null);

/** An ISO timestamp as a short local date, or an empty string. */
function shortTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Stands in for a figure Azure did not return. Never a zero. */
const DASH = <span className="text-slate-600">—</span>;

export default function Compute() {
  const tenantId = useAppStore(s => s.selectedTenantId);
  const subscriptionIds = useAppStore(s => s.selectedSubscriptionIds);

  // The fleet lives in the store, not here. /estate shows a summary of exactly
  // this dataset, and two pages each running their own copy of an endpoint
  // that fans out to Resource Graph, Cost Management, Azure Monitor and Retail
  // Prices is not just wasteful — Monitor throttles, and the duplicate can
  // push the original into a 429.
  const data = useAppStore(s => s.computeData);
  const loading = useAppStore(s => s.computeLoading);
  const error = useAppStore(s => s.computeError);
  const loadCompute = useAppStore(s => s.loadCompute);

  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState(null);
  // Off by default: raw Azure Monitor request detail is for whoever has to
  // explain a telemetry gap, not for the person reading the fleet.
  const [diagnostics, setDiagnostics] = useState(false);
  // The VM currently under review. Holding the row rather than an id keeps the
  // modal readable while the fleet behind it reloads.
  const [reviewing, setReviewing] = useState(null);
  const [history, setHistory] = useState([]);

  // Concurrent callers of the same key share one promise inside the store, so
  // the effect below and the Refresh button can no longer race each other into
  // two requests. The guard that used to live here is now the store's.
  const load = useCallback(() => loadCompute(), [loadCompute]);

  // Deferred by a tick: calling a state-setting callback directly in an effect
  // body is flagged by react-hooks, and this endpoint is expensive enough that
  // a stray double-invoke is worth avoiding anyway.
  useEffect(() => {
    const id = setTimeout(load, 0);
    return () => clearTimeout(id);
  }, [load]);

  const loadHistory = useCallback(async () => {
    if (!tenantId) return;
    try {
      const result = await fetchResizeHistory(tenantId);
      setHistory(result?.operations || []);
    } catch {
      // History is a record of what already happened; failing to read it must
      // not take the fleet down with it.
      setHistory([]);
    }
  }, [tenantId]);

  useEffect(() => {
    const id = setTimeout(loadHistory, 0);
    return () => clearTimeout(id);
  }, [loadHistory]);

  // After a successful resize the machine is a different size, at a different
  // price, and the recommendation that produced it is now stale. Re-reading the
  // fleet is the only way to make the old advice disappear.
  const afterResize = useCallback(() => {
    // Forced: the cached fleet still describes the old size at the old price.
    loadCompute({ force: true });
    loadHistory();
  }, [loadCompute, loadHistory]);

  const currency = data?.currency || 'USD';
  const summary = data?.summary;
  const vms = useMemo(() => data?.vms || [], [data]);

  const counts = useMemo(() => summary?.by_verdict || {}, [summary]);
  const filterOptions = useMemo(
    () => FILTERS.map(f => ({ ...f, count: counts[f.value] || 0 })).filter(f => f.count > 0),
    [counts],
  );

  const rows = useMemo(
    () => (filter ? vms.filter(v => v.verdict === filter) : vms),
    [vms, filter],
  );

  // Guarded rather than trusting: the cost join once handed this an object,
  // which `formatAmount` turned into "₹NaN" in every row of the table. A value
  // that is not a finite number has no business being formatted as money.
  const money = useCallback(
    (v) => (typeof v === 'number' && Number.isFinite(v) ? formatAmount(v, currency) : null),
    [currency],
  );

  const columns = useMemo(() => [
    {
      key: 'name',
      header: 'Virtual machine',
      render: (r) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-slate-200">{r.name}</p>
          <p className="truncate text-[11px] text-slate-500">
            {r.resource_group} · {r.region}
          </p>
        </div>
      ),
    },
    { key: 'sku', header: 'Size', render: (r) => <span className="font-mono text-[11px]">{r.sku || '—'}</span> },
    {
      key: 'power_state',
      header: 'Operational',
      sortValue: (r) => r.operational?.status,
      render: (r) => (
        <Status
          tone={OPERATIONAL_TONE[r.operational?.status] || POWER_TONE[r.power_state] || 'neutral'}
          label={r.operational?.label || r.power_state || 'Unknown'}
        />
      ),
    },
    {
      key: 'right_sizing',
      header: 'Right-sizing',
      sortValue: (r) => r.right_sizing?.status,
      render: (r) => (
        <div className="flex items-center gap-1.5">
          <Status
            tone={RIGHTSIZING_TONE[r.right_sizing?.status] || 'neutral'}
            label={r.right_sizing?.label || '—'}
          />
          {r.right_sizing?.confidence && r.right_sizing.confidence !== 'NONE' && (
            <Badge tone={CONFIDENCE_TONE[r.right_sizing.confidence]}>
              {r.right_sizing.confidence.toLowerCase()}
            </Badge>
          )}
        </div>
      ),
    },
    {
      key: 'telemetry',
      header: 'Telemetry',
      sortValue: (r) => r.telemetry?.coverage,
      render: (r) => {
        const status = r.telemetry?.status;
        const cov = r.telemetry?.coverage;
        // A sound reading is shown as its coverage; anything else is shown as
        // the reason, because that is the actionable part.
        if (status === 'VALID' && typeof cov === 'number') {
          return <span className="tabular-nums text-slate-400">{cov.toFixed(0)}%</span>;
        }
        return (
          <Status
            tone={TELEMETRY_TONE[status] || 'neutral'}
            label={TELEMETRY_SHORT[status] || 'Unknown'}
          />
        );
      },
    },
    {
      key: 'cpu_avg', header: 'CPU avg', align: 'right',
      render: (r) => <Pct value={r.cpu_avg} telemetry={r.telemetry} />,
    },
    {
      key: 'cpu_p95', header: 'CPU p95', align: 'right',
      render: (r) => <Pct value={r.cpu_p95} telemetry={r.telemetry} />,
    },
    {
      key: 'cpu_p99', header: 'CPU p99', align: 'right',
      render: (r) => <Pct value={r.cpu_p99} telemetry={r.telemetry} />,
    },
    {
      key: 'monthly_cost', header: 'Cost / mo', align: 'right',
      render: (r) => money(r.monthly_cost) ?? DASH,
    },
    {
      key: 'annual_cost', header: 'Cost / yr', align: 'right',
      render: (r) => money(r.annual_cost) ?? DASH,
    },
    {
      key: 'savings', header: 'Saving / mo', align: 'right',
      sortValue: (r) => r.savings?.monthly,
      render: (r) => (money(r.savings?.monthly)
        ? <span className="font-medium text-emerald-400">{money(r.savings.monthly)}</span>
        : DASH),
    },
    {
      key: 'action', header: 'Action', sortable: false,
      render: (r) => {
        // One control per row, and it says what it does. This cell used to
        // render a "View details" button beside the words "Resize → D4as_v5",
        // so the page named an action and then refused to open it.
        //
        // Every VM gets in, not just the ones we had an opinion about. A
        // machine with no recommendation opens straight onto the size
        // catalogue, because "we found nothing" is not the same as "there is
        // nothing to do" — undersized and untelemetered machines are exactly
        // the ones a person needs to judge for themselves.
        const resizable = isResizable(r);
        const reviewable = isReviewable(r);
        return (
          <div className="flex items-center justify-end gap-2">
            {r.recommended_sku && (
              <Badge tone="info">→ {r.recommended_sku.replace('Standard_', '')}</Badge>
            )}
            <Button
              size="sm"
              variant={resizable ? 'primary' : 'ghost'}
              onClick={(e) => {
                e.stopPropagation();
                if (reviewable) setReviewing(r); else setExpanded(r.id);
              }}
            >
              {actionLabel(r)}
            </Button>
          </div>
        );
      },
    },
  ], [money]);

  const metricsBlocked = data?.sources?.metrics === 'permission';
  const costUnmatched = data?.sources?.cost === 'unmatched';
  const coverage = data?.coverage;

  return (
    <div className="mx-auto max-w-screen-2xl space-y-5 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-100">Compute Intelligence</h1>
          <p className="mt-1 max-w-3xl text-sm leading-relaxed text-slate-400">
            Every virtual machine, what it costs, and what it actually did. Verdicts come
            from 30 days of Azure Monitor telemetry — nothing here changes your estate.
          </p>
        </div>
        <Button variant="primary" icon={RefreshCw} onClick={load} loading={loading}>
          Refresh fleet
        </Button>
      </div>

      {/* ── headline ──
          Split into what the fleet *is* and what can be *saved*, because the
          two answer different questions and the second is frequently empty.
          "Needs attention" used to lump telemetry failures in with real
          findings, which made a permissions gap look like an overspend. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <Metric
          label="Virtual machines" icon={Server} loading={loading}
          value={summary?.total ?? null}
          hint={data?.window_days ? `${data.window_days}-day window` : ''}
        />
        <Metric
          label="Telemetry coverage" icon={Gauge} loading={loading}
          value={summary ? `${summary.telemetry_measured ?? 0} / ${summary.total}` : null}
          /* Deliberately not "assessed". Counting the deallocated machines as
             assessed reads as though their CPU was examined, when all that was
             established is that they are off. */
          hint={summary
            ? `${summary.verifiably_off ?? 0} verifiably off · ${summary.telemetry_unavailable ?? 0} awaiting telemetry`
            : ''}
        />
        <Metric
          label="Running" icon={Play} loading={loading}
          value={summary?.running ?? null}
          hint={summary?.stopped ? `${summary.stopped} stopped but billing` : ''}
        />
        <Metric
          label="Deallocated" icon={PowerOff} loading={loading}
          value={summary?.deallocated ?? null}
          hint="No compute charge; disks still bill"
        />
        <Metric
          label="Right-sizing opportunities" icon={TrendingDown} tone="good" loading={loading}
          value={summary?.rightsizing_opportunities ?? null}
          hint="Idle, oversized or stopped-but-billing"
        />
        <Metric
          label="Telemetry issues" icon={AlertTriangle}
          tone={summary?.telemetry_issues ? 'high' : undefined} loading={loading}
          value={summary?.telemetry_issues ?? null}
          hint="Machines Azure could not report on"
        />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Metric
          label="Potential monthly saving" icon={TrendingDown} tone="good" loading={loading}
          value={money(summary?.confident_monthly_savings)}
          hint={summary?.no_opportunity_note
            || (summary?.monthly_savings && summary.monthly_savings !== summary.confident_monthly_savings
              ? `${money(summary.monthly_savings)} including lower-confidence findings`
              : 'High-confidence findings only')}
        />
        <Metric
          label="Potential annual saving" icon={Wallet} tone="good" loading={loading}
          value={money(summary?.confident_annual_savings)}
          hint="Monthly figure × 12"
        />
        <Metric
          label="Fleet cost" icon={Cpu} loading={loading}
          value={money(summary?.fleet_monthly_cost)}
          hint={money(summary?.fleet_annual_cost)
            ? `${money(summary.fleet_annual_cost)} a year`
            : 'Cost could not be read'}
        />
      </div>

      {/* Honesty about what the totals exclude, shown before the table rather
          than as a footnote nobody scrolls to. */}
      {summary?.unpriced_recommendations > 0 && (
        <Callout tone="info" title="Some recommendations have no price attached">
          {summary.unpriced_recommendations} machine
          {summary.unpriced_recommendations === 1 ? '' : 's'} could be resized, but the published
          price for the proposed size could not be read — so they are listed and contribute
          nothing to the savings totals above. Azure SKU prices are not proportional to vCPU
          count, so estimating them would be a guess.
        </Callout>
      )}

      {metricsBlocked && (
        <Callout tone="medium" title="Utilization is unavailable">
          This account can list the VMs and read their cost, but Azure refused the metrics
          request. Every machine will show “Access denied” until{' '}
          <code className="text-amber-300">Monitoring Reader</code> is granted. That is a
          missing role, not an idle estate — and it is not evidence about which metrics
          these machines publish.
        </Callout>
      )}

      {/* Partial success is the normal case on a large estate, so it is stated
          as a count rather than hidden behind rows that quietly say nothing. */}
      {coverage && coverage.not_analysed > 0 && (
        <Callout
          tone="info"
          title={summary
            ? `${summary.telemetry_measured ?? 0} measured · ${summary.verifiably_off ?? 0} verifiably off · ${summary.telemetry_unavailable ?? 0} awaiting telemetry`
            : `${coverage.analysed} of ${coverage.total} machines`}
        >
          Only the measured machines had their CPU examined. The verifiably off ones are
          settled without any telemetry — they are deallocated, so there is nothing running
          to measure. The rest returned no usable CPU history; each row names its own reason
          — Monitor access denied, throttling, a CPU metric Azure does not publish for
          that machine, an empty window for one it does, or too short a
          history to judge. All of them keep their cost and any other telemetry they did
          report, because a machine nobody can size is still a machine somebody is paying for.
        </Callout>
      )}

      {costUnmatched && (
        <Callout tone="medium" title="Cost could not be matched to these machines">
          Azure returned cost data, but none of it matched a VM in this fleet. The cost
          column is left empty rather than showing zero — these machines are not free,
          their price simply could not be joined.
        </Callout>
      )}

      <Panel
        title="Fleet"
        hint="Sorted worst-first: stopped machines, then idle, then oversized. Click a row for the evidence."
        actions={
          filterOptions.length > 0 && (
            <ChipFilter options={filterOptions} value={filter} onChange={setFilter} />
          )
        }
        bodyClassName=""
      >
        {loading && !data && <TableSkeleton rows={8} cols={8} />}

        {!loading && !error && !tenantId && (
          <EmptyState title="Choose a tenant" description="Pick a tenant and at least one subscription to assess its VM fleet." />
        )}

        {!loading && !error && tenantId && !subscriptionIds?.length && (
          <EmptyState
            icon={Server}
            title="Choose a subscription"
            description="Compute Intelligence reads VMs per subscription. Select one or more from the sidebar to begin."
          />
        )}

        {!loading && error && (
          <ErrorState message={error} onRetry={load} />
        )}

        {!loading && !error && metricsBlocked && vms.length === 0 && (
          <NoPermissionState
            what="virtual machine utilization"
            permission="Monitoring Reader — Microsoft.Insights/metrics/read"
          />
        )}

        {!loading && !error && data && vms.length === 0 && !metricsBlocked && (
          <EmptyState
            icon={Server}
            title="No virtual machines found"
            description="No VMs exist in the selected subscriptions, or none are visible to this account."
            actions={<Button size="sm" onClick={load}>Refresh</Button>}
          />
        )}

        {!loading && !error && rows.length > 0 && (
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id}
            onRowClick={(r) => setExpanded(expanded === r.id ? null : r.id)}
            selectedKey={expanded}
            initialSort={{ key: 'savings', dir: 'desc' }}
            pageSize={25}
          />
        )}

        {!loading && !error && rows.length === 0 && vms.length > 0 && (
          <EmptyState
            title="No machines match this filter"
            description="Every VM in the fleet falls into a different category."
            actions={<Button size="sm" onClick={() => setFilter('')}>Clear filter</Button>}
          />
        )}
      </Panel>

      {/* The evidence for whichever row is open. Kept below the table rather
          than in a drawer so it can be read alongside the fleet it came from.

          Organised as the four questions the backend answers separately. A VM
          with no CPU metric previously rendered this whole panel blank, which
          suggested the machine was unknowable — when in fact its identity,
          cost and power state were all known and only its sizing was not. */}
      {expanded && (() => {
        const vm = vms.find(v => v.id === expanded);
        if (!vm) return null;
        const t = vm.telemetry || {};
        const sig = vm.utilization?.signals || {};
        const rs = vm.right_sizing || {};
        const measured = t.status === 'VALID' || t.status === 'PARTIAL_DATA'
          || t.status === 'INSUFFICIENT_DATA';

        return (
          <Panel
            title={vm.name}
            hint={vm.sku}
            tone={VERDICT_TONE[vm.verdict]}
            actions={
              <div className="flex items-center gap-2">
                <Button size="sm" variant="ghost" onClick={() => setDiagnostics(d => !d)}>
                  {diagnostics ? 'Hide diagnostics' : 'Diagnostics'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setExpanded(null)}>Close</Button>
              </div>
            }
          >
            <div className="grid gap-4 lg:grid-cols-2">
              <Section title="VM information">
                <Row label="Size" value={vm.sku} mono />
                <Row label="Region" value={vm.region} />
                <Row label="Resource group" value={vm.resource_group} />
                <Row label="Operating system" value={vm.os_type} />
                <Row label="Power" value={vm.operational?.label || vm.power_state} />
              </Section>

              <Section title="Cost">
                <Row label="Monthly" value={money(vm.monthly_cost)} />
                <Row label="Annualized" value={money(vm.annual_cost)} />
                <Row
                  label="Share of fleet cost"
                  value={typeof vm.cost?.share_of_fleet === 'number'
                    ? `${vm.cost.share_of_fleet.toFixed(1)}%` : null}
                />
              </Section>

              <Section title="Telemetry">
                <Row label="Overall" value={t.label} />
                {/* Each signal's label is computed once on the server from the
                    catalogue and the query result together. Deriving it here
                    from capabilities alone is what let this panel say "CPU:
                    Published" directly above "CPU metric unavailable". */}
                <Row label="CPU" value={sig.cpu?.label} />
                <Row label="Network" value={sig.network?.label} />
                <Row label="Disk" value={sig.disk?.label} />
                <Row label="Memory" value={sig.memory?.status === 'NOT_PUBLISHED'
                  ? 'Not published — needs the Azure Monitor agent'
                  : sig.memory?.label} />
                <Row label="Datapoints" value={t.observed_points ?? null} />
                <Row label="Coverage" value={typeof t.coverage === 'number'
                  ? `${t.coverage.toFixed(0)}% of the window` : null} />
                <Row label="First datapoint" value={t.first_observed} />
                <Row label="Last datapoint" value={t.last_observed} />
              </Section>

              <Section title="Right-sizing">
                <Row label="Verdict" value={rs.label} />
                <Row label="Confidence" value={rs.confidence
                  ? rs.confidence.charAt(0) + rs.confidence.slice(1).toLowerCase() : null} />
                <Row label="Recommended size" value={rs.recommendation} mono />
                <Row label="Saving / month" value={money(vm.savings?.monthly)} />
              </Section>
            </div>

            <p className="mt-4 text-sm leading-relaxed text-slate-300">{rs.reason || vm.reason}</p>
            {rs.recommended_action && (
              <p className="mt-1.5 text-xs leading-relaxed text-slate-500">
                {rs.recommended_action}
              </p>
            )}

            {/* CPU statistics only when CPU was actually measured. Rendering
                four dashes under a "CPU" heading reads as broken; naming the
                reason reads as an answer. */}
            {measured ? (
              <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Metric label="CPU average" value={pct(vm.cpu_avg)} />
                <Metric label="CPU p95" value={pct(vm.cpu_p95)} />
                <Metric label="CPU p99" value={pct(vm.cpu_p99)} />
                <Metric label="CPU peak" value={pct(vm.cpu_max)} />
              </div>
            ) : (
              <Callout tone="info" className="mt-4" title="No CPU chart is drawn for this machine">
                {t.reason || 'Percentage CPU was not read for this VM.'} Drawing a line
                here would invent data that Azure never returned.
              </Callout>
            )}

            {/* The provenance of the numbers above. Without it a reader cannot
                tell a verdict drawn from a full month from one drawn from an
                afternoon, and both look equally authoritative. */}
            {measured && (
              <div className="mt-4 rounded-lg border border-slate-800 bg-slate-900/40 p-3">
                <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
                  Evidence
                </p>
                <p className="mt-1.5 text-xs leading-relaxed text-slate-400">
                  {t.observed_points} of {t.expected_points ?? '—'} expected {t.metric} readings
                  {typeof t.coverage === 'number' && ` (${t.coverage.toFixed(1)}% coverage)`}
                  {t.first_observed && (
                    <>, from {shortTime(t.first_observed)} to {shortTime(t.last_observed)}</>
                  )}
                  . Buckets where the machine reported nothing are excluded rather
                  than counted as zero.
                </p>
              </div>
            )}

            {vm.savings?.note && (
              <Callout tone={vm.savings.monthly ? 'good' : 'info'} className="mt-3">
                {vm.savings.note}
              </Callout>
            )}

            {/* Hidden by default. This is for whoever has to explain an Azure
                Monitor gap, not for the person reading the fleet. */}
            {diagnostics && (
              <div className="mt-4 rounded-lg border border-slate-800 bg-slate-950/60 p-3">
                <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
                  Diagnostics
                </p>
                <dl className="mt-2 space-y-1 font-mono text-[11px] text-slate-400">
                  <Diag label="resource id" value={vm.resource_id || vm.id} />
                  <Diag label="namespace" value={(vm.diagnostics?.namespaces || []).join(', ')} />
                  <Diag label="requested" value={(vm.diagnostics?.requested_metrics || []).join(', ')} />
                  <Diag label="available" value={(t.available_metrics || []).join(', ')} />
                  <Diag label="skipped" value={(vm.diagnostics?.skipped_metrics || []).join(', ')} />
                  <Diag label="definitions http" value={vm.diagnostics?.definitions_status} />
                  <Diag label="metrics http" value={vm.diagnostics?.status_code} />
                  <Diag label="stage" value={vm.diagnostics?.stage} />
                  <Diag label="duration" value={vm.diagnostics?.duration_ms != null
                    ? `${vm.diagnostics.duration_ms} ms` : null} />
                  <Diag label="points" value={t.observed_points} />
                  <Diag label="first datapoint" value={t.first_observed} />
                  <Diag label="last datapoint" value={t.last_observed} />
                  <Diag label="error code" value={vm.diagnostics?.error_code} />
                  <Diag label="error" value={vm.diagnostics?.error} />
                  {/* Azure's own words. Every layer above this one is an
                      interpretation; this is the only line that is not. */}
                  <Diag label="azure response" value={vm.diagnostics?.body} />
                  <Diag
                    label="request groups"
                    value={(vm.diagnostics?.groups || [])
                      .map((g) => `${g.aggregation} [${g.status_code}] ${(g.metrics || []).join(' + ')}`)
                      .join(' — ')}
                  />
                </dl>
              </div>
            )}
          </Panel>
        );
      })()}

      {/* What has actually been changed, as opposed to what was advised. This
          is the audit trail: it is read from the backend's own record of every
          resize started from this application, successful or not. */}
      {history.length > 0 && (
        <Panel title="Resize history" hint={`${history.length} operation${history.length === 1 ? '' : 's'}`}>
          <ul className="divide-y divide-slate-800">
            {history.map(op => (
              <li key={op.operation_id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
                <span className="text-xs text-slate-500">{shortTime(op.created_at)}</span>
                <span className="font-medium text-slate-200">{op.vm_name}</span>
                <span className="font-mono text-xs text-slate-400">
                  {op.old_sku} → {op.new_sku}
                </span>
                <Status
                  tone={op.state === 'SUCCESS' ? 'good'
                    : op.state === 'FAILED' ? 'critical' : 'info'}
                  label={op.state_label}
                />
                {typeof op.estimated_monthly_saving === 'number' && (
                  <span className="text-xs text-emerald-400">
                    Estimated saving {formatAmountFull(op.estimated_monthly_saving, op.currency)} / month
                  </span>
                )}
                {op.failure_reason && (
                  <span className="text-xs text-slate-500">{op.failure_reason}</span>
                )}
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {reviewing && (
        <ResizeModal
          vm={reviewing}
          tenantId={tenantId}
          currency={currency}
          onClose={() => setReviewing(null)}
          onResized={afterResize}
        />
      )}

      {data?.note && (
        <p className="text-[11px] leading-relaxed text-slate-500">{data.note}</p>
      )}
    </div>
  );
}
