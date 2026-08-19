import { useEffect, useState } from 'react';
import {
  Trash2, AlertTriangle, CheckCircle2, ChevronDown, ChevronRight,
  Loader2, ShieldAlert, Wallet,
} from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { formatAmount, formatAmountFull } from '../utils/currency';
import { exactAmount } from '../utils/exact';
import { Amount } from '../components/Common/Amount';

/**
 * "certain" means Azure itself reports the resource as detached — deleting it
 * cannot break a running workload. "likely" still needs a human to confirm
 * intent, so the two are never shown as the same kind of finding.
 */
const SEVERITY = {
  certain: {
    label: 'Definite waste',
    chip: 'bg-red-500/10 text-red-300 border-red-500/30',
    dot: 'bg-red-400',
  },
  likely: {
    label: 'Review needed',
    chip: 'bg-amber-500/10 text-amber-300 border-amber-500/30',
    dot: 'bg-amber-400',
  },
};

function Kpi({ icon: Icon, label, value, sub, tone = 'slate', title }) {
  const tones = {
    slate: 'text-slate-100',
    red: 'text-red-300',
    emerald: 'text-emerald-300',
  };
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 elevated">
      <div className="flex items-center gap-2 text-slate-400 text-xs font-medium">
        <Icon className="w-4 h-4" />
        {label}
      </div>
      <p className={`mt-2 text-2xl font-semibold tabular-nums ${tones[tone]}`} title={title}>{value}</p>
      {sub && <p className="mt-1 text-xs text-slate-500">{sub}</p>}
    </div>
  );
}

function Category({ category, currency, expanded, onToggle }) {
  const sev = SEVERITY[category.severity] || SEVERITY.likely;

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-5 py-4 text-left hover:bg-slate-800/50 transition"
      >
        {expanded
          ? <ChevronDown className="w-4 h-4 text-slate-500 shrink-0" />
          : <ChevronRight className="w-4 h-4 text-slate-500 shrink-0" />}

        <span className={`w-2 h-2 rounded-full shrink-0 ${sev.dot}`} />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-semibold text-white">{category.title}</p>
            <span className={`text-[11px] px-2 py-0.5 rounded-full border ${sev.chip}`}>
              {sev.label}
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-1 leading-relaxed">{category.reason}</p>
        </div>

        <div className="text-right shrink-0">
          <p className="text-sm font-semibold text-white">
            {category.monthly_cost > 0
              ? <Amount value={category.monthly_cost} currency={currency} />
              : '—'}
          </p>
          <p className="text-xs text-slate-500">{category.count} resource{category.count === 1 ? '' : 's'}</p>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-slate-800 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800 bg-slate-950/40 text-xs text-slate-500">
                <th className="text-left font-medium px-5 py-2.5">Name</th>
                <th className="text-left font-medium px-3 py-2.5">Detail</th>
                <th className="text-left font-medium px-3 py-2.5">Resource group</th>
                <th className="text-left font-medium px-3 py-2.5">Location</th>
                <th className="text-right font-medium px-5 py-2.5">Monthly cost</th>
              </tr>
            </thead>
            <tbody>
              {category.items.map(item => (
                <tr key={item.id} className="border-b border-slate-800/50 last:border-0 hover:bg-slate-800/30">
                  <td className="px-5 py-2.5 text-slate-200 font-medium max-w-[220px] truncate" title={item.name}>
                    {item.name}
                  </td>
                  <td className="px-3 py-2.5 text-slate-400">{item.detail || '—'}</td>
                  <td className="px-3 py-2.5 text-slate-400 max-w-[180px] truncate" title={item.resource_group}>
                    {item.resource_group || '—'}
                  </td>
                  <td className="px-3 py-2.5 text-slate-400">{item.location || '—'}</td>
                  <td className="px-5 py-2.5 text-right text-slate-200">
                    {/* A blank cost is "not billed in the window", not "free". */}
                    {item.monthly_cost != null
                      ? <Amount value={item.monthly_cost} currency={currency} />
                      : <span title="Not billed in this period">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function Orphaned() {
  const {
    selectedTenantId, selectedSubscriptionIds, imported,
    orphanedData, orphanedLoading, orphanedError, loadOrphaned,
  } = useAppStore();

  const [open, setOpen] = useState({});

  useEffect(() => {
    if (selectedTenantId && selectedSubscriptionIds.length > 0) loadOrphaned();
  }, [selectedTenantId, selectedSubscriptionIds.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  const currency = orphanedData?.currency || 'INR';
  const categories = orphanedData?.categories || [];
  const certainCost = categories
    .filter(c => c.severity === 'certain')
    .reduce((sum, c) => sum + (c.monthly_cost || 0), 0);

  return (
    <div className="p-6 space-y-6 max-w-screen-2xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold text-white">Orphaned Resources</h1>
        <p className="text-slate-400 text-sm mt-1">
          Resources that are still billed but attached to nothing
        </p>
      </div>

      {imported && (
        <div className="bg-blue-950/40 border border-blue-500/30 rounded-2xl p-5">
          <p className="text-blue-300 font-medium text-sm">Live Azure data required</p>
          <p className="text-slate-400 text-sm mt-1 leading-relaxed">
            A billing export lists charges, not what each resource is attached to. Remove the
            imported file to scan this tenant for orphaned resources.
          </p>
        </div>
      )}

      {!selectedTenantId && !imported && (
        <div className="bg-blue-950/40 border border-blue-500/30 rounded-2xl p-6 text-center">
          <p className="text-blue-300 font-medium">No tenant selected</p>
          <p className="text-slate-400 text-sm mt-1">Add a tenant from Settings to get started.</p>
        </div>
      )}

      {orphanedError && (
        <div className="bg-red-950/30 border border-red-500/30 rounded-2xl p-4 text-red-400 text-sm">
          {orphanedError}
        </div>
      )}

      {orphanedLoading && !orphanedData && (
        <div className="flex items-center justify-center gap-3 py-16 text-slate-400">
          <Loader2 className="w-5 h-5 animate-spin" />
          Scanning subscriptions…
        </div>
      )}

      {orphanedData && (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <Kpi
              icon={Wallet}
              label="Recoverable per month"
              value={formatAmountFull(certainCost, currency)}
              title={exactAmount(certainCost, currency)}
              sub="From definite waste only"
              tone="emerald"
            />
            <Kpi
              icon={Trash2}
              label="Orphaned resources"
              value={orphanedData.total_count}
              sub={`Across ${selectedSubscriptionIds.length} subscription(s)`}
            />
            <Kpi
              icon={ShieldAlert}
              label="Total billed waste"
              value={formatAmountFull(orphanedData.total_monthly_cost, currency)}
              title={exactAmount(orphanedData.total_monthly_cost, currency)}
              sub="Includes items needing review"
              tone="red"
            />
          </div>

          {orphanedData.errors?.length > 0 && (
            <div className="bg-amber-950/30 border border-amber-500/30 rounded-2xl p-4">
              <div className="flex items-center gap-2 text-amber-300 text-sm font-medium">
                <AlertTriangle className="w-4 h-4" />
                Some checks could not complete
              </div>
              <p className="text-xs text-slate-400 mt-1.5 leading-relaxed">
                These results are partial. The service principal may lack read access for:{' '}
                {orphanedData.errors.map(e => e.rule).join(', ')}.
              </p>
            </div>
          )}

          {orphanedData.total_count === 0 ? (
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-10 text-center">
              <CheckCircle2 className="w-10 h-10 text-emerald-400 mx-auto mb-3" />
              <p className="text-white font-semibold">No orphaned resources found</p>
              <p className="text-slate-400 text-sm mt-1">
                Every scanned resource is attached to something.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {categories.filter(c => c.count > 0).map(category => (
                <Category
                  key={category.key}
                  category={category}
                  currency={currency}
                  expanded={!!open[category.key]}
                  onToggle={() => setOpen(o => ({ ...o, [category.key]: !o[category.key] }))}
                />
              ))}
            </div>
          )}

          <p className="text-xs text-slate-600 leading-relaxed">
            This report is read-only. Delete resources from the Azure portal or your
            infrastructure-as-code, so the change is reviewed and recorded where the rest of
            your infrastructure history lives.
          </p>
        </>
      )}
    </div>
  );
}
