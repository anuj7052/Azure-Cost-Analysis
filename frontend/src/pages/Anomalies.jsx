import { useEffect, useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import AnomalyCard from '../components/Cards/AnomalyCard';
import { TrendingDown, AlertTriangle, CalendarRange } from 'lucide-react';
import { formatAmount } from '../utils/currency';

export default function Anomalies() {
  const {
    costData, costLoading, costError, subscriptions,
    loadCosts, selectedTenantId, selectedSubscriptionIds, dateKey,
  } = useAppStore();
  const [filter, setFilter] = useState('all');
  const [tab, setTab] = useState('spikes');

  // This page used to rely on the Dashboard having already fetched the costs,
  // so opening it directly (or reloading on it) showed a permanently empty
  // page. It now asks for its own data like every other page.
  useEffect(() => {
    if (selectedTenantId && selectedSubscriptionIds.length > 0) loadCosts();
  }, [selectedTenantId, selectedSubscriptionIds.join(','), dateKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const anomalies = costData?.anomalies || [];
  const savings = costData?.savings || [];
  const monthCount = costData?.months?.length || 0;
  // A spike is a month-over-month comparison, so a single-month window can
  // never produce one. Saying so beats showing a convincing empty state.
  const needsWiderRange = !costLoading && !costError && monthCount < 2;

  // subscription id → name lookup
  const subMap = Object.fromEntries((subscriptions || []).map(s => [s.subscription_id, s.display_name]));
  const currency = costData?.months?.[0]?.currency || 'INR';
  const fmt = (v) => formatAmount(v, currency);

  const filteredAnomalies = anomalies.filter(a => {
    if (filter === 'all') return true;
    if (filter === 'high') return a.pct_change > 100;
    if (filter === 'medium') return a.pct_change > 50 && a.pct_change <= 100;
    if (filter === 'low') return a.pct_change <= 50;
    return true;
  });

  const totalSavingsAmt = savings.reduce((a, s) => a + s.saved_amount, 0);

  return (
    <div className="p-6 space-y-6 max-w-screen-2xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold text-white">Anomalies & Savings</h1>
        <p className="text-slate-400 text-sm mt-1">
          Services with sudden cost changes — shown across all subscriptions
        </p>
      </div>

      {costError && (
        <div className="flex items-start gap-3 bg-red-950/30 border border-red-500/30 rounded-xl p-4">
          <AlertTriangle className="w-4 h-4 text-red-400 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-medium text-red-300">Could not load cost data</p>
            <p className="text-xs text-slate-400 mt-1">{costError}</p>
          </div>
        </div>
      )}

      {needsWiderRange && (
        <div className="flex items-start gap-3 bg-amber-950/30 border border-amber-500/30 rounded-xl p-4">
          <CalendarRange className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-medium text-amber-300">
              {monthCount === 0 ? 'No cost data for this selection' : 'Only one month selected'}
            </p>
            <p className="text-xs text-slate-400 mt-1">
              {monthCount === 0
                ? 'Pick a tenant and at least one subscription, then widen the date range.'
                : 'Spikes and savings compare one month against the previous one, so pick a range covering at least two months.'}
            </p>
          </div>
        </div>
      )}

      {/* Legend box — explain what anomaly means */}
      <div className="bg-blue-950/30 border border-blue-500/20 rounded-xl p-4 text-sm text-slate-300 space-y-1">
        <p className="font-semibold text-blue-300">📌 What is a Cost Spike?</p>
        <p className="text-xs text-slate-400">A <strong>Cost Spike</strong> is when an Azure service's spend increases more than 20% compared to the previous month.</p>
        <div className="flex flex-wrap gap-3 mt-2 text-xs">
          <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-red-500 inline-block" /> 🔴 High — 100%+ increase (needs immediate attention)</span>
          <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-orange-500 inline-block" /> 🟡 Medium — 50–100% increase</span>
          <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-yellow-500 inline-block" /> 🟢 Low — 20–50% increase</span>
        </div>
      </div>

      {/* Summary stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-red-950/30 border border-red-500/30 rounded-2xl p-4">
          <p className="text-red-400 text-xs font-medium uppercase tracking-wide">Total Cost Spikes</p>
          <p className="text-3xl font-bold text-white mt-1">{anomalies.length}</p>
          <p className="text-slate-500 text-xs mt-1">services with 20%+ cost increase</p>
        </div>
        <div className="bg-orange-950/30 border border-orange-500/30 rounded-2xl p-4">
          <p className="text-orange-400 text-xs font-medium uppercase tracking-wide">Largest Spike</p>
          <p className="text-3xl font-bold text-white mt-1">
            {anomalies[0] ? `+${anomalies[0].pct_change.toFixed(0)}%` : '—'}
          </p>
          <p className="text-slate-500 text-xs mt-1">{anomalies[0]?.service || 'No anomalies'}</p>
        </div>
        <div className="bg-emerald-950/30 border border-emerald-500/30 rounded-2xl p-4">
          <p className="text-emerald-400 text-xs font-medium uppercase tracking-wide">Total Savings</p>
          <p className="text-3xl font-bold text-white mt-1">{fmt(totalSavingsAmt)}</p>
          <p className="text-slate-500 text-xs mt-1">{savings.length} services with reduced cost</p>
        </div>
      </div>

      {/* Tab switcher */}
      <div className="flex gap-1 bg-slate-900 border border-slate-800 rounded-xl p-1 w-fit">
        <button
          onClick={() => setTab('spikes')}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition ${tab === 'spikes' ? 'bg-red-600/30 text-red-300' : 'text-slate-400 hover:text-white'}`}
        >
          🔺 Cost Spikes ({anomalies.length})
        </button>
        <button
          onClick={() => setTab('savings')}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition ${tab === 'savings' ? 'bg-emerald-600/30 text-emerald-300' : 'text-slate-400 hover:text-white'}`}
        >
          💰 Savings ({savings.length})
        </button>
      </div>

      {tab === 'spikes' && (
        <>
          {/* Severity filter */}
          <div className="flex flex-wrap gap-2">
            {[
              { key: 'all', label: 'All' },
              { key: 'high', label: '🔴 High (100%+)' },
              { key: 'medium', label: '🟡 Medium (50–100%)' },
              { key: 'low', label: '🟢 Low (20–50%)' },
            ].map(f => (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                className={`px-3 py-1.5 rounded-full text-xs font-medium border transition ${
                  filter === f.key ? 'border-blue-500 bg-blue-600/20 text-blue-300' : 'border-slate-700 text-slate-400 hover:border-slate-600'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>

          {costLoading ? (
            <div className="space-y-3">{[...Array(4)].map((_, i) => <div key={i} className="h-36 bg-slate-800 rounded-xl animate-pulse" />)}</div>
          ) : filteredAnomalies.length === 0 ? (
            <div className="text-center py-12 text-slate-500">
              <p className="text-lg">✅ No anomalies found</p>
              <p className="text-sm mt-1">All service costs are within normal range for this period</p>
            </div>
          ) : (
            <div className="space-y-3">
              {filteredAnomalies.map((a, i) => <AnomalyCard key={i} anomaly={a} subMap={subMap} currency={currency} />)}
            </div>
          )}
        </>
      )}

      {tab === 'savings' && (
        <div className="space-y-3">
          {savings.length === 0 ? (
            <div className="text-center py-12 text-slate-500">
              <p className="text-lg">No savings detected</p>
            </div>
          ) : (
            savings.map((s, i) => (
              <div key={i} className="bg-emerald-950/30 border border-emerald-500/30 rounded-xl p-4 flex items-center gap-4">
                <TrendingDown className="w-5 h-5 text-emerald-400 shrink-0" />
                <div className="flex-1">
                  <p className="text-sm font-semibold text-white">{s.service}</p>
                  <p className="text-xs text-slate-400 mt-0.5">{s.month}</p>
                </div>
                <div className="text-right">
                  <p className="text-emerald-400 font-bold">{s.pct_change.toFixed(1)}%</p>
                  <p className="text-xs text-slate-300 font-medium mt-0.5">{fmt(s.saved_amount)} saved</p>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
