import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { IndianRupee, TrendingUp, TrendingDown, AlertTriangle, PiggyBank, BarChart2, Flame, Network, ArrowUpFromLine, ArrowDownToLine } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import HeroCard from '../components/Cards/HeroCard';
import PricingSection from '../components/Cards/PricingSection';
import DetailPanel, { DetailStat } from '../components/Common/DetailPanel';
import PortalGuide, { COST_GUIDE } from '../components/Common/PortalGuide';
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
    imported, boqs,
  } = useAppStore();

  const navigate = useNavigate();
  const [detail, setDetail] = useState(null);

  useEffect(() => {
    if (imported || (selectedTenantId && selectedSubscriptionIds.length > 0)) {
      loadCosts();
      loadBandwidth();
      loadPricing();
    }
  }, [imported, selectedTenantId, selectedSubscriptionIds.join(','), dateKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const latest        = costData?.months?.at(-1);
  const mom           = costData?.mom_change_pct;
  const anomalyCount  = costData?.anomalies?.length || 0;
  const savingsTotal  = costData?.savings?.reduce((acc, s) => acc + s.saved_amount, 0) || 0;
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
      title: 'This Month',
      subtitle: mom != null ? (mom > 0 ? 'vs last month ↑' : 'vs last month ↓') : 'vs previous month',
      icon: mom != null && mom > 0 ? TrendingUp : TrendingDown, accent: 'violet',
      value: full(latest?.total_cost),
      exact: exact(latest?.total_cost),
      momChange: mom,
      panelTitle: 'Current Month Spend',
      rows: Object.entries(latest?.by_service || {})
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => ({ label: k, value: fmt(v) })),
      stats: [
        { label: 'Month', value: latest?.month ?? '—' },
        { label: 'Total', value: full(latest?.total_cost) },
        { label: 'MoM change', value: mom == null ? '—' : `${mom.toFixed(1)}%` },
        { label: 'Daily burn', value: full(dailyBurn) },
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
      value: anomalyCount,
      footnote: 'Click to inspect each spike',
      panelTitle: 'Detected Cost Spikes',
      rows: (costData?.anomalies || []).map(a => ({
        label: `${a.service} · ${a.month}`,
        value: `${a.pct_change > 0 ? '▲' : '▼'} ${Math.abs(a.pct_change).toFixed(1)}%`,
      })),
      stats: [
        { label: 'Spikes found', value: anomalyCount },
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
  }), [costData, latest, mom, avgMonthly, dailyBurn, anomalyCount, savingsTotal, months, currency, periodShort, isCustom]);

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
        return (
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
            <h2 className="text-sm font-semibold text-slate-300 mb-1">Cost by Subscription</h2>
            <p className="text-xs text-slate-500 mb-4">Total spend per subscription over the {periodLong}</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {entries.map(([subId, cost]) => {
                const name = subMap[subId] || subId;
                const pct  = costData.total_6m > 0 ? (cost / costData.total_6m * 100).toFixed(1) : 0;
                return (
                  <div key={subId} className="bg-slate-800/50 rounded-xl p-4 border border-slate-700/50">
                    <p className="text-xs text-slate-400 truncate mb-2" title={name}>{name}</p>
                    <p className="text-xl font-bold text-white">{fmt(cost)}</p>
                    <div className="mt-2 flex items-center gap-2">
                      <div className="flex-1 bg-slate-700 rounded-full h-1.5">
                        <div className="bg-blue-500 h-1.5 rounded-full" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="text-xs text-slate-400">{pct}%</span>
                    </div>
                  </div>
                );
              })}
            </div>
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
          <table className="w-full text-sm">
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

