import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine
} from 'recharts';
import { formatAmount } from '../../utils/currency';
import { monthFromPoint } from '../../utils/monthDrill';
import { clickedPoint } from '../../utils/dailyTimeline';
import { useChartTheme } from '../../store/useTheme';

function formatMonth(m) {
  if (!m) return '';
  const [year, month] = m.split('-');
  return new Date(year, month - 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
}

export default function CostTrendChart({
  months = [], loading = false, currency = 'INR', forecast = [], onSelectMonth,
  selectedMonth = '',
}) {
  const t = useChartTheme();
  const COLORS = t.series;

  if (loading) return <ChartSkeleton />;
  if (!months.length) return <EmptyState msg="No cost data available" />;

  const fmt = (v) => formatAmount(v, currency);

  // Forecast months appended to chart data
  const forecastData = forecast.map(m => ({
    month: formatMonth(m.month),
    projected: Number.isFinite(m.total_cost) ? m.total_cost : null,
    _isForecast: true,
  }));
  const forecastStartLabel = forecastData[0]?.month;

  const actualData = months.map(m => {
    const point = {
      month: formatMonth(m.month),
      total: Number.isFinite(m.total_cost) ? m.total_cost : null,
      // The raw key travels with the point because the label is formatted for
      // reading -- "Sep 26" cannot be looked up again, and two years sharing a
      // month would collide.
      _key: m.month,
    };
    return point;
  });

  const data = [...actualData, ...forecastData];
  // Plot the same total as the headline, not overlapping subscription areas
  // (which made the axis appear to show only the largest subscription).
  const keys = ['total'];
  if (forecastData.length && actualData.length) actualData.at(-1).projected = actualData.at(-1).total;

  const selectedLabel = selectedMonth
    ? (actualData.find(p => p._key === selectedMonth)?.month || '')
    : '';

  const handleClick = (state) => {
    if (!onSelectMonth) return;
    const key = monthFromPoint(clickedPoint(state, data));
    // A click that lands on a forecast month, or between points, is ignored
    // rather than clearing the selection: the reader aimed at something.
    if (key) onSelectMonth(key);
  };

  return (
    <ResponsiveContainer width="100%" height={280}>
      <AreaChart
        data={data}
        margin={{ top: 5, right: 20, left: 10, bottom: 0 }}
        onClick={onSelectMonth ? handleClick : undefined}
        style={onSelectMonth ? { cursor: 'pointer' } : undefined}
      >
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
        {selectedLabel && (
          <ReferenceLine x={selectedLabel} stroke={COLORS[0]} strokeWidth={2} />
        )}
        {forecastStartLabel && (
          <ReferenceLine x={forecastStartLabel} stroke={t.reference} strokeDasharray="4 4"
            label={{ value: 'Forecast ▶', fill: t.label, fontSize: 11, position: 'insideTopRight' }} />
        )}
        {keys.map((key, i) => (
          <Area
            key={key}
            type="monotone"
            dataKey={key}
            name="Actual cost"
            stroke={COLORS[i % COLORS.length]}
            fill={`url(#grad-${i})`}
            strokeWidth={2}
            dot={actualData.length === 1 ? { r: 4 } : false}
            activeDot={{ r: 4 }}
          />
        ))}
        {forecastData.length > 0 && <Area dataKey="projected" name="Forecast" type="monotone" stroke={COLORS[0]} strokeDasharray="5 5" fill="none" connectNulls={false} dot={false} />}
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
