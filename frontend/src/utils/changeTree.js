/**
 * Shaping a diff for the change-tracking page.
 *
 * These are the parts worth testing on their own: there is no DOM in this test
 * setup, and the decisions here — how a resource is grouped, what counts as a
 * property, what "deleted" means for a bag of settings — are the ones that
 * would quietly misreport somebody's estate if they were wrong.
 */

/**
 * How the left-hand columns are built.
 *
 * `secondary` is what produces a third column. Region alone reads fine as two
 * columns; region *and* resource group needs three, and forcing every grouping
 * into the same shape would leave an empty middle column for most of them.
 */
export const GROUPINGS = [
  { key: 'subscription', label: 'Subscription', primary: 'subscription_id', secondary: 'resource_group' },
  { key: 'type', label: 'Resource type', primary: 'type', secondary: null },
  { key: 'location', label: 'Region', primary: 'location', secondary: null },
  { key: 'location_rg', label: 'Region and RG', primary: 'location', secondary: 'resource_group' },
];

export const UNASSIGNED = 'Unassigned';

/** Flatten a diff response into one list, each entry tagged with its bucket. */
export function toEntries(diff) {
  if (!diff) return [];
  const out = [];
  for (const kind of ['added', 'removed', 'modified']) {
    for (const item of diff[kind] || []) out.push({ ...item, kind });
  }
  return out;
}

/**
 * Group entries by one column, carrying the counts each group needs to show.
 *
 * Sorted by size rather than alphabetically. The reason to group at all is to
 * find where the activity was, and a subscription with forty changes should not
 * be below one with a single tag edit because of its name.
 */
export function groupBy(entries, column) {
  const buckets = new Map();

  for (const entry of entries) {
    const key = entry[column] || UNASSIGNED;
    const row = buckets.get(key)
      || { key, added: 0, removed: 0, modified: 0, items: [] };
    row[entry.kind] += 1;
    row.items.push(entry);
    buckets.set(key, row);
  }

  return [...buckets.values()]
    .map(row => ({ ...row, total: row.items.length }))
    .sort((a, b) => (b.total - a.total) || a.key.localeCompare(b.key));
}

/**
 * Turn a configuration bag into leaf paths.
 *
 * Used to describe a resource that was added or deleted outright: there is no
 * before-and-after for those, but "these are the settings that went away" is
 * still the thing somebody needs to read during an incident.
 *
 * Lists are kept whole. Azure reorders them freely, so numbering their elements
 * would imply a stability that is not there.
 */
export function flattenBag(bag, prefix = '', depth = 0) {
  if (!bag || typeof bag !== 'object' || Array.isArray(bag) || depth > 6) return [];

  const out = [];
  for (const key of Object.keys(bag).sort()) {
    const path = prefix ? `${prefix}.${key}` : key;
    const value = bag[key];
    if (value && typeof value === 'object' && !Array.isArray(value) && depth < 6) {
      const nested = flattenBag(value, path, depth + 1);
      // An empty object has no leaves, but it is still a setting that existed.
      // Dropping it silently would understate what was removed.
      if (nested.length) out.push(...nested);
      else out.push({ field: path, value: '{}' });
    } else {
      out.push({ field: path, value: readable(value) });
    }
  }
  return out;
}

/** One line describing a value, for a table cell. */
export function readable(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'object') {
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}

/**
 * Nest dotted property paths so a large bag can be collapsed.
 *
 * A storage account can produce sixty differences, most of them under two or
 * three parents. Flat, that is a wall nobody reads; nested, the parents are a
 * summary and the detail is one click away.
 *
 * Fields with no dot — Region, SKU, Tags — stay at the top, because those are
 * the ones people came to see.
 */
export function toPropertyTree(changes) {
  const root = { name: '', children: new Map(), leaves: [] };

  for (const change of changes || []) {
    const parts = String(change.field || '').split('.');
    let node = root;

    for (const part of parts.slice(0, -1)) {
      if (!node.children.has(part)) {
        node.children.set(part, { name: part, children: new Map(), leaves: [] });
      }
      node = node.children.get(part);
    }

    node.leaves.push({ ...change, leaf: parts[parts.length - 1] });
  }

  return root;
}

/** How many differences sit anywhere beneath a node, for its badge. */
export function countLeaves(node) {
  let total = node.leaves.length;
  for (const child of node.children.values()) total += countLeaves(child);
  return total;
}
