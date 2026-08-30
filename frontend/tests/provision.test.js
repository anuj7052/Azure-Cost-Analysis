/**
 * The Build page's rules, tested without a DOM.
 *
 * There is no jsdom in this project, so these cover the decisions rather than
 * the rendering: what stops a deploy, when an SSH key becomes mandatory, and
 * how a blank field differs from an absent one. Those are the parts that, if
 * wrong, create the wrong thing in somebody's Azure subscription — the markup
 * is not.
 */
import { describe, it, expect } from 'vitest';

/**
 * Mirrors the `blockers` memo in pages/Provision.jsx.
 *
 * Kept as a plain function so the rule can be exercised directly. If the page
 * and this drift apart the tests stop meaning anything, so the page keeps the
 * same order and wording.
 */
function blockers({ tenantId, subscriptionId, resourceGroup, location, plan, sshKey }) {
  const list = [];
  if (!tenantId) list.push('Choose a tenant.');
  if (!subscriptionId) list.push('Choose a subscription.');
  if (!resourceGroup.trim()) list.push('Name the resource group.');
  if (!location.trim()) list.push('Choose a region.');
  if (!plan.length) list.push('Add at least one resource.');
  if (plan.some(r => r.kind === 'linux_vm') && !sshKey.trim()) {
    list.push('A Linux VM needs an SSH public key — it is the only way in once it is built.');
  }
  return list;
}

/** Mirrors the field-stripping in KindForm.add. */
function fieldsFor(values) {
  const fields = {};
  for (const [key, value] of Object.entries(values)) {
    if (String(value ?? '').trim() !== '') fields[key] = value;
  }
  return fields;
}

const complete = {
  tenantId: 'tenant-1',
  subscriptionId: 'sub-1',
  resourceGroup: 'rg-app',
  location: 'centralindia',
  plan: [{ kind: 'storage_account', fields: { name: 'stapp' } }],
  sshKey: '',
};

describe('what stops a deployment', () => {
  it('allows a complete plan', () => {
    expect(blockers(complete)).toEqual([]);
  });

  it('refuses an empty plan even when everything else is filled in', () => {
    expect(blockers({ ...complete, plan: [] }))
      .toContain('Add at least one resource.');
  });

  it.each([
    ['tenantId', 'Choose a tenant.'],
    ['subscriptionId', 'Choose a subscription.'],
  ])('refuses a missing %s', (field, message) => {
    expect(blockers({ ...complete, [field]: '' })).toContain(message);
  });

  it('treats a whitespace-only resource group as missing', () => {
    // Azure would accept the request and create something named oddly, or
    // reject it several seconds later. Neither is a good answer.
    expect(blockers({ ...complete, resourceGroup: '   ' }))
      .toContain('Name the resource group.');
  });

  it('reports every problem at once rather than one at a time', () => {
    const list = blockers({
      tenantId: '', subscriptionId: '', resourceGroup: '', location: '',
      plan: [], sshKey: '',
    });
    expect(list).toHaveLength(5);
  });
});

describe('the SSH key rule', () => {
  it('is not asked for when no VM is being built', () => {
    expect(blockers(complete)).toEqual([]);
  });

  it('is required as soon as a Linux VM is added', () => {
    const withVm = { ...complete, plan: [{ kind: 'linux_vm', fields: { name: 'vm1' } }] };
    expect(blockers(withVm).join(' ')).toContain('SSH public key');
  });

  it('is satisfied by a key', () => {
    const withVm = {
      ...complete,
      plan: [{ kind: 'linux_vm', fields: { name: 'vm1' } }],
      sshKey: 'ssh-ed25519 AAAAC3Nz',
    };
    expect(blockers(withVm)).toEqual([]);
  });

  it('is not satisfied by whitespace', () => {
    const withVm = {
      ...complete,
      plan: [{ kind: 'linux_vm', fields: { name: 'vm1' } }],
      sshKey: '   ',
    };
    expect(blockers(withVm).join(' ')).toContain('SSH public key');
  });
});

describe('what gets sent for a resource', () => {
  it('drops blank fields so the server applies its own suggestion', () => {
    // An empty string is a deliberate empty value to the backend, which is a
    // different request from "you choose". Sending one for the other would
    // silently override the catalogue's default.
    expect(fieldsFor({ name: 'vm1', size: '', image: 'Ubuntu2204' }))
      .toEqual({ name: 'vm1', image: 'Ubuntu2204' });
  });

  it('keeps values that are only meaningful as text', () => {
    expect(fieldsFor({ name: 'vnet1', address_space: '10.0.0.0/16' }))
      .toEqual({ name: 'vnet1', address_space: '10.0.0.0/16' });
  });

  it('drops whitespace-only values', () => {
    expect(fieldsFor({ name: 'a', allow_ssh_from: '   ' })).toEqual({ name: 'a' });
  });

  it('keeps a zero, which is a real value', () => {
    expect(fieldsFor({ name: 'a', os_disk_gib: 0 })).toEqual({ name: 'a', os_disk_gib: 0 });
  });
});
