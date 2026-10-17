import { useEffect, useMemo, useRef, useState } from 'react';
import { CostStrip } from '../components/Layout/CostNavigation';
import { BoqHowItWorks, BoqReconcile } from '../components/Boq/BoqPlainSummary';
import { useAppStore } from '../store/useAppStore';
import { reconcileCostRows } from '../utils/costReconciliation';
import { uploadBoq } from '../api/client';
import { formatAmount } from '../utils/currency';
import BoqDashboard from '../components/Boq/BoqDashboard';
import { calendarMonths, compareBoqToUsage } from '../utils/boqCompare';
import toast from 'react-hot-toast';
import { Upload, FileSpreadsheet, X, ChevronDown, ClipboardList } from 'lucide-react';

const ACCEPTED = '.csv,.xlsx,.xlsm,.xls';


export default function Boq() {
  const { boqs, addBoq, removeBoq, toggleBoq, costData, imported, rowsData, rowsLoading, loadCosts, loadCostRows, dailyData, loadDailyCosts, detailedUsageRows, selectedTenantId, selectedSubscriptionIds, dateKey, months: monthsBack, dateMode, fromDate, toDate } = useAppStore();
  const [busy, setBusy] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const perMonth = false;
  const inputRef = useRef(null);
  const hasActiveBoq = boqs.some(boq => boq.enabled !== false);

  // Matching a budget line to the resource that actually billed needs meter
  // level detail, which the cost summary does not carry — fetch both on a plain
  // login so the comparison works without visiting the dashboard first.
  // Switching tenant or subscription has to refetch as well, otherwise the page
  // keeps the previous account's meters or, worse, falls back to service totals
  // and reports a charge like "Backup" as one figure that cannot be explained.
  useEffect(() => {
    if (imported || !hasActiveBoq) return;
    if (!selectedTenantId || selectedSubscriptionIds.length === 0) return;
    loadCosts();
    loadCostRows({ selectedRange: true });
    // The day-by-day line is the only thing on the page that can show a month
    // drifting over budget before the month is over, so it is fetched here
    // rather than left to whichever page happened to be visited first.
    loadDailyCosts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imported, hasActiveBoq, selectedTenantId, selectedSubscriptionIds.join(','), dateKey]);

  const active = boqs.filter(b => b.enabled !== false);
  const currency = costData?.months?.[0]?.currency || costData?.currency || active[0]?.currency || 'INR';
  const fmt = (v) => formatAmount(v, currency);

  // How much of the selected period actually has spend behind it. A BOQ is a
  // whole month's money, so comparing it with four days of a month and calling
  // the difference an underspend is arithmetic nobody asked for. The daily
  // series is the only honest source of this -- the monthly totals cannot say
  // whether a month is complete or three days old.
  const coverage = useMemo(() => {
    const days = dailyData?.days;
    if (!Array.isArray(days) || days.length === 0) return {};
    const monthsCovered = new Set(days.map(d => String(d.date).slice(0, 7)));
    let daysInPeriod = 0;
    for (const key of monthsCovered) {
      const [y, m] = key.split('-').map(Number);
      daysInPeriod += new Date(Date.UTC(y, m, 0)).getUTCDate();
    }
    return { days: days.length, daysInPeriod };
  }, [dailyData]);

  // Meter-level rows give the per-resource match (P20 disk to P20 disk); the
  // service-level summary is only a fallback. Built once and shared, so the
  // month-over-month panel is explaining the same rows the comparison scored
  // rather than a second, separately assembled set of them.
  const movementRows = useMemo(() => {
    if (!costData?.months?.length) return null;
    const detailed = detailedUsageRows();
    // While the meter-level rows are still in flight there is nothing to match
    // on, and the service totals would roll every backup charge into one
    // unexplainable lump. Waiting is better than showing a figure that cannot
    // be broken down.
    if (!detailed?.length && rowsLoading) return null;
    if (detailed?.length) return detailed;
    return costData.months.flatMap(m =>
      Object.entries(m.by_service || {}).map(([service, cost]) => ({
        service, cost, month: m.month,
      })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [costData, imported, rowsData, rowsLoading]);

  const reconciliation = useMemo(() => reconcileCostRows(movementRows || [], costData?.months || [], costData?.months?.[0]?.currency || costData?.currency || 'INR'), [movementRows, costData]);
  const report = useMemo(() => {
    if (!active.length || !movementRows?.length) return null;
    // The plan is multiplied by the number of calendar months selected. Azure
    // labels spend by billing month, and a billing period that crosses a month
    // boundary would otherwise make one selected month count as two.
    const span = dateMode === 'custom' && fromDate && toDate ? calendarMonths(fromDate, toDate) : costData.months.length;
    return compareBoqToUsage(active, reconciliation.rows, span, currency, {
      perMonth, ...coverage,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boqs, costData, currency, movementRows, reconciliation, perMonth, coverage, dateMode, fromDate, toDate]);

  const months = report?.months || 1;
  // The phrase every figure on the page is qualified with. One string so the
  // cards, the chart and the recommendations cannot describe the same number
  // three different ways.
  const per = report?.perMonth
    ? 'per month'
    : report?.partial && report.partial < 1
      ? `over the ${report.days} day${report.days > 1 ? 's' : ''} billed so far`
      : `over ${months} month${months > 1 ? 's' : ''}`;


  // What to ask Azure when the rows on this page cannot name a resource. On an
  // uploaded file there is nothing to ask -- the names are already in the file,
  // and there is no tenant behind it to query.
  const resourceQuery = useMemo(() => {
    if (imported || !selectedTenantId || !selectedSubscriptionIds.length) return null;
    return {
      tenant_id: selectedTenantId,
      subscription_ids: selectedSubscriptionIds,
      months: monthsBack || 6,
      ...(dateMode === 'custom' && fromDate && toDate
        ? { from_date: fromDate, to_date: toDate }
        : {}),
    };
  }, [imported, selectedTenantId, selectedSubscriptionIds, monthsBack, dateMode, fromDate, toDate]);

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


  return (
    <div className="p-6 space-y-6 max-w-screen-2xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold text-white">BOQ vs Actual</h1>
        <p className="text-slate-400 text-sm mt-1">
          Compare the cost you planned with what Azure actually charged, and see exactly
          where the difference comes from.
        </p>
      </div>

      <CostStrip />

      {boqs.length === 0 && <BoqHowItWorks hasEstimate={false} />}

      {/* Generate a BOQ from what is actually deployed. Sits above upload
          because most people arrive without an estimate to upload. */}
      {/* Upload */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-sm font-semibold text-white">Step 1 · Your plan (estimate files)</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Upload the CSV or Excel file you exported from the Azure Pricing Calculator. You can add
              several; their totals are added together. Untick a file to leave it out.
            </p>
          </div>
          <button
            onClick={() => inputRef.current?.click()}
            disabled={busy}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-[#fff] text-sm font-medium px-4 py-2 rounded-xl transition"
          >
            <Upload className="w-4 h-4" />
            {busy ? 'Reading…' : 'Upload estimate'}
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
            <p className="text-sm text-slate-400">Drag your estimate file here, or press Upload estimate</p>
            <p className="text-xs text-slate-600 mt-1">
              Where to get it: azure.microsoft.com/pricing/calculator → open your saved estimate → Export
            </p>
          </div>
        ) : (
          <>
          <button type="button" onClick={() => setShowFiles(v => !v)} aria-expanded={showFiles} className="flex items-center gap-2 text-xs font-medium text-slate-400 hover:text-slate-100">
            <ChevronDown className={`h-4 w-4 transition-transform ${showFiles ? 'rotate-180' : ''}`} aria-hidden="true" />
            {active.length} of {boqs.length} file{boqs.length === 1 ? '' : 's'} in use · {showFiles ? 'hide' : 'manage files'}
          </button>
          {showFiles && <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
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
                      {b.items.length} items · services {formatAmount(b.items_total, b.currency)}
                      {b.managed_services ? ` · support/management ${formatAmount(b.managed_services, b.currency)}` : ''}
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
                  Use this file in the comparison
                </label>
              </div>
            ))}
          </div>}
          </>
        )}
      </div>

      {!report ? (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-8 text-center">
          <p className="text-slate-400 text-sm">
            {boqs.length === 0
              ? 'Upload your estimate file in Step 1 to see the comparison.'
              : !active.length
                ? 'All estimate files are switched off. Tick “Use this file in the comparison” on at least one.'
                : 'No cost data yet. Import a usage file in Settings, or wait for live data to load.'}
          </p>
        </div>
      ) : (
        <>
          {/* Which question the whole page is answering. Placed above the
              numbers it changes, because finding it underneath them means
              reading the numbers wrong first. */}

          <BoqDashboard
            report={report}
            months={costData?.months}
            days={dailyData?.days}
            rows={movementRows}
            resourceQuery={resourceQuery}
            tenantId={selectedTenantId}
            onShowOverruns={() => setShowDetails(true)}
          />


          <button
            type="button"
            aria-expanded={showDetails}
            onClick={() => setShowDetails(v => !v)}
            className="flex w-full items-center justify-between gap-3 rounded-2xl border border-slate-800 bg-slate-900 px-5 py-4 text-left transition hover:border-[#fdba74] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ea580c]"
          >
            <span>
              <span className="block text-sm font-semibold text-slate-100">{showDetails ? 'Hide full comparison' : 'Show full comparison'}</span>
              <span className="mt-0.5 block text-xs text-slate-500">Charts, every service line, resources and daily spend — for a deeper look.</span>
            </span>
            <ChevronDown className={`h-5 w-5 shrink-0 text-[#ea580c] transition-transform ${showDetails ? 'rotate-180' : ''}`} aria-hidden="true" />
          </button>

          {showDetails && <div className="space-y-6">
          <BoqReconcile report={report} fmt={fmt} per={per} query={resourceQuery} />
          </div>}
        </>
      )}
    </div>
  );
}

/**
 * A column heading that sorts.
 *
 * The arrow is drawn faintly on every sortable column rather than only on the
 * active one, because a control that appears on hover is a control nobody knows
 * is there. `aria-sort` carries the same state to a screen reader, which cannot
 * see the arrow at all.
 */
