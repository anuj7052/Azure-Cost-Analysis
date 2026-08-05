import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine
} from 'recharts';
import { formatAmount } from '../../utils/currency';
import { useChartTheme } from '../../store/useTheme';

function formatMonth(m) {
  if (!m) return '';
  const [year, month] = m.split('-');
  return new Date(year, month - 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
}

export default function CostTrendChart({ months = [], loading = false, currency = 'INR', forecast = [] }) {
  const t = useChartTheme();
  const COLORS = t.series;

  if (loading) return <ChartSkeleton />;
  if (!months.length) return <EmptyState msg="No cost data available" />;

  const fmt = (v) => formatAmount(v, currency);

  // Forecast months appended to chart data
  const forecastData = forecast.map(m => ({
    month: formatMonth(m.month),
    total: parseFloat(m.total_cost.toFixed(2)),
    _isForecast: true,
  }));
  const forecastStartLabel = forecastData[0]?.month;

  // Get all unique subscriptions
  const allSubs = [...new Set(months.flatMap(m => Object.keys(m.by_subscription || {})))];

  const actualData = months.map(m => {
    const point = { month: formatMonth(m.month), total: parseFloat(m.total_cost.toFixed(2)) };
    allSubs.forEach(sub => {
      point[sub.slice(-8)] = parseFloat((m.by_subscription?.[sub] || 0).toFixed(2));
    });
    return point;
  });

  const data = [...actualData, ...forecastData];
  const keys = allSubs.length > 1 ? allSubs.map(s => s.slice(-8)) : ['total'];
  if (allSubs.length <= 1) keys[0] = 'total';

  return (
    <ResponsiveContainer width="100%" height={280}>
      <AreaChart data={data} margin={{ top: 5, right: 20, left: 10, bottom: 0 }}>
        <defs>
          {keys.map((key, i) => (
            <linearGradient key={key} id={`grad-${i}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={COLORS[i % COLORS.length]} stopOpacity={t.isLight ? 0.22 : 0.32} />
              <stop offset="95%" stopColor={COLORS[i % COLORS.length]} stopOpacity={0} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke={t.grid} vertical={false} />
        <XAxis dataKey="month" tick={{ fill: t.axis, fontSize: 12 }} axisLine={false} tickLine={false} dy={6} />
        <YAxis
          tick={{ fill: t.axis, fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          width={64}
          tickFormatter={v => formatAmount(v, currency, true)}
        />
        <Tooltip
          cursor={t.tooltipCursor}
          contentStyle={t.tooltip}
          labelStyle={t.tooltipLabel}
          formatter={(val, _name, props) => [
            props.payload?._isForecast ? `${fmt(val)} (forecast)` : fmt(val),
            undefined,
          ]}
        />
        {keys.length > 1 && <Legend iconType="circle" iconSize={8} wrapperStyle={{ color: t.axis, fontSize: 12 }} />}
        {forecastStartLabel && (
          <ReferenceLine x={forecastStartLabel} stroke={t.reference} strokeDasharray="4 4"
            label={{ value: 'Forecast ▶', fill: t.label, fontSize: 11, position: 'insideTopRight' }} />
        )}
        {keys.map((key, i) => (
          <Area
            key={key}
            type="monotone"
            dataKey={key}
            stroke={COLORS[i % COLORS.length]}
            fill={`url(#grad-${i})`}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4 }}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}

function ChartSkeleton() {
  return <div className="h-[280px] bg-slate-800/40 rounded-xl animate-pulse" />;
}

function EmptyState({ msg }) {
  return (
    <div className="h-[280px] flex items-center justify-center text-slate-500 text-sm">
      {msg}
    </div>
  );
}
