import { describe, it, expect } from 'vitest';
import {
  isGuid, shortId, principalLabel, isUnresolved,
  subscriptionLabel, scopeLabel, subscriptionNameMap,
} from '../src/utils/identity.js';

/*
 * The property under test throughout: a bare GUID must never reach the screen
 * as if it were a label. Either we found a name, or we say we did not and
 * abbreviate the id — but we never present `7f801a91-3d36-...` as an answer.
 */

const SUB = '7f801a91-3d36-4d34-9b38-619fc8588362';

describe('isGuid', () => {
  it('accepts a canonical GUID', () => {
    expect(isGuid(SUB)).toBe(true);
    expect(isGuid(SUB.toUpperCase())).toBe(true);
  });

  it('rejects names, emails and empties', () => {
    expect(isGuid('alice@contoso.com')).toBe(false);
    expect(isGuid('rg-production')).toBe(false);
    expect(isGuid('')).toBe(false);
    expect(isGuid(null)).toBe(false);
  });
});

describe('shortId', () => {
  it('keeps both ends so same-prefix GUIDs stay distinguishable', () => {
    expect(shortId(SUB)).toBe('7f801a91…8362');
  });

  it('leaves real names untouched', () => {
    expect(shortId('Production')).toBe('Production');
  });
});

describe('principalLabel', () => {
  it('uses the display name when Azure gave us one', () => {
    expect(principalLabel({ principal_name: 'Alice Smith', principal_type: 'User' }))
      .toBe('Alice Smith');
  });

  it('never returns a bare GUID', () => {
    const label = principalLabel({
      principal_name: SUB, principal_id: SUB, principal_type: 'Service principal',
    });
    expect(label).not.toBe(SUB);
    expect(label).toBe('Name unavailable');
    // The id is deliberately absent. Appending it produced labels such as
    // "Unnamed service principal · 7f801a91…", which reads as though the GUID
    // were part of a name rather than the trace of a failed lookup.
    expect(label).not.toContain('7f801a91');
  });

  it('prefers an email address over an unknown-account placeholder', () => {
    expect(principalLabel({ principal_upn: 'anuj@company.com', principal_type: 'User' }))
      .toBe('anuj@company.com');
  });

  it('names the kind of thing it could not resolve', () => {
    expect(principalLabel({ principal_type: 'User' })).toBe('Name unavailable');
    expect(principalLabel({ principal_type: 'Group' })).toBe('Name unavailable');
    expect(principalLabel({ principal_type: 'Managed identity' }))
      .toBe('Name unavailable');
    expect(principalLabel({})).toBe('Name unavailable');
  });
});

describe('isUnresolved', () => {
  it('is false when the backend resolved a name', () => {
    expect(isUnresolved({ resolved: true, principal_name: 'Alice' })).toBe(false);
  });

  it('is true when the name is really the object id', () => {
    expect(isUnresolved({ principal_name: SUB })).toBe(true);
  });
});

describe('subscriptionLabel', () => {
  const names = { [SUB]: 'Contoso Production' };

  it('prefers the display name', () => {
    expect(subscriptionLabel(SUB, names)).toBe('Contoso Production');
  });

  it('matches case-insensitively, because ARM varies the casing', () => {
    expect(subscriptionLabel(SUB.toUpperCase(), names)).toBe('Contoso Production');
  });

  it('abbreviates and labels an unknown id rather than printing it raw', () => {
    expect(subscriptionLabel(SUB, {})).toBe('Subscription 7f801a91…8362');
  });
});

describe('scopeLabel', () => {
  const names = { [SUB]: 'Contoso Production' };

  it('describes the tenant root in words', () => {
    expect(scopeLabel('/', names).kind).toBe('tenant root');
  });

  it('names a management group', () => {
    const out = scopeLabel('/providers/Microsoft.Management/managementGroups/root', names);
    expect(out.kind).toBe('management group');
    expect(out.text).toContain('root');
  });

  it('replaces the subscription GUID with its name', () => {
    const out = scopeLabel(`/subscriptions/${SUB}`, names);
    expect(out.text).toBe('Contoso Production');
    expect(out.text).not.toContain(SUB);
  });

  it('builds a breadcrumb down to the resource group', () => {
    const out = scopeLabel(`/subscriptions/${SUB}/resourceGroups/rg-web`, names);
    expect(out.parts).toEqual(['Contoso Production', 'rg-web']);
    expect(out.kind).toBe('resource group');
  });

  it('ends a resource path on the resource name', () => {
    const out = scopeLabel(
      `/subscriptions/${SUB}/resourceGroups/rg-web/providers/Microsoft.Compute/virtualMachines/vm-01`,
      names,
    );
    expect(out.parts).toEqual(['Contoso Production', 'rg-web', 'vm-01']);
    expect(out.kind).toBe('resource');
  });

  it('still avoids a bare GUID when the subscription is unknown', () => {
    const out = scopeLabel(`/subscriptions/${SUB}/resourceGroups/rg-web`, {});
    expect(out.text).toBe('Subscription 7f801a91…8362 / rg-web');
  });
});

describe('subscriptionNameMap', () => {
  it('lower-cases keys and skips entries with no name', () => {
    const map = subscriptionNameMap([
      { subscription_id: SUB.toUpperCase(), display_name: 'Contoso Production' },
      { subscription_id: 'abc', display_name: '' },
    ]);
    expect(map[SUB]).toBe('Contoso Production');
    expect(map.abc).toBeUndefined();
  });
});
