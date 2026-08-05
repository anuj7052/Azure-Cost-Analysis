import { TrendingUp, TrendingDown, Minus, DollarSign } from 'lucide-react';
import { formatAmount } from '../../utils/currency';

export default function KpiCard({ title, value, subtitle, explanation, momChange, isCurrency = true, currency = 'INR', icon: Icon = DollarSign, loading = false, accentColor = 'blue' }) {
  const formatted = isCurrency ? formatAmount(value, currency) : (value ?? '—');

  const trendColor =
    momChange == null ? 'text-slate-400' :
    momChange > 0 ? 'text-red-400' :
    momChange < 0 ? 'text-emerald-400' : 'text-slate-400';

  const TrendIcon =
    momChange == null ? Minus :
    momChange > 0 ? TrendingUp :
    TrendingDown;

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 flex flex-col gap-3 hover:border-slate-700 transition-colors">
      <div className="flex items-center justify-between">
        <p className="text-slate-400 text-sm font-medium">{title}</p>
        <div className="w-9 h-9 rounded-lg bg-slate-800 flex items-center justify-center">
          <Icon className="w-4 h-4 text-blue-400" />
        </div>
      </div>

      {loading ? (
        <div className="h-8 bg-slate-800 rounded-lg animate-pulse" />
      ) : (
        <p className="text-3xl font-bold text-white tracking-tight">{formatted}</p>
      )}

      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          {momChange != null && (
            <span className={`flex items-center gap-1 text-sm font-semibold ${trendColor}`}>
              <TrendIcon className="w-3.5 h-3.5" />
              {Math.abs(momChange).toFixed(1)}%
            </span>
          )}
          {subtitle && (
            <span className="text-xs text-slate-500">{subtitle}</span>
          )}
        </div>
        {explanation && (
          <p className="text-xs text-slate-600 leading-relaxed">{explanation}</p>
        )}
      </div>
    </div>
  );
}
