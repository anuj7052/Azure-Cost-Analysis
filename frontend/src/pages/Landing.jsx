import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronRight, Menu, Moon, Sun, X, Check, Cpu, Database, Network, Wallet, CalendarDays, Layers, BadgeCheck, ClipboardList, FileText, Gauge, ShieldCheck } from 'lucide-react';
import { PRODUCT_SECTIONS as SECTIONS } from '../nav';
import { GUIDES, guidePath } from '../content/guides';
import { PRODUCTS, productPath } from '../content/products';
import { FAQ as PUBLIC_FAQ } from '../content/faq';
import { useTheme } from '../store/useTheme';
import MarketingBrand from '../components/Common/MarketingBrand';
import ProductShowcase from '../components/Common/ProductShowcase';

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
  { href: '#showcase', id: 'showcase', label: 'Product' },
  { href: '#how', id: 'how', label: 'How it works' },
  { href: '#features', id: 'features', label: 'Features' },
  { href: '#security', id: 'security', label: 'Security' },
  { href: '#faq', id: 'faq', label: 'FAQ' },
];

/** The Microsoft services the app reads. */
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
    title: 'Admin-only changes',
    body: 'Reporting only reads. Anything that changes Azure — resize, delete, revoke, build — is limited to workspace admins, previewed first and needs explicit confirmation.',
  },
  {
    title: 'Uploads are not kept',
    body: 'A BOQ spreadsheet travels with the request that parses it and is never written to disk. Text inside a cell is treated as data, never as an instruction.',
  },
  {
    title: 'Bring your own model',
    body: 'Point the assistant at your own OpenAI or Azure OpenAI endpoint. It runs on your key, your quota and your data agreement, and stops at the daily limit you set.',
  },
];

const FAQ = PUBLIC_FAQ;

/** What the app does today, one line each. Kept in step with the sidebar. */
const FEATURES = [
  { icon: Wallet, title: 'Cost dashboard', body: 'Pay-as-you-go, reserved (RI) and total spend at a glance, with a daily or monthly graph split by service.' },
  { icon: CalendarDays, title: 'Day by day', body: 'Click any day to see every resource billed on it, and leave a dated note so your team knows why it moved.' },
  { icon: Layers, title: 'Group any way', body: 'Split spend by service, subscription, resource group, meter or payment type — daily or monthly.' },
  { icon: BadgeCheck, title: 'RI, PAYG and DR / ASR', body: 'Billing categories read from Azure’s own pricing model, down to each resource and meter.' },
  { icon: ClipboardList, title: 'BOQ vs actual', body: 'Upload a Pricing Calculator estimate and see, in plain words, where you paid more or less than planned.' },
  { icon: FileText, title: 'Azure Billing workspace', body: 'Customer ledgers, invoices and profit / loss per customer, with cloud-stored documents.' },
  { icon: Gauge, title: 'Estate', body: 'Anomalies, change tracking, activity, idle VMs and orphaned resources, with admin-only actions.' },
  { icon: ShieldCheck, title: 'Access & security', body: 'Unused or risky access, Advisor, Defender, policy and network — with a change history.' },
];

/** Guides shown on the homepage. The rest live on the hub. */
const FEATURED_GUIDES = GUIDES.slice(0, 3);

function prefersLessMotion() {
  return typeof window !== 'undefined'
    && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}

/** Keep content visible before and after React mounts, including deep links. */
function Reveal({ children, delay = 0, className = '' }) {
  return <div className={`marketing-enter ${className}`} style={{ animationDelay: `${delay}ms` }}>{children}</div>;
}

/**
 * An abstract stand-in for the dashboard. Deliberately unlabelled with figures
 * — see the note at the top of the file.
 */
function ProductMock() {
  const bars = [34, 58, 41, 72, 50, 84, 64, 92, 59, 78, 53, 88, 70, 81];
  const [selected, setSelected] = useState(0);
  const services = [
    { label: 'Compute', icon: Cpu, text: 'Trace a VM cost change to its resource, running hours and billing meter.', href: '/features/azure-resource-optimization/#compute' },
    { label: 'Storage', icon: Database, text: 'Review capacity, disk tiers and retained resources behind storage charges.', href: '/guides/azure-storage-cost-growth/' },
    { label: 'Network', icon: Network, text: 'Separate data-transfer charges from network processing and hourly costs.', href: '/guides/understand-azure-bandwidth-data-transfer-costs/' },
  ];

  return (
    <div className="marketing-panel marketing-preview overflow-hidden text-left">
      <div className="flex items-center gap-2 px-5 py-3.5" style={{ borderBottom: '1px solid var(--hairline)' }}>
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: 'var(--hairline)' }} />
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: 'var(--hairline)' }} />
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: 'var(--hairline)' }} />
        <span className="ml-2 text-[11px] text-slate-400">Cloudledger / Cost Explorer</span>
        <span className="preview-label ml-auto">Interactive illustration</span>
      </div>

      <div className="grid grid-cols-[3rem_1fr] sm:grid-cols-[10rem_1fr]">
        <aside className="p-3" style={{ borderRight: '1px solid var(--hairline)' }}>
          {SECTIONS.map((section, i) => (
            <div
              key={section.key}
              className={`mb-1 flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[12px] ${
                i === 0 ? 'bg-[#ea580c] text-white' : 'text-slate-500'
              }`}
            >
              <section.icon className="h-4 w-4 shrink-0" />
              <span className="hidden truncate sm:inline">{section.title}</span>
            </div>
          ))}
        </aside>

        <div className="space-y-3 p-4 sm:p-6">
          <div className="grid grid-cols-3 gap-2" aria-label="Explore cost categories">
            {services.map((service, index) => (
              <button key={service.label} aria-pressed={selected === index} onClick={() => setSelected(index)} className="preview-service">
                <service.icon size={18} aria-hidden="true" />
                <span>{service.label}</span>
              </button>
            ))}
          </div>

          <div key={selected} className="preview-chart flex h-28 items-end gap-[3px] sm:h-40" aria-hidden="true">
            {bars.map((height, i) => (
              <div
                key={i}
                className="preview-bar flex-1 rounded-t-[3px]"
                style={{
                  height: `${bars[(i + selected * 3) % bars.length]}%`,
                  // One hue, varied only by weight. A full-saturation bar chart
                  // in a hero is decoration; this reads as data at a glance and
                  // stops competing with the headline above it.
                  background: i % 4 === selected ? 'linear-gradient(180deg, #fb923c, #ea580c)' : 'color-mix(in srgb, #64748b 55%, transparent)',
                  opacity: 1,
                  animationDelay: `${i * 35}ms`,
                }}
              />
            ))}
          </div>

          <div className="preview-insight" aria-live="polite">
            <span className="preview-insight-mark" aria-hidden="true"><Check size={16} /></span>
            <div><p className="text-sm font-semibold">Follow the {services[selected].label.toLowerCase()} cost</p><p className="mt-1 text-xs leading-6 text-slate-400">{services[selected].text}</p><a href={services[selected].href} className="marketing-cta mt-2 text-xs">Explore the workflow <ChevronRight size={14} /></a></div>
          </div>
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
    <div className="marketing landing-warm aca-motion min-h-screen scroll-smooth bg-slate-950 text-white">
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
        <div className="mx-auto flex h-16 max-w-[1120px] items-center justify-between px-5">
          <MarketingBrand href="#top" />

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
            <button onClick={signIn} className="brand-button hidden rounded-full px-4 py-2 text-[13px] font-semibold sm:block">
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
            <button onClick={signIn} className="brand-button mt-5 w-full rounded-full py-2.5 text-[15px] font-semibold">
              Sign in with Microsoft
            </button>
          </div>
        )}
      </header>

      {/* ── hero ───────────────────────────────────────────────────── */}
      <section id="top" className="warm-hero px-5 pb-16 pt-28 sm:pt-32">
        <div className="mx-auto grid max-w-[1200px] items-center gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
          <Reveal className="text-center lg:text-left">
            <p className="hero-kicker"><span aria-hidden="true" /> Azure cost, explained — for finance and cloud teams</p>
            <h1 className="marketing-display hero-title">
              Know what Azure costs. <span className="brand-text">And exactly why.</span>
            </h1>
            <p className="marketing-lead mx-auto mt-6 max-w-xl lg:mx-0">
              Daily spend down to the resource, RI vs pay-as-you-go, BOQ vs actual and customer billing —
              in one place, read with your own Azure permissions.
            </p>
            <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row sm:justify-center lg:justify-start">
              <button onClick={signIn} className="brand-button rounded-full px-7 py-3 text-[16px] font-semibold">
                Sign in with Microsoft
              </button>
              <a href="#features" className="ghost-button inline-flex items-center gap-1.5 rounded-full px-6 py-3 text-[15px] font-medium">
                Explore features
                <ChevronRight className="h-4 w-4" />
              </a>
            </div>
            <div className="hero-proof hero-proof-left" aria-label="Product highlights">{['Microsoft Entra sign-in', 'Read-only reporting', 'Resource-level detail'].map(label => <span key={label}><Check size={14} aria-hidden="true" />{label}</span>)}</div>
          </Reveal>

          <Reveal delay={120}>
            <div ref={heroRef} className="will-change-transform">
              <ProductMock />
            </div>
            <p className="mt-3 text-center text-[12px] text-slate-500">
              Illustration only — the app shows figures from your own Azure account.
            </p>
          </Reveal>
        </div>

        <Reveal className="mx-auto max-w-[1200px]">
          <div className="hero-stats" aria-label="At a glance">
            {[['Day-level', 'cost detail'], ['RI · PAYG', 'split by Azure'], ['0', 'agents to install'], ['Read-only', 'by default']].map(([v, l]) => <div key={l}><strong>{v}</strong><span>{l}</span></div>)}
          </div>
        </Reveal>
      </section>

      {/* ── sources ────────────────────────────────────────────────── */}
      <section className="source-strip px-5 py-9" style={{ background: 'var(--surface-raised)' }}>
        <Reveal className="mx-auto max-w-[1024px] text-center">
          <p className="text-[13px] text-slate-500">Reads directly from Microsoft services</p>
          <ul className="mt-7 flex flex-wrap items-center justify-center gap-x-10 gap-y-4">
            {SOURCES.map((label) => (
              <li key={label} className="text-[17px] font-medium tracking-tight text-slate-300">{label}</li>
            ))}
          </ul>
        </Reveal>
      </section>

      <ProductShowcase />

      {/* ── how it works ───────────────────────────────────────────── */}
      <section id="how" className="scroll-mt-12 px-5 py-16 sm:py-20">
        <div className="mx-auto max-w-[1024px]">
          <Reveal className="mx-auto max-w-2xl text-center">
            <p className="marketing-eyebrow">How it works</p>
            <h2 className="marketing-headline mt-3">A clear path from sign-in to insight.</h2>
            <p className="marketing-lead mt-5">
              Nothing to deploy and no agent to install. Azure permissions and data availability
              determine which reports you can open.
            </p>
          </Reveal>

          <ol className="mt-12 grid gap-3 md:grid-cols-3">
            {STEPS.map((step, i) => (
              <Reveal key={step.title} delay={i * 70}>
                <li className="feature-card">
                  <span className="text-[15px] font-semibold" style={{ color: 'var(--brand-accent)' }}>{String(i + 1).padStart(2, '0')}</span>
                  <h3 className="mt-3 text-[17px] font-semibold tracking-tight">{step.title}</h3>
                  <p className="mt-2 text-[14px] leading-6 text-slate-400">{step.body}</p>
                </li>
              </Reveal>
            ))}
          </ol>
        </div>
      </section>

      {/* ── features ──────────────────────────────────────────────── */}
      <section id="features" className="scroll-mt-12 px-5 py-16 sm:py-20" style={{ background: 'var(--surface-raised)' }}>
        <div className="mx-auto max-w-[1120px]">
          <Reveal className="mx-auto max-w-2xl text-center">
            <p className="marketing-eyebrow">Features</p>
            <h2 className="marketing-headline mt-3">Understand your cloud bill, down to the resource.</h2>
            <p className="marketing-lead mt-5">Built for finance and cloud teams. Every figure comes from your own Azure account.</p>
          </Reveal>
          <div className="mt-12 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {FEATURES.map((f, i) => (
              <Reveal key={f.title} delay={i * 40}>
                <div className="feature-card">
                  <span className="platform-icon"><f.icon size={20} /></span>
                  <h3 className="mt-5 text-[17px] font-semibold tracking-tight">{f.title}</h3>
                  <p className="mt-2 text-[14px] leading-6 text-slate-400">{f.body}</p>
                </div>
              </Reveal>
            ))}
          </div>
          <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {PRODUCTS.map((product) => (
              <a key={product.key} href={productPath(product)} className="feature-card flex items-center justify-between gap-3 !py-4">
                <span><span className="block text-[14px] font-semibold">{product.label}</span><span className="block text-[12px] text-slate-400">{product.outcome}</span></span>
                <ChevronRight className="h-4 w-4 shrink-0" style={{ color: 'var(--brand-accent)' }} aria-hidden="true" />
              </a>
            ))}
          </div>
          <Reveal className="mt-8 rounded-2xl p-6 text-center sm:p-7" style={{ background: 'var(--surface-base)', border: '1px solid var(--hairline)' }}>
            <p className="text-[15px] font-semibold">Plus a read-only assistant on every page</p>
            <p className="mx-auto mt-2 max-w-2xl text-[14px] leading-6 text-slate-400">Ask about your spend in plain words. It answers only from your subscriptions and costs, says “Not available” instead of guessing, and cannot change anything.</p>
          </Reveal>
        </div>
      </section>

      {/* ── security ───────────────────────────────────────────────── */}
      <section id="security" className="scroll-mt-12 px-5 py-16 sm:py-20">
        <div className="mx-auto max-w-[1024px]">
          <Reveal className="mx-auto max-w-2xl text-center">
            <p className="marketing-eyebrow">Security</p>
            <h2 className="marketing-headline mt-3">What it can and cannot do.</h2>
            <p className="marketing-lead mt-5">
              Worth reading before you connect a tenant. These are constraints in the code, not
              promises in a policy.
            </p>
          </Reveal>

          <div className="mt-12 grid gap-3 md:grid-cols-2">
            {SECURITY.map((item, i) => (
              <Reveal key={item.title} delay={i * 60}>
                <div className="feature-card">
                  <h3 className="flex items-center gap-2 text-[17px] font-semibold tracking-tight"><ShieldCheck size={18} style={{ color: 'var(--brand-accent)' }} aria-hidden="true" />{item.title}</h3>
                  <p className="mt-3 text-[14px] leading-6 text-slate-400">{item.body}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── guides ─────────────────────────────────────────────────── */}
      <section className="px-5 py-16 sm:py-20" style={{ background: 'var(--surface-raised)' }}>
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
                <a href={guidePath(guide)} className="feature-card flex flex-col">
                  <p className="text-[13px]" style={{ color: 'var(--brand-accent)' }}>{guide.topic}</p>
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
      <section id="faq" className="scroll-mt-12 px-5 py-16 sm:py-20">
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
                    <span className="shrink-0 transition-transform group-open:rotate-45" style={{ color: 'var(--brand-accent)' }}>
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
      <section className="px-5 py-20 text-center sm:py-24">
        <Reveal className="closing-band">
          <h2 className="marketing-headline">See your own numbers.</h2>
          <p className="marketing-lead mt-5">
            Sign in with your work account, connect a tenant, and start with a read-only cost review.
          </p>
          <div className="mt-10 flex flex-col items-center justify-center gap-5 sm:flex-row sm:gap-8">
            <button onClick={signIn} className="brand-button rounded-full px-7 py-3 text-[17px] font-semibold">
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
