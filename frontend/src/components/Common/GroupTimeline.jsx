/**
 * Everything that happened inside one resource group — spend and operations on
 * the same axis.
 *
 * The cost table answers what a group spends. The Activity Log answers what was
 * done to it. Separately, each leaves the obvious question unanswered: the bill
 * jumped on the 14th, and who changed something on the 14th? So both are read
 * and merged onto one day-by-day timeline, and the graph above gives the shape
 * the list cannot.
 *
 * The panel opens on what matters rather than on everything. A resource group
 * with two hundred routine writes in it has a real story of four or five
 * events, and printing all two hundred in arrival order is how a history stops
 * being read — the reader scrolls, finds nothing but "Created or updated", and
 * concludes the page has nothing to say. So the first tab keeps the days the
 * bill moved, the deletions, and the failures; the full log is one click away
 * and unabridged, because a summary nobody can check is not evidence.
 *
 * A cost movement and an operation are still labelled apart. A movement is
 * derived from billing data and knows nothing about intent; an operation is an
 * exact record of somebody doing something. Rendering them identically would
 * invite the reader to treat a coincidence of dates as a cause, which on a busy
 * group is frequently wrong.
 *
 * Two honesty constraints on the operations half. Azure keeps ninety days and
 * no more, so a group older than that has a history this cannot reach — said
 * out loud, because an empty list reads as "nothing happened". And a failed
 * operation is marked failed: an attempt to delete a database and a deleted
 * database are not the same event.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import {
  AlertTriangle, ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Clock, GitCompareArrows,
  Loader2, MinusCircle, PencilLine, PlusCircle, Search, Sparkles, ScrollText, Wallet,
} from 'lucide-react';
import { fetchActivity, fetchChanges, fetchDailyCosts } from '../../api/client';
import ResourceTimeline from './ResourceTimeline';
import { friendlyError } from '../../utils/apiError';
import { describeResourceId } from '../../utils/azureSku';
import { shortType, summariseChange } from '../../utils/changeSummary';
import { toEntries } from '../../utils/changeTree';
import { formatAmount } from '../../utils/currency';
import { dayTimeline } from '../../utils/boqTrend';

// Azure keeps ninety days of operations and no more. Everything is read once at
// that full depth and narrowed in the browser, so changing the date range costs
// nothing and does not spend another cost-query allowance.
const RETENTION_DAYS = 90;
const COST_MONTHS = 3;

const PRESETS = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
];

const HAS_ZONE = /(Z|[+-]\d{2}:?\d{2})$/;

/** Azure timestamps carry their own zone; appending a Z would invalidate them. */
function asDate(timestamp) {
  if (!timestamp) return null;
  const date = new Date(HAS_ZONE.test(timestamp) ? timestamp : `${timestamp.replace(' ', 'T')}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function moment(timestamp) {
  const date = asDate(timestamp);
  return date ? date.toLocaleString() : (timestamp || '—');
}

/**
 * The calendar day a timestamp belongs to, in UTC.
 *
 * Azure bills by UTC day, so an operation is matched to the cost day Azure
 * would have charged it to. Bucketing by the reader's local day instead would
 * slide events onto the wrong bar for anyone east or west of UTC — which is
 * exactly the reader who would then blame the wrong change.
 */
function utcDay(timestamp) {
  const date = asDate(timestamp);
  return date ? date.toISOString().slice(0, 10) : '';
}

function isoDaysAgo(n) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - n);
  return date.toISOString().slice(0, 10);
}

function readableDay(iso) {
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

const COST_KIND = {
  spike: { tone: 'text-red-300', Icon: ArrowUp },
  drop: { tone: 'text-emerald-300', Icon: ArrowDown },
  started: { tone: 'text-blue-300', Icon: Wallet },
  stopped: { tone: 'text-slate-300', Icon: Wallet },
  over: { tone: 'text-amber-300', Icon: AlertTriangle },
};

/** Whether an operation deletes something, read from the ARM operation name. */
function isDelete(event) {
  return String(event.operation || '').toLowerCase().endsWith('/delete');
}

const DIFF_KIND = {
  added: { Icon: PlusCircle, label: 'Added', tone: 'text-emerald-300', dot: 'bg-emerald-400' },
  removed: { Icon: MinusCircle, label: 'Removed', tone: 'text-red-300', dot: 'bg-red-400' },
  modified: { Icon: PencilLine, label: 'Modified', tone: 'text-amber-300', dot: 'bg-amber-400' },
};

/**
 * One resource as the captures saw it, with the fields that moved.
 *
 * The Activity Log says an update was requested; this says what the resource
 * looked like either side of it. They are different evidence and are shown as
 * different things: an operation can succeed and change nothing, and a field
 * can differ between captures with no operation naming it -- somebody used the
 * portal outside the retention window, or Azure changed it on their behalf.
 */
function DiffRow({ entry, onOpen }) {
  const meta = DIFF_KIND[entry.kind] || DIFF_KIND.modified;
  const fields = entry.kind === 'modified' ? (entry.changes || []) : [];
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(entry)}
        title="Open this resource's own history"
        className="flex w-full gap-2.5 rounded-lg px-1.5 py-1 text-left transition hover:bg-slate-900"
      >
        <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${meta.dot}`} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-[11px] text-slate-200">{entry.name || entry.resource_id}</span>
            <span className={`shrink-0 text-[10px] ${meta.tone}`}>{meta.label}</span>
            <ChevronRight className="h-3 w-3 shrink-0 text-slate-600" />
          </span>
          <span className="block truncate text-[11px] text-slate-500">
            {[shortType(entry.type), entry.location].filter(Boolean).join(' · ')}
          </span>
          {fields.length > 0 && (
            <span className="mt-0.5 block space-y-0.5">
              {fields.slice(0, 4).map(change => (
                <span key={change.field} className="block truncate text-[10px] text-slate-400">
                  {summariseChange(change)}
                </span>
              ))}
              {fields.length > 4 && (
                <span className="block text-[10px] text-slate-600">
                  and {fields.length - 4} more field{fields.length - 4 === 1 ? '' : 's'}
                </span>
              )}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

/** A figure, or an honest statement that there is no figure. */
function Figure({ label, value, hint }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-2.5">
      <p className="text-[10px] uppercase tracking-wide text-slate-500">{label}</p>
      {value == null
        ? <p className="mt-0.5 text-[12px] text-slate-600">Not available</p>
        : <p className="mt-0.5 text-[13px] font-semibold text-slate-100">{value}</p>}
      {hint && <p className="mt-0.5 text-[10px] text-slate-500">{hint}</p>}
    </div>
  );
}

function OperationRow({ event, onOpen }) {
  const { name, service } = describeResourceId(event.resource_id);
  const facts = [name, service].filter(Boolean).join(' · ');
  // An operation names a resource, and the reader's next question is almost
  // always about that resource rather than about the group. Only offered when
  // there is an id to open: a subscription-level operation has no resource
  // history to show, and a button that does nothing is worse than no button.
  const openable = Boolean(onOpen && event.resource_id);
  const body = (
    <div className="min-w-0 flex-1">
      <p className="text-[11px] text-slate-200">
        {event.summary}
        {event.succeeded === false && (
          <span className="ml-1.5 text-[10px] text-red-300">failed</span>
        )}
      </p>
      {!!facts && (
        <p className="flex items-center gap-1 truncate text-[11px] text-slate-500">
          {facts}
          {openable && <ChevronRight className="h-3 w-3 shrink-0 text-slate-600" />}
        </p>
      )}
      <p className="text-[10px] text-slate-500">
        {moment(event.at)} · {event.caller || 'unknown caller'}
      </p>
    </div>
  );

  return (
    <li className="flex gap-2.5">
      <span
        className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
          event.succeeded === false ? 'bg-red-400' : isDelete(event) ? 'bg-amber-400' : 'bg-blue-400'
        }`}
      />
      {openable ? (
        <button
          type="button"
          onClick={() => onOpen({ resource_id: event.resource_id, name, type: '' })}
          title="Open this resource's own history"
          className="min-w-0 flex-1 rounded-lg px-1.5 py-0.5 text-left transition hover:bg-slate-900"
        >
          {body}
        </button>
      ) : body}
    </li>
  );
}

function CostMovement({ event, currency }) {
  const meta = COST_KIND[event.kind] || COST_KIND.started;
  return (
    <div className="mt-1 rounded-lg border border-slate-800 bg-slate-900/50 px-2.5 py-2">
      <p className={`flex flex-wrap items-center gap-1.5 text-[11px] font-medium ${meta.tone}`}>
        <meta.Icon className="h-3 w-3 shrink-0" />
        {event.title}
        {event.delta != null && (
          <span className="font-semibold">
            {event.delta > 0 ? '+' : ''}{formatAmount(event.delta, currency)}
            {event.deltaPct != null && ` (${event.deltaPct > 0 ? '+' : ''}${event.deltaPct.toFixed(0)}%)`}
          </span>
        )}
      </p>
      <p className="mt-0.5 text-[10px] text-slate-500">
        {formatAmount(event.total, currency)} billed that day
        {event.drivers?.length > 0 && ' · '}
        {event.drivers?.map(d => `${d.name} ${d.delta > 0 ? '+' : ''}${formatAmount(d.delta, currency)}`).join(', ')}
      </p>
    </div>
  );
}

export default function GroupTimeline({ tenantId, subscriptionIds, resourceGroup }) {
  // Both halves are keyed by the request rather than paired with loading flags.
  // A flag has to be set synchronously inside the effect to avoid showing the
  // previous group's history for a frame; deriving it instead means the stale
  // result simply cannot be rendered.
  const [acts, setActs] = useState({ key: null, events: [], error: '' });
  const [costs, setCosts] = useState({ key: null, days: [], currency: 'USD', error: '' });
  const [diffs, setDiffs] = useState({ key: null, entries: [], error: '', comparable: false, before: null, after: null });
  // Null means "nobody has chosen yet", which is not the same as "key". The
  // opening tab depends on what actually loaded, and that is not known when
  // this state is created -- deriving it below rather than correcting it in an
  // effect avoids showing an empty tab for a frame first.
  const [tab, setTab] = useState(null);
  const [query, setQuery] = useState('');
  const [preset, setPreset] = useState(30);
  const [custom, setCustom] = useState({ from: '', to: '' });
  // One resource, opened from any list here. Rendered in place rather than in a
  // second panel over the first: this component is already inside a drawer, and
  // stacking two of them leaves the reader unsure which close button returns
  // them to the group and which closes everything.
  const [openResource, setOpenResource] = useState(null);

  const subKey = (subscriptionIds || []).join(',');
  const requestKey = `${tenantId}|${subKey}|${resourceGroup}`;

  useEffect(() => {
    if (!tenantId || !resourceGroup || !subKey) return undefined;
    let live = true;

    fetchActivity(tenantId, subKey.split(','), {
      days: RETENTION_DAYS, resourceGroup, writesOnly: true,
    })
      .then(d => { if (live) setActs({ key: requestKey, events: d.events || [], error: '' }); })
      .catch(e => { if (live) setActs({ key: requestKey, events: [], error: friendlyError(e) }); });

    // Deliberately a separate request with its own error. Cost reads get
    // throttled and activity reads need a different permission, so one failing
    // must not blank the other — half a timeline beats none, as long as the
    // missing half says why it is missing.
    fetchDailyCosts({
      tenant_id: tenantId,
      subscription_ids: subKey.split(','),
      months: COST_MONTHS,
      resource_group: resourceGroup,
    })
      .then(d => {
        if (live) {
          setCosts({ key: requestKey, days: d.days || [], currency: d.currency || 'USD', error: '' });
        }
      })
      .catch(e => {
        if (live) setCosts({ key: requestKey, days: [], currency: 'USD', error: friendlyError(e) });
      });

    return () => { live = false; };
  }, [tenantId, subKey, resourceGroup, requestKey]);

  // The chosen window, as two dates. A custom range only takes effect once both
  // ends are set: applying a half-finished range would silently show a period
  // nobody asked for.
  const window_ = useMemo(() => {
    const complete = custom.from && custom.to && custom.from <= custom.to;
    return complete
      ? { from: custom.from, to: custom.to, custom: true }
      : { from: isoDaysAgo(preset), to: isoDaysAgo(0), custom: false };
  }, [custom, preset]);

  // The stored captures either side of the window.
  //
  // Refetched when the window moves, unlike the two above. That looks
  // inconsistent until you notice this one never calls Azure: it reads
  // snapshots this app already took, so it cannot be throttled and costs no
  // quota. Narrowing it in the browser instead would mean asking for ninety
  // days of diff to answer a question about seven.
  const diffKey = `${requestKey}|${window_.from}|${window_.to}`;

  useEffect(() => {
    if (!tenantId || !resourceGroup) return undefined;
    let live = true;

    fetchChanges(tenantId, { from_date: window_.from, to_date: window_.to })
      .then((d) => {
        if (!live) return;
        const mine = toEntries(d).filter(
          e => String(e.resource_group || '').toLowerCase() === String(resourceGroup).toLowerCase(),
        );
        setDiffs({
          key: diffKey,
          entries: mine,
          error: '',
          comparable: Boolean(d.comparable),
          before: d.before || null,
          after: d.after || null,
        });
      })
      .catch((e) => {
        if (live) {
          setDiffs({
            key: diffKey, entries: [], error: friendlyError(e),
            comparable: false, before: null, after: null,
          });
        }
      });

    return () => { live = false; };
  }, [tenantId, resourceGroup, window_.from, window_.to, diffKey]);

  const events = useMemo(
    () => (acts.key === requestKey ? acts.events : []).filter((e) => {
      const day = utcDay(e.at);
      return day >= window_.from && day <= window_.to;
    }),
    [acts, requestKey, window_],
  );
  const days = useMemo(
    () => (costs.key === requestKey ? costs.days : [])
      .filter(d => d.date >= window_.from && d.date <= window_.to),
    [costs, requestKey, window_],
  );
  const currency = costs.currency;

  const chart = useMemo(
    () => days.map(d => ({ date: d.date, cost: Math.round((d.total || 0) * 100) / 100 })),
    [days],
  );

  const totals = useMemo(() => {
    if (!days.length) return null;
    const spend = days.reduce((sum, d) => sum + (d.total || 0), 0);
    const busiest = days.reduce((a, b) => ((b.total || 0) > (a.total || 0) ? b : a));
    return { spend, busiest, perDay: spend / days.length };
  }, [days]);

  /** The cost movements worth a line of their own, keyed by day. */
  const costEvents = useMemo(() => {
    const map = new Map();
    for (const event of dayTimeline(days, null, { limit: 120 })) map.set(event.date, event);
    return map;
  }, [days]);

  /**
   * The short version: days the bill moved, plus the operations that are
   * consequential on their own terms.
   *
   * A deletion and a failure are always worth a line — one destroys something,
   * the other means somebody tried and could not, and neither shows up in a
   * cost figure. Routine writes are kept only on days the bill also moved,
   * where they are candidates for the explanation rather than noise.
   */
  const highlights = useMemo(() => {
    const buckets = new Map();
    const bucket = (day) => {
      if (!buckets.has(day)) buckets.set(day, { day, ops: [], cost: costEvents.get(day) || null });
      return buckets.get(day);
    };

    for (const [day] of costEvents) bucket(day);
    for (const event of events) {
      const day = utcDay(event.at);
      const notable = event.succeeded === false || isDelete(event) || costEvents.has(day);
      if (notable) bucket(day).ops.push(event);
    }

    return [...buckets.values()].sort((a, b) => b.day.localeCompare(a.day));
  }, [events, costEvents]);

  /** Everything, unabridged, with the search that makes it usable. */
  const log = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const buckets = new Map();
    for (const event of events) {
      if (needle) {
        const { name, service } = describeResourceId(event.resource_id);
        const hit = [event.caller, event.summary, name, service]
          .filter(Boolean)
          .some(field => String(field).toLowerCase().includes(needle));
        if (!hit) continue;
      }
      const day = utcDay(event.at);
      if (!buckets.has(day)) buckets.set(day, { day, ops: [] });
      buckets.get(day).ops.push(event);
    }
    return [...buckets.values()].sort((a, b) => b.day.localeCompare(a.day));
  }, [events, query]);

  if (acts.key !== requestKey) {
    return (
      <p className="flex items-center gap-2 text-[11px] text-slate-400">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Reading cost and Azure&apos;s Activity Log for {resourceGroup}…
      </p>
    );
  }

  const shownOps = log.reduce((n, r) => n + r.ops.length, 0);
  const highlightOps = highlights.reduce((n, r) => n + r.ops.length, 0);
  const changed = diffs.key === diffKey ? diffs.entries : [];

  // Land on the tab that has something in it. Opening on "What matters" when
  // the Activity Log was refused shows an empty list under a banner explaining
  // why, and makes the reader hunt for the tab that works.
  const activeTab = tab ?? (acts.error ? 'diff' : 'key');

  // Drilling into one resource replaces the group view rather than covering it,
  // and the way back is the first thing on screen.
  if (openResource) {
    return (
      <div className="space-y-3">
        <button
          type="button"
          onClick={() => setOpenResource(null)}
          className="flex items-center gap-1.5 text-[11px] text-slate-400 transition hover:text-white"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          Back to {resourceGroup}
        </button>
        <div>
          <p className="text-sm font-medium text-slate-100">{openResource.name || 'This resource'}</p>
          <p className="text-[11px] text-slate-500">
            {[shortType(openResource.type), openResource.location].filter(Boolean).join(' · ')}
          </p>
        </div>
        <ResourceTimeline tenantId={tenantId} resourceId={openResource.resource_id} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* ── The period being read ────────────────────────────────────── */}
      <div className="space-y-2 rounded-lg border border-slate-800 bg-slate-900/40 p-2.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wide text-slate-500">Period</span>
          {PRESETS.map(p => (
            <button
              key={p.days}
              type="button"
              onClick={() => { setPreset(p.days); setCustom({ from: '', to: '' }); }}
              className={`rounded-full px-2.5 py-0.5 text-[11px] transition ${
                !window_.custom && preset === p.days
                  ? 'bg-blue-500/15 text-blue-300'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Last {p.label}
            </button>
          ))}
          <span className="ml-auto flex items-center gap-1.5">
            <input
              type="date"
              value={custom.from}
              max={custom.to || isoDaysAgo(0)}
              min={isoDaysAgo(RETENTION_DAYS)}
              onChange={e => setCustom(c => ({ ...c, from: e.target.value }))}
              className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-white focus:border-blue-500 focus:outline-none"
            />
            <span className="text-[11px] text-slate-500">to</span>
            <input
              type="date"
              value={custom.to}
              min={custom.from || isoDaysAgo(RETENTION_DAYS)}
              max={isoDaysAgo(0)}
              onChange={e => setCustom(c => ({ ...c, to: e.target.value }))}
              className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-white focus:border-blue-500 focus:outline-none"
            />
          </span>
        </div>
        <p className="text-[10px] text-slate-500">
          {/* Both ends stated, because "last 30 days" and a pair of dates are
              not obviously the same window to somebody checking a figure. */}
          Showing {readableDay(window_.from)} to {readableDay(window_.to)}
          {custom.from && custom.to && custom.from > custom.to && (
            <span className="ml-1.5 text-amber-300">
              — the start is after the end, so the preset is still in use.
            </span>
          )}
          {' · '}Azure keeps no operation record older than {RETENTION_DAYS} days.
        </p>
      </div>

      {/* ── What it costs ────────────────────────────────────────────── */}
      {costs.error ? (
        <p className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-950/20 p-2.5 text-[11px] text-amber-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Cost for this group could not be read, so the graph is missing rather than empty.
          {' '}{costs.error}
        </p>
      ) : chart.length > 1 && (
        <div className="space-y-2">
          <div className="grid grid-cols-3 gap-2">
            <Figure
              label="Spend in this period"
              value={formatAmount(totals.spend, currency)}
              hint={`${days.length} billed days`}
            />
            <Figure
              label="Typical day"
              value={formatAmount(totals.perDay, currency)}
              hint="Total ÷ billed days"
            />
            <Figure
              label="Most expensive day"
              value={formatAmount(totals.busiest.total, currency)}
              hint={readableDay(totals.busiest.date)}
            />
          </div>

          <div className="h-40 rounded-lg border border-slate-800 bg-slate-900/40 p-2">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chart} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="rgCost" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.45} />
                    <stop offset="100%" stopColor="#3b82f6" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis
                  dataKey="date"
                  tick={{ fill: '#64748b', fontSize: 9 }}
                  axisLine={false}
                  tickLine={false}
                  interval="preserveStartEnd"
                  tickFormatter={d => d.slice(5)}
                />
                <YAxis
                  tick={{ fill: '#64748b', fontSize: 9 }}
                  axisLine={false}
                  tickLine={false}
                  width={48}
                  tickFormatter={v => formatAmount(v, currency, true)}
                />
                <Tooltip
                  contentStyle={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8, fontSize: 11 }}
                  labelStyle={{ color: '#e2e8f0', fontWeight: 600 }}
                  formatter={v => [formatAmount(v, currency), 'Cost that day']}
                />
                <Area type="monotone" dataKey="cost" stroke="#3b82f6" strokeWidth={1.5} fill="url(#rgCost)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* ── What was done ────────────────────────────────────────────── */}
      {/*
        The activity failure is a banner, not a replacement.

        It used to return early and take the whole tab strip with it, which
        also removed "What changed" -- and that tab reads snapshots this app
        stored itself, so it works perfectly well without the Activity Log
        permission that just failed. One missing role was hiding a feature it
        has no bearing on.
      */}
      {acts.error && (
        <p className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-950/20 p-2.5 text-[11px] text-amber-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Who did it could not be read, so the two activity tabs are empty rather
            than quiet. What changed still works — it compares captures this app
            already took.
            {' '}{acts.error}
          </span>
        </p>
      )}
      {(
        <>
          <div className="flex items-center gap-1 rounded-lg bg-slate-900/60 p-1">
            <button
              type="button"
              onClick={() => setTab('key')}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-medium transition ${
                activeTab === 'key' ? 'bg-blue-600/25 text-blue-300' : 'text-slate-400 hover:text-white'
              }`}
            >
              <Sparkles className="h-3.5 w-3.5" />
              What matters ({highlights.length})
            </button>
            <button
              type="button"
              onClick={() => setTab('log')}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-medium transition ${
                activeTab === 'log' ? 'bg-blue-600/25 text-blue-300' : 'text-slate-400 hover:text-white'
              }`}
            >
              <ScrollText className="h-3.5 w-3.5" />
              Full activity log ({events.length})
            </button>
            <button
              type="button"
              onClick={() => setTab('diff')}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-medium transition ${
                activeTab === 'diff' ? 'bg-blue-600/25 text-blue-300' : 'text-slate-400 hover:text-white'
              }`}
            >
              <GitCompareArrows className="h-3.5 w-3.5" />
              What changed ({changed.length})
            </button>
          </div>

          {activeTab === 'key' ? (
            <>
              <p className="flex items-start gap-1.5 text-[10px] text-slate-500">
                <Clock className="mt-0.5 h-3 w-3 shrink-0" />
                The days the bill moved, every deletion and every failed attempt —
                {' '}{costEvents.size} cost movement{costEvents.size === 1 ? '' : 's'} and{' '}
                {highlightOps} operation{highlightOps === 1 ? '' : 's'} out of {events.length}.
                Routine writes are in the full log.
              </p>

              {highlights.length === 0 ? (
                <p className="text-[11px] text-slate-400">
                  {acts.error
                    ? 'This list is empty because the Activity Log could not be read, not because the period was quiet. See What changed for the resources that differ between captures.'
                    : <>
                        The bill did not move noticeably in this period, and nothing was deleted
                        or failed. {events.length > 0
                          ? `The ${events.length} routine operation${events.length === 1 ? '' : 's'} are in the full log.`
                          : 'Nothing was created, changed or deleted here either.'}
                      </>}
                </p>
              ) : highlights.map(({ day, ops, cost }) => (
                <section key={day}>
                  <h4 className="sticky top-0 z-10 bg-slate-950/90 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500 backdrop-blur">
                    {readableDay(day)}
                    {ops.length > 0 && ` · ${ops.length} operation${ops.length === 1 ? '' : 's'}`}
                  </h4>
                  {cost && <CostMovement event={cost} currency={currency} />}
                  {ops.length > 0 && (
                    <ol className="mt-1 space-y-2">
                      {ops.map(event => (
                        <OperationRow key={event.id || `${event.at}-${event.operation}`} event={event} onOpen={setOpenResource} />
                      ))}
                    </ol>
                  )}
                </section>
              ))}
            </>
          ) : activeTab === 'log' ? (
            <>
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
                <input
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder="Filter by person, resource or service…"
                  spellCheck={false}
                  className="h-8 w-full rounded-lg border border-slate-700 bg-slate-950/60 pl-8 pr-3 text-xs text-white placeholder-slate-600 outline-none transition focus:border-blue-500"
                />
              </div>

              {query.trim() && (
                <p className="text-[11px] text-slate-500">
                  {shownOps} of {events.length} operations match “{query.trim()}”
                </p>
              )}

              {log.length === 0 ? (
                <p className="text-[11px] text-slate-400">
                  {acts.error
                    ? 'No operations could be read for this period, so this is a gap in the record rather than a quiet one.'
                    : events.length === 0
                      ? `Nothing was created, changed or deleted in this resource group between ${readableDay(window_.from)} and ${readableDay(window_.to)}.`
                      : 'No operation matches that filter.'}
                </p>
              ) : log.map(({ day, ops }) => (
                <section key={day}>
                  <h4 className="sticky top-0 z-10 bg-slate-950/90 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500 backdrop-blur">
                    {readableDay(day)} · {ops.length} operation{ops.length === 1 ? '' : 's'}
                  </h4>
                  <ol className="mt-1 space-y-2">
                    {ops.map(event => (
                      <OperationRow key={event.id || `${event.at}-${event.operation}`} event={event} onOpen={setOpenResource} />
                    ))}
                  </ol>
                </section>
              ))}
            </>
          ) : (
            <>
              <p className="flex items-start gap-1.5 text-[10px] text-slate-500">
                <Clock className="mt-0.5 h-3 w-3 shrink-0" />
                What the stored captures actually recorded, field by field — not what
                was asked for. Pick a resource to open its own history.
              </p>

              {diffs.error ? (
                <p className="flex items-start gap-2 text-[11px] text-amber-300">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {diffs.error}
                </p>
              ) : diffs.key !== diffKey ? (
                <p className="flex items-center gap-2 text-[11px] text-slate-400">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Comparing captures…
                </p>
              ) : !diffs.comparable ? (
                <p className="text-[11px] text-slate-400">
                  Two captures are needed to compare, and only one exists for this
                  period. The activity log above still covers it — it comes from
                  Azure rather than from anything this app recorded.
                </p>
              ) : changed.length === 0 ? (
                <p className="text-[11px] text-slate-400">
                  Nothing in {resourceGroup} differs between the captures taken{' '}
                  {moment(diffs.before?.started_at)} and {moment(diffs.after?.started_at)}.
                  A change made and undone between those two moments leaves no trace
                  here — the activity log would still have it.
                </p>
              ) : (
                <>
                  <p className="text-[11px] text-slate-500">
                    {moment(diffs.before?.started_at)} → {moment(diffs.after?.started_at)}
                  </p>
                  <ul className="space-y-1">
                    {changed.map(entry => (
                      <DiffRow
                        key={`${entry.kind}-${entry.resource_id}`}
                        entry={entry}
                        onOpen={setOpenResource}
                      />
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
