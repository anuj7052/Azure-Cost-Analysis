/*
 * Shaping for the Access Optimization review.
 *
 * Everything here is a pure function over what the backend returned, kept out
 * of the page for two reasons. The obvious one is that this project has no DOM
 * test environment, so logic inside a component cannot be tested at all. The
 * less obvious one is that the filtering rules on this page decide whether
 * somebody's access gets revoked — a bug that quietly drops a finding is far
 * worse than one that renders badly, and it deserves to be provable.
 */

/** The kinds of finding the review produces, in the order they matter. */
export const OPTIMIZATION_KINDS = [
  { key: 'unused', label: 'Unused Role Assignment' },
  { key: 'over-privileged', label: 'Over-Privileged Access' },
  { key: 'over-scoped', label: 'Over-Scoped Access' },
  { key: 'stale', label: 'Stale Access' },
  { key: 'sprawl', label: 'Role Sprawl' },
  { key: 'redundant', label: 'Redundant Assignment' },
];

export const KIND_LABEL = Object.fromEntries(
  OPTIMIZATION_KINDS.map(k => [k.key, k.label]),
);

/**
 * The account types worth filtering by.
 *
 * A person leaving the company and an application nobody owns are both real
 * problems, but they are investigated by completely different people, so
 * separating them is the first thing anyone does with this list.
 */
export const PRINCIPAL_TYPES = [
  { key: 'user', label: 'Users' },
  { key: 'group', label: 'Groups' },
  { key: 'service principal', label: 'Service principals' },
  { key: 'managed identity', label: 'Managed identities' },
];

/**
 * Role filters, by what the role can do rather than by its name.
 *
 * Azure has hundreds of role names and a list of all of them is unusable. What
 * a reviewer actually wants is "show me the dangerous ones", and privilege
 * class is exactly that question.
 */
export const ROLE_TYPES = [
  { key: 'critical', label: 'Owner / access admin' },
  { key: 'management', label: 'Can change things' },
  { key: 'read', label: 'Read only' },
];

export const SORTS = [
  { key: 'most', label: 'Most optimizations' },
  { key: 'severity', label: 'Highest severity' },
  { key: 'name', label: 'Name (A–Z)' },
  { key: 'idle', label: 'Longest inactive' },
];

export const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

/** Verbs shown as chips on a card, in the order they appear in Azure. */
export const VERB_ORDER = ['create', 'write', 'delete', 'action', 'rbac'];

export const VERB_LABEL = {
  create: 'Create',
  write: 'Update',
  delete: 'Delete',
  action: 'Action',
  rbac: 'RBAC',
};

const MISSING = 'Not available';

function text(value) {
  return String(value ?? '').trim();
}

/**
 * A value, or an explicit statement that we do not have one.
 *
 * Zero is a value. An earlier version used a falsy check and printed "Not
 * available" next to every principal with no recorded operations — turning the
 * single most important measurement on the page into a rendering bug.
 */
export function shown(value) {
  if (value === null || value === undefined || value === '') return MISSING;
  return value;
}

/**
 * An Azure timestamp as a date a person can read, without a time.
 *
 * The hour an assignment was created is never the question; the question is
 * always "how long ago", and a date answers it without implying a precision the
 * comparison does not have.
 */
export function asDate(value) {
  const raw = text(value);
  if (!raw) return '';
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toLocaleDateString(undefined, {
    year: 'numeric', month: 'long', day: 'numeric',
  });
}

/**
 * How long since something happened, in words, or "" when unknown.
 *
 * `null` days and `0` days are different sentences and both are correct: one
 * means the log was never read, the other means they acted today.
 */
export function idleLabel(days) {
  if (days === null || days === undefined) return '';
  if (days <= 0) return 'Today';
  return `${days} day${days === 1 ? '' : 's'}`;
}

/**
 * The operation breakdown as chips, only for verbs that were actually counted.
 *
 * A missing `operations` bag means no Activity Log was read, and returns an
 * empty list so the card omits the row entirely rather than printing five
 * confident zeroes drawn from nothing.
 */
export function operationChips(operations) {
  if (!operations || typeof operations !== 'object') return [];
  return VERB_ORDER
    .filter(verb => typeof operations[verb] === 'number')
    .map(verb => ({ key: verb, label: VERB_LABEL[verb], count: operations[verb] }));
}

/** Where a grant applies, in the fewest accurate words. */
export function scopeLabel(finding) {
  return (
    text(finding?.management_group)
    || text(finding?.scope_label)
    || text(finding?.subscription_name)
    || ''
  );
}

/** Management group, subscription, resource group or resource — as a chip. */
export function scopeChip(finding) {
  const kind = text(finding?.scope_kind).toLowerCase();
  if (kind === 'management group' || text(finding?.management_group)) {
    return 'Management Group';
  }
  if (kind === 'tenant root') return 'Tenant Root';
  if (kind === 'resource group') return 'Resource Group';
  if (kind === 'resource') return 'Resource';
  return 'Subscription';
}

/**
 * Filter findings by everything the toolbar can ask.
 *
 * One function rather than a chain of `.filter` calls in the component, because
 * the rules interact: a search term narrows what the type filters see, and
 * getting the order wrong changes the count shown under them.
 */
export function filterFindings(findings, filters = {}) {
  const {
    kind = 'all',
    principalType = 'all',
    roleType = 'all',
    scope = 'all',
    managementGroup = 'all',
    query = '',
  } = filters;

  const needle = text(query).toLowerCase();

  return (findings || []).filter(f => {
    if (kind !== 'all' && f.kind !== kind) return false;
    if (principalType !== 'all') {
      if (text(f.principal_type).toLowerCase() !== principalType) return false;
    }
    if (roleType !== 'all' && text(f.privilege).toLowerCase() !== roleType) return false;
    if (scope !== 'all' && text(f.subscription_id) !== scope) return false;
    if (managementGroup !== 'all') {
      if (text(f.management_group) !== managementGroup) return false;
    }
    if (!needle) return true;
    // Searchable by what is on screen *and* by the identifiers underneath, so
    // an administrator holding a GUID from an Azure alert can find the finding
    // even though the page never shows that GUID to anybody else.
    return [
      f.principal_name, f.principal_upn, f.principal_type, f.role_name,
      f.scope_label, f.subscription_name, f.management_group, f.resource_name,
      f.resource_group, f.headline, f.principal_id, f.subscription_id, f.scope,
    ].some(v => text(v).toLowerCase().includes(needle));
  });
}

/**
 * One row per principal, counted, from a list of findings.
 *
 * The backend returns the same shape for the unfiltered list. This recomputes
 * it from whatever survived the filters, so the badges beside a name always
 * describe what clicking that name will actually show — a count that disagrees
 * with the list it opens is worse than no count.
 */
export function principalRows(findings, sort = 'most') {
  const people = new Map();

  for (const finding of findings || []) {
    const key = text(finding.principal_id).toLowerCase()
      || text(finding.principal_name).toLowerCase();
    if (!key) continue;

    let entry = people.get(key);
    if (!entry) {
      entry = {
        key,
        principal_id: text(finding.principal_id),
        principal_name: text(finding.principal_name),
        principal_upn: text(finding.principal_upn),
        principal_type: text(finding.principal_type),
        resolved: Boolean(finding.resolved),
        severities: {},
        count: 0,
        hidden: 0,
        idle: null,
      };
      people.set(key, entry);
    }

    entry.count += 1;
    if (finding.hidden) entry.hidden += 1;
    if (finding.resolved) entry.resolved = true;
    const severity = text(finding.severity).toLowerCase() || 'low';
    entry.severities[severity] = (entry.severities[severity] || 0) + 1;

    const days = finding?.usage?.days_inactive;
    if (typeof days === 'number' && (entry.idle === null || days > entry.idle)) {
      entry.idle = days;
    }
  }

  return sortPrincipals([...people.values()], sort);
}

export function sortPrincipals(rows, sort = 'most') {
  const byName = (a, b) => a.principal_name.localeCompare(b.principal_name);
  const worst = row => Math.min(
    ...Object.keys(row.severities).map(s => SEVERITY_RANK[s] ?? 9),
    9,
  );

  const copy = [...rows];
  if (sort === 'name') copy.sort(byName);
  else if (sort === 'severity') copy.sort((a, b) => worst(a) - worst(b) || b.count - a.count || byName(a, b));
  else if (sort === 'idle') {
    // Unknown inactivity sorts last, never first. A principal whose usage was
    // never read has no claim to the top of a list ordered by how long access
    // has sat unused.
    const days = r => (r.idle === null ? -1 : r.idle);
    copy.sort((a, b) => days(b) - days(a) || byName(a, b));
  } else copy.sort((a, b) => b.count - a.count || worst(a) - worst(b) || byName(a, b));
  return copy;
}

/** The findings belonging to one principal, in the chosen card order. */
export function findingsFor(findings, principalKey, sort = 'kind') {
  const key = text(principalKey).toLowerCase();
  const mine = (findings || []).filter(f => {
    const own = text(f.principal_id).toLowerCase() || text(f.principal_name).toLowerCase();
    return own === key;
  });

  const rank = f => OPTIMIZATION_KINDS.findIndex(k => k.key === f.kind);
  const severity = f => SEVERITY_RANK[text(f.severity).toLowerCase()] ?? 9;

  const copy = [...mine];
  if (sort === 'severity') copy.sort((a, b) => severity(a) - severity(b) || rank(a) - rank(b));
  else if (sort === 'role') {
    copy.sort((a, b) => text(a.role_name).localeCompare(text(b.role_name)) || rank(a) - rank(b));
  } else copy.sort((a, b) => rank(a) - rank(b) || severity(a) - severity(b));
  return copy;
}

/**
 * The subscriptions present in a set of findings, named rather than numbered.
 *
 * Built from the findings themselves so the filter can only ever offer scopes
 * the reader already has in front of them — it cannot widen the review by
 * accident.
 */
export function subscriptionOptions(findings) {
  const seen = new Map();
  for (const f of findings || []) {
    const id = text(f.subscription_id);
    if (!id || seen.has(id)) continue;
    seen.set(id, text(f.subscription_name) || 'Unnamed subscription');
  }
  return [...seen.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The management groups present in a set of findings. */
export function managementGroupOptions(findings) {
  const seen = new Set();
  for (const f of findings || []) {
    const name = text(f.management_group);
    if (name) seen.add(name);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/**
 * Flatten a management group tree for a select element.
 *
 * The backend already returns a flat list with depths; this handles the case
 * where only the nested form is available, and is the same walk either way.
 */
export function flattenGroups(nodes, depth = 0) {
  const rows = [];
  for (const node of nodes || []) {
    rows.push({
      id: node.id,
      name: node.name,
      display_name: node.display_name || node.name,
      depth,
      subscription_count: (node.subscriptions || []).length,
    });
    rows.push(...flattenGroups(node.children, depth + 1));
  }
  return rows;
}

/**
 * Whether this finding can be acted on, and if not, why.
 *
 * Deciding this before drawing the button is the point. The alternative is a
 * Revoke button that always appears and sometimes returns 400, which teaches
 * people that the errors on this page are noise — on the one page where they
 * must not learn that.
 *
 * Three separate reasons, because they send the reader to three different
 * places: a sprawl finding is about a pattern with no single grant to remove, a
 * management-group grant has to be changed in the portal, and a group
 * assignment would take access from everyone inside it at once.
 */
export function actionability(finding) {
  const scope = text(finding?.scope);
  const kind = text(finding?.scope_kind).toLowerCase();

  if (!text(finding?.assignment_id)) {
    return {
      can: false,
      reason:
        'This finding is about a pattern across several grants, not one '
        + 'assignment. Open the individual grants to change any of them.',
    };
  }

  if (kind === 'management group' || kind === 'tenant root' || !scope.toLowerCase().startsWith('/subscriptions/')) {
    return {
      can: false,
      reason:
        'This grant was made above subscription level. Changing it affects '
        + 'every subscription underneath, and it has to be done in the Azure '
        + 'portal where the full blast radius is visible.',
    };
  }

  if (text(finding?.principal_type).toLowerCase() === 'group') {
    return {
      can: true,
      warning:
        'This is a group. Removing it takes this access from everybody in it '
        + 'at once, and the members are not listed here.',
    };
  }

  return { can: true };
}

/**
 * The role definition id for a recommended role name, from what Azure offers
 * at that scope.
 *
 * Returns "" rather than a guess when the name is not on offer. The
 * recommendation names a *tier* — "Reader", "Contributor" — and a tenant can
 * rename or withhold either; picking the nearest match would silently grant a
 * role nobody chose.
 */
export function roleIdFor(roles, roleName) {
  const wanted = text(roleName).toLowerCase();
  if (!wanted) return '';
  const match = (roles || []).find(r => text(r.role_name || r.name).toLowerCase() === wanted);
  return match ? text(match.id || match.role_definition_id) : '';
}
