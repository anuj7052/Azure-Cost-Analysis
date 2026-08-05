import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer
} from 'recharts';
import { useChartTheme } from '../../store/useTheme';

export default function TenantComparisonChart({ perTenantData = [], loading = false }) {
  const t = useChartTheme();
  const COLORS = t.series;

  if (loading) return <div className="h-[260px] bg-slate-800/40 rounded-xl animate-pulse" />;
  if (!perTenantData.length) return <div className="h-[260px] flex items-center justify-center text-slate-500 text-sm">Add multiple tenants to compare</div>;

  // perTenantData: [{ tenant_name, months: [{ month, total_cost }] }]
  // Build chart data: [{ month: 'Jan 26', 'Tenant A': 1234, 'Tenant B': 2345 }]
  const allMonths = [...new Set(
    perTenantData.flatMap(t => t.months.map(m => m.month))
  )].sort();

  const data = allMonths.map(month => {
    const point = { month };
    perTenantData.forEach(t => {
      const found = t.months.find(m => m.month === month);
      point[t.tenant_name] = found ? parseFloat(found.total_cost.toFixed(2)) : 0;
    });
    return point;
  });

  const tenantNames = perTenantData.map(t => t.tenant_name);

  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={data} margin={{ top: 5, right: 20, left: 10, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={t.grid} vertical={false} />
        <XAxis dataKey="month" tick={{ fill: t.axis, fontSize: 12 }} axisLine={false} tickLine={false} dy={6} />
        <YAxis
          tick={{ fill: t.axis, fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          width={64}
          tickFormatter={v => `$${v >= 1000 ? (v/1000).toFixed(1)+'K' : v}`}
        />
        <Tooltip
          cursor={t.tooltipCursor}
          contentStyle={t.tooltip}
          labelStyle={t.tooltipLabel}
          formatter={(val) => [`$${val.toLocaleString()}`, undefined]}
        />
        <Legend iconType="circle" iconSize={8} wrapperStyle={{ color: t.axis, fontSize: 12 }} />
        {tenantNames.map((name, i) => (
          <Bar key={name} dataKey={name} fill={COLORS[i % COLORS.length]} radius={[6, 6, 0, 0]} maxBarSize={44} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}
