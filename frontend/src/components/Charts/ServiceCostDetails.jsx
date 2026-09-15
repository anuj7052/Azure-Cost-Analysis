import { useMemo, useState } from 'react';
import { previousDate, previousMonth } from '../../utils/dailyTimeline';
import { formatAmountFull } from '../../utils/currency';
import { Panel, Select, Callout } from '../ui';
import CostDeltaDetails from './CostDeltaDetails';
import CostChangeExplainer from './CostChangeExplainer';
import ServiceMeterChanges from './ServiceMeterChanges';

/** Service totals and changes read from the exact series currently on screen. */
export default function ServiceCostDetails({ periods = [], currency, daily = false, query = null, filters = {} }) {
  const [selected, setSelected] = useState('');
  const [pickedPeriod, setPickedPeriod] = useState('');
  const [detailKey, setDetailKey] = useState('');
  const key = daily ? 'date' : 'month';
  const totalKey = daily ? 'total' : 'total_cost';
  const services = useMemo(() => {
    const sums = new Map();
    periods.forEach(period => Object.entries(period.by_service || {}).forEach(([name, value]) => {
      sums.set(name, (sums.get(name) || 0) + value);
    }));
    return [...sums].sort((a, b) => b[1] - a[1]);
  }, [periods]);
  const service = services.some(([name]) => name === selected) ? selected : services[0]?.[0] || '';
  const series = periods.map(period => ({ ...period,
    [totalKey]: period.by_service == null ? null : period.by_service[service] ?? 0,
    by_service: period.by_service == null ? null : { [service]: period.by_service[service] ?? 0 },
  })).sort((a, b) => a[key].localeCompare(b[key]));
  const current = series.find(period => period[key] === pickedPeriod) || series.at(-1);
  const priorLabel = daily ? previousDate(current?.[key]) : previousMonth(current?.[key]);
  const prior = series.find(period => period[key] === priorLabel);
  const money = value => Number.isFinite(value) ? formatAmountFull(value, currency) : '—';
  const meterKey = JSON.stringify([query, service, current?.[key], priorLabel, filters]);
  if (!services.length) return null;
  return <Panel title="Service-wise costs & changes" hint="Amounts use the same dates and filters as the chart above. Select a service, then a billing period to explain its movement.">
    <div className="flex flex-wrap gap-3">
      <Select label="Inspect service" value={service} onChange={setSelected}
        options={services.map(([name, total]) => ({ value: name, label: `${name} · ${money(total)} in range` }))} />
      <Select label={daily ? 'Inspect day' : 'Inspect billing month'} value={current?.[key] || ''} onChange={setPickedPeriod}
        options={series.map(period => ({ value: period[key], label: `${period[key]} · ${money(period[totalKey])}` }))} />
    </div>
    {service === 'Bandwidth' && <Callout title="Bandwidth service vs transfer report" tone="info">This is the Azure service named Bandwidth. The Bandwidth tab also includes transfer meters billed under other services, so its total can be larger.</Callout>}
    <div className="mt-4 max-h-64 overflow-auto">
      <table className="w-full text-sm"><thead><tr className="text-slate-400"><th className="text-left">{daily ? 'Day' : 'Month'}</th><th className="text-right">{service}</th></tr></thead>
        <tbody>{series.map(period => <tr key={period[key]} className="border-t border-slate-800"><td className="py-2"><button type="button" className="text-blue-400 hover:underline" onClick={() => setPickedPeriod(period[key])}>{period[key]}</button></td><td className="text-right tabular-nums text-slate-200">{money(period[totalKey])}</td></tr>)}</tbody>
      </table>
    </div>
    <div className="mt-4"><CostChangeExplainer current={current} prior={prior} label={current?.[key]} priorLabel={priorLabel} currency={currency} totalKey={totalKey}
      partial={current?.[key] >= new Date().toISOString().slice(0, daily ? 10 : 7)} /></div>
    <CostDeltaDetails current={current} prior={prior} label={current?.[key]} priorLabel={priorLabel} currency={currency} totalKey={totalKey} />
    {!daily && query && prior && <>
      <button type="button" className="mt-3 rounded-lg border border-blue-500/40 px-3 py-2 text-sm text-blue-400" onClick={() => setDetailKey(detailKey === meterKey ? '' : meterKey)} aria-expanded={detailKey === meterKey}> {detailKey === meterKey ? 'Hide meter details' : 'Explain usage, rates & meter changes'} </button>
      {detailKey === meterKey && <ServiceMeterChanges key={meterKey} query={query} filters={filters} service={service} prior={prior} current={current} currency={currency} />}
    </>}
    <p className="mt-3 text-xs text-slate-400">These service charges identify where the bill changed. For usage-versus-rate and meter-level reasons, open Month compare → Full variance. Service totals alone do not establish an operational cause.</p>
  </Panel>;
}
