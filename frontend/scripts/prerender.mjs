import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { GUIDES, SITE, guidePath } from '../src/content/guides.js';
import { PRODUCTS, productPath } from '../src/content/products.js';

const escape = (value) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

const root = fileURLToPath(new URL('../', import.meta.url));
const output = new URL('../dist/', import.meta.url);
const shell = await readFile(new URL('index.html', output), 'utf8');
if (!shell.includes('<div id="root"></div>')) {
  throw new Error('Expected an empty app root before prerendering');
}
const server = await createServer({ root, server: { middlewareMode: true }, appType: 'custom' });
try {
  const { renderLanding, renderGuide, renderProduct } = await server.ssrLoadModule('/src/landing-server.jsx');
  const markup = renderLanding();
  if (!markup.includes('<h1') || !markup.includes('id="faq"')) {
    throw new Error('Public landing content is missing from the rendered HTML');
  }
  // The private routes retain a separate shell; only the homepage gets public copy.
  await writeFile(new URL('app.html', output), shell
    .replace('content="index, follow, max-image-preview:large"', 'content="noindex, follow"')
    .replace(/    <link rel="canonical"[^>]+>\n/, '')
    .replace(/    <script type="application\/ld\+json">[\s\S]*?<\/script>\n/, ''));
  await writeFile(new URL('index.html', output), shell.replace('<div id="root"></div>', () => `<div id="root">${markup}</div>`));
  const pages = [{ path: '/guides/', title: 'Azure cost management guides', description: 'Practical guides to Azure cost analysis, reservation billing and Pricing Calculator reconciliation.' }, ...GUIDES.map(guide => ({ ...guide, path: guidePath(guide) })), ...PRODUCTS.map(product => ({ ...product, path: productPath(product), product: true }))];
  for (const page of pages) {
    const canonical = `${SITE}${page.path}`;
    const graph = {
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': page.product ? 'WebPage' : page.slug ? 'Article' : 'CollectionPage', '@id': canonical, url: canonical, headline: page.title, name: page.title, description: page.description, inLanguage: 'en', ...(page.slug && !page.product ? { dateModified: '2026-09-15', author: { '@type': 'Organization', name: 'Cloudledger', url: SITE } } : {}) },
        { '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE}/` }, ...(page.product ? [{ '@type': 'ListItem', position: 2, name: page.label, item: canonical }] : [{ '@type': 'ListItem', position: 2, name: 'Guides', item: `${SITE}/guides/` }, ...(page.slug ? [{ '@type': 'ListItem', position: 3, name: page.title, item: canonical }] : [])])] },
      ],
    };
    const html = shell
      .replace(/<title>[\s\S]*?<\/title>/, () => `<title>${escape(page.product ? `Azure ${page.label}` : page.title)} | Cloudledger</title>`)
      .replace(/(<meta\s+name="description"\s+content=")[^"]+/, () => `<meta name="description" content="${escape(page.description)}`)
      .replace(/(<link rel="canonical" href=")[^"]+/, () => `<link rel="canonical" href="${canonical}`)
      .replace(/(<meta (?:property|name)="(?:og|twitter):title" content=")[^"]+/g, (_, prefix) => `${prefix}${escape(page.title)} | Cloudledger`)
      .replace(/(<meta\s+(?:property|name)="(?:og|twitter):description"\s+content=")[^"]+/g, (_, prefix) => `${prefix}${escape(page.description)}`)
      .replace(/(<meta property="og:url" content=")[^"]+/, (_, prefix) => `${prefix}${canonical}`)
      .replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, () => `<script type="application/ld+json">${JSON.stringify(graph).replaceAll('<', '\\u003c')}</script>`)
      .replace('<div id="root"></div>', () => `<div id="root">${page.product ? renderProduct(page.path) : renderGuide(page.path)}</div>`);
    const directory = new URL(`.${page.path}`, output);
    await mkdir(directory, { recursive: true });
    await writeFile(new URL('index.html', directory), html);
  }
  console.log('Prerendered public homepage; private app shell marked noindex.');
} finally {
  await server.close();
}
