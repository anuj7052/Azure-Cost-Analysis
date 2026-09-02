/**
 * Cost analysis the reader drives.
 *
 * The chart this replaces drew one thing: the whole estate, by month, as an
 * area. Everything else -- by resource group, daily, this service only, the
 * top five meters -- meant leaving for the Azure portal. So the shape of the
 * chart is a choice now, and a choice worth making twice is worth keeping,
 * which is what the saved views are for.
 *
 * The dimensions offered depend on the data actually held. Monthly comes from
 * the meter rows and can be split every way Azure reports; daily comes from
 * the daily totals and Azure splits those by service only. Rather than offer a
 * grouping that would quietly return an empty chart, the view says which
 * grouping it cannot do and why.
 */
import { useMemo, useState } from 'react';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Legend, Line, LineChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { BookmarkPlus, Check, Filter, Trash2, X } from 'lucide-react';

import {
  CHART_TYPES, DIMENSIONS, GRANULARITIES,
  buildView, defaultView, describeView, filterOptions, normaliseView,
} from '../../utils/costExplorer';
import { formatAmount } from '../../utils/currency';
import { useChartTheme } from '../../store/useTheme';

/** A labelled control, so the toolbar reads as sentences rather than widgets. */
function Choice({ label, value, options, onChange, disabled }) {
  return (
    <label className="flex items-center gap-1.5 text-[11px] text-slate-500">
      {label}
      <select
        value={value}
        disabled={disabled}
        onChange={e => onChange(e.target.value)}
        className="rounded-lg border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-slate-200 outline-none focus:border-sky-500 disabled:opacity-40"
      >
        {options.map(o => (
          <option key={o.key} value={o.key}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}

export default function CostAnalysisChart({
  rows = [], days = [], currency = 'INR', loading = false,
  saved = [], onSave, onDelete,
}) {
  const t = useChartTheme();
  const [view, setView] = useState(defaultView);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [filterOn, setFilterOn] = useState('service');

  const set = (patch) => setView(v => normaliseView({ ...v, ...patch }));
  const built = useMemo(
    () => buildView(view, { rows, days, currency }),
    [view, rows, days, currency],
  );

  const dailyOnly = view.granularity === 'daily';
  // Daily data carries a service split and nothing else, so the other
  // dimensions are shown as unavailable rather than silently missing.
  const groupOptions = DIMENSIONS.map(d => ({
    ...d,
    label: dailyOnly && !['none', 'service'].includes(d.key)
      ? `${d.label} (monthly only)`
      : d.label,
  }));

  const options = useMemo(
    () => filterOptions(rows, filterOn, view.filters).slice(0, 40),
    [rows, filterOn, view.filters],
  );

  const chosen = view.filters[filterOn] || [];
  const activeFilters = Object.entries(view.filters);

  function toggleFilter(dimension, value) {
    const current = view.filters[dimension] || [];
    const next = current.includes(value)
      ? current.filter(v => v !== value)
      : [...current, value];
    const filters = { ...view.filters };
    if (next.length) filters[dimension] = next; else delete filters[dimension];
    set({ filters });
  }

  function commitSave() {
    if (!name.trim()) return;
    onSave?.({ ...view, name: name.trim(), id: undefined });
    setView(v => ({ ...v, name: name.trim() }));
    setNaming(false);
    setName('');
  }

  const fmt = (v) => formatAmount(v, currency);
  const Chart = { area: AreaChart, bar: BarChart, line: LineChart }[view.chart];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Choice
          label="Show"
          value={view.granularity}
          options={GRANULARITIES}
          onChange={v => set({ granularity: v })}
        />
        <Choice
          label="by"
          value={view.groupBy}
          options={groupOptions}
          onChange={v => set({ groupBy: v })}
        />
        <Choice
          label="as"
          value={view.chart}
          options={CHART_TYPES}
          onChange={v => set({ chart: v })}
        />
        {view.groupBy !== 'none' && (
          <Choice
            label="top"
            value={String(view.topN)}
            options={[5, 10, 15, 25].map(n => ({ key: String(n), label: String(n) }))}
            onChange={v => set({ topN: Number(v) })}
          />
        )}
        {view.groupBy !== 'none' && view.chart !== 'line' && (
          <label className="flex items-center gap-1.5 text-[11px] text-slate-500">
            <input
              type="checkbox"
              checked={view.stacked}
              onChange={e => set({ stacked: e.target.checked })}
              className="accent-sky-500"
            />
            Stacked
          </label>
        )}

        <span className="flex-1" />

        {onSave && (naming ? (
          <span className="flex items-center gap-1.5">
            <input
              autoFocus
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') commitSave();
                if (e.key === 'Escape') setNaming(false);
              }}
              placeholder="Name this view"
              className="w-40 rounded-lg border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-slate-200 outline-none focus:border-sky-500"
            />
            <button
              onClick={commitSave}
              className="rounded-lg border border-sky-500/50 bg-sky-500/10 p-1 text-sky-300"
              aria-label="Save view"
            >
              <Check size={13} />
            </button>
            <button
              onClick={() => setNaming(false)}
              className="rounded-lg border border-slate-700 p-1 text-slate-400"
              aria-label="Cancel"
            >
              <X size={13} />
            </button>
          </span>
        ) : (
          <button
            onClick={() => { setNaming(true); setName(view.name || ''); }}
            className="flex items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 py-1 text-[11px] text-slate-300 transition hover:border-slate-500 hover:text-white"
          >
            <BookmarkPlus size={13} />
            Save this view
          </button>
        ))}
      </div>

      {/* Filters. The values offered are ranked by cost and narrowed by the
          other filters already on, so the list is of things that would change
          the picture rather than everything Azure has ever billed. */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-2">
        <Filter size={13} className="shrink-0 text-slate-500" />
        <Choice
          label="Filter by"
          value={filterOn}
          options={DIMENSIONS.filter(d => d.key !== 'none')}
          onChange={setFilterOn}
        />
        <select
          value=""
          onChange={e => e.target.value && toggleFilter(filterOn, e.target.value)}
          className="min-w-[10rem] max-w-[16rem] rounded-lg border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-slate-200 outline-none focus:border-sky-500"
        >
          <option value="">
            {options.length ? 'Add a value…' : 'Nothing to filter on'}
          </option>
          {options.map(o => (
            <option key={o.value} value={o.value} disabled={chosen.includes(o.value)}>
              {o.value} — {fmt(o.cost)}
            </option>
          ))}
        </select>

        {activeFilters.length === 0 ? (
          <span className="text-[11px] text-slate-600">No filters — showing everything.</span>
        ) : (
          activeFilters.map(([dimension, values]) => values.map(value => (
            <button
              key={`${dimension}:${value}`}
              onClick={() => toggleFilter(dimension, value)}
              className="flex max-w-[16rem] items-center gap-1 rounded-md border border-sky-500/40 bg-sky-500/10 px-1.5 py-0.5 text-[11px] text-sky-200 transition hover:border-rose-500/50 hover:text-rose-200"
              title="Remove this filter"
            >
              <span className="truncate">
                {DIMENSIONS.find(d => d.key === dimension)?.label}: {value}
              </span>
              <X size={11} className="shrink-0" />
            </button>
          )))
        )}
      </div>

      {loading ? (
        <div className="h-[280px] animate-pulse rounded-xl bg-slate-800/40" />
      ) : built.note ? (
        <p className="flex h-[280px] items-center justify-center px-8 text-center text-sm leading-relaxed text-slate-500">
          {built.note}
        </p>
      ) : (
        <>
          <ResponsiveContainer width="100%" height={280}>
            <Chart data={built.points} margin={{ top: 5, right: 16, left: 4, bottom: 0 }}>
              <defs>
                {built.keys.map((key, i) => (
                  <linearGradient key={key} id={`ce-${i}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={t.series[i % t.series.length]}
                      stopOpacity={t.isLight ? 0.22 : 0.32} />
                    <stop offset="95%" stopColor={t.series[i % t.series.length]} stopOpacity={0} />
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke={t.grid} vertical={false} />
              <XAxis dataKey="label" tick={{ fill: t.axis, fontSize: 11 }}
                axisLine={false} tickLine={false} minTickGap={16} />
              <YAxis tick={{ fill: t.axis, fontSize: 11 }} axisLine={false} tickLine={false}
                width={64} tickFormatter={v => formatAmount(v, currency, true)} />
              <Tooltip cursor={t.tooltipCursor} contentStyle={t.tooltip}
                labelStyle={t.tooltipLabel} formatter={v => fmt(v)} />
              {built.keys.length > 1 && (
                <Legend iconType="circle" iconSize={8}
                  wrapperStyle={{ color: t.axis, fontSize: 11 }} />
              )}
              {built.keys.map((key, i) => {
                const colour = t.series[i % t.series.length];
                if (view.chart === 'bar') {
                  return (
                    <Bar key={key} dataKey={key} name={key} fill={colour}
                      stackId={view.stacked ? 'a' : undefined} radius={[2, 2, 0, 0]} />
                  );
                }
                if (view.chart === 'line') {
                  return (
                    <Line key={key} type="monotone" dataKey={key} name={key}
                      stroke={colour} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                  );
                }
                return (
                  <Area key={key} type="monotone" dataKey={key} name={key}
                    stroke={colour} fill={`url(#ce-${i})`} strokeWidth={2} dot={false}
                    stackId={view.stacked ? 'a' : undefined} activeDot={{ r: 4 }} />
                );
              })}
            </Chart>
          </ResponsiveContainer>

          <p className="text-[11px] text-slate-500">
            {fmt(built.total)} across {built.points.length}{' '}
            {view.granularity === 'daily' ? 'days' : 'months'}.
            {built.truncated > 0 && ` The ${built.truncated} smallest series are summed into "Other" rather than dropped, so the chart still adds up to this total.`}
          </p>
        </>
      )}

      {saved.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-t border-slate-800 pt-3">
          <span className="text-[11px] text-slate-500">Saved views</span>
          {saved.map(s => (
            <span
              key={s.id}
              className="flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800/60 pl-2 pr-1 py-0.5"
            >
              <button
                onClick={() => setView(normaliseView(s))}
                className="text-[11px] text-slate-300 transition hover:text-white"
                title={describeView(s)}
              >
                {s.name}
              </button>
              {onDelete && (
                <button
                  onClick={() => onDelete(s.id)}
                  className="text-slate-600 transition hover:text-rose-400"
                  aria-label={`Delete ${s.name}`}
                >
                  <Trash2 size={11} />
                </button>
              )}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
