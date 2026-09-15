import { useEffect, useMemo, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import {
  ArrowDownToLine, ArrowUpFromLine, Gauge, Network, Repeat, Layers,
} from 'lucide-react';
import {
  Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { useAppStore } from '../store/useAppStore';
import { useChartTheme } from '../store/useTheme';
import HeroCard from '../components/Cards/HeroCard';
import DetailPanel, { DetailStat } from '../components/Common/DetailPanel';
import PortalGuide from '../components/Common/PortalGuide';
import { BANDWIDTH_GUIDE } from '../components/Common/portalGuides';
import UnitRatePanel from '../components/Common/UnitRatePanel';
import { MeterTable, SubscriptionBandwidthTable } from '../components/Common/BandwidthTables';
import { formatAmount, formatAmountFull, formatRate } from '../utils/currency';
import { subscriptionLabel, subscriptionNameMap } from '../utils/identity';
import { formatBytes, formatGB, formatTB, pctOf, splitBytes, toGB } from '../utils/bytes';

const DIRECTION_LABEL = {
  egress: 'Egress (data out)',
  ingress: 'Ingress (data in)',
  intra: 'Intra-region / zone',
  other: 'Other transfer',
};

/**
 * Data transfer volumes, directions and meters.
 *
 * `embedded` renders it inside the Cost Explorer's Bandwidth tab, which owns
 * the page heading and padding and already shows the charge behind these
 * volumes underneath. Standalone, it keeps its own title and links across.
 */
export default function Bandwidth({ embedded = false }) {
  const navigate = useNavigate();
  const {
    bandwidthData: bw, bandwidthLoading: pending, bandwidthError: error, loadBandwidth,
    selectedTenantId, selectedSubscriptionIds, months, subscriptions, imported, dateKey,
    dateMode, fromDate, toDate,
  } = useAppStore();
  const loading = pending && !bw;

  const periodLong = dateMode === 'custom' && fromDate && toDate
    ? `${fromDate} → ${toDate}`
    : `last ${months} months`;

  const [detail, setDetail] = useState(null); // 'total' | 'egress' | 'ingress' | 'intra'
  // The meter whose unit rate is being explained, shaped for UnitRatePanel.
  const [rateItem, setRateItem] = useState(null);
  const t = useChartTheme();

  useEffect(() => {
    // The embedded tab's cost panel owns this request; two owners reset the
    // same loading state and can duplicate partial-response retry loops.
    if (!embedded && (imported || (selectedTenantId && selectedSubscriptionIds.length > 0))) loadBandwidth();
  }, [embedded, imported, selectedTenantId, selectedSubscriptionIds.join(','), dateKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const currency = bw?.currency || 'INR';
  const money    = (v) => formatAmount(v, currency);
  const total    = bw?.total_bytes || 0;
  const subMap   = subscriptionNameMap(subscriptions || []);

  const chartData = useMemo(() => (bw?.months || []).map(m => ({
    month: m.month,
    Egress: +toGB(m.egress_bytes).toFixed(2),
    Ingress: +toGB(m.ingress_bytes).toFixed(2),
    Intra: +toGB(m.intra_bytes).toFixed(2),
    Other: +toGB(m.other_bytes).toFixed(2),
    cost: m.cost,
  })), [bw]);

  const metersFor = (direction) =>
    (bw?.meters || []).filter(m => direction === 'total' || m.direction === direction);

  /**
   * Reshape a bandwidth meter into what UnitRatePanel asks for.
   *
   * The panel was written against cost-comparison rows, but the question it
   * answers — is this rate what Microsoft publishes? — is the same one a
   * bandwidth meter raises, so it is reused rather than reimplemented.
   *
   * Two fields need care. `region` comes from the meter's own locations and is
   * only sent when there is exactly one: a meter spanning several regions has no
   * single published price, and guessing one would produce a confident
   * comparison against the wrong number. `prev_rate` is taken from the previous
   * month only when this meter actually has two months of history.
   */
  const openRate = (meter) => {
    const history = meter.months || [];
    const previous = history.length >= 2 ? history[history.length - 2] : null;
    const previousRate = previous?.quantity ? previous.cost / previous.quantity : null;
    const onlyRegion = meter.regions?.length === 1 ? meter.regions[0] : '';

    setRateItem({
      key: meter.meter,
      label: meter.meter,
      service: meter.category || 'Bandwidth',
      meter: meter.meter,
      sku: '',
      region: onlyRegion,
      unit: meter.unit || '',
      curr_rate: meter.unit_rate ?? null,
      prev_rate: previousRate,
    });
  };

  const rateMonths = bw?.months || [];
  const ratePrevMonth = rateMonths.length >= 2 ? rateMonths[rateMonths.length - 2].month : '';
  const rateCurrMonth = rateMonths.length ? rateMonths[rateMonths.length - 1].month : '';

  const hero = (key, extra) => {
    const bytes = key === 'total' ? total : bw?.[`${key}_bytes`];
    const cost  = key === 'total' ? bw?.total_cost : bw?.[`${key}_cost`];
    const { value, unit } = splitBytes(bytes ?? null);
    return {
      value, unit,
      amount: money(cost),
      sharePct: pctOf(bytes || 0, total),
      onClick: () => setDetail(key),
      active: detail === key,
      loading,
      ...extra,
    };
  };

  return (
    <div className={embedded ? 'space-y-6' : 'p-6 space-y-6 max-w-screen-2xl mx-auto'}>
      {!embedded && (
        <div>
          <h1 className="text-2xl font-bold text-white">Bandwidth &amp; Data Transfer</h1>
          <p className="text-slate-400 text-sm mt-1">
            Egress / ingress volumes in GB &amp; TB with the amount charged · {periodLong}
            <span className="ml-2 text-xs text-slate-600">· {currency}</span>
          </p>
        </div>
      )}
      {embedded && (
        <p className="text-xs text-slate-500">
          Data transfer volumes by direction · {periodLong} · {currency}. Uses the header selection;
          the filters above apply to the other tabs.
        </p>
      )}

      {error && (
        <div className="bg-red-950/40 border border-red-500/30 rounded-2xl p-4">
          <p className="text-sm font-semibold text-red-300">Could not load bandwidth data</p>
          <p className="text-sm text-red-200/80 mt-1">{String(error)}</p>
          <button
            onClick={loadBandwidth}
            className="mt-3 text-xs px-3 py-1.5 rounded-lg border border-red-500/40 text-red-200 hover:bg-red-500/10 transition"
          >Try again</button>
        </div>
      )}

      {!error && !!bw?.errors?.length && (
        <div className="bg-amber-950/30 border border-amber-500/30 rounded-2xl p-4">
          <p className="text-sm font-semibold text-amber-300">
            Partial data — {bw.errors.length} subscription(s) could not be read
          </p>
          <p className="text-sm text-amber-200/80 mt-1">
            The totals below exclude them. {bw.errors[0].error}
          </p>
        </div>
      )}

      {!loading && bw && total === 0 && (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 text-center">
          <p className="text-slate-300 font-medium">No data-transfer usage found</p>
          <p className="text-slate-500 text-sm mt-1">
            The selected subscriptions have no bandwidth meters in this period.
          </p>
        </div>
      )}

      {/* ── Hero section ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
        <HeroCard
          title="Total Data Transfer"
          subtitle="All directions combined"
          icon={Network}
          accent="blue"
          momChange={bw?.mom_change_pct}
          footnote={formatGB(total)}
          {...hero('total')}
        />
        <HeroCard
          title="Egress · Data Out"
          subtitle="Leaving Azure — billable"
          icon={ArrowUpFromLine}
          accent="rose"
          footnote={formatTB(bw?.egress_bytes)}
          {...hero('egress')}
        />
        <HeroCard
          title="Ingress · Data In"
          subtitle="Into Azure — usually free"
          icon={ArrowDownToLine}
          accent="emerald"
          footnote={formatTB(bw?.ingress_bytes)}
          {...hero('ingress')}
        />
        <HeroCard
          title="Intra-Region / Zone"
          subtitle="Between zones in a region"
          icon={Repeat}
          accent="violet"
          footnote={formatGB(bw?.intra_bytes)}
          {...hero('intra')}
        />
        <HeroCard
          title="Bandwidth Spend"
          subtitle={embedded ? 'Charged across all meters' : 'Open costs in Cost Explorer →'}
          icon={Layers}
          accent="amber"
          loading={loading}
          value={formatAmountFull(bw?.total_cost, currency)}
          amount={formatBytes(total)}
          footnote="Across all meters"
          onClick={embedded ? undefined : () => navigate('/explorer?tab=bandwidth')}
        />
        <HeroCard
          title="Effective Rate"
          subtitle={embedded ? 'Blended across transfer meters' : 'Open rates in Cost Explorer →'}
          icon={Gauge}
          accent="slate"
          loading={loading}
          value={formatRate(bw?.cost_per_gb, currency)}
          unit="/ GB"
          amount={bw?.cost_per_gb == null ? '—' : `${money(bw.cost_per_gb * 1024)} / TB`}
          footnote={`${(toGB(total)).toFixed(1)} GB billed`}
          onClick={embedded ? undefined : () => navigate('/explorer?tab=bandwidth')}
        />
      </div>

      {/* ── Trend ────────────────────────────────────────────────────── */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
        <h2 className="text-sm font-semibold text-slate-300 mb-1">Transfer Volume by Month</h2>
        <p className="text-xs text-slate-500 mb-4">Stacked GB per direction</p>
        {loading ? (
          <div className="h-72 bg-slate-800 rounded-xl animate-pulse" />
        ) : !chartData.length ? (
          <p className="text-slate-500 text-sm text-center py-10">No data available</p>
        ) : (
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke={t.grid} vertical={false} />
              <XAxis dataKey="month" stroke={t.axis} fontSize={12} tickLine={false} axisLine={false} dy={6} />
              <YAxis stroke={t.axis} fontSize={12} unit=" GB" tickLine={false} axisLine={false} width={78} />
              <Tooltip
                cursor={t.tooltipCursor}
                contentStyle={t.tooltip}
                labelStyle={t.tooltipLabel}
                formatter={(v, name) => [`${v.toLocaleString('en-IN')} GB`, name]}
              />
              <Legend wrapperStyle={{ fontSize: 12, color: t.axis }} />
              <Bar dataKey="Egress"  stackId="a" fill={t.isLight ? '#e11d48' : '#f43f5e'} />
              <Bar dataKey="Ingress" stackId="a" fill={t.isLight ? '#059669' : '#10b981'} />
              <Bar dataKey="Intra"   stackId="a" fill={t.isLight ? '#7c3aed' : '#8b5cf6'} />
              <Bar dataKey="Other"   stackId="a" fill={t.isLight ? '#94a3b8' : '#64748b'} radius={[6, 6, 0, 0]} maxBarSize={56} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* ── Per-subscription breakdown ───────────────────────────────── */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
        <div className="flex items-baseline justify-between gap-3 flex-wrap mb-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-300 mb-1">Bandwidth by Subscription</h2>
            <p className="text-xs text-slate-500">Volume and amount charged per subscription</p>
          </div>
          <span className="text-xs text-slate-500">
            {(bw?.by_subscription || []).length} subscription(s) with transfer
          </span>
        </div>
        <SubscriptionBandwidthTable
          rows={bw?.by_subscription}
          loading={loading}
          currency={currency}
          total={total}
          subMap={subMap}
        />
      </div>

      {/* ── Meter table ──────────────────────────────────────────────── */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
        <h2 className="text-sm font-semibold text-slate-300 mb-1">Data Transfer Meters</h2>
        <p className="text-xs text-slate-500 mb-4">
          Exact size and amount per Azure meter — click any row for the full breakdown
        </p>
        <MeterTable meters={bw?.meters} loading={loading} currency={currency} total={total} subMap={subMap} onRate={openRate} />
      </div>

      {/* ── Where the charge came from ───────────────────────────────── */}
      {!embedded && (
        <Link to="/explorer?tab=bandwidth" className="block text-sm text-blue-400 hover:underline">
          Open Bandwidth cost in Cost Explorer — monthly charges, effective rates and resource charge tracking →
        </Link>
      )}

      <PortalGuide {...BANDWIDTH_GUIDE} />

      {/* ── Detail slide-over ────────────────────────────────────────── */}
      <DetailPanel
        open={!!detail}
        onClose={() => setDetail(null)}
        title={
          detail === 'total' ? 'Total Data Transfer'
            : DIRECTION_LABEL[detail] || 'Details'
        }
        subtitle={`${periodLong} · ${selectedSubscriptionIds.length} subscription(s)`}
      >
        {detail && (
          <>
            <div className="grid grid-cols-2 gap-3">
                <>
                  <DetailStat
                    label="Volume"
                    value={formatBytes(detail === 'total' ? total : bw?.[`${detail}_bytes`])}
                    hint={formatGB(detail === 'total' ? total : bw?.[`${detail}_bytes`])}
                  />
                  <DetailStat
                    label="Amount"
                    value={formatAmountFull(detail === 'total' ? bw?.total_cost : bw?.[`${detail}_cost`], currency)}
                  />
                  <DetailStat
                    label="Share of transfer"
                    value={`${pctOf(detail === 'total' ? total : bw?.[`${detail}_bytes`] || 0, total).toFixed(1)}%`}
                  />
                  <DetailStat
                    label="In TB"
                    value={formatTB(detail === 'total' ? total : bw?.[`${detail}_bytes`])}
                  />
                </>
            </div>

            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-3">Monthly breakdown</h3>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-slate-500 border-b border-slate-800">
                    <th className="pb-2 font-medium">Month</th>
                    <th className="pb-2 font-medium text-right">Size</th>
                    <th className="pb-2 font-medium text-right">GB</th>
                    <th className="pb-2 font-medium text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {(bw?.months || []).map(m => {
                    const bytes = detail === 'total'
                      ? m.total_bytes : m[`${detail}_bytes`];
                    return (
                      <tr key={m.month} className="border-b border-slate-800/50">
                        <td className="py-2.5 text-slate-300">{m.month}</td>
                        <td className="py-2.5 text-right text-white font-medium">{formatBytes(bytes)}</td>
                        <td className="py-2.5 text-right text-slate-400 tabular-nums">{toGB(bytes).toFixed(2)}</td>
                        <td className="py-2.5 text-right text-slate-300">{money(m.cost)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>

            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-3">
                Contributing meters
              </h3>
              <MeterTable
                meters={metersFor(detail)}
                currency={currency}
                total={total}
                subMap={subMap}
                onRate={openRate}
                compact
              />
            </section>

            {!!bw?.by_subscription?.length && (
              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-3">By subscription</h3>
                <div className="space-y-2">
                  {bw.by_subscription.map(s => (
                    <div key={s.subscription_id} className="flex items-center justify-between gap-3 bg-slate-800/40 rounded-xl px-4 py-3">
                      <span className="text-sm text-slate-300 truncate" title={s.subscription_id}>{subscriptionLabel(s.subscription_id, subMap)}</span>
                      <span className="text-sm text-white font-medium shrink-0">
                        {formatBytes(s.bytes)} · {money(s.cost)}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </DetailPanel>

      {/* The same rate explanation the cost comparison uses — a bandwidth rate
          raises the identical question, so it gets the identical answer. */}
      <UnitRatePanel
        item={rateItem}
        currency={currency}
        prevMonth={ratePrevMonth}
        currMonth={rateCurrMonth}
        onClose={() => setRateItem(null)}
      />
    </div>
  );
}
