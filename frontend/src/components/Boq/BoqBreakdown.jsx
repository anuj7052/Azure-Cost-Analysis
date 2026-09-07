import { Fragment, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Download, Info } from 'lucide-react';
import { formatAmount } from '../../utils/currency';
import {
  MultiFilter, FilterSelect, SearchBox, ClearFilters, ControlRow, FilterIcon, PillButton,
} from './FilterControls';
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
 *
 * One deliberate difference from the card at the top of the page: this panel
 * asks how accurate the estimate is, so a charge no BOQ line names counts as
 * not in the BOQ even where a lump-sum budget absorbs the money. That is a
 * stricter test than the category variance, and the panel says so on screen
 * rather than leaving the two figures to be discovered as a contradiction.
 */

const COVERAGE_TONE = {
  line: 'text-emerald-300',
  none: 'text-red-300',
};

const COVERAGE_TEXT = {
  line: 'Matched to a BOQ line',
  none: 'Not in BOQ',
};

/** Two verdicts on screen, so the middle case reads as what it is: unnamed. */
const verdictOf = (row) => (row.coverage === 'line' ? 'line' : 'none');


/**
 * The matched/unmatched split of one group, as a bar.
 *
 * Segments are clamped at zero and scaled against the positive part rather
 * than against `actual`. Azure issues credits as negative charges -- a hybrid
 * benefit line can leave a whole group negative -- and dividing by that gave a
 * negative width, which the browser drops silently: the bar simply vanished,
 * and a missing bar looks like missing data rather than a refund.
 */
function Bar({ matched, notInBoq }) {
  const up = Math.max(matched, 0) + Math.max(notInBoq, 0);
  if (up <= 0) return null;
  const pct = (v) => `${(Math.max(v, 0) / up) * 100}%`;
  return (
    <span className="flex h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
      <span className="block h-full bg-emerald-500/70" style={{ width: pct(matched) }} />
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
            The same spend as above, regrouped, and scored on one question: does
            a line in your BOQ actually name this charge? Anything it does not
            name is counted as not in the BOQ here — a stricter test than the
            category variance above, which lets a lump-sum budget line absorb
            charges it never listed.
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
      <ControlRow label="Group by">
        {DIMENSIONS.map(d => (
          <PillButton
            key={d.key}
            active={dimension === d.key}
            onClick={() => { setDimension(d.key); setExpanded({}); }}
          >
            {d.label}
          </PillButton>
        ))}
      </ControlRow>

      {/* Filters */}
      <ControlRow label="Filter">
        <FilterIcon />
        <MultiFilter label="Resource group" options={rgOptions} selected={resourceGroups} onChange={setResourceGroups} />
        <MultiFilter label="Service" options={serviceOptions} selected={services} onChange={setServices} />
        <MultiFilter label="Region" options={regionOptions} selected={regions} onChange={setRegions} />
        <MultiFilter label="Subscription" options={subOptions} selected={subscriptions} onChange={setSubscriptions} />
        <FilterSelect value={coverage} onChange={setCoverage} options={COVERAGE_FILTERS} />
        <SearchBox
          value={search}
          onChange={setSearch}
          placeholder="Search resource, meter, service…"
        />
        <ClearFilters count={activeFilters} onClear={clearAll} />
      </ControlRow>

      {/* What this grouping can and cannot tell you */}
      <div className="flex items-start gap-2.5 rounded-xl border border-slate-800 bg-slate-800/30 px-3.5 py-2.5">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-600" />
        <p className="text-xs leading-relaxed text-slate-400">{result.dimension.note}</p>
      </div>

      {/* Totals for the current slice */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Tile label="Actual / month" value={fmt(result.total)} hint={`${result.groups.length} ${result.dimension.label.toLowerCase()}(s)`} />
        <Tile
          label="Named by a BOQ line"
          value={fmt(result.matchedTotal)}
          hint={result.total > 0 ? `${Math.round((result.matchedTotal / result.total) * 100)}% of this slice — how much of the bill the estimate got right` : undefined}
          tone="text-emerald-300"
        />        <Tile
          label="Not in BOQ"
          value={fmt(result.notInBoqTotal)}
          hint={result.notInBoqTotal > 0 ? 'no line in the estimate lists these charges' : 'every charge is listed in the estimate'}
          tone={result.notInBoqTotal > 0 ? 'text-red-300' : 'text-emerald-300'}
        />
      </div>

      {/* Credits are why this total can be smaller than the column below it
          adds up to. Said out loud, because the alternative is a reader who
          checks the arithmetic, finds it wrong, and stops trusting the page. */}
      {result.creditTotal < 0 && (
        <p className="rounded-xl border border-slate-800 bg-slate-800/30 px-3.5 py-2.5 text-[11px] leading-relaxed text-slate-400">
          This slice includes {fmt(Math.abs(result.creditTotal))} of credits — charges
          Azure billed as negative, such as a hybrid benefit or a refund. They are
          subtracted from the totals above, so the columns add up to less than the
          positive charges alone.
        </p>
      )}

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
                      <td className={`py-3 text-right font-medium ${
                        g.notInBoq > 0 ? 'text-red-300'
                          : g.notInBoq < 0 ? 'text-emerald-300' : 'text-slate-600'
                      }`}>
                        {/* A credit is shown as the negative number it is.
                            Rendering it as an em dash hid it from the column
                            while it still counted in the total above, so the
                            two could not be reconciled by adding the column
                            up -- which is the first thing anybody does. */}
                        {g.notInBoq === 0 ? '—' : fmt(g.notInBoq)}
                      </td>
                      <td className="py-3 pl-4">
                        <Bar matched={g.matched} notInBoq={g.notInBoq} />
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
                                <span className={`w-40 shrink-0 text-[10px] ${COVERAGE_TONE[verdictOf(r)]}`}>
                                  {r.coverage === 'line' && r.boqLine
                                    ? `→ ${r.boqLine}`
                                    : COVERAGE_TEXT[verdictOf(r)]}
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
