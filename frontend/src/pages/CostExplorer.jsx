import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { TrendingUp, Layers, Bookmark, X, Search, Boxes, ChevronRight, GitCompareArrows, Network, RefreshCw, CalendarDays, SlidersHorizontal, RotateCcw } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { usePageRefresh } from '../store/usePageRefresh';
import { useFilteredCosts } from '../hooks/useFilteredCosts';
import DataQuality from '../components/Common/DataQuality';
import ReservationNote from '../components/Common/ReservationNote';
import CostTrendChart from '../components/Charts/CostTrendChart';
import CostDailyTimeline from '../components/Charts/CostDailyTimeline';
import CostChangeExplainer from '../components/Charts/CostChangeExplainer';
import CostDeltaDetails from '../components/Charts/CostDeltaDetails';
import ServiceCostDetails from '../components/Charts/ServiceCostDetails';
import MonthCompare from '../components/Charts/MonthCompare';
import { migrateExplorerView } from '../utils/monthCompare';
import { previousMonth } from '../utils/dailyTimeline';
import { monthByKey, servicesInMonth, unattributed } from '../utils/monthDrill';
import { hasTrendFilters, monthsFromRows, monthsFromSummary, summaryFilterSupported, rowCoverage } from '../utils/trendFilter';
import { groupsFromRows, groupsTotal } from '../utils/rgDrill';
import ServiceBreakdownChart from '../components/Charts/ServiceBreakdownChart';
import { Button as UiButton, Input as UiInput, NativeSelect, Label as UiLabel, TabsList } from '../components/shadcn';
import { Card as SCard, CardContent as SCardContent } from '../components/billing-ui/card';
import { SpendOverTime } from '../components/Charts/CostDashboardCharts';
import { CostStrip } from '../components/Layout/CostNavigation';
import { buildSeries } from '../utils/costDashboardSeries';
import { GROUP_BY_OPTIONS, groupByLabel, groupedMonthPeriods, groupNeedsRows, pricingMonthPeriods } from '../utils/explorerGroupBy';
import { formatAmount } from '../utils/currency';
import { Amount } from '../components/Common/Amount';
import { linearForecast, currentMonthKey } from '../utils/breakdown';
import {
  Button, Badge, Panel, Metric, SegmentedControl,
  Select, DataTable, EmptyState, ErrorState, Callout, TableSkeleton,
} from '../components/ui';

/*
 * Saved views are stored outside the API cache on purpose.
 *
 * `persistCache` expires anything it holds after a day and drops the lot when
 * the quota is hit — correct for a cached cost query, wrong for something the
 * user named and expects to find again next week.
 */
const VIEWS_KEY = 'aca:views:explorer';

/* Month Compare and Bandwidth used to be their own sidebar pages. They are the
 * same dataset seen from a different angle, and having them elsewhere meant
 * leaving the filters and the month you were looking at behind to reach them.
 *
 * Both are loaded lazily: each drags in its own panels and charts, and a reader
 * who only opens the trend tab should not pay to download either. */
const MonthVariance = lazy(() => import('./Compare'));
const ResourceGroupsReport = lazy(() => import('./ResourceGroups'));
const BandwidthTab = lazy(() => import('../components/Common/BandwidthTab'));
const BillingCategoryDetails = lazy(() => import('../components/Charts/BillingCategoryDetails'));
const DayDetails = lazy(() => import('../components/Charts/DayDetails'));
const ResourceGroupResources = lazy(() => import('../components/Charts/ResourceGroupResources'));

function TabLoading({ what }) {
  return <div role="status" className="p-6 text-sm text-slate-400">Loading {what}…</div>;
}


function readViews() {
  try {
    const raw = window.localStorage.getItem(VIEWS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed.map(migrateExplorerView) : [];
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
    costData, costLoading: costsPending, costError, loadCosts,
    activeServices, servicesError, loadServices,
    rowsData, rowsLoading: rowsPending, rowsError, loadCostRows,
    pricingData, pricingLoading, loadPricing,
    selectedTenantId, selectedSubscriptionIds, subscriptions, months, dateKey, dateMode, fromDate, toDate, imported,
  } = useAppStore();
  const costLoading = costsPending && !costData;

  const [searchParams, setSearchParams] = useSearchParams();
  const tab = migrateExplorerView({ tab: searchParams.get('tab') }).tab;
  const setTab = (next) => setSearchParams(previous => {
    const params = new URLSearchParams(previous);
    params.set('tab', migrateExplorerView({ tab: next }).tab);
    return params;
  });
  const [timeline, setTimeline] = useState('daily');
  // The compare tab holds two different questions: the full meter-by-meter
  // variance (its own page until it moved here) and a quick total-vs-total read
  // that honours the filter bar above. Neither subsumes the other.
  const [compareMode, setCompareMode] = useState('full');
  const [groupMode, setGroupMode] = useState('resources');
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [groupBy, setGroupBy] = useState('service');
  const [views, setViews] = useState(readViews);
  // The month whose services are open under the trend chart. Empty means the
  // reader has not asked, which is not the same as a month with no services.
  const [drillMonth, setDrillMonth] = useState('');
  // The resource group whose services are open. One at a time: a list where
  // every row can be expanded at once stops being a list you can compare.
  const [openGroup, setOpenGroup] = useState('');

  const subsKey = selectedSubscriptionIds.join(',');
  const filterRequest = useRef('');
  const loadFilterOptions = () => {
    const key = `${selectedTenantId}:${subsKey}:${dateKey}`;
    if (filterRequest.current === key && !servicesError) return;
    filterRequest.current = key;
    loadServices();
  };
  const quickCompare = tab === 'compare' && compareMode === 'quick';
  const filteredGroups = tab === 'groups' && groupMode === 'filtered';
  const needsMonthly = (tab === 'trend' && timeline === 'monthly') || filteredGroups || quickCompare;

  useEffect(() => {
    if (!needsMonthly) return;
    if (!selectedTenantId || !subsKey) return;
    loadCosts();
  }, [selectedTenantId, subsKey, dateKey, needsMonthly, loadCosts]);

  /* Meter rows are fetched only once something on screen needs them.
   *
   * They are by far the widest of the three queries -- every meter, every
   * month, across a window deliberately widened past the chosen range -- and
   * nothing renders from them until a filter is set or the groups tab is
   * opened. Loading them with the rest put that whole query on the critical
   * path of the first paint, so the page waited on detail for a click that
   * usually never came. */
  const trendFiltered = hasTrendFilters(filters);
  const usesServerFilters = trendFiltered && !summaryFilterSupported(filters) && !filters.search && !imported;
  const filteredResult = useFilteredCosts({ tenant_id: selectedTenantId,
    subscription_ids: filters.subscription ? [filters.subscription] : selectedSubscriptionIds,
    months, ...(dateMode === 'custom' ? { from_date: fromDate, to_date: toDate } : {}),
    service: filters.service || null, resource_group: filters.resource_group || null, location: filters.location || null,
    include_reservation_context: true,
  }, Boolean(needsMonthly && usesServerFilters && selectedTenantId && subsKey));
  const usesMeterRows = trendFiltered && !summaryFilterSupported(filters) && !usesServerFilters;
  const groupedTrend = tab === 'trend' && timeline === 'monthly' && groupBy !== 'none';
  const needsRows = (usesMeterRows && (quickCompare || (tab === 'trend' && timeline === 'monthly'))) || filteredGroups
    || (groupedTrend && !imported && groupNeedsRows(groupBy, costData?.months || []));
  const rowsLoading = (rowsPending && needsRows) || filteredResult.loading;
  const registerRefresh = usePageRefresh(s => s.register);
  const refreshFilteredCosts = filteredResult.refresh;
  const [comparisonRefreshing, setComparisonRefreshing] = useState(false);
  const comparisonRefresh = useRef(null);
  const refreshComparison = useCallback(() => {
    if (comparisonRefresh.current) return comparisonRefresh.current;
    setComparisonRefreshing(true);
    const pending = (async () => {
      if (imported) return useAppStore.getState().recomputeImported();
      if (compareMode === 'full') return loadCostRows({ force: true });
      if (usesServerFilters) return refreshFilteredCosts();
      // Quick compare reads the monthly summary; search-based comparisons
      // additionally require the selected-range meter detail.
      await loadCosts({ force: true });
      if (usesMeterRows) await loadCostRows({ force: true, selectedRange: true });
    })().finally(() => {
      comparisonRefresh.current = null;
      setComparisonRefreshing(false);
    });
    comparisonRefresh.current = pending;
    return pending;
  }, [compareMode, imported, usesServerFilters, usesMeterRows, refreshFilteredCosts, loadCostRows, loadCosts]);
  useEffect(() => {
    if (tab === 'compare') return registerRefresh(refreshComparison);
  }, [tab, registerRefresh, refreshComparison]);

  useEffect(() => {
    if (!needsRows) return;
    if (!selectedTenantId || !selectedSubscriptionIds.length) return;
    loadCostRows({ selectedRange: true });
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
    if (usesServerFilters) return filteredResult.data?.months || [];
    if (!usesMeterRows) return monthsFromSummary(monthly, filters);
    return monthsFromRows(rows, filters, { allowed: monthKeys, currency });
  }, [trendFiltered, usesMeterRows, usesServerFilters, filteredResult.data, monthly, rows, filters, monthKeys, currency]);

  // What share of the real total the meter rows account for. The API caps rows
  // on a large estate, so a filtered total is a floor -- and a reader watching
  // the line drop deserves to know that before concluding their spend fell.
  const coverage = useMemo(
    () => (usesMeterRows ? rowCoverage(rows, monthKeys, monthly) : null),
    [usesMeterRows, rows, monthKeys, monthly],
  );

  useEffect(() => {
    if (groupedTrend && groupBy === 'pricing_model' && !imported) loadPricing();
  }, [groupedTrend, groupBy, imported, loadPricing, dateKey, subsKey]);
  const groupedSeries = useMemo(() => (groupedTrend ? buildSeries(groupBy === 'pricing_model' ? pricingMonthPeriods(pricingData?.months || []) : groupedMonthPeriods({
    groupBy, months: trendMonths, rows, filters, names: Object.fromEntries((subscriptions || []).map(sub => [sub.subscription_id, sub.display_name])),
  })) : null), [groupedTrend, groupBy, trendMonths, rows, filters, subscriptions, pricingData]);
  const groupedFromRows = groupedTrend && groupNeedsRows(groupBy, trendMonths);

  const forecast = useMemo(
    // A forecast drawn from a filtered slice would project a subset as if it
    // were the bill, so it is offered only on the whole estate.
    () => (trendFiltered ? [] : linearForecast(monthly, 3, { currentMonth: thisMonth })),
    [trendFiltered, monthly, thisMonth],
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
    ...monthly.flatMap(month => Object.keys(month.by_service || {}).map(service => ({ service }))),
    ...subscriptions.filter(sub => selectedSubscriptionIds.includes(sub.subscription_id)).map(sub => ({ subscription_id: sub.subscription_id })),
    ...rows.map((r) => ({
      subscription_id: r.subscription_id,
      resource_group: r.resource_group,
      location: r.region,
      service: r.service,
    })),
  ]), [activeServices, rows, monthly, subscriptions, selectedSubscriptionIds]);

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
    return (id) => map.get(id) || 'Unnamed subscription';
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
      { name: name.trim(), tab, timeline, compareMode, groupMode, filters, groupBy, category: searchParams.get('category') || 'payg' },
    ]);
  };

  const applyView = (v) => {
    const migrated = migrateExplorerView(v);
    setSearchParams(previous => {
      const params = new URLSearchParams(previous);
      params.set('tab', migrated.tab);
      if (migrated.tab === 'billing') params.set('category', v.category || 'payg');
      return params;
    });
    setTimeline(migrated.timeline);
    setCompareMode(v.compareMode === 'quick' ? 'quick' : 'full');
    setGroupMode(['filtered', 'report'].includes(v.groupMode) ? v.groupMode : 'resources');
    setFilters({ ...EMPTY_FILTERS, ...(v.filters || {}) });
    setGroupBy(GROUP_BY_OPTIONS.some(o => o.value === v.groupBy) ? v.groupBy : 'service');
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
    { key: 'compare', label: 'Month compare', icon: GitCompareArrows },
    { key: 'bandwidth', label: 'Bandwidth', icon: Network },
    { key: 'billing', label: 'Billing categories', icon: Layers },
    { key: 'day', label: 'Day details', icon: CalendarDays },
  ];

  // The two moved-in tabs answer the header selection, not the filter bar, so
  // the filter bar is not shown pretending otherwise.
  const showFilters = tab === 'trend' || filteredGroups || quickCompare;

  return (
    <div className="mx-auto max-w-screen-2xl space-y-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-100">Cost Explorer</h1>
          <p className="mt-1 text-sm text-slate-400">
            Spend over time, split any way, down to the resource billing it.
          </p>
        </div>
        <UiButton variant="outline" size="sm" onClick={saveView}>
          <Bookmark aria-hidden="true" />
          Save view
        </UiButton>
      </header>

      <CostStrip />

      {/* Coverage sits with the figures, not in a console log. */}
      {needsMonthly && costError && <ErrorState title="Could not load monthly costs" message={costError} onRetry={loadCosts} />}
      {usesServerFilters && filteredResult.error && <ErrorState title="Could not load filtered costs" message={filteredResult.error} />}
      {usesServerFilters && <DataQuality coverage={filteredResult.data?.coverage} />}
      {needsRows && rowsError && <ErrorState title="Could not load cost detail" message={rowsError} onRetry={loadCostRows} />}

      {views.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-medium text-slate-500">Saved views</span>
          {views.map((v) => (
            <span
              key={v.name}
              className="inline-flex items-center gap-1 rounded-md border border-slate-700 bg-slate-900 pl-2.5 text-xs font-medium text-slate-300 shadow-sm"
            >
              <button onClick={() => applyView(v)} className="py-1.5 hover:text-[#c2410c]">
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

      <TabsList label="Cost Explorer views" items={tabs.map(t => ({ value: t.key, label: t.label, icon: t.icon, count: t.count }))} value={tab} onValueChange={setTab} />

      {tab === 'day' && <Suspense fallback={<TabLoading what="day details" />}><DayDetails /></Suspense>}

      {tab === 'billing' && <Suspense fallback={<TabLoading what="billing categories" />}><BillingCategoryDetails /></Suspense>}

      {/* Filters drive every tab, the trend included. The trend is re-summed
          from meter rows when a filter is set, so the narrowing is real rather
          than a control that appears to do nothing. */}
      {showFilters && (() => {
        const fields = [
          ['subscription', 'Subscription', optionsFor(filterSource, 'subscription_id', 'subscriptions')
            .filter(o => !o.value || selectedSubscriptionIds.includes(o.value))
            .map((o) => (o.value ? { ...o, label: subName(o.value) } : o))],
          ['resource_group', 'Resource group', optionsFor(filterSource, 'resource_group', 'groups')],
          ['location', 'Region', optionsFor(filterSource, 'location', 'regions')],
          ['service', 'Service', optionsFor(filterSource, 'service', 'services')],
        ];
        const dailyMode = tab === 'trend' && timeline === 'daily';
        const chips = [
          ...(filters.search ? [['search', `Search: ${filters.search}`]] : []),
          ...fields.filter(([key]) => filters[key]).map(([key, label, options]) => [key, `${label}: ${options.find(o => o.value === filters[key])?.label || filters[key]}`]),
        ];
        return (
          <SCard onFocusCapture={loadFilterOptions}>
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-4 py-3 sm:px-5">
              <div className="flex items-center gap-2">
                <SlidersHorizontal className="h-4 w-4 text-[#ea580c]" aria-hidden="true" />
                <h2 className="text-sm font-semibold text-slate-100">Filters</h2>
                {activeFilterCount > 0 && <span className="rounded-full bg-[#ffedd5] px-2 py-0.5 text-[11px] font-semibold text-[#9a3412]">{activeFilterCount} active</span>}
              </div>
              <UiButton variant="ghost" size="sm" disabled={!activeFilterCount} onClick={() => setFilters(EMPTY_FILTERS)}>
                <RotateCcw aria-hidden="true" />Reset filters
              </UiButton>
            </div>
            <SCardContent className="space-y-4 p-4 sm:p-5">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-[minmax(14rem,1.3fr)_repeat(4,minmax(0,1fr))]">
                <div className="space-y-1.5 sm:col-span-2 lg:col-span-3 2xl:col-span-1">
                  <UiLabel htmlFor="explorer-search">Search</UiLabel>
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" aria-hidden="true" />
                    <UiInput id="explorer-search" value={filters.search} onChange={(e) => setFilters({ ...filters, search: e.target.value })} placeholder="Resource, service, meter…" className="pl-8 pr-8" />
                    {filters.search && <button type="button" aria-label="Clear search" onClick={() => setFilters({ ...filters, search: '' })} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-slate-500 hover:text-slate-200"><X className="h-4 w-4" /></button>}
                  </div>
                </div>
                {fields.map(([key, label, options]) => (
                  <div key={key} className="min-w-0 space-y-1.5">
                    <UiLabel htmlFor={`explorer-filter-${key}`}>{label}</UiLabel>
                    <NativeSelect id={`explorer-filter-${key}`} value={filters[key]} onChange={(e) => setFilters({ ...filters, [key]: e.target.value })} className={filters[key] ? 'border-[#fdba74]' : ''}>
                      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </NativeSelect>
                  </div>
                ))}
              </div>
              {tab === 'trend' && (
                <div className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-800 bg-slate-950/40 p-3">
                  <div className="space-y-1.5">
                    <UiLabel className="flex items-center gap-1.5"><CalendarDays className="h-3.5 w-3.5 text-[#ea580c]" aria-hidden="true" />View</UiLabel>
                    <TabsList
                      size="sm"
                      label="Timeline granularity"
                      className="bg-slate-800/70"
                      items={[{ value: 'daily', label: 'Daily', icon: CalendarDays }, { value: 'monthly', label: 'Monthly', icon: TrendingUp }]}
                      value={timeline}
                      onValueChange={setTimeline}
                    />
                  </div>
                  <div className="min-w-[12rem] flex-1 space-y-1.5 sm:max-w-xs">
                    <UiLabel htmlFor="explorer-group-by" className="flex items-center gap-1.5"><Layers className="h-3.5 w-3.5 text-[#ea580c]" aria-hidden="true" />Group by</UiLabel>
                    <NativeSelect id="explorer-group-by" value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
                      {GROUP_BY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </NativeSelect>
                  </div>
                  <p className="flex-1 text-xs leading-5 text-slate-500">
                    {groupBy === 'none'
                      ? 'Showing totals only. Pick a dimension to stack the spend chart by it.'
                      : `Stacks the ${dailyMode ? 'daily' : 'monthly'} spend chart by ${groupByLabel(groupBy).toLowerCase()}. Top six shown, the rest grouped as Other.`}
                  </p>
                </div>
              )}
              {chips.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-slate-500">Applied:</span>
                  {chips.map(([key, text]) => (
                    <span key={key} className="inline-flex max-w-full items-center gap-1 rounded-full border border-[#fdba74] bg-[#ffedd5] py-0.5 pl-2.5 pr-1 text-xs font-medium text-[#9a3412]">
                      <span className="truncate">{text}</span>
                      <button type="button" aria-label={`Remove ${text}`} onClick={() => setFilters({ ...filters, [key]: '' })} className="rounded-full p-0.5 hover:bg-[#fed7aa]"><X className="h-3 w-3" /></button>
                    </span>
                  ))}
                </div>
              )}
            </SCardContent>
          </SCard>
        );
      })()}

      {tab === 'bandwidth' && (
        <Suspense fallback={<TabLoading what="the bandwidth report" />}>
          <BandwidthTab resetKey={`${selectedTenantId}:${subsKey}:${dateKey}`} />
        </Suspense>
      )}

      {servicesError && showFilters && tab !== 'trend' && (
        <ErrorState title="Could not load resources" message={servicesError} onRetry={loadServices} />
      )}

      {tab === 'trend' && (
        <div className="space-y-5">
          {timeline === 'daily' ? <CostDailyTimeline filters={filters} groupBy={groupBy} /> : <>
          {trendFiltered && !usesMeterRows && <Callout tone="info" title="Filtered Azure summary">{usesServerFilters ? 'These filters are applied by Azure Cost Management to the selected dates and subscriptions.' : 'Service-only and subscription-only amounts come directly from the same monthly summary as Dashboard.'} All figures below follow your selection.</Callout>}
          {filters.service === 'Bandwidth' && <Callout tone="info" title="Bandwidth service scope">This filter selects the Azure service named Bandwidth. The Bandwidth tab includes transfer-related meters under other services too; it is a broader total.</Callout>}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Metric label="Actual cost in selected range" value={trendMonths.length ? fmt(trendMonths.reduce((sum, month) => sum + (month.total_cost || 0), 0)) : null} loading={costLoading || rowsLoading} hint={trendFiltered ? 'Selected filters · full range' : 'Same monthly totals as Dashboard'} />
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
          {usesMeterRows && !rowsLoading && (
            <Callout
              tone={coverage !== null && coverage < 0.95 ? 'medium' : 'info'}
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

          {usesMeterRows && rowsLoading && (
            <Callout tone="info" title="Fetching the detail behind the totals">
              Filtering the trend needs the individual meter rows. The chart will narrow
              once they arrive.
            </Callout>
          )}

          {groupedSeries && (
            <SpendOverTime
              key={`${dateKey}:${groupBy}`}
              series={groupedSeries}
              daily={false}
              groupLabel={groupByLabel(groupBy)}
              description={`Each month in the selected period, split by ${groupByLabel(groupBy).toLowerCase()}. Hover a month for the breakdown.${groupedFromRows ? ' Built from meter rows, so totals can sit slightly below the invoice.' : ''}`}
              loading={costLoading || (groupedFromRows && rowsLoading) || (groupBy === 'pricing_model' && pricingLoading)}
              error={costError}
              currency={currency}
              onRetry={() => loadCosts({ force: true })}
            />
          )}

          <Panel
            title={`Monthly spend (${trendMonths.length} returned ${trendMonths.length === 1 ? 'month' : 'months'})`}
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
            <Select label="Inspect month" value={drillMonth} onChange={setDrillMonth}
              options={[{ value: '', label: 'Choose a month' }, ...trendMonths.map(m => ({ value: m.month, label: m.month }))]} />
          </Panel>

          {drillMonth && !costLoading && !(trendFiltered && rowsLoading) && (
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
              {drillMonth === thisMonth && <Callout tone="medium" title="Current month is partial">This month is still being billed; comparison with a completed month is not like-for-like.</Callout>}
              <CostChangeExplainer current={drillMonthRow} prior={monthByKey(trendMonths, previousMonth(drillMonth))}
                label={drillMonth} priorLabel={previousMonth(drillMonth)} currency={currency} totalKey="total_cost"
                partial={drillMonth === thisMonth} priorPartial={previousMonth(drillMonth) === thisMonth} />
              <CostDeltaDetails current={drillMonthRow} prior={monthByKey(trendMonths, previousMonth(drillMonth))}
                label={drillMonth} priorLabel={previousMonth(drillMonth)} currency={currency} totalKey="total_cost" />
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
            <ServiceBreakdownChart months={trendMonths} loading={costLoading || (trendFiltered && rowsLoading)} currency={currency} />
          </Panel>
          {!costLoading && !rowsLoading && <ServiceCostDetails periods={trendMonths} currency={currency} filters={filters}
            query={imported || filters.location ? null : { tenant_id: selectedTenantId,
              subscription_ids: filters.subscription ? [filters.subscription] : selectedSubscriptionIds,
              months, ...(dateMode === 'custom' ? { from_date: fromDate, to_date: toDate } : {}),
            }} />}

          <Panel title="Month-over-month" bodyClassName="">
            {costLoading || (trendFiltered && rowsLoading) ? (
              <TableSkeleton rows={6} cols={5} />
            ) : (
              <DataTable
                rows={trendMonths.map((m) => {
                  const prev = monthByKey(trendMonths, previousMonth(m.month));
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
                        <ReservationNote period={monthByKey(trendMonths, r.month)} currency={currency} compact />
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
          </>}
        </div>
      )}

      {tab === 'groups' && <>
        <nav aria-label="Resource group views" className="flex flex-wrap items-center gap-x-1 text-sm text-slate-500">
          {[['resources', 'Resources & payment type'], ['report', 'Costs & history'], ['filtered', 'Filtered service breakdown']].map(([value, text], index) => (
            <span key={value} className="inline-flex items-center gap-x-1">
              {index > 0 && <span aria-hidden="true" className="px-1 text-slate-700">·</span>}
              <button type="button" aria-current={groupMode === value ? 'page' : undefined} onClick={() => setGroupMode(value)}
                className={`rounded px-0.5 transition hover:text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ea580c] ${groupMode === value ? 'font-semibold text-slate-100' : ''}`}>{text}</button>
            </span>
          ))}
        </nav>
        {groupMode === 'resources' && <Suspense fallback={<TabLoading what="resource groups" />}>
          <ResourceGroupResources key={`${selectedTenantId}:${subsKey}:${dateKey}`} />
        </Suspense>}
        {groupMode === 'report' && <Suspense fallback={<TabLoading what="resource groups" />}>
          <ResourceGroupsReport embedded key={`${selectedTenantId}:${subsKey}:${dateKey}`} />
        </Suspense>}
      </>}

      {filteredGroups && (
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

      {tab === 'compare' && (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
          <SegmentedControl
            options={[
              { value: 'full', label: 'Full variance' },
              { value: 'quick', label: 'Quick compare (uses filters)' },
            ]}
            value={compareMode}
            onChange={setCompareMode}
          />
          <Button variant="secondary" size="sm" icon={RefreshCw}
            onClick={refreshComparison} disabled={comparisonRefreshing}
            aria-busy={comparisonRefreshing}>
            {comparisonRefreshing ? 'Refreshing comparison…' : 'Refresh comparison'}
          </Button>
          </div>
          {compareMode === 'full' ? (
            <Suspense fallback={<TabLoading what="the month-by-month variance" />}>
              <MonthVariance embedded />
            </Suspense>
          ) : (
            <MonthCompare
              months={trendMonths}
              currency={currency}
              loading={costLoading || (trendFiltered && rowsLoading)}
              filtered={trendFiltered}
              coverage={coverage}
              currentMonth={thisMonth}
            />
          )}
        </div>
      )}

    </div>
  );
}
