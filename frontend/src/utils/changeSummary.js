/**
 * Plain-English descriptions of a change.
 *
 * A raw field diff ("sku: D2s v3 -> D4s v3") is precise and means nothing to
 * most people reading it. The question behind the screen is "what happened, and
 * does it matter", so every change is stated as a sentence first and the exact
 * values kept underneath for whoever needs them.
 */

/** Azure type ids are verbose; the last segment is the part people recognise. */
export function shortType(type) {
  if (!type) return 'resource';
  const parts = String(type).split('/');
  const last = parts[parts.length - 1] || 'resource';

  // "virtualMachines" -> "virtual machines": readable rather than camel case.
  const spaced = last.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();

  return singular(spaced);
}

/**
 * Singular, because each sentence describes one resource.
 *
 * Naively dropping a trailing "s" turns "addresses" into "addresse", which
 * reads as a typo and undermines the sentence it appears in.
 */
function singular(word) {
  if (word.endsWith('sses')) return word.slice(0, -2);   // addresses -> address
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`; // policies -> policy
  if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/** What a single field moving actually means, in words. */
export function describeFieldChange(change) {
  const from = change.from || '(empty)';
  const to = change.to || '(empty)';

  switch (change.field) {
    case 'sku':
      return `Resized from ${from} to ${to}`;
    case 'location':
      return `Moved region from ${from} to ${to}`;
    case 'resource_group':
      return `Moved from resource group ${from} to ${to}`;
    case 'subscription_id':
      return `Moved to a different subscription`;
    case 'name':
      return `Renamed from ${from} to ${to}`;
    case 'type':
      return `Resource type changed from ${from} to ${to}`;
    case 'tags':
      return describeTagChange(change.tags);
    default:
      return `${change.label} changed from ${from} to ${to}`;
  }
}

/**
 * Tags in words.
 *
 * Governance work is almost entirely per-tag, and a whole-blob before/after
 * hides which one moved, so each kind of tag edit is counted separately.
 */
export function describeTagChange(tags) {
  if (!tags) return 'Tags changed';

  const added = Object.keys(tags.added || {});
  const removed = Object.keys(tags.removed || {});
  const changed = Object.keys(tags.changed || {});
  const parts = [];

  if (added.length) parts.push(`added ${added.join(', ')}`);
  if (removed.length) parts.push(`removed ${removed.join(', ')}`);
  if (changed.length) parts.push(`updated ${changed.join(', ')}`);

  return parts.length ? `Tags: ${parts.join('; ')}` : 'Tags changed';
}

/**
 * One sentence for a whole resource.
 *
 * `kind` is the diff bucket the resource landed in.
 */
export function summariseChange(item, kind) {
  const what = shortType(item.type);
  const where = item.resource_group ? ` in ${item.resource_group}` : '';

  if (kind === 'added') {
    return `A new ${what} appeared${where}${item.location ? ` (${item.location})` : ''}.`;
  }

  if (kind === 'removed') {
    // Three causes, and this data cannot distinguish them. Saying "deleted"
    // outright would be a guess presented as a fact — and "access was lost" is
    // the one people never consider until it has already misled them.
    return `This ${what}${where} is no longer present. It was deleted, moved out of scope, or the credential lost access to it.`;
  }

  const changes = item.changes || [];
  if (!changes.length) return `This ${what} changed.`;
  if (changes.length === 1) return describeFieldChange(changes[0]);

  return `${changes.length} properties changed on this ${what}.`;
}
