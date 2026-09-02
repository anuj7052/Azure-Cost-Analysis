/**
 * Change Tracking — comparing two captures of the estate.
 *
 * The shape of this page follows the shape of the question. Nobody opens it
 * asking "show me 400 changes"; they ask "what happened in that subscription",
 * then "which resource group", then "which resource", then "what exactly
 * moved". So it cascades, and the detail panel answers the last question in
 * full rather than summarising it.
 *
 * Three things here are deliberate and easy to get wrong:
 *
 *   * Ignored changes are counted even when hidden. A page that quietly shows
 *     less than it found is worse than one that shows too much.
 *   * A configuration that was never captured renders as "not captured", never
 *     as empty. Old snapshots predate the configuration bag, and reading
 *     absence as deletion would invent changes that never happened.
 *   * Who made a change is fetched only when asked for. It is the one thing on
 *     this page that calls Azure, and doing it on every click is how a page
 *     starts getting rate-limited.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { Link } from 'react-router-dom';
import {
  GitCompareArrows, PlusCircle, MinusCircle, PencilLine, Loader2, History,
  Clock, AlertTriangle, RadioTower, HelpCircle, EyeOff, Eye, Code2,
  ChevronRight, ChevronDown, Users, WrapText, ExternalLink, Layers, MapPin,
  Boxes, FolderOpen,
} from 'lucide-react';
import {
  fetchChanges, fetchResourceTimeline, fetchScans, runScan,
  ignoreChange, unignoreChange, fetchActivity,
} from '../api/client';
import { useAppStore } from '../store/useAppStore';
import { formatAmount } from '../utils/currency';
import DetailPanel from '../components/Common/DetailPanel';
import GroupActivity from '../components/Changes/GroupActivity';
import { describeFieldChange, shortType, summariseChange } from '../utils/changeSummary';
import { friendlyError } from '../utils/apiError';
import {
  GROUPINGS, UNASSIGNED, toEntries, groupBy, flattenBag, toPropertyTree, countLeaves,
} from '../utils/changeTree';

const KIND = {
  added: {
    icon: PlusCircle, label: 'Added', title: 'Resource Added',
    tone: 'text-emerald-300', dot: 'bg-emerald-400', row: 'bg-emerald-500/5',
  },
  removed: {
    icon: MinusCircle, label: 'Removed', title: 'Resource Deleted',
    tone: 'text-red-300', dot: 'bg-red-400', row: 'bg-red-500/5',
  },
  modified: {
    icon: PencilLine, label: 'Modified', title: 'Resource Modified',
    tone: 'text-amber-300', dot: 'bg-amber-400', row: 'bg-amber-500/5',
  },
};

const GROUP_ICON = {
  subscription: Layers, type: Boxes, location: MapPin, location_rg: FolderOpen,
};

function when(timestamp) {
  if (!timestamp) return '—';
  // SQLite stores UTC without a zone marker; without the Z the browser reads it
  // as local time and every capture appears hours out.
  const date = new Date(`${timestamp.replace(' ', 'T')}Z`);
  return Number.isNaN(date.getTime()) ? timestamp : date.toLocaleString();
}

// Timestamps that already carry a zone, which is what Azure returns. Appending
// a Z to one of those produces an invalid date, and stripping the offset first
// would silently shift anything not already in UTC. So the zone is detected and
// the string handed to Date untouched when it has one.
const HAS_ZONE = /(Z|[+-]\d{2}:?\d{2})$/;

function moment(timestamp) {
  if (!timestamp) return '—';
  if (!HAS_ZONE.test(timestamp)) return when(timestamp);
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? timestamp : date.toLocaleString();
}

// Where a date came from, in the words a reader would use. Shown next to every
// date so an approximate one is never mistaken for an exact one.
const SOURCE_LABEL = {
  azure: 'Azure record',
  activity: 'Activity Log',
  snapshot: 'from scans',
};

/** The name a person would use for a group key, not the raw value. */
function groupLabel(column, value, subscriptionNames) {
  if (!value || value === UNASSIGNED) return UNASSIGNED;
  if (column === 'subscription_id') return subscriptionNames[value] || value;
  if (column === 'type') return shortType(value);
  return value;
}

/** +2 −3 ~1 — the counts that let you skip a group without opening it. */
function CountBadges({ added = 0, removed = 0, modified = 0 }) {
  return (
    <span className="flex items-center gap-1 shrink-0">
      {added > 0 && (
        <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-300">
          +{added}
        </span>
      )}
      {removed > 0 && (
        <span className="rounded-full bg-red-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-red-300">
          −{removed}
        </span>
      )}
      {modified > 0 && (
        <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300">
          ~{modified}
        </span>
      )}
    </span>
  );
}

/** One selectable column of the cascade. */
const VIEWS = [
  { key: 'list', label: 'List', icon: Boxes },
  { key: 'timeline', label: 'Timeline', icon: History },
];

/**
 * The same choice as a Column, laid out horizontally.
 *
 * The timeline needs the full width, so selection has to stop being a column
 * without ceasing to exist. Each chip keeps its change count, because that is
 * what tells the reader which group is worth opening - a list of bare names
 * gives no reason to pick one over another.
 */
function ChipRow({ label, rows, selected, onSelect, labelFor }) {
  if (!rows.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </span>
      {rows.map(row => (
        <button
          key={row.key}
          onClick={() => onSelect(row.key)}
          className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] transition ${
            row.key === selected
              ? 'border-blue-500/60 bg-slate-800 text-white'
              : 'border-slate-800 bg-slate-900/60 text-slate-400 hover:text-slate-200'
          }`}
        >
          <span className="max-w-[14rem] truncate">{labelFor(row.key)}</span>
          <span className="text-slate-500">{row.items.length}</span>
        </button>
      ))}
    </div>
  );
}

function Column({ title, rows, selected, onSelect, labelFor, collapsed, onToggle }) {
  if (collapsed) {
    return (
      <button
        onClick={onToggle}
        title={`Show ${title}`}
        className="flex w-10 shrink-0 flex-col items-center gap-2 rounded-2xl border border-slate-800 bg-slate-900/60 py-3 text-slate-400 transition hover:text-slate-200"
      >
        <ChevronRight className="h-4 w-4" />
        <span className="text-[10px] font-medium [writing-mode:vertical-rl]">{title}</span>
      </button>
    );
  }

  return (
    <section className="min-w-0 flex-1 rounded-2xl border border-slate-800 bg-slate-900/60">
      <div className="flex items-center justify-between border-b border-slate-800 px-4 py-2.5">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          {title} ({rows.length})
        </h3>
        <button
          onClick={onToggle}
          aria-label={`Collapse ${title}`}
          className="text-slate-600 transition hover:text-slate-300"
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="max-h-[30rem] divide-y divide-slate-800 overflow-y-auto">
        {rows.length === 0 && (
          <p className="p-4 text-sm text-slate-500">Nothing here.</p>
        )}
        {rows.map(row => (
          <button
            key={row.key}
            onClick={() => onSelect(row.key)}
            className={`flex w-full items-center gap-2 px-4 py-2.5 text-left transition ${
              selected === row.key ? 'bg-slate-800/70' : 'hover:bg-slate-800/40'
            }`}
          >
            <span className="min-w-0 flex-1 truncate text-sm text-slate-200" title={row.key}>
              {labelFor(row.key)}
            </span>
            <CountBadges {...row} />
          </button>
        ))}
      </div>
    </section>
  );
}

/**
 * A property difference, nested so a large bag can be collapsed.
 *
 * Parents are summaries, not values: `backupPolicy` has no old and new of its
 * own, only the leaves underneath it do. Showing a serialised parent object as
 * well would print the same information twice in two different shapes.
 */
function PropertyNode({ node, depth, wrap, onIgnoreField, busyField }) {
  const [open, setOpen] = useState(depth === 0);
  const children = [...node.children.values()];
  const wrapClass = wrap ? 'break-words whitespace-pre-wrap' : 'truncate';

  return (
    <>
      {node.name !== '' && (
        <tr className="border-t border-slate-800 bg-slate-900/40">
          <td colSpan={4} className="px-3 py-1.5">
            <button
              onClick={() => setOpen(o => !o)}
              className="flex items-center gap-1.5 font-mono text-[11px] text-slate-300"
              style={{ paddingLeft: `${(depth - 1) * 12}px` }}
            >
              {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              {node.name}
              <span className="rounded-full bg-slate-800 px-1.5 text-[10px] text-slate-400">
                {countLeaves(node)}
              </span>
            </button>
          </td>
        </tr>
      )}

      {open && node.leaves.map(change => (
        <tr key={change.field} className="border-t border-slate-800 align-top">
          <td
            className="px-3 py-2 font-mono text-[11px] text-slate-300 break-all"
            style={{ paddingLeft: `${12 + depth * 12}px` }}
          >
            {change.leaf || change.label || change.field}
          </td>
          <td className={`max-w-xs px-3 py-2 text-[11px] text-red-300 ${wrapClass}`}>
            {change.tags ? '—' : (change.from || <span className="text-slate-600">(empty)</span>)}
          </td>
          <td className={`max-w-xs px-3 py-2 text-[11px] text-emerald-300 ${wrapClass}`}>
            {change.tags ? '—' : (change.to || <span className="text-slate-600">(empty)</span>)}
          </td>
          <td className="px-3 py-2">
            {onIgnoreField && (
              <button
                onClick={() => onIgnoreField(change.field)}
                disabled={busyField === change.field}
                title="Stop reporting this property for this resource"
                aria-label={`Ignore ${change.field}`}
                className="text-slate-600 transition hover:text-amber-300 disabled:opacity-50"
              >
                <EyeOff className="h-3.5 w-3.5" />
              </button>
            )}
          </td>
        </tr>
      ))}

      {open && children.map(child => (
        <PropertyNode
          key={child.name}
          node={child}
          depth={depth + 1}
          wrap={wrap}
          onIgnoreField={onIgnoreField}
          busyField={busyField}
        />
      ))}
    </>
  );
}

function PropertyTable({ changes, wrap, onWrapToggle, onIgnoreField, busyField, empty }) {
  const tree = useMemo(() => toPropertyTree(changes), [changes]);

  if (!changes.length) return <p className="text-sm text-slate-400">{empty}</p>;

  return (
    <>
      <div className="mb-2 flex justify-end">
        <button
          onClick={onWrapToggle}
          className="flex items-center gap-1.5 text-[11px] text-slate-400 transition hover:text-slate-200"
        >
          <WrapText className="h-3.5 w-3.5" />
          {wrap ? 'Truncate long values' : 'Wrap all'}
        </button>
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-800">
        <table className="w-full text-left">
          <thead className="bg-slate-900/70 text-[11px] text-slate-400">
            <tr>
              <th className="px-3 py-2 font-medium">Property</th>
              <th className="px-3 py-2 font-medium">Old value</th>
              <th className="px-3 py-2 font-medium">New value</th>
              <th className="w-8 px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            <PropertyNode
              node={tree}
              depth={0}
              wrap={wrap}
              onIgnoreField={onIgnoreField}
              busyField={busyField}
            />
          </tbody>
        </table>
      </div>
    </>
  );
}

/** Name, type, location — the identity questions, answered in one table. */
function KeyInformation({ item, subscriptionNames }) {
  const rows = [
    ['Name', item.name],
    ['Type', item.type],
    ['Location', item.location],
    ['Resource group', item.resource_group],
    ['Subscription', subscriptionNames[item.subscription_id] || item.subscription_id],
    ['SKU / size', item.sku],
  ];

  return (
    <dl className="divide-y divide-slate-800 rounded-xl border border-slate-800">
      {rows.map(([label, value]) => (
        <div key={label} className="grid grid-cols-3 gap-2 px-3 py-2">
          <dt className="text-[11px] text-slate-500">{label}</dt>
          <dd className="col-span-2 break-all text-[11px] text-slate-200">
            {value || <span className="text-slate-600">Not recorded</span>}
          </dd>
        </div>
      ))}

      <div className="grid grid-cols-3 gap-2 px-3 py-2">
        <dt className="text-[11px] text-slate-500">Tags</dt>
        <dd className="col-span-2 flex flex-wrap gap-1">
          {Object.keys(item.tags || {}).length === 0
            ? <span className="text-[11px] text-slate-600">None</span>
            : Object.entries(item.tags).map(([k, v]) => (
              <span key={k} className="rounded-full bg-slate-800 px-2 py-0.5 text-[10px] text-slate-300">
                {k}: {v}
              </span>
            ))}
        </dd>
      </div>
    </dl>
  );
}

/**
 * Who touched this resource, from Azure's own operation log.
 *
 * Loaded on request rather than on open. A snapshot diff costs nothing — it
 * reads our database — but this calls Azure, and firing it every time somebody
 * clicks a row is exactly how the rest of the app started getting throttled.
 */
function ActivityUsers({ tenantId, subscriptionIds, resourceId }) {
  const [state, setState] = useState({ status: 'idle', callers: [], error: '' });

  const load = async () => {
    if (!subscriptionIds.length) {
      setState({ status: 'done', callers: [], error: 'Select a subscription first.' });
      return;
    }
    setState({ status: 'loading', callers: [], error: '' });
    try {
      const data = await fetchActivity(tenantId, subscriptionIds, {
        days: 90, resourceId, writesOnly: true,
      });
      setState({ status: 'done', callers: data.callers || [], error: '' });
    } catch (err) {
      setState({ status: 'done', callers: [], error: friendlyError(err) });
    }
  };

  if (state.status === 'idle') {
    return (
      <button
        onClick={load}
        className="flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-1.5 text-[11px] text-slate-300 transition hover:text-white"
      >
        <Users className="h-3.5 w-3.5" />
        Find who changed this
      </button>
    );
  }

  if (state.status === 'loading') {
    return (
      <p className="flex items-center gap-2 text-[11px] text-slate-400">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Reading the activity log…
      </p>
    );
  }

  if (state.error) return <p className="text-[11px] text-amber-300">{state.error}</p>;

  if (!state.callers.length) {
    // Azure keeps roughly 90 days. Older changes have an actor that no longer
    // exists anywhere, and saying so is the only honest answer.
    return (
      <p className="text-[11px] text-slate-400">
        No write operations recorded for this resource in the last 90 days. Azure does
        not keep activity beyond that, so an older change has no actor to attribute.
      </p>
    );
  }

  return (
    <ul className="space-y-1">
      {state.callers.slice(0, 8).map(c => (
        <li key={c.caller} className="flex items-center justify-between text-[11px]">
          <span className="truncate text-slate-200">{c.caller}</span>
          <span className="shrink-0 text-slate-500">
            {c.count} operation{c.count === 1 ? '' : 's'}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Everything that ever happened to one resource, with what it cost.
 *
 * This is the view a diff cannot give: a diff says a VM was resized, a history
 * says it has been resized four times this quarter — and says what each resize
 * did to the bill.
 *
 * Three sources feed it and they are not equally reliable, so none of them is
 * allowed to pretend otherwise. Azure's own creation stamp is exact. The
 * Activity Log is exact and names a person, but only reaches back ninety days.
 * Our snapshots reach back for ever and are only as precise as the scan
 * interval. Every date below carries a badge saying which one it came from,
 * because a column mixing second-accurate and week-accurate dates with nothing
 * to tell them apart teaches people to trust none of it.
 */
function LifecycleDate({ label, entry, tone }) {
  if (!entry) {
    return (
      <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-2.5">
        <p className="text-[10px] uppercase tracking-wide text-slate-500">{label}</p>
        <p className="mt-0.5 text-[11px] text-slate-600">—</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-2.5">
      <p className="text-[10px] uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-0.5 text-[12px] font-semibold ${tone}`}>{moment(entry.at)}</p>
      <p
        className="mt-1 inline-flex items-center gap-1 text-[10px] text-slate-500"
        title={entry.detail}
      >
        <span
          className={`h-1.5 w-1.5 rounded-full ${
            entry.exact ? 'bg-emerald-400' : 'bg-amber-400'
          }`}
        />
        {SOURCE_LABEL[entry.source] || entry.source}
        {!entry.exact && ' · approximate'}
      </p>
      {!!entry.by && (
        <p className="mt-1 truncate text-[10px] text-slate-400" title={entry.by}>
          by {entry.by}
        </p>
      )}
    </div>
  );
}

/** The cost either side of one change, or nothing if we could not price it. */
function CostSwing({ event, currency }) {
  if (event.cost_before == null && event.cost_after == null) return null;

  const delta = event.cost_delta;
  const rising = delta != null && delta > 0;
  const falling = delta != null && delta < 0;

  return (
    <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
      <span className="text-slate-500">
        {formatAmount(event.cost_before ?? 0, currency)} → {formatAmount(event.cost_after ?? 0, currency)}
      </span>
      {delta != null && (
        <span
          className={`font-semibold ${
            rising ? 'text-red-300' : falling ? 'text-emerald-300' : 'text-slate-400'
          }`}
        >
          {rising ? '+' : ''}{formatAmount(delta, currency)}
          {event.cost_delta_pct != null && ` (${rising ? '+' : ''}${event.cost_delta_pct}%)`}
        </span>
      )}
      {/* A period still being billed against a finished one is not a
          like-for-like number, and reading it as one turns a half-month into
          an imaginary saving. */}
      {event.cost_after_partial && (
        <span className="text-[10px] text-amber-400/80" title="This period is still being billed, so the figure will keep rising.">
          period in progress
        </span>
      )}
    </p>
  );
}

function EntityHistory({ tenantId, resource }) {
  // Keyed by resource id rather than paired with a separate loading flag. The
  // flag version had to be set synchronously inside the effect to avoid showing
  // the previous resource's history for a frame; deriving it instead means the
  // stale result simply cannot be rendered.
  const [result, setResult] = useState({ id: null, data: null });
  const [granularity, setGranularity] = useState('monthly');

  useEffect(() => {
    let cancelled = false;
    const id = resource.resource_id;
    fetchResourceTimeline(tenantId, id, { granularity })
      .then(data => { if (!cancelled) setResult({ id, data }); })
      .catch(() => { if (!cancelled) setResult({ id, data: null }); });
    return () => { cancelled = true; };
  }, [tenantId, resource.resource_id, granularity]);

  const data = result.data;

  // Switching to daily refetches, but the events and the lifecycle dates do not
  // depend on granularity. Only the cost strip is stale, so only the cost strip
  // shows that it is loading — clearing the whole timeline to change a toggle
  // would throw away the thing the reader is looking at.
  const costPending = !!data && data.cost?.granularity !== granularity;

  if (result.id !== resource.resource_id) {
    return (
      <p className="flex items-center gap-2 text-[11px] text-slate-400">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Reading history, costs and the Activity Log…
      </p>
    );
  }

  if (!data?.events?.length) {
    return <p className="text-[11px] text-slate-400">No history recorded for this resource.</p>;
  }

  const life = data.lifecycle || {};
  const currency = data.cost?.currency || 'USD';
  const summary = data.cost?.summary || {};

  return (
    <>
      {/* ── When it was born, changed and died ───────────────────────── */}
      <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <LifecycleDate label="Created" entry={life.created} tone="text-emerald-300" />
        <LifecycleDate label="Last changed" entry={life.last_changed} tone="text-amber-300" />
        <LifecycleDate label="Deleted" entry={life.deleted} tone="text-red-300" />
      </div>

      {/* ── What it costs ────────────────────────────────────────────── */}
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2">
        <span className="text-[10px] uppercase tracking-wide text-slate-500">Cost</span>
        {costPending ? (
          <span className="flex items-center gap-1.5 text-[11px] text-slate-500">
            <Loader2 className="h-3 w-3 animate-spin" />
            Reading {granularity} cost…
          </span>
        ) : (
          <>
            <span className="text-[12px] font-semibold text-slate-200">
              {formatAmount(summary.latest ?? 0, currency)}
              <span className="ml-1 text-[10px] font-normal text-slate-500">
                {summary.latest_period || 'latest period'}
              </span>
            </span>
            <span className="text-[11px] text-slate-500">
              {formatAmount(summary.total ?? 0, currency)} over {summary.periods || 0}{' '}
              {granularity === 'daily' ? 'days' : 'months'}
            </span>
          </>
        )}
        <div className="ml-auto flex items-center gap-1">
          {['monthly', 'daily'].map(option => (
            <button
              key={option}
              type="button"
              onClick={() => setGranularity(option)}
              className={`rounded px-2 py-0.5 text-[10px] capitalize transition-colors ${
                granularity === option
                  ? 'bg-blue-500/15 text-blue-300'
                  : 'text-slate-500 hover:text-slate-300'
              }`}
              // Daily is the throttle-prone read, so it is never the default.
              title={
                option === 'daily'
                  ? 'Day by day for the last 90 days. Slower, and shows the exact day the bill moved.'
                  : 'Month by month for the last 12 months.'
              }
            >
              {option}
            </button>
          ))}
        </div>
      </div>

      <p className="mb-2 text-[11px] text-slate-500">
        First seen {when(data.first_seen)} · last seen {when(data.last_seen)} ·
        present in {data.scan_count} capture{data.scan_count === 1 ? '' : 's'}
      </p>

      <ol className="space-y-3">
        {data.events.map((event, index) => {
          const meta = KIND[event.kind] || {
            label: 'First seen', dot: 'bg-blue-400', tone: 'text-blue-300',
          };
          return (
            <li key={`${event.scan_id}-${index}`} className="flex gap-3">
              <div className="flex flex-col items-center">
                <span className={`mt-1.5 h-2 w-2 rounded-full ${meta.dot}`} />
                {index < data.events.length - 1 && (
                  <span className="mt-1 w-px flex-1 bg-slate-800" />
                )}
              </div>
              <div className="min-w-0 flex-1 pb-1">
                <p className={`text-[11px] font-semibold ${meta.tone}`}>
                  {event.kind === 'first_seen' ? 'First seen' : meta.label}
                </p>
                <p className="text-[11px] text-slate-500">{when(event.at)}</p>
                {!!event.changes?.length && (
                  <ul className="mt-1 space-y-0.5">
                    {event.changes.slice(0, 6).map(c => (
                      <li key={c.field} className="text-[11px] text-slate-300">
                        {describeFieldChange(c)}
                      </li>
                    ))}
                  </ul>
                )}

                <CostSwing event={event} currency={currency} />

                {/* Who touched it between the two captures. Every candidate is
                    listed rather than one being named as the cause: on a busy
                    resource, picking one would frequently be wrong, and a
                    wrong name in an audit trail is worse than no name. */}
                {!!event.activity?.length && (
                  <div className="mt-1">
                    {event.by ? (
                      <p className="text-[11px] text-slate-400">
                        by <span className="text-slate-300">{event.by}</span>
                        {' · '}{event.activity[0].summary}
                      </p>
                    ) : (
                      <>
                        <p className="text-[10px] text-slate-500">
                          {event.activity.length} operations in this window — any could
                          be responsible:
                        </p>
                        <ul className="mt-0.5 space-y-0.5">
                          {event.activity.slice(0, 4).map(a => (
                            <li key={`${a.at}-${a.caller}`} className="truncate text-[11px] text-slate-400">
                              {moment(a.at)} · {a.caller || 'unknown'} · {a.summary}
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {/* Only captures where something moved are listed. Showing every one
          would bury a handful of real events under hundreds of identical
          ones, which is how a history stops being read. */}
      <p className="mt-3 text-[11px] text-slate-600">
        Captures where nothing changed are omitted.
      </p>

      {/* Anything Azure would not tell us. Said out loud rather than left as a
          gap, because a blank where a cost should be reads as "this is free". */}
      {!!data.notes?.length && (
        <ul className="mt-2 space-y-1">
          {data.notes.map(note => (
            <li key={note} className="flex gap-1.5 text-[10px] text-slate-500">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber-500/70" />
              {note}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * How far back to compare.
 *
 * A range is what people actually ask -- "what changed this quarter" -- and it
 * is the default because the alternative was worse than it looked. Comparing
 * the two most recent captures sounds sensible until you notice that scans
 * taken minutes apart produce an empty diff, which the page then presented as
 * a stable estate. Somebody who scans twice in a row to check the scanner
 * works would open this page and conclude nothing had ever changed.
 *
 * Each date still resolves to a real capture and the page reports which ones,
 * so a range never hides what was actually compared.
 */
const RANGES = [
  { key: '7d', label: 'Last 7 days', days: 7 },
  { key: '30d', label: 'Last 30 days', days: 30 },
  { key: '90d', label: 'Last 3 months', days: 90 },
  { key: '180d', label: 'Last 6 months', days: 180 },
  { key: '365d', label: 'Last 12 months', days: 365 },
  { key: 'custom', label: 'Custom range…' },
  { key: 'captures', label: 'Pick two captures…' },
];

const DEFAULT_RANGE = '30d';

function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * The `from_date` / `to_date` a range asks for, or null to compare captures.
 *
 * A custom range with only one end filled in returns null rather than half a
 * query: the browser fires a change event on every keystroke in a date field,
 * and sending `2026-0` as a date produces an error message that looks like a
 * broken page.
 */
function rangeParams(range) {
  if (range.preset === 'captures') return null;
  if (range.preset === 'custom') {
    return range.from && range.to
      ? { from_date: range.from, to_date: range.to }
      : null;
  }
  const days = RANGES.find(r => r.key === range.preset)?.days || 30;
  const to = new Date();
  return {
    from_date: isoDay(new Date(to.getTime() - days * 86400000)),
    to_date: isoDay(to),
  };
}

export default function Changes() {
  const selectedTenantId = useAppStore(s => s.selectedTenantId);
  const selectedSubscriptionIds = useAppStore(s => s.selectedSubscriptionIds);
  const subscriptions = useAppStore(s => s.subscriptions);

  const [data, setData] = useState(null);
  const [scans, setScans] = useState([]);
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [pair, setPair] = useState({ before: '', after: '' });
  const [range, setRange] = useState({ preset: DEFAULT_RANGE, from: '', to: '' });
  const [grouping, setGrouping] = useState('subscription');
  const [kindFilter, setKindFilter] = useState('all');
  const [showIgnored, setShowIgnored] = useState(false);
  const [sel, setSel] = useState({ primary: null, secondary: null });
  // Two ways to read the same selection. The list answers "what changed" at a
  // glance; the timeline answers "what happened here", which needs the room the
  // three columns are using. Rather than cram both on screen, the toggle picks
  // one - and it stays on the current selection, so switching view never loses
  // the reader's place.
  const [view, setView] = useState('list');
  const [collapsed, setCollapsed] = useState({});
  const [open, setOpen] = useState(null);
  const [rawJson, setRawJson] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [busyField, setBusyField] = useState(null);
  const [help, setHelp] = useState(false);

  // A resource named in the URL, put there by the anomaly drawer. Held in a ref
  // rather than state because it is a one-shot instruction, not something the
  // page renders: turning it into state would re-open the drawer every time
  // somebody closed it.
  const deepLink = useRef(
    new URLSearchParams(window.location.search).get('resource') || '',
  );

  const subscriptionNames = useMemo(() => {
    const map = {};
    for (const sub of subscriptions || []) {
      map[sub.subscription_id] = sub.display_name || sub.subscription_id;
    }
    return map;
  }, [subscriptions]);

  const load = async (overrides = {}) => {
    if (!selectedTenantId) return;
    const dates = rangeParams(range);
    const params = {
      show_ignored: showIgnored,
      // A range and an explicit capture pair are two ways of asking the same
      // question, and sending both lets the server pick one silently. Only
      // one is ever sent, and which one is whatever the reader last chose.
      ...(dates || {
        ...(pair.before ? { before: Number(pair.before) } : {}),
        ...(pair.after ? { after: Number(pair.after) } : {}),
      }),
      ...overrides,
    };
    setLoading(true);
    try {
      const [diff, history] = await Promise.all([
        fetchChanges(selectedTenantId, params),
        fetchScans(selectedTenantId, 30),
      ]);
      setData(diff);
      setScans(history.filter(s => s.status === 'complete'));

      // Arriving from an anomaly's "what changed here" list, with one resource
      // named in the URL. Opening it saves the reader hunting for a row they
      // were already looking at. Consumed here rather than in an effect so it
      // fires once on the load that can satisfy it, and consumed before the
      // match so a resource outside this window does not retry for ever.
      if (deepLink.current) {
        const target = deepLink.current.toLowerCase();
        deepLink.current = '';
        const match = toEntries(diff).find(
          e => (e.resource_id || '').toLowerCase() === target,
        );
        if (match) {
          setOpen(match);
          setRawJson(false);
        } else {
          toast('That resource did not change in this comparison window.');
        }
      }
    } catch (err) {
      toast.error(friendlyError(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ },
    [selectedTenantId, showIgnored, range.preset, range.from, range.to]);

  const scan = async () => {
    if (!selectedTenantId || selectedSubscriptionIds.length === 0) {
      toast.error('Select a tenant and at least one subscription first.');
      return;
    }
    setScanning(true);
    try {
      const result = await runScan({
        tenant_id: selectedTenantId,
        subscription_ids: selectedSubscriptionIds,
      });
      if (result.status === 'failed') toast.error(result.error || 'Scan failed.');
      else toast.success(`Captured ${result.resource_count} resources`);
      await load();
    } catch (err) {
      toast.error(friendlyError(err));
    } finally {
      setScanning(false);
    }
  };

  const shape = GROUPINGS.find(g => g.key === grouping) || GROUPINGS[0];

  const entries = useMemo(() => toEntries(data), [data]);
  const visible = useMemo(
    () => entries.filter(e => kindFilter === 'all' || e.kind === kindFilter),
    [entries, kindFilter],
  );

  const primaryRows = useMemo(
    () => groupBy(visible, shape.primary), [visible, shape.primary],
  );

  // A selection that no longer exists — because the grouping or the filter
  // moved — falls back to the first row rather than leaving the next column
  // blank with no explanation.
  const activePrimary = primaryRows.find(r => r.key === sel.primary) || primaryRows[0] || null;

  const secondaryRows = useMemo(() => {
    if (!shape.secondary || !activePrimary) return [];
    return groupBy(activePrimary.items, shape.secondary);
  }, [shape.secondary, activePrimary]);

  const activeSecondary = shape.secondary
    ? (secondaryRows.find(r => r.key === sel.secondary) || secondaryRows[0] || null)
    : null;

  const resourceRows = shape.secondary
    ? (activeSecondary?.items || [])
    : (activePrimary?.items || []);

  const ignore = async (resourceId, field = '') => {
    setBusyField(field || resourceId);
    try {
      await ignoreChange({
        tenant_id: selectedTenantId, resource_id: resourceId, field, note: '',
      });
      toast.success(field ? `Ignoring ${field} on this resource` : 'Resource ignored');
      if (!field) setOpen(null);
      await load();
    } catch (err) {
      toast.error(friendlyError(err));
    } finally {
      setBusyField(null);
    }
  };

  const unignore = async (resourceId) => {
    setBusyField(resourceId);
    try {
      await unignoreChange(selectedTenantId, resourceId, '');
      toast.success('No longer ignored');
      await load();
    } catch (err) {
      toast.error(friendlyError(err));
    } finally {
      setBusyField(null);
    }
  };

  /**
   * What the property table shows for the open resource.
   *
   * A modified resource has real before-and-after values. An added or deleted
   * one has only one side, so its captured settings are listed against a blank
   * opposite column — which is the truth, and more useful than an empty panel.
   */
  const propertyRows = useMemo(() => {
    if (!open) return [];
    if (open.kind === 'modified') return open.changes || [];
    return flattenBag(open.properties).map(p => ({
      field: p.field,
      label: p.field,
      from: open.kind === 'removed' ? p.value : '',
      to: open.kind === 'added' ? p.value : '',
    }));
  }, [open]);

  const scanOption = s => `#${s.id} · ${when(s.started_at)} · ${s.resource_count} resources`;
  const toggle = key => setCollapsed(c => ({ ...c, [key]: !c[key] }));

  return (
    <div className="mx-auto max-w-screen-2xl space-y-5 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Change Tracking</h1>
          <p className="mt-1 text-sm text-slate-400">
            Compare Azure resources between two point-in-time captures
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setHelp(h => !h)}
            className="flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-3.5 py-2.5 text-sm font-medium text-slate-300 transition hover:text-white"
          >
            <HelpCircle className="h-4 w-4" />
            How this works
          </button>
          <button
            onClick={scan}
            disabled={scanning}
            className="flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:opacity-60"
          >
            {scanning
              ? <><Loader2 className="h-4 w-4 animate-spin" />Scanning…</>
              : <><RadioTower className="h-4 w-4" />Scan now</>}
          </button>
        </div>
      </div>

      {help && (
        <div className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900/60 p-5 text-sm leading-relaxed text-slate-300">
          <p>
            Azure only reports what exists right now. A capture writes down what existed
            at one moment; this page subtracts one from another.
          </p>
          <p>
            <span className="font-medium text-emerald-300">Added</span> is present in the
            newer capture and not the older one.{' '}
            <span className="font-medium text-red-300">Removed</span> is the reverse.{' '}
            <span className="font-medium text-amber-300">Modified</span> means the resource
            exists in both but something about it moved.
          </p>
          <p>
            Comparison happens between two stored captures, so it can only see what a
            capture recorded. A change made and reverted between two captures leaves no
            trace here — the Activity Explorer sees those, because it reads Azure's own
            operation log.
          </p>
          <p className="text-slate-400">
            Property differences depend on the configuration Azure returned at the time.
            Captures taken before this app stored configuration show no property rows,
            which is not the same as nothing having changed.
          </p>
        </div>
      )}

      {!selectedTenantId && (
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 text-slate-400">
          Select a tenant to compare captures.
        </div>
      )}

      {selectedTenantId && (
        <div className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <label className="block">
              <span className="mb-1 block text-[11px] font-medium text-slate-400">
                Period
              </span>
              <select
                value={range.preset}
                onChange={e => {
                  // Leaving a stale capture pair behind would send both a range
                  // and a pair, and the reader would have no way to tell which
                  // one produced the answer on screen.
                  setPair({ before: '', after: '' });
                  setRange(r => ({ ...r, preset: e.target.value }));
                }}
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
              >
                {RANGES.map(r => (
                  <option key={r.key} value={r.key}>{r.label}</option>
                ))}
              </select>
            </label>

            {range.preset === 'custom' && (
              <>
                <label className="block">
                  <span className="mb-1 block text-[11px] font-medium text-slate-400">
                    From
                  </span>
                  <input
                    type="date"
                    value={range.from}
                    max={range.to || undefined}
                    onChange={e => setRange(r => ({ ...r, from: e.target.value }))}
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-[11px] font-medium text-slate-400">
                    To
                  </span>
                  <input
                    type="date"
                    value={range.to}
                    min={range.from || undefined}
                    onChange={e => setRange(r => ({ ...r, to: e.target.value }))}
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                  />
                </label>
              </>
            )}

            {range.preset === 'captures' && (
              <>
                <label className="block">
                  <span className="mb-1 block text-[11px] font-medium text-slate-400">
                    Older capture
                  </span>
                  <select
                    value={pair.before}
                    onChange={e => setPair(p => ({ ...p, before: e.target.value }))}
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                  >
                    <option value="">Second most recent</option>
                    {scans.map(s => <option key={s.id} value={s.id}>{scanOption(s)}</option>)}
                  </select>
                </label>

                <label className="block">
                  <span className="mb-1 block text-[11px] font-medium text-slate-400">
                    Newer capture
                  </span>
                  <select
                    value={pair.after}
                    onChange={e => setPair(p => ({ ...p, after: e.target.value }))}
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                  >
                    <option value="">Most recent</option>
                    {scans.map(s => <option key={s.id} value={s.id}>{scanOption(s)}</option>)}
                  </select>
                </label>
              </>
            )}

            <label className="block">
              <span className="mb-1 block text-[11px] font-medium text-slate-400">
                Change type
              </span>
              <select
                value={kindFilter}
                onChange={e => setKindFilter(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
              >
                <option value="all">All</option>
                <option value="added">Added</option>
                <option value="removed">Removed</option>
                <option value="modified">Modified</option>
              </select>
            </label>

            <div className="flex items-end gap-2">
              <button
                onClick={() => load()}
                disabled={loading}
                className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:opacity-60"
              >
                {loading
                  ? <><Loader2 className="h-4 w-4 animate-spin" />Comparing…</>
                  : <><GitCompareArrows className="h-4 w-4" />Compare</>}
              </button>
              {(range.preset !== DEFAULT_RANGE || pair.before || pair.after) && (
                <button
                  onClick={() => {
                    setPair({ before: '', after: '' });
                    setRange({ preset: DEFAULT_RANGE, from: '', to: '' });
                  }}
                  className="text-xs text-slate-400 underline underline-offset-2 hover:text-slate-200"
                >
                  Reset
                </button>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-800 pt-3">
            <div className="flex flex-wrap gap-1.5">
              {GROUPINGS.map(g => {
                const Icon = GROUP_ICON[g.key] || Layers;
                const active = g.key === grouping;
                return (
                  <button
                    key={g.key}
                    onClick={() => { setGrouping(g.key); setSel({ primary: null, secondary: null }); }}
                    className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                      active
                        ? 'bg-blue-600 text-white'
                        : 'border border-slate-700 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    Group by {g.label.toLowerCase()}
                  </button>
                );
              })}
            </div>

            <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-400">
              <input
                type="checkbox"
                checked={showIgnored}
                onChange={e => setShowIgnored(e.target.checked)}
                className="accent-blue-500"
              />
              {showIgnored ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
              Show ignored
              {data?.ignored_count > 0 && (
                <span className="rounded-full bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-300">
                  {data.ignored_count}
                </span>
              )}
            </label>
          </div>
        </div>
      )}

      {data?.note && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
          <AlertTriangle className="mt-px h-4 w-4 shrink-0" />
          <span>{data.note}</span>
        </div>
      )}

      {data && !data.comparable && (
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 text-slate-400">
          Not enough captures to compare yet. Run a scan now and another later —
          the difference between them is this page.
        </div>
      )}

      {data?.comparable && (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400">
            <Clock className="h-3.5 w-3.5" />
            <span>{when(data.before?.started_at)}</span>
            <ChevronRight className="h-3.5 w-3.5 text-slate-600" />
            <span className="text-slate-200">{when(data.after?.started_at)}</span>
            <span className="text-slate-600">·</span>
            <span>{data.total_changes} change{data.total_changes === 1 ? '' : 's'}</span>
            {data.ignored_count > 0 && (
              <>
                <span className="text-slate-600">·</span>
                <span className="text-amber-300/80">{data.ignored_count} ignored</span>
              </>
            )}

            <div className="ml-auto flex rounded-lg border border-slate-700 p-0.5">
              {VIEWS.map(v => {
                const Icon = v.icon;
                return (
                  <button
                    key={v.key}
                    onClick={() => setView(v.key)}
                    className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] transition ${
                      view === v.key ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {v.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            {['added', 'removed', 'modified'].map(kind => {
              const meta = KIND[kind];
              const Icon = meta.icon;
              return (
                <button
                  key={kind}
                  onClick={() => setKindFilter(f => (f === kind ? 'all' : kind))}
                  className={`rounded-2xl border p-4 text-left transition ${
                    kindFilter === kind
                      ? 'border-blue-500/60 bg-slate-900'
                      : 'border-slate-800 bg-slate-900/60 hover:border-slate-700'
                  }`}
                >
                  <div className={`flex items-center gap-2 text-xs font-semibold ${meta.tone}`}>
                    <Icon className="h-4 w-4" />
                    {meta.label}
                  </div>
                  <p className="mt-1 text-2xl font-bold text-white">{data[`${kind}_count`]}</p>
                </button>
              );
            })}
          </div>

          {view === 'timeline' ? (
            <div className="space-y-3">
              {/* The columns become chips here. Navigation still has to be
                  available - a timeline for a group you cannot change is a dead
                  end - but it no longer deserves a third of the width once the
                  history is the thing being read. */}
              <ChipRow
                label={shape.label}
                rows={primaryRows}
                selected={activePrimary?.key}
                onSelect={key => setSel({ primary: key, secondary: null })}
                labelFor={key => groupLabel(shape.primary, key, subscriptionNames)}
              />
              {shape.secondary && (
                <ChipRow
                  label="Resource groups"
                  rows={secondaryRows}
                  selected={activeSecondary?.key}
                  onSelect={key => setSel(s => ({ ...s, secondary: key }))}
                  labelFor={key => key}
                />
              )}

              <GroupActivity
                group={(shape.secondary ? activeSecondary?.key : activePrimary?.key) || 'Selection'}
                items={resourceRows}
                subscriptionId={resourceRows[0]?.subscription_id || ''}
                subscriptionIds={selectedSubscriptionIds}
                tenantId={selectedTenantId}
                detectedAt={data.after?.started_at}
                onOpen={item => { setOpen(item); setRawJson(false); }}
              />
            </div>
          ) : (
          <div className="flex gap-3">
            <Column
              title={shape.label}
              rows={primaryRows}
              selected={activePrimary?.key}
              onSelect={key => setSel({ primary: key, secondary: null })}
              labelFor={key => groupLabel(shape.primary, key, subscriptionNames)}
              collapsed={!!collapsed.primary}
              onToggle={() => toggle('primary')}
            />

            {shape.secondary && (
              <Column
                title="Resource groups"
                rows={secondaryRows}
                selected={activeSecondary?.key}
                onSelect={key => setSel(s => ({ ...s, secondary: key }))}
                labelFor={key => key}
                collapsed={!!collapsed.secondary}
                onToggle={() => toggle('secondary')}
              />
            )}

            <section className="min-w-0 flex-[1.4] rounded-2xl border border-slate-800 bg-slate-900/60">
              <h3 className="border-b border-slate-800 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                Resources ({resourceRows.length})
              </h3>
              <div className="max-h-[30rem] divide-y divide-slate-800 overflow-y-auto">
                {resourceRows.length === 0 && (
                  <p className="p-4 text-sm text-slate-500">No changes to show.</p>
                )}
                {resourceRows.map(item => {
                  const meta = KIND[item.kind];
                  return (
                    <button
                      key={`${item.kind}-${item.resource_id}`}
                      onClick={() => { setOpen(item); setRawJson(false); }}
                      className={`flex w-full items-start gap-2.5 px-4 py-2.5 text-left transition hover:bg-slate-800/40 ${
                        item.ignored ? 'opacity-50' : ''
                      }`}
                    >
                      <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${meta.dot}`} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium text-slate-100" title={item.name}>
                            {item.name}
                          </span>
                          {item.ignored && (
                            <span className="shrink-0 rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">
                              ignored
                            </span>
                          )}
                        </span>
                        <span className={`mt-0.5 block text-xs ${meta.tone}`}>
                          {summariseChange(item, item.kind)}
                        </span>
                        <span className="mt-0.5 block truncate text-[11px] text-slate-500">
                          {shortType(item.type)}
                          {item.location ? ` · ${item.location}` : ''}
                        </span>
                      </span>
                      <History className="mt-1 h-3.5 w-3.5 shrink-0 text-slate-600" />
                    </button>
                  );
                })}
              </div>
            </section>
          </div>
          )}
        </>
      )}

      <DetailPanel
        open={!!open}
        onClose={() => setOpen(null)}
        title={open ? KIND[open.kind].title : ''}
        subtitle={open?.name || ''}
      >
        {open && (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => setRawJson(r => !r)}
                className="flex items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 py-1 text-[11px] text-slate-300 transition hover:text-white"
              >
                <Code2 className="h-3.5 w-3.5" />
                {rawJson ? 'Hide raw JSON' : 'Raw JSON'}
              </button>
              {open.ignored ? (
                <button
                  onClick={() => unignore(open.resource_id)}
                  disabled={busyField === open.resource_id}
                  className="flex items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 py-1 text-[11px] text-slate-300 transition hover:text-white disabled:opacity-50"
                >
                  <Eye className="h-3.5 w-3.5" />
                  Stop ignoring
                </button>
              ) : (
                <button
                  onClick={() => ignore(open.resource_id, '')}
                  disabled={busyField === open.resource_id}
                  className="flex items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 py-1 text-[11px] text-slate-300 transition hover:text-amber-300 disabled:opacity-50"
                >
                  <EyeOff className="h-3.5 w-3.5" />
                  Ignore this resource
                </button>
              )}
            </div>

            <section>
              <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                Key information
              </h4>
              <KeyInformation item={open} subscriptionNames={subscriptionNames} />
            </section>

            <section>
              <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                Related
              </h4>
              <div className="flex flex-wrap gap-2">
                <Link
                  to="/activity"
                  className="flex items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 py-1 text-[11px] text-slate-300 transition hover:text-white"
                >
                  <History className="h-3.5 w-3.5" />
                  Activity
                </Link>
                <Link
                  to="/access-identity?view=assignments"
                  className="flex items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 py-1 text-[11px] text-slate-300 transition hover:text-white"
                >
                  <Users className="h-3.5 w-3.5" />
                  Access
                </Link>
                {/* Only offered for something that still exists. A portal link
                    to a deleted resource is a 404 with extra steps. */}
                {open.kind !== 'removed' && (
                  <a
                    href={`https://portal.azure.com/#@/resource${open.resource_id}`}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 py-1 text-[11px] text-slate-300 transition hover:text-white"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    Azure portal
                  </a>
                )}
              </div>
            </section>

            <section>
              <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                Recent activity users
              </h4>
              <ActivityUsers
                tenantId={selectedTenantId}
                subscriptionIds={selectedSubscriptionIds}
                resourceId={open.resource_id}
              />
            </section>

            <section>
              <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                {open.kind === 'modified' ? 'Property changes'
                  : open.kind === 'removed' ? 'Deleted properties' : 'Created properties'}
              </h4>
              <PropertyTable
                changes={propertyRows}
                wrap={wrap}
                onWrapToggle={() => setWrap(w => !w)}
                busyField={busyField}
                onIgnoreField={open.kind === 'modified'
                  ? field => ignore(open.resource_id, field)
                  : null}
                empty={open.properties
                  ? 'No property differences recorded.'
                  : 'Configuration was not captured for this resource — either the capture predates this feature, or the configuration was too large to store.'}
              />
            </section>

            {rawJson && (
              <section>
                <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  Configuration as captured
                </h4>
                {open.properties ? (
                  <pre className="max-h-96 overflow-auto rounded-xl border border-slate-800 bg-slate-950 p-3 text-[11px] leading-relaxed text-slate-300">
                    {JSON.stringify(open.properties, null, 2)}
                  </pre>
                ) : (
                  // Silence here would read as "this resource has no settings",
                  // which is a claim about Azure rather than about the capture.
                  <p className="text-[11px] text-slate-400">
                    Configuration was not captured for this resource.
                  </p>
                )}
              </section>
            )}

            <section>
              <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                History
              </h4>
              <EntityHistory tenantId={selectedTenantId} resource={open} />
            </section>
          </div>
        )}
      </DetailPanel>
    </div>
  );
}
