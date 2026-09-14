import { useEffect, useMemo, useState } from 'react';
import { TrendingUp, Layers, Server, Bookmark, X, Search, Boxes, ChevronRight } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import DataQuality from '../components/Common/DataQuality';
import CostTrendChart from '../components/Charts/CostTrendChart';
import { monthByKey, servicesInMonth, unattributed } from '../utils/monthDrill';
import { hasTrendFilters, monthsFromRows, rowCoverage } from '../utils/trendFilter';
import { groupsFromRows, groupsTotal } from '../utils/rgDrill';
import ServiceBreakdownChart from '../components/Charts/ServiceBreakdownChart';
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
    rowsData, rowsLoading, loadCostRows,
    selectedTenantId, selectedSubscriptionIds, subscriptions, months, dateKey,
  } = useAppStore();

  const [tab, setTab] = useState('trend');
  const [dimension, setDimension] = useState('service');
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [views, setViews] = useState(readViews);
  // The month whose services are open under the trend chart. Empty means the
  // reader has not asked, which is not the same as a month with no services.
  const [drillMonth, setDrillMonth] = useState('');
  // The resource group whose services are open. One at a time: a list where
  // every row can be expanded at once stops being a list you can compare.
  const [openGroup, setOpenGroup] = useState('');

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

  /* Meter rows are fetched only once something on screen needs them.
   *
   * They are by far the widest of the three queries -- every meter, every
   * month, across a window deliberately widened past the chosen range -- and
   * nothing renders from them until a filter is set or the groups tab is
   * opened. Loading them with the rest put that whole query on the critical
   * path of the first paint, so the page waited on detail for a click that
   * usually never came. */
  const trendFiltered = hasTrendFilters(filters);
  const needsRows = trendFiltered || tab === 'groups';

  useEffect(() => {
    if (!needsRows) return;
    if (!selectedTenantId || !selectedSubscriptionIds.length) return;
    loadCostRows();
  }, [needsRows, selectedTenantId, subsKey, dateKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const monthly = useMemo(() => costData?.months || [], [costData]);
  const currency = monthly[0]?.currency || costData?.currency || activeServices[0]?.currency || 'INR';
  const fmt = (v) => formatAmount(v, currency);
  const thisMonth = currentMonthKey();

  /* ── the trend, filtered ────────────────────────────────────────────
     Unfiltered, the chart shows Azure's own monthly totals. Filtered, it is
     re-summed from the meter rows behind them, which is the only source that
     knows a row's month, service, group, subscription and region at once.

     Deliberately not the other way round: re-deriving an unfiltered total we
     were handed directly would only create a chance to disagree with Azure. */
  const rows = useMemo(() => rowsData?.rows || [], [rowsData]);
  const monthKeys = useMemo(() => monthly.map((m) => m.month), [monthly]);

  const trendMonths = useMemo(() => {
    if (!trendFiltered) return monthly;
    return monthsFromRows(rows, filters, { allowed: monthKeys, currency });
  }, [trendFiltered, monthly, rows, filters, monthKeys, currency]);

  // What share of the real total the meter rows account for. The API caps rows
  // on a large estate, so a filtered total is a floor -- and a reader watching
  // the line drop deserves to know that before concluding their spend fell.
  const coverage = useMemo(
    () => (trendFiltered ? rowCoverage(rows, monthKeys, monthly) : null),
    [trendFiltered, rows, monthKeys, monthly],
  );

  const forecast = useMemo(
    // A forecast drawn from a filtered slice would project a subset as if it
    // were the bill, so it is offered only on the whole estate.
    () => (trendFiltered ? [] : linearForecast(monthly, 3, { currentMonth: thisMonth })),
    [trendFiltered, monthly, thisMonth],
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

  /* Resource groups, and what is inside them. Summed from the same rows the
     trend uses, so the two tabs cannot disagree about a group's cost. */
  const groups = useMemo(
    () => groupsFromRows(rows, filters, { allowed: monthKeys }),
    [rows, filters, monthKeys],
  );
  const groupsSum = useMemo(() => groupsTotal(groups), [groups]);

  /* What the dropdowns are allowed to offer.
   *
   * The resource list alone is not enough. A charge can name a group or region
   * that no priced resource does -- deleted resources still bill for the days
   * they ran -- and on the trend tab the resource list may not have arrived
   * yet, which would leave every dropdown empty next to a chart full of data.
   * Rows contribute the same four fields under the cost API's own names. */
  const filterSource = useMemo(() => ([
    ...activeServices,
    ...rows.map((r) => ({
      subscription_id: r.subscription_id,
      resource_group: r.resource_group,
      location: r.region,
      service: r.service,
    })),
  ]), [activeServices, rows]);

  // Read from the filtered months, not the raw ones: a drill-down that ignored
  // the filter would contradict the chart the reader clicked on.
  const drillMonthRow = useMemo(() => monthByKey(trendMonths, drillMonth), [trendMonths, drillMonth]);
  const drillRows = useMemo(() => servicesInMonth(drillMonthRow), [drillMonthRow]);
  const drillTotal = useMemo(
    () => drillRows.reduce((sum, r) => sum + r.cost, 0),
    [drillRows],
  );
  const drillGap = useMemo(() => unattributed(drillMonthRow), [drillMonthRow]);

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
    { key: 'groups', label: 'Resource groups', icon: Boxes, count: groups.length || null },
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

      {/* Filters drive every tab, the trend included. The trend is re-summed
          from meter rows when a filter is set, so the narrowing is real rather
          than a control that appears to do nothing. */}
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
              options={optionsFor(filterSource, 'subscription_id', 'subscriptions')
                .map((o) => (o.value ? { ...o, label: subName(o.value) } : o))}
            />
            <Select
              label="Resource group"
              value={filters.resource_group}
              onChange={(v) => setFilters({ ...filters, resource_group: v })}
              options={optionsFor(filterSource, 'resource_group', 'groups')}
            />
            <Select
              label="Region"
              value={filters.location}
              onChange={(v) => setFilters({ ...filters, location: v })}
              options={optionsFor(filterSource, 'location', 'regions')}
            />
            <Select
              label="Service"
              value={filters.service}
              onChange={(v) => setFilters({ ...filters, service: v })}
              options={optionsFor(filterSource, 'service', 'services')}
            />
          </FilterBar>
      </Card>

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
              label={trendFiltered ? 'Latest month (filtered)' : 'Latest month'}
              value={trendMonths.length ? fmt(trendMonths.at(-1).total_cost) : null}
              hint={monthly.at(-1)?.month === thisMonth ? 'Still being billed' : undefined}
              loading={costLoading || (trendFiltered && rowsLoading)}
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

          {forecast.length === 0 && !trendFiltered && !costLoading && monthly.length > 0 && (
            <Callout tone="info" title="Not enough history to project">
              A forecast needs at least three complete billing months. Widen the date range in
              the header and this will fill in.
            </Callout>
          )}

          {/* A filtered line is a slice of the bill, and slices are read from
              meter rows rather than Azure's own totals. Both facts change what
              the number means, so both are said rather than left to be
              discovered by someone wondering why their spend dropped. */}
          {trendFiltered && !rowsLoading && (
            <Callout
              tone={coverage !== null && coverage < 0.95 ? 'warn' : 'info'}
              title="Showing a filtered slice of the bill"
            >
              The chart is re-summed from meter rows that match your filters, so it no
              longer matches the invoice total. Forecasting is off while a filter is set.
              {coverage !== null && coverage < 0.95 && (
                <> Meter rows cover about {Math.round(coverage * 100)}% of the real total for
                  this range, so treat the filtered figures as a floor.</>
              )}
            </Callout>
          )}

          {trendFiltered && rowsLoading && (
            <Callout tone="info" title="Fetching the detail behind the totals">
              Filtering the trend needs the individual meter rows. The chart will narrow
              once they arrive.
            </Callout>
          )}

          <Panel
            title={`Monthly spend${months ? ` (${months} months)` : ''}`}
            hint="The dashed line is a straight-line projection from completed months, not an Azure forecast."
          >
            <CostTrendChart
              months={trendMonths}
              loading={costLoading || (trendFiltered && rowsLoading)}
              currency={currency}
              forecast={forecast}
              onSelectMonth={setDrillMonth}
              selectedMonth={drillMonth}
            />
            <p className="mt-2 text-[11px] text-slate-500">
              Click any month to see the services billed in it.
            </p>
          </Panel>

          {drillMonth && (
            <Panel
              title={`What made ${drillMonth}`}
              actions={(
                <button
                  type="button"
                  onClick={() => setDrillMonth('')}
                  className="text-xs text-slate-400 transition hover:text-white"
                >
                  Close
                </button>
              )}
            >
              {!drillRows.length ? (
                <p className="py-6 text-center text-sm text-slate-500">
                  Azure returned no service breakdown for this month.
                </p>
              ) : (
                <>
                  <div className="space-y-1.5">
                    {drillRows.map((row) => (
                      <div key={row.name} className="flex items-center gap-3 text-xs">
                        <span className="flex-1 truncate text-slate-300" title={row.name}>
                          {row.name}
                        </span>
                        <div className="hidden h-1.5 w-28 rounded-full bg-slate-800 sm:block">
                          <div
                            className="h-1.5 rounded-full bg-blue-500"
                            style={{ width: `${row.share === null ? 0 : row.share}%` }}
                          />
                        </div>
                        <span className="w-24 text-right font-medium tabular-nums text-white">
                          {fmt(row.cost)}
                        </span>
                        <span className="w-12 text-right tabular-nums text-slate-500">
                          {row.share === null ? '—' : `${row.share.toFixed(1)}%`}
                        </span>
                      </div>
                    ))}
                  </div>
                  {drillGap !== 0 && (
                    <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
                      These services account for {fmt(drillTotal)} of the month&rsquo;s
                      {' '}{fmt(drillMonthRow?.total_cost || 0)}. The remaining {fmt(drillGap)}
                      {' '}carries no service name in Azure&rsquo;s grouped totals, so it can be
                      counted but not attributed.
                    </p>
                  )}
                </>
              )}
            </Panel>
          )}

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

      {tab === 'groups' && (
        <div className="space-y-4">
          {rowsLoading && groups.length === 0 && <TableSkeleton rows={8} />}

          {!rowsLoading && groups.length === 0 && (
            <EmptyState
              title="No resource groups to show"
              message={
                activeFilterCount
                  ? 'No charges match the current filters. Clear one and try again.'
                  : 'Meter rows are what name a resource group. None came back for this range.'
              }
            />
          )}

          {groups.length > 0 && (
            <Panel
              title="Spend by resource group"
              hint="Open a group to see the services billing inside it. Totals come from meter rows, so they follow the filters above."
              actions={(
                <span className="text-xs text-slate-500">
                  {groups.length} {groups.length === 1 ? 'group' : 'groups'} · {fmt(groupsSum)}
                </span>
              )}
            >
              <div className="divide-y divide-slate-800">
                {groups.map((g) => {
                  const open = openGroup === g.name;
                  return (
                    <div key={g.name}>
                      <button
                        type="button"
                        onClick={() => setOpenGroup(open ? '' : g.name)}
                        aria-expanded={open}
                        className="flex w-full items-center gap-3 py-2.5 text-left transition hover:bg-slate-900/60"
                      >
                        <ChevronRight
                          className={`h-4 w-4 shrink-0 text-slate-600 transition-transform ${open ? 'rotate-90' : ''}`}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm text-slate-200">{g.name}</div>
                          <div className="text-[11px] text-slate-500">
                            {g.serviceCount} {g.serviceCount === 1 ? 'service' : 'services'}
                            {/* Only worth saying when it is true: a group name
                                repeated across subscriptions is two groups. */}
                            {g.subscriptions.length > 1 && (
                              <> · in {g.subscriptions.length} subscriptions</>
                            )}
                          </div>
                        </div>
                        <div className="hidden w-40 shrink-0 sm:block">
                          <div className="h-1.5 overflow-hidden rounded-full bg-slate-800">
                            <div
                              className="h-full rounded-full bg-blue-500"
                              style={{ width: `${Math.round((g.share || 0) * 100)}%` }}
                            />
                          </div>
                        </div>
                        <div className="w-16 shrink-0 text-right text-[11px] text-slate-500">
                          {g.share === null ? '—' : `${(g.share * 100).toFixed(1)}%`}
                        </div>
                        <div className="w-28 shrink-0 text-right text-sm tabular-nums text-slate-200">
                          <Amount value={g.cost} currency={currency} />
                        </div>
                      </button>

                      {open && (
                        <div className="border-l-2 border-slate-800 pb-3 pl-7">
                          {g.services.map((s) => (
                            <div key={s.name} className="flex items-center gap-3 py-1.5">
                              <div className="min-w-0 flex-1 truncate text-[13px] text-slate-400">
                                {s.name}
                              </div>
                              <div className="w-16 shrink-0 text-right text-[11px] text-slate-600">
                                {s.share === null ? '—' : `${(s.share * 100).toFixed(1)}%`}
                              </div>
                              <div className="w-28 shrink-0 text-right text-[13px] tabular-nums text-slate-300">
                                <Amount value={s.cost} currency={currency} />
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </Panel>
          )}
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
