/**
 * The bandwidth tables, shared by the Bandwidth report and the Cost Explorer's
 * bandwidth cost panel.
 *
 * They lived on the page until the panel needed them too: a static import of a
 * whole page just to reach two tables pinned that page into the explorer's
 * bundle and defeated loading it on demand. The tables are the shared part, so
 * the tables are what moved.
 */
import { Fragment, useState } from 'react';
import { ChevronDown, ChevronRight, Info } from 'lucide-react';

import { DetailStat } from './DetailPanel';
import ResourceCostTable from './ResourceCostTable';
import { useBandwidthTraffic, resourcesForMeter } from '../../hooks/useBandwidthTraffic';
import { formatAmount, formatAmountFull, formatRate } from '../../utils/currency';
import { formatQuantity } from '../../utils/exact';
import { subscriptionLabel } from '../../utils/identity';
import { Quantity } from './Amount';
import { GB, formatBytes, pctOf } from '../../utils/bytes';

export function SubscriptionBandwidthTable({ rows, loading, currency, total, subMap }) {
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

export function MeterTable({ meters, loading, currency, total, compact = false, subMap = {}, onRate }) {
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
