import { AlertTriangle, TrendingUp, CreditCard } from 'lucide-react';
import { formatAmount } from '../../utils/currency';

export default function AnomalyCard({ anomaly, subMap = {}, currency = 'INR' }) {
  const { service, month, pct_change, current_cost, prev_cost, reason, subscription_ids } = anomaly;
  const fmt = (v) => formatAmount(v, currency);

  const severity = pct_change > 100 ? 'high' : pct_change > 50 ? 'medium' : 'low';
  const severityLabel = severity === 'high' ? '🔴 High' : severity === 'medium' ? '🟡 Medium' : '🟢 Low';
  const colors = {
    high: 'border-red-500/40 bg-red-950/30',
    medium: 'border-orange-500/40 bg-orange-950/30',
    low: 'border-yellow-500/40 bg-yellow-950/30',
  };
  const badgeColors = {
    high: 'bg-red-500/20 text-red-400',
    medium: 'bg-orange-500/20 text-orange-400',
    low: 'bg-yellow-500/20 text-yellow-400',
  };

  // Map subscription IDs to display names
  const subNames = (subscription_ids || []).map(id => subMap[id] || id);

  return (
    <div className={`border rounded-xl p-4 ${colors[severity]}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <AlertTriangle className={`w-4 h-4 mt-0.5 shrink-0 ${
            severity === 'high' ? 'text-red-400' : severity === 'medium' ? 'text-orange-400' : 'text-yellow-400'
          }`} />
          <div>
            <p className="text-sm font-semibold text-white">{service}</p>
            <p className="text-xs text-slate-400 mt-0.5">{month} · {severityLabel}</p>
          </div>
        </div>
        <span className={`text-xs font-bold px-2 py-1 rounded-full flex items-center gap-1 shrink-0 ${badgeColors[severity]}`}>
          <TrendingUp className="w-3 h-3" />
          +{pct_change.toFixed(1)}%
        </span>
      </div>

      {/* Subscription name badge */}
      {subNames.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {subNames.map((name, i) => (
            <span key={i} className="flex items-center gap-1 text-xs bg-slate-700/60 text-slate-300 px-2 py-0.5 rounded-full">
              <CreditCard className="w-2.5 h-2.5 text-blue-400" />
              {name}
            </span>
          ))}
        </div>
      )}

      {/* Cost comparison */}
      <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
        <div className="bg-slate-800/50 rounded-lg p-2 text-center">
          <p className="text-slate-500">Previous</p>
          <p className="text-white font-semibold mt-0.5">{fmt(prev_cost)}</p>
        </div>
        <div className="bg-slate-800/50 rounded-lg p-2 text-center">
          <p className="text-slate-500">Current</p>
          <p className="text-white font-semibold mt-0.5">{fmt(current_cost)}</p>
        </div>
        <div className={`rounded-lg p-2 text-center ${severity === 'high' ? 'bg-red-900/30' : 'bg-orange-900/30'}`}>
          <p className="text-slate-500">Increase</p>
          <p className="text-red-400 font-semibold mt-0.5">+{fmt(current_cost - prev_cost)}</p>
        </div>
      </div>

      {reason && (
        <p className="mt-2 text-xs text-slate-400 leading-relaxed border-t border-slate-700 pt-2">
          💡 {reason}
        </p>
      )}
    </div>
  );
}
