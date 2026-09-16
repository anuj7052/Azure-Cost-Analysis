import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { ChevronRight, Moon, Sun } from 'lucide-react';
import { GUIDES, guidePath } from '../content/guides';
import { useTheme } from '../store/useTheme';
import MarketingBrand from '../components/Common/MarketingBrand';

/** Guides grouped by topic, so a growing library stays navigable. */
const TOPICS = [...new Set(GUIDES.map((guide) => guide.topic))];

export default function Guides() {
  const { pathname } = useLocation();
  const guide = GUIDES.find((item) => guidePath(item) === `${pathname.replace(/\/$/, '')}/`);
  const isIndex = /^\/guides\/?$/.test(pathname);
  const title = guide?.title || (isIndex ? 'Azure cost management guides' : 'Guide not found');
  const theme = useTheme((s) => s.theme);
  const toggleTheme = useTheme((s) => s.toggleTheme);

  useEffect(() => { document.title = `${title} | Cloudledger`; }, [title]);

  // Same topic first: a reader who arrived on a storage guide wants storage.
  const related = guide
    ? [...GUIDES.filter((item) => item !== guide && item.topic === guide.topic),
      ...GUIDES.filter((item) => item !== guide && item.topic !== guide.topic)].slice(0, 3)
    : [];

  return (
    <div className="marketing min-h-screen bg-slate-950 text-white">
      <header style={{ borderBottom: '1px solid var(--hairline)' }}>
        <nav aria-label="Main navigation" className="mx-auto flex h-12 max-w-[1024px] items-center justify-between px-5">
          <MarketingBrand />
          <div className="flex items-center gap-6">
            <a href="/#product" className="text-[13px] text-slate-400 hover:text-white">Product</a>
            <a href="/guides/" className="text-[13px] text-slate-400 hover:text-white">Guides</a>
            <a href="/login" className="text-[13px] text-slate-400 hover:text-white">Sign in</a>
            <button
              onClick={toggleTheme}
              aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              className="flex h-8 w-8 items-center justify-center rounded-full text-slate-400 hover:text-white"
            >
              {theme === 'dark' ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
            </button>
          </div>
        </nav>
      </header>

      <main className="mx-auto max-w-[1024px] px-5 py-16 sm:py-24">
        <nav aria-label="Breadcrumb" className="text-[13px] text-slate-500">
          <a href="/" className="hover:text-slate-300">Home</a>
          <span className="px-1.5">/</span>
          <a href="/guides/" className="hover:text-slate-300">Guides</a>
          {guide && <><span className="px-1.5">/</span>{guide.topic}</>}
        </nav>

        <div className={guide ? 'mt-10 max-w-3xl' : 'mt-10 max-w-3xl'}>
          <p className="marketing-eyebrow">{guide ? guide.topic : 'Learning centre'}</p>
          <h1 className={`mt-4 ${guide ? 'marketing-headline' : 'marketing-display'}`}>{title}</h1>
          <p className="marketing-lead mt-6">
            {guide?.description || (isIndex
              ? `Practical, evidence-led guides to understanding your Azure bill and checking the assumptions behind your cloud budget. ${GUIDES.length} guides across ${TOPICS.length} topics.`
              : 'Choose one of the guides below to continue.')}
          </p>
        </div>

        {guide && (
          <article className="max-w-3xl">
            <p className="mt-6 text-[13px] text-slate-500">
              By Cloudledger · Updated <time dateTime="2026-09-15">September 15, 2026</time>
            </p>

            <nav aria-label="On this page" className="marketing-panel mt-12 p-8">
              <h2 className="text-[15px] font-semibold">On this page</h2>
              <ol className="mt-5 space-y-3">
                {guide.sections.map((section, index) => (
                  <li key={section.title}>
                    <a href={`#section-${index + 1}`} className="text-[15px] text-slate-400 hover:text-blue-400">
                      <span className="mr-3 text-blue-400">{String(index + 1).padStart(2, '0')}</span>
                      {section.title}
                    </a>
                  </li>
                ))}
              </ol>
            </nav>

            {guide.sections.map((section, index) => (
              <section key={section.title} id={`section-${index + 1}`} className="scroll-mt-8 py-10" style={{ borderTop: '1px solid var(--hairline)', marginTop: index === 0 ? '3rem' : 0 }}>
                <h2 className="text-2xl font-semibold tracking-tight">{section.title}</h2>
                <p className="mt-4 text-[17px] leading-8 text-slate-400">{section.body}</p>
                {section.steps && (
                  <ol className="mt-6 space-y-4">
                    {section.steps.map((step, i) => (
                      <li key={step} className="flex gap-4 text-[15px] leading-7 text-slate-400">
                        <span className="shrink-0 font-semibold text-blue-400">{String(i + 1).padStart(2, '0')}</span>
                        {step}
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            ))}

            <section className="py-10" style={{ borderTop: '1px solid var(--hairline)' }}>
              <h2 className="text-xl font-semibold tracking-tight">Microsoft documentation</h2>
              <ul className="mt-5 space-y-3">
                {guide.sources.map((source) => (
                  <li key={source.url}>
                    <a href={source.url} target="_blank" rel="noreferrer noopener" className="marketing-cta text-[15px]">
                      {source.label}
                      <ChevronRight className="marketing-chevron h-4 w-4" />
                    </a>
                  </li>
                ))}
              </ul>
            </section>

            <aside className="marketing-panel p-9">
              <h2 className="text-xl font-semibold tracking-tight">Explore your own Azure costs</h2>
              <p className="mt-3 text-[15px] leading-7 text-slate-400">
                Connect your Microsoft account to inspect your costs, resources and commitments.
              </p>
              <a href="/login" className="marketing-cta mt-5 text-[15px]">
                Open Cloudledger
                <ChevronRight className="marketing-chevron h-4 w-4" />
              </a>
            </aside>
          </article>
        )}

        {guide ? (
          <section className="mt-24" aria-label="Related guides">
            <h2 className="marketing-headline">Related guides.</h2>
            <div className="mt-10 grid gap-4 md:grid-cols-3">
              {related.map((item) => (
                <a key={item.slug} href={guidePath(item)} className="marketing-link flex h-full flex-col p-8">
                  <p className="text-[13px] text-blue-400">{item.topic}</p>
                  <h3 className="mt-4 text-lg font-semibold leading-snug tracking-tight">{item.title}</h3>
                  <p className="mt-3 flex-1 text-[15px] leading-7 text-slate-400">{item.description}</p>
                  <span className="marketing-cta mt-6 text-[15px]">
                    Read guide
                    <ChevronRight className="marketing-chevron h-4 w-4" />
                  </span>
                </a>
              ))}
            </div>
            <a href="/guides/" className="marketing-cta mt-10 text-[17px]">
              Browse all {GUIDES.length} guides
              <ChevronRight className="marketing-chevron h-4 w-4" />
            </a>
          </section>
        ) : (
          <div className="mt-20 space-y-20">
            {TOPICS.map((topic) => (
              <section key={topic} aria-label={topic}>
                <h2 className="text-2xl font-semibold tracking-tight">{topic}</h2>
                <div className="mt-8 grid gap-4 md:grid-cols-3">
                  {GUIDES.filter((item) => item.topic === topic).map((item) => (
                    <a key={item.slug} href={guidePath(item)} className="marketing-link flex h-full flex-col p-8">
                      <h3 className="text-lg font-semibold leading-snug tracking-tight">{item.title}</h3>
                      <p className="mt-3 flex-1 text-[15px] leading-7 text-slate-400">{item.description}</p>
                      <span className="marketing-cta mt-6 text-[15px]">
                        Read guide
                        <ChevronRight className="marketing-chevron h-4 w-4" />
                      </span>
                    </a>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </main>

      <footer className="px-5 py-12 text-[12px] text-slate-500" style={{ borderTop: '1px solid var(--hairline)' }}>
        <div className="mx-auto flex max-w-[1024px] flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p><a href="/" className="hover:text-slate-300">Cloudledger</a> · <a href="/#product" className="hover:text-slate-300">Product</a></p>
          <p>Not affiliated with Microsoft.</p>
        </div>
      </footer>
    </div>
  );
}
