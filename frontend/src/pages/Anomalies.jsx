import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowDown, ArrowUp, Download, RefreshCw, Search,
  TrendingUp, TrendingDown, Sparkles, CircleSlash, Minus, Loader2, Info,
} from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { analyzeAnomalies } from '../api/client';
import { friendlyError } from '../utils/apiError';
import { formatAmount } from '../utils/currency';
import { downloadCsv, timestampedName } from '../utils/csv';
import AnomalyDrawer from '../components/Anomalies/AnomalyDrawer';
import {
  applyFilters, sortRows, paginate, summarise, severityCounts, toExportRows,
  severityLabel, severityHint, directionLabel, filtersToParams, filtersFromParams,
  DEFAULT_FILTERS, SEVERITIES, STATUSES,
  SORT_IMPACT, SORT_PCT, SORT_CURRENT, SORT_SERVICE,
  ROLLING_MONTHS, monthOptions, monthBounds, periodValue, periodLabel,
  todayIso, rangeError,
} from '../utils/anomalyView';

const PAGE_SIZE = 25;

/**
 * Results survive navigating away and back.
 *
 * Without this, opening a finding, walking over to Cost Explorer to check it,
 * and coming back means waiting through the whole Cost Management query again
 * -- which on nine subscriptions is long enough that people stop cross-
 * checking, which is the one habit this page exists to encourage.
 */
const cache = new Map();

const SEVERITY_STYLE = {
  critical: 'border-red-500/40 bg-red-950/40 text-red-300',
  high: 'border-orange-500/40 bg-orange-950/40 text-orange-300',
  medium: 'border-amber-500/40 bg-amber-950/40 text-amber-300',
  low: 'border-slate-600/40 bg-slate-900 text-slate-400',
  none: 'border-slate-700/40 bg-slate-900 text-slate-500',
};

const DIRECTION_ICON = {
  increase: TrendingUp, decrease: TrendingDown,
  new: Sparkles, removed: CircleSlash, flat: Minus,
};

const STATUS_LABEL = {
  new: 'Not looked at yet',
  investigating: 'Being looked into',
  acknowledged: 'Known and expected',
  resolved: 'Dealt with',
  ignored: 'Not worth chasing',
};

const COMPARISONS = [
  { value: 'previous_month', label: 'The month before' },
  { value: 'previous_period', label: 'The period before this one' },
  { value: 'same_month_last_year', label: 'The same month last year' },
];

/** A figure, or an honest statement that there is no figure. */
function Kpi({ label, value, sub, tone = 'text-white' }) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
      <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{label}</p>
      {value == null ? (
        <p className="mt-1 text-base text-slate-500">Not available</p>
      ) : (
        <p className={`mt-1 text-2xl font-bold ${tone}`}>{value}</p>
      )}
      {sub && <p className="mt-1 text-xs text-slate-500">{sub}</p>}
    </div>
  );
}

export default function Anomalies() {
  const {
    selectedTenantId, selectedSubscriptionIds, dateMode, fromDate, toDate, dateKey,
    months, setMonths, setCustomDateRange,
  } = useAppStore();

  const [comparison, setComparison] = useState('previous_month');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [loadedAt, setLoadedAt] = useState(null);

  const [filters, setFilters] = useState(() => filtersFromParams(window.location.search));
  const [searchInput, setSearchInput] = useState(() => filtersFromParams(window.location.search).search);
  const [sortKey, setSortKey] = useState(SORT_IMPACT);
  const [ascending, setAscending] = useState(false);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(null);

  const subKey = selectedSubscriptionIds.join(',');
  const cacheKey = `${selectedTenantId}|${subKey}|${dateKey}|${comparison}`;
  const requestId = useRef(0);

  const load = useCallback(async (force = false) => {
    if (!selectedTenantId || selectedSubscriptionIds.length === 0) {
      setData(null);
      return;
    }
    if (!force && cache.has(cacheKey)) {
      const hit = cache.get(cacheKey);
      setData(hit.data);
      setLoadedAt(hit.at);
      setError('');
      return;
    }
    const id = ++requestId.current;
    setLoading(true);
    setError('');
    try {
      const result = await analyzeAnomalies({
        tenant_id: selectedTenantId,
        subscription_ids: selectedSubscriptionIds,
        comparison,
        ...(dateMode === 'custom' && fromDate && toDate ? { from_date: fromDate, to_date: toDate } : {}),
      });
      // A slower earlier request must not overwrite a newer answer.
      if (id !== requestId.current) return;
      const at = new Date().toISOString();
      cache.set(cacheKey, { data: result, at });
      setData(result);
      setLoadedAt(at);
    } catch (e) {
      if (id !== requestId.current) return;
      // Deliberately not clearing `data`: stale figures with a visible
      // "last updated" beat an empty page, as long as the staleness is stated.
      setError(friendlyError(e));
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [selectedTenantId, selectedSubscriptionIds, cacheKey, comparison, dateMode, fromDate, toDate]);

  useEffect(() => { load(); }, [load]);

  // Debounced so typing does not re-filter a few thousand rows per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => ({ ...f, search: searchInput })), 200);
    return () => clearTimeout(t);
  }, [searchInput]);

  // A filtered view is something people paste into a message. Keeping it in
  // the URL is what makes that link show the recipient the same thing.
  useEffect(() => {
    const qs = new URLSearchParams(filtersToParams(filters)).toString();
    const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
    window.history.replaceState(null, '', url);
  }, [filters]);

  useEffect(() => { setPage(1); }, [filters, sortKey, ascending]);

  const allRows = useMemo(() => {
    if (!data) return [];
    // New and stopped costs belong in the same table: a service that appeared
    // from nothing is the single most common real surprise on a bill, and the
    // old rule skipped it entirely because it could not compute a percentage.
    return [
      ...(data.anomalies || []),
      ...(data.new_costs || []),
      ...(data.removed_costs || []),
      ...(data.reductions || []),
    ];
  }, [data]);

  const currency = data?.currency || 'INR';
  const filtered = useMemo(() => applyFilters(allRows, filters), [allRows, filters]);
  const sorted = useMemo(() => sortRows(filtered, sortKey, ascending), [filtered, sortKey, ascending]);
  const paged = useMemo(() => paginate(sorted, page, PAGE_SIZE), [sorted, page]);
  // Every card, the chart and the table read from `filtered`. A KPI computed
  // from the unfiltered list above a filtered table is how a cost page starts
  // contradicting itself.
  const stats = useMemo(() => summarise(filtered), [filtered]);
  const counts = useMemo(() => severityCounts(filtered), [filtered]);

  const subscriptionOptions = useMemo(() => {
    const seen = new Map();
    for (const r of allRows) {
      if (r.subscription_id && !seen.has(r.subscription_id)) {
        seen.set(r.subscription_id, r.subscription_name || r.subscription_id);
      }
    }
    return [...seen.entries()];
  }, [allRows]);

  const setFilter = (key, value) => setFilters((f) => ({ ...f, [key]: value }));

  const toggleSort = (key) => {
    if (key === sortKey) setAscending((a) => !a);
    else { setSortKey(key); setAscending(key === SORT_SERVICE); }
  };

  const onStatusChange = (key, status) => {
    setData((d) => {
      if (!d) return d;
      const patch = (list) => (list || []).map((r) => (r.anomaly_key === key ? { ...r, status } : r));
      const next = {
        ...d,
        anomalies: patch(d.anomalies),
        new_costs: patch(d.new_costs),
        removed_costs: patch(d.removed_costs),
        reductions: patch(d.reductions),
      };
      cache.set(cacheKey, { data: next, at: loadedAt });
      return next;
    });
    setSelected((s) => (s && s.anomaly_key === key ? { ...s, status } : s));
  };

  const exportCsv = () => downloadCsv(toExportRows(sorted, currency), timestampedName('cost-changes'));

  /* The period picker writes to the same store the Topbar date pill does, so
     the two controls can never describe different figures. */
  const period = periodValue(dateMode, months, fromDate, toDate);
  const months12 = useMemo(() => monthOptions(new Date(), 12), []);

  /* The from/to boxes are a draft until applied. Refetching on every keystroke
     would fire a Cost Management query for half-typed years like 0202. */
  const [showRange, setShowRange] = useState(period === 'custom');
  const [draftFrom, setDraftFrom] = useState(fromDate || '');
  const [draftTo, setDraftTo] = useState(toDate || '');
  const maxDate = todayIso();
  const draftError = rangeError(draftFrom, draftTo);

  const onPeriodChange = (value) => {
    if (value === 'range') { setShowRange(true); return; }
    setShowRange(false);
    if (value.startsWith('rolling:')) { setMonths(Number(value.slice(8))); return; }
    if (value.startsWith('month:')) {
      const bounds = monthBounds(value.slice(6));
      if (bounds) setCustomDateRange(bounds.from, bounds.to);
    }
  };

  const applyRange = () => {
    if (draftError) return;
    setCustomDateRange(draftFrom, draftTo);
  };

  const window_ = data?.window;
  const errors = data?.coverage?.errors || [];
  const noSelection = !selectedTenantId || selectedSubscriptionIds.length === 0;

  const SortHeader = ({ label, sortKey: key, className = '' }) => (
    <th className={`px-3 py-2 text-left font-medium ${className}`}>
      <button
        type="button"
        onClick={() => toggleSort(key)}
        className="inline-flex items-center gap-1 text-slate-400 transition hover:text-white"
      >
        {label}
        {sortKey === key && (ascending ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
      </button>
    </th>
  );

  return (
    <div className="mx-auto max-w-screen-2xl space-y-5 p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Cost Anomalies &amp; Savings Center</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-400">
            Every service whose cost moved between this period and the one you compare it against,
            ranked by how much money moved.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={showRange ? 'range' : period}
            onChange={(e) => onPeriodChange(e.target.value)}
            title="Which period is analysed. Shared with the date filter in the header."
            className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white focus:border-blue-500 focus:outline-none"
          >
            <optgroup label="Rolling">
              {ROLLING_MONTHS.map((n) => (
                <option key={n} value={`rolling:${n}`}>Period: Last {n} months</option>
              ))}
            </optgroup>
            <optgroup label="A single month">
              {months12.map((m) => (
                <option key={m.value} value={`month:${m.value}`}>Period: {m.label}</option>
              ))}
            </optgroup>
            <optgroup label="Exact dates">
              <option value="range">Period: Custom date range…</option>
            </optgroup>
          </select>
          <select
            value={comparison}
            onChange={(e) => setComparison(e.target.value)}
            title="What that period is measured against."
            className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white focus:border-blue-500 focus:outline-none"
          >
            {COMPARISONS.map((c) => <option key={c.value} value={c.value}>Compare with: {c.label}</option>)}
          </select>
          <button
            type="button"
            onClick={exportCsv}
            disabled={!sorted.length}
            title="Downloads a CSV of the rows currently listed below, in the order shown — your search, severity and status filters are applied."
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-2 text-xs font-medium text-slate-300 transition hover:border-slate-600 hover:text-white disabled:opacity-40"
          >
            <Download className="h-3.5 w-3.5" />
            Download CSV{sorted.length ? ` (${sorted.length})` : ''}
          </button>
          <button
            type="button"
            onClick={() => load(true)}
            disabled={loading || noSelection}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-2 text-xs font-medium text-slate-300 transition hover:border-slate-600 hover:text-white disabled:opacity-40"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>
      </header>

      {showRange && (
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-medium text-slate-400">From</span>
              <input
                type="date"
                value={draftFrom}
                max={draftTo || maxDate}
                onChange={(e) => setDraftFrom(e.target.value)}
                className="rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs text-white focus:border-blue-500 focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-medium text-slate-400">To</span>
              <input
                type="date"
                value={draftTo}
                min={draftFrom || undefined}
                /* Capped at today for typing, because today is the most data
                   there is. The month presets may still end later than this
                   when the current month is only part way through. */
                max={maxDate}
                onChange={(e) => setDraftTo(e.target.value)}
                className="rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs text-white focus:border-blue-500 focus:outline-none"
              />
            </label>
            <button
              type="button"
              onClick={applyRange}
              disabled={!!draftError}
              className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-blue-500 disabled:opacity-40"
            >
              Apply range
            </button>
            <button
              type="button"
              onClick={() => { setShowRange(false); setMonths(months); }}
              className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 transition hover:border-slate-600 hover:text-white"
            >
              Cancel
            </button>
          </div>
          <p className={`mt-2 text-[11px] ${draftError ? 'text-amber-300' : 'text-slate-500'}`}>
            {draftError || `Both dates are included. Currently showing ${periodLabel(dateMode, months, fromDate, toDate)}.`}
          </p>
        </div>
      )}

      {/* Freshness. Stated always, because a figure with no time on it is a
          figure the reader has to guess the age of. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
        {window_ && (
          <span>
            Comparing <span className="text-slate-300">{window_.current_start} to {window_.current_effective_end}</span>
            {' '}against <span className="text-slate-300">{window_.previous_start} to {window_.previous_end}</span>
          </span>
        )}
        {loadedAt && <span>Read {new Date(loadedAt).toLocaleTimeString()}</span>}
        {loading && data && <span className="inline-flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Updating…</span>}
      </div>

      {window_?.partial && (
        <div className="flex items-start gap-2.5 rounded-xl border border-blue-500/20 bg-blue-950/20 p-3">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-blue-400" />
          <p className="text-xs text-slate-300">{window_.note}</p>
        </div>
      )}

      {error && (
        <div className="flex items-start gap-3 rounded-xl border border-red-500/30 bg-red-950/30 p-4">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
          <div>
            <p className="text-sm font-medium text-red-300">Could not read the latest cost data</p>
            <p className="mt-1 text-xs text-slate-400">{error}</p>
            {data && <p className="mt-1 text-xs text-slate-500">The figures below are from the last successful read and may be out of date.</p>}
          </div>
        </div>
      )}

      {errors.length > 0 && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-950/20 p-3">
          <p className="text-xs font-medium text-amber-300">
            Partial data — {errors.length} subscription{errors.length === 1 ? '' : 's'} could not be read
          </p>
          <ul className="mt-1 space-y-0.5">
            {errors.map((e) => (
              <li key={e.subscription_id} className="text-[11px] text-slate-400">
                {e.subscription_name || e.subscription_id}: {e.error}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Kpi
          label="Cost increases"
          value={stats.increase == null ? null : formatAmount(stats.increase, currency)}
          sub="Added compared with the previous period"
          tone="text-red-300"
        />
        <Kpi
          label="Cost reductions"
          /* Deliberately not "savings". A bill going down proves a cost fell,
             not that anybody saved anything -- a deleted test environment and a
             successful rightsizing look identical in billing data. */
          value={stats.reduction == null ? null : formatAmount(stats.reduction, currency)}
          sub="Cost that fell — not verified as savings"
          tone="text-emerald-300"
        />
        <Kpi
          label="Net change"
          value={stats.netChange == null ? null : `${stats.netChange > 0 ? '+' : ''}${formatAmount(stats.netChange, currency)}`}
          sub="Increases minus reductions"
          tone={stats.netChange > 0 ? 'text-red-300' : 'text-emerald-300'}
        />
        <Kpi
          label="Needs attention"
          value={stats.count ? String(stats.needsAttention) : null}
          sub="Serious and not yet closed"
          tone="text-amber-300"
        />
        <Kpi
          label="Largest change"
          value={stats.largest ? `${(stats.largest.delta || 0) > 0 ? '+' : ''}${formatAmount(stats.largest.delta, currency)}` : null}
          sub={stats.largest ? stats.largest.service : 'Nothing to show'}
        />
      </div>

      {/* Severity bar. Clicking a band filters everything, so the chart is a
          control rather than a decoration. */}
      {stats.count > 0 && (
        <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
          <p className="text-xs font-medium text-slate-400">How serious these changes are</p>
          <div className="mt-2 flex h-2.5 w-full overflow-hidden rounded-full bg-slate-800">
            {SEVERITIES.map((s) => counts[s] > 0 && (
              <button
                key={s}
                type="button"
                title={`${severityLabel(s)}: ${counts[s]}`}
                onClick={() => setFilter('severity', filters.severity === s ? 'all' : s)}
                style={{ width: `${(counts[s] / stats.count) * 100}%` }}
                className={
                  s === 'critical' ? 'bg-red-500' : s === 'high' ? 'bg-orange-500'
                    : s === 'medium' ? 'bg-amber-500' : s === 'low' ? 'bg-slate-500' : 'bg-slate-700'
                }
              />
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-3">
            {SEVERITIES.filter((s) => counts[s] > 0).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setFilter('severity', filters.severity === s ? 'all' : s)}
                className={`text-[11px] transition ${filters.severity === s ? 'text-white' : 'text-slate-500 hover:text-slate-300'}`}
              >
                {severityLabel(s)} ({counts[s]}) — {severityHint(s)}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search service, resource, subscription or region"
            className="w-full rounded-lg border border-slate-700 bg-slate-900 py-2 pl-9 pr-3 text-xs text-white placeholder:text-slate-600 focus:border-blue-500 focus:outline-none"
          />
        </div>
        <select value={filters.severity} onChange={(e) => setFilter('severity', e.target.value)} className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white focus:border-blue-500 focus:outline-none">
          <option value="all">Any seriousness</option>
          {SEVERITIES.map((s) => <option key={s} value={s}>{severityLabel(s)}</option>)}
        </select>
        <select value={filters.direction} onChange={(e) => setFilter('direction', e.target.value)} className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white focus:border-blue-500 focus:outline-none">
          <option value="all">Any change</option>
          {['increase', 'decrease', 'new', 'removed'].map((d) => <option key={d} value={d}>{directionLabel(d)}</option>)}
        </select>
        <select value={filters.status} onChange={(e) => setFilter('status', e.target.value)} className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white focus:border-blue-500 focus:outline-none">
          <option value="all">Any state</option>
          {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select>
        {subscriptionOptions.length > 1 && (
          <select value={filters.subscription} onChange={(e) => setFilter('subscription', e.target.value)} className="max-w-[200px] rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white focus:border-blue-500 focus:outline-none">
            <option value="all">All subscriptions</option>
            {subscriptionOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        )}
        {JSON.stringify(filters) !== JSON.stringify(DEFAULT_FILTERS) && (
          <button
            type="button"
            onClick={() => { setFilters(DEFAULT_FILTERS); setSearchInput(''); }}
            className="rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-400 transition hover:text-white"
          >
            Clear filters
          </button>
        )}
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-800">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-xs">
            <thead className="border-b border-slate-800 bg-slate-900/80">
              <tr>
                <SortHeader label="Service" sortKey={SORT_SERVICE} />
                <th className="hidden px-3 py-2 text-left font-medium text-slate-400 lg:table-cell">Subscription</th>
                <th className="px-3 py-2 text-left font-medium text-slate-400">What happened</th>
                <SortHeader label="Change" sortKey={SORT_IMPACT} className="text-right" />
                <SortHeader label="%" sortKey={SORT_PCT} className="hidden sm:table-cell" />
                <SortHeader label="This period" sortKey={SORT_CURRENT} className="hidden md:table-cell" />
                <th className="hidden px-3 py-2 text-left font-medium text-slate-400 xl:table-cell">State</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70">
              {loading && !data && [...Array(6)].map((_, i) => (
                <tr key={i}><td colSpan={7} className="px-3 py-3"><div className="h-4 animate-pulse rounded bg-slate-800" /></td></tr>
              ))}
              {paged.rows.map((r) => {
                const Icon = DIRECTION_ICON[r.direction] || Minus;
                const rising = (r.delta || 0) > 0;
                return (
                  <tr
                    key={r.anomaly_key}
                    onClick={() => setSelected(r)}
                    className="cursor-pointer transition hover:bg-slate-900/60"
                  >
                    <td className="px-3 py-2.5">
                      <p className="font-medium text-white">{r.service || 'Unnamed service'}</p>
                      <p className="truncate text-[11px] text-slate-500">{r.resource_name || r.resource_group || ''}</p>
                    </td>
                    <td className="hidden px-3 py-2.5 text-slate-400 lg:table-cell">
                      {r.subscription_name || r.subscription_id}
                    </td>
                    <td className="px-3 py-2.5">
                      <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] ${SEVERITY_STYLE[r.severity] || SEVERITY_STYLE.none}`}>
                        <Icon className="h-3 w-3" /> {directionLabel(r.direction)}
                      </span>
                      <p className="mt-0.5 text-[11px] text-slate-500">{severityLabel(r.severity)}</p>
                    </td>
                    <td className={`px-3 py-2.5 text-right font-semibold ${rising ? 'text-red-300' : 'text-emerald-300'}`}>
                      {rising ? '+' : ''}{formatAmount(r.delta, currency)}
                    </td>
                    <td className="hidden px-3 py-2.5 text-slate-400 sm:table-cell">
                      {r.pct_change == null
                        ? <span className="text-slate-600">Not available</span>
                        : `${r.pct_change > 0 ? '+' : ''}${r.pct_change.toFixed(0)}%`}
                    </td>
                    <td className="hidden px-3 py-2.5 text-slate-300 md:table-cell">{formatAmount(r.current_cost, currency)}</td>
                    <td className="hidden px-3 py-2.5 text-slate-500 xl:table-cell">{STATUS_LABEL[r.status || 'new']}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {!loading && paged.rows.length === 0 && (
          <div className="px-6 py-12 text-center">
            {noSelection ? (
              <>
                <p className="text-sm text-slate-300">Pick a tenant and at least one subscription</p>
                <p className="mt-1 text-xs text-slate-500">There is nothing to compare until a subscription is selected.</p>
              </>
            ) : allRows.length === 0 ? (
              <>
                <p className="text-sm text-slate-300">No cost changes worth reporting in this period</p>
                <p className="mt-1 text-xs text-slate-500">
                  Every service cost roughly what it did last period. Try a wider date range or a different comparison.
                </p>
              </>
            ) : (
              <>
                <p className="text-sm text-slate-300">Nothing matches these filters</p>
                <p className="mt-1 text-xs text-slate-500">
                  {allRows.length} change{allRows.length === 1 ? '' : 's'} were found — clear a filter to see them.
                </p>
              </>
            )}
          </div>
        )}
      </div>

      {paged.totalPages > 1 && (
        <div className="flex items-center justify-between text-xs text-slate-500">
          <span>
            Showing {(paged.page - 1) * PAGE_SIZE + 1}–{Math.min(paged.page * PAGE_SIZE, paged.totalRows)} of {paged.totalRows}
          </span>
          <div className="flex gap-2">
            <button type="button" disabled={paged.page === 1} onClick={() => setPage(paged.page - 1)} className="rounded-lg border border-slate-700 px-3 py-1.5 transition hover:text-white disabled:opacity-40">Previous</button>
            <button type="button" disabled={paged.page === paged.totalPages} onClick={() => setPage(paged.page + 1)} className="rounded-lg border border-slate-700 px-3 py-1.5 transition hover:text-white disabled:opacity-40">Next</button>
          </div>
        </div>
      )}

      <AnomalyDrawer
        open={!!selected}
        row={selected}
        currency={currency}
        tenantId={selectedTenantId}
        siblings={allRows}
        onClose={() => setSelected(null)}
        onStatusChange={onStatusChange}
      />
    </div>
  );
}
