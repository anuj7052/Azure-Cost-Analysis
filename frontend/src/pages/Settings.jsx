import { useState, useRef } from 'react';
import { Plus, Trash2, Upload, CheckCircle, FileSpreadsheet, FileText, FileType, X } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { deleteTenant, uploadCSV } from '../api/client';
import AddTenantModal from '../components/TenantManager/AddTenantModal';
import PortalGuide, { EXPORT_GUIDE } from '../components/Common/PortalGuide';
import { formatAmount } from '../utils/currency';
import toast from 'react-hot-toast';

const ACCEPTED = '.csv,.tsv,.txt,.xlsx,.xlsm,.xls,.pdf';

export default function Settings() {
  const {
    tenants, subscriptions, selectedSubscriptionIds, toggleSubscription,
    removeTenantFromList, loadCosts, imported, setImported, clearImported, setImportCurrency,
  } = useAppStore();
  const [showModal, setShowModal] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef(null);

  const handleDeleteTenant = async (t) => {
    if (t.source === 'delegated') {
      toast.error("Cannot remove delegated (Microsoft login) tenants");
      return;
    }
    setDeletingId(t.tenant_id);
    try {
      await deleteTenant(t.tenant_id);
      removeTenantFromList(t.tenant_id);
      toast.success(`Tenant "${t.tenant_name}" removed`);
    } catch (err) {
      toast.error(err.response?.data?.detail || err.message);
    } finally {
      setDeletingId(null);
    }
  };

  const importFile = async (file) => {
    if (!file) return;
    setUploading(true);
    try {
      const data = await uploadCSV(file);
      setImported(data);
      toast.success(
        `${data.file_name} imported — ${data.rows_used.toLocaleString()} rows, ` +
        `${data.months.length} month(s), ${data.subscriptions.length} subscription(s)`
      );
    } catch (err) {
      toast.error(err.response?.data?.detail || err.message);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const handleFileUpload = (e) => importFile(e.target.files?.[0]);

  const handleDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    importFile(e.dataTransfer.files?.[0]);
  };

  return (
    <div className="p-6 space-y-6 max-w-2xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold text-white">Settings</h1>
        <p className="text-slate-400 text-sm mt-1">Manage tenants, subscriptions, and data sources</p>
      </div>

      {/* Tenants */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className="text-sm font-semibold text-white">Connected Tenants</h2>
            <p className="text-xs text-slate-500 mt-0.5">Delegated (your login) + Service Principal tenants</p>
          </div>
          <button
            onClick={() => setShowModal(true)}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-[#fff] text-sm px-3 py-2 rounded-xl transition"
          >
            <Plus className="w-4 h-4" />
            Add Tenant
          </button>
        </div>

        <div className="space-y-2">
          {tenants.length === 0 && (
            <p className="text-slate-500 text-sm text-center py-4">No tenants connected yet</p>
          )}
          {tenants.map(t => (
            <div key={t.tenant_id} className="flex items-center gap-3 bg-slate-800 rounded-xl px-4 py-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-white truncate">{t.tenant_name}</p>
                <p className="text-xs text-slate-500 font-mono">{t.tenant_id}</p>
              </div>
              <span className={`text-xs px-2 py-0.5 rounded-full ${
                t.source === 'delegated' ? 'bg-blue-900/60 text-blue-300' : 'bg-purple-900/60 text-purple-300'
              }`}>
                {t.source === 'delegated' ? 'Microsoft Login' : 'Service Principal'}
              </span>
              {t.source === 'service_principal' && (
                <button
                  onClick={() => handleDeleteTenant(t)}
                  disabled={deletingId === t.tenant_id}
                  className="text-slate-500 hover:text-red-400 transition p-1"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Subscriptions */}
      {subscriptions.length > 0 && (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 elevated">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-white">Subscriptions</h2>
            <span className="text-xs text-slate-500">
              {selectedSubscriptionIds.length} of {subscriptions.length} selected
            </span>
          </div>
          <div className="space-y-2">
            {subscriptions.map(sub => (
              <label key={sub.subscription_id} className="flex items-center gap-3 bg-slate-800 rounded-xl px-4 py-3 cursor-pointer hover:bg-slate-700/60 transition">
                <input
                  type="checkbox"
                  checked={selectedSubscriptionIds.includes(sub.subscription_id)}
                  onChange={() => toggleSubscription(sub.subscription_id)}
                  className="rounded accent-blue-500"
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-white truncate">{sub.display_name}</p>
                  <p className="text-xs text-slate-500 font-mono truncate">{sub.subscription_id}</p>
                </div>
                {sub.total_cost != null && (
                  <span className="text-xs text-slate-300 font-semibold shrink-0">
                    {formatAmount(sub.total_cost, imported?.currency || 'INR')}
                  </span>
                )}
                <span className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${
                  sub.state === 'Enabled' ? 'bg-emerald-900/60 text-emerald-400'
                    : sub.state === 'Imported' ? 'bg-blue-900/60 text-blue-300'
                    : 'bg-slate-700 text-slate-500'
                }`}>
                  {sub.state}
                </span>
              </label>
            ))}
          </div>
          {!imported && (
            <button
              onClick={loadCosts}
              className="mt-4 w-full text-sm bg-blue-600 hover:bg-blue-500 text-[#fff] py-2.5 rounded-xl font-medium transition"
            >
              Apply &amp; Refresh Data
            </button>
          )}
          {imported && (
            <p className="mt-4 text-xs text-slate-500 text-center">
              Filters apply instantly to the imported file — every page updates as you tick subscriptions.
            </p>
          )}
        </div>
      )}

      {/* File import */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 elevated">
        <h2 className="text-sm font-semibold text-white mb-1">Import cost file</h2>
        <p className="text-xs text-slate-500 mb-4">
          Upload an Azure cost export as <strong className="text-slate-400">CSV, Excel or PDF</strong>.
          It replaces live API data for this session and stays fully filterable by subscription and date.
        </p>

        {imported ? (
          <div className="border border-emerald-500/30 bg-emerald-950/20 rounded-xl p-4 space-y-3">
            <div className="flex items-start gap-3">
              <CheckCircle className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-white truncate">{imported.file_name}</p>
                <p className="text-xs text-slate-400 mt-0.5">
                  {imported.rows_used.toLocaleString()} of {imported.rows_read.toLocaleString()} rows imported
                  {' · '}{imported.source_type.toUpperCase()}
                  {' · '}{imported.currency}
                </p>
              </div>
              <button
                onClick={clearImported}
                title="Remove the import and go back to live Azure data"
                className="text-slate-500 hover:text-red-400 transition p-1 shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <SummaryStat label="Months" value={imported.months.length} />
              <SummaryStat label="Subscriptions" value={imported.subscriptions.length} />
              <SummaryStat label="Period" value={`${imported.months[0] ?? '—'} → ${imported.months.at(-1) ?? '—'}`} />
            </div>

            <label className="flex items-center gap-2 text-xs text-slate-400">
              <span>Currency</span>
              <select
                value={imported.currency}
                onChange={(e) => setImportCurrency(e.target.value)}
                title="Set this if the file has no currency column and the amounts are shown with the wrong symbol"
                className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-slate-200"
              >
                {['INR', 'USD', 'EUR', 'GBP', 'AUD', 'CAD', 'SGD', 'AED', 'JPY'].map(c => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
              <span className="text-[11px] text-slate-600">
                Partner usage reports often omit the currency — set it here if the amounts look wrong.
              </span>
            </label>

            {imported.dated === false && (
              <p className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-xl px-3 py-2">
                This export has no date column, so every row was filed under {imported.months[0]}.
                Totals and subscription filters are exact; the month-by-month trend will show a
                single bar. Add a <span className="font-semibold">Date</span> or{' '}
                <span className="font-semibold">BillingMonth</span> column for a real trend.
              </p>
            )}

            <button
              onClick={clearImported}
              className="w-full py-2 rounded-xl border border-slate-700 text-slate-300 hover:bg-slate-800 text-xs font-medium transition"
            >
              Switch back to live Azure data
            </button>
          </div>
        ) : (
          <label
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            className={`flex flex-col items-center gap-3 border-2 border-dashed rounded-xl p-8 cursor-pointer transition ${
              uploading || dragging ? 'border-blue-500 bg-blue-950/20' : 'border-slate-700 hover:border-slate-600'
            }`}
          >
            <input ref={fileRef} type="file" accept={ACCEPTED} onChange={handleFileUpload} className="sr-only" disabled={uploading} />
            <Upload className={`w-8 h-8 ${uploading ? 'text-blue-400 animate-bounce' : 'text-slate-500'}`} />
            <div className="text-center">
              <p className="text-sm font-medium text-slate-300">
                {uploading ? 'Parsing your file…' : 'Drop a file here, or click to browse'}
              </p>
              <p className="text-xs text-slate-600 mt-0.5">Max 20 MB</p>
            </div>
            <div className="flex items-center gap-4 text-[11px] text-slate-500">
              <span className="flex items-center gap-1.5"><FileText className="w-3.5 h-3.5" /> CSV</span>
              <span className="flex items-center gap-1.5"><FileSpreadsheet className="w-3.5 h-3.5" /> Excel</span>
              <span className="flex items-center gap-1.5"><FileType className="w-3.5 h-3.5" /> PDF</span>
            </div>
          </label>
        )}

        <div className="mt-4 p-3 bg-slate-800/60 rounded-xl space-y-1">
          <p className="text-xs text-slate-400 font-medium">Columns we look for</p>
          <p className="text-xs text-slate-500 font-mono break-words">
            Date · Cost / CostInBillingCurrency / PreTaxCost · ServiceName · SubscriptionId · SubscriptionName · ResourceGroup · Currency
          </p>
          <p className="text-xs text-slate-500 font-mono break-words">
            Meter · MeterCategory · UnitOfMeasure · Quantity <span className="text-slate-600">(unlocks the bandwidth report)</span>
          </p>
          <p className="text-[11px] text-slate-600">Only a cost column is strictly required — a resource-level export with no date still imports as a single period. Names are case-insensitive and common Azure aliases are accepted.</p>
        </div>
      </div>

      <PortalGuide {...EXPORT_GUIDE} />

      {showModal && <AddTenantModal onClose={() => setShowModal(false)} />}
    </div>
  );
}

function SummaryStat({ label, value }) {
  return (
    <div className="bg-slate-800/60 rounded-lg px-3 py-2">
      <p className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">{label}</p>
      <p className="text-xs font-bold text-white mt-0.5 truncate">{value}</p>
    </div>
  );
}
