import { useMsal } from '@azure/msal-react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '../../store/useAppStore';
import { useTheme } from '../../store/useTheme';
import { useNav } from '../../store/useNav';
import { RefreshCw, LogOut, ChevronDown, Calendar, X, Moon, Sun, FileText, Menu, Search, Coins } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { evictAll, evictApiCache } from '../../utils/persistCache';
import { getDisplayCurrency, getRateMeta, setDisplayCurrency } from '../../utils/currency';
import { tenantLabel } from '../../utils/tenantName';
import SubscriptionPicker from './SubscriptionPicker';

// The currencies worth offering: Azure's own pricing currency, the one this
// product is most often billed in, and the three that cover the rest of the
// estates it has been pointed at. "As billed" is first because it is the only
// option that involves no exchange rate and therefore no approximation.
const CURRENCIES = [
  { code: null, label: 'As billed', hint: 'Each figure in the currency Azure invoiced it in' },
  { code: 'INR', label: 'INR ₹' },
  { code: 'USD', label: 'USD $' },
  { code: 'EUR', label: 'EUR €' },
  { code: 'GBP', label: 'GBP £' },
];

const ROLLING_OPTIONS = [1, 3, 6, 12];
const ALL_MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

export default function Topbar() {
  const { accounts, instance } = useMsal();
  const {
    costLoading, months, setMonths,
    dateMode, fromDate, toDate, setCustomDateRange,
    selectedTenantId, tenants, setSelectedTenant,
    imported, clearImported,
  } = useAppStore();
  const theme       = useTheme(s => s.theme);
  const toggleTheme = useTheme(s => s.toggleTheme);
  const toggleNav   = useNav(s => s.toggleNav);
  const [tenantOpen, setTenantOpen]     = useState(false);
  const [filterOpen, setFilterOpen]     = useState(false);
  const [filterTab, setFilterTab]       = useState('rolling'); // 'rolling' | 'month' | 'custom'
  const [customFrom, setCustomFrom]     = useState('');
  const [customTo, setCustomTo]         = useState('');
  // For month picker — stores "YYYY-M" strings e.g. "2026-3"
  const [pickedYear]                    = useState(new Date().getFullYear());
  const [refreshing, setRefreshing]     = useState(false);
  const navigate = useNavigate();
  const [term, setTerm] = useState('');
  const [currencyOpen, setCurrencyOpen] = useState(false);
  const searchRef = useRef(null);

  // ⌘K / Ctrl+K focuses the estate search from anywhere. `select()` rather
  // than only focus, so a leftover previous query is replaced by typing
  // instead of prepended to.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Read once per render rather than mirrored into state: `App` re-renders the
  // whole tree on a currency change, so a local copy would only be a second
  // source for the same fact.
  const display = getDisplayCurrency();
  const rateMeta = getRateMeta();

  const submitSearch = (event) => {
    event.preventDefault();
    const q = term.trim();
    // The page owns the search; the bar only carries the question to it. That
    // keeps one implementation of "what does this term match" rather than a
    // second, subtly different one in the chrome.
    navigate(q ? `/search?q=${encodeURIComponent(q)}` : '/search');
  };

  // Amount formatting lives outside React (chart axis formatters are plain
  // functions), so a currency change is announced through `subscribeCurrency`
  // and re-rendered from `App` rather than from here.

  // Refresh must empty the local cache, not just bypass it for the two datasets
  // this bar happens to know about: anything left behind is re-served the moment
  // the user navigates, which reads as "refresh did nothing".
  /**
   * Refresh has to be unconditional.
   *
   * Re-running the loaders in place could sit for over a minute: a throttled
   * Cost Management call is retried with backoff, and a request that never
   * settles left the button disabled with no way back. Clearing the cached
   * answers and reloading the document cannot hang, and guarantees every page
   * comes back from Azure rather than from localStorage.
   *
   * The sign-in, an uploaded usage file and the BOQ list are deliberately kept:
   * re-fetching cannot bring those back, so wiping them would turn a refresh
   * into data loss and a forced logout.
   */
  const hardRefresh = () => {
    setRefreshing(true);
    evictApiCache();
    window.location.reload();
  };
  const busy = refreshing || costLoading;

  const user = accounts[0];
  const initials = user?.name
    ? user.name.split(' ').map(n => n[0]).slice(0, 2).join('').toUpperCase()
    : '??';

  const currentTenant = tenants.find(t => t.tenant_id === selectedTenantId);
  const tenantLabelText = tenantLabel(currentTenant, user?.username);

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
    /*
     * Wraps below `lg` rather than overflowing.
     *
     * Laid out as a single 64px row this bar needs roughly 520px of controls,
     * so on any phone the right-hand end -- sign out, the theme toggle, the
     * account -- simply fell off the edge with no way to scroll to it. Allowing
     * the row to wrap keeps every control reachable at every width; from `lg`
     * upwards `flex-nowrap` restores the original single-line bar exactly.
     */
    <header className="sticky top-0 z-40 flex flex-wrap items-center gap-2 border-b border-slate-800/80 bg-slate-950/75 px-3 py-2 backdrop-blur-xl elevated sm:gap-3 sm:px-5 lg:h-16 lg:flex-nowrap lg:py-0">
      {/* Opens the navigation drawer. Only meaningful below lg, where the rail
          is off-canvas -- without it every page on a phone is unreachable. */}
      <button
        type="button"
        onClick={toggleNav}
        aria-label="Open navigation"
        className="-ml-1 shrink-0 rounded-xl p-2 text-slate-400 transition hover:bg-slate-800 hover:text-white lg:hidden"
      >
        <Menu className="h-5 w-5" />
      </button>

      {/* Tenant selector */}
      <div className="relative min-w-0">
        <button
          onClick={() => setTenantOpen(o => !o)}
           className="flex max-w-full items-center gap-2 bg-slate-900/80 hover:bg-slate-800 border border-slate-800 px-3 py-2 rounded-xl text-sm text-slate-300 transition"
        >
          <span className="max-w-[110px] sm:max-w-[180px] truncate">{tenantLabelText}</span>
          <ChevronDown className="w-3.5 h-3.5 text-slate-500 shrink-0" />
        </button>
        {tenantOpen && (
          <div className="absolute top-full left-0 mt-1 bg-slate-800 border border-slate-700 rounded-xl shadow-xl z-50 min-w-[220px] max-w-[calc(100vw-1.5rem)] py-1">
            {tenants.length === 0 && (
              <p className="px-4 py-3 text-xs text-slate-500">No tenants loaded yet</p>
            )}
            {tenants.map(t => {
              const dispName = tenantLabel(t, user?.username);
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
                    {t.source === 'delegated' ? 'Microsoft Login'
                      : t.source === 'azure_cli' ? 'Azure CLI'
                      : t.source === 'session_token' ? 'Session Token'
                      : 'Service Principal'} · {t.tenant_id.slice(0, 8)}…
                  </p>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Subscription scope. Sits beside the tenant because the two together
          are what every figure on every page is a sum of, and a reader should
          not have to scroll to find out what they are looking at. */}
      <SubscriptionPicker />

      {/* ── Date filter pill ── */}
      <div className="relative">
        <button
          onClick={() => setFilterOpen(o => !o)}
           className={`flex items-center gap-2 px-3 py-2 rounded-xl text-sm transition ${
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
          <div className="absolute top-full left-0 mt-1 bg-slate-800 border border-slate-700 rounded-2xl shadow-2xl z-50 w-[min(20rem,calc(100vw-1.5rem))] p-4 space-y-4">
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

      {/* Only pushes the actions right once the bar is a single line. On a
          wrapped layout it would force a pointless empty row. */}
      <div className="hidden lg:block lg:flex-1" />

      {/* Estate search. Promoted out of the Cost section because it is not a
          cost question — it answers "where is this thing", which is asked from
          every page, and burying it three clicks deep in one section meant it
          was reached by navigating away from whatever prompted the question.
          ⌘K reaches it from the keyboard, because the person who asks "where
          is this thing" a dozen times a day stops being willing to mouse to
          it around the third time. */}
      {/* min-w floor: with `min-w-0` a crowded row shrank this to a bare
          magnifier overlapping the next control. Better to wrap early than
          to render a search box nothing can be typed into. */}
      <form onSubmit={submitSearch} className="relative min-w-[9rem] flex-1 lg:w-60 lg:max-w-xs lg:flex-none">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
        <input
          ref={searchRef}
          type="search"
          value={term}
          onChange={e => setTerm(e.target.value)}
          placeholder="Search resources…"
          aria-label="Search every resource in this tenant"
          aria-keyshortcuts="Meta+K Control+K"
          className="h-10 w-full rounded-xl border border-slate-800 bg-slate-900/80 pl-8 pr-3 text-sm text-slate-200 placeholder:text-slate-500 transition focus:border-blue-500 focus:outline-none lg:pr-10"
        />
        <kbd className="pointer-events-none absolute right-2.5 top-1/2 hidden -translate-y-1/2 rounded border border-slate-700 bg-slate-800/80 px-1.5 py-0.5 font-mono text-[10px] font-medium text-slate-500 lg:inline">
          ⌘K
        </kbd>
      </form>

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
        disabled={busy}
        className="flex shrink-0 items-center gap-2 text-slate-400 hover:text-white transition text-sm disabled:opacity-60"
      >
        <RefreshCw className={`w-4 h-4 ${busy ? 'animate-spin' : ''}`} />
        <span className="hidden md:inline">{busy ? 'Refreshing…' : 'Refresh'}</span>
      </button>

      {/* Display currency. Every amount on every page is rendered through the
          formatter this sets, so one choice here applies everywhere at once
          and nothing needs refetching — the billed figures are unchanged. */}
      <div className="relative shrink-0">
        <button
          onClick={() => setCurrencyOpen(o => !o)}
          title={display
            ? `Every amount converted to ${display}. Hover any figure for what was actually billed.`
            : 'Each amount shown in the currency Azure billed it in'}
          aria-expanded={currencyOpen}
          className={`flex h-10 items-center gap-1.5 rounded-xl border px-2.5 text-xs font-semibold transition ${
            display
              ? 'bg-blue-600/20 border-blue-500/40 text-blue-300'
              : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-white'
          }`}
        >
          <Coins className="h-3.5 w-3.5" />
          <span className="hidden lg:inline">{display || 'As billed'}</span>
          <ChevronDown className="h-3 w-3 shrink-0 opacity-70" />
        </button>
        {currencyOpen && (
          <div className="absolute right-0 top-full z-50 mt-1 w-[min(17rem,calc(100vw-1.5rem))] rounded-2xl border border-slate-700 bg-slate-800 py-1 shadow-2xl">
            {CURRENCIES.map(c => (
              <button
                key={c.code || 'billed'}
                onClick={() => { setDisplayCurrency(c.code); setCurrencyOpen(false); }}
                className={`w-full px-4 py-2.5 text-left text-sm transition hover:bg-slate-700 ${
                  (c.code || null) === display ? 'text-blue-400' : 'text-slate-300'
                }`}
              >
                <p className="font-medium">{c.label}</p>
                {c.hint && <p className="text-xs text-slate-500">{c.hint}</p>}
              </button>
            ))}
            {/* A converted figure is an indication of scale, not a restatement
                of the invoice, and the page has to say so rather than let a
                reader carry a converted total into an accounts conversation. */}
            <p className="border-t border-slate-700 px-4 py-2.5 text-[11px] leading-relaxed text-slate-500">
              {display
                ? <>Converted at today&apos;s reference rate{rateMeta.as_of && ` (${rateMeta.as_of})`}
                  {rateMeta.stale && ', which could not be refreshed today'}. Invoices are
                  still issued in the billed currency — hover any amount to see it.</>
                : <>Amounts stay in the currency each subscription was billed in. Totals
                  that span two currencies cannot be added together.</>}
            </p>
          </div>
        )}
      </div>

      {/* Theme toggle */}
      <button
        onClick={toggleTheme}
        title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
         className="relative flex w-10 h-10 shrink-0 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 items-center justify-center transition-colors overflow-hidden"
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

      {/* User avatar. `ml-auto` only matters on the wrapped tablet layout,
          where it pushes the account to the right edge of its row instead of
          leaving it stranded at the left; on the single-line bar the spacer
          has already done the pushing and this resolves to zero. */}
      <div className="ml-auto flex shrink-0 items-center gap-2 sm:ml-auto lg:ml-1">
        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center text-xs font-bold text-[#fff] shrink-0">
          {initials}
        </div>
        <span className="text-sm text-slate-400 hidden md:block truncate max-w-[140px]">
          {user?.name || user?.username || 'User'}
        </span>
        <button
          onClick={() => { evictAll(); instance.clearCache(); instance.logoutPopup(); }}
          title="Sign out"
          className="text-slate-500 hover:text-red-400 transition"
        >
          <LogOut className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
}


