import { useState } from 'react';
import toast from 'react-hot-toast';
import {
  ClipboardList, Download, FileSpreadsheet, Loader2, AlertTriangle, Server, Info,
} from 'lucide-react';
import { downloadBoqEstimate, generateBoqFromSubscription } from '../../api/client';
import { useAppStore } from '../../store/useAppStore';
import { formatAmountFull } from '../../utils/currency';
import { exactAmount } from '../../utils/exact';
import { downloadBlob, downloadCsv, timestampedName } from '../../utils/csv';

/**
 * A Bill of Quantities built from what is actually running.
 *
 * The rest of the BOQ page runs the other way: an estimate is uploaded and
 * compared against reality. This produces the estimate *from* reality, which is
 * otherwise a manual job — reading the portal resource by resource and copying
 * SKUs into a spreadsheet.
 */
export default function BoqGenerator() {
  const selectedTenantId = useAppStore(s => s.selectedTenantId);
  const selectedSubscriptionIds = useAppStore(s => s.selectedSubscriptionIds);
  const subscriptions = useAppStore(s => s.subscriptions);

  const [boq, setBoq] = useState(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);

  const currency = boq?.currency || 'INR';
  const full = (v) => formatAmountFull(v, currency);

  const generate = async () => {
    if (!selectedTenantId || selectedSubscriptionIds.length === 0) {
      toast.error('Select a tenant and at least one subscription first.');
      return;
    }

    setLoading(true);
    try {
      const result = await generateBoqFromSubscription({
        tenant_id: selectedTenantId,
        subscription_ids: selectedSubscriptionIds,
        months: 1,
      });
      setBoq(result);
      toast.success(`${result.line_count} line items from ${result.resource_count} resources`);
    } catch (err) {
      toast.error(err.response?.data?.detail || err.message || 'Could not build the BOQ.');
    } finally {
      setLoading(false);
    }
  };

  const exportCsv = () => {
    if (!boq) return;

    const rows = [
      ['Service', 'Spec / SKU', 'Region', 'Quantity',
       `Unit monthly (${currency})`, `Monthly total (${currency})`,
       `Yearly total (${currency})`, 'Resource groups', 'Examples'],
      ...boq.items.map(i => [
        i.service,
        i.spec,
        i.region,
        i.quantity,
        // Blank, not zero: "0.00" in a quotation reads as free and gets quoted
        // as such.
        i.unit_monthly_cost == null ? '' : i.unit_monthly_cost.toFixed(2),
        i.monthly_cost.toFixed(2),
        (i.monthly_cost * 12).toFixed(2),
        i.resource_groups.join('; '),
        i.examples.join('; '),
      ]),
      [],
      ['TOTAL', '', '', boq.resource_count, '',
       boq.total_monthly.toFixed(2), boq.total_yearly.toFixed(2), '', ''],
    ];

    downloadCsv(rows, timestampedName('azure-boq'));
    toast.success('BOQ exported');
  };

  /**
   * Download the same BOQ in the pricing calculator's own export layout.
   *
   * Procurement reads that workbook without being told what it is, and it can
   * be placed straight next to a real estimate. A CSV in our own column order
   * has to be explained before it can be used.
   */
  const exportExcel = async () => {
    if (!boq) return;
    setExporting(true);
    try {
      const blob = await downloadBoqEstimate(boq, `${subNames[0] || 'Azure'} — built from live usage`);
      downloadBlob(blob, timestampedName('azure-estimate', 'xlsx'));
      toast.success('Estimate exported');
    } catch (err) {
      toast.error(err.response?.data?.detail || err.message || 'Could not build the workbook.');
    } finally {
      setExporting(false);
    }
  };

  const subNames = subscriptions
    .filter(s => selectedSubscriptionIds.includes(s.subscription_id))
    .map(s => s.display_name);

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
            <ClipboardList className="w-4 h-4 text-blue-400" />
            Build a BOQ from this subscription
          </h2>
          <p className="text-xs text-slate-500 mt-1 leading-relaxed max-w-xl">
            Reads everything currently running, groups it the way a quotation is written,
            and prices it from what Azure actually billed.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {boq && (
            <>
              <button
                onClick={exportExcel}
                disabled={exporting}
                title="Excel, laid out exactly like an Azure Pricing Calculator export"
                className="flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-800 px-3.5 py-2.5 text-sm font-medium text-slate-200 transition hover:bg-slate-700 disabled:opacity-60"
              >
                {exporting
                  ? <Loader2 className="w-4 h-4 animate-spin" />
                  : <FileSpreadsheet className="w-4 h-4 text-emerald-400" />}
                Export Excel
              </button>
              <button
                onClick={exportCsv}
                className="flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-800 px-3.5 py-2.5 text-sm font-medium text-slate-200 transition hover:bg-slate-700"
              >
                <Download className="w-4 h-4" />
                Export CSV
              </button>
            </>
          )}
          <button
            onClick={generate}
            disabled={loading}
            className="flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:opacity-60"
          >
            {loading
              ? <><Loader2 className="w-4 h-4 animate-spin" />Reading resources…</>
              : <><ClipboardList className="w-4 h-4" />Create BOQ</>}
          </button>
        </div>
      </div>

      {!!subNames.length && !boq && (
        <p className="text-[11px] text-slate-600">
          Will scan: {subNames.join(', ')}
        </p>
      )}

      {boq && (
        <>
          <div className="grid gap-3 sm:grid-cols-4">
            <Stat label="Line items" value={boq.line_count} />
            <Stat label="Resources" value={boq.resource_count} />
            <Stat
              label="Monthly"
              value={full(boq.total_monthly)}
              title={exactAmount(boq.total_monthly, currency)}
            />
            <Stat
              label="Yearly (projected)"
              value={full(boq.total_yearly)}
              title={exactAmount(boq.total_yearly, currency)}
            />
          </div>

          {/* A total that silently excludes resources would be quoted as
              complete, so the shortfall is stated rather than buried. */}
          {boq.unpriced_count > 0 && (
            <div className="flex items-start gap-2 bg-amber-950/30 border border-amber-500/30 rounded-xl p-3">
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <p className="text-xs text-slate-400 leading-relaxed">
                {boq.unpriced_count} resource(s) carried no billed cost this period, so
                they appear with a quantity but no price. That is not the same as free —
                Azure may not have billed them yet, or the cost query was throttled.
              </p>
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-800 text-xs text-slate-500">
                  <th className="text-left font-medium py-2">Service</th>
                  <th className="text-left font-medium py-2">Spec / SKU</th>
                  <th className="text-left font-medium py-2">Region</th>
                  <th className="text-right font-medium py-2">Qty</th>
                  <th className="text-right font-medium py-2">Unit / month</th>
                  <th className="text-right font-medium py-2">Monthly</th>
                  <th className="text-right font-medium py-2">Yearly</th>
                </tr>
              </thead>
              <tbody>
                {boq.items.map(item => (
                  <tr
                    key={`${item.service}-${item.spec}-${item.region}`}
                    className="border-b border-slate-800/50 last:border-0 hover:bg-slate-800/30"
                  >
                    <td className="py-2 text-slate-200">
                      {item.service}
                      {!!item.examples.length && (
                        <p className="text-[10px] text-slate-600 truncate max-w-[220px]"
                           title={item.examples.join(', ')}>
                          {item.examples.join(', ')}
                        </p>
                      )}
                    </td>
                    <td className="py-2 text-slate-400">{item.spec}</td>
                    <td className="py-2 text-slate-400">{item.region}</td>
                    <td className="py-2 text-right text-slate-200 tabular-nums">{item.quantity}</td>
                    <td className="py-2 text-right text-slate-400 tabular-nums">
                      {item.unit_monthly_cost == null
                        ? <span title="No billed cost reported for this period">—</span>
                        : full(item.unit_monthly_cost)}
                    </td>
                    <td className="py-2 text-right text-slate-200 tabular-nums"
                        title={exactAmount(item.monthly_cost, currency)}>
                      {full(item.monthly_cost)}
                    </td>
                    <td className="py-2 text-right text-slate-400 tabular-nums">
                      {full(item.monthly_cost * 12)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-slate-700 font-semibold">
                  <td className="py-2.5 text-slate-200" colSpan={3}>Total</td>
                  <td className="py-2.5 text-right text-slate-200 tabular-nums">
                    {boq.resource_count}
                  </td>
                  <td />
                  <td className="py-2.5 text-right text-emerald-300 tabular-nums">
                    {full(boq.total_monthly)}
                  </td>
                  <td className="py-2.5 text-right text-emerald-300 tabular-nums">
                    {full(boq.total_yearly)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          <div className="flex items-start gap-2 text-[11px] text-slate-600 leading-relaxed">
            <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <p>
              Prices are what Azure billed you, not list prices — a quotation built on
              list prices disagrees with the invoice as soon as any discount or
              reservation applies. The yearly figure projects the current month forward
              and is not a commitment.
            </p>
          </div>
        </>
      )}

      {!boq && !loading && (
        <div className="text-center py-8">
          <Server className="w-8 h-8 text-slate-600 mx-auto mb-2" />
          <p className="text-sm text-slate-400">
            No BOQ generated yet — pick your subscriptions and press Create BOQ.
          </p>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, title }) {
  return (
    <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-3.5">
      <p className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">{label}</p>
      <p className="text-lg font-bold text-white mt-1 tabular-nums" title={title}>{value}</p>
    </div>
  );
}
