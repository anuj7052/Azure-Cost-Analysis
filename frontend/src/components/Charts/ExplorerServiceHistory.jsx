import { useEffect, useMemo, useRef, useState } from 'react';
import { ServiceResources, ResourceDetail } from '../Boq/BoqResourcePanel';
import { fetchActivity } from '../../api/client';
import { dedupeRequest } from '../../utils/queryRequest';
import { previousDate, serviceSlice } from '../../utils/dailyTimeline';
import { formatAmountFull } from '../../utils/currency';
import { Panel, DataTable, Callout } from '../ui';
import CostTrendChart from './CostTrendChart';

/** Billing history remains scoped to the selected range, not the clicked day. */
export default function ExplorerServiceHistory({ service, days = [], query, currency, onPickDay, onClose, resourcesOnly = false }) {
  const [resource, setResource] = useState(null);
  const root = useRef(null);
  useEffect(() => { if (!resourcesOnly) root.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, [resourcesOnly]);
  const series = useMemo(() => serviceSlice(days, service), [days, service]);
  const months = useMemo(() => {
    const totals = new Map();
    series.forEach(day => {
      if (!Number.isFinite(day.total)) return;
      const month = day.date.slice(0, 7);
      totals.set(month, (totals.get(month) || 0) + day.total);
    });
    return [...totals].map(([month, total_cost]) => ({ month, total_cost }));
  }, [series]);
  const byDate = new Map(series.map(day => [day.date, day]));
  const money = value => Number.isFinite(value) ? formatAmountFull(value, currency) : '—';
  return <section ref={root} aria-label={`${service} full-period details`} className="scroll-mt-24 space-y-4">
    {!resourcesOnly && <Panel title={`${service} · full selected period`} hint={`${query.from_date} → ${query.to_date}. Selecting a date above does not shorten this history.`}
      actions={<button type="button" className="text-sm text-blue-400" onClick={onClose}>Back to all services</button>}>
      <p className="mb-3 text-lg font-semibold text-slate-200">{money(series.reduce((sum, day) => sum + (day.total || 0), 0))} billed in this range</p>
      <CostTrendChart months={months} currency={currency} onSelectMonth={month => onPickDay(series.find(day => day.date.startsWith(month))?.date)} />
      <details className="mt-3" open>
        <summary className="cursor-pointer text-sm text-slate-300">All daily charges and changes ({series.length} returned days)</summary>
        <DataTable rows={series.map(day => ({ ...day, id: day.date, delta: Number.isFinite(day.total) && Number.isFinite(byDate.get(previousDate(day.date))?.total) ? day.total - byDate.get(previousDate(day.date)).total : null }))} columns={[
          { key: 'date', header: 'Date', render: day => <button className="text-blue-400 hover:underline" onClick={() => onPickDay(day.date)}>{day.date}</button> },
          { key: 'total', header: 'Service cost', align: 'right', render: day => money(day.total) },
          { key: 'delta', header: 'vs previous calendar day', align: 'right', render: day => money(day.delta) },
        ]} />
      </details>
    </Panel>}
    {resource ? <>
      <ResourceDetail key={resource.key} resource={resource} tenantId={query.tenant_id} currency={currency} fromDate={query.from_date} toDate={query.to_date} onBack={() => setResource(null)} onClose={onClose} />
      <ResourceActivity key={`${resource.key}:${query.from_date}:${query.to_date}`} resource={resource} query={query} />
    </> : <ServiceResources service={service} rows={[]} query={query} currency={currency} onPick={setResource} onClose={onClose} />}
  </section>;
}

function ResourceActivity({ resource, query }) {
  const [result, setResult] = useState(null);
  const requestKey = JSON.stringify([query.tenant_id, resource.subscriptionId, resource.resourceId, query.from_date]);
  useEffect(() => {
    const [tenantId, subscriptionId, resourceId, fromDate] = JSON.parse(requestKey);
    if (!resourceId) return;
    let live = true;
    const days = Math.min(90, Math.max(1, Math.ceil((Date.now() - Date.parse(`${fromDate}T00:00:00Z`)) / 86400000) + 1));
    dedupeRequest(`resource-activity:${requestKey}`, () => fetchActivity(tenantId, [subscriptionId], { days, resourceId, writesOnly: false }))
      .then(data => { if (live) setResult({ data }); }).catch(error => { if (live) setResult({ error: error.message }); });
    return () => { live = false; };
  }, [requestKey]);
  const events = (result?.data?.events || []).filter(event => event.at?.slice(0, 10) >= query.from_date && event.at.slice(0, 10) <= query.to_date);
  return <Panel title="Resource activity in selected period" hint="All returned operations, including failures. Azure Activity Log retains roughly 90 days; older changes require retained scan history.">
    {!resource.resourceId ? <Callout title="Resource identity unavailable">Activity cannot be safely matched by name alone.</Callout> : !result ? <p role="status">Loading resource activity…</p> : result.error ? <Callout title="Activity unavailable" tone="medium">{result.error}</Callout> : <>
      {!!result.data.errors?.length && <Callout title="Partial activity" tone="medium">{result.data.errors.map(error => error.error).join(' · ')}</Callout>}
      <DataTable rows={events.map((event, index) => ({ ...event, id: event.id || `${event.at}:${index}` }))} columns={[
        { key: 'at', header: 'When' }, { key: 'operation', header: 'Operation' }, { key: 'caller', header: 'Who' }, { key: 'status', header: 'Status' },
      ]} />
      {!events.length && <p className="text-xs text-slate-400">No activity was returned within this period. This does not establish that the resource never changed.</p>}
    </>}
  </Panel>;
}
