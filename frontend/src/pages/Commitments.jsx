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
  AlertTriangle, Ban, ArrowUp, ArrowDown, ChevronsUpDown, X,
} from 'lucide-react';
import { fetchCommitments } from '../api/client';
import {
  PageHeader, NeedsSelection, Failure, Empty, Chips,
} from '../components/Security/SecurityShell';
import { useAppStore } from '../store/useAppStore';
import CommitmentRules from '../components/Commitments/CommitmentRules';
import CommitmentDetail from '../components/Commitments/CommitmentDetail';
import { friendlyError } from '../utils/apiError';
import { cancellationImpact } from '../utils/commitmentRules';
import {
  GRAINS, TYPE_FILTERS, KIND_LABEL, KIND_FULL, EXPIRY_TONE, EXPIRY_LABEL,
  MISSING, percent, money, termLabel, expiryLabel, filterCommitments, usedAt,
  wastageOf, wastageBasis, byResourceType, worstWaste, utilisationTone, utilisationBar,
  utilisationVerdict, sortCommitments,
} from '../utils/commitments';

/**
 * What cancelling one specific commitment would mean.
 *
 * Opened from the row rather than shown always, because most commitments are
 * not cancellation candidates and a permanent block of warnings beside a
 * healthy reservation trains people to stop reading them. A blocker is drawn
 * differently from a cost so that "you cannot" and "you can, but" are never
 * mistaken for one another.
 */
/*
 * Tinted with a /10 overlay on the 500 step rather than a 950 background.
 * The light theme remaps the slate ramp and the 300/400 accent steps but not
 * the 900/950 ones, so `bg-rose-950/30` stayed a dark plum on a white page and
 * read as mud. An overlay works on both themes because it is the surface
 * underneath doing the work.
 */
const IMPACT_TONE = {
  blocker: { icon: Ban, wrap: 'border-rose-500/40 bg-rose-500/10', text: 'text-rose-300' },
  cost: { icon: AlertTriangle, wrap: 'border-amber-500/40 bg-amber-500/10', text: 'text-amber-300' },
  note: { icon: Info, wrap: 'border-slate-800 bg-slate-900/60', text: 'text-slate-400' },
};

function Impact({ item, grain }) {
  const notes = useMemo(() => cancellationImpact(item, { grain }), [item, grain]);
  if (notes.length === 0) return null;
  return (
    <div className="space-y-2">
      <p className="text-[11px] uppercase tracking-wide text-slate-500">
        If you cancel {item.name || 'this commitment'}
      </p>
      {notes.map(note => {
        const tone = IMPACT_TONE[note.severity] || IMPACT_TONE.note;
        const Glyph = tone.icon;
        return (
          <div key={note.id} className={`flex gap-2.5 rounded-xl border p-3 ${tone.wrap}`}>
            <Glyph size={14} className={`mt-0.5 shrink-0 ${tone.text}`} />
            <div className="min-w-0">
              <p className={`text-xs font-medium ${tone.text}`}>{note.title}</p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-slate-400">{note.detail}</p>
              {note.source && (
                <a
                  href={note.source.url}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 inline-flex items-center gap-1 text-[11px] text-sky-400 hover:text-sky-300"
                >
                  {note.source.title} <ExternalLink size={10} />
                </a>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

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

/**
 * A column heading that sorts.
 *
 * The arrow is drawn faintly on every sortable column rather than only on the
 * active one, because a control that appears on hover is a control nobody
 * knows is there. `aria-sort` carries the same state to a screen reader, which
 * cannot see the arrow at all.
 */
function SortHead({ label, column, sort, onSort, align = 'left', title, pad = 'px-3' }) {
  const active = sort.key === column;
  const Glyph = active ? (sort.dir === 'asc' ? ArrowUp : ArrowDown) : ChevronsUpDown;
  return (
    <th
      className={`${pad} py-2 font-medium ${align === 'right' ? 'text-right' : ''}`}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        title={title}
        onClick={() => onSort(column)}
        className={`inline-flex items-center gap-1 uppercase tracking-wide transition hover:text-slate-200 ${
          align === 'right' ? 'flex-row-reverse' : ''
        } ${active ? 'text-slate-200' : ''}`}
      >
        {label}
        <Glyph size={11} className={active ? 'text-sky-400' : 'text-slate-600'} />
      </button>
    </th>
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

/*
 * The page answers three separate questions, and stacking them made the third
 * one unreachable: four full-height summary cards, a row of expiring cards and
 * a filter bar sat above the inventory, so the table everybody came for started
 * below the fold on a laptop. They are sections now rather than one long
 * scroll. The counts are on the tabs because a section worth opening and an
 * empty one should not look the same from the outside.
 */
const VIEWS = [
  { key: 'overview', label: 'Overview' },
  { key: 'details', label: 'Commitment details' },
  { key: 'rules', label: 'Cancellation rules' },
];

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
  // Untouched, this keeps the order the backend sent -- worst utilisation
  // first -- so the page still opens on the problem rather than on an
  // alphabetical list. A column is only applied once somebody asks for it.
  const [sort, setSort] = useState({ key: '', dir: 'asc' });
  // The full record for one commitment, in a panel rather than a row. Held by
  // id rather than by object so a refresh replaces what is on screen instead
  // of pinning the reader to the copy that was fetched when they opened it.
  const [detailFor, setDetailFor] = useState(null);
  // Which tab the drawer opens on. Clicking the row wants the record; clicking
  // "What happens" wants the cancellation rules and nothing else.
  const [detailTab, setDetailTab] = useState('overview');
  // Opens on the inventory rather than the summary. Somebody arriving here has
  // usually already been told there is a problem and wants the list.
  const [view, setView] = useState('details');

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

  const filtered = useMemo(
    () => filterCommitments(items, { type, hideExpired, query }),
    [items, type, hideExpired, query],
  );
  const rows = useMemo(
    () => (sort.key ? sortCommitments(filtered, sort.key, sort.dir, grain) : filtered),
    [filtered, sort, grain],
  );

  /*
   * First click on a column sorts the way that column is usually read: text
   * from A, money and waste from the largest. Sorting cost ascending puts the
   * cheapest reservation at the top, which is never why anybody clicks "Monthly
   * cost".
   */
  function toggleSort(key) {
    setSort(prev => {
      if (prev.key === key) return { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' };
      const descFirst = ['cost', 'wastage', 'utilisation'].includes(key);
      return { key, dir: descFirst ? 'desc' : 'asc' };
    });
  }

  const filtersOn = type !== 'all' || Boolean(query.trim()) || !hideExpired || Boolean(sort.key);

  function clearFilters() {
    setType('all');
    setQuery('');
    setHideExpired(true);
    setSort({ key: '', dir: 'asc' });
  }

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
        subtitle="What you have bought up front, how much of it is being used, and what lapses soon."
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
          <div className="flex flex-wrap items-center gap-1 border-b border-slate-800">
            {VIEWS.map(v => (
              <button
                key={v.key}
                onClick={() => setView(v.key)}
                aria-current={view === v.key ? 'page' : undefined}
                className={`-mb-px border-b-2 px-3 py-2 text-sm transition ${
                  view === v.key
                    ? 'border-sky-500 text-slate-100'
                    : 'border-transparent text-slate-500 hover:text-slate-300'
                }`}
              >
                {v.label}
                {v.key === 'details' && items.length > 0 && (
                  <span className="ml-1.5 text-[11px] text-slate-500">{items.length}</span>
                )}
                {/* An expiry is a deadline, so the count that matters on the
                    summary tab is drawn in its own colour rather than as one
                    more grey number the eye skips. */}
                {v.key === 'overview' && (data.expiring || []).length > 0 && (
                  <span className="ml-1.5 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
                    {data.expiring.length} expiring
                  </span>
                )}
              </button>
            ))}
          </div>

          {view === 'overview' && (
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
                summary.monthly_spend === null
                  ? 'Cost Management returned no benefit charges for the selected '
                    + 'subscriptions. Amortised cost lands on the subscriptions that used '
                    + 'the benefit, so select those too, or check Cost Management access.'
                  : summary.costed < summary.active
                    ? `Amortised over the last 30 days. Covers ${summary.costed} of `
                      + `${summary.active} active commitments — the rest returned no charges.`
                    : 'Amortised over the last 30 days.'
              }
            />
            <Kpi
              icon={TrendingDown}
              label="Wastage"
              value={money(summary.wastage, currency)}
              hint={
                summary.wastage === null
                  ? 'Needs either Azure’s own unused-benefit charge or both a utilisation '
                    + 'figure and a cost. Neither came back for these commitments.'
                  : summary.wastage_measured
                    ? `Across ${summary.wastage_counted} commitments, `
                      + `${summary.wastage_measured} of them billed by Azure as unused.`
                    : `Unused share across ${summary.wastage_counted} commitments, worked `
                      + 'out from utilisation rather than billed.'
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
          </>
          )}

          {view === 'details' && (
          <>
          {/* Sticky, because the inventory is long enough that the search box
              scrolls away, and the usual response to a table that will not
              narrow is to scroll back up hunting for the filter rather than to
              type. */}
          <div className="sticky top-0 z-20 -mx-6 flex flex-wrap items-center gap-3 border-b border-slate-800 bg-slate-950/90 px-6 py-3 backdrop-blur">
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
                className="w-full rounded-xl border border-slate-800 bg-slate-900 py-2 pl-9 pr-8 text-sm text-slate-200 placeholder:text-slate-600"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  aria-label="Clear search"
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-slate-500 hover:text-slate-200"
                >
                  <X size={12} />
                </button>
              )}
            </div>
            {/* Says how much of the inventory is hidden, and offers the way
                back. A filtered table and a small estate look identical, and
                somebody who forgets a filter is on concludes they own two
                reservations. */}
            {filtersOn && (
              <div className="flex items-center gap-2 text-[11px] text-slate-500">
                <span>Showing {rows.length} of {items.length}</span>
                <button
                  type="button"
                  onClick={clearFilters}
                  className="rounded-lg border border-slate-700 px-2 py-1 text-slate-300 transition hover:border-slate-500 hover:text-white"
                >
                  Reset
                </button>
              </div>
            )}
          </div>

          <div className="grid gap-4 xl:grid-cols-[1fr_20rem]">
            <div className="space-y-4">
              <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900">
                <p className="border-b border-slate-800 px-4 py-3 text-sm font-medium text-slate-200">
                  Commitment inventory
                  <span className="ml-2 text-[11px] font-normal text-slate-500">
                    {sort.key ? 'sorted by the column you chose' : 'worst utilisation first'}
                  </span>
                  {/* Moved off the page header, which had grown into a
                      paragraph nobody read. It belongs beside the figures it
                      describes: "used" is Azure's own measurement and "per
                      month" is a billing query, and a reader deciding whether
                      to cancel something needs to know which is which. */}
                  <span className="mt-0.5 block text-[11px] font-normal text-slate-500">
                    Used is Azure&apos;s own figure. Per month is amortised cost from
                    Cost Management, and is blank when that query returned nothing.
                  </span>
                </p>
                {rows.length === 0 ? (
                  <div className="px-4 py-6">
                    <p className="text-xs text-slate-500">Nothing matches those filters.</p>
                    {filtersOn && (
                      <button
                        type="button"
                        onClick={clearFilters}
                        className="mt-3 rounded-lg border border-slate-700 px-2.5 py-1.5 text-[11px] text-slate-300 transition hover:border-slate-500 hover:text-white"
                      >
                        Clear filters and show all {items.length}
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      {/* Sticky, because the inventory is the one table here
                          long enough to scroll a heading off the top -- and a
                          column of percentages with no heading above it is a
                          column of numbers nobody can read. Offset by the
                          height of the filter bar above it, which is sticky
                          too and would otherwise cover it. */}
                      <thead className="sticky top-[3.25rem] z-10 bg-slate-900 text-[11px] uppercase tracking-wide text-slate-500">
                        <tr className="border-b border-slate-800">
                          <SortHead label="Commitment" column="name" sort={sort} onSort={toggleSort} pad="px-4" />
                          <th className="px-3 py-2 font-medium">What it covers</th>
                          <SortHead
                            label="Expiry"
                            column="expiry"
                            sort={sort}
                            onSort={toggleSort}
                            title="Soonest first"
                          />
                          <SortHead
                            label={`Used (${grain}d)`}
                            column="utilisation"
                            sort={sort}
                            onSort={toggleSort}
                          />
                          <SortHead
                            label="Per month"
                            column="cost"
                            sort={sort}
                            onSort={toggleSort}
                            align="right"
                          />
                          <SortHead
                            label="Wasted"
                            column="wastage"
                            sort={sort}
                            onSort={toggleSort}
                            align="right"
                          />
                          <th className="px-4 py-2 text-right font-medium">
                            <span className="sr-only">Cancellation</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map(item => {
                          const used = usedAt(item, grain);
                          const lost = wastageOf(item, grain);
                          const basis = wastageBasis(item, grain);
                          return (
                            /* The whole row opens the record, not just the
                               name. A single underlined word in the first
                               column is a target people do not find, and every
                               cell in the row is about the same commitment.

                               Reachable from the keyboard as well as the
                               mouse: the row is the only way into the full
                               record, so a keyboard user who could not open it
                               could not read half of this page. */
                            <tr
                              key={item.id}
                              tabIndex={0}
                              role="button"
                              aria-label={`Open ${item.name || 'commitment'}`}
                              onClick={() => { setDetailTab('overview'); setDetailFor(item.id); }}
                              onKeyDown={(e) => {
                                if (e.key !== 'Enter' && e.key !== ' ') return;
                                e.preventDefault();
                                setDetailTab('overview');
                                setDetailFor(item.id);
                              }}
                              className="cursor-pointer border-b border-slate-800/60 hover:bg-slate-800/40 focus:bg-slate-800/60 focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-sky-500"
                            >
                              <td className="max-w-[18rem] px-4 py-2.5">
                                {/* Name, type and SKU in one cell. They were
                                    three columns, which pushed the two figures
                                    people actually came for off the right edge
                                    on a laptop — and a number nobody scrolls to
                                    is a number nobody reads. */}
                                <span className="flex items-center gap-1.5">
                                  <span className="truncate text-slate-200" title={item.name}>
                                    {item.name || MISSING}
                                  </span>
                                  <Kind kind={item.kind} />
                                  <ChevronRight size={12} className="shrink-0 text-slate-600" />
                                </span>
                                <span className="block truncate text-[11px] text-slate-500" title={item.sku || ''}>
                                  {item.sku || MISSING}
                                </span>
                              </td>
                              <td className="px-3 py-2.5 text-slate-400">
                                {item.quantity === null ? MISSING
                                  : `${item.quantity} ${item.quantity_unit}`}
                                <span className="block text-[11px] text-slate-500">
                                  {termLabel(item.term)}
                                </span>
                              </td>
                              <td className={`px-3 py-2.5 ${EXPIRY_TONE[item.expiry_band] || 'text-slate-400'}`}>
                                {expiryLabel(item.days_to_expiry)}
                              </td>
                              <td className="px-3 py-2.5"><Bar used={used} /></td>
                              <td className="px-3 py-2.5 text-right tabular-nums text-slate-300">
                                {money(item.monthly_cost, item.currency || currency)}
                              </td>
                              <td className={`px-3 py-2.5 text-right tabular-nums ${
                                lost ? 'text-rose-400' : 'text-slate-500'
                              }`}>
                                {money(lost, item.currency || currency)}
                                {/* Says whether Azure billed this or we worked it
                                    out, because one is evidence and the other is
                                    an inference and they should not read alike. */}
                                {basis && (
                                  <span className="block text-[10px] font-normal text-slate-600">
                                    {basis === 'measured' ? 'billed as unused' : 'from utilisation'}
                                  </span>
                                )}
                              </td>
                              <td className="px-4 py-2.5 text-right">
                                {/* Opens the record on its cancellation tab
                                    rather than unfolding a second row. An
                                    expanding row pushed the rest of the table
                                    down and put the rules in a 10-column cell
                                    barely wide enough to read them. */}
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setDetailTab('cancel');
                                    setDetailFor(item.id);
                                  }}
                                  title="What happens if this is cancelled"
                                  className="inline-flex items-center gap-1 rounded-lg border border-slate-700 px-2 py-1 text-[11px] text-slate-400 transition hover:border-slate-500 hover:text-white"
                                >
                                  If cancelled
                                </button>
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
                  <p className="mb-3 text-sm font-medium text-slate-200">
                    Utilisation by what it covers
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
                  <p className="mb-3 flex items-center gap-2 text-sm font-medium text-slate-200">
                    <TrendingDown size={14} /> Costing the most while unused
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
                    Azure returned no purchase recommendations.
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
                {(data.errors || []).map(err => (
                  <p key={err} className="mb-2 text-[11px] leading-relaxed text-amber-300/80">
                    {err}
                  </p>
                ))}
                {(data.partial?.cost_subscriptions || []).length > 0 && (
                  <p className="mb-2 text-[11px] leading-relaxed text-slate-500">
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

      {/* Reference, not measurement -- and deliberately available before any
          tenant is selected, because the question "what does it cost to get out
          of this" is usually asked before anyone signs in to check. That is
          also why it is shown when nothing has been read yet rather than only
          behind its own tab. */}
      {(!data || view === 'rules') && (
        <div className="border-t border-slate-800 pt-6">
          <CommitmentRules items={items} currency={currency} />
        </div>
      )}

      {/* Looked up in the current list rather than stored, so a refresh while
          the panel is open shows the new figures instead of the ones that were
          fetched when it was opened. A commitment that vanished from the list
          closes the panel rather than freezing a record that no longer exists. */}
      {detailFor && (() => {
        const item = items.find(i => i.id === detailFor);
        if (!item) return null;
        return (
          <CommitmentDetail
            item={item}
            grain={grain}
            currency={currency}
            initialTab={detailTab}
            onClose={() => setDetailFor(null)}
          >
            <Impact item={item} grain={grain} />
          </CommitmentDetail>
        );
      })()}
    </div>
  );
}
