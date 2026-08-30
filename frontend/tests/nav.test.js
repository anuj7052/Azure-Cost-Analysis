/**
 * Navigation structure.
 *
 * The sidebar and the section landing pages are rendered from one definition,
 * so a mistake here is a mistake in two places at once — a page that vanishes
 * from a hub is genuinely unreachable for anyone who navigates by section.
 */
import { describe, expect, it } from 'vitest';

import { ADMIN_ITEM, SECTIONS, sectionForPath, sectionsFor } from '../src/nav';

const allItems = (sections) => sections.flatMap(s => s.items);

describe('structure', () => {
  it('gives every page a route, a label and an explanation', () => {
    for (const item of allItems(SECTIONS)) {
      expect(item.to.startsWith('/')).toBe(true);
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.blurb.length).toBeGreaterThan(0);
      expect(item.icon).toBeTruthy();
    }
  });

  it('never lists the same route twice', () => {
    // Two entries for one path means one of them can never appear active,
    // which reads as a dead link.
    const routes = allItems(SECTIONS).map(i => i.to);
    expect(new Set(routes).size).toBe(routes.length);
  });

  it('gives every section exactly one overview, and it is the section hub', () => {
    for (const section of SECTIONS) {
      const overviews = section.items.filter(i => i.overview);
      expect(overviews).toHaveLength(1);
      expect(overviews[0].to).toBe(section.hub);
    }
  });

  it('gives every section a tagline and an icon', () => {
    for (const section of SECTIONS) {
      expect(section.tagline.length).toBeGreaterThan(0);
      expect(section.icon).toBeTruthy();
    }
  });
});

describe('admin', () => {
  it('hides the Admin Center from ordinary users', () => {
    const routes = allItems(sectionsFor(false)).map(i => i.to);
    expect(routes).not.toContain('/admin');
  });

  it('shows it to administrators, under Account', () => {
    const account = sectionsFor(true).find(s => s.key === 'account');
    expect(account.items).toContainEqual(ADMIN_ITEM);
  });

  it('leaves the shared definition untouched when adding it', () => {
    // sectionsFor runs on every render. Mutating SECTIONS would append the
    // Admin Center again and again until the sidebar filled with copies.
    sectionsFor(true);
    sectionsFor(true);
    expect(allItems(SECTIONS).filter(i => i.to === '/admin')).toHaveLength(0);
  });
});

describe('sectionForPath', () => {
  it('puts the dashboard in Cost', () => {
    expect(sectionForPath('/').key).toBe('cost');
  });

  it('does not sweep every page into Cost because "/" is a prefix', () => {
    // The bug this guards against: a naive startsWith test matches "/" against
    // every path, so the Cost section would open on every page in the app.
    expect(sectionForPath('/defender').key).toBe('security');
    expect(sectionForPath('/orphaned').key).toBe('estate');
    expect(sectionForPath('/settings').key).toBe('account');
  });

  it('resolves each security page to Access & Security', () => {
    for (const path of ['/access-identity', '/advisor', '/defender', '/policy']) {
      expect(sectionForPath(path).key).toBe('security');
    }
  });

  it('keeps a nested route inside its parent section', () => {
    expect(sectionForPath('/explorer/storage').key).toBe('cost');
  });

  it('prefers the longest matching route', () => {
    // "/security" and "/security-overview" style clashes must not resolve to
    // whichever happened to be declared first.
    expect(sectionForPath('/security').key).toBe('security');
  });

  it('returns nothing for a path the app does not serve', () => {
    expect(sectionForPath('/nowhere')).toBeNull();
  });

  it('finds the admin page only when the user is an administrator', () => {
    expect(sectionForPath('/admin', false)).toBeNull();
    expect(sectionForPath('/admin', true).key).toBe('account');
  });
});
