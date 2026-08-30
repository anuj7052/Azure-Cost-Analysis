import { useEffect, useMemo, useState, Fragment } from 'react';
import {
  ArrowDownToLine, ArrowUpFromLine, Gauge, Network, Repeat, Layers,
  ChevronDown, ChevronRight, Info,
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
import BandwidthTrackPanel from '../components/Common/BandwidthTrackPanel';
import ResourceCostTable from '../components/Common/ResourceCostTable';
import { useBandwidthTraffic, resourcesForMeter } from '../hooks/useBandwidthTraffic';
import { formatAmount, formatAmountFull, formatRate } from '../utils/currency';
import { formatQuantity } from '../utils/exact';
import { subscriptionLabel, subscriptionNameMap } from '../utils/identity';
import { Quantity } from '../components/Common/Amount';
import { GB, formatBytes, formatGB, formatTB, pctOf, splitBytes, toGB } from '../utils/bytes';

const DIRECTION_LABEL = {
  egress: 'Egress (data out)',
  ingress: 'Ingress (data in)',
  intra: 'Intra-region / zone',
  other: 'Other transfer',
};

export default function Bandwidth() {
  const {
    bandwidthData: bw, bandwidthLoading: loading, bandwidthError: error, loadBandwidth,
    selectedTenantId, selectedSubscriptionIds, months, subscriptions, imported, dateKey,
    dateMode, fromDate, toDate,
  } = useAppStore();

  const periodLong = dateMode === 'custom' && fromDate && toDate
    ? `${fromDate} → ${toDate}`
    : `last ${months} months`;

  const [detail, setDetail] = useState(null); // 'total' | 'egress' | 'ingress' | 'intra' | 'cost' | 'rate'
  // The meter whose unit rate is being explained, shaped for UnitRatePanel.
  const [rateItem, setRateItem] = useState(null);
  const t = useChartTheme();

  useEffect(() => {
    if (imported || (selectedTenantId && selectedSubscriptionIds.length > 0)) loadBandwidth();
  }, [imported, selectedTenantId, selectedSubscriptionIds.join(','), dateKey]); // eslint-disable-line react-hooks/exhaustive-deps

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
    <div className="p-6 space-y-6 max-w-screen-2xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold text-white">Bandwidth &amp; Data Transfer</h1>
        <p className="text-slate-400 text-sm mt-1">
          Egress / ingress volumes in GB &amp; TB with the amount charged · {periodLong}
          <span className="ml-2 text-xs text-slate-600">· {currency}</span>
        </p>
      </div>

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
          subtitle="Total charged for transfer"
          icon={Layers}
          accent="amber"
          loading={loading}
          value={formatAmountFull(bw?.total_cost, currency)}
          amount={formatBytes(total)}
          footnote="Across all meters"
          onClick={() => setDetail('cost')}
          active={detail === 'cost'}
        />
        <HeroCard
          title="Effective Rate"
          subtitle="Blended cost per GB"
          icon={Gauge}
          accent="slate"
          loading={loading}
          value={formatRate(bw?.cost_per_gb, currency)}
          unit="/ GB"
          amount={`${money((bw?.cost_per_gb || 0) * 1024)} / TB`}
          footnote={`${(toGB(total)).toFixed(1)} GB billed`}
          onClick={() => setDetail('rate')}
          active={detail === 'rate'}
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
      <BandwidthTrackPanel currency={currency} />

      <PortalGuide {...BANDWIDTH_GUIDE} />

      {/* ── Detail slide-over ────────────────────────────────────────── */}
      <DetailPanel
        open={!!detail}
        onClose={() => setDetail(null)}
        title={
          detail === 'cost' ? 'Bandwidth Spend'
            : detail === 'rate' ? 'Effective Rate per GB'
            : detail === 'total' ? 'Total Data Transfer'
            : DIRECTION_LABEL[detail] || 'Details'
        }
        subtitle={`Last ${months} months · ${selectedSubscriptionIds.length} subscription(s)`}
      >
        {detail && (
          <>
            <div className="grid grid-cols-2 gap-3">
              {detail === 'rate' ? (
                <>
                  <DetailStat label="Cost per GB" value={formatRate(bw?.cost_per_gb, currency)} />
                  <DetailStat label="Cost per TB" value={formatAmountFull((bw?.cost_per_gb || 0) * 1024, currency)} />
                  <DetailStat label="Billed volume" value={formatBytes(total)} hint={formatGB(total)} />
                  <DetailStat label="Total charged" value={formatAmountFull(bw?.total_cost, currency)} />
                </>
              ) : (
                <>
                  <DetailStat
                    label="Volume"
                    value={formatBytes(detail === 'cost' || detail === 'total' ? total : bw?.[`${detail}_bytes`])}
                    hint={formatGB(detail === 'cost' || detail === 'total' ? total : bw?.[`${detail}_bytes`])}
                  />
                  <DetailStat
                    label="Amount"
                    value={formatAmountFull(detail === 'cost' || detail === 'total' ? bw?.total_cost : bw?.[`${detail}_cost`], currency)}
                  />
                  <DetailStat
                    label="Share of transfer"
                    value={`${pctOf(detail === 'cost' || detail === 'total' ? total : bw?.[`${detail}_bytes`] || 0, total).toFixed(1)}%`}
                  />
                  <DetailStat
                    label="In TB"
                    value={formatTB(detail === 'cost' || detail === 'total' ? total : bw?.[`${detail}_bytes`])}
                  />
                </>
              )}
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
                    const bytes = detail === 'cost' || detail === 'total' || detail === 'rate'
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
                meters={metersFor(detail === 'cost' || detail === 'rate' ? 'total' : detail)}
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

function SubscriptionBandwidthTable({ rows, loading, currency, total, subMap }) {
  if (loading) {
    return <div className="space-y-2">{[...Array(4)].map((_, i) => <div key={i} className="h-11 bg-slate-800 rounded-lg animate-pulse" />)}</div>;
  }
  if (!rows?.length) {
    return <p className="text-slate-500 text-sm text-center py-6">No data-transfer usage for the selected subscriptions</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-slate-500 border-b border-slate-800">
            <th className="pb-2 font-medium">Subscription</th>
            <th className="pb-2 font-medium text-right">Total size</th>
            <th className="pb-2 font-medium text-right">Egress</th>
            <th className="pb-2 font-medium text-right">Ingress</th>
            <th className="pb-2 font-medium text-right">Share</th>
            <th className="pb-2 font-medium text-right">Rate / GB</th>
            <th className="pb-2 font-medium text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(s => (
            <tr key={s.subscription_id} className="border-b border-slate-800/50 hover:bg-slate-800/30">
              <td className="py-2.5 text-slate-200 max-w-[240px]">
                <span className="block truncate" title={s.subscription_id}>{subscriptionLabel(s.subscription_id, subMap)}</span>
                {s.top_meter && (
                  <span className="block text-[11px] text-slate-500 truncate">
                    top meter: {s.top_meter}
                    {s.meter_count > 1 && ` · ${s.meter_count} meters`}
                  </span>
                )}
              </td>
              <td className="py-2.5 text-right text-white font-medium">{formatBytes(s.bytes)}</td>
              <td className="py-2.5 text-right text-rose-300">
                {formatBytes(s.egress_bytes)}
                <span className="block text-[11px] text-slate-500">{formatAmount(s.egress_cost, currency)}</span>
              </td>
              <td className="py-2.5 text-right text-emerald-300">
                {formatBytes(s.ingress_bytes)}
                <span className="block text-[11px] text-slate-500">{formatAmount(s.ingress_cost, currency)}</span>
              </td>
              <td className="py-2.5 text-right text-slate-400">{pctOf(s.bytes, total).toFixed(1)}%</td>
              <td className="py-2.5 text-right text-slate-400 tabular-nums">
                {formatRate(s.cost_per_gb, currency)}
              </td>
              <td className="py-2.5 text-right text-white font-semibold">{formatAmount(s.cost, currency)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-slate-700">
            <td className="pt-3 text-slate-400 font-medium">Total</td>
            <td className="pt-3 text-right text-white font-semibold">{formatBytes(total)}</td>
            <td colSpan={4} />
            <td className="pt-3 text-right text-white font-semibold">
              {formatAmount(rows.reduce((sum, s) => sum + (s.cost || 0), 0), currency)}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function MeterTable({ meters, loading, currency, total, compact = false, subMap = {}, onRate }) {
  const [open, setOpen] = useState(() => new Set());
  const toggle = (key) => setOpen(prev => {
    const next = new Set(prev);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });

  if (loading) {
    return <div className="space-y-2">{[...Array(5)].map((_, i) => <div key={i} className="h-10 bg-slate-800 rounded-lg animate-pulse" />)}</div>;
  }
  if (!meters?.length) {
    return <p className="text-slate-500 text-sm text-center py-6">No meters in this category</p>;
  }
  const span = compact ? 4 : 7;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-slate-500 border-b border-slate-800">
            <th className="pb-2 font-medium">Meter</th>
            {!compact && <th className="pb-2 font-medium">Direction</th>}
            <th className="pb-2 font-medium text-right">Size</th>
            <th className="pb-2 font-medium text-right">GB</th>
            {!compact && <th className="pb-2 font-medium text-right">Share</th>}
            <th className="pb-2 font-medium text-right">Amount</th>
            {!compact && <th className="pb-2 w-8" />}
          </tr>
        </thead>
        <tbody>
          {meters.map((m, i) => {
            const key = `${m.meter}-${i}`;
            const expanded = open.has(key);
            const Chevron = expanded ? ChevronDown : ChevronRight;
            return (
              <Fragment key={key}>
                <tr
                  onClick={() => toggle(key)}
                  className="border-b border-slate-800/50 hover:bg-slate-800/30 cursor-pointer"
                >
                  <td className="py-2.5 text-slate-200">
                    {m.meter}
                    {!compact && <span className="block text-[11px] text-slate-500">{m.category}</span>}
                  </td>
                  {!compact && (
                    <td className="py-2.5">
                      <span className={`text-[11px] px-2 py-0.5 rounded-full border ${
                        m.direction === 'egress'  ? 'border-rose-500/40 text-rose-300' :
                        m.direction === 'ingress' ? 'border-emerald-500/40 text-emerald-300' :
                        m.direction === 'intra'   ? 'border-violet-500/40 text-violet-300' :
                                                    'border-slate-600 text-slate-400'
                      }`}>{m.direction}</span>
                    </td>
                  )}
                  <td className="py-2.5 text-right text-white font-medium">
                    {m.bytes
                      ? formatBytes(m.bytes)
                      : <Quantity value={m.quantity ?? 0} unit={m.unit} className="text-slate-500" />}
                  </td>
                  <td className="py-2.5 text-right text-slate-400 tabular-nums">
                    {m.bytes ? (m.bytes / GB).toFixed(2) : <span className="text-slate-600">—</span>}
                  </td>
                  {!compact && (
                    <td className="py-2.5 text-right text-slate-400">
                      {m.bytes ? `${pctOf(m.bytes, total).toFixed(1)}%` : <span className="text-slate-600">—</span>}
                    </td>
                  )}
                  <td className="py-2.5 text-right text-slate-200">{formatAmount(m.cost, currency)}</td>
                  {!compact && (
                    <td className="py-2.5 text-right">
                      <Chevron className="w-4 h-4 text-slate-500 inline" />
                    </td>
                  )}
                </tr>

                {expanded && (
                  <tr className="border-b border-slate-800 bg-slate-950/40">
                    <td colSpan={span} className="px-3 py-4">
                      <MeterDetail meter={m} currency={currency} total={total} subMap={subMap} onRate={onRate} />
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

const DIRECTION_HINT = {
  egress: 'Data leaving Azure for the internet or another region — this is what Azure charges for.',
  ingress: 'Data coming into Azure. Normally free, so any cost here is the service, not the transfer.',
  intra: 'Movement between availability zones inside one region, billed at a reduced rate.',
  other: 'A network charge that is not a simple in/out transfer — a gateway, firewall or processing fee.',
};

/** Everything known about one meter: what it is, and where the charge came from. */
function MeterResourceTrack({ meter, currency }) {
  const { ready, data, error, loading } = useBandwidthTraffic();
  const rows = resourcesForMeter(data, meter.meter);
  const tracked = rows.reduce((sum, r) => sum + r.cost, 0);

  return (
    <section>
      <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        Track data — which service was charged
      </h4>

      {!ready && (
        <p className="text-[11px] leading-relaxed text-slate-500">
          Select a tenant and subscription to trace this meter to the resources
          that produced it. Imported files carry no resource identity, so this
          detail can only come from a live Azure connection.
        </p>
      )}

      {loading && <div className="h-16 animate-pulse rounded-lg bg-slate-800/40" />}

      {error && <p className="text-[11px] leading-relaxed text-amber-400/80">{error}</p>}

      {data && (
        <>
          <ResourceCostTable
            rows={rows}
            currency={currency}
            dense
            emptyNote={
              data.level === 'group'
                ? 'Azure would not break this meter down past the resource group for this account, so no individual service can be named.'
                : 'Azure reported no per-resource split for this meter — it is billed at subscription level.'
            }
          />
          {rows.length > 0 && (
            <p className="mt-2 text-[10px] leading-relaxed text-slate-500">
              {rows.length} {rows.length === 1 ? 'resource' : 'resources'} account for{' '}
              {formatAmountFull(tracked, currency)} of this meter. Costs shown are
              this meter&apos;s share only, not each resource&apos;s total spend.
            </p>
          )}
        </>
      )}
    </section>
  );
}

function MeterDetail({ meter, currency, total, subMap, onRate }) {
  const money = (v) => formatAmount(v, currency);
  const gb = meter.bytes / GB;
  // Gateways and firewalls bill by the hour, so they have a cost but no volume.
  const volumeless = !meter.bytes;

  // The rate is cost divided by billed quantity. If both are on screen there is
  // always a rate, so falling back to "none could be derived" was simply wrong —
  // it hid a number the user could do on a calculator. `rateDerived` tracks
  // whether we did the division ourselves so the caption can say so.
  const rateDerived = meter.unit_rate == null && !!meter.quantity && meter.cost != null;
  const unitRate = meter.unit_rate ?? (rateDerived ? meter.cost / meter.quantity : null);

  // Cost per GB is only a separate fact when the meter is *not* already billed
  // per GB. Where it is, the two figures are identical by definition and only
  // one belongs on screen.
  const ratesMatch =
    unitRate != null &&
    meter.cost_per_gb != null &&
    Math.abs(unitRate - meter.cost_per_gb) < 0.00005;
  const showCostPerGb = !volumeless && !!meter.cost_per_gb && !ratesMatch;

  return (
    <div className="space-y-4">
      <p className="text-[11px] text-slate-300 bg-slate-800/50 border border-slate-700/60 rounded-lg px-3 py-2 leading-relaxed">
        <span className="font-semibold text-white">{meter.meter}</span> — {DIRECTION_HINT[meter.direction] || DIRECTION_HINT.other}
        {volumeless ? (
          <>
            {' '}It is billed per {meter.unit || 'unit'} rather than per GB, so it carries no transfer
            volume — {(meter.quantity ?? 0).toLocaleString('en-IN')} {meter.unit || 'units'} cost {money(meter.cost)}.
          </>
        ) : (
          <>
            {' '}It moved {formatBytes(meter.bytes)} ({gb.toFixed(2)} GB) for {money(meter.cost)}
            {meter.cost_per_gb ? `, working out at ${formatRate(meter.cost_per_gb, currency)} per GB` : ''}
            {' '}— {pctOf(meter.bytes, total).toFixed(1)}% of all transfer.
          </>
        )}
      </p>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {/* No hint: the unit is already part of the formatted value ("512 GB"),
            and a period restated here duplicates the date filter in the header.
            A caption that repeats what is already on screen is noise. */}
        <DetailStat
          label="Billed quantity"
          value={formatQuantity(meter.quantity ?? 0, meter.unit)}
        />
        {/* The unit rate opens the same explanation panel the cost comparison
            uses: billed rate against Microsoft's published price, in both
            currencies, with links to verify it.

            It also has to account for itself when there is no rate to show.
            A bare "—" is indistinguishable from a bug, and a meter billed per
            hour with no volume, or one carrying no quantity at all, has a real
            and explainable reason for being blank. */}
        <button
          type="button"
          onClick={() => onRate?.({ ...meter, unit_rate: unitRate })}
          disabled={!onRate}
          className="text-left bg-slate-800/40 border border-slate-700/50 rounded-lg px-3 py-2 enabled:hover:border-blue-500/50 enabled:hover:bg-slate-800/70 transition-colors disabled:cursor-default"
        >
          <span className="text-[10px] uppercase tracking-wide text-slate-500 flex items-center gap-1">
            Unit rate
            {onRate && <Info size={10} className="text-slate-600" />}
          </span>
          <span className="block text-sm font-semibold text-white mt-0.5">
            {unitRate != null
              ? formatRate(unitRate, currency)
              : <span className="text-slate-500">not billed per unit</span>}
          </span>
          <span className="block text-[10px] text-slate-500 mt-0.5">
            {unitRate != null
              ? `${money(meter.cost)} ÷ ${formatQuantity(meter.quantity ?? 0, meter.unit)}${onRate ? ' · click to explain' : ''}`
              : 'Azure reported no billed quantity for this meter, so there is nothing to divide the cost by'}
          </span>
        </button>
        {/* When Azure already bills this meter per GB, the unit rate *is* the
            cost per GB. Showing both put the same number on screen twice and
            implied they were two different facts. */}
        {showCostPerGb && (
          <DetailStat
            label="Cost per GB"
            value={formatRate(meter.cost_per_gb, currency)}
            hint="derived from transfer volume"
          />
        )}
        <DetailStat label="Category" value={meter.category || '—'} hint={meter.regions?.length ? meter.regions.slice(0, 3).join(', ') : ''} />
      </div>

      {/* Which service actually spent this. The stats above say how much and at
          what rate; without a name attached, none of it is actionable. */}
      <MeterResourceTrack meter={meter} currency={currency} />

      {!!meter.months?.length && (
        <section>
          <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-2">Month by month</h4>
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-slate-500 border-b border-slate-800">
                <th className="text-left font-medium pb-1.5">Month</th>
                <th className="text-right font-medium pb-1.5">Size</th>
                <th className="text-right font-medium pb-1.5">GB</th>
                <th className="text-right font-medium pb-1.5">Quantity</th>
                <th className="text-right font-medium pb-1.5">Amount</th>
              </tr>
            </thead>
            <tbody>
              {meter.months.map(mm => (
                <tr key={mm.month} className="border-b border-slate-800/50">
                  <td className="py-1.5 text-slate-300">{mm.month}</td>
                  <td className="py-1.5 text-right text-white">
                    {mm.bytes ? formatBytes(mm.bytes) : <span className="text-slate-600">—</span>}
                  </td>
                  <td className="py-1.5 text-right text-slate-400 tabular-nums">
                    {mm.bytes ? (mm.bytes / GB).toFixed(2) : <span className="text-slate-600">—</span>}
                  </td>
                  <td className="py-1.5 text-right text-slate-400">
                    <Quantity value={mm.quantity} unit={meter.unit} />
                  </td>
                  <td className="py-1.5 text-right text-slate-200">{money(mm.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <div className="grid md:grid-cols-2 gap-4">
        {!!meter.subscriptions?.length && (
          <section>
            <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-2">Which subscriptions</h4>
            <div className="space-y-1.5">
              {meter.subscriptions.map(s => (
                <div key={s.subscription_id} className="flex items-center justify-between gap-3 bg-slate-800/40 rounded-lg px-3 py-2">
                  <span className="text-[11px] text-slate-300 truncate" title={s.subscription_id}>{subscriptionLabel(s.subscription_id, subMap)}</span>
                  <span className="text-[11px] text-white shrink-0">
                    {s.bytes ? `${formatBytes(s.bytes)} · ` : ''}{money(s.cost)}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        {!!meter.resources?.length && (
          <section>
            <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-2">Top resources</h4>
            <div className="space-y-1.5">
              {meter.resources.map(r => (
                <div key={r.name} className="flex items-center justify-between gap-3 bg-slate-800/40 rounded-lg px-3 py-2">
                  <span className="text-[11px] text-slate-300 truncate">
                    {r.name}
                    {r.resource_group && <span className="block text-slate-500">{r.resource_group}</span>}
                  </span>
                  <span className="text-[11px] text-white shrink-0">
                    {r.bytes ? `${formatBytes(r.bytes)} · ` : ''}{money(r.cost)}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
