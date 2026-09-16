import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { GUIDES, SITE, guidePath } from '../src/content/guides.js';
import { PRODUCTS, productPath } from '../src/content/products.js';

const read = (file) => readFile(new URL(`../dist/${file}`, import.meta.url), 'utf8');

const homepage = await read('index.html');
const guidesIndex = await read('guides/index.html');
const privateShell = await read('app.html');

// ── the public homepage ──────────────────────────────────────────────────
assert.equal((homepage.match(/<h1\b/g) || []).length, 1);
assert.match(homepage, /Understand your cloud bill/);
assert.match(homepage, /Does it change anything in my Azure account/);
assert.match(homepage, /<link rel="canonical" href="https:\/\/azure.microsoftupdates.co.in\/"/);
assert.match(homepage, /content="index, follow/);

// ── the private shell must never be indexable ────────────────────────────
assert.match(privateShell, /content="noindex, follow"/);
assert.match(privateShell, /<div id="root"><\/div>/);
assert.doesNotMatch(privateShell, /rel="canonical"|application\/ld\+json|<h1\b/);

// ── every guide is reachable, and the hub is reachable from the homepage ──
// The homepage links the hub rather than all 23 guides: a front page that
// lists an entire library is how a marketing page turns into a sitemap. The
// hub is what must be exhaustive, so that is where the assertion belongs.
assert.ok(homepage.includes('href="/guides/"'), 'homepage must link the guides hub');

for (const guide of GUIDES) {
  const path = guidePath(guide);
  const html = await read(`${path.slice(1)}index.html`);

  assert.equal((html.match(/<h1\b/g) || []).length, 1, `${path} needs exactly one h1`);
  assert.ok(html.includes(guide.title), `${path} missing its title`);
  assert.ok(html.includes(`href="${SITE}${path}"`), `${path} missing canonical`);
  assert.ok(html.includes(guide.sections[0].body), `${path} missing prerendered body`);
  assert.doesNotMatch(html, /content="noindex/, `${path} must be indexable`);
  assert.ok(guidesIndex.includes(`href="${path}"`), `${path} missing from the guides hub`);

  const graph = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(graph['@graph'][0]['@type'], 'Article');
  assert.equal(graph['@graph'][0].url, `${SITE}${path}`);
}

// ── product pages are linked from the homepage and fully rendered ────────
for (const product of PRODUCTS) {
  const path = productPath(product);
  const html = await read(`${path.slice(1)}index.html`);

  assert.equal((html.match(/<h1\b/g) || []).length, 1, `${path} needs exactly one h1`);
  assert.ok(html.includes(`href="${SITE}${path}"`), `${path} missing canonical`);
  assert.ok(homepage.includes(`href="${path}"`), `${path} missing from the homepage`);
  assert.doesNotMatch(html, /content="noindex/, `${path} must be indexable`);

  for (const anchor of Object.keys(product.details)) {
    assert.ok(html.includes(`id="${anchor}"`), `${path} missing section #${anchor}`);
  }

  const graph = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(graph['@graph'][0]['@type'], 'WebPage');
}

console.log(`SEO build checks passed: homepage, ${GUIDES.length} guides, ${PRODUCTS.length} product pages and private noindex shell.`);
