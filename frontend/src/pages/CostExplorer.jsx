import { useEffect, useMemo, useState } from 'react';
import { TrendingUp, Layers, Server, Bookmark, X, Search } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import DataQuality from '../components/Common/DataQuality';
import CostTrendChart from '../components/Charts/CostTrendChart';
import ServiceBreakdownChart from '../components/Charts/ServiceBreakdownChart';
import BoqGenerator from '../components/Boq/BoqGenerator';
import { formatAmount } from '../utils/currency';
import { Amount } from '../components/Common/Amount';
import { DIMENSIONS, aggregate, totalOf, linearForecast, currentMonthKey } from '../utils/breakdown';
import {
  Button, Badge, Card, Panel, Metric, Tabs, SegmentedControl,
  FilterBar, Select, DataTable, EmptyState, ErrorState, Callout, TableSkeleton,
} from '../components/ui';

/*
 * Saved views are stored outside the API cache on purpose.
 *
 * `persistCache` expires anything it holds after a day and drops the lot when
 * the quota is hit — correct for a cached cost query, wrong for something the
 * user named and expects to find again next week.
 */
const VIEWS_KEY = 'aca:views:explorer';

function readViews() {
  try {
    const raw = window.localStorage.getItem(VIEWS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveViews(views) {
  try {
    window.localStorage.setItem(VIEWS_KEY, JSON.stringify(views));
  } catch {
    /* storage unavailable or full — the views just will not persist */
  }
}

const SHORT_TYPE = (t) => (t || '').split('/').slice(1).join('/') || t || '—';

const EMPTY_FILTERS = {
  search: '', subscription: '', resource_group: '', location: '', service: '',
};

/** The distinct values of one field, for a filter dropdown. */
function optionsFor(resources, field, label) {
  const seen = new Set();
  resources.forEach((r) => { if (r[field]) seen.add(r[field]); });
  return [
    { value: '', label: `All ${label}` },
    ...[...seen].sort().map((v) => ({ value: v, label: v })),
  ];
}

function matches(r, f) {
  if (f.subscription && r.subscription_id !== f.subscription) return false;
  if (f.resource_group && r.resource_group !== f.resource_group) return false;
  if (f.location && r.location !== f.location) return false;
  if (f.service && (r.service || r.type) !== f.service) return false;
  if (f.search) {
    const q = f.search.toLowerCase();
    const hay = `${r.name} ${r.type} ${r.service} ${r.resource_group} ${r.sku}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

/**
 * Cost Trends and Service Analysis, merged.
 *
 * They were two pages over one dataset: the trend page charted
 * `costData.months` and the services page tabulated the resources behind it,
 * so answering "what drove that spike" meant leaving one page, re-filtering on
 * the other, and holding the month in your head. Filters set here survive the
 * tab switch, which is the whole point of merging them.
 */
export default function CostExplorer() {
  const {
    costData, costLoading, loadCosts,
    activeServices, servicesLoading, servicesError, loadServices,
    selectedTenantId, selectedSubscriptionIds, subscriptions, months, dateKey,
  } = useAppStore();

  const [tab, setTab] = useState('trend');
  const [dimension, setDimension] = useState('service');
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [views, setViews] = useState(readViews);

  const subsKey = selectedSubscriptionIds.join(',');

  useEffect(() => {
    if (!selectedTenantId || !selectedSubscriptionIds.length) return;
    // Costs first, then resources. Both are cost queries per subscription and
    // Azure throttles them together, so firing both at once reliably earned a
    // 429 on the second.
    let cancelled = false;
    (async () => {
      await loadCosts();
      if (!cancelled) await loadServices();
    })();
    return () => { cancelled = true; };
  }, [selectedTenantId, subsKey, dateKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const monthly = useMemo(() => costData?.months || [], [costData]);
  const currency = monthly[0]?.currency || costData?.currency || activeServices[0]?.currency || 'INR';
  const fmt = (v) => formatAmount(v, currency);
  const thisMonth = currentMonthKey();

  const forecast = useMemo(
    () => linearForecast(monthly, 3, { currentMonth: thisMonth }),
    [monthly, thisMonth],
  );

  const filtered = useMemo(
    () => activeServices.filter((r) => matches(r, filters)),
    [activeServices, filters],
  );

  const breakdown = useMemo(() => aggregate(filtered, dimension), [filtered, dimension]);
  const breakdownTotal = useMemo(() => totalOf(breakdown), [breakdown]);
  const unpricedCount = useMemo(
    () => breakdown.reduce((n, r) => n + r.unpriced, 0),
    [breakdown],
  );

  const activeFilterCount = Object.values(filters).filter(Boolean).length;
  const subName = useMemo(() => {
    const map = new Map(subscriptions.map((s) => [s.subscription_id, s.display_name]));
    return (id) => map.get(id) || id;
  }, [subscriptions]);

  /* ── saved views ────────────────────────────────────────────────────
     A "custom dashboard" that stores a whole widget layout would need a
     layout engine; what people actually re-open is a question — this
     breakdown, these filters — so that is what is saved. */
  const persistViews = (next) => { setViews(next); saveViews(next); };

  const saveView = () => {
    const name = window.prompt('Name this view');
    if (!name?.trim()) return;
    persistViews([
      ...views.filter((v) => v.name !== name.trim()),
      { name: name.trim(), tab, dimension, filters },
    ]);
  };

  const applyView = (v) => {
    setTab(v.tab || 'trend');
    setDimension(v.dimension || 'service');
    setFilters({ ...EMPTY_FILTERS, ...(v.filters || {}) });
  };

  if (!selectedTenantId || !selectedSubscriptionIds.length) {
    return (
      <div className="p-6">
        <EmptyState
          icon={Layers}
          title="Choose a subscription to explore"
          description="Pick a tenant and at least one subscription in the header and this page will load its spend."
        />
      </div>
    );
  }

  const tabs = [
    { key: 'trend', label: 'Trend & forecast', icon: TrendingUp },
    { key: 'breakdown', label: 'Breakdown', icon: Layers },
    { key: 'resources', label: 'Resources', icon: Server, count: filtered.length || null },
  ];

  return (
    <div className="mx-auto max-w-screen-2xl space-y-5 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">Cost Explorer</h1>
          <p className="mt-1 text-sm text-slate-400">
            Spend over time, split any way, down to the resource billing it.
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={saveView} icon={Bookmark}>
          Save view
        </Button>
      </div>

      {/* Coverage sits with the figures, not in a console log. */}
      <DataQuality coverage={costData?.coverage} />

      {views.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-slate-500">Saved:</span>
          {views.map((v) => (
            <span
              key={v.name}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-800 bg-slate-900 pl-2 text-xs text-slate-300"
            >
              <button onClick={() => applyView(v)} className="py-1 hover:text-blue-300">
                {v.name}
              </button>
              <button
                onClick={() => persistViews(views.filter((x) => x.name !== v.name))}
                aria-label={`Delete view ${v.name}`}
                className="px-1.5 py-1 text-slate-600 hover:text-red-400"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <Tabs tabs={tabs} active={tab} onChange={setTab} />

      {/* Filters drive the breakdown and the resource table. The trend comes
          from Cost Management's own monthly totals, which are not resource
          scoped, so they cannot honestly be filtered here — said plainly
          rather than leaving a filter that appears to do nothing. */}
      {tab !== 'trend' && (
        <Card className="p-4">
          <FilterBar
            active={activeFilterCount}
            onReset={() => setFilters(EMPTY_FILTERS)}
          >
            <label className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-2 text-xs text-slate-400">
              <Search className="h-3.5 w-3.5" />
              <input
                value={filters.search}
                onChange={(e) => setFilters({ ...filters, search: e.target.value })}
                placeholder="Search name, type, SKU…"
                className="h-8 w-52 bg-transparent text-slate-200 outline-none placeholder:text-slate-600"
              />
            </label>
            <Select
              label="Subscription"
              value={filters.subscription}
              onChange={(v) => setFilters({ ...filters, subscription: v })}
              options={optionsFor(activeServices, 'subscription_id', 'subscriptions')
                .map((o) => (o.value ? { ...o, label: subName(o.value) } : o))}
            />
            <Select
              label="Resource group"
              value={filters.resource_group}
              onChange={(v) => setFilters({ ...filters, resource_group: v })}
              options={optionsFor(activeServices, 'resource_group', 'groups')}
            />
            <Select
              label="Region"
              value={filters.location}
              onChange={(v) => setFilters({ ...filters, location: v })}
              options={optionsFor(activeServices, 'location', 'regions')}
            />
            <Select
              label="Service"
              value={filters.service}
              onChange={(v) => setFilters({ ...filters, service: v })}
              options={optionsFor(activeServices, 'service', 'services')}
            />
          </FilterBar>
        </Card>
      )}

      {servicesError && tab !== 'trend' && (
        <ErrorState title="Could not load resources" message={servicesError} onRetry={loadServices} />
      )}

      {tab === 'trend' && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Metric
              label="Months loaded"
              value={monthly.length || null}
              hint={monthly.length ? `${monthly[0].month} → ${monthly.at(-1).month}` : undefined}
              loading={costLoading}
            />
            <Metric
              label="Latest month"
              value={monthly.length ? fmt(monthly.at(-1).total_cost) : null}
              hint={monthly.at(-1)?.month === thisMonth ? 'Still being billed' : undefined}
              loading={costLoading}
            />
            {forecast.slice(0, 2).map((f) => (
              <Metric
                key={f.month}
                label={`Projected ${f.month}`}
                value={fmt(f.total_cost)}
                hint="Straight-line projection"
                loading={costLoading}
              />
            ))}
          </div>

          {forecast.length === 0 && !costLoading && monthly.length > 0 && (
            <Callout tone="info" title="Not enough history to project">
              A forecast needs at least three complete billing months. Widen the date range in
              the header and this will fill in.
            </Callout>
          )}

          <Panel
            title={`Monthly spend${months ? ` (${months} months)` : ''}`}
            hint="The dashed line is a straight-line projection from completed months, not an Azure forecast."
          >
            <CostTrendChart
              months={monthly}
              loading={costLoading}
              currency={currency}
              forecast={forecast}
            />
          </Panel>

          <Panel title="Spend by service, month over month">
            <ServiceBreakdownChart months={monthly} loading={costLoading} currency={currency} />
          </Panel>

          <Panel title="Month-over-month" bodyClassName="">
            {costLoading ? (
              <TableSkeleton rows={6} cols={5} />
            ) : (
              <DataTable
                rows={monthly.map((m, i) => {
                  const prev = monthly[i - 1];
                  const top = Object.entries(m.by_service || {}).sort((a, b) => b[1] - a[1])[0];
                  return {
                    id: m.month,
                    month: m.month,
                    total: m.total_cost,
                    // No previous month means no change to report — not a
                    // change of zero.
                    diff: prev ? m.total_cost - prev.total_cost : null,
                    pct: prev && prev.total_cost ? ((m.total_cost - prev.total_cost) / prev.total_cost) * 100 : null,
                    top: top ? `${top[0]} (${fmt(top[1])})` : null,
                  };
                })}
                initialSort={{ key: 'month', dir: 'desc' }}
                columns={[
                  {
                    key: 'month', header: 'Month', sortable: true,
                    render: (r) => (
                      <span className="font-medium text-slate-200">
                        {r.month}
                        {r.month === thisMonth && (
                          <Badge tone="info" className="ml-2">in progress</Badge>
                        )}
                      </span>
                    ),
                  },
                  {
                    key: 'total', header: `Total (${currency})`, align: 'right', sortable: true,
                    render: (r) => <Amount value={r.total} currency={currency} />,
                  },
                  {
                    key: 'pct', header: 'Change', align: 'right', sortable: true,
                    render: (r) => (r.pct == null ? <span className="text-slate-600">—</span> : (
                      <span className={r.pct > 0 ? 'text-red-400' : 'text-emerald-400'}>
                        {r.pct > 0 ? '▲' : '▼'} {Math.abs(r.pct).toFixed(1)}%
                      </span>
                    )),
                  },
                  {
                    key: 'diff', header: 'Amount', align: 'right', sortable: true,
                    render: (r) => (r.diff == null ? <span className="text-slate-600">—</span> : (
                      <span className={r.diff > 0 ? 'text-red-400' : 'text-emerald-400'}>
                        {r.diff > 0 ? '+' : ''}{fmt(r.diff)}
                      </span>
                    )),
                  },
                  {
                    key: 'top', header: 'Top service', align: 'right',
                    render: (r) => <span className="text-xs text-slate-400">{r.top || '—'}</span>,
                  },
                ]}
                empty={<EmptyState title="No months returned" description="Azure reported no billing for this range." />}
              />
            )}
          </Panel>
        </div>
      )}

      {tab === 'breakdown' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <SegmentedControl
              options={DIMENSIONS.map((d) => ({ value: d.value, label: d.label }))}
              value={dimension}
              onChange={setDimension}
            />
            <p className="text-xs text-slate-500">
              {breakdown.length} {breakdown.length === 1 ? 'group' : 'groups'} · {fmt(breakdownTotal)}
            </p>
          </div>

          {unpricedCount > 0 && (
            <Callout tone="medium" title={`${unpricedCount} resources have no cost reported`}>
              They are counted here but add nothing to the totals. Azure reports no cost for a
              resource that has not been billed in this period, or that your account cannot read
              cost for — so this is a floor, not the full figure.
            </Callout>
          )}

          {servicesLoading ? (
            <Card><TableSkeleton rows={10} cols={4} /></Card>
          ) : (
            <Panel title={DIMENSIONS.find((d) => d.value === dimension)?.label} bodyClassName="">
              <DataTable
                rows={breakdown.map((b) => ({
                  id: b.key,
                  name: dimension === 'subscription' ? subName(b.key) : b.key,
                  cost: b.cost,
                  count: b.count,
                  share: breakdownTotal ? (b.cost / breakdownTotal) * 100 : null,
                }))}
                initialSort={{ key: 'cost', dir: 'desc' }}
                columns={[
                  {
                    key: 'name', header: 'Name', sortable: true,
                    render: (r) => <span className="text-slate-200">{r.name}</span>,
                  },
                  { key: 'count', header: 'Items', align: 'right', sortable: true },
                  {
                    key: 'share', header: 'Share', align: 'right', sortable: true,
                    render: (r) => (r.share == null ? '—' : (
                      <div className="flex items-center justify-end gap-2">
                        <div className="h-1.5 w-16 rounded-full bg-slate-800">
                          <div className="h-full rounded-full bg-blue-500" style={{ width: `${Math.min(100, r.share)}%` }} />
                        </div>
                        <span className="w-10 text-right text-xs text-slate-400">{r.share.toFixed(1)}%</span>
                      </div>
                    )),
                  },
                  {
                    key: 'cost', header: `Cost (${currency})`, align: 'right', sortable: true,
                    render: (r) => <Amount value={r.cost} currency={currency} />,
                  },
                ]}
                empty={(
                  <EmptyState
                    title="Nothing matches these filters"
                    description="Clear a filter to widen the breakdown."
                    actions={<Button size="sm" variant="secondary" onClick={() => setFilters(EMPTY_FILTERS)}>Clear filters</Button>}
                  />
                )}
              />
            </Panel>
          )}
        </div>
      )}

      {tab === 'resources' && (
        <div className="space-y-4">
          <BoqGenerator />

          {servicesLoading ? (
            <Card><TableSkeleton rows={12} cols={6} /></Card>
          ) : (
            <Panel title="Active resources" hint={`${filtered.length} of ${activeServices.length}`} bodyClassName="">
              <DataTable
                rows={filtered.map((r, i) => ({ ...r, id: `${r.name}-${i}` }))}
                initialSort={{ key: 'cost', dir: 'desc' }}
                columns={[
                  {
                    key: 'name', header: 'Name', sortable: true,
                    render: (r) => (
                      <span className="block max-w-[220px] truncate font-medium text-slate-200" title={r.name}>
                        {r.name}
                      </span>
                    ),
                  },
                  {
                    key: 'type', header: 'Type', sortable: true,
                    render: (r) => (
                      <span className="text-xs text-slate-400">
                        {SHORT_TYPE(r.type)}
                        {r.service && r.service !== r.type && (
                          <span className="block text-[10px] text-slate-600">{r.service}</span>
                        )}
                      </span>
                    ),
                  },
                  {
                    key: 'sku', header: 'SKU / size',
                    render: (r) => (r.sku || r.size || r.tier ? (
                      <span className="text-xs">
                        {r.sku && <Badge tone="neutral">{r.sku}</Badge>}
                        {r.size && <span className="ml-1.5 text-slate-300">{r.size}</span>}
                        {r.tier && <span className="block text-[10px] text-slate-600">{r.tier}</span>}
                      </span>
                    ) : <span className="text-slate-600">—</span>),
                  },
                  {
                    key: 'resource_group', header: 'Resource group', sortable: true,
                    render: (r) => <span className="text-xs text-slate-500">{r.resource_group || '—'}</span>,
                  },
                  {
                    key: 'location', header: 'Region', sortable: true,
                    render: (r) => <span className="text-xs text-slate-500">{r.location || '—'}</span>,
                  },
                  {
                    key: 'cost', header: `Cost (${currency})`, align: 'right', sortable: true,
                    render: (r) => (r.cost == null
                      ? <span className="text-slate-600" title="Azure reported no cost for this resource">—</span>
                      : <Amount value={r.cost} currency={currency} />),
                  },
                ]}
                empty={(
                  <EmptyState
                    title="No resources match"
                    description={activeServices.length
                      ? 'Clear a filter to see more.'
                      : 'No resources were returned. This usually means the account lacks Reader on these subscriptions.'}
                  />
                )}
              />
            </Panel>
          )}
        </div>
      )}
    </div>
  );
}
