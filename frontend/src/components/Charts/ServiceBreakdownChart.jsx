import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, Cell
} from 'recharts';
import { useChartTheme } from '../../store/useTheme';
import { formatAmount, currencySymbol } from '../../utils/currency';

function formatMonth(m) {
  if (!m) return '';
  const [year, month] = m.split('-');
  return new Date(year, month - 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
}

export default function ServiceBreakdownChart({ months = [], topN = 7, loading = false, currency = 'USD' }) {
  const t = useChartTheme();
  const COLORS = t.series;

  if (loading) return <div className="h-[300px] bg-slate-800/40 rounded-xl animate-pulse" />;
  if (!months.length) return <div className="h-[300px] flex items-center justify-center text-slate-500 text-sm">No data</div>;

  // Gather top N services by total cost
  const serviceTotals = {};
  months.forEach(m => {
    Object.entries(m.by_service || {}).forEach(([svc, cost]) => {
      serviceTotals[svc] = (serviceTotals[svc] || 0) + cost;
    });
  });
  const topServices = Object.entries(serviceTotals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([name]) => name);

  const data = months.map(m => {
    const point = { month: formatMonth(m.month) };
    topServices.forEach(svc => {
      point[svc] = parseFloat(((m.by_service || {})[svc] || 0).toFixed(2));
    });
    return point;
  });

  return (
    <ResponsiveContainer width="100%" height={300}>
      <BarChart data={data} margin={{ top: 5, right: 20, left: 10, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={t.grid} vertical={false} />
        <XAxis dataKey="month" tick={{ fill: t.axis, fontSize: 12 }} axisLine={false} tickLine={false} dy={6} />
        <YAxis
          tick={{ fill: t.axis, fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          width={64}
          tickFormatter={v => `${currencySymbol(currency)}${v >= 1000 ? (v / 1000).toFixed(1) + 'K' : v}`}
        />
        <Tooltip
          cursor={t.tooltipCursor}
          contentStyle={t.tooltip}
          labelStyle={t.tooltipLabel}
          formatter={(val) => [formatAmount(val, currency), undefined]}
        />
        <Legend iconType="circle" iconSize={8} wrapperStyle={{ color: t.axis, fontSize: 11 }} />
        {topServices.map((svc, i) => (
          <Bar key={svc} dataKey={svc} stackId="a" fill={COLORS[i % COLORS.length]} radius={i === topServices.length - 1 ? [3, 3, 0, 0] : [0, 0, 0, 0]} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}
