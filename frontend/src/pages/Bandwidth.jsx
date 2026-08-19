import { useEffect, useMemo, useState, Fragment } from 'react';
import {
  ArrowDownToLine, ArrowUpFromLine, Gauge, Network, Repeat, Layers,
  ChevronDown, ChevronRight,
} from 'lucide-react';
import {
  Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { useAppStore } from '../store/useAppStore';
import { useChartTheme } from '../store/useTheme';
import HeroCard from '../components/Cards/HeroCard';
import DetailPanel, { DetailStat } from '../components/Common/DetailPanel';
import PortalGuide, { BANDWIDTH_GUIDE } from '../components/Common/PortalGuide';
import SubscriptionFilter from '../components/Common/SubscriptionFilter';
import { formatAmount, formatAmountFull, formatRate } from '../utils/currency';
import { formatQuantity } from '../utils/exact';
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
  const t = useChartTheme();

  useEffect(() => {
    if (imported || (selectedTenantId && selectedSubscriptionIds.length > 0)) loadBandwidth();
  }, [imported, selectedTenantId, selectedSubscriptionIds.join(','), dateKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const currency = bw?.currency || 'INR';
  const money    = (v) => formatAmount(v, currency);
  const total    = bw?.total_bytes || 0;
  const subMap   = Object.fromEntries((subscriptions || []).map(s => [s.subscription_id, s.display_name]));

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

      <SubscriptionFilter onChange={loadBandwidth} />

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
        <MeterTable meters={bw?.meters} loading={loading} currency={currency} total={total} subMap={subMap} />
      </div>

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
                compact
              />
            </section>

            {!!bw?.by_subscription?.length && (
              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-3">By subscription</h3>
                <div className="space-y-2">
                  {bw.by_subscription.map(s => (
                    <div key={s.subscription_id} className="flex items-center justify-between gap-3 bg-slate-800/40 rounded-xl px-4 py-3">
                      <span className="text-sm text-slate-300 truncate">{subMap[s.subscription_id] || s.subscription_id}</span>
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
                <span className="block truncate">{subMap[s.subscription_id] || s.subscription_id}</span>
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

function MeterTable({ meters, loading, currency, total, compact = false, subMap = {} }) {
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
                      <MeterDetail meter={m} currency={currency} total={total} subMap={subMap} />
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
function MeterDetail({ meter, currency, total, subMap }) {
  const money = (v) => formatAmount(v, currency);
  const gb = meter.bytes / GB;
  // Gateways and firewalls bill by the hour, so they have a cost but no volume.
  const volumeless = !meter.bytes;

  // Cost per GB is only a separate fact when the meter is *not* already billed
  // per GB. Where it is, the two figures are identical by definition and only
  // one belongs on screen.
  const ratesMatch =
    meter.unit_rate != null &&
    meter.cost_per_gb != null &&
    Math.abs(meter.unit_rate - meter.cost_per_gb) < 0.00005;
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
        <DetailStat
          label="Unit rate"
          value={formatRate(meter.unit_rate, currency)}
          hint={meter.unit ? `per ${meter.unit}` : 'per billed unit'}
        />
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
                  <span className="text-[11px] text-slate-300 truncate">{subMap[s.subscription_id] || s.subscription_id}</span>
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
