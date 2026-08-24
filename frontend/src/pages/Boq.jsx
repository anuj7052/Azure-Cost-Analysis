import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import { uploadBoq } from '../api/client';
import { formatAmount } from '../utils/currency';
import { Quantity } from '../components/Common/Amount';
import BoqGenerator from '../components/Boq/BoqGenerator';
import BoqBreakdown from '../components/Boq/BoqBreakdown';
import { formatBytes } from '../utils/bytes';
import { compareBoqToUsage } from '../utils/boqCompare';
import toast from 'react-hot-toast';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, Cell,
} from 'recharts';
import { useChartTheme } from '../store/useTheme';
import {
  Upload, FileSpreadsheet, X, AlertTriangle, TrendingDown, TrendingUp,
  CheckCircle, ChevronDown, ChevronRight, ClipboardList, Ban,
} from 'lucide-react';

const ACCEPTED = '.csv,.xlsx,.xlsm,.xls';

export default function Boq() {
  const { boqs, addBoq, removeBoq, toggleBoq, costData, imported, rowsData, rowsLoading, loadCosts, loadCostRows, detailedUsageRows, selectedTenantId, selectedSubscriptionIds, dateKey } = useAppStore();
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState({});
  const [focus, setFocus] = useState(null);
  const inputRef = useRef(null);
  const t = useChartTheme();

  // Matching a budget line to the resource that actually billed needs meter
  // level detail, which the cost summary does not carry — fetch both on a plain
  // login so the comparison works without visiting the dashboard first.
  // Switching tenant or subscription has to refetch as well, otherwise the page
  // keeps the previous account's meters or, worse, falls back to service totals
  // and reports a charge like "Backup" as one figure that cannot be explained.
  useEffect(() => {
    if (imported) return;
    if (!selectedTenantId || selectedSubscriptionIds.length === 0) return;
    loadCosts();
    loadCostRows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imported, selectedTenantId, selectedSubscriptionIds.join(','), dateKey]);

  const active = boqs.filter(b => b.enabled !== false);
  const currency = costData?.currency || active[0]?.currency || 'INR';
  const fmt = (v) => formatAmount(v, currency);

  // The estimate is a monthly figure, so usage is averaged per month to match.
  // Meter-level rows give the per-resource match (P20 disk to P20 disk); the
  // service-level summary is only a fallback.
  const report = useMemo(() => {
    if (!active.length || !costData?.months?.length) return null;
    const detailed = detailedUsageRows();
    // While the meter-level rows are still in flight there is nothing to match
    // on, and the service totals would roll every backup charge into one
    // unexplainable lump. Waiting is better than showing a figure that cannot
    // be broken down.
    if (!detailed?.length && rowsLoading) return null;
    const rows = detailed?.length
      ? detailed
      : costData.months.flatMap(m =>
          Object.entries(m.by_service || {}).map(([service, cost]) => ({ service, cost })),
        );
    return compareBoqToUsage(active, rows, costData.months.length, currency);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boqs, costData, currency, imported, rowsData, rowsLoading]);

  // Service totals carry no meter, resource or quantity, so a comparison built
  // from them cannot be drilled into. Say so rather than letting it pass for
  // the real thing.
  const coarse = !!report && !detailedUsageRows()?.length;

  async function handleFiles(fileList) {
    const files = [...fileList];
    if (!files.length) return;
    setBusy(true);
    for (const file of files) {
      try {
        const parsed = await uploadBoq(file);
        addBoq(parsed);
        toast.success(`${parsed.name} — ${parsed.items.length} line items, ${formatAmount(parsed.total_monthly, parsed.currency)}/month`);
      } catch (err) {
        toast.error(err?.response?.data?.detail || `Could not read ${file.name}`);
      }
    }
    setBusy(false);
    if (inputRef.current) inputRef.current.value = '';
  }

  const chartData = (report?.categories || [])
    .filter(c => c.budgeted > 0 || c.actual > 0)
    .map(c => ({ name: c.label, Budget: c.budgeted, Actual: c.actual, over: c.variance > 0 }));

  // Clicking a headline card narrows the table to the rows behind that number
  // and opens them, so the figure can be traced to individual resources.
  const FOCUS = {
    budget: { test: c => c.budgeted > 0, note: 'Showing every category your BOQ budgeted for.' },
    actual: { test: c => c.actual > 0, note: 'Showing every category you were charged for.' },
    extra:  { test: c => c.variance > 0, note: 'Showing only what is costing more than the BOQ allowed.' },
    rogue:  { test: c => c.notInBoqTotal > 0, note: 'Showing only categories with charges your BOQ never paid for.' },
    net:    { test: () => true, note: 'Showing all categories, worst overrun first.' },
  };
  const visible = (report?.categories || []).filter(c => (focus ? FOCUS[focus].test(c) : true));

  function focusOn(key) {
    if (focus === key) { setFocus(null); return; }
    setFocus(key);
    const open = {};
    for (const c of report.categories) if (FOCUS[key].test(c)) open[c.key] = true;
    setExpanded(open);
    const target = key === 'rogue' ? 'boq-rogue' : 'boq-detail';
    requestAnimationFrame(() =>
      document.getElementById(target)?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
    );
  }

  return (
    <div className="p-6 space-y-6 max-w-screen-2xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold text-white">BOQ vs Actual</h1>
        <p className="text-slate-400 text-sm mt-1">
          Upload your Azure Pricing Calculator estimates and see exactly what you are being
          charged over and above the budget.
        </p>
      </div>

      {/* Generate a BOQ from what is actually deployed. Sits above upload
          because most people arrive without an estimate to upload. */}
      <BoqGenerator />

      {/* Upload */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-sm font-semibold text-white">Bill of Quantities</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Export from the Azure Pricing Calculator (CSV or Excel). Upload as many as you need —
              they are added together.
            </p>
          </div>
          <button
            onClick={() => inputRef.current?.click()}
            disabled={busy}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-[#fff] text-sm font-medium px-4 py-2 rounded-xl transition"
          >
            <Upload className="w-4 h-4" />
            {busy ? 'Reading…' : 'Upload BOQ'}
          </button>
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPTED}
            multiple
            className="hidden"
            onChange={(e) => handleFiles(e.target.files)}
          />
        </div>

        {boqs.length === 0 ? (
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); handleFiles(e.dataTransfer.files); }}
            className="border border-dashed border-slate-700 rounded-xl px-4 py-10 text-center"
          >
            <ClipboardList className="w-7 h-7 text-slate-600 mx-auto mb-2" />
            <p className="text-sm text-slate-400">Drop your estimate files here, or use Upload BOQ</p>
            <p className="text-xs text-slate-600 mt-1">
              Azure portal → Pricing Calculator → your saved estimate → Export
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {boqs.map((b) => (
              <div
                key={b.file_name}
                className={`border rounded-xl p-4 transition ${
                  b.enabled === false
                    ? 'border-slate-800 bg-slate-950/40 opacity-60'
                    : 'border-emerald-500/30 bg-emerald-950/20'
                }`}
              >
                <div className="flex items-start gap-3">
                  <FileSpreadsheet className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-white">{b.name}</p>
                    <p className="text-xs text-slate-500 mt-0.5 truncate">{b.file_name}</p>
                    <p className="text-xs text-slate-400 mt-1">
                      {b.items.length} line items · infra {formatAmount(b.items_total, b.currency)}
                      {b.managed_services ? ` · managed ${formatAmount(b.managed_services, b.currency)}` : ''}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-base font-bold text-white">{formatAmount(b.total_monthly, b.currency)}</p>
                    <p className="text-[11px] text-slate-500">per month</p>
                  </div>
                  <button
                    onClick={() => removeBoq(b.file_name)}
                    title="Remove this estimate"
                    className="text-slate-500 hover:text-red-400 transition p-1 shrink-0"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <label className="flex items-center gap-2 text-xs text-slate-400 mt-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={b.enabled !== false}
                    onChange={() => toggleBoq(b.file_name)}
                    className="accent-blue-500"
                  />
                  Include in comparison
                </label>
              </div>
            ))}
          </div>
        )}
      </div>

      {!report ? (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-8 text-center">
          <p className="text-slate-400 text-sm">
            {boqs.length === 0
              ? 'Upload at least one BOQ to start comparing.'
              : !active.length
                ? 'No estimate is included in the comparison — tick at least one above.'
                : 'No cost data yet. Import a usage file in Settings, or wait for live data to load.'}
          </p>
        </div>
      ) : (
        <>
          {coarse && (
            <div className="flex items-start gap-2.5 border border-amber-500/40 bg-amber-500/[0.07] rounded-xl px-4 py-3">
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm text-amber-200 font-medium">
                  Showing service totals only — no meter detail available
                </p>
                <p className="text-xs text-amber-200/70 mt-0.5">
                  Each service is one figure that cannot be opened up or matched to a resource,
                  so budget lines are grouped rather than compared one by one. Use Refresh, or
                  import a usage file in Settings, to get the per-meter breakdown.
                </p>
              </div>
            </div>
          )}

          {/* Headline variance */}
          <div className="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-5 gap-4">
            <SummaryCard
              label="Budget (BOQ)"
              value={fmt(report.budgetTotal)}
              hint={`${active.length} estimate${active.length > 1 ? 's' : ''} · per month`}
              tone="neutral"
              onClick={() => focusOn('budget')}
              active={focus === 'budget'}
            />
            <SummaryCard
              label="Actual spend"
              value={fmt(report.actualTotal)}
              hint={report.months > 1 ? `monthly average of ${report.months} months` : 'this month'}
              tone="neutral"
              onClick={() => focusOn('actual')}
              active={focus === 'actual'}
            />
            <SummaryCard
              label="Extra over BOQ"
              value={fmt(report.extraTotal)}
              hint={report.extraTotal > 0 ? 'charged above budget' : 'nothing over budget'}
              tone={report.extraTotal > 0 ? 'bad' : 'good'}
              icon={report.extraTotal > 0 ? AlertTriangle : CheckCircle}
              onClick={() => focusOn('extra')}
              active={focus === 'extra'}
            />
            <SummaryCard
              label="Not in your BOQ"
              value={fmt(report.notInBoqTotal)}
              hint={report.notInBoqTotal > 0
                ? `${report.notInBoq.length} charge${report.notInBoq.length > 1 ? 's' : ''} with no budget line`
                : 'everything is budgeted'}
              tone={report.notInBoqTotal > 0 ? 'bad' : 'good'}
              icon={report.notInBoqTotal > 0 ? Ban : CheckCircle}
              onClick={() => focusOn('rogue')}
              active={focus === 'rogue'}
            />
            <SummaryCard
              label="Net vs budget"
              value={`${report.variance >= 0 ? '+' : '−'}${fmt(Math.abs(report.variance))}`}
              hint={report.variancePct != null ? `${report.variancePct >= 0 ? '+' : ''}${report.variancePct}% vs BOQ` : '—'}
              tone={report.variance > 0 ? 'bad' : 'good'}
              icon={report.variance > 0 ? TrendingUp : TrendingDown}
              onClick={() => focusOn('net')}
              active={focus === 'net'}
            />
          </div>

          {report.unbudgetedTotal > 0 && (
            <div className="flex items-start gap-3 bg-red-500/10 border border-red-500/30 rounded-2xl px-4 py-3">
              <AlertTriangle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
              <div className="text-sm text-red-200">
                <span className="font-semibold">{fmt(report.unbudgetedTotal)} per month</span> is
                being spent in whole categories your BOQ never budgeted for — separate from the{' '}
                {fmt(report.notInBoqTotal)} of individual charges with no matching budget line.
                Both are highlighted in red below.
              </div>
            </div>
          )}

          {/* Budget vs actual chart */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
            <h2 className="text-sm font-semibold text-slate-300 mb-4">Budget vs actual by category</h2>
            <ResponsiveContainer width="100%" height={320}>
              <BarChart data={chartData} margin={{ top: 5, right: 20, left: 10, bottom: 60 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={t.grid} vertical={false} />
                <XAxis
                  dataKey="name" tick={{ fill: t.axis, fontSize: 11 }} axisLine={false}
                  tickLine={false} angle={-25} textAnchor="end" height={70} interval={0}
                />
                <YAxis tick={{ fill: t.axis, fontSize: 11 }} axisLine={false} tickLine={false} width={70}
                  tickFormatter={v => v >= 1000 ? `${(v / 1000).toFixed(0)}K` : v} />
                <Tooltip
                  cursor={t.tooltipCursor} contentStyle={t.tooltip} labelStyle={t.tooltipLabel}
                  formatter={(val, key) => [fmt(val), key]}
                />
                <Legend iconType="circle" iconSize={8} wrapperStyle={{ color: t.axis, fontSize: 11 }} />
                <Bar dataKey="Budget" fill={t.series[4]} radius={[3, 3, 0, 0]} />
                <Bar dataKey="Actual" radius={[3, 3, 0, 0]}>
                  {chartData.map((d, i) => (
                    <Cell key={i} fill={d.over ? '#ef4444' : t.series[0]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            <p className="text-[11px] text-slate-600 mt-2">
              Red bars are categories where actual spend exceeds the BOQ.
            </p>
          </div>

          {focus === 'rogue' && report.notInBoqTotal > 0 && (
            <div id="boq-rogue" className="bg-slate-900 border border-red-500/30 rounded-2xl p-5 scroll-mt-4">
              <div className="flex items-start justify-between gap-3 flex-wrap mb-1">
                <h2 className="text-sm font-semibold text-red-300">
                  Everything you are paying for that is not in the BOQ
                </h2>
                <p className="text-sm font-bold text-red-300">{fmt(report.notInBoqTotal)} / month</p>
              </div>
              <p className="text-xs text-slate-500 mb-4">
                {report.notInBoq.length} charges across{' '}
                {new Set(report.notInBoq.map(u => u.categoryKey)).size} categories. No line in your
                estimate pays for any of these — they were added after the BOQ was written, or the
                estimate missed them.
              </p>
              <ul className="space-y-1.5">
                {report.notInBoq.map((u, i) => {
                  const share = (u.cost / report.notInBoqTotal) * 100;
                  return (
                    <li key={i} className="flex items-center gap-3 text-xs">
                      <span className="w-28 shrink-0 text-[11px] text-slate-500 truncate">{u.category}</span>
                      {u.resource_name ? (
                        <span className="w-44 shrink-0 text-slate-200 font-medium truncate" title={u.resource_name}>
                          {u.resource_name}
                        </span>
                      ) : (
                        <span className="w-44 shrink-0 text-slate-600">—</span>
                      )}
                      {u.size && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-700 text-[#fff] shrink-0">
                          {u.sku} · {u.size}
                        </span>
                      )}
                      <span className="text-slate-300 truncate min-w-0">{u.label}</span>
                      {u.resource_group && (
                        <span className="text-[10px] text-slate-600 shrink-0">{u.resource_group}</span>
                      )}
                      <span className="flex-1 h-1 rounded-full bg-slate-800 overflow-hidden min-w-[24px]">
                        <span className="block h-full bg-red-500/70 rounded-full" style={{ width: `${share}%` }} />
                      </span>
                      <span className="w-20 text-right shrink-0 font-medium text-red-300">{fmt(u.cost)}</span>
                      <span className="w-12 text-right shrink-0 text-[10px] text-slate-600">
                        {share.toFixed(1)}%
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {/* Line-by-line variance */}
          <div id="boq-detail" className="bg-slate-900 border border-slate-800 rounded-2xl p-5 scroll-mt-4">
            <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
              <h2 className="text-sm font-semibold text-slate-300">
                What is extra — category by category
              </h2>
              {focus && (
                <button
                  onClick={() => { setFocus(null); setExpanded({}); }}
                  className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white bg-slate-800 hover:bg-slate-700 px-2.5 py-1 rounded-lg transition"
                >
                  <X className="w-3 h-3" />
                  {FOCUS[focus].note} Clear
                </button>
              )}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-slate-500 border-b border-slate-800">
                    <th className="pb-2 font-medium w-8" />
                    <th className="pb-2 font-medium">Category</th>
                    <th className="pb-2 font-medium text-right">BOQ budget</th>
                    <th className="pb-2 font-medium text-right">Actual / month</th>
                    <th className="pb-2 font-medium text-right">Difference</th>
                    <th className="pb-2 font-medium text-right">vs budget</th>
                    <th className="pb-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((c) => {
                    const open = expanded[c.key];
                    const over = c.variance > 0;
                    return (
                      <Fragment key={c.key}>
                        <tr
                          onClick={() => setExpanded(s => ({ ...s, [c.key]: !s[c.key] }))}
                          className={`border-b border-slate-800/50 cursor-pointer transition ${
                            c.unbudgeted
                              ? 'bg-red-500/10 hover:bg-red-500/15'
                              : over
                                ? 'bg-amber-500/[0.07] hover:bg-amber-500/[0.12]'
                                : 'hover:bg-slate-800/30'
                          }`}
                        >
                          <td className="py-3 pl-1 text-slate-500">
                            {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                          </td>
                          <td className="py-3 text-slate-200 font-medium">{c.label}</td>
                          <td className="py-3 text-right text-slate-400">
                            {c.budgeted > 0 ? fmt(c.budgeted) : '—'}
                          </td>
                          <td className="py-3 text-right text-white font-semibold">
                            {c.actual > 0 ? fmt(c.actual) : '—'}
                          </td>
                          <td className={`py-3 text-right font-semibold ${over ? 'text-red-400' : c.variance < 0 ? 'text-emerald-400' : 'text-slate-500'}`}>
                            {c.variance === 0 ? '—' : `${over ? '+' : '−'}${fmt(Math.abs(c.variance))}`}
                          </td>
                          <td className={`py-3 text-right text-xs ${over ? 'text-red-400' : 'text-slate-500'}`}>
                            {c.variancePct == null ? '—' : `${c.variancePct >= 0 ? '+' : ''}${Math.abs(c.variancePct) >= 999 ? '999+' : c.variancePct}%`}
                          </td>
                          <td className="py-3">
                            <StatusPill category={c} />
                          </td>
                        </tr>
                        {open && (
                          <tr className="border-b border-slate-800/50 bg-slate-950/40">
                            <td />
                            <td colSpan={6} className="py-4 pr-2">
                              <ResourceBreakdown category={c} fmt={fmt} />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t border-slate-700 font-semibold">
                    <td />
                    <td className="py-3 text-slate-300">Total</td>
                    <td className="py-3 text-right text-slate-300">{fmt(report.budgetTotal)}</td>
                    <td className="py-3 text-right text-white">{fmt(report.actualTotal)}</td>
                    <td className={`py-3 text-right ${report.variance > 0 ? 'text-red-400' : 'text-emerald-400'}`}>
                      {`${report.variance >= 0 ? '+' : '−'}${fmt(Math.abs(report.variance))}`}
                    </td>
                    <td colSpan={2} />
                  </tr>
                </tfoot>
              </table>
            </div>
            <p className="text-[11px] text-slate-600 mt-3">
              {imported ? 'Comparing your imported file' : 'Comparing live Azure data'} against{' '}
              {active.length} BOQ{active.length > 1 ? 's' : ''}
              {report.months > 1 ? `, averaged over ${report.months} months to match the monthly estimate.` : '.'}
              {' '}Click any row to see the underlying lines.
            </p>
          </div>

          {/* Same money, any slice: resource group, service, resource, region. */}
          <BoqBreakdown report={report} currency={currency} />
        </>
      )}
    </div>
  );
}

function StatusPill({ category: c }) {
  if (c.unbudgeted) {
    return <span className="text-[11px] px-2 py-1 rounded-lg bg-red-500/20 text-red-300 border border-red-500/30">Not in BOQ</span>;
  }
  if (c.variance > 0) {
    return <span className="text-[11px] px-2 py-1 rounded-lg bg-amber-500/20 text-amber-300 border border-amber-500/30">Over budget</span>;
  }
  if (c.unused) {
    return <span className="text-[11px] px-2 py-1 rounded-lg bg-slate-700/40 text-slate-400 border border-slate-700">Not used</span>;
  }
  return <span className="text-[11px] px-2 py-1 rounded-lg bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">Within budget</span>;
}

/**
 * Line-by-line answer for one category: every BOQ resource with the meters that
 * were actually billed against it, then whatever was billed that no line covers.
 */
/**
 * Plain-English verdict for one BOQ line. The number alone rarely explains an
 * overrun; "you paid for 1 disk, 3 are running" does.
 */
function explain(l) {
  if (!l.matched) {
    return { tone: 'idle', text: `Budgeted ${fmtQty(l.budgetQty, l.sku)}, but nothing matching is being billed. Either it was never deployed, or it is named differently on the bill.` };
  }
  if (l.budgetQty && l.billedCount > l.budgetQty) {
    return {
      tone: 'bad',
      text: `You budgeted for ${l.budgetQty} ${l.sku || 'resource'}${l.budgetQty > 1 ? 's' : ''}, but ${l.billedCount} are being billed — that is ${l.billedCount - l.budgetQty} more than planned.`,
    };
  }
  if (l.variance > 0) {
    return { tone: 'bad', text: `Costing more than the estimate allowed for. Check the size, region or redundancy of this resource.` };
  }
  if (l.variance < 0) {
    return { tone: 'good', text: `Running under the estimate — you are saving here.` };
  }
  return { tone: 'good', text: 'Matches the estimate.' };
}

const fmtQty = (qty, sku) =>
  qty ? `${qty} × ${sku || 'resource'}` : (sku || 'this resource');

const TONE = {
  bad:  { ring: 'border-red-500/40 bg-red-500/[0.05]',      text: 'text-red-300',     dot: 'bg-red-400' },
  good: { ring: 'border-emerald-500/30 bg-emerald-500/[0.04]', text: 'text-emerald-300', dot: 'bg-emerald-400' },
  idle: { ring: 'border-slate-700 bg-slate-900/40',          text: 'text-slate-400',   dot: 'bg-slate-500' },
};

const DIRECTION_LABEL = {
  egress:  { title: 'Going out of Azure (egress)', note: 'Data leaving Azure to the internet or another region — this is what you pay for.' },
  ingress: { title: 'Coming into Azure (ingress)', note: 'Data uploaded into Azure. Normally free, so it should cost close to nothing.' },
  intra:   { title: 'Inside the same region',      note: 'Traffic between zones or resources in one region, billed at a lower rate.' },
  other:   { title: 'Other transfer',              note: 'Transfer meters that do not state a direction.' },
};

function ResourceBreakdown({ category: c, fmt }) {
  const hasPooled = c.pooledLines.length > 0;
  // The traffic panel already lists every transfer meter, so repeating them
  // underneath would just be the same numbers twice.
  const listMeters = !c.traffic;
  // The category total is bigger than the sum of the BOQ lines whenever Azure
  // bills things the estimate never priced, so show that sum explicitly.
  const matchedActual = c.lines.reduce((s, l) => s + l.actual, 0);
  // Every single charge in the category on one line, so the total can be read
  // resource by resource instead of only as two subtotals.
  const allCharges = [
    ...c.lines.flatMap(l => l.matches.map(m => ({
      ...m,
      boqLine: l.custom_name || l.service_type,
    }))),
    ...c.unmatched.map(u => ({ ...u, boqLine: null })),
  ].sort((a, b) => b.cost - a.cost);
  return (
    <div className="space-y-5">
      {c.lines.length > 0 && c.unmatchedTotal > 0 && (
        <div className="border border-slate-700 bg-slate-900/50 rounded-xl p-3.5">
          <p className="text-xs font-semibold text-slate-200 mb-2">
            How the {fmt(c.actual)} for {c.label} adds up
          </p>
          <ul className="text-xs space-y-1 tabular-nums">
            <li className="flex items-baseline gap-2">
              <span className="text-slate-400">
                {c.lines.length} resource{c.lines.length > 1 ? 's' : ''} matched to your BOQ
              </span>
              <span className="flex-1 border-b border-dotted border-slate-700/70 translate-y-[-3px]" />
              <span className="text-slate-200 shrink-0">{fmt(matchedActual)}</span>
            </li>
            <li className="flex items-baseline gap-2">
              <span className="text-red-300">
                {c.unmatched.length} charge{c.unmatched.length > 1 ? 's' : ''} with no BOQ line
              </span>
              <span className="flex-1 border-b border-dotted border-slate-700/70 translate-y-[-3px]" />
              <span className="text-red-300 shrink-0">{fmt(c.unmatchedTotal)}</span>
            </li>
            <li className="flex items-baseline gap-2 pt-1.5 border-t border-slate-800">
              <span className="text-slate-300 font-semibold">Total billed by Azure</span>
              <span className="flex-1 border-b border-dotted border-slate-700/70 translate-y-[-3px]" />
              <span className="text-white font-bold shrink-0">{fmt(c.actual)}</span>
            </li>
          </ul>

          <details className="mt-3">
            <summary className="text-[11px] text-sky-400 cursor-pointer select-none">
              Show all {allCharges.length} charges, resource by resource
            </summary>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-[11px] tabular-nums">
                <thead>
                  <tr className="text-slate-600 border-b border-slate-800">
                    <th className="text-left font-medium py-1 pr-2">Resource</th>
                    <th className="text-left font-medium py-1 pr-2">SKU / size</th>
                    <th className="text-left font-medium py-1 pr-2">Meter</th>
                    <th className="text-left font-medium py-1 pr-2">Resource group</th>
                    <th className="text-left font-medium py-1 pr-2">BOQ line</th>
                    <th className="text-right font-medium py-1">Cost / month</th>
                  </tr>
                </thead>
                <tbody>
                  {allCharges.map((m, i) => (
                    <tr key={i} className="border-b border-slate-800/60">
                      <td className="py-1 pr-2 text-slate-200 break-all">{m.resource_name || '—'}</td>
                      <td className="py-1 pr-2 text-slate-400 whitespace-nowrap">
                        {m.sku ? `${m.sku}${m.size ? ` · ${m.size}` : ''}` : '—'}
                      </td>
                      <td className="py-1 pr-2 text-slate-400">{m.label}</td>
                      <td className="py-1 pr-2 text-slate-500 break-all">{m.resource_group || '—'}</td>
                      <td className="py-1 pr-2">
                        {m.boqLine
                          ? <span className="text-slate-400">{m.boqLine}</span>
                          : <span className="text-red-300">Not in BOQ</span>}
                      </td>
                      <td className={`py-1 text-right font-medium whitespace-nowrap ${m.boqLine ? 'text-slate-200' : 'text-red-300'}`}>
                        {fmt(m.cost)}
                      </td>
                    </tr>
                  ))}
                  <tr>
                    <td colSpan={5} className="py-1.5 text-slate-300 font-semibold">Total</td>
                    <td className="py-1.5 text-right text-white font-bold">{fmt(c.actual)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </details>
        </div>
      )}

      {c.traffic && <TrafficPanel traffic={c.traffic} fmt={fmt} />}

      {c.lines.length > 0 && (
        <div className="space-y-2.5">
          <p className="text-xs font-semibold text-slate-400">
            Resource by resource — {c.lines.length} item{c.lines.length > 1 ? 's' : ''} from your BOQ
          </p>
          {c.lines.map((l) => {
            const verdict = explain(l);
            const tone = TONE[verdict.tone];
            return (
              <div key={l.id} className={`border rounded-xl p-3.5 ${tone.ring}`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      {l.sku && (
                        <span className="text-[10px] font-bold tracking-wide px-1.5 py-0.5 rounded bg-slate-700 text-[#fff]">
                          {l.sku}
                        </span>
                      )}
                      <span className="text-sm font-semibold text-slate-100">
                        {l.custom_name || l.service_type}
                      </span>
                    </div>
                    <p className={`text-xs mt-1.5 flex items-start gap-1.5 ${tone.text}`}>
                      <span className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${tone.dot}`} />
                      {verdict.text}
                    </p>
                  </div>

                  <div className="flex items-stretch gap-4 shrink-0 text-right">
                    <Figure label="BOQ budget" value={fmt(l.monthly_cost)} />
                    <Figure label="Actually billed" value={l.actual > 0 ? fmt(l.actual) : 'nothing'} strong />
                    <Figure
                      label="Difference"
                      value={l.actual === 0 ? '—' : `${l.variance >= 0 ? '+' : '−'}${fmt(Math.abs(l.variance))}`}
                      sub={l.actual === 0 || l.variancePct == null ? null
                        : `${l.variancePct >= 0 ? '+' : ''}${Math.abs(l.variancePct) >= 999 ? '999+' : l.variancePct}%`}
                      className={l.variance > 0 ? 'text-red-400' : l.variance < 0 ? 'text-emerald-400' : 'text-slate-400'}
                      strong
                    />
                  </div>
                </div>

                {l.drivers && l.variance !== 0 && (
                  <WhyPanel line={l} fmt={fmt} />
                )}

                {l.matches.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-slate-700/50">
                    <p className="text-[11px] text-slate-500 mb-1.5">
                      Billed on your invoice as:
                    </p>
                    <ul className="space-y-1">
                      {l.matches.map((m, i) => (
                        <MeterRow key={i} meter={m} fmt={fmt} />
                      ))}
                    </ul>
                  </div>
                )}

                <p className="text-[10px] text-slate-600 mt-2.5">{l.description}</p>
              </div>
            );
          })}
        </div>
      )}

      {c.unmatched.length > 0 && (
        <div
          className={`border rounded-xl p-3.5 ${
            hasPooled ? 'border-slate-700 bg-slate-900/50' : 'border-red-500/40 bg-red-500/[0.06]'
          }`}
        >
          {hasPooled ? (
            <>
              <p className="text-xs font-semibold text-slate-200">
                These are compared as a group, not one by one
              </p>
              <p className="text-[11px] text-slate-500 mt-1">
                {c.pooledLines.map(l => l.custom_name || l.service_type).join(', ')} — these BOQ
                lines don't name a disk or VM size, so the bill can't be split between them.
              </p>
              <div className="flex items-center gap-5 mt-2.5 mb-3">
                <Figure label="BOQ budget" value={fmt(c.pooledBudget)} />
                <Figure label="Actually billed" value={fmt(c.unmatchedTotal)} strong />
                <Figure
                  label="Difference"
                  value={`${c.pooledVariance >= 0 ? '+' : '−'}${fmt(Math.abs(c.pooledVariance))}`}
                  className={c.pooledVariance > 0 ? 'text-red-400' : 'text-emerald-400'}
                  strong
                />
              </div>
            </>
          ) : (
            <>
              <p className="text-xs font-semibold text-red-300">
                Not in your BOQ at all — {fmt(c.unmatchedTotal)} every month
              </p>
              <p className="text-[11px] text-slate-500 mt-1 mb-2.5">
                These resources are running and being charged, but no line in the estimate
                pays for them.
              </p>
            </>
          )}
          <ul className="space-y-1">
            {listMeters && c.unmatched.map((u, i) => (
              <MeterRow key={i} meter={u} fmt={fmt} tone={hasPooled ? '' : 'text-red-300'} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Egress / ingress split with the data volume behind each charge. */
function TrafficPanel({ traffic, fmt }) {
  return (
    <div className="border border-slate-700 bg-slate-900/50 rounded-xl p-3.5">
      <div className="flex flex-wrap items-baseline justify-between gap-3 mb-3">
        <p className="text-xs font-semibold text-slate-200">
          How much data actually moved
        </p>
        <p className="text-xs text-slate-400">
          <span className="text-white font-semibold">{formatBytes(traffic.totalBytes)}</span>
          {' transferred · '}
          <span className="text-white font-semibold">{fmt(traffic.totalCost)}</span>
          {' per month'}
        </p>
      </div>

      <div className="space-y-2.5">
        {traffic.directions.map((d) => {
          const meta = DIRECTION_LABEL[d.direction] || DIRECTION_LABEL.other;
          const share = traffic.totalCost > 0 ? (d.cost / traffic.totalCost) * 100 : 0;
          return (
            <div key={d.direction} className="bg-slate-950/40 rounded-lg p-2.5">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-xs font-medium text-slate-200">{meta.title}</span>
                <span className="text-xs text-slate-300">
                  {formatBytes(d.bytes)} · <span className="text-white font-semibold">{fmt(d.cost)}</span>
                </span>
              </div>
              <p className="text-[10px] text-slate-600 mt-0.5">{meta.note}</p>
              <div className="h-1 rounded-full bg-slate-800 mt-2 overflow-hidden">
                <div
                  className={`h-full rounded-full ${d.direction === 'egress' ? 'bg-amber-400' : 'bg-sky-400'}`}
                  style={{ width: `${Math.min(100, share)}%` }}
                />
              </div>
              <ul className="mt-2 space-y-0.5">
                {d.meters.map((m, i) => (
                  <li key={i} className="flex items-baseline justify-between gap-2 text-[11px]">
                    <span className="text-slate-400 min-w-0 truncate">{m.label}</span>
                    <span className="text-slate-500 shrink-0">
                      {formatBytes(m.bytes)} · <span className="text-slate-300">{fmt(m.cost)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Break an overrun into its two causes so the number is defensible: extra
 * resources running, and each one billing at a different rate than estimated.
 */
function WhyPanel({ line: l, fmt }) {
  const d = l.drivers;
  const unit = l.sku || 'resource';

  // Charge the variance to the actual resources on the invoice. The cheapest
  // ones are treated as the extras, so the budgeted slots are the ones the BOQ
  // most plausibly priced. Every row here is a real resource you can go and
  // look at in the portal, and they still add up to the headline variance.
  const ranked = [...l.matches].sort((a, b) => b.cost - a.cost);
  const budgeted = ranked.slice(0, d.qty);
  const extras = ranked.slice(d.qty);
  const rows = [];

  budgeted.forEach((m) => {
    rows.push({
      amount: m.cost - d.unitBudget,
      name: m.resource_name || m.label,
      group: m.resource_group,
      tag: 'Covered by the BOQ',
      detail: `Budgeted ${fmt(d.unitBudget)} for this ${unit}, Azure billed ${fmt(m.cost)}.`,
    });
  });

  extras.forEach((m) => {
    rows.push({
      amount: m.cost,
      name: m.resource_name || m.label,
      group: m.resource_group,
      tag: 'Not budgeted',
      detail: `The BOQ paid for ${d.qty} ${unit}${d.qty > 1 ? 's' : ''} only, so this whole ${fmt(m.cost)} is extra.`,
    });
  });

  const unfilled = d.qty - l.matches.length;
  if (unfilled > 0) {
    rows.push({
      amount: -(unfilled * d.unitBudget),
      name: `${unfilled} × ${unit} never deployed`,
      tag: 'Budgeted, not billed',
      detail: `The BOQ paid for ${d.qty} but only ${l.matches.length} are on the invoice.`,
    });
  }

  if (!rows.length) return null;

  return (
    <div className="mt-3 pt-3 border-t border-slate-700/50">
      <p className="text-[11px] text-slate-500 mb-2">
        BOQ estimate vs what Azure actually charged:
      </p>
      <table className="w-full text-[11px] mb-3 tabular-nums">
        <thead>
          <tr className="text-slate-600">
            <th className="text-left font-medium pb-1"></th>
            <th className="text-right font-medium pb-1">Qty</th>
            <th className="text-right font-medium pb-1">Rate / {unit} / month</th>
            <th className="text-right font-medium pb-1">Monthly total</th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-t border-slate-800">
            <td className="py-1 text-slate-300">BOQ estimate</td>
            <td className="py-1 text-right text-slate-300">{d.qty}</td>
            <td className="py-1 text-right text-slate-300">{fmt(d.unitBudget)}</td>
            <td className="py-1 text-right text-slate-300">{fmt(l.monthly_cost)}</td>
          </tr>
          <tr className="border-t border-slate-800">
            <td className="py-1 text-slate-200 font-medium">Azure actual</td>
            <td className="py-1 text-right text-slate-200 font-medium">{d.billedCount}</td>
            <td className="py-1 text-right text-slate-200 font-medium">{fmt(d.unitActual)}</td>
            <td className="py-1 text-right text-slate-200 font-medium">{fmt(l.actual)}</td>
          </tr>
          <tr className="border-t border-slate-800">
            <td className="py-1 text-slate-500">Difference</td>
            <td className={`py-1 text-right ${d.extraUnits > 0 ? 'text-red-400' : d.extraUnits < 0 ? 'text-emerald-400' : 'text-slate-500'}`}>
              {d.extraUnits > 0 ? '+' : ''}{d.extraUnits}
            </td>
            <td className={`py-1 text-right ${d.unitActual > d.unitBudget ? 'text-red-400' : d.unitActual < d.unitBudget ? 'text-emerald-400' : 'text-slate-500'}`}>
              {d.unitActual >= d.unitBudget ? '+' : '−'}{fmt(Math.abs(d.unitActual - d.unitBudget))}
            </td>
            <td className={`py-1 text-right font-semibold ${l.variance > 0 ? 'text-red-400' : l.variance < 0 ? 'text-emerald-400' : 'text-slate-500'}`}>
              {l.variance >= 0 ? '+' : '−'}{fmt(Math.abs(l.variance))}
            </td>
          </tr>
        </tbody>
      </table>
      <p className="text-[11px] text-slate-500 mb-2">
        Which resources make up the {l.variance >= 0 ? '+' : '−'}{fmt(Math.abs(l.variance))}:
      </p>
      <ul className="space-y-2">
        {rows.map((r, i) => (
          <li key={i} className="flex items-start gap-2.5 text-xs">
            <span
              className={`shrink-0 font-semibold tabular-nums w-[72px] text-right ${
                r.amount > 0 ? 'text-red-400' : 'text-emerald-400'
              }`}
            >
              {r.amount >= 0 ? '+' : '−'}{fmt(Math.abs(r.amount))}
            </span>
            <span className="min-w-0">
              <span className="text-slate-200 font-medium break-all">{r.name}</span>
              {r.group && <span className="text-[10px] text-slate-600 ml-1.5">{r.group}</span>}
              <span
                className={`text-[10px] px-1.5 py-0.5 rounded ml-1.5 align-middle ${
                  r.tag === 'Not budgeted'
                    ? 'bg-red-500/20 text-red-300'
                    : 'bg-slate-700 text-slate-300'
                }`}
              >
                {r.tag}
              </span>
              <span className="block text-[11px] text-slate-500 mt-0.5">{r.detail}</span>
            </span>
          </li>
        ))}
        <li className="flex items-start gap-2.5 text-xs pt-1.5 border-t border-slate-800">
          <span
            className={`shrink-0 font-bold tabular-nums w-[72px] text-right ${
              l.variance > 0 ? 'text-red-400' : 'text-emerald-400'
            }`}
          >
            {l.variance >= 0 ? '+' : '−'}{fmt(Math.abs(l.variance))}
          </span>
          <span className="text-slate-400">Total difference for this line</span>
        </li>
      </ul>
    </div>
  );
}

/**
 * One billed meter: what it is on the left, what it cost on the right.
 *
 * The headline figure is an average across the months in view, which is not
 * something a finance team can reconcile on its own — so every row opens up to
 * the individual monthly charges, with the metered quantity behind each one.
 */
function MeterRow({ meter, fmt, tone = 'text-slate-200' }) {
  const [open, setOpen] = useState(false);
  const parts = meter.parts || [];
  const canOpen = parts.length > 0;

  return (
    <li className="text-xs">
      <div
        className={`flex items-baseline gap-2 ${canOpen ? 'cursor-pointer group' : ''}`}
        onClick={canOpen ? () => setOpen(o => !o) : undefined}
        role={canOpen ? 'button' : undefined}
        tabIndex={canOpen ? 0 : undefined}
        onKeyDown={canOpen ? (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(o => !o); }
        } : undefined}
      >
        {canOpen && (
          <ChevronRight
            className={`w-3 h-3 shrink-0 text-slate-500 transition-transform ${open ? 'rotate-90' : ''}`}
          />
        )}
        {meter.resource_name && (
          <span className="text-slate-200 font-medium shrink-0 max-w-[190px] truncate" title={meter.resource_name}>
            {meter.resource_name}
          </span>
        )}
        {meter.size && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-700 text-[#fff] shrink-0">
            {meter.sku} · {meter.size}
          </span>
        )}
        <span className="text-slate-400 truncate">{meter.label}</span>
        {meter.resource_group && (
          <span className="text-[10px] text-slate-600 shrink-0">{meter.resource_group}</span>
        )}
        <span className="flex-1 border-b border-dotted border-slate-700/70 translate-y-[-3px]" />
        <span className={`font-medium shrink-0 ${tone || 'text-slate-200'}`}>{fmt(meter.cost)}</span>
      </div>

      {open && (
        <div className="ml-5 mt-1.5 mb-2 border-l border-slate-700/70 pl-3">
          <p className="text-[10px] text-slate-500 mb-1">
            {parts.length === 1
              ? `Billed once, in ${parts[0].month || 'the period shown'}:`
              : `${fmt(meter.cost)} is the average of ${parts.length} months of charges on this meter:`}
          </p>
          <table className="w-full max-w-md text-[11px] tabular-nums">
            <tbody>
              {parts.map((p) => (
                <tr key={p.month}>
                  <td className="py-0.5 pr-4 text-slate-400 whitespace-nowrap w-16">{p.month || '—'}</td>
                  <td className="py-0.5 pr-4 text-slate-500 whitespace-nowrap">
                    {p.quantity ? <Quantity value={p.quantity} unit={p.unit} /> : ''}
                  </td>
                  <td className="py-0.5 text-right text-slate-200 whitespace-nowrap">{fmt(p.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </li>
  );
}


function Figure({ label, value, sub, className = 'text-slate-300', strong = false }) {  return (
    <div className="text-right">
      <p className="text-[10px] uppercase tracking-wide text-slate-600">{label}</p>
      <p className={`${strong ? 'text-sm font-bold' : 'text-xs font-medium'} whitespace-nowrap ${className}`}>
        {value}
      </p>
      {sub && <p className={`text-[10px] ${className} opacity-80`}>{sub}</p>}
    </div>
  );
}

function SummaryCard({ label, value, hint, tone, icon: Icon, onClick, active = false }) {
  const ring = tone === 'bad'
    ? 'border-red-500/30 bg-red-500/[0.07]'
    : tone === 'good'
      ? 'border-emerald-500/30 bg-emerald-500/[0.07]'
      : 'border-slate-800 bg-slate-900';
  const accent = tone === 'bad' ? 'text-red-400' : tone === 'good' ? 'text-emerald-400' : 'text-slate-400';
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left border rounded-2xl p-5 transition cursor-pointer hover:border-slate-600 ${ring} ${
        active ? 'ring-2 ring-blue-500/60' : ''
      }`}
    >
      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-400 uppercase tracking-wide">{label}</p>
        {Icon && <Icon className={`w-4 h-4 ${accent}`} />}
      </div>
      <p className="text-2xl font-bold text-white mt-2">{value}</p>
      <p className="text-xs text-slate-500 mt-1">{hint}</p>
      <p className="text-[10px] text-slate-600 mt-2">
        {active ? 'Showing these below · click to clear' : 'Click to see what makes this up'}
      </p>
    </button>
  );
}
