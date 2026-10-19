import { useMemo, useState } from 'react';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart,
  ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { BarChart3, Layers, LineChart as LineIcon, PieChart as PieIcon, Building2 } from 'lucide-react';
import { formatAmount, formatAmountFull } from '../../utils/currency';
import { OTHER_COLOR, SERIES_COLORS, TOP_SERVICES, weekday } from '../../utils/costDashboardSeries';

/*
 * Dashboard graphs. Every series is read from data the page already loaded:
 * daily rows (with a per-service split) for a single month, monthly rows for a
 * longer range, the pricing-model split for Reserved vs Pay-as-you-go, and the
 * per-subscription totals. Nothing is estimated or interpolated.
 */

const axis = { fill: 'var(--color-slate-400)', fontSize: 12 };
const grid = <CartesianGrid strokeDasharray="3 3" stroke="var(--color-slate-800)" vertical={false} />;

function Card({ title, description, icon: Icon, actions, children, className = '' }) {
  return (
    <section className={`rounded-2xl border border-slate-800 bg-slate-900 p-5 sm:p-6 ${className}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-base font-semibold text-slate-100">
            {Icon && <Icon className="h-4 w-4 text-[#ea580c]" aria-hidden="true" />}
            {title}
          </h2>
          {description && <p className="mt-1 text-sm text-slate-400">{description}</p>}
        </div>
        {actions}
      </div>
      <div className="mt-5">{children}</div>
    </section>
  );
}

function Placeholder({ loading, message, height = 'h-72' }) {
  return loading
    ? <div className={`${height} animate-pulse rounded-xl bg-slate-800/60`} role="status" aria-label="Loading chart" />
    : <div className={`${height} flex items-center justify-center text-center text-sm text-slate-400`}>{message}</div>;
}

function Segmented({ value, onChange, options, label }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg border border-slate-700 bg-slate-950 p-0.5">
      {options.map(option => {
        const active = value === option.value;
        const Icon = option.icon;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={option.label}
            onClick={() => onChange(option.value)}
            className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ea580c] ${active ? 'bg-[#ffedd5] text-[#9a3412]' : 'text-slate-400 hover:text-slate-100'}`}
          >
            {Icon && <Icon className="h-3.5 w-3.5" aria-hidden="true" />}
            <span className="hidden sm:inline">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Hover card: date, total, change, and every series with its share. */
function DetailTooltip({ active, payload, currency, daily, keys, colors, notes, clickable }) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  const parts = (keys || [])
    .map(key => ({ key, value: Number(row[key]) || 0 }))
    .filter(part => part.value !== 0)
    .sort((a, b) => b.value - a.value);
  return (
    <div className="min-w-64 max-w-xs rounded-xl bg-[#0f172a] p-3.5 text-[#f8fafc] shadow-2xl ring-1 ring-black/10">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm font-semibold text-[#f8fafc]">{row.full}{daily && <span className="ml-1 text-xs font-normal text-[#94a3b8]">{weekday(row.key)}</span>}</p>
        {row.change != null && (
          <span className={`text-xs font-semibold ${row.change > 0 ? 'text-[#fca5a5]' : 'text-[#6ee7b7]'}`}>
            {row.change > 0 ? '▲' : '▼'} {Math.abs(row.change).toFixed(1)}%
          </span>
        )}
      </div>
      <p className="mt-1 text-lg font-bold tabular-nums text-[#f8fafc]">{formatAmountFull(row.total, currency)}</p>
      {row.change != null && <p className="text-[11px] text-[#94a3b8]">vs previous {daily ? 'day' : 'month'}</p>}
      {parts.length > 0 && (
        <ul className="mt-2 space-y-1 border-t border-white/10 pt-2">
          {parts.map(part => (
            <li key={part.key} className="flex items-center justify-between gap-3 text-xs">
              <span className="flex min-w-0 items-center gap-1.5 text-[#cbd5e1]">
                <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: colors?.[part.key] }} />
                <span className="truncate">{part.key}</span>
              </span>
              <span className="shrink-0 tabular-nums text-[#e2e8f0]">
                {formatAmount(part.value, currency)}
                <span className="ml-1 text-[#94a3b8]">{row.total ? `${((part.value / row.total) * 100).toFixed(0)}%` : ''}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 border-t border-white/10 pt-2 text-[11px] text-[#94a3b8]">Running total {formatAmount(row.cumulative, currency)}</p>
      {notes?.[row.key]?.length > 0 && (
        <ul className="mt-2 space-y-1 border-t border-white/10 pt-2">
          {notes[row.key].slice(0, 3).map(note => (
            <li key={note.id} className="flex gap-1.5 text-[11px] text-[#fde68a]">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-[#eab308]" />
              <span className="line-clamp-2">{note.body}</span>
            </li>
          ))}
          {notes[row.key].length > 3 && <li className="text-[11px] text-[#94a3b8]">+{notes[row.key].length - 3} more notes</li>}
        </ul>
      )}
      {clickable && <p className="mt-2 text-[11px] font-semibold text-[#fdba74]">Click for this day's details →</p>}
    </div>
  );
}

function Legend({ keys, colors, hidden, onToggle }) {
  return (
    <div className="mb-4 flex flex-wrap gap-2">
      {keys.map(key => {
        const off = hidden.has(key);
        return (
          <button
            key={key}
            type="button"
            aria-pressed={!off}
            onClick={() => onToggle(key)}
            title={off ? `Show ${key}` : `Hide ${key}`}
            className={`inline-flex max-w-[16rem] items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ea580c] ${off ? 'border-slate-800 text-slate-500 line-through' : 'border-slate-700 text-slate-300 hover:bg-slate-800'}`}
          >
            <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: off ? 'transparent' : colors[key], border: `1px solid ${colors[key]}` }} />
            <span className="truncate">{key}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Main chart: spend over time, switchable between stacked bars, stacked area and line. */
export function SpendOverTime({ series, daily, loading, error, currency, onRetry, onSelect, notes, groupLabel = 'service', description, showSummary = true }) {
  const [type, setType] = useState('stacked');
  const [hidden, setHidden] = useState(() => new Set());
  const toggle = key => setHidden(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const { rows, keys, colors } = series;
  const visible = keys.filter(key => !hidden.has(key));
  const average = rows.length ? rows.reduce((sum, row) => sum + row.total, 0) / rows.length : 0;
  const peak = rows.reduce((best, row) => (row.total > (best?.total ?? -Infinity) ? row : best), null);
  const total = rows.reduce((sum, row) => sum + row.total, 0);
  const clickable = Boolean(daily && onSelect);
  const pick = state => {
    if (!clickable) return;
    const index = Number(state?.activeIndex ?? state?.activeTooltipIndex);
    const row = Number.isInteger(index) ? rows[index] : rows.find(r => r.label === state?.activeLabel);
    if (row) onSelect(row.key);
  };
  const chartProps = { data: rows, margin: { top: 8, right: 8, left: 0, bottom: 0 }, onClick: pick, style: clickable ? { cursor: 'pointer' } : undefined };
  const noteDots = daily ? rows.filter(row => notes?.[row.key]?.length).map(row => <ReferenceDot key={`note-${row.key}`} x={row.label} y={row.total} r={5} fill="#eab308" stroke="var(--color-slate-900)" strokeWidth={2} ifOverflow="extendDomain" />) : null;
  const tooltip = <Tooltip content={<DetailTooltip currency={currency} daily={daily} keys={keys} colors={colors} notes={notes} clickable={clickable} />} cursor={{ fill: 'rgba(234,88,12,0.08)', stroke: '#EA580C', strokeWidth: 1 }} />;
  const yAxis = <YAxis tick={axis} tickLine={false} axisLine={false} width={76} tickFormatter={value => formatAmount(value, currency)} />;
  const xAxis = <XAxis dataKey="label" tick={axis} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={14} />;
  const avgLine = <ReferenceLine y={average} stroke="#EA580C" strokeOpacity={0.7} strokeDasharray="5 5" label={{ value: `${daily ? 'Daily' : 'Monthly'} avg ${formatAmount(average, currency)}`, position: 'insideTopRight', fill: '#c2410c', fontSize: 11, fontWeight: 600 }} />;

  return (
    <Card
      title={`${daily ? 'Daily' : 'Monthly'} spend by ${groupLabel.toLowerCase()}`}
      description={description || (daily ? 'Each day of the selected month, split by Azure service. Hover a day for details, click it to see every resource. Yellow dots mark days with notes.' : 'Each month in the selected period, split by Azure service. Hover a month for details.')}
      icon={Layers}
      actions={
        <Segmented
          label="Chart type"
          value={type}
          onChange={setType}
          options={[
            { value: 'stacked', label: 'Stacked bars', icon: BarChart3 },
            { value: 'area', label: 'Stacked area', icon: Layers },
            { value: 'line', label: 'Total line', icon: LineIcon },
          ]}
        />
      }
    >
      {showSummary && rows.length > 0 && (
        <dl className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            ['Total', formatAmount(total, currency)],
            [daily ? 'Daily average' : 'Monthly average', formatAmount(average, currency)],
            ['Highest', peak ? `${peak.label} · ${formatAmount(peak.total, currency)}` : '—'],
            [daily ? 'Days reported' : 'Months', rows.length],
          ].map(([label, value]) => (
            <div key={label} className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2.5">
              <dt className="text-[11px] uppercase tracking-wide text-slate-500">{label}</dt>
              <dd className="mt-0.5 truncate text-sm font-semibold tabular-nums text-slate-100">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {(loading && !rows.length) || (!rows.length) ? (
        error && !loading ? (
          <div className="flex h-80 flex-col items-center justify-center gap-3 text-center">
            <p className="text-sm text-slate-400">The spend could not be loaded. {error}</p>
            {onRetry && <button type="button" onClick={onRetry} className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800">Try again</button>}
          </div>
        ) : <Placeholder loading={loading} message="No spend recorded for this period." height="h-80" />
      ) : (
        <>
          {type !== 'line' && <Legend keys={keys} colors={colors} hidden={hidden} onToggle={toggle} />}
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              {type === 'line' ? (
                <LineChart {...chartProps}>
                  {grid}{xAxis}{yAxis}{tooltip}{avgLine}{noteDots}
                  <Line type="monotone" dataKey="total" stroke="#EA580C" strokeWidth={2.5} dot={!daily} activeDot={{ r: 5 }} />
                </LineChart>
              ) : type === 'area' ? (
                <AreaChart {...chartProps}>
                  {grid}{xAxis}{yAxis}{tooltip}{noteDots}
                  {visible.map(key => <Area key={key} type="monotone" dataKey={key} stackId="cost" stroke={colors[key]} strokeWidth={1.5} fill={colors[key]} fillOpacity={0.85} />)}
                </AreaChart>
              ) : (
                <BarChart {...chartProps}>
                  {grid}{xAxis}{yAxis}{tooltip}{avgLine}
                  {visible.map((key, index) => <Bar key={key} dataKey={key} stackId="cost" fill={colors[key]} maxBarSize={daily ? 28 : 56} radius={index === visible.length - 1 ? [5, 5, 0, 0] : 0} />)}
                  {noteDots}
                </BarChart>
              )}
            </ResponsiveContainer>
          </div>
        </>
      )}
    </Card>
  );
}

/**
 * Donut with a ranked list beside it. Shared by the service and subscription
 * breakdowns so both read the same way: hover a slice or a row to focus it.
 */
export function ShareBreakdown({ title, description, icon, items, loading, currency, emptyMessage, stacked = false }) {
  const [focus, setFocus] = useState(null);
  const data = useMemo(() => {
    const top = items.slice(0, TOP_SERVICES);
    const rest = items.slice(TOP_SERVICES).reduce((sum, item) => sum + item.cost, 0);
    const list = rest > 0 ? [...top, { key: '__other', name: 'Other', cost: rest }] : top;
    return list.map((item, index) => ({ ...item, color: item.key === '__other' ? OTHER_COLOR : SERIES_COLORS[index % SERIES_COLORS.length] }));
  }, [items]);
  const total = data.reduce((sum, item) => sum + item.cost, 0);
  const shown = focus ? data.find(item => item.key === focus) : null;

  return (
    <Card title={title} description={description} icon={icon}>
      {!data.length ? <Placeholder loading={loading} message={emptyMessage} /> : (
        <div className={`grid items-center gap-6 ${stacked ? '' : 'sm:grid-cols-[minmax(0,14rem)_1fr]'}`}>
          <div className="relative mx-auto h-56 w-56">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={data}
                  dataKey="cost"
                  nameKey="name"
                  innerRadius="62%"
                  outerRadius="95%"
                  paddingAngle={data.length > 1 ? 1.5 : 0}
                  stroke="var(--color-slate-900)"
                  strokeWidth={2}
                  onMouseEnter={(_, index) => setFocus(data[index]?.key)}
                  onMouseLeave={() => setFocus(null)}
                >
                  {data.map(item => <Cell key={item.key} fill={item.color} opacity={!focus || focus === item.key ? 1 : 0.35} />)}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-6 text-center">
              <p className="line-clamp-2 text-[11px] text-slate-400">{shown ? shown.name : 'Total'}</p>
              <p className="text-base font-bold tabular-nums text-slate-100">{formatAmount(shown ? shown.cost : total, currency)}</p>
              {shown && total > 0 && <p className="text-xs text-slate-400">{((shown.cost / total) * 100).toFixed(1)}%</p>}
            </div>
          </div>
          <ul className="space-y-1.5">
            {data.map(item => {
              const pct = total > 0 ? (item.cost / total) * 100 : 0;
              return (
                <li
                  key={item.key}
                  onMouseEnter={() => setFocus(item.key)}
                  onMouseLeave={() => setFocus(null)}
                  className={`rounded-lg px-2 py-1.5 transition ${focus === item.key ? 'bg-slate-800/70' : ''}`}
                >
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="flex min-w-0 items-center gap-2 text-slate-300">
                      <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: item.color }} />
                      <span className="truncate" title={item.hint || item.name}>{item.name}</span>
                    </span>
                    <span className="shrink-0 tabular-nums text-slate-100">{formatAmount(item.cost, currency)} <span className="text-xs text-slate-500">{pct.toFixed(1)}%</span></span>
                  </div>
                  <div className="mt-1 h-1 rounded-full bg-slate-800"><div className="h-1 rounded-full" style={{ width: `${pct}%`, background: item.color }} /></div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Card>
  );
}

/** The period's spend by Azure service. */
export function ServiceShare({ series, loading, currency }) {
  const items = useMemo(() => series.share.map(item => ({ key: item.service, name: item.service, cost: item.cost })), [series.share]);
  return <ShareBreakdown title="Spend by service" description="Share of the period's total. Hover a slice or a row." icon={PieIcon} items={items} loading={loading} currency={currency} emptyMessage="No service breakdown for this period." />;
}

/** The period's spend by subscription. */
export function SubscriptionSpend({ months, names, loading, currency }) {
  const items = useMemo(() => {
    const totals = {};
    for (const month of months || []) {
      for (const [id, cost] of Object.entries(month.by_subscription || {})) totals[id] = (totals[id] || 0) + (Number(cost) || 0);
    }
    return Object.entries(totals)
      .filter(([, cost]) => cost !== 0)
      .sort((a, b) => b[1] - a[1])
      .map(([id, cost]) => ({ key: id, name: names[id] || names[String(id).toLowerCase()] || 'Unnamed subscription', hint: id, cost }));
  }, [months, names]);
  return <ShareBreakdown title="Spend by subscription" description="Share of the period's total. Hover a slice or a row." icon={Building2} items={items} loading={loading} currency={currency} emptyMessage="No subscription breakdown for this period." />;
}
