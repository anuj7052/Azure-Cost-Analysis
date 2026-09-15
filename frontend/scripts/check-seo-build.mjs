import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { GUIDES, SITE, guidePath } from '../src/content/guides.js';
import { PRODUCTS, productPath } from '../src/content/products.js';

const read = (file) => readFile(new URL(`../dist/${file}`, import.meta.url), 'utf8');
const homepage = await read('index.html');
const privateShell = await read('app.html');
assert.equal((homepage.match(/<h1\b/g) || []).length, 1);
assert.match(homepage, /Understand your cloud bill/);
assert.match(homepage, /Does it change anything in my Azure account/);
assert.match(homepage, /<link rel="canonical" href="https:\/\/azure.microsoftupdates.co.in\/"/);
assert.match(homepage, /content="index, follow/);
assert.match(privateShell, /content="noindex, follow"/);
assert.match(privateShell, /<div id="root"><\/div>/);
assert.doesNotMatch(privateShell, /rel="canonical"|application\/ld\+json|<h1\b/);
for (const guide of GUIDES) {
  const path = guidePath(guide);
  const html = await read(`${path.slice(1)}index.html`);
  assert.equal((html.match(/<h1\b/g) || []).length, 1);
  assert.ok(html.includes(guide.title));
  assert.ok(html.includes(`href="${SITE}${path}"`));
  assert.ok(html.includes(guide.sections[0].body));
  assert.ok(homepage.includes(`href="${path}"`));
  assert.doesNotMatch(html, /content="noindex/);
  const graph = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(graph['@graph'][0]['@type'], 'Article');
  assert.equal(graph['@graph'][0].url, `${SITE}${path}`);
}
for (const product of PRODUCTS) {
  const path = productPath(product);
  const html = await read(`${path.slice(1)}index.html`);
  assert.equal((html.match(/<h1\b/g) || []).length, 1);
  assert.ok(html.includes(`href="${SITE}${path}"`));
  assert.ok(homepage.includes(`href="${path}"`));
  assert.doesNotMatch(html, /content="noindex/);
  for (const anchor of Object.keys(product.details)) assert.ok(html.includes(`id="${anchor}"`));
  const graph = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(graph['@graph'][0]['@type'], 'WebPage');
}
console.log(`SEO build checks passed: homepage, ${GUIDES.length} guides, ${PRODUCTS.length} product pages and private noindex shell.`);
