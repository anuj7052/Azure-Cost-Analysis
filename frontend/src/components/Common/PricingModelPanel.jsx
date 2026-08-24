import { useEffect, useState } from 'react';
import { ArrowRight, BadgeCheck, Info, Loader2, ShieldCheck, TrendingDown, TrendingUp } from 'lucide-react';

import { fetchPricingModel } from '../../api/client';
import { formatAmount } from '../../utils/currency';
import { useAppStore } from '../../store/useAppStore';

/**
 * Reserved Instances, Savings Plans, and what moved between Pay-as-you-go.
 *
 * A resource moving onto a reservation is the single largest explicable swing
 * in an Azure bill, and it is indistinguishable from a fault: the cost collapses
 * to near zero with no change in usage. A reservation expiring is the same event
 * in reverse, and it looks like a price rise nobody authorised. Naming the
 * transition turns both into expected news.
 *
 * The panel is careful about one number. Under ActualCost, reservation-covered
 * usage bills at zero because the money was spent when the reservation was
 * bought — a different month, often a different subscription. So the drop is not
 * a saving realised this month, and this panel never calls it one. It reports
 * *avoided on-demand cost* and says what that means, because calling it a saving
 * counts the purchase twice.
 */

const MODEL_STYLE = {
  reservation: { label: 'Reserved', tone: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30' },
  'savings-plan': { label: 'Savings Plan', tone: 'text-teal-300 bg-teal-500/10 border-teal-500/30' },
  spot: { label: 'Spot', tone: 'text-violet-300 bg-violet-500/10 border-violet-500/30' },
  'on-demand': { label: 'Pay-as-you-go', tone: 'text-slate-300 bg-slate-700/30 border-slate-600/40' },
  unknown: { label: 'Unclassified', tone: 'text-amber-300 bg-amber-500/10 border-amber-500/30' },
};

/** The tag shown after a covered meter's name — matches the backend's own. */
const MODEL_TAG = {
  reservation: '(RI)',
  'savings-plan': '(SP)',
  spot: '(Spot)',
};

function suffixFor(meter) {
  const committed = meter.models.find(m => MODEL_TAG[m]);
  return MODEL_TAG[committed] || '';
}

function Pill({ model }) {
  const style = MODEL_STYLE[model] || MODEL_STYLE.unknown;
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded border whitespace-nowrap ${style.tone}`}>
      {style.label}
    </span>
  );
}

function Transition({ move, currency }) {
  const toCommitted = move.direction === 'to-committed';
  const Icon = toCommitted ? TrendingDown : TrendingUp;

  return (
    <div className={`rounded-xl border px-3 py-2.5 ${toCommitted
      ? 'bg-emerald-950/20 border-emerald-500/30'
      : 'bg-amber-950/20 border-amber-500/30'}`}
    >
      <div className="flex items-start gap-2.5">
        <Icon size={15} className={`mt-0.5 shrink-0 ${toCommitted ? 'text-emerald-400' : 'text-amber-400'}`} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-white">{move.headline}</p>
          <p className="text-[11px] text-slate-400 mt-0.5">
            {move.service} · {move.from_month} → {move.to_month}
          </p>

          <div className="flex items-center gap-2 mt-2 text-[11px]">
            <Pill model={move.from_model} />
            <ArrowRight size={11} className="text-slate-600" />
            <Pill model={move.to_model} />
            <span className="text-slate-500 ml-1">
              {Math.round(move.committed_share_before * 100)}% → {Math.round(move.committed_share_after * 100)}% covered
            </span>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-x-3 gap-y-1 mt-2 text-[11px]">
            <span className="text-slate-500">Cost before</span>
            <span className="text-slate-200 text-right md:text-left">
              {formatAmount(move.cost_before, currency)}
            </span>
            <span className="text-slate-500">Cost after</span>
            <span className="text-slate-200 text-right md:text-left">
              {formatAmount(move.cost_after, currency)}
            </span>

            <span className="text-slate-500">Quantity before</span>
            <span className="text-slate-200 text-right md:text-left">
              {move.quantity_before?.toLocaleString('en-IN')} {move.unit}
            </span>
            <span className="text-slate-500">Quantity after</span>
            <span className="text-slate-200 text-right md:text-left">
              {move.quantity_after?.toLocaleString('en-IN')} {move.unit}
            </span>
          </div>

          {/* Usage held steady while cost moved — the proof that this was a
              pricing change, not a usage change. Worth stating outright,
              because it is the fact that rules out a fault. */}
          {move.quantity_before === move.quantity_after && (
            <p className="text-[11px] text-slate-300 mt-2 bg-slate-800/50 rounded px-2 py-1">
              Usage did not change. Only the way it is paid for did.
            </p>
          )}

          <p className="text-[11px] text-slate-400 mt-2 leading-relaxed">{move.detail}</p>
        </div>
      </div>
    </div>
  );
}

export default function PricingModelPanel({ currency }) {
  const [answer, setAnswer] = useState({ key: null, data: null, error: null });

  const selectedTenantId = useAppStore(s => s.selectedTenantId);
  const selectedSubscriptionIds = useAppStore(s => s.selectedSubscriptionIds);
  const months = useAppStore(s => s.months);
  const fromDate = useAppStore(s => s.fromDate);
  const toDate = useAppStore(s => s.toDate);

  const subsKey = selectedSubscriptionIds.join(',');
  const key = [selectedTenantId, subsKey, months, fromDate, toDate].join('::');
  const ready = !!selectedTenantId && selectedSubscriptionIds.length > 0;

  useEffect(() => {
    if (!ready) return undefined;
    let cancelled = false;

    fetchPricingModel({
      tenant_id: selectedTenantId,
      subscription_ids: selectedSubscriptionIds,
      months,
      from_date: fromDate,
      to_date: toDate,
    })
      .then(data => { if (!cancelled) setAnswer({ key, data, error: null }); })
      .catch(err => {
        if (cancelled) return;
        setAnswer({ key, data: null, error: err.message || 'Could not read pricing model.' });
      });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ready]);

  if (!ready) return null;

  const settled = answer.key === key;
  const data = settled ? answer.data : null;
  const error = settled ? answer.error : null;
  const coverage = data?.coverage;
  const moves = data?.transitions || [];
  const covered = (data?.meters || []).filter(m => m.is_committed);

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold text-white flex items-center gap-2">
            <ShieldCheck size={15} className="text-emerald-400" />
            Reservations &amp; commitments
          </h3>
          <p className="text-[11px] text-slate-500 mt-1 leading-relaxed max-w-2xl">
            How much of this usage is prepaid, and anything that moved between Pay-as-you-go
            and a reservation — the most common reason a cost changes without usage changing.
          </p>
        </div>
        {!settled && <Loader2 size={16} className="animate-spin text-slate-500 shrink-0 mt-1" />}
      </div>

      {error && (
        <p className="text-[11px] text-red-300 bg-red-950/30 border border-red-500/30 rounded-lg px-3 py-2">
          {error}
        </p>
      )}

      {data && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <div className="bg-slate-800/40 border border-slate-700/50 rounded-lg px-3 py-2">
              <p className="text-[10px] uppercase tracking-wide text-slate-500">Covered by a commitment</p>
              <p className="text-sm font-semibold text-white mt-0.5">
                {Math.round((coverage?.committed_share || 0) * 100)}% of billed quantity
              </p>
            </div>
            {Object.entries(coverage?.by_model || {}).map(([model, cell]) => (
              <div key={model} className="bg-slate-800/40 border border-slate-700/50 rounded-lg px-3 py-2">
                <p className="text-[10px] uppercase tracking-wide text-slate-500 flex items-center gap-1.5">
                  <Pill model={model} />
                </p>
                <p className="text-sm font-semibold text-white mt-1">
                  {formatAmount(cell.cost, data.currency || currency)}
                </p>
              </div>
            ))}
          </div>

          {/* Where PricingModel is unavailable the answer is a shape, not a
              fact, and a reservation cannot be told from a savings plan. The
              user has to know which kind of answer they are reading. */}
          {!data.precise && (
            <p className="text-[11px] text-amber-200/90 bg-amber-950/25 border border-amber-500/30 rounded-lg px-3 py-2 flex items-start gap-2">
              <Info size={13} className="mt-0.5 shrink-0 text-amber-400" />
              <span>{data.basis}</span>
            </p>
          )}

          {moves.length > 0 ? (
            <section className="space-y-2">
              <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                What moved ({moves.length})
              </h4>
              {moves.slice(0, 8).map(move => (
                <Transition
                  key={`${move.service}|${move.meter}|${move.from_month}`}
                  move={move}
                  currency={data.currency || currency}
                />
              ))}
            </section>
          ) : (
            <p className="text-[11px] text-slate-400 bg-slate-800/40 border border-slate-700/50 rounded-lg px-3 py-2 flex items-start gap-2">
              <BadgeCheck size={13} className="mt-0.5 shrink-0 text-slate-500" />
              <span>
                Nothing moved between Pay-as-you-go and a commitment in this period. Any cost
                change you are looking at came from usage or price, not from how it is paid for.
              </span>
            </p>
          )}

          {/* The tag people asked for. Only committed meters are listed and
              only they carry a suffix — tagging every row would make the tag
              carry no information at all. */}
          {!!covered.length && (
            <section className="space-y-2">
              <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                Meters on a commitment ({covered.length})
              </h4>
              <div className="grid md:grid-cols-2 gap-1.5">
                {covered.slice(0, 12).map(meter => (
                  <div
                    key={`${meter.service}|${meter.meter}`}
                    className="flex items-center justify-between gap-2 bg-slate-800/40 border border-slate-700/50 rounded-lg px-3 py-1.5"
                  >
                    <span className="text-[11px] text-slate-200 truncate">
                      {meter.meter}
                      <span className="text-emerald-400 font-semibold"> {suffixFor(meter)}</span>
                      <span className="block text-slate-500">{meter.service}</span>
                    </span>
                    <div className="flex gap-1 shrink-0">
                      {meter.models.map(m => <Pill key={m} model={m} />)}
                    </div>
                  </div>
                ))}
              </div>
              {covered.length > 12 && (
                <p className="text-[11px] text-slate-500">
                  +{covered.length - 12} more covered meters.
                </p>
              )}
            </section>
          )}

          <p className="text-[11px] text-slate-500 leading-relaxed">
            Source: {data.basis}.
          </p>
        </>
      )}
    </div>
  );
}