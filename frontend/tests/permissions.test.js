import { describe, it, expect } from 'vitest';
import {
  CORE, FULL_READ, WRITE, READ, CHANGE,
  toneFor, FALLBACK_TONE, accessLabel, tierVerdict, entriesOf, allEntries,
  filterEntries, costOfSkipping, isDirectory, assignCommand, assignScript,
  manualEntries, needsAdmin, headline,
} from '../src/utils/permissions';

const role = (over = {}) => ({
  kind: 'azure-role',
  name: 'Reader',
  access: READ,
  scope: 'subscription',
  scope_label: 'Each subscription',
  why: 'Lists resources.',
  unlocks: ['Estate'],
  assignable: true,
  caveat: '',
  ...over,
});

const perm = (over = {}) => ({
  kind: 'graph-permission',
  name: 'Directory.Read.All',
  access: READ,
  scope: 'directory',
  scope_label: 'Entra tenant',
  why: 'Resolves GUIDs to names.',
  unlocks: ['Access & Identity'],
  admin_consent: true,
  ...over,
});

const tier = (over = {}) => ({
  key: CORE,
  label: 'Essential',
  summary: 'The minimum.',
  read_only: true,
  azure_roles: [role()],
  graph_permissions: [],
  ...over,
});

describe('colouring by what a permission can do', () => {
  it('gives each known tier its own tone', () => {
    const tones = [CORE, FULL_READ, WRITE].map(t => toneFor(t).chip);
    expect(new Set(tones).size).toBe(3);
  });

  it('falls back rather than crashing on a tier it does not know', () => {
    expect(toneFor('something-new')).toBe(FALLBACK_TONE);
    expect(toneFor(undefined)).toBe(FALLBACK_TONE);
  });
});

describe('naming the kind of access', () => {
  it('says read only plainly', () => {
    expect(accessLabel(READ)).toBe('Read only');
  });

  it('does not soften the fact that something can write', () => {
    expect(accessLabel(CHANGE)).toBe('Can change Azure');
  });

  it('admits when it does not know', () => {
    expect(accessLabel('weird')).toBe('Unknown');
    expect(accessLabel(undefined)).toBe('Unknown');
  });
});

describe('summarising a tier in one line', () => {
  it('states that a read-only tier changes nothing', () => {
    const line = tierVerdict(tier());
    expect(line).toContain('none of which can change');
  });

  it('warns when a tier can change things', () => {
    const line = tierVerdict(tier({ read_only: false, azure_roles: [role(), role()] }));
    expect(line).toContain('make changes');
  });

  it('counts roles and directory permissions together', () => {
    const line = tierVerdict(tier({ graph_permissions: [perm()] }));
    expect(line).toContain('2 permissions');
  });

  it('uses the singular for one', () => {
    expect(tierVerdict(tier())).toContain('1 permission,');
  });

  it('handles an empty tier without pretending', () => {
    expect(tierVerdict(tier({ azure_roles: [] }))).toBe('Nothing to grant here.');
  });

  it('returns nothing for a missing tier', () => {
    expect(tierVerdict(null)).toBe('');
  });
});

describe('flattening the list', () => {
  it('puts roles before directory permissions', () => {
    const out = entriesOf(tier({ graph_permissions: [perm()] }));
    expect(out.map(e => e.kind)).toEqual(['azure-role', 'graph-permission']);
  });

  it('survives a tier with neither', () => {
    expect(entriesOf({ key: 'x' })).toEqual([]);
    expect(entriesOf(null)).toEqual([]);
  });

  it('walks every tier', () => {
    const manifest = { tiers: [tier(), tier({ graph_permissions: [perm()] })] };
    expect(allEntries(manifest)).toHaveLength(3);
  });

  it('treats a missing manifest as empty', () => {
    expect(allEntries(null)).toEqual([]);
  });
});

describe('searching', () => {
  const entries = [role(), perm(), role({ name: 'Security Reader', unlocks: ['Security'] })];

  it('returns everything for an empty query', () => {
    expect(filterEntries(entries, '')).toHaveLength(3);
    expect(filterEntries(entries, '   ')).toHaveLength(3);
  });

  it('matches on the role name', () => {
    expect(filterEntries(entries, 'security')).toHaveLength(1);
  });

  it('matches on the page somebody is actually looking for', () => {
    // People arrive asking why a page is missing, not what a role is called.
    const hit = filterEntries(entries, 'access & identity');
    expect(hit).toHaveLength(1);
    expect(hit[0].name).toBe('Directory.Read.All');
  });

  it('ignores case', () => {
    expect(filterEntries(entries, 'READER')).toHaveLength(2);
  });

  it('returns nothing when nothing matches', () => {
    expect(filterEntries(entries, 'kubernetes')).toEqual([]);
  });
});

describe('saying what breaks without a permission', () => {
  it('uses a single clause for one page', () => {
    expect(costOfSkipping(role())).toBe('Without this: Estate will not work.');
  });

  it('joins two with and', () => {
    const out = costOfSkipping(role({ unlocks: ['Estate', 'Dashboard'] }));
    expect(out).toBe('Without this: Estate and Dashboard will not work.');
  });

  it('uses commas then and for three', () => {
    const out = costOfSkipping(role({ unlocks: ['A', 'B', 'C'] }));
    expect(out).toBe('Without this: A, B and C will not work.');
  });

  it('says nothing when there is nothing to say', () => {
    expect(costOfSkipping(role({ unlocks: [] }))).toBe('');
    expect(costOfSkipping(null)).toBe('');
  });
});

describe('telling a role from a directory permission', () => {
  it('recognises a directory permission', () => {
    expect(isDirectory(perm())).toBe(true);
  });

  it('recognises a role', () => {
    expect(isDirectory(role())).toBe(false);
  });

  it('does not crash on nothing', () => {
    expect(isDirectory(null)).toBe(false);
  });
});

describe('building the grant command', () => {
  it('scopes a subscription role to the subscription', () => {
    const cmd = assignCommand(role(), 'sub-1', 'someone');
    expect(cmd).toContain('--scope /subscriptions/sub-1');
    expect(cmd).toContain('--assignee someone');
  });

  it('scopes a management group role to a management group', () => {
    const cmd = assignCommand(role({ scope: 'management-group' }), 'sub-1', 'x');
    expect(cmd).toContain('managementGroups/');
    expect(cmd).not.toContain('/subscriptions/sub-1');
  });

  it('shows obvious placeholders rather than empty flags', () => {
    const cmd = assignCommand(role(), '', '');
    expect(cmd).toContain('<subscription-id>');
    expect(cmd).toContain('<user-or-app-id>');
  });

  it('refuses to build a command for a role that cannot be assigned that way', () => {
    // A command that always fails is worse than no command.
    expect(assignCommand(role({ assignable: false }))).toBeNull();
  });

  it('refuses for a directory permission', () => {
    expect(assignCommand(perm())).toBeNull();
  });

  it('refuses for nothing at all', () => {
    expect(assignCommand(null)).toBeNull();
  });
});

describe('building a script for a whole tier', () => {
  it('produces one line per assignable role', () => {
    const t = tier({ azure_roles: [role(), role({ name: 'Cost Management Reader' })] });
    expect(assignScript(t, 'sub-1', 'me').split('\n')).toHaveLength(2);
  });

  it('leaves out what cannot be granted this way', () => {
    const t = tier({ azure_roles: [role(), role({ name: 'Reservation Reader', assignable: false })] });
    const script = assignScript(t, 'sub-1', 'me');
    expect(script).not.toContain('Reservation Reader');
    expect(script.split('\n')).toHaveLength(1);
  });

  it('leaves out directory permissions, which are not role assignments', () => {
    const t = tier({ graph_permissions: [perm()] });
    expect(assignScript(t, 'sub-1', 'me')).not.toContain('Directory.Read.All');
  });

  it('is empty when there is nothing assignable', () => {
    expect(assignScript(tier({ azure_roles: [] }), 's', 'a')).toBe('');
  });
});

describe('surfacing what needs a human', () => {
  it('lists the roles that must be granted some other way', () => {
    const t = tier({ azure_roles: [role(), role({ name: 'Reservation Reader', assignable: false })] });
    expect(manualEntries(t).map(e => e.name)).toEqual(['Reservation Reader']);
  });

  it('does not count directory permissions as manual roles', () => {
    expect(manualEntries(tier({ graph_permissions: [perm()] }))).toEqual([]);
  });

  it('finds the permissions that need an administrator', () => {
    const manifest = { tiers: [tier({ graph_permissions: [perm(), perm({ name: 'User.Read', admin_consent: false })] })] };
    expect(needsAdmin(manifest).map(e => e.name)).toEqual(['Directory.Read.All']);
  });

  it('finds none when nothing needs one', () => {
    expect(needsAdmin({ tiers: [tier()] })).toEqual([]);
  });
});

describe('the headline', () => {
  it('leads with the read versus change split', () => {
    const out = headline({ summary: { total: 12, read: 8, change: 4 } });
    expect(out).toContain('8 read-only');
    expect(out).toContain('4 that can change Azure');
  });

  it('says so plainly when nothing can write', () => {
    expect(headline({ summary: { total: 5, read: 5, change: 0 } }))
      .toBe('5 permissions, all read-only.');
  });

  it('admits when there is no list rather than showing a zero', () => {
    expect(headline(null)).toBe('Not available');
    expect(headline({ summary: { total: 0 } })).toBe('Not available');
  });
});
