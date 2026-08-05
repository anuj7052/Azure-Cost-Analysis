import { useMsal } from '@azure/msal-react';
import { useAppStore } from '../../store/useAppStore';
import { useTheme } from '../../store/useTheme';
import { RefreshCw, LogOut, ChevronDown, Calendar, X, Moon, Sun, FileText } from 'lucide-react';
import { useState } from 'react';
import { evictAll } from '../../utils/persistCache';

const ROLLING_OPTIONS = [1, 3, 6, 12];
const ALL_MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

export default function Topbar() {
  const { accounts, instance } = useMsal();
  const {
    loadCosts, costLoading, months, setMonths,
    dateMode, fromDate, toDate, setCustomDateRange,
    selectedTenantId, tenants, setSelectedTenant,
    imported, clearImported, loadBandwidth,
  } = useAppStore();
  const theme       = useTheme(s => s.theme);
  const toggleTheme = useTheme(s => s.toggleTheme);
  const [tenantOpen, setTenantOpen]     = useState(false);
  const [filterOpen, setFilterOpen]     = useState(false);
  const [filterTab, setFilterTab]       = useState('rolling'); // 'rolling' | 'month' | 'custom'
  const [customFrom, setCustomFrom]     = useState('');
  const [customTo, setCustomTo]         = useState('');
  // For month picker — stores "YYYY-M" strings e.g. "2026-3"
  const [pickedYear]                    = useState(new Date().getFullYear());

  // Refresh must bypass the local cache, otherwise it would re-serve the very
  // data the user is asking to replace.
  const hardRefresh = () => {
    loadCosts({ force: true });
    loadBandwidth({ force: true });
  };

  const user = accounts[0];
  const initials = user?.name
    ? user.name.split(' ').map(n => n[0]).slice(0, 2).join('').toUpperCase()
    : '??';

  const currentTenant = tenants.find(t => t.tenant_id === selectedTenantId);
  const tenantLabel = (() => {
    if (!currentTenant) return 'Select tenant';
    const name = currentTenant.tenant_name;
    if (/^[0-9a-f-]{36}$/i.test(name)) {
      const domain = (user?.username || '').split('@')[1];
      return domain ? `My Tenant (${domain})` : 'My Azure Tenant';
    }
    return name;
  })();

  // Human-readable label for current filter
  const filterLabel = (() => {
    if (dateMode === 'custom' && fromDate && toDate) return `${fromDate} → ${toDate}`;
    return `Last ${months}M`;
  })();

  // Changing the range updates `dateKey`, and every page re-runs its own load
  // effect off that — so no page is left showing data for the previous range.
  const applyRolling = (m) => {
    setMonths(m);
    setFilterOpen(false);
  };

  const applyMonth = (monthIdx) => {
    // monthIdx: 0=Jan … 11=Dec
    const from = `${pickedYear}-${String(monthIdx + 1).padStart(2, '0')}-01`;
    const lastDay = new Date(pickedYear, monthIdx + 1, 0).getDate();
    const to   = `${pickedYear}-${String(monthIdx + 1).padStart(2, '0')}-${lastDay}`;
    setCustomDateRange(from, to);
    setFilterOpen(false);
  };

  const applyCustom = () => {
    if (!customFrom || !customTo) return;
    setCustomDateRange(customFrom, customTo);
    setFilterOpen(false);
  };

  const clearFilter = () => {
    setMonths(6);
  };

  return (
    <header className="h-14 bg-slate-900/85 backdrop-blur-xl border-b border-slate-800 flex items-center px-5 gap-3 sticky top-0 z-40 elevated">
      {/* Tenant selector */}
      <div className="relative">
        <button
          onClick={() => setTenantOpen(o => !o)}
          className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 px-3 py-1.5 rounded-lg text-sm text-slate-300 transition"
        >
          <span className="max-w-[180px] truncate">{tenantLabel}</span>
          <ChevronDown className="w-3.5 h-3.5 text-slate-500 shrink-0" />
        </button>
        {tenantOpen && (
          <div className="absolute top-full left-0 mt-1 bg-slate-800 border border-slate-700 rounded-xl shadow-xl z-50 min-w-[220px] py-1">
            {tenants.length === 0 && (
              <p className="px-4 py-3 text-xs text-slate-500">No tenants loaded yet</p>
            )}
            {tenants.map(t => {
              const isGuid    = /^[0-9a-f-]{36}$/i.test(t.tenant_name);
              const domain    = (user?.username || '').split('@')[1];
              const dispName  = isGuid ? (domain ? `My Tenant (${domain})` : 'My Azure Tenant') : t.tenant_name;
              return (
                <button
                  key={t.tenant_id}
                  onClick={() => { setSelectedTenant(t.tenant_id); setTenantOpen(false); }}
                  className={`w-full text-left px-4 py-2.5 text-sm hover:bg-slate-700 transition ${
                    t.tenant_id === selectedTenantId ? 'text-blue-400' : 'text-slate-300'
                  }`}
                >
                  <p className="font-medium">{dispName}</p>
                  <p className="text-xs text-slate-500">
                    {t.source === 'delegated' ? 'Microsoft Login' : 'Service Principal'} · {t.tenant_id.slice(0, 8)}…
                  </p>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Date filter pill ── */}
      <div className="relative">
        <button
          onClick={() => setFilterOpen(o => !o)}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm transition ${
            dateMode === 'custom'
              ? 'bg-blue-600/20 border border-blue-500/40 text-blue-300 hover:bg-blue-600/30'
              : 'bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700'
          }`}
        >
          <Calendar className="w-3.5 h-3.5 shrink-0" />
          <span>{filterLabel}</span>
          <ChevronDown className="w-3 h-3 text-slate-500 shrink-0" />
        </button>
        {dateMode === 'custom' && (
          <button
            onClick={clearFilter}
            className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-slate-600 hover:bg-red-500 flex items-center justify-center transition"
            title="Clear custom filter"
          >
            <X className="w-2.5 h-2.5 text-[#fff]" />
          </button>
        )}

        {filterOpen && (
          <div className="absolute top-full left-0 mt-1 bg-slate-800 border border-slate-700 rounded-2xl shadow-2xl z-50 w-80 p-4 space-y-4">
            {/* Tab row */}
            <div className="flex gap-1 bg-slate-900 rounded-xl p-1">
              {[
                { key: 'rolling', label: 'Rolling' },
                { key: 'month',   label: 'By Month' },
                { key: 'custom',  label: 'Custom' },
              ].map(t => (
                <button
                  key={t.key}
                  onClick={() => setFilterTab(t.key)}
                  className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition ${
                    filterTab === t.key ? 'bg-blue-600 text-[#fff] shadow-sm' : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {/* Rolling (1M / 3M / 6M / 12M) */}
            {filterTab === 'rolling' && (
              <div className="grid grid-cols-4 gap-2">
                {ROLLING_OPTIONS.map(m => (
                  <button
                    key={m}
                    onClick={() => applyRolling(m)}
                    className={`py-2 rounded-xl text-sm font-semibold transition ${
                      dateMode === 'rolling' && months === m
                        ? 'bg-blue-600 text-[#fff]'
                        : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                    }`}
                  >
                    {m}M
                  </button>
                ))}
              </div>
            )}

            {/* Month picker */}
            {filterTab === 'month' && (
              <div className="space-y-2">
                <p className="text-xs text-slate-400 font-semibold">{pickedYear}</p>
                <div className="grid grid-cols-4 gap-2">
                  {ALL_MONTHS.map((label, idx) => {
                    const isFuture = new Date(pickedYear, idx, 1) > new Date();
                    const isActive = dateMode === 'custom' &&
                      fromDate === `${pickedYear}-${String(idx + 1).padStart(2, '0')}-01`;
                    return (
                      <button
                        key={idx}
                        disabled={isFuture}
                        onClick={() => applyMonth(idx)}
                        className={`py-1.5 rounded-xl text-xs font-medium transition ${
                          isFuture
                            ? 'bg-slate-700/30 text-slate-600 cursor-not-allowed'
                            : isActive
                              ? 'bg-blue-600 text-[#fff]'
                              : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                        }`}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Custom date range */}
            {filterTab === 'custom' && (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <label className="text-xs text-slate-400">From</label>
                  <input
                    type="date"
                    value={customFrom}
                    onChange={e => setCustomFrom(e.target.value)}
                    max={customTo || undefined}
                    className="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-blue-500"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs text-slate-400">To</label>
                  <input
                    type="date"
                    value={customTo}
                    onChange={e => setCustomTo(e.target.value)}
                    min={customFrom || undefined}
                    className="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-blue-500"
                  />
                </div>
                <button
                  onClick={applyCustom}
                  disabled={!customFrom || !customTo}
                  className="w-full py-2 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-[#fff] text-sm font-medium transition"
                >
                  Apply Range
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex-1" />

      {/* Imported-file indicator */}
      {imported && (
        <div className="hidden sm:flex items-center gap-2 bg-blue-600/15 border border-blue-500/30 rounded-lg px-2.5 py-1.5">
          <FileText className="w-3.5 h-3.5 text-blue-400 shrink-0" />
          <span className="text-xs text-blue-300 max-w-[160px] truncate" title={imported.file_name}>
            {imported.file_name}
          </span>
          <button
            onClick={clearImported}
            title="Remove import and use live Azure data"
            className="text-blue-400/70 hover:text-red-400 transition"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Refresh */}
      <button
        onClick={hardRefresh}
        disabled={costLoading}
        className="flex items-center gap-2 text-slate-400 hover:text-white transition text-sm"
      >
        <RefreshCw className={`w-4 h-4 ${costLoading ? 'animate-spin' : ''}`} />
        <span className="hidden md:inline">{costLoading ? 'Loading…' : 'Refresh'}</span>
      </button>

      {/* Theme toggle */}
      <button
        onClick={toggleTheme}
        title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        className="relative w-9 h-9 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 flex items-center justify-center transition-colors overflow-hidden"
      >
        <Sun
          className={`w-4 h-4 absolute transition-all duration-300 ${
            theme === 'light' ? 'opacity-100 rotate-0 scale-100' : 'opacity-0 -rotate-90 scale-50'
          }`}
        />
        <Moon
          className={`w-4 h-4 absolute transition-all duration-300 ${
            theme === 'dark' ? 'opacity-100 rotate-0 scale-100' : 'opacity-0 rotate-90 scale-50'
          }`}
        />
      </button>

      {/* User avatar */}
      <div className="flex items-center gap-2 ml-1">
        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center text-xs font-bold text-[#fff] shrink-0">
          {initials}
        </div>
        <span className="text-sm text-slate-400 hidden md:block truncate max-w-[140px]">
          {user?.name || user?.username || 'User'}
        </span>
        <button
          onClick={() => { evictAll(); instance.logoutPopup(); }}
          title="Sign out"
          className="text-slate-500 hover:text-red-400 transition"
        >
          <LogOut className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
}



