/**
 * Commitments -- reservations and savings plans.
 *
 * A commitment is a promise to spend, made up front, in exchange for a lower
 * rate. Two things go wrong with them and they fail in opposite directions: one
 * lapses and the rate silently reverts to pay-as-you-go, or one sits underused
 * and you pay for hours nobody consumed. Neither is visible on a normal cost
 * report -- in the first case the bill rises for no apparent reason, and in the
 * second it does not move at all.
 *
 * So the page is arranged around those two questions and nothing else. What is
 * about to lapse, and what is not being used.
 *
 * Every number here is either measured or absent. Utilisation is Azure's own
 * figure and is never recomputed; cost comes from an amortised Cost Management
 * query and is blank when that query did not return it. Wastage needs both, and
 * shows nothing when either is missing -- it is the number somebody quotes when
 * they propose cancelling a reservation, and an estimate would look identical
 * on screen to a measurement.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  PiggyBank, TrendingDown, CalendarClock, Percent, Wallet, Loader2,
  ShoppingCart, Info, ChevronRight, ChevronDown, ExternalLink, Search,
} from 'lucide-react';
import { fetchCommitments } from '../api/client';
import {
  PageHeader, NeedsSelection, Failure, Empty, Chips,
} from '../components/Security/SecurityShell';
import { useAppStore } from '../store/useAppStore';
import { friendlyError } from '../utils/apiError';
import {
  GRAINS, TYPE_FILTERS, KIND_LABEL, KIND_FULL, EXPIRY_TONE, EXPIRY_LABEL,
  MISSING, percent, money, termLabel, expiryLabel, filterCommitments, usedAt,
  wastageOf, byResourceType, worstWaste, utilisationTone, utilisationBar,
  utilisationVerdict,
} from '../utils/commitments';

function Kpi({ icon, label, value, hint, tone = 'text-slate-100', accent = 'border-slate-800' }) {
  const Glyph = icon;
  return (
    <div className={`rounded-2xl border ${accent} bg-slate-900 p-4`}>
      <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-slate-500">
        <Glyph size={12} /> {label}
      </p>
      <p className={`mt-1.5 text-2xl font-semibold ${tone}`}>{value}</p>
      {hint && <p className="mt-1 text-[11px] leading-relaxed text-slate-500">{hint}</p>}
    </div>
  );
}

function Bar({ used }) {
  const known = used !== null && used !== undefined;
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-slate-800">
        {known && (
          <div className={`h-full rounded-full ${utilisationBar(used)}`}
            style={{ width: `${Math.max(2, Math.min(100, used))}%` }} />
        )}
      </div>
      <span className={`w-16 text-right text-xs tabular-nums ${utilisationTone(used)}`}>
        {known ? percent(used) : MISSING}
      </span>
    </div>
  );
}

function Kind({ kind }) {
  const reserved = kind === 'reservation';
  return (
    <span
      title={KIND_FULL[kind] || kind}
      className={`rounded-md px-1.5 py-0.5 text-[10px] font-medium ${
        reserved ? 'bg-sky-500/15 text-sky-300' : 'bg-violet-500/15 text-violet-300'
      }`}
    >
      {KIND_LABEL[kind] || kind}
    </span>
  );
}

function ExpiringCard({ item, currency }) {
  const tone = EXPIRY_TONE[item.expiry_band] || 'text-slate-400';
  const border = item.expiry_band === 'critical' ? 'border-rose-500/40'
    : item.expiry_band === 'warning' ? 'border-amber-500/35' : 'border-slate-800';
  return (
    <div className={`min-w-[15rem] rounded-xl border ${border} bg-slate-900 p-3`}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium text-slate-100">{item.name}</p>
        <span className={`text-[10px] font-medium ${tone}`}>
          {EXPIRY_LABEL[item.expiry_band] || ''}
        </span>
      </div>
      <p className="text-[11px] text-slate-500">{item.sku || item.resource_type}</p>
      <p className={`mt-2 text-lg font-semibold ${tone}`}>{expiryLabel(item.days_to_expiry)}</p>
      <p className="text-[11px] text-slate-500">
        {item.monthly_cost !== null
          ? `${money(item.monthly_cost, currency)} per month reverts to pay-as-you-go`
          : 'Monthly cost not available'}
      </p>
      {/* Auto-renew is the difference between a deadline and a note, so it is
          stated rather than left for the reader to check in the portal. */}
      <p className="mt-1 text-[11px] text-slate-500">
        {item.renew ? 'Set to renew automatically.' : 'Will not renew automatically.'}
      </p>
    </div>
  );
}

function Recommendation({ rec, currency }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900">
      <button onClick={() => setOpen(v => !v)} className="flex w-full items-start gap-2 p-3 text-left">
        {open ? <ChevronDown size={12} className="mt-1" /> : <ChevronRight size={12} className="mt-1" />}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium text-slate-100">
            Buy {rec.quantity ?? '?'} × {rec.sku || MISSING}
          </span>
          <span className="text-[11px] text-slate-500">
            {termLabel(rec.term)} · {rec.resource_type}
          </span>
        </span>
        <span className="shrink-0 text-right">
          <span className="block text-xs font-semibold text-emerald-400">
            {money(rec.net_savings, rec.currency || currency)}
          </span>
          <span className="text-[10px] text-slate-500">per month</span>
        </span>
      </button>
      {open && (
        <div className="space-y-1 border-t border-slate-800 px-3 py-2 text-[11px]">
          {[
            ['On-demand cost today', money(rec.cost_without, rec.currency || currency)],
            ['Cost with this purchase', money(rec.cost_with, rec.currency || currency)],
            ['Saving', rec.savings_percent === null ? MISSING : `${rec.savings_percent}%`],
            ['Lookback window', rec.lookback || MISSING],
            ['Scope', rec.scope || MISSING],
          ].map(([label, value]) => (
            <div key={label} className="flex justify-between gap-2">
              <span className="text-slate-500">{label}</span>
              <span className="text-slate-300">{value}</span>
            </div>
          ))}
          {/* Azure's own arithmetic, stated as such. Recomputing it here would
              produce a second, slightly different number with no way to tell
              which one the invoice will agree with. */}
          <p className="pt-1 text-slate-600">
            Savings are Azure&apos;s estimate from your recent usage, not a quote.
            They assume that usage continues.
          </p>
        </div>
      )}
    </div>
  );
}

export default function Commitments() {
  const tenantId = useAppStore(s => s.selectedTenantId);
  const subscriptionIds = useAppStore(s => s.selectedSubscriptionIds);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState(null);

  const [grain, setGrain] = useState(30);
  const [type, setType] = useState('all');
  const [hideExpired, setHideExpired] = useState(true);
  const [query, setQuery] = useState('');

  const ready = Boolean(tenantId) && (subscriptionIds || []).length > 0;

  async function run(nextGrain = grain) {
    if (!ready) return;
    setLoading(true);
    setError('');
    try {
      const result = await fetchCommitments({
        tenant_id: tenantId,
        subscription_ids: subscriptionIds,
        grain: nextGrain,
      });
      setData(result);
      setLastUpdated(new Date().toISOString());
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { setData(null); }, [tenantId, subscriptionIds]);

  const items = useMemo(() => data?.items || [], [data]);
  const currency = data?.currency || '';
  const summary = data?.summary || {};

  const rows = useMemo(
    () => filterCommitments(items, { type, hideExpired, query }),
    [items, type, hideExpired, query],
  );
  const groups = useMemo(() => byResourceType(rows, grain), [rows, grain]);
  const worst = useMemo(() => worstWaste(rows, grain, 5), [rows, grain]);
  const expiredCount = useMemo(
    () => items.filter(i => (i.days_to_expiry ?? 0) < 0).length,
    [items],
  );

  const typeOptions = useMemo(() => TYPE_FILTERS.map(t => ({
    ...t,
    count: t.key === 'all' ? items.length : items.filter(i => i.kind === t.key).length,
  })), [items]);

  return (
    <div className="mx-auto max-w-screen-2xl space-y-4 p-6">
      <PageHeader
        title="Commitments"
        subtitle="Reservations and savings plans: how much of what you bought is actually being used, what lapses soon, and what Azure suggests buying. Utilisation is Azure's own figure; cost is an amortised Cost Management query."
        onRun={() => run()}
        loading={loading}
        disabled={!ready}
        lastUpdated={lastUpdated}
        loaded={Boolean(data)}
      />

      {!ready && <NeedsSelection hasTenant={Boolean(tenantId)} />}
      {error && <Failure message={error} onRetry={() => run()} stale={Boolean(data)} />}

      {ready && !data && !loading && !error && (
        <Empty title="Nothing read yet">
          Press Refresh to read your reservations and savings plans. They are
          held at tenant level, so this reads them once rather than per
          subscription.
        </Empty>
      )}

      {loading && !data && (
        <div className="flex h-64 items-center justify-center gap-2 text-sm text-slate-400">
          <Loader2 size={16} className="animate-spin" /> Reading commitments from Azure…
        </div>
      )}

      {data && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Kpi
              icon={Percent}
              label={`Utilisation (${grain}d)`}
              value={percent(summary.utilisation)}
              hint={summary.utilisation_basis || undefined}
              tone={utilisationTone(summary.utilisation)}
            />
            <Kpi
              icon={Wallet}
              label="Commitment spend"
              value={money(summary.monthly_spend, currency)}
              hint={
                summary.costed < summary.active
                  ? `Covers ${summary.costed} of ${summary.active} active commitments.`
                  : 'Amortised over the last 30 days.'
              }
            />
            <Kpi
              icon={TrendingDown}
              label="Wastage"
              value={money(summary.wastage, currency)}
              hint={
                summary.wastage === null
                  ? 'Needs both a utilisation figure and a cost.'
                  : `Unused share across ${summary.wastage_counted} commitments.`
              }
              tone={summary.wastage ? 'text-rose-400' : 'text-slate-100'}
              accent={summary.wastage ? 'border-rose-500/30' : 'border-slate-800'}
            />
            <Kpi
              icon={CalendarClock}
              label="Next expiry"
              value={expiryLabel(summary.next_expiry_days)}
              hint={summary.next_expiry_name || undefined}
              tone={summary.next_expiry_days !== null && summary.next_expiry_days <= 30
                ? 'text-rose-400' : 'text-slate-100'}
              accent={summary.next_expiry_days !== null && summary.next_expiry_days <= 30
                ? 'border-rose-500/30' : 'border-slate-800'}
            />
          </div>

          <p className="text-xs leading-relaxed text-slate-400">
            {utilisationVerdict(summary, grain)}
          </p>

          {(data.expiring || []).length > 0 && (
            <div className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
              <p className="mb-1 flex items-center gap-2 text-sm font-medium text-slate-200">
                <CalendarClock size={14} /> Expiring soon
                <span className="text-[11px] font-normal text-slate-500">within 90 days</span>
              </p>
              <p className="mb-3 text-[11px] leading-relaxed text-slate-500">
                When one of these lapses nothing breaks and no alert fires — the
                rate simply reverts to pay-as-you-go and the bill goes up.
              </p>
              <div className="flex gap-3 overflow-x-auto pb-1">
                {data.expiring.map(item => (
                  <ExpiringCard key={item.id} item={item} currency={currency} />
                ))}
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <Chips options={typeOptions} value={type} onChange={setType} />
            <div className="flex items-center gap-1.5 text-xs text-slate-400">
              <span>Window</span>
              {GRAINS.map(g => (
                <button
                  key={g.key}
                  onClick={() => { setGrain(g.key); run(g.key); }}
                  className={`rounded-lg px-2 py-1 transition ${
                    grain === g.key ? 'bg-slate-800 text-slate-100' : 'hover:text-slate-200'
                  }`}
                >
                  {g.label}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-1.5 text-xs text-slate-400">
              <input
                type="checkbox"
                checked={hideExpired}
                onChange={e => setHideExpired(e.target.checked)}
                className="accent-sky-500"
              />
              Hide expired{expiredCount ? ` (${expiredCount})` : ''}
            </label>
            <div className="relative min-w-[14rem] flex-1">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Search by name, SKU or scope…"
                className="w-full rounded-xl border border-slate-800 bg-slate-900 py-2 pl-9 pr-3 text-sm text-slate-200 placeholder:text-slate-600"
              />
            </div>
          </div>

          <div className="grid gap-4 xl:grid-cols-[1fr_20rem]">
            <div className="space-y-4">
              <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900">
                <p className="border-b border-slate-800 px-4 py-3 text-sm font-medium text-slate-200">
                  Commitment inventory
                  <span className="ml-2 text-[11px] font-normal text-slate-500">
                    worst utilisation first
                  </span>
                </p>
                {rows.length === 0 ? (
                  <p className="px-4 py-6 text-xs text-slate-500">
                    Nothing matches those filters.
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="text-[11px] uppercase tracking-wide text-slate-500">
                        <tr className="border-b border-slate-800">
                          <th className="px-4 py-2 font-medium">Name</th>
                          <th className="px-3 py-2 font-medium">Type</th>
                          <th className="px-3 py-2 font-medium">Commitment</th>
                          <th className="px-3 py-2 font-medium">SKU</th>
                          <th className="px-3 py-2 font-medium">Term</th>
                          <th className="px-3 py-2 font-medium">Expiry</th>
                          <th className="px-3 py-2 font-medium">Utilisation ({grain}d)</th>
                          <th className="px-3 py-2 text-right font-medium">Monthly cost</th>
                          <th className="px-4 py-2 text-right font-medium">Wasted</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map(item => {
                          const used = usedAt(item, grain);
                          const lost = wastageOf(item, grain);
                          return (
                            <tr key={item.id} className="border-b border-slate-800/60 last:border-0">
                              <td className="max-w-[14rem] truncate px-4 py-2 text-slate-200" title={item.name}>
                                {item.name || MISSING}
                              </td>
                              <td className="px-3 py-2"><Kind kind={item.kind} /></td>
                              <td className="px-3 py-2 text-slate-400">
                                {item.quantity === null ? MISSING
                                  : `${item.quantity} ${item.quantity_unit}`}
                              </td>
                              <td className="px-3 py-2 text-slate-400">{item.sku || MISSING}</td>
                              <td className="px-3 py-2 text-slate-400">{termLabel(item.term)}</td>
                              <td className={`px-3 py-2 ${EXPIRY_TONE[item.expiry_band] || 'text-slate-400'}`}>
                                {expiryLabel(item.days_to_expiry)}
                              </td>
                              <td className="px-3 py-2"><Bar used={used} /></td>
                              <td className="px-3 py-2 text-right tabular-nums text-slate-300">
                                {money(item.monthly_cost, item.currency || currency)}
                              </td>
                              <td className={`px-4 py-2 text-right tabular-nums ${
                                lost ? 'text-rose-400' : 'text-slate-500'
                              }`}>
                                {money(lost, item.currency || currency)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {groups.length > 0 && (
                <div className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
                  <p className="mb-1 text-sm font-medium text-slate-200">
                    Utilisation by what it covers
                  </p>
                  <p className="mb-3 text-[11px] text-slate-500">
                    Averaged only across commitments Azure has measured. Groups
                    with nothing measured are left out rather than drawn at zero.
                  </p>
                  <div className="space-y-2">
                    {groups.map(group => (
                      <div key={group.name} className="flex items-center gap-3">
                        <span className="w-36 shrink-0 truncate text-xs text-slate-400">
                          {group.name}
                        </span>
                        <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-800">
                          <div className={`h-full rounded-full ${utilisationBar(group.used)}`}
                            style={{ width: `${Math.max(2, Math.min(100, group.used))}%` }} />
                        </div>
                        <span className={`w-14 text-right text-xs tabular-nums ${utilisationTone(group.used)}`}>
                          {percent(group.used, 0)}
                        </span>
                        <span className="w-16 text-right text-[11px] text-slate-600">
                          {group.count} item{group.count === 1 ? '' : 's'}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="space-y-3">
              {worst.length > 0 && (
                <div className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
                  <p className="mb-1 flex items-center gap-2 text-sm font-medium text-slate-200">
                    <TrendingDown size={14} /> Costing the most while unused
                  </p>
                  {/* Ranked by measured waste, not by low utilisation. A
                      60%-used reservation costing a little is a smaller problem
                      than an 88%-used one costing a great deal. */}
                  <p className="mb-3 text-[11px] leading-relaxed text-slate-500">
                    Ranked by money, not by percentage.
                  </p>
                  <div className="space-y-2">
                    {worst.map(({ item, lost }) => (
                      <div key={item.id} className="flex items-start justify-between gap-2">
                        <span className="min-w-0">
                          <span className="block truncate text-xs text-slate-200">{item.name}</span>
                          <span className="text-[11px] text-slate-500">
                            {percent(usedAt(item, grain))} used · {KIND_FULL[item.kind]}
                          </span>
                        </span>
                        <span className="shrink-0 text-right text-xs font-medium text-rose-400">
                          {money(lost, item.currency || currency)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
                <p className="mb-1 flex items-center gap-2 text-sm font-medium text-slate-200">
                  <ShoppingCart size={14} /> Suggested purchases
                  {(data.recommendations || []).length > 0 && (
                    <span className="text-[11px] font-normal text-slate-500">
                      {data.recommendations.length}
                    </span>
                  )}
                </p>
                {(data.recommendations || []).length === 0 ? (
                  <p className="text-[11px] leading-relaxed text-slate-500">
                    Azure returned no purchase recommendations for the selected
                    subscriptions. That can mean your usage is already covered,
                    or that it is too variable for Azure to recommend a
                    commitment against.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {data.recommendations.slice(0, 8).map(rec => (
                      <Recommendation key={rec.id} rec={rec} currency={currency} />
                    ))}
                  </div>
                )}
              </div>

              <div className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
                <p className="flex items-start gap-2 text-[11px] leading-relaxed text-slate-400">
                  <Info size={12} className="mt-0.5 shrink-0" />
                  {data.note}
                </p>
                {(data.errors || []).map(err => (
                  <p key={err} className="mt-2 text-[11px] leading-relaxed text-amber-300/80">
                    {err}
                  </p>
                ))}
                {(data.partial?.cost_subscriptions || []).length > 0 && (
                  <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
                    Cost could not be read for{' '}
                    {data.partial.cost_subscriptions.length} subscription(s), so
                    some commitments show no amount.
                  </p>
                )}
                <a
                  href="https://portal.azure.com/#view/Microsoft_Azure_Reservations/ReservationsBrowseBlade"
                  target="_blank"
                  rel="noreferrer"
                  className="mt-3 flex items-center justify-center gap-2 rounded-lg border border-slate-700 py-2 text-xs font-medium text-slate-300 transition hover:bg-slate-800"
                >
                  <ExternalLink size={12} /> Manage in Azure Portal
                </a>
              </div>
            </div>
          </div>
        </>
      )}

      {data && items.length === 0 && (
        <Empty title="No reservations or savings plans">
          <span className="flex items-start gap-2">
            <PiggyBank size={14} className="mt-0.5 shrink-0" />
            Every eligible resource is being billed at pay-as-you-go rates. The
            Suggested purchases panel shows whether Azure thinks a commitment
            would pay for itself.
          </span>
        </Empty>
      )}
    </div>
  );
}
