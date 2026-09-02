/**
 * What the app is currently waiting for.
 *
 * Every page has its own skeletons, and they are the right thing for a panel
 * whose shape is known. What none of them can do is answer the question people
 * actually ask when a large estate is loading: is this working, or is it
 * broken? A skeleton looks identical at two seconds and at ninety, and several
 * of these reads legitimately take a minute because they fan out across every
 * subscription and wait on Azure rather than on us.
 *
 * So this tracks in-flight requests centrally, and the indicator built on it
 * can say how long we have been waiting and what for. It is deliberately a
 * plain module rather than a store: it is written to from an axios
 * interceptor, which has no access to React, and read by exactly one
 * component.
 */

const active = new Map();
const listeners = new Set();
let nextId = 1;

/**
 * URL prefix to a phrase describing what is being fetched.
 *
 * Ordered longest-first at match time so `/security/role-assignments` is not
 * described by the `/security` entry. The wording names Azure where Azure is
 * the thing being waited on, because "this is slow" and "Azure is slow" call
 * for different amounts of patience.
 */
const LABELS = [
  ['/costs', 'Reading cost data from Azure'],
  ['/services', 'Reading resources and their costs'],
  ['/subscriptions', 'Listing subscriptions'],
  ['/bandwidth', 'Reading data transfer costs'],
  ['/anomalies', 'Looking for unusual spend'],
  ['/commitments', 'Reading reservations and savings plans'],
  ['/orphaned', 'Looking for unattached resources'],
  ['/network/topology', 'Mapping the network'],
  ['/activity', 'Reading the Azure Activity Log'],
  ['/security', 'Reading access and security data'],
  ['/compute', 'Reading VM utilization'],
  ['/scans', 'Scanning the estate'],
  ['/changes', 'Comparing snapshots'],
  ['/timeline', 'Building the resource timeline'],
  ['/prices', 'Reading Azure retail prices'],
  ['/boq', 'Working through the BOQ'],
  ['/search', 'Searching'],
];

export function describe(url = '') {
  const match = LABELS
    .filter(([prefix]) => url.startsWith(prefix))
    .sort((a, b) => b[0].length - a[0].length)[0];
  return match ? match[1] : 'Loading';
}

function emit() {
  const snapshot = read();
  listeners.forEach((fn) => fn(snapshot));
}

let cached = { count: 0, since: 0, label: '' };

function read() {
  if (active.size === 0) return cached.count === 0 ? cached : (cached = { count: 0, since: 0, label: '' });

  // The oldest request is the one worth naming. When a page fires five reads at
  // once, the one still outstanding after ten seconds is what the user is
  // actually waiting for; naming the newest would relabel the indicator every
  // time something fast completed.
  let oldest = null;
  for (const entry of active.values()) {
    if (!oldest || entry.startedAt < oldest.startedAt) oldest = entry;
  }

  const next = { count: active.size, since: oldest.startedAt, label: describe(oldest.url) };
  // useSyncExternalStore compares snapshots by identity and will loop forever
  // if a new object is returned for an unchanged state.
  if (
    cached.count === next.count
    && cached.since === next.since
    && cached.label === next.label
  ) {
    return cached;
  }
  cached = next;
  return cached;
}

export function begin(url) {
  const id = nextId++;
  active.set(id, { url: url || '', startedAt: Date.now() });
  emit();
  return id;
}

export function end(id) {
  if (active.delete(id)) emit();
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getSnapshot() {
  return read();
}

/** Tests and story rendering need a way back to a known state. */
export function reset() {
  active.clear();
  cached = { count: 0, since: 0, label: '' };
  emit();
}
