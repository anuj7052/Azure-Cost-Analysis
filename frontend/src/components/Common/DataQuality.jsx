import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, Clock, Database, RefreshCw } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';

/**
 * What a number on this page actually covers.
 *
 * Every aggregate here is summed across subscriptions, and any one of them can
 * fail on its own. When that happens the total is still a number and still
 * looks like an answer — it is only the answer for the subscriptions that
 * responded.
 *
 * Presenting that as complete is the worst thing this app could do: somebody
 * reconciles it against an invoice, finds a shortfall, and either stops
 * trusting the tool or reports the wrong figure. So the coverage is stated
 * next to the figures rather than buried in a console log.
 *
 * The failures are inspectable rather than summarised away. "One subscription
 * could not be queried" is not actionable; "throttled" and "missing Cost
 * Management Reader" need completely different responses.
 *
 * Throttling in particular is temporary, and this bar used to end by telling
 * the reader to wait a few seconds and press Refresh — a job the page can do
 * for itself. It now says when it is going back, and counts down, so waiting
 * is something the reader watches rather than something they administer.
 */

function when(iso) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Seconds until `at`, recomputed on a tick.
 *
 * The tick lives here rather than in the store because a countdown is a
 * rendering concern: the store already knows the deadline, and waking every
 * subscriber once a second to re-render pages that show no countdown would be
 * a lot of work to display one number.
 */
function useCountdown(at) {
  // The clock is the state, not the remaining seconds. Storing the difference
  // would mean writing it once on mount from inside an effect, which is the
  // cascading-render pattern React now warns about; reading a ticking clock
  // during render is both simpler and always consistent with `at`.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!at) return undefined;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [at]);

  return at ? Math.max(0, Math.ceil((at - now) / 1000)) : 0;
}

export default function DataQuality({ coverage, className = '' }) {
  const [open, setOpen] = useState(false);
  const retryAt = useAppStore(s => s.costRetryAt);
  const costLoading = useAppStore(s => s.costLoading);
  const loadCosts = useAppStore(s => s.loadCosts);
  const secondsLeft = useCountdown(retryAt);

  // No coverage means the caller has not wired it yet. Rendering a confident
  // "complete" badge for an unknown state would be a lie of omission.
  if (!coverage) return null;

  const {
    source, fetched_at: fetchedAt, requested_subscriptions: requested,
    succeeded_subscriptions: succeeded, partial, errors = [],
  } = coverage;

  const time = when(fetchedAt);
  const missing = Math.max(0, (requested || 0) - (succeeded || 0));
  const recoverable = errors.filter(e => e?.retryable).length;
  // Only claim a retry is coming for the failures a retry can actually fix.
  const retryPending = Boolean(retryAt) && recoverable > 0;

  return (
    <div
      className={`rounded-xl border text-xs ${
        partial
          ? 'border-amber-500/40 bg-amber-950/20'
          : 'border-slate-800 bg-slate-900/60'
      } ${className}`}
    >
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-3.5 py-2.5">
        <span className={`flex items-center gap-1.5 font-medium ${
          partial ? 'text-amber-300' : 'text-emerald-300'
        }`}>
          {partial
            ? <AlertTriangle className="h-3.5 w-3.5" />
            : <CheckCircle2 className="h-3.5 w-3.5" />}
          {partial
            ? `Partial data — ${missing} of ${requested} subscription${missing === 1 ? '' : 's'} could not be queried`
            : `Complete — ${succeeded} of ${requested} subscriptions`}
        </span>

        {time && (
          <span className="flex items-center gap-1.5 text-slate-500">
            <Clock className="h-3.5 w-3.5" />
            Updated {time}
          </span>
        )}

        {source && (
          <span className="flex items-center gap-1.5 text-slate-500">
            <Database className="h-3.5 w-3.5" />
            {source}
          </span>
        )}

        {/* Said plainly and in the present tense: nothing is being asked of the
            reader, and the totals are about to change on their own. */}
        {costLoading && retryPending && (
          <span className="flex items-center gap-1.5 text-amber-200">
            <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            Reading the missing subscription{recoverable === 1 ? '' : 's'} again…
          </span>
        )}
        {!costLoading && retryPending && (
          <span className="flex items-center gap-1.5 text-amber-200">
            <RefreshCw className="h-3.5 w-3.5" />
            Retrying automatically in {secondsLeft}s — totals will update themselves
          </span>
        )}
        {!costLoading && partial && !retryPending && recoverable > 0 && (
          <button
            onClick={() => loadCosts({ force: true })}
            className="flex items-center gap-1.5 font-medium text-amber-300 transition hover:text-amber-200"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Try the missing subscription{recoverable === 1 ? '' : 's'} again
          </button>
        )}

        {partial && errors.length > 0 && (
          <button
            onClick={() => setOpen(o => !o)}
            className="ml-auto flex items-center gap-1 font-medium text-amber-300 transition hover:text-amber-200"
          >
            {open ? 'Hide' : 'Inspect'} {errors.length === 1 ? 'error' : 'errors'}
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
          </button>
        )}
      </div>

      {open && (
        <div className="space-y-2 border-t border-amber-500/20 px-3.5 py-3">
          {errors.map((e, i) => (
            <div key={e.subscription_id || i}>
              <p className="font-mono text-[11px] text-slate-400">
                {e.subscription_name || e.subscription_id || 'Unknown subscription'}
              </p>
              {/* The reason verbatim: throttling and a missing role need
                  entirely different responses, and a generic message hides
                  which one this is. */}
              <p className="mt-0.5 leading-relaxed text-slate-300">{e.error}</p>
            </div>
          ))}

          <p className="pt-1 leading-relaxed text-[11px] text-slate-500">
            Totals above exclude these subscriptions. They are not zero — they
            are unknown.
          </p>
        </div>
      )}
    </div>
  );
}
