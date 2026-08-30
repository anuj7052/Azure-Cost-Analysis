import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { IndianRupee, TrendingUp, TrendingDown, AlertTriangle, PiggyBank, BarChart2, Flame, Network, ArrowUpFromLine, ArrowDownToLine, CalendarDays } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import HeroCard from '../components/Cards/HeroCard';
import DataQuality from '../components/Common/DataQuality';
import PricingSection from '../components/Cards/PricingSection';
import DetailPanel, { DetailStat } from '../components/Common/DetailPanel';
import PortalGuide from '../components/Common/PortalGuide';
import { COST_GUIDE } from '../components/Common/portalGuides';
import AnomalyCard from '../components/Cards/AnomalyCard';
import CostTrendChart from '../components/Charts/CostTrendChart';
import ServicePieChart from '../components/Charts/ServicePieChart';
import { formatAmount, formatAmountFull } from '../utils/currency';
import { exactAmount } from '../utils/exact';
import { Amount } from '../components/Common/Amount';
import { compareBoqToUsage } from '../utils/boqCompare';
import { formatBytes, formatGB, formatTB, pctOf, splitBytes, toGB } from '../utils/bytes';

export default function Dashboard() {
  const {
    costData, costLoading, loadCosts,
    selectedSubscriptionIds, selectedTenantId, months, dateKey, dateMode, fromDate, toDate,
    subscriptions,
    bandwidthData: bw, bandwidthLoading: bwLoading, loadBandwidth,
    pricingData, pricingLoading, pricingError, loadPricing,
    computeData, computeLoading, loadCompute,
    orphanedData, orphanedLoading, loadOrphaned,
    activityData, activityLoading, activityError, loadActivity,
    imported, boqs,
  } = useAppStore();

  const navigate = useNavigate();
  const [detail, setDetail] = useState(null);

  // The savings and activity panels are not loaded with the page.
  //
  // Between them they are the three most expensive calls in the app: /compute
  // alone fans out to Resource Graph, Cost Management, Azure Monitor and Retail
  // Prices, at roughly two Monitor requests per virtual machine. Firing them on
  // every dashboard visit tripled the Azure traffic of the page people open
  // first, and Monitor throttles — so the cost of the tile was paid by the
  // Compute page, which then had to report "Not enough data".
  //
  // They still appear immediately when the store already holds an answer,
  // which it does after visiting those pages or from the cache on this device.
  // Otherwise they are one click away, and the click is the person saying the
  // findings are worth the wait.
  const haveExtras = Boolean(computeData || orphanedData || activityData);
  const loadingExtras = computeLoading || orphanedLoading || activityLoading;
  const loadExtras = () => {
    // Sequential, heaviest last, for the same reason the page's own loads are
    // staged: three fan-outs at once is what gets a tenant throttled.
    (async () => {
      await Promise.allSettled([loadOrphaned(), loadActivity()]);
      await loadCompute();
    })();
  };

  useEffect(() => {
    if (!(imported || (selectedTenantId && selectedSubscriptionIds.length > 0))) return undefined;

    let cancelled = false;

    // Costs first, on its own, then the rest together.
    //
    // All three are Cost Management queries that fan out across every selected
    // subscription, and firing all of them at once on a nine-subscription
    // tenant put ~27 queries in flight and got the lot throttled.
    //
    // Fully serialising them fixed that but made the page three times slower
    // than it needed to be. Costs fills every tile above the fold, so it gets
    // the whole rate-limit budget to itself and lands as fast as Azure can
    // manage it. Bandwidth and reservations decorate sections further down,
    // and once costs is done there is no reason to make them wait on each
    // other as well.
    (async () => {
      await loadCosts();
      if (cancelled) return;
      await Promise.allSettled([loadBandwidth(), loadPricing()]);
    })();

    return () => { cancelled = true; };
  }, [imported, selectedTenantId, selectedSubscriptionIds.join(','), dateKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const latest        = costData?.months?.at(-1);
  const previous      = costData?.months?.at(-2);
  const mom           = costData?.mom_change_pct;
  // Counts stay null until something has actually been loaded. "We have not
  // looked" and "we looked and found none" are different answers, and a
  // dashboard that renders both as 0 is quietly telling you the estate is
  // clean when it has never been examined.
  const anomalyCount  = costData ? (costData.anomalies?.length || 0) : null;
  const savingsTotal  = costData
    ? (costData.savings?.reduce((acc, s) => acc + s.saved_amount, 0) || 0)
    : null;
  const avgMonthly    = costData?.months?.length
    ? costData.months.reduce((s, m) => s + m.total_cost, 0) / costData.months.length : null;
  const dailyBurn     = latest?.total_cost ? latest.total_cost / 30 : null;
  const currency      = costData?.months?.[0]?.currency || 'INR';
  const fmt           = (v) => formatAmount(v, currency);
  const full          = (v) => formatAmountFull(v, currency);
  // The unabbreviated figure, shown on hover so a tile can be reconciled
  // against an invoice without leaving the dashboard.
  const exact         = (v) => exactAmount(v, currency);
  const subMap        = Object.fromEntries((subscriptions || []).map(s => [s.subscription_id, s.display_name]));

  const bwCurrency    = bw?.currency || currency;
  const bwTotal       = bw?.total_bytes || 0;

  // The header and tiles must describe the range actually in effect, otherwise
  // picking a single month still reads "last 6 months" and looks like nothing changed.
  const isCustom      = dateMode === 'custom' && fromDate && toDate;
  const periodShort   = isCustom ? 'period' : `${months}M`;
  const periodLong    = isCustom ? `${fromDate} → ${toDate}` : `last ${months} months`;

  // Whether the newest month in the data is the one we are currently living
  // through. If it is, it is only partially billed, so it will always look
  // cheap beside a completed month and the month-over-month figure is
  // comparing a part-month to a whole one.
  const currentMonthKey = new Date().toISOString().slice(0, 7);
  const latestIsPartial = Boolean(latest) && latest.month.startsWith(currentMonthKey);

  // ── Savings opportunities ────────────────────────────────────────────────
  // Assembled from two endpoints that already exist rather than a new one, and
  // deliberately not summed into a single headline figure. A right-sizing
  // saving is modelled from thirty days of telemetry; an orphaned resource's
  // figure is what Azure has already charged for something nothing is attached
  // to. Adding them together would present a forecast and a fact as one number.
  const savingsGroups = useMemo(() => {
    const groups = [];
    const vms = computeData?.vms || [];
    const buckets = [
      ['IDLE', 'Idle VMs', 'idle'],
      ['OVERSIZED', 'Right-size VMs', 'can be downsized'],
      ['DEALLOCATE', 'Stopped but billing', 'stopped and still billing'],
    ];
    for (const [status, title, phrase] of buckets) {
      const rows = vms.filter(v => v.right_sizing?.status === status);
      if (!rows.length) continue;
      const priced = rows.filter(v => typeof v.savings?.monthly === 'number');
      groups.push({
        key: status,
        title,
        detail: `${rows.length} ${rows.length === 1 ? 'machine' : 'machines'} ${phrase}`,
        // null rather than 0. A machine whose replacement size Azure would not
        // quote has an unknown saving, not an absent one, and a zero here would
        // read as "nothing to gain".
        monthly: priced.length ? priced.reduce((s, v) => s + v.savings.monthly, 0) : null,
        unpriced: rows.length - priced.length,
        to: '/compute',
      });
    }
    for (const c of orphanedData?.categories || []) {
      if (!c.count) continue;
      groups.push({
        key: c.key,
        title: c.title,
        detail: `${c.count} found · ${c.severity === 'certain' ? 'certainly unused' : 'likely unused'}`,
        monthly: typeof c.monthly_cost === 'number' ? c.monthly_cost : null,
        unpriced: 0,
        to: '/orphaned',
      });
    }
    return groups.sort((a, b) => (b.monthly ?? -1) - (a.monthly ?? -1));
  }, [computeData, orphanedData]);

  // Savings rolled up per subscription. Neither endpoint returns this, so it is
  // summed here from rows that each carry their own subscription_id — derived
  // from real figures, not estimated.
  const savingsBySub = useMemo(() => {
    const out = {};
    const add = (id, amount) => {
      if (!id || typeof amount !== 'number') return;
      out[id] = (out[id] || 0) + amount;
    };
    for (const v of computeData?.vms || []) add(v.subscription_id, v.savings?.monthly);
    for (const c of orphanedData?.categories || []) {
      for (const it of c.items || []) add(it.subscription_id, it.monthly_cost);
    }
    return out;
  }, [computeData, orphanedData]);

  /** Every hero tile declares how its drill-down renders. */
  const HEROES = useMemo(() => ({
    total: {
      title: `Actual Cost (${periodShort})`,
      subtitle: 'All subscriptions combined',
      icon: IndianRupee, accent: 'blue',
      value: full(costData?.total_6m),
      exact: exact(costData?.total_6m),
      footnote: `${costData?.months?.length || 0} months of data`,
      panelTitle: 'Total Azure Spend',
      rows: (costData?.months || []).map(m => ({ label: m.month, value: fmt(m.total_cost) })),
      stats: [
        { label: 'Total', value: full(costData?.total_6m) },
        { label: 'Monthly average', value: full(avgMonthly) },
        { label: 'Highest month', value: full(Math.max(0, ...(costData?.months || []).map(m => m.total_cost))) },
        { label: 'Services tracked', value: costData?.top_services?.length ?? 0 },
      ],
    },
    month: {
      // Named for what it is. `months.at(-1)` is the newest month in the
      // selected range, which is only "this month" when the range happens to
      // run to today and Cost Management has already reported it.
      title: 'Latest Month',
      subtitle: !latest
        ? 'Not loaded yet'
        : previous
          ? `${latest.month} vs ${previous.month}`
          : `${latest.month} · nothing earlier to compare`,
      // A neutral icon when there is no comparison. Falling back to
      // TrendingDown made an empty dashboard show a downward arrow, which
      // reads as "your costs went down" when nothing has been measured at all.
      icon: mom == null ? CalendarDays : (mom > 0 ? TrendingUp : TrendingDown),
      accent: 'violet',
      value: full(latest?.total_cost),
      exact: exact(latest?.total_cost),
      momChange: mom,
      footnote: latestIsPartial
        ? 'Still being billed — a partial month always looks low beside a full one'
        : undefined,
      panelTitle: 'Latest Month Spend',
      rows: Object.entries(latest?.by_service || {})
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => ({ label: k, value: fmt(v) })),
      stats: [
        { label: 'Month', value: latest?.month ?? '—' },
        { label: 'Total', value: full(latest?.total_cost) },
        { label: 'vs previous month', value: mom == null ? '—' : `${mom > 0 ? '+' : ''}${mom.toFixed(1)}%` },
        { label: 'Compared against', value: previous?.month ?? '—' },
      ],
    },
    burn: {
      title: 'Daily Burn Rate',
      subtitle: 'Avg spend per day',
      icon: Flame, accent: 'rose',
      value: full(dailyBurn),
      exact: exact(dailyBurn),
      footnote: 'Based on current month pace',
      panelTitle: 'Daily Burn Rate',
      rows: (costData?.months || []).map(m => ({ label: m.month, value: `${fmt(m.total_cost / 30)} / day` })),
      stats: [
        { label: 'Per day', value: full(dailyBurn) },
        { label: 'Per week', value: full(dailyBurn ? dailyBurn * 7 : null) },
        { label: 'Projected month', value: full(dailyBurn ? dailyBurn * 30 : null) },
        { label: 'Projected year', value: full(dailyBurn ? dailyBurn * 365 : null) },
      ],
    },
    avg: {
      title: 'Monthly Average',
      subtitle: isCustom ? 'Average per month in range' : `${months}-month average`,
      icon: BarChart2, accent: 'emerald',
      value: full(avgMonthly),
      exact: exact(avgMonthly),
      panelTitle: 'Monthly Average Spend',
      rows: (costData?.months || []).map(m => ({
        label: m.month,
        value: `${fmt(m.total_cost)} · ${avgMonthly ? ((m.total_cost / avgMonthly - 1) * 100).toFixed(1) : 0}% vs avg`,
      })),
      stats: [
        { label: 'Average', value: full(avgMonthly) },
        { label: 'Months', value: costData?.months?.length ?? 0 },
        { label: 'Lowest month', value: full(Math.min(...(costData?.months || [{ total_cost: 0 }]).map(m => m.total_cost))) },
        { label: 'Highest month', value: full(Math.max(0, ...(costData?.months || []).map(m => m.total_cost))) },
      ],
    },
    spikes: {
      title: 'Cost Spikes',
      subtitle: 'Services with >20% increase',
      icon: AlertTriangle, accent: 'amber',
      value: anomalyCount ?? '—',
      footnote: anomalyCount == null
        ? 'Nothing loaded yet'
        : 'Click to inspect each spike',
      panelTitle: 'Detected Cost Spikes',
      rows: (costData?.anomalies || []).map(a => ({
        label: `${a.service} · ${a.month}`,
        value: `${a.pct_change > 0 ? '▲' : '▼'} ${Math.abs(a.pct_change).toFixed(1)}%`,
      })),
      stats: [
        { label: 'Spikes found', value: anomalyCount ?? '—' },
        { label: 'Threshold', value: '> 20% MoM' },
      ],
    },
    savings: {
      title: 'Savings Identified',
      subtitle: 'Optimization opportunities',
      icon: PiggyBank, accent: 'emerald',
      value: full(savingsTotal),
      exact: exact(savingsTotal),
      panelTitle: 'Savings Opportunities',
      rows: (costData?.savings || []).map(s => ({
        label: `${s.service} · ${s.month}`,
        value: fmt(s.saved_amount),
      })),
      stats: [
        { label: 'Total saved', value: full(savingsTotal) },
        { label: 'Opportunities', value: costData?.savings?.length ?? 0 },
      ],
    },
  }), [costData, latest, previous, latestIsPartial, mom, avgMonthly, dailyBurn, anomalyCount, savingsTotal, months, currency, periodShort, isCustom]);

  /** Drill-downs for the bandwidth tiles (rendered in their own section). */
  const BW_HEROES = useMemo(() => {
    const bwFmt  = (v) => formatAmount(v, bwCurrency);
    const bwFull = (v) => formatAmountFull(v, bwCurrency);

    const directional = (key, label) => {
      const bytes = key === 'bw_total' ? bwTotal : bw?.[`${key.replace('bw_', '')}_bytes`];
      const cost  = key === 'bw_total' ? bw?.total_cost : bw?.[`${key.replace('bw_', '')}_cost`];
      const monthKey = key === 'bw_total' ? 'total_bytes' : `${key.replace('bw_', '')}_bytes`;
      return {
        panelTitle: label,
        stats: [
          { label: 'Volume', value: formatBytes(bytes), hint: formatGB(bytes) },
          { label: 'In TB', value: formatTB(bytes) },
          { label: 'Amount charged', value: bwFull(cost) },
          { label: 'Share of transfer', value: `${pctOf(bytes || 0, bwTotal).toFixed(1)}%` },
        ],
        rows: (bw?.months || []).map(m => ({
          label: m.month,
          value: `${formatBytes(m[monthKey])} · ${bwFmt(m.cost)}`,
        })),
      };
    };

    return {
      bw_total:   directional('bw_total', 'Total Data Transfer'),
      bw_egress:  directional('bw_egress', 'Egress · Data Out'),
      bw_ingress: directional('bw_ingress', 'Ingress · Data In'),
      bw_rate: {
        panelTitle: 'Effective Rate per GB',
        stats: [
          { label: 'Cost per GB', value: bwFull(bw?.cost_per_gb) },
          { label: 'Cost per TB', value: bwFull((bw?.cost_per_gb || 0) * 1024) },
          { label: 'Billed volume', value: formatBytes(bwTotal), hint: formatGB(bwTotal) },
          { label: 'Total charged', value: bwFull(bw?.total_cost) },
        ],
        rows: (bw?.meters || []).map(m => ({
          label: `${m.meter} · ${m.direction}`,
          value: `${formatBytes(m.bytes)} · ${bwFmt(m.cost)}`,
        })),
      },
    };
  }, [bw, bwTotal, bwCurrency]);

  const activeHero = detail ? (HEROES[detail] || BW_HEROES[detail]) : null;

  // Budget variance, shown only once at least one BOQ has been uploaded.
  const boqReport = useMemo(() => {
    const active = (boqs || []).filter(b => b.enabled !== false);
    if (!active.length || !costData?.months?.length) return null;
    const rows = costData.months.flatMap(m =>
      Object.entries(m.by_service || {}).map(([service, cost]) => ({ service, cost })),
    );
    return compareBoqToUsage(active, rows, costData.months.length, currency);
  }, [boqs, costData, currency]);

  return (
    <div className="p-6 space-y-6 max-w-screen-2xl mx-auto">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">Dashboard</h1>
          <p className="text-slate-400 text-sm mt-1">
            Azure cost overview · {periodLong}
            {selectedSubscriptionIds.length > 0 &&
              ` · ${selectedSubscriptionIds.length} subscription${selectedSubscriptionIds.length > 1 ? 's' : ''}`}
            <span className="ml-2 text-xs text-slate-600">· {currency}</span>
          </p>
        </div>
      </div>

      {/* What these figures cover. A partial total looks identical to a
          complete one, so the difference is stated next to them. */}
      <DataQuality coverage={costData?.coverage} />

      {!selectedTenantId && !imported && (
        <div className="bg-blue-950/40 border border-blue-500/30 rounded-2xl p-6 text-center">
          <p className="text-blue-300 font-medium">No tenant selected</p>
          <p className="text-slate-400 text-sm mt-1">Add a tenant from Settings to get started, or import a cost file.</p>
        </div>
      )}

      {boqReport && <BoqVarianceBanner report={boqReport} onOpen={() => navigate('/boq')} />}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {Object.entries(HEROES).map(([key, h]) => (
          <HeroCard
            key={key}
            title={h.title}
            subtitle={h.subtitle}
            icon={h.icon}
            accent={h.accent}
            value={h.value}
            exact={h.exact}
            unit={h.unit}
            footnote={h.footnote}
            momChange={h.momChange}
            loading={costLoading}
            active={detail === key}
            onClick={() => setDetail(key)}
          />
        ))}
      </div>

      {/* ── Reserved vs pay-as-you-go ────────────────────────────────── */}
      {/* The detail panel must query the same window the totals came from,
          or the drill-down disagrees with the card above it. */}
      <PricingSection
        data={pricingData}
        loading={pricingLoading}
        error={pricingError}
        request={
          selectedTenantId && selectedSubscriptionIds.length
            ? {
                tenant_id: selectedTenantId,
                subscription_ids: selectedSubscriptionIds,
                months,
                ...(isCustom ? { from_date: fromDate, to_date: toDate } : {}),
              }
            : null
        }
      />

      {/* ── Bandwidth hero section ───────────────────────────────────── */}
      <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-5 space-y-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-sm font-semibold text-slate-300 flex items-center gap-2">
              <Network className="w-4 h-4 text-blue-400" /> Bandwidth &amp; Data Transfer
            </h2>
            <p className="text-xs text-slate-500 mt-1">
              Egress / ingress volume in GB &amp; TB with the amount charged
            </p>
          </div>
          <button
            onClick={() => navigate('/bandwidth')}
            className="text-xs text-blue-400 hover:text-blue-300 transition"
          >
            Open full report →
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          {[
            { key: 'bw_total',   title: 'Total Transfer', sub: 'All directions', icon: Network,         accent: 'blue',    bytes: bwTotal,           cost: bw?.total_cost },
            { key: 'bw_egress',  title: 'Egress · Out',   sub: 'Billable',       icon: ArrowUpFromLine, accent: 'rose',    bytes: bw?.egress_bytes,  cost: bw?.egress_cost },
            { key: 'bw_ingress', title: 'Ingress · In',   sub: 'Usually free',   icon: ArrowDownToLine, accent: 'emerald', bytes: bw?.ingress_bytes, cost: bw?.ingress_cost },
            { key: 'bw_rate',    title: 'Cost per GB',    sub: 'Blended rate',   icon: BarChart2,       accent: 'amber',   rate: true },
          ].map(item => {
            const { value, unit } = splitBytes(item.bytes ?? null);
            return (
              <HeroCard
                key={item.key}
                title={item.title}
                subtitle={item.sub}
                icon={item.icon}
                accent={item.accent}
                loading={bwLoading}
                value={item.rate ? formatAmountFull(bw?.cost_per_gb, bwCurrency) : value}
                unit={item.rate ? '/ GB' : unit}
                amount={item.rate
                  ? `${formatAmount((bw?.cost_per_gb || 0) * 1024, bwCurrency)} / TB`
                  : formatAmount(item.cost, bwCurrency)}
                sharePct={item.rate ? undefined : pctOf(item.bytes || 0, bwTotal)}
                momChange={item.key === 'bw_total' ? bw?.mom_change_pct : undefined}
                footnote={item.rate ? `${toGB(bwTotal).toFixed(1)} GB billed` : formatGB(item.bytes)}
                active={detail === item.key}
                onClick={() => setDetail(item.key)}
              />
            );
          })}
        </div>

        {!bwLoading && bwTotal > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-1">
            <MiniStat label="Total in TB"   value={formatTB(bwTotal)} />
            <MiniStat label="Egress in TB"  value={formatTB(bw?.egress_bytes)} />
            <MiniStat label="Ingress in TB" value={formatTB(bw?.ingress_bytes)} />
            <MiniStat label="Exact size"    value={formatBytes(bwTotal)} />
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <div className="xl:col-span-2 bg-slate-900 border border-slate-800 rounded-2xl p-5">
          <h2 className="text-sm font-semibold text-slate-300 mb-1">Cost Trend</h2>
          <p className="text-xs text-slate-500 mb-4">Monthly spend across all subscriptions</p>
          <CostTrendChart months={costData?.months || []} loading={costLoading} currency={currency} />
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
          <h2 className="text-sm font-semibold text-slate-300 mb-1">Service Distribution</h2>
          <p className="text-xs text-slate-500 mb-4">Which service costs the most</p>
          <ServicePieChart topServices={costData?.top_services || []} loading={costLoading} />
        </div>
      </div>

      {costData?.months?.length > 0 && (() => {
        const subTotals = {};
        costData.months.forEach(m => {
          Object.entries(m.by_subscription || {}).forEach(([subId, cost]) => {
            subTotals[subId] = (subTotals[subId] || 0) + cost;
          });
        });
        const entries = Object.entries(subTotals).sort((a, b) => b[1] - a[1]);
        if (!entries.length) return null;
        const lastMonth = latest?.by_subscription || {};
        const prevMonth = previous?.by_subscription || {};
        // Only claim a month-over-month move when there is a previous month to
        // move from. A subscription that first appears this month has no
        // change; showing +100% would invent a trend out of a single point.
        const changeFor = (id) => {
          const now = lastMonth[id];
          const before = prevMonth[id];
          if (typeof now !== 'number' || typeof before !== 'number' || before === 0) return null;
          return ((now - before) / before) * 100;
        };
        // Savings arrive from two slower endpoints. Until they land, the column
        // says so rather than showing a dash that reads as "nothing to save".
        const savingsPending = computeLoading || orphanedLoading;
        return (
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
            <div className="flex items-center justify-between gap-3 mb-1">
              <h2 className="text-sm font-semibold text-slate-300">Subscription Summary</h2>
              <span className="text-xs text-slate-500">
                {entries.length} of {subscriptions?.length || entries.length} subscriptions
              </span>
            </div>
            <p className="text-xs text-slate-500 mb-4">Spend per subscription over the {periodLong}</p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[46rem] text-sm">
                <thead>
                  <tr className="text-left text-slate-500 border-b border-slate-800">
                    <th className="pb-2 font-medium">Subscription</th>
                    <th className="pb-2 font-medium text-right">Total Cost</th>
                    <th className="pb-2 font-medium text-right">Share</th>
                    <th className="pb-2 font-medium text-right">Latest Month</th>
                    <th className="pb-2 font-medium text-right">Cost Change</th>
                    <th className="pb-2 font-medium text-right">Savings Potential</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map(([subId, cost]) => {
                    const name = subMap[subId] || subId;
                    const pct = costData.total_6m > 0 ? (cost / costData.total_6m * 100) : 0;
                    const change = changeFor(subId);
                    const saving = savingsBySub[subId];
                    return (
                      <tr key={subId} className="border-b border-slate-800/50 hover:bg-slate-800/30">
                        <td className="py-3 text-slate-200 max-w-[16rem] truncate" title={name}>{name}</td>
                        <td className="py-3 text-right text-white font-medium">
                          <Amount value={cost} currency={currency} />
                        </td>
                        <td className="py-3 text-right">
                          <div className="flex items-center justify-end gap-2">
                            <div className="w-16 bg-slate-700 rounded-full h-1.5">
                              <div className="bg-blue-500 h-1.5 rounded-full" style={{ width: `${pct}%` }} />
                            </div>
                            <span className="text-xs text-slate-400 tabular-nums w-10 text-right">
                              {pct.toFixed(1)}%
                            </span>
                          </div>
                        </td>
                        <td className="py-3 text-right text-slate-300">
                          {typeof lastMonth[subId] === 'number'
                            ? <Amount value={lastMonth[subId]} currency={currency} />
                            : <span className="text-slate-500">—</span>}
                        </td>
                        <td className="py-3 text-right">
                          {change == null ? <span className="text-slate-500">—</span> : (
                            <span className={`font-semibold ${change > 0 ? 'text-red-400' : 'text-emerald-400'}`}>
                              {change > 0 ? '▲' : '▼'} {Math.abs(change).toFixed(1)}%
                            </span>
                          )}
                        </td>
                        <td className="py-3 text-right">
                          {typeof saving === 'number'
                            ? <span className="text-emerald-400 font-medium">{fmt(saving)} /mo</span>
                            : <span className="text-slate-500 text-xs">
                                {savingsPending ? 'Checking…' : haveExtras ? 'Not available' : 'Not loaded'}
                              </span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-slate-600 mt-3">
              Savings potential is this subscription&rsquo;s share of the right-sizing and unused-resource
              findings. Azure does not report a resource count or a health score per subscription,
              so neither is shown.
            </p>
          </div>
        );
      })()}

      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
        <h2 className="text-sm font-semibold text-slate-300 mb-1">Top Services by Spend</h2>
        <p className="text-xs text-slate-500 mb-4">Highest-cost Azure services in the selected period</p>
        {costLoading ? (
          <div className="space-y-2">{[...Array(5)].map((_, i) => <div key={i} className="h-10 bg-slate-800 rounded-lg animate-pulse" />)}</div>
        ) : !costData?.top_services?.length ? (
          <p className="text-slate-500 text-sm text-center py-6">No data available</p>
        ) : (
          <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] text-sm">
            <thead>
              <tr className="text-left text-slate-500 border-b border-slate-800">
                <th className="pb-2 font-medium">#</th>
                <th className="pb-2 font-medium">Service</th>
                <th className="pb-2 font-medium text-right">Total Cost</th>
                <th className="pb-2 font-medium text-right">This Month</th>
                <th className="pb-2 font-medium text-right">MoM Change</th>
              </tr>
            </thead>
            <tbody>
              {costData.top_services.map((svc, i) => (
                <tr key={i} className="border-b border-slate-800/50 hover:bg-slate-800/30">
                  <td className="py-3 text-slate-500 text-xs">{i + 1}</td>
                  <td className="py-3 text-slate-200">{svc.service}</td>
                  <td className="py-3 text-right text-white font-medium"><Amount value={svc.total_cost} currency={currency} /></td>
                  <td className="py-3 text-right text-slate-300"><Amount value={svc.latest_month_cost} currency={currency} /></td>
                  <td className="py-3 text-right">
                    {svc.mom_change_pct == null ? <span className="text-slate-500">—</span> : (
                      <span className={`font-semibold ${svc.mom_change_pct > 0 ? 'text-red-400' : 'text-emerald-400'}`}>
                        {svc.mom_change_pct > 0 ? '▲' : '▼'} {Math.abs(svc.mom_change_pct).toFixed(1)}%
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>

      {costData?.anomalies?.length > 0 && (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-sm font-semibold text-slate-300">Recent Cost Spikes</h2>
            <a href="/anomalies" className="text-xs text-blue-400 hover:text-blue-300">View all →</a>
          </div>
          <p className="text-xs text-slate-500 mb-4">Services where cost increased significantly</p>
          <div className="space-y-3">
            {costData.anomalies.slice(0, 3).map((a, i) => (
              <AnomalyCard key={i} anomaly={a} subMap={subMap} currency={currency} />
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
          <div className="flex items-center justify-between gap-3 mb-1">
            <h2 className="text-sm font-semibold text-slate-300">Savings Opportunities</h2>
            <button
              type="button"
              onClick={() => navigate('/compute')}
              className="text-xs text-blue-400 hover:text-blue-300"
            >
              View all →
            </button>
          </div>
          <p className="text-xs text-slate-500 mb-4">
            Right-sizing findings and resources nothing is attached to
          </p>
          {(computeLoading || orphanedLoading) && !savingsGroups.length ? (
            <div className="space-y-2">
              {[...Array(3)].map((_, i) => <div key={i} className="h-14 bg-slate-800 rounded-xl animate-pulse" />)}
            </div>
          ) : !haveExtras ? (
            <NotLoadedYet
              onLoad={loadExtras}
              busy={loadingExtras}
              label="Find savings"
              note="Reads your VMs' utilization and looks for unattached resources. Several Azure queries, so it is not run automatically."
            />
          ) : !savingsGroups.length ? (
            <p className="text-slate-500 text-sm text-center py-6">
              Nothing found to reclaim in the selected subscriptions.
            </p>
          ) : (
            <div className="space-y-2">
              {savingsGroups.slice(0, 5).map(g => (
                <button
                  key={g.key}
                  type="button"
                  onClick={() => navigate(g.to)}
                  className="w-full flex items-center justify-between gap-3 bg-slate-800/40 hover:bg-slate-800/70 border border-slate-700/40 rounded-xl px-4 py-3 text-left transition"
                >
                  <span className="min-w-0">
                    <span className="block text-sm text-slate-200 truncate">{g.title}</span>
                    <span className="block text-xs text-slate-500 truncate">
                      {g.detail}
                      {g.unpriced > 0 && ` · ${g.unpriced} without a published price`}
                    </span>
                  </span>
                  <span className="shrink-0 text-sm font-semibold">
                    {g.monthly == null
                      ? <span className="text-slate-500 text-xs">Not available</span>
                      : <span className="text-emerald-400">{fmt(g.monthly)} /mo</span>}
                  </span>
                </button>
              ))}
            </div>
          )}
          <p className="text-[11px] text-slate-600 mt-3">
            Right-sizing figures are modelled from 30 days of telemetry. Unused-resource figures
            are what Azure already billed. They are listed separately rather than added up.
          </p>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
          <div className="flex items-center justify-between gap-3 mb-1">
            <h2 className="text-sm font-semibold text-slate-300">Recent Activity</h2>
            <button
              type="button"
              onClick={() => navigate('/activity')}
              className="text-xs text-blue-400 hover:text-blue-300"
            >
              View all →
            </button>
          </div>
          <p className="text-xs text-slate-500 mb-4">Changes made in the last 7 days, from the Activity Log</p>
          {activityLoading && !activityData ? (
            <div className="space-y-2">
              {[...Array(4)].map((_, i) => <div key={i} className="h-12 bg-slate-800 rounded-xl animate-pulse" />)}
            </div>
          ) : activityError ? (
            // Named rather than left blank. An empty feed and a refused read
            // look identical, and only one of them means the estate is quiet.
            <p className="text-slate-500 text-sm py-6">
              The Activity Log could not be read. {activityError}
            </p>
          ) : !activityData?.events?.length ? (
            activityData ? (
              <p className="text-slate-500 text-sm text-center py-6">
                No changes recorded in this window.
              </p>
            ) : (
              <NotLoadedYet
                onLoad={loadExtras}
                busy={loadingExtras}
                label="Load recent activity"
                note="Reads the Activity Log for each selected subscription."
              />
            )
          ) : (
            <ul className="space-y-1">
              {activityData.events.slice(0, 6).map(ev => (
                <li key={ev.id} className="flex items-start gap-3 px-2 py-2.5 rounded-lg hover:bg-slate-800/40">
                  <span
                    className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                      ev.succeeded ? 'bg-emerald-400' : 'bg-red-400'
                    }`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-slate-200 truncate">
                      {ev.summary || ev.operation}
                    </span>
                    <span className="block text-xs text-slate-500 truncate">
                      {resourceName(ev.resource_id) || ev.resource_group || '—'}
                      {ev.caller && ` · ${ev.caller}`}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-slate-500">{relativeTime(ev.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <PortalGuide {...COST_GUIDE} />

      <DetailPanel
        open={!!activeHero}
        onClose={() => setDetail(null)}
        title={activeHero?.panelTitle || ''}
        subtitle={`Last ${months} months · ${selectedSubscriptionIds.length} subscription(s) · ${currency}`}
      >
        {activeHero && (
          <>
            <div className="grid grid-cols-2 gap-3">
              {activeHero.stats.map(s => (
                <DetailStat key={s.label} label={s.label} value={s.value} hint={s.hint} />
              ))}
            </div>
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-3">Breakdown</h3>
              {activeHero.rows.length === 0 ? (
                <p className="text-slate-500 text-sm text-center py-6">No data available</p>
              ) : (
                <div className="space-y-2">
                  {activeHero.rows.map((r, i) => (
                    <div key={`${r.label}-${i}`} className="flex items-center justify-between gap-3 bg-slate-800/40 rounded-xl px-4 py-3">
                      <span className="text-sm text-slate-300 truncate">{r.label}</span>
                      <span className="text-sm text-white font-medium shrink-0">{r.value}</span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </DetailPanel>
    </div>
  );
}

/** Last segment of an Azure resource id, which is the part a person recognises. */
function resourceName(resourceId) {
  if (!resourceId) return '';
  const parts = String(resourceId).split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

/**
 * "2h ago" from an ISO timestamp.
 *
 * Returns the raw string when it cannot be parsed rather than the usual
 * "Invalid Date", and never rounds up past the window: anything a week or
 * older is shown as a date, because "8d ago" is harder to place than 21 Aug.
 */
function relativeTime(iso) {
  if (!iso) return '';
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return String(iso);
  const seconds = Math.round((Date.now() - then.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return then.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/**
 * A panel that has not been fetched, saying so and offering to fetch it.
 *
 * Deliberately not an empty state. "Nothing found" and "never looked" are
 * different answers, and only one of them means the estate is clean.
 */
function NotLoadedYet({ onLoad, busy, label, note }) {
  return (
    <div className="text-center py-6">
      <button
        type="button"
        onClick={onLoad}
        disabled={busy}
        className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-60 text-white text-sm font-medium transition"
      >
        {busy ? 'Reading Azure…' : label}
      </button>
      <p className="text-xs text-slate-500 mt-3 max-w-sm mx-auto">{note}</p>
    </div>
  );
}

function MiniStat({ label, value }) {
  return (
    <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl px-3 py-2.5">
      <p className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">{label}</p>
      <p className="text-sm font-bold text-white mt-0.5">{value}</p>
    </div>
  );
}

/** Headline answer to "what am I paying above the BOQ?" with the worst offenders. */
function BoqVarianceBanner({ report, onOpen }) {
  const fmt = (v) => formatAmount(v, report.currency);
  const over = report.categories.filter(c => c.variance > 0).slice(0, 4);
  const overBudget = report.variance > 0;

  return (
    <div
      onClick={onOpen}
      className={`rounded-2xl border p-5 cursor-pointer transition ${
        overBudget
          ? 'border-red-500/30 bg-red-500/[0.07] hover:bg-red-500/[0.11]'
          : 'border-emerald-500/30 bg-emerald-500/[0.07] hover:bg-emerald-500/[0.11]'
      }`}
    >
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-start gap-3">
          {overBudget
            ? <AlertTriangle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
            : <PiggyBank className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />}
          <div>
            <p className="text-sm font-semibold text-white">
              {overBudget
                ? `${fmt(report.extraTotal)} per month is being charged above your BOQ`
                : `You are ${fmt(Math.abs(report.variance))} per month under your BOQ`}
            </p>
            <p className="text-xs text-slate-400 mt-0.5">
              Budget {fmt(report.budgetTotal)} · actual {fmt(report.actualTotal)}
              {report.variancePct != null && ` · ${report.variancePct >= 0 ? '+' : ''}${report.variancePct}%`}
              {report.months > 1 && ` · monthly average of ${report.months} months`}
            </p>
          </div>
        </div>
        <span className="text-xs text-slate-400 underline underline-offset-2">See full comparison →</span>
      </div>

      {over.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 mt-4">
          {over.map(c => (
            <div
              key={c.key}
              className={`rounded-xl px-3 py-2.5 border ${
                c.unbudgeted
                  ? 'bg-red-500/15 border-red-500/40'
                  : 'bg-amber-500/10 border-amber-500/30'
              }`}
            >
              <p className="text-[10px] uppercase tracking-wide text-slate-400 font-semibold truncate">
                {c.label}
              </p>
              <p className="text-sm font-bold text-white mt-0.5">+{fmt(c.variance)}</p>
              <p className={`text-[10px] mt-0.5 ${c.unbudgeted ? 'text-red-300' : 'text-amber-300'}`}>
                {c.unbudgeted ? 'not in BOQ' : `${c.variancePct >= 999 ? '999+' : c.variancePct}% over budget`}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

