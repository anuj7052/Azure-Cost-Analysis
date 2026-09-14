/*
 * Deciding what to say about tenant-wide elevation.
 *
 * The hard part of this feature is not the API call, it is knowing which of
 * four different situations somebody is in and not saying the wrong one. The
 * logic lives here rather than in the component so it can be tested against
 * every combination, including the ones that are awkward to reproduce in a
 * browser -- an elevation taken months ago, or a tenant whose access could
 * not be read at all.
 */

/*
 * How long an elevation may stand before it stops looking like somebody
 * working and starts looking like a permanent tenant-wide administrator.
 *
 * A day, because Microsoft's guidance is to elevate, do the one thing that
 * needed it, and remove it -- and anything that survives a night has outlived
 * the task it was taken for. This is a prompt, not an expiry: nothing is
 * removed automatically, because silently dropping somebody's access mid-task
 * would be worse than the standing grant.
 */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * How long ago an elevation was taken, in words.
 *
 * Returns null rather than a zero or a placeholder when the timestamp is
 * missing or unparseable. A duration is either known or it is not, and
 * "0 minutes ago" for an unknown date is a lie that reads as a fact.
 */
export function elevationAge(createdOn, now = Date.now()) {
  if (!createdOn) return null;
  const started = Date.parse(createdOn);
  if (Number.isNaN(started)) return null;

  const ms = now - started;
  // Clock skew between Azure and the browser can put a fresh elevation a few
  // seconds in the future. "just now" is true enough; "-1 minutes ago" is not.
  if (ms < 60_000) return { ms: Math.max(ms, 0), label: 'just now', stale: false };

  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  let label;
  if (days >= 1) label = `${days} day${days === 1 ? '' : 's'} ago`;
  else if (hours >= 1) label = `${hours} hour${hours === 1 ? '' : 's'} ago`;
  else label = `${minutes} minute${minutes === 1 ? '' : 's'} ago`;

  return { ms, label, stale: ms >= STALE_AFTER_MS };
}

/**
 * What the elevation panel should be saying right now.
 *
 * The four states are deliberately distinct, because collapsing any two of
 * them produces a specific wrong message:
 *
 *   `unknown`  -- we could not read the assignment. Offering Elevate here
 *                 would invite somebody to take access they may already hold,
 *                 and offering Remove would invite them to remove something
 *                 that might not exist.
 *   `elevated` -- they hold it. The only useful button is Remove.
 *   `needed`   -- they are not elevated and the tenant shows no subscriptions.
 *                 This is the case the feature was built for, and it is the
 *                 only one that should be loud.
 *   `offer`    -- not elevated, and the estate is visible. Nothing is wrong,
 *                 so this stays quiet and available rather than prompting.
 */
export function elevationState(status, { subscriptionCount = null } = {}) {
  if (!status || status.unknown) {
    return {
      state: 'unknown',
      canElevate: false,
      canRemove: false,
      tone: 'info',
      error: status?.error || '',
    };
  }

  if (status.elevated) {
    const age = elevationAge(status.created_on);
    return {
      state: 'elevated',
      canElevate: false,
      canRemove: true,
      // An old elevation is the finding this product raises about other
      // people's tenants. It should raise it about its own user too.
      tone: age?.stale ? 'medium' : 'info',
      age,
      assignmentId: status.assignment_id || '',
      error: '',
    };
  }

  // Zero is the symptom. Null means the subscription list has not answered
  // yet, and guessing "none" during a load would flash a warning at somebody
  // whose estate is about to appear.
  const blind = subscriptionCount === 0;

  return {
    state: blind ? 'needed' : 'offer',
    canElevate: true,
    canRemove: false,
    tone: blind ? 'medium' : 'info',
    error: '',
  };
}
