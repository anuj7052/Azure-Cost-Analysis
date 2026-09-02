import { useEffect, useState, useSyncExternalStore } from 'react';
import { Loader2 } from 'lucide-react';
import { subscribe, getSnapshot } from '../../api/inflight';

/**
 * One indicator that always tells the truth about whether the app is working.
 *
 * Individual panels have their own skeletons, and those are right for showing
 * the shape of something that is about to appear. They are useless for the
 * question people actually ask on a large estate: is this loading, or is it
 * broken? A skeleton looks the same after two seconds and after ninety.
 *
 * So this does the two things a skeleton cannot. A bar appears at the top of
 * the window the moment anything is in flight, which answers "is it doing
 * something". And once a wait passes the point where people start to doubt it,
 * a panel names what is being read and how long it has taken, which answers
 * "should I keep waiting". Several of these reads legitimately take a minute
 * because they fan out across every subscription and wait on Azure rather than
 * on us; a wait that explains itself is tolerable, and a silent one is not.
 */

// When a wait stops feeling instant and starts feeling stuck. Below this the
// bar alone is enough and a panel would be noise on every quick request.
const PATIENCE_MS = 4000;

// When the wait is long enough that people need to know it is expected rather
// than hung.
const REASSURE_MS = 15000;

export default function GlobalProgress() {
  const { count, since, label } = useSyncExternalStore(subscribe, getSnapshot);

  // The clock lives in state rather than being read during render, because
  // reading it during render is impure: two renders in the same tick would
  // disagree. The interval is also what re-renders the elapsed seconds, and a
  // ticking number is the difference between "still working" and "frozen".
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!count) return undefined;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [count]);

  if (!count) return null;

  // Clamped because the first tick is up to half a second away, so `now` can
  // still predate a request that started moments ago. Nothing is shown before
  // PATIENCE_MS anyway, which is several ticks later.
  const elapsed = since ? Math.max(0, now - since) : 0;
  const seconds = Math.floor(elapsed / 1000);

  return (
    <>
      {/* Indeterminate on purpose. We know how many requests are outstanding
          but nothing about how far through any of them Azure is, and a bar
          that implies progress it cannot measure is a lie that gets noticed
          precisely when the wait is longest. */}
      <div
        className="fixed inset-x-0 top-0 z-[60] h-0.5 overflow-hidden bg-slate-800"
        role="progressbar"
        aria-label="Loading"
      >
        <div className="h-full w-1/3 animate-progress-slide rounded-full bg-gradient-to-r from-sky-500 via-sky-300 to-sky-500" />
      </div>

      {elapsed > PATIENCE_MS && (
        // `role="status"` announces the label once, and again if what we are
        // waiting on changes. The elapsed count is deliberately hidden from
        // assistive technology: it is inside the live region and rewrites
        // itself twice a second, which would turn a helpful announcement into
        // an unusable stream of numbers. Sighted users get the clock, screen
        // reader users get the sentence that carries the meaning.
        <div
          className="fixed bottom-4 right-4 z-[60] max-w-xs rounded-xl border border-slate-700 bg-slate-900/95 p-3 shadow-xl backdrop-blur"
          role="status"
        >
          <div className="flex items-start gap-2.5">
            <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-sky-400" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-slate-100">
                {label}
                {count > 1 && (
                  <span className="ml-1 font-normal text-slate-400">
                    (+{count - 1} more)
                  </span>
                )}
              </p>
              <p className="mt-0.5 text-xs tabular-nums text-slate-400" aria-hidden="true">
                {seconds}s elapsed
              </p>
              {elapsed > REASSURE_MS && (
                <p className="mt-1.5 text-xs leading-relaxed text-slate-400">
                  Large estates take a while on the first read. Selecting fewer
                  subscriptions or a shorter period makes this faster.
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
