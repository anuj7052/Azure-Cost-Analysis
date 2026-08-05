import { useEffect, useState, useMemo } from 'react';
import { useAppStore } from '../store/useAppStore';
import CostTrendChart from '../components/Charts/CostTrendChart';
import ServiceBreakdownChart from '../components/Charts/ServiceBreakdownChart';
import { formatAmount } from '../utils/currency';

export default function CostTrends() {
  const { costData, costLoading, loadCosts, selectedTenantId, selectedSubscriptionIds, subscriptions, toggleSubscription, setAllSubscriptions, months, dateKey } = useAppStore();

  useEffect(() => {
    if (selectedTenantId && selectedSubscriptionIds.length > 0) loadCosts();
  }, [selectedTenantId, selectedSubscriptionIds.join(','), dateKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const monthlyData = costData?.months || [];
  const currency    = costData?.months?.[0]?.currency || 'INR';
  const fmt         = (v) => formatAmount(v, currency);

  // Simple linear regression forecast for next 2 months
  const forecast = useMemo(() => {
    if (monthlyData.length < 3) return [];
    const n   = monthlyData.length;
    const xs  = monthlyData.map((_, i) => i);
    const ys  = monthlyData.map(m => m.total_cost);
    const sx  = xs.reduce((a, b) => a + b, 0);
    const sy  = ys.reduce((a, b) => a + b, 0);
    const sxy = xs.reduce((a, x, i) => a + x * ys[i], 0);
    const sx2 = xs.reduce((a, x) => a + x * x, 0);
    const slope = (n * sxy - sx * sy) / (n * sx2 - sx * sx);
    const intercept = (sy - slope * sx) / n;
    const lastMonth = monthlyData[n - 1].month;
    const [ly, lm] = lastMonth.split('-').map(Number);
    return [1, 2].map(offset => {
      const d = new Date(ly, lm - 1 + offset, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      return { month: key, total_cost: Math.max(0, slope * (n - 1 + offset) + intercept) };
    });
  }, [monthlyData]);

  return (
    <div className="p-6 space-y-6 max-w-screen-2xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold text-white">Cost Trends</h1>
        <p className="text-slate-400 text-sm mt-1">Month-over-month spend analysis across all subscriptions</p>
      </div>

      {/* Subscription filter */}
      {subscriptions.length > 0 && (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
          <div className="flex items-center gap-4 flex-wrap">
            <span className="text-xs text-slate-400 font-medium">Filter subscriptions:</span>
            <button onClick={() => setAllSubscriptions(subscriptions.map(s => s.subscription_id))} className="text-xs text-blue-400 hover:text-blue-300">All</button>
            <button onClick={() => setAllSubscriptions([])} className="text-xs text-slate-500 hover:text-slate-300">None</button>
            {subscriptions.map(sub => (
              <button
                key={sub.subscription_id}
                onClick={() => { toggleSubscription(sub.subscription_id); loadCosts(); }}
                className={`text-xs px-3 py-1.5 rounded-full border transition ${
                  selectedSubscriptionIds.includes(sub.subscription_id)
                    ? 'bg-blue-600/20 border-blue-500/40 text-blue-300'
                    : 'border-slate-700 text-slate-500 hover:border-slate-600'
                }`}
              >
                {sub.display_name}
              </button>
            ))}
          </div>
        </div>
      )}

      {forecast.length > 0 && (
        <div className="bg-blue-950/30 border border-blue-500/20 rounded-xl p-4 flex flex-wrap gap-6 items-center">
          <div>
            <p className="text-xs text-blue-400 font-semibold uppercase tracking-wide">Forecast ® — Next 2 Months</p>
            <p className="text-xs text-slate-400 mt-1">Linear projection based on last {months} months of spend</p>
          </div>
          {forecast.map((m, i) => (
            <div key={i} className="text-center">
              <p className="text-xs text-slate-400">{m.month}</p>
              <p className="text-lg font-bold text-blue-300">{fmt(m.total_cost)}</p>
            </div>
          ))}
        </div>
      )}

      {/* Trend chart */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
        <h2 className="text-sm font-semibold text-slate-300 mb-1">Monthly Cost Trend ({months} months)</h2>
        <p className="text-xs text-slate-500 mb-4">Dashed line shows linear forecast for the next 2 months</p>
        <CostTrendChart months={monthlyData} loading={costLoading} currency={currency} forecast={forecast} />
      </div>

      {/* Service breakdown stacked */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
        <h2 className="text-sm font-semibold text-slate-300 mb-4">Cost by Service (Stacked)</h2>
        <ServiceBreakdownChart months={monthlyData} loading={costLoading} />
      </div>

      {/* Monthly summary table */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
        <h2 className="text-sm font-semibold text-slate-300 mb-4">Month-over-Month Summary</h2>
        {costLoading ? (
          <div className="space-y-2">{[...Array(6)].map((_, i) => <div key={i} className="h-10 bg-slate-800 rounded-lg animate-pulse" />)}</div>
        ) : !monthlyData.length ? (
          <p className="text-slate-500 text-sm text-center py-6">No data available</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-slate-500 border-b border-slate-800">
                  <th className="pb-2 font-medium">Month</th>
                      <th className="pb-2 font-medium text-right">Total Cost ({currency})</th>
                  <th className="pb-2 font-medium text-right">MoM Change</th>
                  <th className="pb-2 font-medium text-right">MoM Amount</th>
                  <th className="pb-2 font-medium text-right">Top Service</th>
                </tr>
              </thead>
              <tbody>
                {monthlyData.map((m, i) => {
                  const prev = monthlyData[i - 1];
                  const mom = prev ? ((m.total_cost - prev.total_cost) / prev.total_cost * 100) : null;
                  const diff = prev ? m.total_cost - prev.total_cost : null;
                  const topSvc = Object.entries(m.by_service || {}).sort((a, b) => b[1] - a[1])[0];
                  return (
                    <tr key={m.month} className="border-b border-slate-800/50 hover:bg-slate-800/30">
                      <td className="py-3 text-slate-200 font-medium">{m.month}</td>
                      <td className="py-3 text-right text-white font-semibold">{fmt(m.total_cost)}</td>
                      <td className="py-3 text-right">
                        {mom == null ? <span className="text-slate-500">—</span> : (
                          <span className={mom > 0 ? 'text-red-400' : 'text-emerald-400'}>
                            {mom > 0 ? '▲' : '▼'} {Math.abs(mom).toFixed(1)}%
                          </span>
                        )}
                      </td>
                      <td className="py-3 text-right">
                        {diff == null ? <span className="text-slate-500">—</span> : (
                          <span className={diff > 0 ? 'text-red-400' : 'text-emerald-400'}>
                            {diff > 0 ? '+' : ''}{fmt(diff)}
                          </span>
                        )}
                      </td>
                      <td className="py-3 text-right text-slate-400 text-xs">
                        {topSvc ? `${topSvc[0]} (${fmt(topSvc[1])})` : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
