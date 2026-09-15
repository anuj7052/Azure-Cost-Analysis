import { formatAmountFull } from '../../utils/currency';

export default function ReservationNote({ period, service, currency, compact = false }) {
  const entries = Object.entries(period?.reservation_context || {}).filter(([name]) => !service || name === service);
  if (!entries.length) return null;
  const purchase = entries.reduce((sum, [, value]) => sum + (value.purchase_cost || 0), 0);
  const refund = entries.reduce((sum, [, value]) => sum + (value.refund_cost || 0), 0);
  const label = purchase > 0 ? 'RI purchase / payment' : refund !== 0 ? 'RI refund / adjustment' : 'RI reservation pricing';
  if (compact) return <span className="ml-2 rounded border border-violet-500/40 bg-violet-500/10 px-1.5 py-0.5 text-[10px] text-violet-300">{label}</span>;
  return <div role="note" className="mx-5 my-3 rounded-xl border border-violet-500/30 bg-violet-500/5 px-4 py-3 text-xs text-slate-300">
    <p className="font-semibold text-violet-300">{label}</p>
    {purchase > 0 ? <p className="mt-1">Includes {formatAmountFull(purchase, currency)} of Azure Reservation purchase charges. An upfront payment or recurring RI installment can create a billing spike without an equivalent increase in resource usage. Actual cost includes this payment; it is not spread over the reservation term.</p>
      : <p className="mt-1">Azure identifies reservation-priced billing in this period. RI-covered usage alone does not prove a new purchase or increased consumption.</p>}
    {refund !== 0 && <p>Reservation refunds / adjustments: {formatAmountFull(refund, currency)}.</p>}
    <p className="mt-1">Services: {entries.map(([name]) => name).join(', ')}. Confirmed from Azure PricingModel and ChargeType.</p>
  </div>;
}
