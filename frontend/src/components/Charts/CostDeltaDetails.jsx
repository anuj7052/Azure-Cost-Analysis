import { compareServices } from '../../utils/dailyTimeline';
import { formatAmountFull } from '../../utils/currency';
import { Badge, Callout, DataTable } from '../ui';

export default function CostDeltaDetails({ current, prior, label, priorLabel, currency, totalKey = 'total', onPickService }) {
  const comparison = compareServices(current, prior, totalKey);
  const fmt = value => Number.isFinite(value) ? formatAmountFull(value, currency) : '—';
  const signed = value => value == null ? '—' : `${value > 0 ? '+' : ''}${fmt(value)}`;
  if (!current) return <Callout tone="info" title={`No billing data returned for ${label}`}>A missing date is not a zero-cost date. Choose a returned date to inspect it.</Callout>;
  return (
    <section className="mt-4 space-y-3 border-t border-slate-800 pt-4" aria-label={`Billing comparison for ${label}`}>
      <h3 className="font-medium text-slate-200">{label}: {fmt(current[totalKey])}</h3>
      <p className="text-sm text-slate-400">Compared with {priorLabel}: {fmt(prior?.[totalKey])}. Change: {signed(comparison.delta)} {comparison.percent !== null && `(${comparison.percent.toFixed(1)}%)`}</p>
      {!prior && <Callout tone="info" title="Previous calendar period unavailable">No comparison is calculated. The prior period may be outside the selected range or have no returned billing data; it is not assumed to be zero.</Callout>}
      {prior && comparison.delta === null && <Callout tone="medium" title="Comparison unavailable">Totals are missing or currencies differ; no valid change can be calculated.</Callout>}
      <p className="text-xs text-slate-400">These billed service deltas explain the arithmetic of the increase or decrease, not operational root causes. Billing can arrive late or be revised. A missing service in a returned breakdown counts as zero; a missing breakdown does not.</p>
      <DataTable key={`${label}:${priorLabel}`} rows={comparison.rows.map(row => ({ ...row, id: row.name }))} columns={[
        { key: 'name', header: 'Service', render: row => onPickService ? <button type="button" className="text-blue-400 hover:underline text-left" onClick={() => onPickService(row.name)} aria-label={`Open ${row.name} service details`}>{row.name} →</button> : row.name },
        { key: 'prior', header: priorLabel, align: 'right', render: row => fmt(row.prior) },
        { key: 'current', header: label, align: 'right', render: row => fmt(row.current) },
        { key: 'delta', header: 'Billed delta', align: 'right', render: row => <Badge tone={row.delta > 0 ? 'medium' : row.delta < 0 ? 'good' : 'neutral'}>{signed(row.delta)}</Badge> },
      ]} />
      {comparison.residual !== null && Math.abs(comparison.residual) >= 0.01 && <p className="text-xs text-slate-400">Unattributed / rounding delta: {signed(comparison.residual)}. Named service deltas do not fully reconcile to the total change.</p>}
    </section>
  );
}
