/**
 * One resource's life story: when it appeared, every time it changed, what it
 * cost either side of each change, and who was working in that window.
 *
 * This used to live inside Change Tracking, which meant it could only be
 * reached by finding the resource in a diff first. That is fine for "what
 * moved last night" and useless for "when was this VM created", because a
 * resource nobody has touched since the first capture appears in no diff at
 * all — and being unable to look it up reads as the history not existing.
 * So it lives here, and any page that can name a resource id can show it.
 */
import { useEffect, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { fetchResourceTimeline } from '../../api/client';
import { formatAmount } from '../../utils/currency';
import { describeFieldChange } from '../../utils/changeSummary';

const KIND = {
  added: { label: 'Added', dot: 'bg-emerald-400', tone: 'text-emerald-300' },
  removed: { label: 'Removed', dot: 'bg-red-400', tone: 'text-red-300' },
  modified: { label: 'Modified', dot: 'bg-amber-400', tone: 'text-amber-300' },
};

// Where a date came from, in the words a reader would use. Shown next to every
// date so an approximate one is never mistaken for an exact one.
const SOURCE_LABEL = {
  azure: 'Azure record',
  activity: 'Activity Log',
  snapshot: 'from scans',
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
// would silently shift anything not already in UTC.
const HAS_ZONE = /(Z|[+-]\d{2}:?\d{2})$/;

function moment(timestamp) {
  if (!timestamp) return '—';
  if (!HAS_ZONE.test(timestamp)) return when(timestamp);
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? timestamp : date.toLocaleString();
}

/**
 * A created/changed/deleted date, with its provenance attached.
 *
 * Two sources answer this question and they are not equally good. The Activity
 * Log is exact and names a person, but only reaches back ninety days. Our
 * snapshots reach back for ever and are only as precise as the scan interval.
 * Every date carries a badge saying which one it came from, because a column
 * mixing second-accurate and week-accurate dates with nothing to tell them
 * apart teaches people to trust none of it.
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
          className={`h-1.5 w-1.5 rounded-full ${entry.exact ? 'bg-emerald-400' : 'bg-amber-400'}`}
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
        <span
          className="text-[10px] text-amber-400/80"
          title="This period is still being billed, so the figure will keep rising."
        >
          period in progress
        </span>
      )}
    </p>
  );
}

export default function ResourceTimeline({ tenantId, resourceId }) {
  // Keyed by resource id rather than paired with a separate loading flag. The
  // flag version had to be set synchronously inside the effect to avoid showing
  // the previous resource's history for a frame; deriving it instead means the
  // stale result simply cannot be rendered.
  const [result, setResult] = useState({ id: null, data: null });
  const [granularity, setGranularity] = useState('monthly');

  useEffect(() => {
    let cancelled = false;
    fetchResourceTimeline(tenantId, resourceId, { granularity })
      .then(data => { if (!cancelled) setResult({ id: resourceId, data }); })
      .catch(() => { if (!cancelled) setResult({ id: resourceId, data: null }); });
    return () => { cancelled = true; };
  }, [tenantId, resourceId, granularity]);

  const data = result.data;

  // Switching to daily refetches, but the events and the lifecycle dates do not
  // depend on granularity. Only the cost strip is stale, so only the cost strip
  // shows that it is loading — clearing the whole timeline to change a toggle
  // would throw away the thing the reader is looking at.
  const costPending = !!data && data.cost?.granularity !== granularity;

  if (result.id !== resourceId) {
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
