import { useCallback, useEffect, useMemo, useState } from 'react';
import { Cpu, RefreshCw, Server, TrendingDown, Wallet } from 'lucide-react';
import { fetchCompute } from '../api/client';
import { useAppStore } from '../store/useAppStore';
import { formatAmount } from '../utils/currency';
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
 * Nothing here mutates Azure. The actions are described, not performed.
 */

const VERDICT_TONE = {
  stopped_but_billed: 'critical',
  idle: 'high',
  underutilized: 'medium',
  overutilized: 'medium',
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
  { value: 'right_sized', label: 'Right-sized', tone: 'good' },
  { value: 'insufficient_data', label: 'No data', tone: 'neutral' },
];

/** A percentage that knows the difference between zero and unmeasured. */
function Pct({ value }) {
  if (value == null) return <span className="text-slate-600">—</span>;
  return <span className="tabular-nums">{value.toFixed(1)}%</span>;
}

export default function Compute() {
  const tenantId = useAppStore(s => s.selectedTenantId);
  const subscriptionIds = useAppStore(s => s.selectedSubscriptionIds);
  const billingCurrency = useAppStore(s => s.imported?.currency);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState(null);

  const load = useCallback(async () => {
    if (!tenantId || !subscriptionIds?.length) return;
    setLoading(true);
    setError('');
    try {
      setData(await fetchCompute({
        tenant_id: tenantId,
        subscription_ids: subscriptionIds,
        days: 30,
        currency: billingCurrency,
      }));
    } catch (err) {
      setError(err?.response?.data?.detail || err.message || 'Could not read your VM fleet.');
    } finally {
      setLoading(false);
    }
  }, [tenantId, subscriptionIds, billingCurrency]);

  // Deferred by a tick: calling a state-setting callback directly in an effect
  // body is flagged by react-hooks, and this endpoint is expensive enough that
  // a stray double-invoke is worth avoiding anyway.
  useEffect(() => {
    const id = setTimeout(load, 0);
    return () => clearTimeout(id);
  }, [load]);

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

  const money = (v) => (v == null ? null : formatAmount(v, currency));

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
      key: 'verdict',
      header: 'Verdict',
      render: (r) => <Status tone={VERDICT_TONE[r.verdict]} label={r.verdict_label} />,
    },
    {
      key: 'cpu_p95', header: 'CPU p95', align: 'right',
      render: (r) => <Pct value={r.cpu_p95} />,
    },
    {
      key: 'cpu_p99', header: 'CPU p99', align: 'right',
      render: (r) => <Pct value={r.cpu_p99} />,
    },
    {
      key: 'monthly_cost', header: `Cost / mo`, align: 'right',
      render: (r) => money(r.monthly_cost) ?? <span className="text-slate-600">—</span>,
    },
    {
      key: 'savings', header: 'Saving / mo', align: 'right',
      sortValue: (r) => r.savings?.monthly,
      render: (r) => (r.savings?.monthly
        ? <span className="font-medium text-emerald-400">{money(r.savings.monthly)}</span>
        : <span className="text-slate-600">—</span>),
    },
    {
      key: 'action', header: 'Action', sortable: false,
      render: (r) => (
        <div className="flex items-center gap-1.5">
          <span className="text-slate-400">{ACTION_LABEL[r.action] || r.action}</span>
          {r.recommended_sku && (
            <Badge tone="info">→ {r.recommended_sku.replace('Standard_', '')}</Badge>
          )}
        </div>
      ),
    },
  ], [currency]); // eslint-disable-line react-hooks/exhaustive-deps

  const metricsBlocked = data?.sources?.metrics === 'permission';

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

      {/* ── headline ── */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric
          label="Virtual machines" icon={Server} loading={loading}
          value={summary?.total ?? null}
          hint={data?.window_days ? `${data.window_days}-day window` : ''}
        />
        <Metric
          label="Monthly saving found" icon={TrendingDown} tone="good" loading={loading}
          value={summary?.monthly_savings ? money(summary.monthly_savings) : null}
          hint={summary?.confident_monthly_savings
            ? `${money(summary.confident_monthly_savings)} of it is high-confidence`
            : 'None of it is high-confidence yet'}
        />
        <Metric
          label="Annual saving found" icon={Wallet} tone="good" loading={loading}
          value={summary?.annual_savings ? money(summary.annual_savings) : null}
          hint="Monthly figure × 12"
        />
        <Metric
          label="Needs attention" icon={Cpu} tone="high" loading={loading}
          value={summary
            ? (counts.stopped_but_billed || 0) + (counts.idle || 0) + (counts.underutilized || 0)
            : null}
          hint="Stopped, idle or oversized"
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
          request. Every machine will show “Not enough data” until{' '}
          <code className="text-amber-300">Monitoring Reader</code> is granted. That is a
          missing role, not an idle estate.
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
          than in a drawer so it can be read alongside the fleet it came from. */}
      {expanded && (() => {
        const vm = vms.find(v => v.id === expanded);
        if (!vm) return null;
        return (
          <Panel
            title={vm.name}
            hint={vm.sku}
            tone={VERDICT_TONE[vm.verdict]}
            actions={<Button size="sm" variant="ghost" onClick={() => setExpanded(null)}>Close</Button>}
          >
            <p className="text-sm leading-relaxed text-slate-300">{vm.reason}</p>

            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Metric label="CPU p95" value={vm.cpu_p95 != null ? `${vm.cpu_p95.toFixed(1)}%` : null} />
              <Metric label="CPU p99" value={vm.cpu_p99 != null ? `${vm.cpu_p99.toFixed(1)}%` : null} />
              <Metric label="CPU average" value={vm.cpu_avg != null ? `${vm.cpu_avg.toFixed(1)}%` : null} />
              <Metric
                label="Memory free at peak"
                value={vm.memory_headroom != null ? `${(vm.memory_headroom * 100).toFixed(0)}%` : null}
              />
            </div>

            <p className="mt-3 text-[11px] text-slate-500">
              Based on {vm.metric_points || 0} observed metric point
              {vm.metric_points === 1 ? '' : 's'}. Buckets where the machine reported nothing
              are excluded rather than counted as zero.
            </p>

            {vm.savings?.note && (
              <Callout tone={vm.savings.monthly ? 'good' : 'info'} className="mt-3">
                {vm.savings.note}
              </Callout>
            )}
          </Panel>
        );
      })()}

      {data?.note && (
        <p className="text-[11px] leading-relaxed text-slate-500">{data.note}</p>
      )}
    </div>
  );
}
