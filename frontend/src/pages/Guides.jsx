import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { GUIDES, SITE, guidePath } from '../content/guides';

export default function Guides() {
  const { pathname } = useLocation();
  const guide = GUIDES.find((item) => guidePath(item) === `${pathname.replace(/\/$/, '')}/`);
  const isIndex = /^\/guides\/?$/.test(pathname);
  const title = guide?.title || (isIndex ? 'Azure cost management guides' : 'Guide not found');
  useEffect(() => { document.title = `${title} | Cloudledger`; }, [title]);

  return <div className="min-h-screen bg-slate-950 text-white">
    <header className="border-b border-slate-800">
      <nav aria-label="Main navigation" className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-4 px-6 py-5">
        <a className="font-bold" href="/">CLOUDLEDGER</a>
        <div className="flex gap-5 text-sm"><a href="/guides/">Guides</a><a href="/login">Sign in</a></div>
      </nav>
    </header>
    <main className="mx-auto max-w-5xl px-6 py-12 sm:py-20">
      <nav aria-label="Breadcrumb" className="mb-8 text-sm text-slate-400"><a href="/">Home</a> / <a href="/guides/">Guides</a>{guide && ' / Article'}</nav>
      <p className="text-xs font-semibold uppercase tracking-widest text-blue-400">Cloudledger learning center</p>
      <h1 className="mt-4 max-w-4xl text-3xl font-semibold leading-tight sm:text-5xl">{title}</h1>
      <p className="mt-6 max-w-3xl text-lg leading-8 text-slate-300">{guide?.description || (isIndex ? 'Practical, evidence-led guides to understanding your Azure bill and checking the assumptions behind your cloud budget.' : 'Choose one of the guides below to continue.')}</p>
      {guide && <article className="max-w-3xl">
        <p className="mt-5 text-sm text-slate-400">By Cloudledger · Updated <time dateTime="2026-09-15">September 15, 2026</time></p>
        <nav aria-label="On this page" className="my-10 rounded-2xl border border-slate-800 bg-slate-900 p-6">
          <h2 className="font-semibold">On this page</h2>
          <ol className="mt-4 space-y-3 text-sm text-blue-400">{guide.sections.map((section, index) => <li key={section.title}><a href={`#section-${index + 1}`}>{index + 1}. {section.title}</a></li>)}</ol>
        </nav>
        {guide.sections.map((section, index) => <section key={section.title} id={`section-${index + 1}`} className="my-10 scroll-mt-6">
          <h2 className="text-2xl font-semibold">{section.title}</h2>
          <p className="mt-4 text-base leading-8 text-slate-300">{section.body}</p>
          {section.steps && <ol className="mt-4 list-decimal space-y-3 pl-6 leading-7 text-slate-300">{section.steps.map(step => <li key={step}>{step}</li>)}</ol>}
        </section>)}
        <section className="my-10 border-t border-slate-800 pt-8"><h2 className="text-xl font-semibold">Microsoft documentation</h2><ul className="mt-4 space-y-3 text-blue-400">{guide.sources.map(source => <li key={source.url}><a href={source.url} className="underline underline-offset-4">{source.label}</a></li>)}</ul></section>
        <aside className="rounded-2xl border border-blue-500/30 bg-blue-500/10 p-6"><h2 className="text-xl font-semibold">Explore your own Azure costs</h2><p className="mt-3 leading-7 text-slate-300">Connect your Microsoft account to inspect your costs, resources and commitments in Cloudledger.</p><a href="/login" className="mt-4 inline-block font-semibold text-blue-400">Open Cloudledger →</a></aside>
      </article>}
      <section className="mt-16" aria-label={guide ? 'Related guides' : 'All guides'}>
        {guide && <h2 className="mb-6 text-2xl font-semibold">Related guides</h2>}
        <div className="grid gap-5 md:grid-cols-3">{GUIDES.filter(item => item !== guide).map(item => <a key={item.slug} href={guidePath(item)} className="rounded-2xl border border-slate-800 bg-slate-900 p-6 hover:border-blue-500">
          <h2 className="text-lg font-semibold">{item.title}</h2><p className="mt-3 text-sm leading-7 text-slate-400">{item.description}</p><span className="mt-5 block text-sm text-blue-400">Read guide →</span>
        </a>)}</div>
      </section>
    </main>
    <footer className="border-t border-slate-800 px-6 py-8 text-center text-sm text-slate-400"><a href={SITE}>Cloudledger</a> · Not affiliated with Microsoft.</footer>
  </div>;
}
