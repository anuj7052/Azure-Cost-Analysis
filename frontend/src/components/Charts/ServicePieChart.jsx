import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { useChartTheme } from '../../store/useTheme';

const RADIAN = Math.PI / 180;
function renderCustomLabel({ cx, cy, midAngle, innerRadius, outerRadius, percent }) {
  if (percent < 0.04) return null;
  const radius = innerRadius + (outerRadius - innerRadius) * 0.5;
  const x = cx + radius * Math.cos(-midAngle * RADIAN);
  const y = cy + radius * Math.sin(-midAngle * RADIAN);
  return (
    <text x={x} y={y} fill="#fff" textAnchor="middle" dominantBaseline="central" fontSize={11} fontWeight={600}>
      {`${(percent * 100).toFixed(0)}%`}
    </text>
  );
}

export default function ServicePieChart({ topServices = [], loading = false }) {
  const t = useChartTheme();
  const COLORS = t.series;

  if (loading) return <div className="h-[280px] bg-slate-800/40 rounded-xl animate-pulse" />;
  if (!topServices.length) return <div className="h-[280px] flex items-center justify-center text-slate-500 text-sm">No data</div>;

  const data = topServices.slice(0, 10).map(s => ({
    name: s.service,
    value: parseFloat(s.total_cost.toFixed(2)),
  }));

  return (
    <ResponsiveContainer width="100%" height={280}>
      <PieChart>
        <Pie
          data={data}
          cx="50%"
          cy="50%"
          innerRadius="40%"
          outerRadius="70%"
          paddingAngle={2}
          dataKey="value"
          labelLine={false}
          label={renderCustomLabel}
        >
          {data.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} stroke={t.isLight ? '#fff' : '#0f172a'} strokeWidth={2} />)}
        </Pie>
        <Tooltip
          contentStyle={t.tooltip}
          labelStyle={t.tooltipLabel}
          formatter={(val) => [`$${val.toLocaleString()}`, undefined]}
        />
        <Legend
          iconType="circle"
          iconSize={8}
          wrapperStyle={{ color: t.axis, fontSize: 11 }}
          formatter={(val) => val.length > 22 ? val.slice(0, 22) + '…' : val}
        />
      </PieChart>
    </ResponsiveContainer>
  );
}
