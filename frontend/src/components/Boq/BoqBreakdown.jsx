import { Fragment, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Download, Filter, Info, Search, X } from 'lucide-react';
import { formatAmount } from '../../utils/currency';
import {
  DIMENSIONS, COVERAGE_FILTERS, optionsFor, filterAttributions,
  groupAttributions, breakdownCsv,
} from '../../utils/boqBreakdown';

/**
 * Full breakdown of BOQ vs actual, sliced any way the reader needs.
 *
 * The category table above answers one question well and no others. Finance
 * wants it by resource group, the platform team wants it by service, and the
 * person chasing a specific overrun wants one resource. All three are the same
 * money, so all three are computed from the same row-level attributions rather
 * than from separate queries — two views of one bill must never disagree.
 */

const COVERAGE_TONE = {
  line: 'text-emerald-300',
  pooled: 'text-slate-300',
  none: 'text-red-300',
};

const COVERAGE_TEXT = {
  line: 'Matched to a BOQ line',
  pooled: 'Covered by pooled budget',
  none: 'Not in BOQ',
};

/** A multi-select filter rendered as a compact dropdown of checkboxes. */
function MultiFilter({ label, options, selected, onChange }) {
  const [open, setOpen] = useState(false);
  if (options.length <= 1) return null;

  const toggle = (value) => {
    const next = new Set(selected);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange(next);
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
          selected.size > 0
            ? 'border-blue-500/30 bg-blue-600/20 text-blue-300'
            : 'border-slate-800 text-slate-400 hover:bg-slate-800/60 hover:text-white'
        }`}
      >
        {label}
        {selected.size > 0 && <span className="text-blue-400">{selected.size}</span>}
        <ChevronDown className="h-3 w-3" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-0 z-20 mt-1 max-h-72 w-64 overflow-y-auto rounded-xl border border-slate-700 bg-slate-900 p-2 shadow-xl animate-scale-in">
            {selected.size > 0 && (
              <button
                onClick={() => onChange(new Set())}
                className="mb-1 w-full rounded-lg px-2 py-1.5 text-left text-xs text-slate-400 hover:bg-slate-800 hover:text-white"
              >
                Clear {label.toLowerCase()}
              </button>
            )}
            {options.map(opt => (
              <label
                key={opt}
                className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-slate-300 hover:bg-slate-800"
              >
                <input
                  type="checkbox"
                  checked={selected.has(opt)}
                  onChange={() => toggle(opt)}
                  className="accent-blue-500"
                />
                <span className="truncate" title={opt}>{opt}</span>
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Bar({ matched, pooled, notInBoq, actual }) {
  if (actual <= 0) return null;
  const pct = (v) => `${Math.max((v / actual) * 100, 0)}%`;
  return (
    <span className="flex h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
      <span className="block h-full bg-emerald-500/70" style={{ width: pct(matched) }} />
      <span className="block h-full bg-slate-500/60" style={{ width: pct(pooled) }} />
      <span className="block h-full bg-red-500/70" style={{ width: pct(notInBoq) }} />
    </span>
  );
}

export default function BoqBreakdown({ report, currency }) {
  const fmt = (v) => formatAmount(v, currency);

  const [dimension, setDimension] = useState('resource_group');
  const [resourceGroups, setResourceGroups] = useState(new Set());
  const [services, setServices] = useState(new Set());
  const [regions, setRegions] = useState(new Set());
  const [subscriptions, setSubscriptions] = useState(new Set());
  const [coverage, setCoverage] = useState('all');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState({});

  // Kept stable across renders: a fresh [] fallback each time would rebuild
  // every list below on every keystroke in the search box.
  const attributions = useMemo(() => report?.attributions || [], [report]);

  const rgOptions = useMemo(() => optionsFor(attributions, 'resource_group'), [attributions]);
  const serviceOptions = useMemo(() => optionsFor(attributions, 'service'), [attributions]);
  const regionOptions = useMemo(() => optionsFor(attributions, 'region'), [attributions]);
  const subOptions = useMemo(() => optionsFor(attributions, 'subscription_id'), [attributions]);

  // The category dimension is the one place a real budget exists, so the
  // per-category budget is handed through only for that grouping.
  const budgetByCategory = useMemo(() => {
    const map = new Map();
    for (const c of report?.categories || []) map.set(c.label, c.budgeted);
    return map;
  }, [report]);

  const filters = { resourceGroups, services, regions, subscriptions, coverage, search };

  const filtered = useMemo(
    () => filterAttributions(attributions, filters),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [attributions, resourceGroups, services, regions, subscriptions, coverage, search],
  );

  const result = useMemo(
    () => groupAttributions(filtered, dimension, budgetByCategory),
    [filtered, dimension, budgetByCategory],
  );

  const activeFilters =
    resourceGroups.size + services.size + regions.size + subscriptions.size +
    (coverage !== 'all' ? 1 : 0) + (search ? 1 : 0);

  function clearAll() {
    setResourceGroups(new Set());
    setServices(new Set());
    setRegions(new Set());
    setSubscriptions(new Set());
    setCoverage('all');
    setSearch('');
  }

  function downloadCsv() {
    const blob = new Blob([breakdownCsv(result, currency)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `boq-breakdown-by-${result.dimension.key}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!attributions.length) return null;

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-300">Full breakdown</h2>
          <p className="text-xs text-slate-500 mt-0.5 max-w-2xl leading-relaxed">
            The same spend as above, regrouped. Every charge carries the verdict
            the category table reached, so no two views here can disagree.
          </p>
        </div>
        <button
          onClick={downloadCsv}
          className="flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-3.5 py-2 text-xs font-medium text-slate-300 transition hover:text-white"
        >
          <Download className="h-3.5 w-3.5" />
          Export CSV
        </button>
      </div>

      {/* Group by */}
      <div className="space-y-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
          Group by
        </span>
        <div className="flex flex-wrap gap-1.5">
          {DIMENSIONS.map(d => (
            <button
              key={d.key}
              onClick={() => { setDimension(d.key); setExpanded({}); }}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                dimension === d.key
                  ? 'border border-blue-500/30 bg-blue-600/25 text-blue-300'
                  : 'border border-slate-800 text-slate-400 hover:bg-slate-800/60 hover:text-white'
              }`}
            >
              {d.label}
            </button>
          ))}
        </div>
      </div>

      {/* Filters */}
      <div className="space-y-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
          Filter
        </span>
        <div className="flex flex-wrap items-center gap-1.5">
          <Filter className="h-3.5 w-3.5 text-slate-600" />
          <MultiFilter label="Resource group" options={rgOptions} selected={resourceGroups} onChange={setResourceGroups} />
          <MultiFilter label="Service" options={serviceOptions} selected={services} onChange={setServices} />
          <MultiFilter label="Region" options={regionOptions} selected={regions} onChange={setRegions} />
          <MultiFilter label="Subscription" options={subOptions} selected={subscriptions} onChange={setSubscriptions} />

          <select
            value={coverage}
            onChange={(e) => setCoverage(e.target.value)}
            className="rounded-lg border border-slate-800 bg-slate-900 px-3 py-1.5 text-xs text-slate-300 focus:border-blue-500/40 focus:outline-none"
          >
            {COVERAGE_FILTERS.map(c => (
              <option key={c.key} value={c.key}>{c.label}</option>
            ))}
          </select>

          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-600" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search resource, meter, service…"
              className="w-56 rounded-lg border border-slate-800 bg-slate-900 py-1.5 pl-8 pr-3 text-xs text-slate-200 placeholder:text-slate-600 focus:border-blue-500/40 focus:outline-none"
            />
          </div>

          {activeFilters > 0 && (
            <button
              onClick={clearAll}
              className="flex items-center gap-1 rounded-lg bg-slate-800 px-2.5 py-1.5 text-xs text-slate-400 transition hover:bg-slate-700 hover:text-white"
            >
              <X className="h-3 w-3" />
              Clear {activeFilters}
            </button>
          )}
        </div>
      </div>

      {/* What this grouping can and cannot tell you */}
      <div className="flex items-start gap-2.5 rounded-xl border border-slate-800 bg-slate-800/30 px-3.5 py-2.5">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-600" />
        <p className="text-xs leading-relaxed text-slate-400">{result.dimension.note}</p>
      </div>

      {/* Totals for the current slice */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Actual / month" value={fmt(result.total)} hint={`${result.groups.length} ${result.dimension.label.toLowerCase()}(s)`} />
        <Tile label="Matched to a BOQ line" value={fmt(result.matchedTotal)} tone="text-emerald-300" />
        <Tile label="Covered by pooled budget" value={fmt(result.pooledTotal)} tone="text-slate-300" />
        <Tile label="Not in BOQ" value={fmt(result.notInBoqTotal)} tone={result.notInBoqTotal > 0 ? 'text-red-300' : 'text-emerald-300'} />
      </div>

      {result.groups.length === 0 ? (
        <p className="rounded-xl border border-slate-800 bg-slate-800/30 px-4 py-8 text-center text-sm text-slate-400">
          No charges match these filters.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800 text-left text-slate-500">
                <th className="w-8 pb-2 font-medium" />
                <th className="pb-2 font-medium">{result.dimension.label}</th>
                {result.dimension.budgeted && <th className="pb-2 text-right font-medium">BOQ budget</th>}
                <th className="pb-2 text-right font-medium">Actual / month</th>
                {result.dimension.budgeted && <th className="pb-2 text-right font-medium">Difference</th>}
                <th className="pb-2 text-right font-medium">Not in BOQ</th>
                <th className="pb-2 pl-4 font-medium">Coverage</th>
                <th className="pb-2 text-right font-medium">Share</th>
              </tr>
            </thead>
            <tbody>
              {result.groups.map((g) => {
                const open = expanded[g.key];
                return (
                  <Fragment key={g.key}>
                    <tr
                      onClick={() => setExpanded(s => ({ ...s, [g.key]: !s[g.key] }))}
                      className={`cursor-pointer border-b border-slate-800/50 transition ${
                        g.notInBoq > 0 ? 'bg-red-500/[0.05] hover:bg-red-500/10' : 'hover:bg-slate-800/30'
                      }`}
                    >
                      <td className="py-3 pl-1 text-slate-500">
                        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                      </td>
                      <td className="max-w-xs truncate py-3 font-medium text-slate-200" title={g.label}>
                        {g.label}
                        <span className="ml-2 text-[10px] text-slate-600">
                          {g.rows.length} charge{g.rows.length > 1 ? 's' : ''}
                        </span>
                      </td>
                      {result.dimension.budgeted && (
                        <td className="py-3 text-right text-slate-400">
                          {g.budgeted > 0 ? fmt(g.budgeted) : '—'}
                        </td>
                      )}
                      <td className="py-3 text-right font-semibold text-white">{fmt(g.actual)}</td>
                      {result.dimension.budgeted && (
                        <td className={`py-3 text-right font-semibold ${
                          g.variance > 0 ? 'text-red-400' : g.variance < 0 ? 'text-emerald-400' : 'text-slate-500'
                        }`}>
                          {!g.variance ? '—' : `${g.variance > 0 ? '+' : '−'}${fmt(Math.abs(g.variance))}`}
                        </td>
                      )}
                      <td className={`py-3 text-right font-medium ${g.notInBoq > 0 ? 'text-red-300' : 'text-slate-600'}`}>
                        {g.notInBoq > 0 ? fmt(g.notInBoq) : '—'}
                      </td>
                      <td className="py-3 pl-4">
                        <Bar matched={g.matched} pooled={g.pooled} notInBoq={g.notInBoq} actual={g.actual} />
                      </td>
                      <td className="py-3 text-right text-xs text-slate-500">{g.share}%</td>
                    </tr>

                    {open && (
                      <tr className="border-b border-slate-800/50 bg-slate-950/40">
                        <td />
                        <td colSpan={result.dimension.budgeted ? 7 : 5} className="py-3 pr-2">
                          <ul className="space-y-1">
                            {g.rows.slice(0, 60).map((r, i) => (
                              <li key={i} className="flex items-center gap-3 text-xs">
                                <span className="w-44 shrink-0 truncate text-slate-200" title={r.resource_name}>
                                  {r.resource_name || '—'}
                                </span>
                                <span className="w-32 shrink-0 truncate text-slate-500" title={r.resource_group}>
                                  {r.resource_group || '—'}
                                </span>
                                <span className="min-w-0 flex-1 truncate text-slate-400" title={r.meter}>
                                  {r.service}{r.meter ? ` · ${r.meter}` : ''}
                                </span>
                                <span className="w-16 shrink-0 text-[10px] text-slate-600">{r.region || '—'}</span>
                                <span className={`w-40 shrink-0 text-[10px] ${COVERAGE_TONE[r.coverage]}`}>
                                  {r.coverage === 'line' && r.boqLine
                                    ? `→ ${r.boqLine}`
                                    : COVERAGE_TEXT[r.coverage]}
                                </span>
                                <span className="w-20 shrink-0 text-right font-medium text-slate-200">
                                  {fmt(r.monthlyCost)}
                                </span>
                              </li>
                            ))}
                          </ul>
                          {g.rows.length > 60 && (
                            <p className="mt-2 text-[11px] text-slate-600">
                              Showing the 60 largest of {g.rows.length} charges. Export the CSV
                              or narrow the filters to see the rest.
                            </p>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-[11px] leading-relaxed text-slate-600">
        Amounts are per month, averaged over the selected period so they line up
        with the monthly estimate. Green is spend a BOQ line explicitly budgeted
        for, grey is spend covered by a budget line too coarse to match per
        resource, red is spend with nothing behind it.
      </p>
    </div>
  );
}

function Tile({ label, value, hint, tone = 'text-white' }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-800/30 p-3">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-1 text-lg font-bold ${tone}`}>{value}</p>
      {hint && <p className="mt-1 text-[11px] text-slate-500">{hint}</p>}
    </div>
  );
}
