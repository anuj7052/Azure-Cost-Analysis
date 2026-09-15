import { useEffect, useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { MeterTable, SubscriptionBandwidthTable } from './BandwidthTables';
import BandwidthTrackPanel from './BandwidthTrackPanel';
import UnitRatePanel from './UnitRatePanel';
import DataQuality from './DataQuality';
import { Callout, EmptyState, ErrorState, Metric, Panel } from '../ui';
import { formatAmountFull, formatRate } from '../../utils/currency';
import { formatBytes, formatGB } from '../../utils/bytes';
import { subscriptionLabel, subscriptionNameMap } from '../../utils/identity';

/** Mounted only by the bandwidth tab; all queries use the header selection. */
export default function BandwidthCostPanel() {
  const {
    bandwidthData: data, bandwidthLoading: loading, bandwidthError: error, loadBandwidth,
    selectedTenantId, selectedSubscriptionIds, subscriptions, dateMode, months,
    fromDate, toDate, dateKey, imported,
  } = useAppStore();
  const [requested, setRequested] = useState(false);
  const [rateItem, setRateItem] = useState(null);
  const subsKey = selectedSubscriptionIds.join(',');
  useEffect(() => {
    let live = true;
    loadBandwidth().then(() => { if (live) setRequested(true); });
    return () => { live = false; };
  }, [loadBandwidth, selectedTenantId, subsKey, dateKey, imported]);

  const subMap = subscriptionNameMap(subscriptions || []);
  const currency = data?.currency;
  const money = value => value == null || !currency ? '—' : formatAmountFull(value, currency);
  const rate = value => value == null || !currency ? '—' : formatRate(value, currency);
  const period = dateMode === 'custom' && fromDate && toDate
    ? `${fromDate} → ${toDate}` : `Last ${months} months`;
  const history = data?.months || [];
  const services = Object.entries((data?.meters || []).reduce((totals, meter) => {
    const service = meter.category || 'Unspecified service';
    totals[service] = (totals[service] || 0) + (Number(meter.cost) || 0);
    return totals;
  }, {})).sort((a, b) => b[1] - a[1]);
  const openRate = meter => {
    const previous = meter.months?.length >= 2 ? meter.months.at(-2) : null;
    setRateItem({
      key: meter.meter, label: meter.meter, service: meter.category || 'Bandwidth',
      meter: meter.meter, sku: '', region: meter.regions?.length === 1 ? meter.regions[0] : '',
      unit: meter.unit || '', curr_rate: meter.unit_rate ?? null,
      prev_rate: previous?.quantity && previous.cost != null ? previous.cost / previous.quantity : null,
    });
  };

  return (
    <div className="space-y-5">
      <Callout tone="info" title="Bandwidth cost scope">
        Tenant: {selectedTenantId} · Subscriptions: {selectedSubscriptionIds.map(id => subscriptionLabel(id, subMap)).join(', ')} · {period}.
        {' '}Uses the header selection only. Explorer search, resource group, region, service and local subscription filters do not apply here; they are preserved for the other tabs.
        {imported && ' Source: imported billing file. Resource tracking requires live Azure data.'}
      </Callout>
      {error ? <ErrorState title="Could not load bandwidth costs" message={String(error)} onRetry={() => loadBandwidth({ force: true })} />
        : (!requested || loading) && !data ? <p role="status" className="text-sm text-slate-400">Loading bandwidth costs…</p>
        : !data ? <EmptyState title="Bandwidth costs unavailable" description="No report was returned. Select a tenant and subscriptions or retry." />
        : <>
          <DataQuality coverage={data.coverage} />
          {!!data.errors?.length && <Callout tone="medium" title="Partial bandwidth costs">
            Totals exclude {data.errors.length} subscription(s) that could not be read.
            {data.errors.map((entry, index) => <p key={index}>{entry.subscription_id}: {entry.error}</p>)}
          </Callout>}
          {!currency && <Callout tone="medium" title="Currency unavailable">Monetary values cannot be displayed without the report currency.</Callout>}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Metric label="Bandwidth Spend" value={money(data.total_cost)} />
            <Metric label="Effective Rate per GB" value={rate(data.cost_per_gb)} hint="Blended across all transfer meters" />
            <Metric label="Cost per TB" value={money(data.cost_per_gb == null ? null : data.cost_per_gb * 1024)} />
            <Metric label="Billed volume" value={data.total_bytes == null ? '—' : formatBytes(data.total_bytes)} />
          </div>
          {services.length > 0 && <Panel title="Why this differs from the Bandwidth service filter" hint="This report includes transfer-related meters billed under multiple Azure services. The Explorer service filter selects only one service.">
            <table className="w-full text-sm text-slate-300"><thead><tr><th className="text-left">Azure service / meter category</th><th className="text-right">Transfer charges</th></tr></thead>
              <tbody>{services.map(([service, cost]) => <tr key={service} className="border-t border-slate-800"><td className="py-2">{service}</td><td className="text-right tabular-nums">{money(cost)}</td></tr>)}</tbody>
            </table>
            <p className="mt-2 text-xs text-slate-400">All transfer charges: {money(data.total_cost)}. Compare the Bandwidth row with the Bandwidth service filter using the same subscriptions and dates.</p>
          </Panel>}
          {!history.length && !data.meters?.length && !data.errors?.length && <EmptyState title="No bandwidth charges returned" description="No bandwidth meters were reported for this selection." />}
          <Panel title={`Monthly bandwidth costs${currency ? ` (${currency})` : ''}`} hint="Same billing-meter source as Bandwidth. Partial calendar months reflect the selected dates; expand a meter below for its monthly quantities and charges.">
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-slate-300">
                <thead><tr><th className="text-left">Month</th><th>Size</th><th>GB</th><th>Amount</th></tr></thead>
                <tbody>{history.map(row => <tr key={row.month} className="border-t border-slate-800">
                  <td className="py-3">{row.month}</td><td className="text-center">{row.total_bytes == null ? '—' : formatBytes(row.total_bytes)}</td>
                  <td className="text-center">{row.total_bytes == null ? '—' : formatGB(row.total_bytes)}</td><td className="text-center">{money(row.cost)}</td>
                </tr>)}</tbody>
              </table>
            </div>
          </Panel>
          {currency && <>
            <Panel title="Contributing meters" hint="Expand a meter for monthly costs, subscriptions, resource attribution and unit-rate explanation.">
              <MeterTable meters={data.meters} currency={currency} total={data.total_bytes} subMap={subMap} onRate={openRate} />
            </Panel>
            <Panel title="Bandwidth costs by subscription">
              <SubscriptionBandwidthTable rows={data.by_subscription} currency={currency} total={data.total_bytes} subMap={subMap} />
            </Panel>
            <BandwidthTrackPanel currency={currency} />
            <UnitRatePanel item={rateItem} currency={currency} prevMonth={history.length >= 2 ? history.at(-2).month : ''} currMonth={history.at(-1)?.month || ''} onClose={() => setRateItem(null)} />
          </>}
        </>}
    </div>
  );
}
