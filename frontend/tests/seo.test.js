import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FAQ } from '../src/content/faq';

const root = resolve(import.meta.dirname, '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');

const html = read('index.html');
const robots = read('public/robots.txt');
const sitemap = read('public/sitemap.xml');

/** The structured data blob, parsed the way a crawler would parse it. */
function jsonLd() {
  const match = html.match(
    /<script type="application\/ld\+json">([\s\S]*?)<\/script>/,
  );
  if (!match) throw new Error('index.html has no JSON-LD block');
  return JSON.parse(match[1]);
}

const nodeOfType = (type) =>
  jsonLd()['@graph'].find((n) => n['@type'] === type);

describe('structured data', () => {
  it('is valid JSON', () => {
    // A trailing comma costs the whole block. Google does not warn; the rich
    // result simply never appears, which is indistinguishable from not having
    // been chosen for one.
    expect(() => jsonLd()).not.toThrow();
  });

  it('asks the same questions the page answers', () => {
    const asked = nodeOfType('FAQPage').mainEntity.map((q) => q.name);
    expect(asked).toEqual(FAQ.map((f) => f.q));
  });

  it('gives the same answers the page gives', () => {
    const given = nodeOfType('FAQPage').mainEntity.map(
      (q) => q.acceptedAnswer.text,
    );
    expect(given).toEqual(FAQ.map((f) => f.a));
  });

  it('describes the application as free, because it is', () => {
    expect(nodeOfType('SoftwareApplication').offers.price).toBe('0');
  });
});

describe('canonical host', () => {
  it('is declared once', () => {
    const links = html.match(/<link rel="canonical"/g) || [];
    expect(links).toHaveLength(1);
  });

  it('is absolute', () => {
    // A relative canonical resolves against whichever host served the page,
    // which makes it agree with both of them and settle nothing.
    const href = html.match(/<link rel="canonical" href="([^"]+)"/)[1];
    expect(href).toMatch(/^https:\/\//);
  });

  it('is the host every other absolute reference names', () => {
    const canonical = new URL(
      html.match(/<link rel="canonical" href="([^"]+)"/)[1],
    ).origin;

    for (const [, url] of html.matchAll(/content="(https:\/\/[^"]+)"/g)) {
      expect(new URL(url).origin).toBe(canonical);
    }
    expect(sitemap).toContain(canonical);
    expect(robots).toContain(canonical);
  });
});

describe('robots', () => {
  it('points at the sitemap', () => {
    expect(robots).toMatch(/^Sitemap: https:\/\/\S+\/sitemap\.xml$/m);
  });

  it('keeps crawlers off the signed-in routes', () => {
    // Anonymous, all of these render the same sign-in screen. Indexed, they
    // are twenty near-identical pages, which reads as a padded site.
    for (const path of ['/explorer', '/boq', '/settings', '/admin', '/api/']) {
      expect(robots).toContain(`Disallow: ${path}`);
    }
  });

  it('does not disallow the one page worth indexing', () => {
    expect(robots).not.toMatch(/^Disallow: \/$/m);
  });
});

describe('sitemap', () => {
  it('starts with an XML declaration', () => {
    // Not decoration: served as text/xml without it, a strict parser is within
    // its rights to reject the document, and Search Console reports that as an
    // unfetchable sitemap rather than as a malformed one.
    expect(sitemap.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  });

  it('lists only pages a signed-out visitor can read', () => {
    const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(locs).toEqual(['https://azure.microsoftupdates.co.in/']);
  });

  it('gives every entry a last-modified date', () => {
    const urls = [...sitemap.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((m) => m[1]);
    expect(urls).not.toHaveLength(0);
    for (const url of urls) expect(url).toMatch(/<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/);
  });

  it('does not claim to have been modified in the future', () => {
    // A future date is the one thing a crawler can prove is untrue, and it
    // discredits the rest of the file rather than just that entry.
    const today = new Date().toISOString().slice(0, 10);
    for (const [, when] of sitemap.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)) {
      expect(when <= today).toBe(true);
    }
  });

  it('does not list a fragment as though it were a page', () => {
    expect(sitemap).not.toMatch(/<loc>[^<]*#/);
  });

  it('is not contradicted by robots.txt', () => {
    const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    const blocked = [...robots.matchAll(/^Disallow: (\S+)$/gm)].map((m) => m[1]);

    for (const loc of locs) {
      const path = new URL(loc).pathname;
      for (const rule of blocked) {
        expect(path.startsWith(rule) && rule !== '/').toBe(false);
      }
    }
  });
});
