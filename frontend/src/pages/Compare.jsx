import { useEffect, useMemo, useState, Fragment } from 'react';
import { ArrowDownRight, ArrowUpRight, ChevronDown, ChevronRight, Upload, Minus, Sigma } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAppStore } from '../store/useAppStore';
import { filterRows } from '../utils/importAnalytics';
import { buildVariance, buildTrend, monthsIn, explainGroup, explainItem, explainStep, explainTotal, explainTrend, explainTrendGroup, GROUP_OPTIONS, REASONS } from '../utils/costVariance';
import { formatAmount, formatRate } from '../utils/currency';
import { Quantity } from '../components/Common/Amount';
import ExplainPanel from '../components/Common/ExplainPanel';
import UnitRatePanel from '../components/Common/UnitRatePanel';
import QuantityPanel from '../components/Common/QuantityPanel';
import PricingModelPanel from '../components/Common/PricingModelPanel';
import { exactAmount } from '../utils/exact';

/**
 * Where a unit rate came from, and what moved it.
 *
 * A rate shown with no derivation invites the assumption that Azure published
 * it. It did not: this is the effective rate, cost divided by billed quantity,
 * so it moves with tier changes, regional pricing, reservation coverage and
 * partial-month proration alike. Saying so stops the number being read as a
 * price list.
 */
function rateExplanation(item, currency) {
  if (item.prev_rate == null || item.curr_rate == null) {
    return 'No unit rate: this line item has no billed quantity to divide the cost by.';
  }

  const unit = item.unit || 'unit';
  const lines = [
    `Effective unit rate = cost ÷ billed quantity (per ${unit}).`,
    `Derived from the billing data, not a published Azure price.`,
    `Was ${exactAmount(item.prev_rate, currency)}, now ${exactAmount(item.curr_rate, currency)}.`,
  ];

  const delta = item.curr_rate - item.prev_rate;
  if (Math.abs(delta) < 1e-9) {
    lines.push('The rate did not change; the cost moved because usage did.');
  } else {
    const pct = item.prev_rate ? (delta / item.prev_rate) * 100 : null;
    lines.push(
      `${delta > 0 ? 'Up' : 'Down'} ${exactAmount(Math.abs(delta), currency)}` +
      (pct == null ? '' : ` (${pct > 0 ? '+' : ''}${pct.toFixed(1)}%)`) + '.',
    );
    lines.push(
      'A moved rate usually means a tier or region change, reservation coverage ' +
      'starting or ending, or a partial month being prorated.',
    );
  }

  return lines.join('\n');
}

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

function GroupRow({ group, currency, expanded, onToggle, ctx, onExplain, onRate, onQty }) {
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
                  <th
                    className="text-right font-medium pb-1.5 cursor-help underline decoration-dotted decoration-slate-600 underline-offset-4"
                    title={
                      'Quantity billed in each month, in this meter\'s own unit.\n' +
                      'Click any quantity to see it broken down day by day, with the\n' +
                      'start and stop operations behind the shape.'
                    }
                  >
                    Quantity
                  </th>
                  <th
                    className="text-right font-medium pb-1.5 cursor-help underline decoration-dotted decoration-slate-600 underline-offset-4"
                    title={
                      'Effective unit rate = cost ÷ billed quantity.\n' +
                      'Derived from your billing data, not a published Azure price.\n' +
                      'Click any rate to see it against Microsoft\'s published price.'
                    }
                  >
                    Unit rate
                  </th>
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
                        <button
                          type="button"
                          onClick={() => onExplain?.(item)}
                          className="text-left group"
                          title="Show how this figure was calculated and how to verify it"
                        >
                          <p className="text-slate-200 truncate max-w-[22rem] group-hover:text-blue-300 transition-colors" title={item.label}>
                            {item.label}
                          </p>
                          <p className="text-slate-500 truncate max-w-[22rem]">
                            {item.meter}{item.resource_group ? ` · ${item.resource_group}` : ''}
                          </p>
                        </button>
                      </td>
                      <td className="py-1.5 text-right text-slate-400 tabular-nums whitespace-nowrap">
                        {/* No day conversion here: this cell already compares
                            two quantities, and spelling both out puts four
                            numbers where two say the same thing. */}
                        {/* A monthly quantity hides its own shape — the same
                            total covers "ran all month" and "ran three weeks
                            plus a weekend nobody meant to leave on". The button
                            opens the days that tell them apart. */}
                        <button
                          type="button"
                          onClick={() => onQty?.(item)}
                          title="See this quantity day by day, with start and stop events"
                          className="hover:text-blue-300 underline decoration-dotted decoration-slate-700 underline-offset-4 transition-colors"
                        >
                          <Quantity value={item.prev_qty} unit={item.unit} showDuration={false} />
                          <span className="text-slate-600"> → </span>
                          <Quantity value={item.curr_qty} unit={item.unit} showDuration={false} />
                        </button>
                      </td>
                      <td
                        className="py-1.5 text-right text-slate-400 tabular-nums whitespace-nowrap"
                        title={rateExplanation(item, currency)}
                      >
                        {item.prev_rate == null || item.curr_rate == null
                          ? '—'
                          : (
                            /* Opens the side panel that puts this rate next to
                               Microsoft's published one and accounts for the
                               gap. A rate is the figure people dispute, so it
                               is the figure that has to be openable. */
                            <button
                              type="button"
                              onClick={() => onRate?.(item)}
                              title="Compare against Microsoft's published price"
                              className="hover:text-blue-300 underline decoration-dotted decoration-slate-700 underline-offset-4 transition-colors"
                            >
                              {formatRate(item.prev_rate, currency)}
                              <span className="text-slate-600"> → </span>
                              {formatRate(item.curr_rate, currency)}
                            </button>
                          )}
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
                        {/* The explanation sentence is where people stop and
                            ask "says who?", so the way to check it belongs
                            here rather than only on the line item name. */}
                        <button
                          type="button"
                          onClick={() => onExplain?.(item)}
                          className="mt-1.5 inline-flex items-center gap-1.5 text-[11px] font-medium text-blue-400 hover:text-blue-300 transition"
                        >
                          <Sigma className="w-3 h-3" />
                          Show calculation, KQL and portal steps
                        </button>
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

/**
 * The last `count` complete calendar months, newest first.
 *
 * The month dropdowns have to be usable *before* anything is fetched, otherwise
 * the page can never honour "pick two months, then load" — the options would
 * come from data that only exists once the query has already run. The calendar
 * is the one list of months that needs no billing data behind it.
 *
 * The month in progress is included, and labelled. It used to be hidden, on the
 * grounds that a partial month next to a complete one always looks like spend
 * collapsed — which is true, and is exactly why someone checking "what have we
 * spent so far this month" needs it. Hiding the month people most want to see,
 * to protect them from a misreading, costs more than saying "in progress" next
 * to it does.
 */
function calendarMonths(count = 12) {
  const out = [];
  const now = new Date();
  // i = 0 is the current month.
  for (let i = 0; i < count; i += 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

/** `YYYY-MM` for the month currently being billed. */
function currentMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export default function Compare() {
  const imported = useAppStore(s => s.imported);
  const rowsData = useAppStore(s => s.rowsData);
  const rowsLoading = useAppStore(s => s.rowsLoading);
  const rowsError = useAppStore(s => s.rowsError);
  const loadCostRows = useAppStore(s => s.loadCostRows);
  const selectedTenantId = useAppStore(s => s.selectedTenantId);
  const selectedSubscriptionIds = useAppStore(s => s.selectedSubscriptionIds);

  const [groupBy, setGroupBy] = useState('service');
  const [expanded, setExpanded] = useState(() => new Set());
  const [pair, setPair] = useState(null); // [prevMonth, currMonth] once the user picks
  const [view, setView] = useState(null); // 'all' | 'pair', defaults from month count
  // The line item whose derivation is being shown, or null.
  const [explain, setExplain] = useState(null);
  // The line item whose unit rate is being taken apart against Microsoft's
  // published price, or null.
  const [rateItem, setRateItem] = useState(null);
  const [qtyItem, setQtyItem] = useState(null);
  const [loadRequested, setLoadRequested] = useState(false);
  const tenants = useAppStore(s => s.tenants);

  const source = imported || rowsData;
  const live = !imported && !!rowsData;

  // Compare across the whole history, not the active date window — the point of
  // this page is to reach back to an older month the dashboard filter hides.
  const rows = useMemo(
    () => filterRows(source?.rows || [], selectedSubscriptionIds),
    [source, selectedSubscriptionIds],
  );
  const months = useMemo(() => monthsIn(rows), [rows]);

  // `pair` holds what the user has picked so far and may be half-filled, so the
  // dropdowns can show a first choice while waiting for the second. Read as two
  // scalars rather than destructured: a fresh array literal here reads to the
  // React compiler as a value that could be mutated, and it bails out of
  // optimising the whole component rather than risk it.
  const draftPrev = pair?.[0] || null;
  const draftCurr = pair?.[1] || null;

  // Two different months are chosen. This is about the *user's* intent and says
  // nothing about whether data exists for them — it is what the fetch waits on.
  const chosen = !!draftPrev && !!draftCurr && draftPrev !== draftCurr;

  // Nothing is compared until both months are chosen *and* both actually
  // billed. Defaulting to the last two produced a comparison nobody asked for,
  // which was easy to mistake for the period selected elsewhere in the app.
  const complete = chosen && months.includes(draftPrev) && months.includes(draftCurr);
  const prevMonth = complete ? draftPrev : null;
  const currMonth = complete ? draftCurr : null;

  // With three or more months the trend is the more useful default; with
  // exactly two — or none yet — there is nothing a trend can show that the pair
  // view does not.
  const mode = view || (months.length > 2 ? 'all' : 'pair');

  // Reading per-meter rows is a cost query per subscription, and Azure throttles
  // those hard. So the query is tied to a question actually being asked:
  //
  //   * "All months" needs the whole history, and there is no smaller version of
  //     that question — it loads on an explicit request.
  //   * "Compare two" can compute nothing until both months are picked, so it
  //     waits for the second dropdown. Fetching on arrival spent a rate limit
  //     to answer a question the user had not asked yet.
  //
  // An uploaded file is already in memory and costs nothing to read, so it
  // bypasses all of this.
  const shouldLoad = !imported && (mode === 'all' ? loadRequested : chosen);
  const subsKey = selectedSubscriptionIds.join(',');

  useEffect(() => {
    if (shouldLoad) loadCostRows();
  }, [shouldLoad, loadCostRows, selectedTenantId, subsKey]);

  // Before anything is fetched there are no billing months to offer, so the
  // dropdowns fall back to the calendar — which is what makes picking first and
  // fetching second possible at all.
  const monthOptions = months.length ? months : calendarMonths(12);

  // The month still being billed is a real choice, but it is not comparable to
  // a finished one without saying so. Labelling it in the dropdown puts the
  // caveat where the decision is made rather than in a footnote underneath the
  // result.
  const thisMonth = currentMonthKey();
  const monthLabels = useMemo(
    () => ({ [thisMonth]: `${thisMonth} · in progress` }),
    [thisMonth],
  );

  // Open on the two most recent months instead of two empty dropdowns.
  //
  // This page used to insist the user choose before it would fetch anything,
  // to avoid spending a rate limit on a question nobody had asked. But the
  // options themselves come from billing data, so the common path was: land on
  // the page, see two empty selects, and have no idea that picking any two
  // would make a whole page appear. The overwhelmingly common question — "what
  // changed between last month and this one" — is now answered on arrival, and
  // both dropdowns still change it to any other pair.
  const defaultPair = useMemo(() => {
    if (monthOptions.length < 2) return null;
    // monthOptions is newest-first, so [1] is the baseline and [0] the month
    // being compared to it.
    return [monthOptions[1], monthOptions[0]];
  }, [monthOptions]);

  useEffect(() => {
    if (pair || !defaultPair) return undefined;
    if (!imported && !selectedTenantId) return undefined;
    // Deferred a tick: setting state straight from an effect body trips
    // react-hooks, and a frame's delay here is invisible.
    const id = setTimeout(() => setPair(defaultPair), 0);
    return () => clearTimeout(id);
  }, [pair, defaultPair, imported, selectedTenantId]);

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

  const currency = source?.currency || 'INR';

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

  if (!source) {
    if (!selectedTenantId || selectedSubscriptionIds.length === 0) {
      return (
        <Empty
          title="Choose a tenant and subscriptions"
          body="Pick at least one subscription on the dashboard, or upload monthly cost exports, and this page will explain what changed."
        />
      );
    }
    if (rowsLoading) {
      return <Empty busy title="Reading your billing months…" body="Pulling per-meter costs from Azure. This can take a moment the first time." />;
    }
    if (rowsError) {
      return <Empty title="Could not load cost detail" body={rowsError} />;
    }
    // Nothing loaded and no months picked. Offering the pickers here rather
    // than a "load everything" button is the whole point: the two months the
    // user chooses are what the query is for.
    return (
      <div className="p-6 space-y-5">
        <div>
          <h1 className="text-2xl font-bold text-white">Month comparison</h1>
          <p className="text-slate-400 text-sm mt-1">
            This page reads two months meter by meter. It opens on the latest pair; change
            either dropdown to compare any other two.
          </p>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
          <div className="flex flex-wrap items-end gap-2">
            <MonthPicker
              label="Baseline"
              value={draftPrev}
              placeholder="Select month"
              labels={monthLabels}
              options={monthOptions.filter(m => m !== draftCurr)}
              onChange={(m) => setPair([m, draftCurr])}
            />
            <span className="text-slate-600 pb-2">→</span>
            <MonthPicker
              label="Compared to"
              value={draftCurr}
              placeholder="Select month"
              labels={monthLabels}
              options={monthOptions.filter(m => m !== draftPrev)}
              onChange={(m) => setPair([draftPrev, m])}
            />
          </div>
          <p className="text-[11px] text-slate-500 mt-3 leading-relaxed">
            Months come from the calendar until your billing months are known. Pick a month
            with no charges and the page will say so rather than showing an empty comparison.
          </p>
          <button
            onClick={() => { setView('all'); setLoadRequested(true); }}
            className="mt-4 text-xs font-medium text-blue-400 hover:text-blue-300 transition"
          >
            Or load every billing month at once →
          </button>
        </div>
      </div>
    );
  }

  if (months.length < 2) {
    return (
      <Empty
        title="One month loaded — add another to compare"
        body={live
          ? `Azure has only returned ${months[0] || 'a single period'} for these subscriptions. A comparison needs at least two complete billing months.`
          : `Only ${months[0] || 'a single period'} is available. Import a second month's export and this page will break down exactly which resources drove the change.`}
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
              ? `All ${months.length} billing months side by side${live ? ', live from Azure' : ''}.`
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
                value={draftPrev}
                placeholder="Select month"
                labels={monthLabels}
                options={monthOptions.filter(m => m !== draftCurr)}
                onChange={(m) => setPair([m, draftCurr])}
              />
              <span className="text-slate-600 pb-2">→</span>
              <MonthPicker
                label="Compared to"
                value={draftCurr}
                placeholder="Select month"
                labels={monthLabels}
                options={monthOptions.filter(m => m !== draftPrev)}
                onChange={(m) => setPair([draftPrev, m])}
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

      {imported?.overlaps?.length > 0 && (
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
        /* Two cases that look identical but are not: nothing picked yet, versus
           a month picked that never billed. Saying "pick two months" to someone
           who just picked two is how a working page reads as broken. */
        chosen ? (
          <Empty
            busy={rowsLoading}
            title={rowsLoading ? 'Reading those two months…' : 'No charges in those months'}
            body={rowsLoading
              ? `Pulling per-meter costs for ${draftPrev} and ${draftCurr}.`
              : `${[draftPrev, draftCurr].filter(m => !months.includes(m)).join(' and ')} has no billing in this data. `
                + (months.length
                  ? `Months with charges: ${months.join(', ')}.`
                  : 'No month returned any charges for these subscriptions.')}
          />
        ) : (
          <Empty title="Pick two different months" body="Choose a baseline and a comparison month above. Nothing is fetched until both are chosen." />
        )
      ) : (
        <>
          {/* A month still being billed is short by however many days are left
              in it, so it will read as a fall in spend regardless of what is
              actually happening. Said here, next to the number it distorts. */}
          {currMonth === thisMonth && (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-2xl px-5 py-3">
              <p className="text-xs text-amber-200/90 leading-relaxed">
                <span className="font-semibold">{thisMonth} is still being billed.</span>{' '}
                It covers only the days so far, so it will look lower than {prevMonth}
                {' '}even if nothing has changed. Compare it to a finished month for a like-for-like view.
              </p>
            </div>
          )}

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
            <div className="overflow-x-auto">
            <table className="w-full min-w-[38rem] text-xs">
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
                    onExplain={setExplain}
                    onRate={setRateItem}
                    onQty={setQtyItem}
                    expanded={expanded.has(g.key)}
                    onToggle={() => toggle(g.key)}
                  />
                ))}
              </tbody>
            </table>
            </div>
            {variance.groups.length === 0 && (
              <p className="text-xs text-slate-500 text-center py-6">
                Nothing changed between these two months.
              </p>
            )}
            <p className="text-[11px] text-slate-600 mt-3">
              Click any row to see the individual resources and meters behind it,
              or click a line item name to see how its figures were calculated.
            </p>
          </div>

          {/* Before blaming usage or price for a change, rule out the third
              cause: the same usage being paid for differently. A reservation
              starting or expiring moves cost sharply with no usage change at
              all, and it is the explanation people reach for last. */}
          <PricingModelPanel currency={currency} />
        </>
      )}

      {/* Every figure here is derived. The panel shows the working and how to
          reproduce it in whichever source the data actually came from. */}
      <ExplainPanel
        open={!!explain}
        item={explain}
        currency={currency}
        onClose={() => setExplain(null)}
        source={
          imported
            ? 'import'
            : (tenants.find(t => t.tenant_id === selectedTenantId)?.source || 'delegated')
        }
        fileName={imported?.file_name}
        // Only pass a subscription when one is selected: a deep link scoped to
        // the wrong subscription is worse than an unscoped one, because it
        // looks authoritative and shows the wrong numbers.
        subscriptionId={selectedSubscriptionIds.length === 1 ? selectedSubscriptionIds[0] : null}
        fromDate={pair?.[0] ? `${pair[0]}-01` : null}
        toDate={pair?.[1] ? `${pair[1]}-01` : null}
      />

      {/* A unit rate is the figure people dispute, and "cost ÷ quantity" is not
          an answer to "but Microsoft's calculator says something else". This
          puts both rates side by side and accounts for the gap. */}
      {rateItem && (
        <UnitRatePanel
          // Remount per line so a region picked for one meter never silently
          // carries over to the next one opened.
          key={rateItem.key}
          item={rateItem}
          currency={currency}
          prevMonth={prevMonth}
          currMonth={currMonth}
          onClose={() => setRateItem(null)}
        />
      )}

      {/* A monthly quantity is a total, and a total cannot say whether the
          extra hours came from a machine left on for a weekend or a second
          instance appearing for a day. The daily breakdown can. */}
      {qtyItem && (
        <QuantityPanel
          key={qtyItem.key}
          item={qtyItem}
          currency={currency}
          prevMonth={prevMonth}
          currMonth={currMonth}
          onClose={() => setQtyItem(null)}
        />
      )}
    </div>
  );
}

function MonthPicker({ label, value, options, labels, onChange, placeholder }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">{label}</span>
      <select
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        className="bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200"
      >
        {placeholder && <option value="">{placeholder}</option>}
        {options.map(o => <option key={o} value={o}>{labels?.[o] || o}</option>)}
      </select>
    </label>
  );
}

/**
 * The page's stand-in panel, for both "there is nothing" and "there is
 * nothing *yet*".
 *
 * `busy` matters more than it looks. Without it this panel showed an upload
 * icon and a "Go to import" button while a cost query was still running, so a
 * page that was working perfectly read as a page that had failed and was
 * asking the user to go and fetch the data themselves. When something is in
 * flight the icon spins, the CTA is withheld, and the title carries a live
 * region so a screen reader announces the wait instead of silence.
 */
function Empty({ title, body, action, busy = false }) {
  return (
    <div className="p-6">
      <div
        className="bg-slate-900 border border-slate-800 rounded-2xl p-10 text-center max-w-xl mx-auto"
        aria-busy={busy || undefined}
        aria-live={busy ? 'polite' : undefined}
      >
        {busy ? (
          <div
            className="w-8 h-8 mx-auto mb-3 rounded-full border-[3px] border-blue-500"
            style={{ borderTopColor: 'transparent', animation: 'aca-spin .8s linear infinite' }}
            role="status"
            aria-label="Loading"
          />
        ) : (
          <Upload className="w-8 h-8 text-slate-600 mx-auto mb-3" />
        )}
        <h2 className="text-sm font-semibold text-white">{title}</h2>
        <p className="text-xs text-slate-500 mt-1.5 leading-relaxed">{body}</p>
        {busy ? null : action || (
          <Link
            to="/settings"
            className="inline-block mt-4 bg-blue-600 hover:bg-blue-500 text-[#fff] text-sm font-medium px-4 py-2 rounded-xl transition"
          >
            Go to import
          </Link>
        )}
      </div>
    </div>
  );
}
