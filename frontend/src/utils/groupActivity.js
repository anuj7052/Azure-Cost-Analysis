/**
 * Turning a diff into a history.
 *
 * The change API answers "what is different between these two captures". A
 * history answers "what happened, in order". Those are close enough to look
 * like the same thing and different enough to mislead if the gap is papered
 * over, so the translation is done here, once, where it can be tested.
 *
 * The gap that matters is time. A diff has exactly one timestamp - the capture
 * that produced it - and it belongs to every entry equally. It is emphatically
 * not when the change happened; it is when we noticed. Presenting it as the
 * former would invent a precision the data does not have, so entries built from
 * a diff are labelled "detected" and the real time is left to the Activity Log,
 * which is the only source that actually knows it.
 */
import { shortType, summariseChange, describeTagChange } from './changeSummary';

/**
 * The badge each kind of change wears.
 *
 * "Tag Updated" is separated out from "Configuration Modified" because it is
 * the one modification that is almost always deliberate bookkeeping rather than
 * a change to what the resource is or costs. Mixing them buries the handful of
 * resizes among a hundred tag edits.
 */
export const EVENT_STYLES = {
  created: { label: 'Resource Created', tone: 'emerald' },
  deleted: { label: 'Resource Deleted', tone: 'red' },
  modified: { label: 'Configuration Modified', tone: 'blue' },
  tagged: { label: 'Tag Updated', tone: 'sky' },
};

/** Whether every recorded difference was a tag. */
export function isTagOnly(item) {
  const fields = item?.changes || [];
  if (!fields.length) return !!item?.tags;
  return fields.every((c) => (c.field || '').toLowerCase().startsWith('tag'));
}

export function eventKindOf(item) {
  if (item.kind === 'added') return 'created';
  if (item.kind === 'removed') return 'deleted';
  return isTagOnly(item) ? 'tagged' : 'modified';
}

const VERB = {
  created: 'Provisioned',
  deleted: 'Deleted',
  modified: 'Updated',
  tagged: 'Retagged',
};

/**
 * A one-line title, in the shape of a sentence about the resource type rather
 * than the resource id. The id is long, unreadable at a glance and already
 * shown; the type is what tells someone whether this row is worth opening.
 */
export function titleOf(item, eventKind) {
  const kind = eventKind || eventKindOf(item);
  const type = shortType(item.type) || 'resource';
  return `${VERB[kind]} ${type}`;
}

/**
 * The sentence under the title.
 *
 * Tag edits get their own description because `summariseChange` reports them as
 * a field count - "3 properties changed" - which is true and tells the reader
 * nothing about which tags or what they now say.
 */
export function descriptionOf(item, eventKind) {
  const kind = eventKind || eventKindOf(item);
  if (kind === 'tagged') {
    const tags = describeTagChange(item.tags);
    if (tags) return `${item.name} - ${tags}`;
  }
  const summary = summariseChange(item, item.kind);
  return summary ? `${item.name} - ${summary}` : item.name;
}

/**
 * Build the history for one resource group.
 *
 * Ordering puts creations and deletions above modifications. Within a single
 * capture there is no real chronology to honour - everything carries the same
 * timestamp - so the order is a judgement about importance instead of a
 * pretence about time: a resource appearing or disappearing changes the estate,
 * whereas a property moving changes a detail of it.
 *
 * Ignored changes are included but marked. Dropping them would make the history
 * disagree with the counts elsewhere on the page, and a history that quietly
 * omits things is not a history.
 */
const RANK = { created: 0, deleted: 1, modified: 2, tagged: 3 };

export function buildGroupTimeline(items = [], { detectedAt = null } = {}) {
  return items
    .map((item) => {
      const kind = eventKindOf(item);
      return {
        id: `${item.kind}:${item.resource_id}`,
        resourceId: item.resource_id,
        name: item.name,
        eventKind: kind,
        style: EVENT_STYLES[kind],
        title: titleOf(item, kind),
        description: descriptionOf(item, kind),
        detectedAt,
        ignored: !!item.ignored,
        fieldCount: (item.changes || []).length,
        item,
      };
    })
    .sort((a, b) => {
      const byRank = RANK[a.eventKind] - RANK[b.eventKind];
      return byRank !== 0 ? byRank : a.name.localeCompare(b.name);
    });
}

/**
 * Attach an actor to each entry from the Activity Log.
 *
 * Matching is case-insensitive because the two sources disagree on the casing
 * of a resource id: Resource Graph returns `resourceGroups` and the Activity
 * Log returns `resourcegroups`. Comparing them literally matches nothing, and
 * the failure is silent - every row simply has no actor, which reads as "nobody
 * did this" rather than as a bug.
 *
 * Where several people touched one resource in the window, none is named. On a
 * busy resource picking one would frequently be wrong, and a wrong name in an
 * audit trail is worse than no name.
 */
export function attachActors(entries, activityEntries = []) {
  const byResource = new Map();
  for (const entry of activityEntries) {
    const key = (entry.resource_id || '').toLowerCase();
    if (!key) continue;
    if (!byResource.has(key)) byResource.set(key, []);
    byResource.get(key).push(entry);
  }

  return entries.map((entry) => {
    const matches = byResource.get((entry.resourceId || '').toLowerCase()) || [];
    if (!matches.length) return entry;

    const callers = [...new Set(matches.map((m) => m.caller).filter(Boolean))];
    const newest = matches.reduce(
      (a, b) => ((b.timestamp || '') > (a.timestamp || '') ? b : a),
      matches[0],
    );

    return {
      ...entry,
      actor: callers.length === 1 ? callers[0] : null,
      actorCount: callers.length,
      occurredAt: newest.timestamp || null,
      operation: newest.summary || null,
    };
  });
}
