/**
 * Presentation logic for the permission list.
 *
 * The backend owns what is required; this file only decides how to say it.
 * Keeping the two apart means the security team's answer and the screen's
 * answer cannot disagree.
 */

export const CORE = 'core';
export const FULL_READ = 'full-read';
export const WRITE = 'write';

export const READ = 'read';
export const CHANGE = 'change';

/**
 * Colour by what a tier can do, not by how far down the page it is.
 *
 * Read and change are genuinely different kinds of risk, and a reader
 * skimming should be able to tell them apart without reading the words.
 */
export const TIER_TONE = {
  [CORE]: {
    border: 'border-blue-500/30',
    bg: 'bg-blue-500/5',
    chip: 'bg-blue-500/15 text-blue-300',
  },
  [FULL_READ]: {
    border: 'border-emerald-500/30',
    bg: 'bg-emerald-500/5',
    chip: 'bg-emerald-500/15 text-emerald-300',
  },
  [WRITE]: {
    border: 'border-amber-500/40',
    bg: 'bg-amber-500/5',
    chip: 'bg-amber-500/15 text-amber-300',
  },
};

export const FALLBACK_TONE = {
  border: 'border-slate-700',
  bg: 'bg-slate-900',
  chip: 'bg-slate-800 text-slate-300',
};

export function toneFor(tier) {
  return TIER_TONE[tier] || FALLBACK_TONE;
}

export const ACCESS_LABEL = {
  [READ]: 'Read only',
  [CHANGE]: 'Can change Azure',
};

export function accessLabel(access) {
  return ACCESS_LABEL[access] || 'Unknown';
}

/**
 * A short line stating whether granting a tier is reversible in effect.
 *
 * "Read only" is the reassurance people are actually looking for, so it is
 * stated plainly rather than left to be inferred from the absence of a
 * warning.
 */
export function tierVerdict(tier) {
  if (!tier) return '';
  const count = (tier.azure_roles?.length || 0) + (tier.graph_permissions?.length || 0);
  if (!count) return 'Nothing to grant here.';
  const noun = count === 1 ? 'permission' : 'permissions';
  return tier.read_only
    ? `${count} ${noun}, none of which can change anything in Azure.`
    : `${count} ${noun}. Some of these let the app make changes.`;
}

/** Everything in a tier, roles and directory permissions together, in order. */
export function entriesOf(tier) {
  if (!tier) return [];
  return [...(tier.azure_roles || []), ...(tier.graph_permissions || [])];
}

/** Every entry across every tier. Used for search and for counting. */
export function allEntries(manifest) {
  return (manifest?.tiers || []).flatMap(entriesOf);
}

/**
 * Narrow the list.
 *
 * Matching on `unlocks` as well as the name matters: people arrive here
 * asking "why can't I see Commitments?", not "what does Reservation Reader
 * do?".
 */
export function filterEntries(entries, query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return entries;
  return entries.filter((e) => {
    const haystack = [
      e.name,
      e.why,
      e.scope_label,
      ...(e.unlocks || []),
    ].join(' ').toLowerCase();
    return haystack.includes(q);
  });
}

/**
 * Which pages stop working without a given entry.
 *
 * Returned as a sentence because a bare list of feature names reads as a
 * feature list rather than as a consequence.
 */
export function costOfSkipping(entry) {
  const unlocks = entry?.unlocks || [];
  if (!unlocks.length) return '';
  if (unlocks.length === 1) return `Without this: ${unlocks[0]} will not work.`;
  const last = unlocks[unlocks.length - 1];
  const rest = unlocks.slice(0, -1).join(', ');
  return `Without this: ${rest} and ${last} will not work.`;
}

/** True when the entry is a directory permission rather than an RBAC role. */
export function isDirectory(entry) {
  return entry?.kind === 'graph-permission';
}

/**
 * The `az` command for one role, or null.
 *
 * Mirrors the backend deliberately rather than trusting a field, so that a
 * role which cannot be granted this way never produces a copyable command
 * that would fail.
 */
export function assignCommand(entry, subscriptionId, assignee) {
  if (!entry || isDirectory(entry) || !entry.assignable) return null;
  const sub = (subscriptionId || '').trim() || '<subscription-id>';
  const who = (assignee || '').trim() || '<user-or-app-id>';
  const scope = entry.scope === 'management-group'
    ? '/providers/Microsoft.Management/managementGroups/<management-group-id>'
    : `/subscriptions/${sub}`;
  return `az role assignment create --assignee ${who} --role "${entry.name}" --scope ${scope}`;
}

/**
 * Every command for a tier, ready to paste as a block.
 *
 * Unassignable roles are dropped rather than commented out, because a script
 * that half-works is harder to reason about than one that is honestly
 * incomplete and says so elsewhere.
 */
export function assignScript(tier, subscriptionId, assignee) {
  return entriesOf(tier)
    .map((e) => assignCommand(e, subscriptionId, assignee))
    .filter(Boolean)
    .join('\n');
}

/** Entries in a tier that cannot be granted with a role assignment. */
export function manualEntries(tier) {
  return entriesOf(tier).filter(
    (e) => !isDirectory(e) && e.assignable === false,
  );
}

/** Directory permissions anywhere in the manifest that need an administrator. */
export function needsAdmin(manifest) {
  return allEntries(manifest).filter((e) => isDirectory(e) && e.admin_consent);
}

/**
 * The headline.
 *
 * Leads with the read/change split because that is the only number that
 * changes anyone's decision.
 */
export function headline(manifest) {
  const s = manifest?.summary;
  if (!s || !s.total) return 'Not available';
  if (!s.change) return `${s.total} permissions, all read-only.`;
  return `${s.total} permissions — ${s.read} read-only, ${s.change} that can change Azure.`;
}
