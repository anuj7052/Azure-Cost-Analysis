import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronRight, Menu, Moon, Sun, X } from 'lucide-react';
import { SECTIONS } from '../nav';
import { GUIDES, guidePath } from '../content/guides';
import { PRODUCTS, productPath } from '../content/products';
import { FAQ as PUBLIC_FAQ } from '../content/faq';
import { useTheme } from '../store/useTheme';

/**
 * The public front door.
 *
 * Written from what the product actually does. The product areas and their
 * workflows are generated from SECTIONS — the same list the signed-in sidebar
 * is built from — so a page that is added, renamed or removed cannot quietly
 * leave a promise behind here.
 *
 * The hero visual carries no figures. A mock full of invented spend would be
 * the first thing a visitor sees and the first thing that is untrue, and this
 * product's whole claim is that it does not make numbers up. Shape and layout
 * convey "this is a cost tool" without printing a currency symbol.
 */

const NAV_LINKS = [
  { href: '#product', id: 'product', label: 'Product' },
  { href: '#how', id: 'how', label: 'How it works' },
  { href: '#assistants', id: 'assistants', label: 'Assistants' },
  { href: '#security', id: 'security', label: 'Security' },
  { href: '#faq', id: 'faq', label: 'FAQ' },
];

/** The Microsoft services the app reads. Matches the API Catalog page. */
const SOURCES = [
  'Cost Management', 'Resource Graph', 'Activity Log',
  'Microsoft Entra', 'Azure Advisor', 'Microsoft Defender',
];

const STEPS = [
  {
    title: 'Sign in with Microsoft',
    body: 'No new password and no account to create. You sign in with the work account you already use for Azure, through Microsoft Entra.',
  },
  {
    title: 'Connect a tenant',
    body: 'Point the app at the tenant you want to read. It uses your own delegated permissions, so it can never see more of Azure than you can.',
  },
  {
    title: 'Start a review',
    body: 'Cost, running resources, changes and access — read from Azure when you ask, rather than from a copy that drifts.',
  },
];

const SECURITY = [
  {
    title: 'Your permissions, not ours',
    body: 'Every call to Azure is made with your own delegated token. If Azure would refuse you, it refuses the app. No service principal quietly holds more access than the person using it.',
  },
  {
    title: 'Explicit deployment controls',
    body: 'Reporting reads. Creating resources through Build requires workspace-admin authorization, explicit confirmation and sufficient Azure permissions.',
  },
  {
    title: 'Uploads are not kept',
    body: 'A BOQ spreadsheet travels with the request that parses it and is never written to disk. Text inside a cell is treated as data, never as an instruction.',
  },
  {
    title: 'Bring your own model',
    body: 'Point the assistants at your own OpenAI or Azure OpenAI endpoint. They run on your key, your quota and your data agreement, and stop at the daily limit you set.',
  },
];

const FAQ = PUBLIC_FAQ;

/** Guides shown on the homepage. The rest live on the hub. */
const FEATURED_GUIDES = GUIDES.slice(0, 3);

function prefersLessMotion() {
  return typeof window !== 'undefined'
    && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}

/** Reveals children once they scroll into view, unless motion is unwanted. */
function Reveal({ children, delay = 0, className = '' }) {
  const ref = useRef(null);
  const [shown, setShown] = useState(
    () => prefersLessMotion() || typeof IntersectionObserver === 'undefined',
  );

  useEffect(() => {
    const node = ref.current;
    if (!node || shown) return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setShown(true);
        observer.disconnect();
      }
    }, { rootMargin: '0px 0px -12% 0px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [shown]);

  return (
    <div
      ref={ref}
      className={className}
      style={{
        opacity: shown ? 1 : 0,
        transform: shown ? 'none' : 'translateY(14px)',
        transition: `opacity .7s cubic-bezier(.22,1,.36,1) ${delay}ms, transform .7s cubic-bezier(.22,1,.36,1) ${delay}ms`,
      }}
    >
      {children}
    </div>
  );
}

/**
 * An abstract stand-in for the dashboard. Deliberately unlabelled with figures
 * — see the note at the top of the file.
 */
function ProductMock() {
  const bars = [34, 58, 41, 72, 50, 84, 64, 92, 59, 78, 53, 88, 70, 81];

  return (
    <div className="marketing-panel overflow-hidden text-left shadow-2xl">
      <div className="flex items-center gap-2 px-5 py-3.5" style={{ borderBottom: '1px solid var(--hairline)' }}>
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: 'var(--hairline)' }} />
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: 'var(--hairline)' }} />
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: 'var(--hairline)' }} />
        <span className="ml-2 text-[11px] text-slate-500">Cloudledger — Dashboard</span>
      </div>

      <div className="grid grid-cols-[3rem_1fr] sm:grid-cols-[10rem_1fr]">
        <aside className="p-3" style={{ borderRight: '1px solid var(--hairline)' }}>
          {SECTIONS.map((section, i) => (
            <div
              key={section.key}
              className={`mb-1 flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[12px] ${
                i === 0 ? 'bg-blue-600 text-white' : 'text-slate-500'
              }`}
            >
              <section.icon className="h-4 w-4 shrink-0" />
              <span className="hidden truncate sm:inline">{section.title}</span>
            </div>
          ))}
        </aside>

        <div className="space-y-3 p-4 sm:p-6">
          <div className="grid grid-cols-3 gap-3">
            {['Actual cost', 'Latest month', 'Daily burn'].map((label) => (
              <div key={label}>
                <p className="truncate text-[11px] text-slate-500">{label}</p>
                <div className="mt-2 h-5 w-full rounded" style={{ background: 'var(--hairline)' }} />
              </div>
            ))}
          </div>

          <div className="flex h-28 items-end gap-[3px] sm:h-40">
            {bars.map((height, i) => (
              <div
                key={i}
                className="flex-1 rounded-t-[2px]"
                style={{
                  height: `${height}%`,
                  // One hue, varied only by weight. A full-saturation bar chart
                  // in a hero is decoration; this reads as data at a glance and
                  // stops competing with the headline above it.
                  background: 'var(--color-blue-400)',
                  opacity: 0.3 + (height / 100) * 0.45,
                }}
              />
            ))}
          </div>

          <p className="text-[11px] leading-relaxed text-slate-500">
            Cost change explained: reservation purchase, new resources and rate changes — each named from billing data.
          </p>
        </div>
      </div>
    </div>
  );
}

/** Product areas as a segmented control. */
function ProductAreas() {
  const [active, setActive] = useState(SECTIONS[0].key);
  const section = SECTIONS.find((s) => s.key === active) ?? SECTIONS[0];
  const product = PRODUCTS.find((p) => p.key === section.key);
  const items = section.items.filter((item) => !item.overview);

  const onKeyDown = (event, key) => {
    const index = SECTIONS.findIndex((item) => item.key === key);
    const next = event.key === 'ArrowRight' ? (index + 1) % SECTIONS.length
      : event.key === 'ArrowLeft' ? (index + SECTIONS.length - 1) % SECTIONS.length
        : event.key === 'Home' ? 0
          : event.key === 'End' ? SECTIONS.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    setActive(SECTIONS[next].key);
    document.getElementById(`tab-${SECTIONS[next].key}`)?.focus();
  };

  return (
    <div className="mt-14">
      <div className="flex justify-center">
        <div role="tablist" aria-label="Product areas" className="marketing-segment flex max-w-full gap-1 overflow-x-auto p-1 [scrollbar-width:none]">
          {SECTIONS.map((s) => {
            const selected = s.key === section.key;
            return (
              <button
                key={s.key}
                role="tab"
                id={`tab-${s.key}`}
                aria-selected={selected}
                aria-controls={`panel-${s.key}`}
                tabIndex={selected ? 0 : -1}
                onKeyDown={(event) => onKeyDown(event, s.key)}
                onClick={() => setActive(s.key)}
                className={`marketing-segment-item shrink-0 px-4 py-2 text-[15px] font-medium ${
                  selected ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {s.title}
              </button>
            );
          })}
        </div>
      </div>

      <div
        key={section.key}
        role="tabpanel"
        id={`panel-${section.key}`}
        aria-labelledby={`tab-${section.key}`}
        className="animate-fade-up mt-12"
      >
        <div className="mx-auto max-w-2xl text-center">
          {/* Deliberately smaller than a section headline: this is a panel
              label that changes as you switch tabs, and one word set at
              display size would out-shout the heading it sits under. */}
          <h3 className="text-2xl font-semibold tracking-tight sm:text-3xl">{section.title}</h3>
          <p className="mt-3 text-[17px] leading-7 text-slate-400">{section.tagline}</p>
          <a href={productPath(product)} className="marketing-cta mt-5 text-[17px]">
            Explore {section.title}
            <ChevronRight className="marketing-chevron h-4 w-4" />
          </a>
        </div>

        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((item) => (
            <a key={item.to} href={`${productPath(product)}#${item.to.slice(1)}`} className="marketing-link p-7">
              <item.icon className="h-6 w-6 text-blue-400" />
              <p className="mt-6 text-lg font-semibold">{item.label}</p>
              <p className="mt-2 text-[15px] leading-7 text-slate-400">{item.blurb}</p>
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function Landing() {
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [activeId, setActiveId] = useState('');
  const heroRef = useRef(null);
  const theme = useTheme((s) => s.theme);
  const toggleTheme = useTheme((s) => s.toggleTheme);

  useEffect(() => {
    // One scroll listener: the header hairline, and a small parallax settle on
    // the hero visual. Ambient animation that runs forever was removed, so
    // this is the only continuous motion on the page and it stops at 620px.
    const hero = heroRef.current;
    const reduced = prefersLessMotion();
    let frame = 0;

    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const y = window.scrollY;
        setScrolled(y > 8);
        if (hero && !reduced) {
          const progress = Math.min(1, y / 620);
          hero.style.transform = `translateY(${progress * -22}px) scale(${1 - progress * 0.035})`;
        }
      });
    };

    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return undefined;
    const nodes = NAV_LINKS.map((l) => document.getElementById(l.id)).filter(Boolean);
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((e) => e.isIntersecting);
      if (visible.length) setActiveId(visible[0].target.id);
    }, { rootMargin: '-45% 0px -50% 0px' });
    nodes.forEach((n) => observer.observe(n));
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const close = () => setMenuOpen(false);
    window.addEventListener('resize', close);
    return () => window.removeEventListener('resize', close);
  }, [menuOpen]);

  const signIn = () => navigate('/login');

  return (
    <div className="marketing aca-motion min-h-screen scroll-smooth bg-slate-950 text-white">
      <style>{`@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }`}</style>

      <a href="#top" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-lg focus:bg-blue-600 focus:px-3 focus:py-2 focus:text-sm focus:text-white">
        Skip to content
      </a>

      {/* ── header ─────────────────────────────────────────────────── */}
      <header
        className="fixed inset-x-0 top-0 z-50 transition-colors duration-300"
        style={scrolled
          ? {
            // Apple's nav recipe without the saturation boost. At 180% a
            // saturated element passing underneath — the chart in the hero —
            // smears colour across the whole bar, which reads as a rendering
            // bug rather than as depth.
            background: 'color-mix(in srgb, var(--surface-base) 94%, transparent)',
            backdropFilter: 'blur(22px)',
            WebkitBackdropFilter: 'blur(22px)',
            borderBottom: '1px solid var(--hairline)',
          }
          : undefined}
      >
        <div className="mx-auto flex h-12 max-w-[1024px] items-center justify-between px-5">
          <a href="#top" className="text-[15px] font-semibold tracking-tight">Cloudledger</a>

          <nav className="hidden items-center gap-8 lg:flex">
            {NAV_LINKS.map((l) => (
              <a
                key={l.href}
                href={l.href}
                aria-current={activeId === l.id ? 'true' : undefined}
                className={`text-[13px] transition-colors ${activeId === l.id ? 'text-white' : 'text-slate-400 hover:text-white'}`}
              >
                {l.label}
              </a>
            ))}
            <a href="/guides/" className="text-[13px] text-slate-400 transition-colors hover:text-white">Guides</a>
          </nav>

          <div className="flex items-center gap-1">
            <button
              onClick={toggleTheme}
              aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              className="flex h-8 w-8 items-center justify-center rounded-full text-slate-400 transition-colors hover:text-white"
            >
              {theme === 'dark' ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
            </button>
            <button onClick={signIn} className="hidden rounded-full bg-blue-600 px-4 py-1.5 text-[13px] font-medium text-white transition hover:bg-blue-500 sm:block">
              Sign in
            </button>
            <button
              onClick={() => setMenuOpen((v) => !v)}
              aria-label={menuOpen ? 'Close menu' : 'Open menu'}
              aria-expanded={menuOpen}
              className="flex h-8 w-8 items-center justify-center rounded-full text-slate-300 lg:hidden"
            >
              {menuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
          </div>
        </div>

        {menuOpen && (
          <div className="animate-fade-up px-5 pb-5 lg:hidden" style={{ background: 'var(--surface-base)', borderTop: '1px solid var(--hairline)' }}>
            {[...NAV_LINKS, { href: '/guides/', label: 'Guides' }].map((l) => (
              <a key={l.href} href={l.href} onClick={() => setMenuOpen(false)} className="block py-3 text-[17px] text-slate-300" style={{ borderBottom: '1px solid var(--hairline)' }}>
                {l.label}
              </a>
            ))}
            <button onClick={signIn} className="mt-5 w-full rounded-full bg-blue-600 py-2.5 text-[15px] font-medium text-white">
              Sign in with Microsoft
            </button>
          </div>
        )}
      </header>

      {/* ── hero ───────────────────────────────────────────────────── */}
      <section id="top" className="px-5 pb-20 pt-28 text-center sm:pt-36">
        <Reveal>
          <h1 className="marketing-display mx-auto max-w-4xl">
            Know what Azure costs.
            <br className="hidden sm:block" />
            <span className="text-slate-400"> And why it changed.</span>
          </h1>

          <p className="marketing-lead mx-auto mt-7 max-w-2xl">
            Cost, running resources, changes and access across every Azure tenant you can reach —
            read with your own permissions.
          </p>

          <div className="mt-10 flex flex-col items-center justify-center gap-5 sm:flex-row sm:gap-8">
            <button onClick={signIn} className="rounded-full bg-blue-600 px-7 py-3 text-[17px] font-medium text-white transition hover:bg-blue-500">
              Sign in with Microsoft
            </button>
            <a href="#product" className="marketing-cta text-[17px]">
              Explore the product
              <ChevronRight className="marketing-chevron h-4 w-4" />
            </a>
          </div>
        </Reveal>

        <Reveal delay={120} className="mx-auto mt-20 max-w-[980px]">
          <div ref={heroRef} className="will-change-transform">
            <ProductMock />
          </div>
          <p className="mt-6 text-[13px] text-slate-500">
            Illustration only. The app shows figures read from your own Azure account, never sample data.
          </p>
        </Reveal>
      </section>

      {/* ── sources ────────────────────────────────────────────────── */}
      <section className="px-5 py-20" style={{ background: 'var(--surface-raised)' }}>
        <Reveal className="mx-auto max-w-[1024px] text-center">
          <p className="text-[13px] text-slate-500">Reads directly from Microsoft services</p>
          <ul className="mt-7 flex flex-wrap items-center justify-center gap-x-10 gap-y-4">
            {SOURCES.map((label) => (
              <li key={label} className="text-[17px] font-medium tracking-tight text-slate-300">{label}</li>
            ))}
          </ul>
        </Reveal>
      </section>

      {/* ── platform ───────────────────────────────────────────────── */}
      <section className="px-5 py-24 sm:py-32">
        <div className="mx-auto max-w-[1024px]">
          <Reveal className="mx-auto max-w-2xl text-center">
            <p className="marketing-eyebrow">One connected platform</p>
            <h2 className="marketing-headline mt-3">Follow the question. Get the context behind it.</h2>
          </Reveal>

          <div className="mt-14 grid gap-4 sm:grid-cols-2">
            {PRODUCTS.map((product, index) => {
              const Icon = SECTIONS.find((s) => s.key === product.key).icon;
              return (
                <Reveal key={product.key} delay={index * 60}>
                  <a href={productPath(product)} className="marketing-link flex h-full flex-col p-9 sm:p-11">
                    <Icon className="h-7 w-7 text-blue-400" />
                    <h3 className="mt-8 text-2xl font-semibold tracking-tight">{product.label}</h3>
                    <p className="mt-3 flex-1 text-[15px] leading-7 text-slate-400">{product.description}</p>
                    <span className="marketing-cta mt-7 text-[15px]">
                      Learn more
                      <ChevronRight className="marketing-chevron h-4 w-4" />
                    </span>
                  </a>
                </Reveal>
              );
            })}
          </div>
        </div>
      </section>

      {/* ── product areas ──────────────────────────────────────────── */}
      <section id="product" className="scroll-mt-12 px-5 py-24 sm:py-32" style={{ background: 'var(--surface-raised)' }}>
        <div className="mx-auto max-w-[1024px]">
          <Reveal className="mx-auto max-w-3xl text-center">
            <p className="marketing-eyebrow">Azure cost analysis</p>
            <h2 className="marketing-headline mt-3">Understand your cloud bill, down to the resource.</h2>
            <p className="marketing-lead mt-5">
              Compare spend month by month, investigate daily changes, and review reservations and
              savings plans — with billing, inventory and access in one place.
            </p>
          </Reveal>
          <ProductAreas />
        </div>
      </section>

      {/* ── how it works ───────────────────────────────────────────── */}
      <section id="how" className="scroll-mt-12 px-5 py-24 sm:py-32">
        <div className="mx-auto max-w-[1024px]">
          <Reveal className="mx-auto max-w-2xl text-center">
            <p className="marketing-eyebrow">How it works</p>
            <h2 className="marketing-headline mt-3">A clear path from sign-in to insight.</h2>
            <p className="marketing-lead mt-5">
              Nothing to deploy and no agent to install. Azure permissions and data availability
              determine which reports you can open.
            </p>
          </Reveal>

          <ol className="mt-16 grid gap-12 md:grid-cols-3">
            {STEPS.map((step, i) => (
              <Reveal key={step.title} delay={i * 70}>
                <li>
                  <span className="text-[15px] font-semibold text-blue-400">{String(i + 1).padStart(2, '0')}</span>
                  <hr className="marketing-rule mt-4" />
                  <h3 className="mt-5 text-xl font-semibold tracking-tight">{step.title}</h3>
                  <p className="mt-3 text-[15px] leading-7 text-slate-400">{step.body}</p>
                </li>
              </Reveal>
            ))}
          </ol>
        </div>
      </section>

      {/* ── assistants ─────────────────────────────────────────────── */}
      <section id="assistants" className="scroll-mt-12 px-5 py-24 sm:py-32" style={{ background: 'var(--surface-raised)' }}>
        <div className="mx-auto max-w-[1024px]">
          <Reveal className="mx-auto max-w-2xl text-center">
            <p className="marketing-eyebrow">Assistants</p>
            <h2 className="marketing-headline mt-3">Two assistants, kept apart on purpose.</h2>
            <p className="marketing-lead mt-5">
              Asking a question and building infrastructure have different consequences, so they are
              different tools. The one that can spend money is deliberately harder to reach.
            </p>
          </Reveal>

          <div className="mt-14 grid gap-4 lg:grid-cols-2">
            <Reveal>
              <div className="h-full p-9 sm:p-11" style={{ background: 'var(--surface-base)', borderRadius: '1.25rem' }}>
                <h3 className="text-2xl font-semibold tracking-tight">Ask anything</h3>
                <p className="mt-3 text-[15px] leading-7 text-slate-400">
                  A bubble on every page, because questions about spend arrive while you are looking
                  at spend. It answers from your subscriptions, costs and running resources.
                </p>
                <ul className="mt-8 space-y-4 text-[15px] leading-7 text-slate-400">
                  {[
                    'Read-only by construction — it is given no tool that changes anything',
                    'Says “Not available” rather than filling a gap with a guess',
                    'Never names a resource that a tool did not return',
                  ].map((t) => (
                    <li key={t} className="pt-4" style={{ borderTop: '1px solid var(--hairline)' }}>{t}</li>
                  ))}
                </ul>
              </div>
            </Reveal>

            <Reveal delay={70}>
              <div className="h-full p-9 sm:p-11" style={{ background: 'var(--surface-base)', borderRadius: '1.25rem' }}>
                <h3 className="text-2xl font-semibold tracking-tight">Deployment assistant</h3>
                <p className="mt-3 text-[15px] leading-7 text-slate-400">
                  Upload a Pricing Calculator estimate or describe what you need. It drafts the
                  resources, prices them against public retail rates and writes Terraform or Bicep.
                </p>
                <ul className="mt-8 space-y-4 text-[15px] leading-7 text-slate-400">
                  {[
                    'Review generated templates and pricing assumptions before acting',
                    'Lines it could not represent are named, with the reason',
                    'Build deployment requires confirmation, an admin role and Azure permissions',
                  ].map((t) => (
                    <li key={t} className="pt-4" style={{ borderTop: '1px solid var(--hairline)' }}>{t}</li>
                  ))}
                </ul>
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ── security ───────────────────────────────────────────────── */}
      <section id="security" className="scroll-mt-12 px-5 py-24 sm:py-32">
        <div className="mx-auto max-w-[1024px]">
          <Reveal className="mx-auto max-w-2xl text-center">
            <p className="marketing-eyebrow">Security</p>
            <h2 className="marketing-headline mt-3">What it can and cannot do.</h2>
            <p className="marketing-lead mt-5">
              Worth reading before you connect a tenant. These are constraints in the code, not
              promises in a policy.
            </p>
          </Reveal>

          <div className="mt-16 grid gap-x-16 gap-y-12 md:grid-cols-2">
            {SECURITY.map((item, i) => (
              <Reveal key={item.title} delay={i * 60}>
                <div>
                  <hr className="marketing-rule" />
                  <h3 className="mt-6 text-xl font-semibold tracking-tight">{item.title}</h3>
                  <p className="mt-3 text-[15px] leading-7 text-slate-400">{item.body}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── guides ─────────────────────────────────────────────────── */}
      <section className="px-5 py-24 sm:py-32" style={{ background: 'var(--surface-raised)' }}>
        <div className="mx-auto max-w-[1024px]">
          <Reveal className="mx-auto max-w-2xl text-center">
            <p className="marketing-eyebrow">Learning centre</p>
            <h2 className="marketing-headline mt-3">Learn to read your Azure bill.</h2>
            <p className="marketing-lead mt-5">
              {GUIDES.length} practical guides on investigating cost changes, reservation billing,
              rightsizing and monthly reviews.
            </p>
          </Reveal>

          <div className="mt-14 grid gap-4 md:grid-cols-3">
            {FEATURED_GUIDES.map((guide, i) => (
              <Reveal key={guide.slug} delay={i * 60}>
                <a href={guidePath(guide)} className="marketing-link flex h-full flex-col p-8" style={{ background: 'var(--surface-base)' }}>
                  <p className="text-[13px] text-blue-400">{guide.topic}</p>
                  <h3 className="mt-4 text-lg font-semibold leading-snug tracking-tight">{guide.title}</h3>
                  <p className="mt-3 flex-1 text-[15px] leading-7 text-slate-400">{guide.description}</p>
                  <span className="marketing-cta mt-6 text-[15px]">
                    Read guide
                    <ChevronRight className="marketing-chevron h-4 w-4" />
                  </span>
                </a>
              </Reveal>
            ))}
          </div>

          <Reveal className="mt-12 text-center">
            <a href="/guides/" className="marketing-cta text-[17px]">
              Browse all {GUIDES.length} guides
              <ChevronRight className="marketing-chevron h-4 w-4" />
            </a>
          </Reveal>
        </div>
      </section>

      {/* ── faq ────────────────────────────────────────────────────── */}
      <section id="faq" className="scroll-mt-12 px-5 py-24 sm:py-32">
        <div className="mx-auto max-w-3xl">
          <Reveal className="text-center">
            <p className="marketing-eyebrow">FAQ</p>
            <h2 className="marketing-headline mt-3">Questions people actually ask.</h2>
          </Reveal>

          <div className="mt-14">
            {FAQ.map((item, i) => (
              <Reveal key={item.q} delay={i * 40}>
                <details className="group" style={{ borderTop: i === 0 ? '1px solid var(--hairline)' : undefined, borderBottom: '1px solid var(--hairline)' }}>
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-6 py-6 text-[17px] font-medium">
                    {item.q}
                    <span className="shrink-0 text-blue-400 transition-transform group-open:rotate-45">
                      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
                        <path d="M9 3.5v11M3.5 9h11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                      </svg>
                    </span>
                  </summary>
                  <p className="pb-7 text-[15px] leading-7 text-slate-400">{item.a}</p>
                </details>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── closing ────────────────────────────────────────────────── */}
      <section className="px-5 py-24 text-center sm:py-32" style={{ background: 'var(--surface-raised)' }}>
        <Reveal className="mx-auto max-w-2xl">
          <h2 className="marketing-headline">See your own numbers.</h2>
          <p className="marketing-lead mt-5">
            Sign in with your work account, connect a tenant, and start with a read-only cost review.
          </p>
          <div className="mt-10 flex flex-col items-center justify-center gap-5 sm:flex-row sm:gap-8">
            <button onClick={signIn} className="rounded-full bg-blue-600 px-7 py-3 text-[17px] font-medium text-white transition hover:bg-blue-500">
              Sign in with Microsoft
            </button>
            <a href="#security" className="marketing-cta text-[17px]">
              Read the security notes
              <ChevronRight className="marketing-chevron h-4 w-4" />
            </a>
          </div>
        </Reveal>
      </section>

      {/* ── footer ─────────────────────────────────────────────────── */}
      <footer className="px-5 py-14 text-[12px] leading-6 text-slate-500">
        <div className="mx-auto max-w-[1024px]">
          <div className="grid gap-10 sm:grid-cols-3 lg:grid-cols-4">
            <div>
              <p className="font-semibold text-slate-300">Product</p>
              <ul className="mt-3 space-y-2">
                {PRODUCTS.map((product) => (
                  <li key={product.key}><a href={productPath(product)} className="hover:text-slate-300">{product.label}</a></li>
                ))}
              </ul>
            </div>
            <div>
              <p className="font-semibold text-slate-300">Learn</p>
              <ul className="mt-3 space-y-2">
                <li><a href="/guides/" className="hover:text-slate-300">All guides</a></li>
                {NAV_LINKS.slice(1, 4).map((l) => (
                  <li key={l.href}><a href={l.href} className="hover:text-slate-300">{l.label}</a></li>
                ))}
              </ul>
            </div>
            <div>
              <p className="font-semibold text-slate-300">Open</p>
              <ul className="mt-3 space-y-2">
                <li>
                  <a href="https://github.com/anuj7052/Azure-Cost-Analysis" target="_blank" rel="noreferrer noopener" className="hover:text-slate-300">
                    Source on GitHub
                  </a>
                </li>
                <li><button onClick={signIn} className="hover:text-slate-300">Sign in</button></li>
              </ul>
            </div>
            <div>
              <p className="font-semibold text-slate-300">Cloudledger</p>
              <p className="mt-3 max-w-xs">
                Azure cost, estate and access — read with your own permissions.
              </p>
            </div>
          </div>

          <hr className="marketing-rule my-10" />

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p>Not affiliated with Microsoft. Azure and Microsoft Entra are trademarks of Microsoft Corporation.</p>
            <p>Figures in the app are read from your Azure account. This page contains no sample data.</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
