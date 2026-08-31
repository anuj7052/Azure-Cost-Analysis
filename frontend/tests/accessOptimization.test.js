import { describe, it, expect } from 'vitest';
import {
  shown, asDate, idleLabel, operationChips, scopeChip, scopeLabel,
  filterFindings, principalRows, sortPrincipals, findingsFor,
  subscriptionOptions, managementGroupOptions, flattenGroups,
  actionability, roleIdFor,
  cardsFor, sortFindings, principalKeyOf, CARD_SCOPES,
  OPTIMIZATION_KINDS,
} from '../src/utils/accessOptimization';

function finding(over = {}) {
  return {
    kind: 'unused',
    severity: 'high',
    principal_id: 'p1',
    principal_name: 'Amber Chen',
    principal_upn: 'amber@example.com',
    principal_type: 'User',
    privilege: 'critical',
    role_name: 'Contributor',
    resolved: true,
    subscription_id: 'sub-1',
    subscription_name: 'Production',
    management_group: '',
    scope_kind: 'subscription',
    scope_label: 'Production',
    usage: { days_inactive: 140, activity_count: 9, operations: {} },
    ...over,
  };
}

describe('missing values are said, not guessed', () => {
  it('keeps a zero rather than calling it unavailable', () => {
    expect(shown(0)).toBe(0);
  });

  it('says so plainly when there is nothing', () => {
    expect(shown('')).toBe('Not available');
    expect(shown(null)).toBe('Not available');
    expect(shown(undefined)).toBe('Not available');
  });

  it('returns an empty string for a date it cannot read, not "Invalid Date"', () => {
    expect(asDate('not-a-date')).toBe('');
    expect(asDate('')).toBe('');
  });

  it('reads a real timestamp as a date', () => {
    expect(asDate('2024-06-15T09:00:00Z')).toContain('2024');
  });
});

describe('how long access has sat unused', () => {
  it('distinguishes never-measured from measured-as-zero', () => {
    expect(idleLabel(null)).toBe('');
    expect(idleLabel(undefined)).toBe('');
    expect(idleLabel(0)).toBe('Today');
  });

  it('agrees with itself about singular and plural', () => {
    expect(idleLabel(1)).toBe('1 day');
    expect(idleLabel(140)).toBe('140 days');
  });
});

describe('operation chips', () => {
  it('shows nothing at all when no log was read', () => {
    expect(operationChips(null)).toEqual([]);
    expect(operationChips({})).toEqual([]);
  });

  it('keeps a verb that was counted as zero', () => {
    const chips = operationChips({ create: 0, write: 33, rbac: 0 });
    expect(chips.map(c => [c.label, c.count])).toEqual([
      ['Create', 0], ['Update', 33], ['RBAC', 0],
    ]);
  });

  it('never invents a verb the backend did not count', () => {
    expect(operationChips({ write: 4 }).map(c => c.key)).toEqual(['write']);
  });
});

describe('naming the scope', () => {
  it('calls a management group grant a management group', () => {
    expect(scopeChip(finding({ scope_kind: 'management group' }))).toBe('Management Group');
  });

  it('treats a grant carrying a group name as a group even if the kind is vague', () => {
    expect(scopeChip(finding({ scope_kind: '', management_group: 'Contoso' }))).toBe('Management Group');
  });

  it('names the other levels', () => {
    expect(scopeChip(finding({ scope_kind: 'tenant root' }))).toBe('Tenant Root');
    expect(scopeChip(finding({ scope_kind: 'resource group' }))).toBe('Resource Group');
    expect(scopeChip(finding({ scope_kind: 'resource' }))).toBe('Resource');
    expect(scopeChip(finding())).toBe('Subscription');
  });

  it('prefers the management group name over the subscription when both exist', () => {
    expect(scopeLabel(finding({ management_group: 'Platform' }))).toBe('Platform');
  });

  it('returns an empty label rather than a scope path', () => {
    expect(scopeLabel({ scope: '/subscriptions/abc/resourceGroups/rg' })).toBe('');
  });
});

describe('filtering', () => {
  const rows = [
    finding(),
    finding({ principal_id: 'p2', principal_name: 'Ava Moreau', kind: 'stale', privilege: 'management', principal_type: 'Service principal' }),
    finding({ principal_id: 'p3', principal_name: 'sp-deploy-legacy', kind: 'redundant', privilege: 'read', subscription_id: 'sub-2', subscription_name: 'Dev', management_group: 'Contoso' }),
  ];

  it('returns everything when nothing is asked', () => {
    expect(filterFindings(rows, {})).toHaveLength(3);
  });

  it('narrows by optimization kind', () => {
    expect(filterFindings(rows, { kind: 'stale' }).map(f => f.principal_id)).toEqual(['p2']);
  });

  it('narrows by what the role can do, not by its name', () => {
    expect(filterFindings(rows, { roleType: 'read' }).map(f => f.principal_id)).toEqual(['p3']);
  });

  it('narrows by account type case-insensitively', () => {
    expect(filterFindings(rows, { principalType: 'service principal' })).toHaveLength(1);
  });

  it('narrows by subscription and by management group independently', () => {
    expect(filterFindings(rows, { scope: 'sub-2' })).toHaveLength(1);
    expect(filterFindings(rows, { managementGroup: 'Contoso' })).toHaveLength(1);
  });

  it('applies every filter together rather than the last one', () => {
    expect(filterFindings(rows, { kind: 'stale', roleType: 'read' })).toHaveLength(0);
  });

  it('searches the identifiers the page never displays', () => {
    expect(filterFindings(rows, { query: 'p3' })).toHaveLength(1);
  });

  it('searches what is on screen', () => {
    expect(filterFindings(rows, { query: 'ava' }).map(f => f.principal_id)).toEqual(['p2']);
  });

  it('survives a missing list', () => {
    expect(filterFindings(null, { kind: 'stale' })).toEqual([]);
  });
});

describe('the principal column', () => {
  const rows = [
    finding(),
    finding({ kind: 'over-privileged', severity: 'high' }),
    finding({ principal_id: 'p2', principal_name: 'Ava Moreau', severity: 'medium', usage: { days_inactive: 18 } }),
  ];

  it('counts one row per principal, not one per finding', () => {
    expect(principalRows(rows).map(r => r.principal_id)).toEqual(['p1', 'p2']);
  });

  it('counts findings by severity beside the name', () => {
    const [first] = principalRows(rows);
    expect(first.count).toBe(2);
    expect(first.severities.high).toBe(2);
  });

  it('puts the busiest principal first by default', () => {
    expect(principalRows(rows)[0].principal_id).toBe('p1');
  });

  it('sorts alphabetically when asked', () => {
    expect(principalRows(rows, 'name').map(r => r.principal_name))
      .toEqual(['Amber Chen', 'Ava Moreau']);
  });

  it('sorts by longest inactive, and keeps unknown inactivity last', () => {
    const withUnknown = [
      finding({ principal_id: 'p9', principal_name: 'Zoe', usage: { days_inactive: null } }),
      ...rows,
    ];
    const order = principalRows(withUnknown, 'idle').map(r => r.principal_id);
    expect(order[0]).toBe('p1');
    expect(order[order.length - 1]).toBe('p9');
  });

  it('counts accepted findings separately from the total', () => {
    const [first] = principalRows([finding({ hidden: true }), finding()]);
    expect(first.count).toBe(2);
    expect(first.hidden).toBe(1);
  });

  it('ignores a finding with no principal at all rather than making one up', () => {
    expect(principalRows([{ severity: 'high' }])).toEqual([]);
  });

  it('does not mutate the list it was given', () => {
    const input = principalRows(rows);
    const before = input.map(r => r.principal_id);
    sortPrincipals(input, 'name');
    expect(input.map(r => r.principal_id)).toEqual(before);
  });
});

describe('the card list for one principal', () => {
  const rows = [
    finding({ kind: 'redundant', severity: 'low' }),
    finding({ kind: 'unused', severity: 'high' }),
    finding({ principal_id: 'p2', principal_name: 'Ava' }),
  ];

  it('returns only that principal', () => {
    expect(findingsFor(rows, 'p1')).toHaveLength(2);
  });

  it('matches the key case-insensitively, because Azure is inconsistent about it', () => {
    expect(findingsFor(rows, 'P1')).toHaveLength(2);
  });

  it('orders by optimization type in the order the kinds are declared', () => {
    const order = findingsFor(rows, 'p1', 'kind').map(f => f.kind);
    const declared = OPTIMIZATION_KINDS.map(k => k.key);
    expect(declared.indexOf(order[0])).toBeLessThan(declared.indexOf(order[1]));
  });

  it('orders by severity when asked', () => {
    expect(findingsFor(rows, 'p1', 'severity')[0].severity).toBe('high');
  });
});

describe('filter options come from the findings themselves', () => {
  const rows = [
    finding(),
    finding({ subscription_id: 'sub-2', subscription_name: 'Dev', management_group: 'Contoso' }),
    finding({ subscription_id: '', subscription_name: '' }),
  ];

  it('offers each subscription once, named and sorted', () => {
    expect(subscriptionOptions(rows).map(s => s.name)).toEqual(['Dev', 'Production']);
  });

  it('never offers a subscription that is not in the data', () => {
    expect(subscriptionOptions(rows).map(s => s.id)).not.toContain('');
  });

  it('offers only management groups that actually appear', () => {
    expect(managementGroupOptions(rows)).toEqual(['Contoso']);
    expect(managementGroupOptions([finding()])).toEqual([]);
  });
});

describe('flattening the group hierarchy', () => {
  const tree = [{
    id: '/mg/root', name: 'root', display_name: 'Contoso',
    subscriptions: [{ subscription_id: 's1' }],
    children: [{ id: '/mg/prod', name: 'prod', display_name: 'Production', children: [] }],
  }];

  it('keeps depth so a dropdown can show the shape', () => {
    expect(flattenGroups(tree).map(r => r.depth)).toEqual([0, 1]);
  });

  it('carries the subscription count', () => {
    expect(flattenGroups(tree)[0].subscription_count).toBe(1);
  });

  it('is safe on an empty tenant', () => {
    expect(flattenGroups(null)).toEqual([]);
  });
});

describe('what can actually be acted on', () => {
  const grant = (over = {}) => ({
    assignment_id: '/subscriptions/a/providers/Microsoft.Authorization/roleAssignments/1',
    scope: '/subscriptions/a',
    scope_kind: 'subscription',
    principal_type: 'user',
    ...over,
  });

  it('allows a normal subscription-scoped grant', () => {
    expect(actionability(grant()).can).toBe(true);
  });

  it('refuses a finding with no single assignment behind it', () => {
    const act = actionability(grant({ assignment_id: '' }));
    expect(act.can).toBe(false);
    expect(act.reason).toMatch(/pattern across several grants/);
  });

  it('refuses a management group grant and says to use the portal', () => {
    // The server rejects these too. Deciding it here means the reason is
    // readable, rather than arriving as a 400 after the click.
    const act = actionability(grant({
      scope: '/providers/Microsoft.Management/managementGroups/prod',
      scope_kind: 'management group',
      assignment_id: '/providers/Microsoft.Management/managementGroups/prod/providers/Microsoft.Authorization/roleAssignments/1',
    }));
    expect(act.can).toBe(false);
    expect(act.reason).toMatch(/Azure portal/);
  });

  it('refuses tenant root', () => {
    expect(actionability(grant({ scope: '/', scope_kind: 'tenant root' })).can).toBe(false);
  });

  it('allows a group but warns that members are not listed', () => {
    const act = actionability(grant({ principal_type: 'Group' }));
    expect(act.can).toBe(true);
    expect(act.warning).toMatch(/everybody in it/);
  });

  it('does not warn for a plain user', () => {
    expect(actionability(grant()).warning).toBeUndefined();
  });

  it('treats a missing finding as not actionable rather than throwing', () => {
    expect(actionability(undefined).can).toBe(false);
  });
});

describe('resolving a recommended role name to an id', () => {
  const roles = [
    { id: '/rd/reader', role_name: 'Reader' },
    { id: '/rd/contrib', role_name: 'Contributor' },
  ];

  it('finds the role regardless of case', () => {
    expect(roleIdFor(roles, 'contributor')).toBe('/rd/contrib');
  });

  it('returns nothing when the role is not on offer', () => {
    // A near match would silently grant a role nobody chose.
    expect(roleIdFor(roles, 'Cost Management Reader')).toBe('');
  });

  it('returns nothing for an empty name or empty list', () => {
    expect(roleIdFor(roles, '')).toBe('');
    expect(roleIdFor([], 'Reader')).toBe('');
    expect(roleIdFor(undefined, 'Reader')).toBe('');
  });

  it('accepts the alternative field names Azure responses use', () => {
    expect(roleIdFor([{ role_definition_id: '/rd/x', name: 'Reader' }], 'Reader')).toBe('/rd/x');
  });
});

describe('cardsFor', () => {
  const amber = finding({ principal_id: 'p1', principal_name: 'Amber Chen' });
  const rijul = finding({ principal_id: 'p2', principal_name: 'Rijul Sharma', kind: 'over_privileged' });
  const all = [amber, rijul];

  it('shows only the selected principal by default', () => {
    const cards = cardsFor(all, { principalKey: 'p1' });
    expect(cards).toHaveLength(1);
    expect(cards[0].principal_name).toBe('Amber Chen');
  });

  it('never leaks another principal into a selection', () => {
    for (const key of ['p1', 'p2']) {
      const cards = cardsFor(all, { principalKey: key });
      expect(cards.every(c => principalKeyOf(c) === key)).toBe(true);
    }
  });

  it('shows everything when the scope is all', () => {
    expect(cardsFor(all, { scope: 'all', principalKey: 'p1' })).toHaveLength(2);
  });

  it('ignores the selection entirely in all scope', () => {
    expect(cardsFor(all, { scope: 'all', principalKey: '' })).toHaveLength(2);
  });

  it('returns nothing rather than everything when no principal is selected', () => {
    expect(cardsFor(all, { principalKey: '' })).toEqual([]);
  });

  it('falls back to the name when a finding carries no id', () => {
    const nameless = finding({ principal_id: '', principal_name: 'Ghost' });
    expect(principalKeyOf(nameless)).toBe('ghost');
    expect(cardsFor([nameless], { principalKey: 'ghost' })).toHaveLength(1);
  });

  it('can order the combined view by principal', () => {
    const sorted = sortFindings(all, 'principal');
    expect(sorted.map(f => f.principal_name)).toEqual(['Amber Chen', 'Rijul Sharma']);
  });

  it('offers exactly the two scopes the pane implements', () => {
    expect(CARD_SCOPES.map(s => s.key)).toEqual(['principal', 'all']);
  });

  it('tolerates a missing list', () => {
    expect(cardsFor(undefined, { scope: 'all' })).toEqual([]);
    expect(cardsFor(null, { principalKey: 'p1' })).toEqual([]);
  });
});
