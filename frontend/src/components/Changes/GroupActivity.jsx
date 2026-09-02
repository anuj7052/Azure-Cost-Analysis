import { useMemo, useState } from 'react';
import {
  MapPin, Boxes, User, FileDiff, Eye, Loader2, Users, History,
} from 'lucide-react';
import { fetchActivity } from '../../api/client';
import { friendlyError } from '../../utils/apiError';
import { timeAgo, exactWhen } from '../../utils/relativeTime';
import { buildGroupTimeline, attachActors } from '../../utils/groupActivity';

/**
 * A resource group, and everything that happened inside it.
 *
 * The cascade elsewhere on this page answers "which group changed". This
 * answers the question that follows, which is "and what happened in it" - as a
 * history rather than as a list, because the reader is trying to reconstruct a
 * sequence of events, not audit a table.
 *
 * Two honesty rules shape it. Every entry from the diff is stamped with when it
 * was *detected*, never with when it happened: a capture knows the moment it
 * looked, not the moment somebody clicked. And the real time and the actor come
 * only from the Activity Log, which is fetched on request rather than on
 * render - it is the one call here that reaches Azure, and doing it every time
 * a group is selected is how a page starts getting rate-limited.
 */

const TONE = {
  emerald: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  red: 'border-red-500/30 bg-red-500/10 text-red-300',
  blue: 'border-blue-500/30 bg-blue-500/10 text-blue-300',
  sky: 'border-sky-500/30 bg-sky-500/10 text-sky-300',
};

const DOT = {
  emerald: 'border-emerald-400', red: 'border-red-400',
  blue: 'border-blue-400', sky: 'border-sky-400',
};

// A history is scanned from the top. Showing everything at once buries the
// recent entries in a group that has seen hundreds of changes, so it opens at a
// readable length and grows on request.
const PAGE = 6;

function Detail({ label, children }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <div className="mt-1 text-[13px] text-slate-200">{children}</div>
    </div>
  );
}

/** The left card: what this group is, before what happened to it. */
function GroupDetails({ group, subscriptionId, resourceCount, locations, changeCount }) {
  const id = subscriptionId
    ? `/subscriptions/${subscriptionId}/resourceGroups/${group}`
    : `/resourceGroups/${group}`;

  return (
    <aside className="w-full shrink-0 rounded-2xl border border-slate-800 bg-slate-900/60 p-4 lg:w-72">
      <h3 className="border-b border-slate-800 pb-2.5 text-sm font-semibold text-white">
        Group Details
      </h3>

      <div className="mt-3 space-y-3.5">
        <Detail label="ID">
          <code className="block break-all rounded-lg border border-slate-800 bg-slate-950 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-slate-300">
            {id}
          </code>
        </Detail>

        <div className="grid grid-cols-2 gap-3">
          <Detail label="Location">
            <span className="flex items-center gap-1 text-[13px]">
              <MapPin className="h-3.5 w-3.5 text-slate-500" />
              {/* Named individually rather than collapsed to a count. A group
                  spanning two regions is a fact worth seeing, and "2 regions"
                  hides which ones. */}
              {locations.length ? locations.join(', ') : '—'}
            </span>
          </Detail>

          <Detail label="Changes">
            <span className={changeCount ? 'text-amber-300' : 'text-slate-400'}>
              {changeCount} in this capture
            </span>
          </Detail>
        </div>

        <Detail label="Resources changed">
          <span className="flex items-center gap-1">
            <Boxes className="h-3.5 w-3.5 text-slate-500" />
            {resourceCount} item{resourceCount === 1 ? '' : 's'}
          </span>
        </Detail>
      </div>
    </aside>
  );
}

export default function GroupActivity({
  group, items, subscriptionId, subscriptionIds, tenantId, detectedAt, onOpen,
}) {
  const [shown, setShown] = useState(PAGE);
  const [actors, setActors] = useState({ status: 'idle', entries: [], error: '' });

  const timeline = useMemo(
    () => buildGroupTimeline(items, { detectedAt }),
    [items, detectedAt],
  );

  const withActors = useMemo(
    () => (actors.entries.length ? attachActors(timeline, actors.entries) : timeline),
    [timeline, actors.entries],
  );

  const locations = useMemo(
    () => [...new Set(items.map((i) => i.location).filter(Boolean))].sort(),
    [items],
  );

  const loadActors = async () => {
    if (!subscriptionIds?.length) {
      setActors({ status: 'done', entries: [], error: 'Select a subscription first.' });
      return;
    }
    setActors({ status: 'loading', entries: [], error: '' });
    try {
      // One call for the whole group, narrowed by Azure itself. Asking per
      // resource would turn a page view into dozens of calls against the same
      // quota every other page is sharing.
      const data = await fetchActivity(tenantId, subscriptionIds, {
        days: 90, resourceGroup: group, writesOnly: true,
      });
      setActors({ status: 'done', entries: data.entries || [], error: '' });
    } catch (err) {
      setActors({ status: 'done', entries: [], error: friendlyError(err) });
    }
  };

  const visible = withActors.slice(0, shown);

  return (
    <div className="flex flex-col gap-3 lg:flex-row">
      <GroupDetails
        group={group}
        subscriptionId={subscriptionId}
        resourceCount={items.length}
        locations={locations}
        changeCount={items.length}
      />

      <section className="min-w-0 flex-1 rounded-2xl border border-slate-800 bg-slate-900/60">
        <header className="flex flex-wrap items-center gap-2 border-b border-slate-800 px-4 py-2.5">
          <h3 className="text-sm font-semibold text-white">Activity History</h3>
          <span className="text-[11px] text-slate-500">
            detected {timeAgo(detectedAt)}
          </span>

          <div className="ml-auto">
            {actors.status === 'idle' && (
              <button
                type="button"
                onClick={loadActors}
                className="flex items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 py-1 text-[11px] text-slate-300 transition hover:text-white"
              >
                <Users className="h-3.5 w-3.5" />
                Find who made these changes
              </button>
            )}
            {actors.status === 'loading' && (
              <span className="flex items-center gap-1.5 text-[11px] text-slate-400">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Reading the activity log…
              </span>
            )}
          </div>
        </header>

        {actors.error && (
          <p className="border-b border-slate-800 px-4 py-2 text-[11px] text-amber-300">
            {actors.error}
          </p>
        )}

        {!visible.length ? (
          <p className="p-4 text-sm text-slate-500">No changes recorded in this group.</p>
        ) : (
          <ol className="space-y-0 p-4">
            {visible.map((entry, index) => (
              <li key={entry.id} className="flex gap-3">
                {/* The rail. The line is drawn on every entry but the last, so
                    the timeline reads as one thread rather than as a column of
                    disconnected bullets. */}
                <div className="flex flex-col items-center pt-1.5">
                  <span
                    className={`h-3 w-3 shrink-0 rounded-full border-2 bg-slate-950 ${DOT[entry.style.tone]}`}
                  />
                  {index < visible.length - 1 && (
                    <span className="mt-1 w-px flex-1 bg-slate-800" />
                  )}
                </div>

                <div className={`mb-3 min-w-0 flex-1 rounded-xl border border-slate-800 bg-slate-900 p-3 ${entry.ignored ? 'opacity-50' : ''}`}>
                  <div className="flex flex-wrap items-start gap-2">
                    <span
                      className={`rounded-md border px-2 py-0.5 text-[10px] font-semibold ${TONE[entry.style.tone]}`}
                    >
                      {entry.style.label}
                    </span>
                    {entry.ignored && (
                      <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">
                        ignored
                      </span>
                    )}
                    <span
                      className="ml-auto shrink-0 text-[11px] text-slate-500"
                      title={exactWhen(entry.occurredAt || entry.detectedAt)}
                    >
                      {/* The Activity Log knows when it happened; a capture only
                          knows when it looked. Whichever is shown says which it
                          is, so a detection time is never mistaken for the
                          moment somebody acted. */}
                      {entry.occurredAt
                        ? timeAgo(entry.occurredAt)
                        : `detected ${timeAgo(entry.detectedAt)}`}
                    </span>
                  </div>

                  <p className="mt-1.5 text-sm font-semibold text-white">{entry.title}</p>
                  <p className="mt-0.5 break-words text-[12px] leading-relaxed text-slate-400">
                    {entry.description}
                  </p>

                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-slate-800 pt-2">
                    <span className="flex items-center gap-1.5 text-[11px] text-slate-400">
                      <User className="h-3.5 w-3.5 text-slate-600" />
                      {entry.actor
                        ? <span className="text-slate-300">{entry.actor}</span>
                        : entry.actorCount > 1
                          // Naming one of several would frequently be wrong, and
                          // a wrong name in an audit trail is worse than none.
                          ? `${entry.actorCount} people acted here`
                          : <span className="text-slate-600">Actor not requested</span>}
                    </span>

                    <button
                      type="button"
                      onClick={() => onOpen(entry.item)}
                      className="ml-auto flex items-center gap-1.5 text-[11px] font-medium text-blue-400 transition hover:text-blue-300"
                    >
                      {entry.fieldCount ? <FileDiff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                      {entry.fieldCount ? 'View diff' : 'View details'}
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}

        {shown < withActors.length && (
          <div className="border-t border-slate-800 p-3 text-center">
            <button
              type="button"
              onClick={() => setShown((n) => n + PAGE)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-1.5 text-[12px] text-slate-300 transition hover:text-white"
            >
              <History className="h-3.5 w-3.5" />
              Load more history
              <span className="text-slate-500">
                ({withActors.length - shown} more)
              </span>
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
