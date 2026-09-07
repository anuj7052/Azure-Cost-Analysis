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
  Boxes, FolderOpen, ScrollText, Search,
} from 'lucide-react';
import {
  fetchChanges, fetchScans, runScan,
  ignoreChange, unignoreChange, fetchActivity,
} from '../api/client';
import { useAppStore } from '../store/useAppStore';
import DetailPanel from '../components/Common/DetailPanel';
import ResourceTimeline from '../components/Common/ResourceTimeline';
import GroupActivity from '../components/Changes/GroupActivity';
import { shortType, summariseChange } from '../utils/changeSummary';
import { friendlyError } from '../utils/apiError';
import { describeResourceId } from '../utils/azureSku';
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
  { key: 'all', label: 'Everything', icon: ScrollText },
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
 * Every change in the window, in one list, with nothing to drill into first.
 *
 * The cascade answers "what happened in that resource group". This answers the
 * question people actually arrive with — "what happened at all" — which the
 * cascade cannot, because it only ever shows one group at a time and a reader
 * who does not already know which group to open has nowhere to start.
 *
 * The one thing it deliberately will not do is print a timestamp per row. A
 * diff between two captures knows the window a change fell inside, not the
 * moment it happened; a column of exact-looking times here would be invented.
 * The window is stated once at the top, and the exact date - when Azure or the
 * Activity Log knows one - lives in the resource's own history, one click away.
 */
const FEED_LIMIT = 300;

function EverythingFeed({ entries, subscriptionNames, before, after, onOpen }) {
  const [query, setQuery] = useState('');

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matched = needle
      ? entries.filter(e => [
        e.name, e.type, e.resource_group, e.location,
        subscriptionNames[e.subscription_id] || e.subscription_id,
      ].some(v => (v || '').toLowerCase().includes(needle)))
      : entries;

    // Removals first, then additions, then edits: a resource that has gone is
    // the one worth seeing before the reader stops scrolling.
    const rank = { removed: 0, added: 1, modified: 2 };
    return [...matched].sort(
      (a, b) => (rank[a.kind] - rank[b.kind]) || (a.name || '').localeCompare(b.name || ''),
    );
  }, [entries, query, subscriptionNames]);

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/60">
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-800 px-4 py-3">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Filter by name, type, resource group, region or subscription"
            className="w-full rounded-lg border border-slate-700 bg-slate-950 py-2 pl-9 pr-3 text-sm text-slate-100 placeholder:text-slate-600"
          />
        </div>
        <span className="shrink-0 text-[11px] text-slate-500">
          {rows.length} of {entries.length}
        </span>
      </div>

      <p className="border-b border-slate-800 px-4 py-2 text-[11px] text-slate-500">
        Everything that moved between {when(before)} and {when(after)}. The exact moment a
        change happened is not something a capture-to-capture comparison knows — open a
        row for the dates Azure and the Activity Log can vouch for.
      </p>

      <ul className="max-h-[38rem] divide-y divide-slate-800 overflow-y-auto">
        {rows.length === 0 && (
          <li className="p-4 text-sm text-slate-500">
            {entries.length === 0
              ? 'Nothing changed in this window.'
              : 'No change matches that filter.'}
          </li>
        )}

        {rows.slice(0, FEED_LIMIT).map(item => {
          const meta = KIND[item.kind];
          const Icon = meta.icon;
          return (
            <li key={`${item.kind}-${item.resource_id}`}>
              <button
                type="button"
                onClick={() => onOpen(item)}
                className={`flex w-full items-start gap-3 px-4 py-3 text-left transition hover:bg-slate-800/50 ${meta.row}`}
              >
                <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${meta.tone}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="truncate text-sm font-medium text-slate-200">
                      {item.name || item.resource_id}
                    </span>
                    <span className={`text-[10px] font-semibold uppercase tracking-wide ${meta.tone}`}>
                      {meta.label}
                    </span>
                  </div>
                  <p className="truncate text-[11px] text-slate-500">
                    {shortType(item.type)}
                    {item.resource_group && ` · ${item.resource_group}`}
                    {item.location && ` · ${item.location}`}
                    {' · '}
                    {subscriptionNames[item.subscription_id] || item.subscription_id}
                  </p>
                  <p className="mt-1 text-[11px] text-slate-400">
                    {summariseChange(item, item.kind)}
                  </p>
                </div>
                <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-slate-600" />
              </button>
            </li>
          );
        })}
      </ul>

      {rows.length > FEED_LIMIT && (
        <p className="border-t border-slate-800 px-4 py-2 text-[11px] text-slate-500">
          Showing the first {FEED_LIMIT} of {rows.length}. Narrow the filter, the period or
          the change type to see the rest — a list this long is not read, it is scrolled past.
        </p>
      )}
    </section>
  );
}

/**
 * What Azure remembers from before the first capture.
 *
 * The diff above can only compare captures, so the period before the first scan
 * looks empty - and "empty" reads as "nothing happened", which for somebody who
 * resized a VM two months ago is simply false. Azure's own Activity Log keeps
 * ninety days of operations regardless of when this app started watching, so
 * that period is not actually unknowable; it was just unasked.
 *
 * Loaded on a click rather than with the page. It is a per-subscription read
 * against a quota shared with everything else here, and most visits to this
 * page are about the recent diff, not the archaeology.
 */
const ACTIVITY_RETENTION_DAYS = 90;

function PreHistoryActivity({
  tenantId, subscriptionIds, until, days = ACTIVITY_RETENTION_DAYS, autoLoad = false,
}) {
  const [state, setState] = useState({ status: 'idle', events: [], error: '' });

  // Azure keeps ninety days and no more, so a reader asking for six months is
  // not being refused - there is nothing older to refuse them. Asking for more
  // than the retention would return the same ninety days while implying the
  // answer covered the whole period.
  const span = Math.min(days, ACTIVITY_RETENTION_DAYS);
  const truncated = days > ACTIVITY_RETENTION_DAYS;

  const load = async () => {
    if (!subscriptionIds.length) {
      setState({ status: 'done', events: [], error: 'Select a subscription first.' });
      return;
    }
    setState({ status: 'loading', events: [], error: '' });
    try {
      const data = await fetchActivity(tenantId, subscriptionIds, {
        days: span, writesOnly: true,
      });
      // Only what the diff cannot already show. Repeating the overlap would
      // put the same change on screen twice with two different timestamps.
      const cutoff = new Date(`${(until || '').replace(' ', 'T')}Z`).getTime();
      const events = (data.events || []).filter(e => {
        const at = new Date(e.at).getTime();
        return Number.isNaN(cutoff) || Number.isNaN(at) || at < cutoff;
      });
      setState({ status: 'done', events, error: '' });
    } catch (err) {
      setState({ status: 'done', events: [], error: friendlyError(err) });
    }
  };

  // Normally this waits for a click: it is a per-subscription read against a
  // shared quota, and most visits are about the diff. When there is no diff
  // yet, that reasoning inverts - this *is* the page, and making somebody
  // press a button to see the only content there is reads as an empty page.
  // The parent remounts this component when the period changes, so the fetch
  // follows the period selector without needing to watch it.
  const started = useRef(false);
  useEffect(() => {
    if (autoLoad && !started.current) {
      started.current = true;
      load();
    }
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [autoLoad]);

  if (state.status === 'idle') {
    return (
      <button
        onClick={load}
        className="flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-1.5 text-[11px] text-slate-300 transition hover:text-white"
      >
        <History className="h-3.5 w-3.5" />
        {until
          ? "Read Azure's own log for that period"
          : `Show me the last ${span} days from Azure's own log`}
      </button>
    );
  }

  if (state.status === 'loading') {
    return (
      <p className="flex items-center gap-2 text-[11px] text-slate-400">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Reading up to {span} days of the Activity Log…
      </p>
    );
  }

  if (state.error) return <p className="text-[11px] text-amber-300">{state.error}</p>;

  if (!state.events.length) {
    return (
      <p className="text-[11px] text-slate-400">
        Azure recorded no write operations in the {span} days
        {until ? ' before the first capture' : ''}. It keeps nothing older than
        {' '}{ACTIVITY_RETENTION_DAYS} days, so anything earlier is gone from Azure too —
        not just from here.
      </p>
    );
  }

  return (
    <div>
      <p className="mb-1.5 text-[11px] text-slate-400">
        {state.events.length} operation{state.events.length === 1 ? '' : 's'} Azure recorded
        {until ? ' before the first capture' : ` in the last ${span} days`}.
        These are operations, not diffs — the log says what was
        asked for, not what the resource looked like either side.
        {truncated && ` Azure keeps only ${ACTIVITY_RETENTION_DAYS} days, so the rest of the period you asked for cannot be answered by anyone.`}
      </p>
      <ul className="max-h-72 space-y-1 overflow-y-auto">
        {state.events.map(e => {
          const { name, service, resourceGroup } = describeResourceId(e.resource_id);
          return (
            <li key={e.id || `${e.at}-${e.resource_id}`} className="flex flex-wrap items-baseline gap-x-2 text-[11px]">
              <span className="text-slate-500">{moment(e.at)}</span>
              <span className={e.succeeded ? 'text-slate-300' : 'text-amber-300'}>
                {e.summary}
              </span>
              {!e.succeeded && <span className="text-[10px] text-amber-400/80">failed</span>}
              <span className="truncate text-slate-400">
                {name}
                {service && ` · ${service}`}
                {(e.resource_group || resourceGroup) && ` · ${e.resource_group || resourceGroup}`}
              </span>
              <span className="text-slate-600">{e.caller || 'unknown caller'}</span>
            </li>
          );
        })}
      </ul>
    </div>
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

  // Tenants whose first capture we have already taken care of this session.
  //
  // A tenant connected five minutes ago has no captures, so this page used to
  // greet its owner with an empty diff and an instruction to press a button.
  // That is a poor first impression of a feature that works perfectly well --
  // and worse, the button is the only thing on the page that does anything, so
  // the filters, the grouping and the detail panel all look broken rather than
  // unused. Taking the first capture for them starts the history immediately.
  //
  // Keyed by tenant rather than a boolean, because switching to a second
  // newly-connected tenant is the same situation again. A ref rather than
  // state: it guards an action, and re-rendering because of it would be the
  // thing that re-triggers it.
  const autoCaptured = useRef(new Set());

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
      const complete = history.filter(s => s.status === 'complete');
      setScans(complete);

      // Nothing has ever been captured for this tenant. Do it now rather than
      // asking, because there is no decision to make: without a first capture
      // this page cannot answer anything at all, and the scan is a read.
      // Only ever fires when the history is genuinely empty, so a tenant that
      // simply has no changes in the selected window is left alone.
      if (
        complete.length === 0
        && selectedSubscriptionIds.length > 0
        && !autoCaptured.current.has(selectedTenantId)
      ) {
        autoCaptured.current.add(selectedTenantId);
        scan({ first: true });
      }

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

  useEffect(() => {
    // A half-filled custom range is not a narrower question, it is no question
    // at all: `rangeParams` returns null for it, and the request then falls
    // through to the default capture pair. The reader sees a diff appear while
    // typing a date and reasonably believes it answers the range they are
    // halfway through entering. Wait for both ends instead.
    if (range.preset === 'custom' && !(range.from && range.to)) return;
    load();
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [
    selectedTenantId, showIgnored, range.preset, range.from, range.to,
    // Picking a capture is choosing a comparison, not preparing to choose one.
    // These were missing, so the two dropdowns under "Pick two captures" did
    // nothing at all until Compare was pressed - which looked like a filter
    // that did not work, because that is exactly what it was.
    pair.before, pair.after,
  ]);

  const scan = async ({ first = false } = {}) => {
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
      else if (first) {
        // Said differently for the automatic one. "Captured 412 resources"
        // arriving unprompted looks like something the reader did by accident;
        // naming it as the start of the history explains why it happened.
        toast.success(
          `First capture taken — ${result.resource_count} resources. `
          + 'History starts from here.',
        );
      } else toast.success(`Captured ${result.resource_count} resources`);
      await load();
    } catch (err) {
      toast.error(friendlyError(err));
    } finally {
      setScanning(false);
    }
  };

  const shape = GROUPINGS.find(g => g.key === grouping) || GROUPINGS[0];

  /**
   * Why a long period produced a short window.
   *
   * Asking for six months and being shown forty minutes looks like a broken
   * filter. It is not: this page can only compare captures that exist, and the
   * estate has no record of itself before the first scan was run. Saying so is
   * the difference between "nothing changed in six months" - which the page
   * would otherwise appear to claim - and "six months were never watched".
   */
  const historyShortfall = useMemo(() => {
    const asked = rangeParams(range)?.from_date;
    const oldest = data?.before?.started_at;
    if (!asked || !oldest) return '';
    const askedAt = new Date(`${asked}T00:00:00`);
    const gotAt = new Date(`${oldest.replace(' ', 'T')}Z`);
    if (Number.isNaN(gotAt.getTime())) return '';
    const missingDays = Math.floor((gotAt - askedAt) / 86400000);
    // A day of slack: the oldest capture is never taken at midnight, and
    // rounding that up into a warning would fire on every well-scanned range.
    if (missingDays < 1) return '';
    const label = RANGES.find(r => r.key === range.preset)?.label?.toLowerCase() || 'this period';
    return (
      `You asked for ${label}, but the oldest capture of this tenant was taken ${when(oldest)}. `
      + `The ${missingDays} day${missingDays === 1 ? '' : 's'} before that were never captured, so `
      + 'nothing from them can be compared. History starts building from the first scan.'
    );
  }, [range, data]);

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

  // How many days the chosen period covers, so the Activity Log below the
  // first-run panel answers the same question the period selector is asking.
  // Without this the selector looked decorative to a new tenant: it drove a
  // diff that did not exist yet and nothing the reader could see.
  const rangeDays = useMemo(() => {
    const preset = RANGES.find(r => r.key === range.preset);
    if (preset?.days) return preset.days;
    if (range.preset === 'custom' && range.from && range.to) {
      const span = (new Date(range.to) - new Date(range.from)) / 86400000;
      return Math.max(1, Math.round(span));
    }
    return ACTIVITY_RETENTION_DAYS;
  }, [range]);

  const rangeIncomplete = range.preset === 'custom' && !(range.from && range.to);

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
            onClick={() => scan()}
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

      {rangeIncomplete && (
        <div className="flex items-start gap-2 rounded-xl border border-slate-700 bg-slate-900/60 p-3 text-xs text-slate-300">
          <Clock className="mt-px h-4 w-4 shrink-0 text-slate-500" />
          <span>
            Pick both dates to compare. Nothing below has changed yet — it still
            answers the previous period, not the one you are half way through
            entering.
          </span>
        </div>
      )}

      {data?.note && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
          <AlertTriangle className="mt-px h-4 w-4 shrink-0" />
          <span>{data.note}</span>
        </div>
      )}

      {data && !data.comparable && (
        <div className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900/60 p-6 text-sm text-slate-300">
          <p className="flex items-center gap-2 font-medium text-slate-200">
            {scanning
              ? <><Loader2 className="h-4 w-4 animate-spin" />Taking the first capture…</>
              : <><Clock className="h-4 w-4 text-slate-500" />History for this tenant starts now</>}
          </p>

          {/* The old copy here was a dead end: it told a new reader to scan
              twice and come back, which is a page saying "nothing for you yet"
              to somebody who has just connected a tenant and wants to see that
              the product works. Two captures really are required for a diff --
              that cannot be faked -- but the ninety days of Activity Log below
              are real history, available immediately, and were already being
              read on this page for a different case. */}
          <p className="leading-relaxed text-slate-400">
            {scans.length === 0
              ? 'A capture writes down what exists at one moment; this page subtracts one from another, so the first comparison appears once a second capture has been taken.'
              : 'One capture has been taken. The next one — scheduled, or from Scan now — produces the first comparison.'}
          </p>

          <div className="space-y-2 border-t border-slate-800 pt-3">
            <p className="text-xs leading-relaxed text-slate-400">
              You do not have to wait to see what has been happening. Azure keeps
              its own log of every write operation for {ACTIVITY_RETENTION_DAYS} days,
              regardless of when this app started watching — who did what, to which
              resource, and whether it succeeded. It is a record of operations rather
              than a diff, so it says what was asked for, not what the resource looked
              like either side. The Period filter above narrows it.
            </p>
            <PreHistoryActivity
              // Remounted when the period changes, so the reader's choice above
              // re-reads the log rather than leaving an answer to the previous
              // question on screen looking like an answer to this one.
              key={`${selectedTenantId}-${rangeDays}`}
              tenantId={selectedTenantId}
              subscriptionIds={selectedSubscriptionIds}
              until={data?.before?.started_at}
              days={rangeDays}
              autoLoad={!scanning && selectedSubscriptionIds.length > 0}
            />
          </div>
        </div>
      )}

      {historyShortfall && (
        <div className="space-y-2 rounded-xl border border-slate-700 bg-slate-900/60 p-3 text-xs text-slate-300">
          <div className="flex items-start gap-2">
            <Clock className="mt-px h-4 w-4 shrink-0 text-slate-500" />
            <span>{historyShortfall}</span>
          </div>
          <PreHistoryActivity
            tenantId={selectedTenantId}
            subscriptionIds={selectedSubscriptionIds}
            until={data?.before?.started_at}
          />
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

          {view === 'all' ? (
            <EverythingFeed
              entries={visible}
              subscriptionNames={subscriptionNames}
              before={data.before?.started_at}
              after={data.after?.started_at}
              onOpen={item => { setOpen(item); setRawJson(false); }}
            />
          ) : view === 'timeline' ? (
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
              <ResourceTimeline tenantId={selectedTenantId} resourceId={open.resource_id} />
            </section>
          </div>
        )}
      </DetailPanel>
    </div>
  );
}
