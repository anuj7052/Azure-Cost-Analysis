import { useMemo, useState, Fragment } from 'react';
import { ArrowDownRight, ArrowUpRight, ChevronDown, ChevronRight, Upload, Minus } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAppStore } from '../store/useAppStore';
import { filterRows } from '../utils/importAnalytics';
import { buildVariance, buildTrend, monthsIn, explainGroup, explainItem, explainStep, explainTotal, explainTrend, explainTrendGroup, GROUP_OPTIONS, REASONS } from '../utils/costVariance';
import { formatAmount } from '../utils/currency';

const REASON_STYLE = {
  new: 'bg-blue-500/15 text-blue-300 border-blue-500/30',
  removed: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  usage: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  rate: 'bg-purple-500/15 text-purple-300 border-purple-500/30',
  mixed: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
  flat: 'bg-slate-500/15 text-slate-400 border-slate-600/30',
};

function ReasonTag({ reason }) {
  const meta = REASONS[reason] || REASONS.mixed;
  return (
    <span
      title={meta.hint}
      className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full border whitespace-nowrap ${REASON_STYLE[reason]}`}
    >
      {meta.label}
    </span>
  );
}

/** Signed money, coloured the way a bill reads: up is bad, down is good. */
function Delta({ value, currency, className = '' }) {
  if (Math.abs(value) < 0.005) {
    return <span className={`text-slate-500 ${className}`}>—</span>;
  }
  const up = value > 0;
  return (
    <span className={`${up ? 'text-red-400' : 'text-emerald-400'} ${className}`}>
      {up ? '+' : '−'}{formatAmount(Math.abs(value), currency)}
    </span>
  );
}

function DriverCard({ label, hint, value, currency }) {
  return (
    <div className="bg-slate-800/60 rounded-xl px-3 py-2.5">
      <p className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">{label}</p>
      <p className="text-sm font-bold mt-0.5">
        <Delta value={value} currency={currency} />
      </p>
      <p className="text-[10px] text-slate-600 mt-0.5 leading-tight">{hint}</p>
    </div>
  );
}

function GroupRow({ group, currency, expanded, onToggle, ctx }) {
  const Icon = expanded ? ChevronDown : ChevronRight;
  return (
    <>
      <tr
        onClick={onToggle}
        className="border-b border-slate-800 hover:bg-slate-800/40 cursor-pointer"
      >
        <td className="py-2 pr-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <Icon className="w-3.5 h-3.5 text-slate-500 shrink-0" />
            <span className="text-slate-200 truncate" title={group.label}>{group.label}</span>
          </div>
        </td>
        <td className="py-2 text-right text-slate-400 tabular-nums">{formatAmount(group.prev, currency)}</td>
        <td className="py-2 text-right text-slate-200 tabular-nums">{formatAmount(group.curr, currency)}</td>
        <td className="py-2 text-right font-semibold tabular-nums">
          <Delta value={group.delta} currency={currency} />
        </td>
        <td className="py-2 text-right text-slate-400 tabular-nums">
          {group.pct == null ? '—' : `${group.pct > 0 ? '+' : ''}${group.pct}%`}
        </td>
        <td className="py-2 pl-2 text-right"><ReasonTag reason={group.reason} /></td>
      </tr>

      {expanded && group.items.length > 0 && (
        <tr className="border-b border-slate-800 bg-slate-950/40">
          <td colSpan={6} className="px-3 py-3">
            <p className="text-[11px] text-slate-300 bg-slate-800/50 border border-slate-700/60 rounded-lg px-3 py-2 mb-3">
              {explainGroup(group, ctx)}
            </p>
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-slate-500 border-b border-slate-800">
                  <th className="text-left font-medium pb-1.5">Line item</th>
                  <th className="text-right font-medium pb-1.5">Quantity</th>
                  <th className="text-right font-medium pb-1.5">Unit rate</th>
                  <th className="text-right font-medium pb-1.5">From usage</th>
                  <th className="text-right font-medium pb-1.5">From rate</th>
                  <th className="text-right font-medium pb-1.5">Change</th>
                </tr>
              </thead>
              <tbody>
                {group.items.slice(0, 25).map(item => (
                  <Fragment key={item.key}>
                    <tr>
                      <td className="py-1.5 pr-2">
                        <p className="text-slate-200 truncate max-w-[22rem]" title={item.label}>{item.label}</p>
                        <p className="text-slate-500 truncate max-w-[22rem]">
                          {item.meter}{item.resource_group ? ` · ${item.resource_group}` : ''}
                        </p>
                      </td>
                      <td className="py-1.5 text-right text-slate-400 tabular-nums whitespace-nowrap">
                        {item.prev_qty} → {item.curr_qty}
                        {item.unit ? <span className="text-slate-600"> {item.unit}</span> : null}
                      </td>
                      <td className="py-1.5 text-right text-slate-400 tabular-nums whitespace-nowrap">
                        {item.prev_rate == null || item.curr_rate == null
                          ? '—'
                          : `${item.prev_rate} → ${item.curr_rate}`}
                      </td>
                      <td className="py-1.5 text-right tabular-nums">
                        <Delta value={item.usage} currency={currency} />
                      </td>
                      <td className="py-1.5 text-right tabular-nums">
                        <Delta value={item.rate} currency={currency} />
                      </td>
                      <td className="py-1.5 text-right font-semibold tabular-nums">
                        <Delta value={item.delta} currency={currency} />
                      </td>
                    </tr>
                    <tr className="border-b border-slate-800/60">
                      <td colSpan={6} className="pb-2.5 pt-0.5">
                        <p className="text-[11px] text-slate-400 leading-relaxed">
                          {explainItem(item, ctx)}
                        </p>
                      </td>
                    </tr>
                  </Fragment>
                ))}
              </tbody>
            </table>
            {group.items.length > 25 && (
              <p className="text-[10px] text-slate-600 mt-2">
                Showing the 25 largest of {group.items.length} changed line items.
              </p>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

/** Every imported month side by side, one column per month. */
function TrendTable({ trend, currency, groupLabel, stepGroupsFor, expanded, onToggle, ctx }) {
  const { months, totals, groups } = trend;
  const span = months.length + 3;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs min-w-[40rem]">
        <thead>
          <tr className="text-slate-500 border-b border-slate-800">
            <th className="text-left font-medium pb-2 sticky left-0 bg-slate-900">{groupLabel}</th>
            {months.map(m => (
              <th key={m} className="text-right font-medium pb-2 px-2 whitespace-nowrap">{m}</th>
            ))}
            <th className="text-right font-medium pb-2 pl-2 whitespace-nowrap">First → last</th>
            <th className="text-right font-medium pb-2 pl-2">Biggest jump</th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-b border-slate-800 bg-slate-800/30 font-semibold">
            <td className="py-2 text-white sticky left-0 bg-slate-800/30">All months</td>
            {totals.map((t, i) => (
              <td key={months[i]} className="py-2 px-2 text-right text-white tabular-nums">
                {formatAmount(t, currency)}
              </td>
            ))}
            <td className="py-2 pl-2 text-right tabular-nums">
              <Delta value={totals[totals.length - 1] - totals[0]} currency={currency} />
            </td>
            <td className="py-2 pl-2" />
          </tr>

          {groups.map(g => {
            const open = expanded.has(g.key);
            const Icon = open ? ChevronDown : ChevronRight;
            const stepGroups = stepGroupsFor(g.key);
            return (
              <Fragment key={g.key}>
                <tr
                  onClick={() => onToggle(g.key)}
                  className="border-b border-slate-800/60 hover:bg-slate-800/30 cursor-pointer"
                >
                  <td className="py-2 pr-2 sticky left-0 bg-slate-900">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <Icon className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                      <span className="text-slate-200 truncate max-w-[13rem]" title={g.label}>{g.label}</span>
                    </div>
                  </td>
                  {g.costs.map((c, i) => (
                    <td key={months[i]} className="py-2 px-2 text-right text-slate-300 tabular-nums">
                      {c === 0 ? <span className="text-slate-600">—</span> : formatAmount(c, currency)}
                    </td>
                  ))}
                  <td className="py-2 pl-2 text-right font-semibold tabular-nums whitespace-nowrap">
                    <Delta value={g.delta} currency={currency} />
                    {g.pct != null && Math.abs(g.delta) >= 0.005 && (
                      <span className="text-slate-600 ml-1">({g.pct > 0 ? '+' : ''}{g.pct}%)</span>
                    )}
                  </td>
                  <td className="py-2 pl-2 text-right text-[11px] whitespace-nowrap">
                    {g.peakStep && Math.abs(g.peakStep.delta) >= 0.005 ? (
                      <>
                        <Delta value={g.peakStep.delta} currency={currency} />
                        <span className="text-slate-600 block">{g.peakStep.from} → {g.peakStep.to}</span>
                      </>
                    ) : <span className="text-slate-600">—</span>}
                  </td>
                </tr>

                {open && (
                  <tr className="border-b border-slate-800 bg-slate-950/40">
                    <td colSpan={span} className="px-3 py-3">
                      <p className="text-[11px] text-slate-300 bg-slate-800/50 border border-slate-700/60 rounded-lg px-3 py-2">
                        {explainTrendGroup(g, stepGroups, ctx)}
                      </p>
                      <ul className="mt-2 space-y-1">
                        {stepGroups.map((s, i) => (
                          <li key={trend.steps[i].to} className="text-[11px] text-slate-400 leading-relaxed">
                            <span className="text-slate-500 font-medium">
                              {trend.steps[i].from} → {trend.steps[i].to}:
                            </span>{' '}
                            {s
                              ? explainGroup(s.g, { ...ctx, prevMonth: s.from })
                              : 'no billing in either month.'}
                          </li>
                        ))}
                      </ul>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function Compare() {
  const imported = useAppStore(s => s.imported);
  const selectedSubscriptionIds = useAppStore(s => s.selectedSubscriptionIds);

  const [groupBy, setGroupBy] = useState('service');
  const [expanded, setExpanded] = useState(() => new Set());
  const [pair, setPair] = useState(null); // [prevMonth, currMonth] once the user picks
  const [view, setView] = useState(null); // 'all' | 'pair', defaults from month count

  // Compare across the whole import, not the active date window — the point of
  // this page is to reach back to an older month the dashboard filter hides.
  const rows = useMemo(
    () => filterRows(imported?.rows || [], selectedSubscriptionIds),
    [imported, selectedSubscriptionIds],
  );
  const months = useMemo(() => monthsIn(rows), [rows]);

  const [prevMonth, currMonth] = pair
    && months.includes(pair[0]) && months.includes(pair[1])
    ? pair
    : [months.at(-2), months.at(-1)];

  const variance = useMemo(() => {
    if (!prevMonth || !currMonth || prevMonth === currMonth) return null;
    return buildVariance(rows, prevMonth, currMonth, { groupBy });
  }, [rows, prevMonth, currMonth, groupBy]);

  const trend = useMemo(() => buildTrend(rows, { groupBy }), [rows, groupBy]);

  // Attribute every consecutive step so the trend can say *why* each month
  // moved, not just by how much.
  const stepVariances = useMemo(() => {
    if (!trend || trend.months.length < 2) return [];
    return trend.steps.map(s => buildVariance(rows, s.from, s.to, { groupBy }));
  }, [rows, trend, groupBy]);

  // For one group, its entry in each step variance (null where it did not bill).
  const stepGroupsFor = useMemo(() => {
    const maps = stepVariances.map(v => new Map(v.groups.map(g => [g.key, g])));
    return (key) => maps.map((map, i) => {
      const g = map.get(key);
      return g ? { g, from: trend.steps[i].from, to: trend.steps[i].to } : null;
    });
  }, [stepVariances, trend]);

  // With three or more months the trend is the more useful default; with
  // exactly two there is nothing a trend can show that the pair view does not.
  const mode = view || (months.length > 2 ? 'all' : 'pair');

  const currency = imported?.currency || 'INR';

  // Explanations need to render money the same way the rest of the page does.
  const ctx = useMemo(
    () => ({ money: (v) => formatAmount(v, currency), prevMonth, currMonth }),
    [currency, prevMonth, currMonth],
  );

  const toggle = (key) => setExpanded(prev => {
    const next = new Set(prev);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });

  if (!imported) {
    return (
      <Empty
        title="Import your monthly cost files first"
        body="This page compares two billing months and explains the difference. Upload at least two Azure cost exports — one per month — to get started."
      />
    );
  }

  if (months.length < 2) {
    return (
      <Empty
        title="One month loaded — add another to compare"
        body={`Only ${months[0] || 'a single period'} is available. Import a second month's export and this page will break down exactly which resources drove the change.`}
      />
    );
  }

  return (
    <div className="p-6 space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">Month comparison</h1>
          <p className="text-slate-400 text-sm mt-1">
            {mode === 'all'
              ? `All ${months.length} imported months side by side.`
              : 'Why the bill moved — split into new resources, removed resources, usage and rate.'}
          </p>
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <div className="flex bg-slate-800 rounded-xl p-0.5">
            <button
              onClick={() => setView('all')}
              className={`text-xs font-medium px-3 py-1.5 rounded-lg ${mode === 'all' ? 'bg-blue-600 text-[#fff]' : 'text-slate-400 hover:text-slate-200'}`}
            >
              All months ({months.length})
            </button>
            <button
              onClick={() => setView('pair')}
              className={`text-xs font-medium px-3 py-1.5 rounded-lg ${mode === 'pair' ? 'bg-blue-600 text-[#fff]' : 'text-slate-400 hover:text-slate-200'}`}
            >
              Compare two
            </button>
          </div>

          {mode === 'pair' && (
            <>
              <MonthPicker
                label="Baseline"
                value={prevMonth}
                options={months.filter(m => m !== currMonth)}
                onChange={(m) => setPair([m, currMonth])}
              />
              <span className="text-slate-600 pb-2">→</span>
              <MonthPicker
                label="Compared to"
                value={currMonth}
                options={months.filter(m => m !== prevMonth)}
                onChange={(m) => setPair([prevMonth, m])}
              />
            </>
          )}

          <MonthPicker
            label="Group by"
            value={groupBy}
            options={GROUP_OPTIONS.map(o => o.value)}
            labels={Object.fromEntries(GROUP_OPTIONS.map(o => [o.value, o.label]))}
            onChange={setGroupBy}
          />
        </div>
      </div>

      {imported.overlaps?.length > 0 && (
        <p className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-xl px-3 py-2">
          Some months appear in more than one imported file, so these figures double-count.
          Remove the duplicate file in <Link to="/settings" className="underline">Settings</Link>.
        </p>
      )}

      {mode === 'all' && trend ? (
        <>
          {/* Month totals + the step between each pair */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
            <h2 className="text-sm font-semibold text-white mb-3">Spend by month</h2>
            <div className="flex flex-wrap gap-2">
              {trend.months.map((m, i) => {
                const step = i > 0 ? trend.steps[i - 1] : null;
                return (
                  <div key={m} className="bg-slate-800/60 rounded-xl px-3 py-2.5 min-w-[8.5rem]">
                    <p className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">{m}</p>
                    <p className="text-base font-bold text-white mt-0.5 tabular-nums">
                      {formatAmount(trend.totals[i], currency)}
                    </p>
                    <p className="text-[10px] mt-0.5">
                      {step ? (
                        <>
                          <Delta value={step.delta} currency={currency} />
                          {step.pct != null && (
                            <span className="text-slate-600"> ({step.pct > 0 ? '+' : ''}{step.pct}%)</span>
                          )}
                        </>
                      ) : <span className="text-slate-600">baseline</span>}
                    </p>
                  </div>
                );
              })}
            </div>

            <p className="text-[11px] text-slate-500 mt-3">
              {trend.months.length} months totalling {formatAmount(trend.grand_total, currency)} —
              averaging {formatAmount(trend.avg_month, currency)} a month, ranging from{' '}
              {formatAmount(trend.min_month, currency)} to {formatAmount(trend.max_month, currency)}.
              Switch to <button onClick={() => setView('pair')} className="underline text-slate-400">Compare two</button>{' '}
              for a usage-versus-rate breakdown of any single step.
            </p>
          </div>

          {/* Plain-English narrative across the whole range */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
            <h2 className="text-sm font-semibold text-white mb-1.5">In plain English</h2>
            <p className="text-sm text-slate-300 leading-relaxed">
              {explainTrend(trend, stepVariances, ctx)}
            </p>

            <ul className="mt-3 space-y-1.5">
              {stepVariances.map(v => (
                <li
                  key={`${v.prevMonth}-${v.currMonth}`}
                  className="text-xs text-slate-400 leading-relaxed bg-slate-800/40 border border-slate-700/50 rounded-lg px-3 py-2"
                >
                  {explainStep(v, ctx)}
                </li>
              ))}
            </ul>

            <p className="text-[11px] text-slate-500 mt-2">
              Open any row in the table below for that service's own story, month by month.
            </p>
          </div>

          {/* Every month, one column each */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
            <h2 className="text-sm font-semibold text-white mb-3">
              Every month by {GROUP_OPTIONS.find(o => o.value === groupBy)?.label.toLowerCase()}
            </h2>
            <TrendTable
              trend={trend}
              currency={currency}
              groupLabel={GROUP_OPTIONS.find(o => o.value === groupBy)?.label}
              stepGroupsFor={stepGroupsFor}
              expanded={expanded}
              onToggle={toggle}
              ctx={ctx}
            />
          </div>
        </>
      ) : !variance ? (
        <Empty title="Pick two different months" body="Choose a baseline and a comparison month above." />
      ) : (
        <>
          {/* Headline */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
            <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
              <div>
                <p className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">{prevMonth}</p>
                <p className="text-xl font-bold text-slate-300 mt-0.5">{formatAmount(variance.prev_total, currency)}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">{currMonth}</p>
                <p className="text-xl font-bold text-white mt-0.5">{formatAmount(variance.curr_total, currency)}</p>
              </div>
              <div className="flex items-center gap-2">
                {variance.delta > 0
                  ? <ArrowUpRight className="w-7 h-7 text-red-400" />
                  : variance.delta < 0
                    ? <ArrowDownRight className="w-7 h-7 text-emerald-400" />
                    : <Minus className="w-7 h-7 text-slate-500" />}
                <div>
                  <p className="text-xl font-bold">
                    <Delta value={variance.delta} currency={currency} />
                  </p>
                  <p className="text-xs text-slate-500">
                    {variance.pct == null ? 'no baseline' : `${variance.pct > 0 ? '+' : ''}${variance.pct}% vs ${prevMonth}`}
                  </p>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-4">
              <DriverCard label="New resources" hint="Started billing this month" value={variance.drivers.new} currency={currency} />
              <DriverCard label="Removed" hint="Stopped billing this month" value={variance.drivers.removed} currency={currency} />
              <DriverCard label="Usage change" hint="Same rate, different quantity" value={variance.drivers.usage} currency={currency} />
              <DriverCard label="Rate change" hint="Same quantity, different unit price" value={variance.drivers.rate} currency={currency} />
            </div>

            <p className="text-[11px] text-slate-500 mt-3">
              Increases totalled {formatAmount(variance.increase_total, currency)} and decreases{' '}
              {formatAmount(Math.abs(variance.decrease_total), currency)}. The four drivers above
              always add up to the net change.
            </p>
          </div>

          {/* Plain-English summary */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
            <h2 className="text-sm font-semibold text-white mb-1.5">In plain English</h2>
            <p className="text-sm text-slate-300 leading-relaxed">{explainTotal(variance, ctx)}</p>
            <p className="text-[11px] text-slate-500 mt-2">
              Open any row below for a sentence explaining that specific service and resource.
            </p>
          </div>

          {/* Breakdown */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
            <h2 className="text-sm font-semibold text-white mb-3">
              What changed, biggest movement first
            </h2>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-slate-500 border-b border-slate-800">
                  <th className="text-left font-medium pb-2">
                    {GROUP_OPTIONS.find(o => o.value === groupBy)?.label}
                  </th>
                  <th className="text-right font-medium pb-2">{prevMonth}</th>
                  <th className="text-right font-medium pb-2">{currMonth}</th>
                  <th className="text-right font-medium pb-2">Change</th>
                  <th className="text-right font-medium pb-2">%</th>
                  <th className="text-right font-medium pb-2 pl-2">Cause</th>
                </tr>
              </thead>
              <tbody>
                {variance.groups.map(g => (
                  <GroupRow
                    key={g.key}
                    group={g}
                    currency={currency}
                    ctx={ctx}
                    expanded={expanded.has(g.key)}
                    onToggle={() => toggle(g.key)}
                  />
                ))}
              </tbody>
            </table>
            {variance.groups.length === 0 && (
              <p className="text-xs text-slate-500 text-center py-6">
                Nothing changed between these two months.
              </p>
            )}
            <p className="text-[11px] text-slate-600 mt-3">
              Click any row to see the individual resources and meters behind it.
            </p>
          </div>
        </>
      )}
    </div>
  );
}

function MonthPicker({ label, value, options, labels, onChange }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">{label}</span>
      <select
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        className="bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200"
      >
        {options.map(o => <option key={o} value={o}>{labels?.[o] || o}</option>)}
      </select>
    </label>
  );
}

function Empty({ title, body }) {
  return (
    <div className="p-6">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-10 text-center max-w-xl mx-auto">
        <Upload className="w-8 h-8 text-slate-600 mx-auto mb-3" />
        <h2 className="text-sm font-semibold text-white">{title}</h2>
        <p className="text-xs text-slate-500 mt-1.5 leading-relaxed">{body}</p>
        <Link
          to="/settings"
          className="inline-block mt-4 bg-blue-600 hover:bg-blue-500 text-[#fff] text-sm font-medium px-4 py-2 rounded-xl transition"
        >
          Go to import
        </Link>
      </div>
    </div>
  );
}
