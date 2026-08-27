import { describe, it, expect } from 'vitest';
import {
  GLOSSARY, STATUS, plainAccessKind, plainAdvisorCategory,
  plainRole, plainScope, plainSeverity,
} from '../src/utils/securityLanguage';

/**
 * The rule being enforced here: a plain sentence may say the same thing more
 * simply, but it may never say more than the Azure term did. Translation is
 * allowed; embellishment is a lie with friendly wording.
 */

describe('describing what a role permits', () => {
  it('translates a well-known role into what it lets someone do', () => {
    const owner = plainRole('Owner');
    expect(owner.plain).toBe('Full control');
    expect(owner.why).toContain('give other people access');
  });

  it('always keeps the exact Azure term for an administrator to search on', () => {
    expect(plainRole('Owner').technical).toBe('Owner');
    expect(plainRole('Storage Blob Data Contributor').technical).toBe('Storage Blob Data Contributor');
  });

  it('believes the role definition over the role name', () => {
    // A custom role called "Reader" that holds a write action is exactly the
    // case a name lookup gets wrong, and getting it wrong would tell someone
    // that an account which can delete their database can only look at it.
    const role = plainRole('Reader', { known: true, can_write: true, can_delete: true, can_grant_access: false });
    expect(role.plain).toBe('Can change and delete');
    expect(role.derived).toBe(true);
    expect(role.technical).toBe('Reader');
  });

  it('keeps the friendlier wording when the definition agrees with the name', () => {
    const role = plainRole('Owner', { known: true, can_write: true, can_delete: true, can_grant_access: true });
    expect(role.plain).toBe('Full control');
    expect(role.derived).toBe(false);
  });

  it('does not guess when the definition could not be read', () => {
    const role = plainRole('Some Custom Role', { known: false });
    expect(role.plain).toBe('Some Custom Role');
    expect(role.why).toContain('could not be read');
  });

  it('never calls a role dangerous, only says what it permits', () => {
    for (const name of ['Owner', 'Contributor', 'User Access Administrator']) {
      const role = plainRole(name);
      expect(role.plain).not.toMatch(/danger|risk|bad|insecure/i);
    }
  });
});

describe('describing how much a grant covers', () => {
  it('makes clear that a subscription is larger than a resource group', () => {
    expect(plainScope('subscription').plain).toContain('whole subscription');
    expect(plainScope('resource group').plain).toContain('group of resources');
    expect(plainScope('tenant root').plain).toContain('entire Azure account');
  });

  it('keeps the Azure term alongside', () => {
    expect(plainScope('subscription').technical).toBe('Subscription scope');
  });
});

describe('describing an access finding', () => {
  it('states an observation and asks for a human, never issues an instruction', () => {
    const unused = plainAccessKind('unused');
    expect(unused.title).toContain('never been used');
    // The Activity Log cannot tell a quarterly billing job apart from dead
    // access, so the wording must not pretend it can.
    expect(unused.caution).toContain('occasionally');
    expect(unused.action).toMatch(/check|confirm|review/i);
  });

  it('covers every finding kind the backend produces', () => {
    for (const kind of ['unused', 'stale', 'over-privileged', 'over-scoped', 'sprawl', 'redundant']) {
      expect(plainAccessKind(kind).title).not.toBe('Access finding');
    }
  });

  it('falls back honestly on a kind it does not recognise', () => {
    expect(plainAccessKind('something-new').why).toContain('without a category');
  });
});

describe('describing an Advisor category', () => {
  it('says what the category is for', () => {
    expect(plainAdvisorCategory('Cost').plain).toBe('Saving money');
    expect(plainAdvisorCategory('HighAvailability').plain).toBe('Staying online');
    expect(plainAdvisorCategory('OperationalExcellence').plain).toBe('Running things well');
  });

  it('passes an unknown category through rather than inventing one', () => {
    expect(plainAdvisorCategory('Quantum').plain).toBe('Quantum');
  });
});

describe('severity wording', () => {
  it('repeats Azure severity rather than re-ranking it', () => {
    expect(plainSeverity('critical').plain).toBe('Fix first');
    expect(plainSeverity('high').plain).toBe('Important');
    expect(plainSeverity('low').plain).toBe('Minor');
  });

  it('does not pretend an unrated finding is harmless', () => {
    const unrated = plainSeverity(undefined);
    expect(unrated.plain).toBe('Unrated');
    expect(unrated.label).toBe('Not checked');
  });
});

describe('statuses', () => {
  it('every status explains itself', () => {
    for (const status of Object.values(STATUS)) {
      expect(status.tooltip.length).toBeGreaterThan(20);
    }
  });

  it('makes clear that "not checked" is not "fine"', () => {
    expect(STATUS.NOT_CHECKED.tooltip).toContain('does not mean everything is fine');
    expect(STATUS.UNAVAILABLE.tooltip).toContain('not a clean result');
  });

  it('avoids the bare words "good" and "bad"', () => {
    for (const status of Object.values(STATUS)) {
      expect(status.label).not.toMatch(/^(good|bad)$/i);
    }
  });
});

describe('the glossary', () => {
  it('explains the jargon the pages still have to use', () => {
    const terms = GLOSSARY.map(g => g.term);
    for (const t of ['RBAC', 'Scope', 'Principal', 'Secure Score', 'Non-compliant']) {
      expect(terms).toContain(t);
    }
  });
});
