import { useEffect, useState } from 'react';
import { BadgeCheck, Tag, ShieldQuestion, Loader2, Server, AlertTriangle } from 'lucide-react';
import HeroCard from '../Cards/HeroCard';
import DetailPanel, { DetailStat } from '../Common/DetailPanel';
import { fetchReservedDetail } from '../../api/client';
import { formatAmountFull } from '../../utils/currency';
import { exactAmount } from '../../utils/exact';

/**
 * The resources a reservation actually paid for.
 *
 * Loaded only when the panel opens: it costs an extra Cost Management query per
 * subscription and Azure throttles those hard, so it must not run on every
 * dashboard load.
 */
function ReservedDetail({ request, currency }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchReservedDetail(request)
      .then(result => { if (!cancelled) setData(result); })
      .catch(err => {
        if (!cancelled) setError(err.response?.data?.detail || err.message);
      })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [JSON.stringify(request)]); // eslint-disable-line react-hooks/exhaustive-deps

  const cur = data?.currency || currency;
  const full = (v) => formatAmountFull(v, cur);

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-3 py-16 text-slate-400">
        <Loader2 className="w-5 h-5 animate-spin" />
        Resolving reserved charges…
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-950/30 border border-red-500/30 rounded-xl p-4 text-red-400 text-sm">
        {error}
      </div>
    );
  }

  if (!data?.resources?.length) {
    return (
      <div className="text-center py-12">
        <Server className="w-9 h-9 text-slate-600 mx-auto mb-3" />
        <p className="text-slate-300 font-medium">No reserved charges in this period</p>
        <p className="text-slate-500 text-sm mt-1">
          Nothing was billed under a reservation for the selected dates.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
        <DetailStat label="Reserved spend" value={full(data.total)} />
        <DetailStat label="Resources covered" value={data.resource_count} />
        <DetailStat
          label="Top SKU"
          value={data.resources[0]?.meters?.[0]?.name || '—'}
          hint="highest reserved charge"
        />
      </div>

      {data.errors?.length > 0 && (
        <div className="flex items-start gap-2 bg-amber-950/30 border border-amber-500/30 rounded-xl p-3">
          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <p className="text-xs text-slate-400 leading-relaxed">
            Some subscriptions could not be read, so this list is partial.
          </p>
        </div>
      )}

      <section>
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-2">
          Where the reservation was applied
        </h4>

        <div className="space-y-2">
          {data.resources.map(r => (
            <div
              key={r.resource_id || r.name}
              className="border border-slate-700/60 bg-slate-800/40 rounded-xl p-3.5"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-white truncate" title={r.name}>
                    {r.name}
                  </p>
                  <p className="text-[11px] text-slate-500 mt-0.5">
                    {r.resource_group
                      ? <>Resource group <span className="text-slate-300">{r.resource_group}</span></>
                      : 'Billed at subscription scope'}
                    {r.service ? ` · ${r.service}` : ''}
                  </p>
                </div>
                <span
                  className="text-sm font-semibold text-emerald-300 tabular-nums shrink-0"
                  title={exactAmount(r.cost, cur)}
                >
                  {full(r.cost)}
                </span>
              </div>

              {/* The meter name is where the SKU lives ("D2s v3"), which is what
                  a renewal decision actually turns on. */}
              {!!r.meters?.length && (
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {r.meters.map(m => (
                    <span
                      key={m.name}
                      title={`${m.name} — ${exactAmount(m.cost, cur)}`}
                      className="text-[11px] px-2 py-0.5 rounded-lg bg-slate-900/70 border border-slate-700 text-slate-300"
                    >
                      {m.name} · {full(m.cost)}
                    </span>
                  ))}
                </div>
              )}

              {r.subscription_id && (
                <p className="text-[10px] text-slate-600 mt-2 truncate" title={r.resource_id}>
                  Subscription {r.subscription_id}
                </p>
              )}
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

/**
 * Committed spend and list-price spend, kept apart.
 *
 * A single total answers "what did we spend" but not the question reservations
 * are bought to answer: how much is already committed, and how much is still
 * being paid at list price. Those drive different decisions — one is a renewal,
 * the other is a purchase — so they are never summed into one tile.
 *
 * The split comes from Azure's PricingModel dimension, not from meter names: a
 * VM meter looks identical whether or not a reservation covered it.
 */
export default function PricingSection({ data, loading, error, request }) {
  const currency = data?.currency || 'INR';
  const full = (v) => formatAmountFull(v, currency);
  const exact = (v) => exactAmount(v, currency);
  const [showReserved, setShowReserved] = useState(false);

  // Nothing to say yet. Rendering zeroes here would read as "no reservations",
  // which is a finding rather than an absence of data.
  if (!loading && !error && !data) return null;

  const noPricingDimension = data && !data.has_pricing_data;

  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-5 space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-sm font-semibold text-slate-300 flex items-center gap-2">
            <BadgeCheck className="w-4 h-4 text-emerald-400" />
            Reserved vs Pay-as-you-go
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Reserved instances and savings plans, kept separate from list-price spend
          </p>
        </div>

        {data?.committed_pct != null && !noPricingDimension && (
          <span className="text-xs text-slate-400">
            <span className="text-emerald-300 font-semibold">{data.committed_pct}%</span>{' '}
            of spend is committed
          </span>
        )}
      </div>

      {error && (
        <div className="bg-red-950/30 border border-red-500/30 rounded-xl p-3 text-red-400 text-sm">
          {error}
        </div>
      )}

      {/* Azure does not return PricingModel for every scope. Drawing the split
          anyway would show all spend as on-demand and invent a finding. */}
      {noPricingDimension && (
        <div className="flex items-start gap-2 bg-amber-950/30 border border-amber-500/30 rounded-xl p-3">
          <ShieldQuestion className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <p className="text-xs text-slate-400 leading-relaxed">
            Azure did not report a pricing model for this scope, so reserved and
            pay-as-you-go spend cannot be separated here. This is common on
            subscriptions with no reservations and on some partner (CSP) billing
            accounts.
          </p>
        </div>
      )}

      {!noPricingDimension && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <HeroCard
            title="Reserved (RI)"
            subtitle="Covered by reserved instances"
            icon={BadgeCheck}
            accent="emerald"
            value={full(data?.reserved)}
            exact={exact(data?.reserved)}
            footnote={
              data?.savings_plan
                ? `Plus ${full(data.savings_plan)} on savings plans`
                : 'Bought ahead of use'
            }
            loading={loading}
            // Only clickable when there is something to drill into; an empty
            // panel is worse than no affordance to open one.
            onClick={data?.reserved && request ? () => setShowReserved(true) : undefined}
            active={showReserved}
          />

          <HeroCard
            title="Pay-as-you-go"
            subtitle="Charged at list price"
            icon={Tag}
            accent="amber"
            value={full(data?.on_demand)}
            exact={exact(data?.on_demand)}
            footnote="Where a reservation would pay for itself"
            loading={loading}
          />

          <HeroCard
            title="Committed total"
            subtitle="Reserved plus savings plans"
            icon={BadgeCheck}
            accent="blue"
            value={full(data?.committed)}
            exact={exact(data?.committed)}
            sharePct={data?.committed_pct ?? undefined}
            footnote={data?.spot ? `${full(data.spot)} on spot` : undefined}
            loading={loading}
          />
        </div>
      )}

      {/* Biggest uncommitted spend first: that is where buying a reservation
          pays for itself, which is the decision this table informs. */}
      {!noPricingDimension && !!data?.services?.length && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800 text-xs text-slate-500">
                <th className="text-left font-medium py-2">Service</th>
                <th className="text-right font-medium py-2">Reserved</th>
                <th className="text-right font-medium py-2">Pay-as-you-go</th>
                <th className="text-right font-medium py-2">Total</th>
              </tr>
            </thead>
            <tbody>
              {data.services.slice(0, 8).map(s => (
                <tr key={s.service} className="border-b border-slate-800/50 last:border-0">
                  <td className="py-2 text-slate-300 truncate max-w-[220px]" title={s.service}>
                    {s.service}
                  </td>
                  <td className="py-2 text-right text-emerald-300 tabular-nums" title={exact(s.reserved)}>
                    {s.reserved ? full(s.reserved) : '—'}
                  </td>
                  <td className="py-2 text-right text-amber-300 tabular-nums" title={exact(s.on_demand)}>
                    {s.on_demand ? full(s.on_demand) : '—'}
                  </td>
                  <td className="py-2 text-right text-slate-200 tabular-nums" title={exact(s.total)}>
                    {full(s.total)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <DetailPanel
        open={showReserved}
        title="Reserved instance detail"
        subtitle="Every resource a reservation was applied to, with its SKU"
        onClose={() => setShowReserved(false)}
      >
        {showReserved && <ReservedDetail request={request} currency={currency} />}
      </DetailPanel>
    </div>
  );
}
