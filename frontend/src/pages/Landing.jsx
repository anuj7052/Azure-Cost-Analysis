import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Activity, ArrowRight, ArrowUpRight, BarChart3, Check, Cloud, Code2, Database,
  FileCode, Globe2, KeyRound, Lock, MessageCircle, Menu, Moon, Search,
  ShieldCheck, Sparkles, Sun, X,
} from 'lucide-react';
import { SECTIONS } from '../nav';
import { FAQ as PUBLIC_FAQ } from '../content/faq';
import { useTheme } from '../store/useTheme';

/**
 * The public front door.
 *
 * Everything here is written from what the product actually does. The feature
 * tabs are generated from SECTIONS — the same list the sidebar and the section
 * hubs are built from — so a page that is added, renamed or removed cannot
 * quietly leave a promise behind on the marketing page.
 *
 * The product mock in the hero carries no figures. A hero image full of
 * invented spend would be the first thing a visitor sees and the first thing
 * that is untrue, and this app's whole claim is that it does not make numbers
 * up. Shapes convey "this is a cost tool" perfectly well without it.
 */

const NAV_LINKS = [
  { href: '#features', id: 'features', label: 'Product' },
  { href: '#how', id: 'how', label: 'How it works' },
  { href: '#assistants', id: 'assistants', label: 'Assistants' },
  { href: '#security', id: 'security', label: 'Security' },
  { href: '#faq', id: 'faq', label: 'FAQ' },
];

/** The Microsoft services the app reads. Matches the API Catalog page. */
const SOURCES = [
  { icon: BarChart3, label: 'Cost Management' },
  { icon: Search, label: 'Resource Graph' },
  { icon: Activity, label: 'Activity Log' },
  { icon: KeyRound, label: 'Microsoft Entra' },
  { icon: Sparkles, label: 'Azure Advisor' },
  { icon: ShieldCheck, label: 'Microsoft Defender' },
];

const STEPS = [
  {
    title: 'Sign in with Microsoft',
    body: 'No new password and no account to create. You sign in with the same work account you already use for Azure, through Microsoft Entra.',
  },
  {
    title: 'Connect a tenant',
    body: 'Point the app at the Azure tenant you want to read. It uses your own delegated permissions, so it can never see more of Azure than you can.',
  },
  {
    title: 'Read your estate',
    body: 'Cost, what is running, what changed and who can reach it — pulled live from Azure rather than from a copy that drifts.',
  },
];

const SECURITY = [
  {
    icon: Lock,
    title: 'Your permissions, not ours',
    body: 'Every call to Azure is made with your own delegated token. If Azure would refuse you, it refuses the app. There is no service principal quietly holding more access than the person using it.',
    wide: true,
  },
  {
    icon: ShieldCheck,
    title: 'Generation, never deployment',
    body: 'The Deployment Assistant writes Terraform and Bicep for you to review and run. It holds no write credentials for your subscription.',
  },
  {
    icon: Database,
    title: 'Uploads are not kept',
    body: 'A BOQ spreadsheet travels with the request that parses it and is never written to disk. Text inside a cell is data, never an instruction.',
  },
  {
    icon: Sparkles,
    title: 'Bring your own model',
    body: 'Point the assistants at your own OpenAI or Azure OpenAI endpoint. They run on your key, your quota and your data agreement, and stop at the daily limit you set.',
    wide: true,
  },
];

const FAQ = PUBLIC_FAQ;

/** True when the visitor has asked their system for less animation. */
function prefersLessMotion() {
  return (
    typeof window !== 'undefined' &&
    Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
  );
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
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShown(true);
          observer.disconnect();
        }
      },
      { rootMargin: '0px 0px -10% 0px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [shown]);

  return (
    <div
      ref={ref}
      className={className}
      style={{
        opacity: shown ? 1 : 0,
        transform: shown ? 'none' : 'translateY(18px)',
        transition: `opacity .6s ease ${delay}ms, transform .6s cubic-bezier(.22,1,.36,1) ${delay}ms`,
      }}
    >
      {children}
    </div>
  );
}

/** Section heading with an eyebrow label, used for every block below the hero. */
function SectionHeading({ eyebrow, title, body, align = 'left' }) {
  const centered = align === 'center';
  return (
    <Reveal className={centered ? 'mx-auto max-w-2xl text-center' : 'max-w-2xl'}>
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-400">{eyebrow}</p>
      <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h2>
      {body && <p className="mt-4 text-base leading-7 text-slate-400">{body}</p>}
    </Reveal>
  );
}

/**
 * An abstract stand-in for the dashboard: sidebar, top bar, KPI tiles and a
 * chart. Deliberately unlabelled with figures — see the note at the top.
 */
function ProductMock() {
  const bars = [38, 62, 45, 78, 55, 88, 70, 96, 64, 82, 58, 91, 74, 86];
  const line = 'M0 70 C 30 66, 50 58, 80 60 S 130 48, 160 44 S 210 52, 240 34 S 290 28, 320 18';

  return (
    <div className="relative overflow-hidden rounded-2xl border border-slate-700/60 bg-slate-900/90 elevated-xl backdrop-blur-xl">
      {/* window chrome */}
      <div className="flex items-center gap-2 border-b border-slate-800 px-4 py-2.5">
        <span className="h-2.5 w-2.5 rounded-full bg-rose-400/70" />
        <span className="h-2.5 w-2.5 rounded-full bg-amber-400/70" />
        <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/70" />
        <span className="ml-3 flex h-6 flex-1 items-center rounded-md bg-slate-950/70 px-2 text-[10px] text-slate-500">
          cloudledger · Dashboard
        </span>
      </div>

      <div className="grid grid-cols-[3.25rem_1fr] sm:grid-cols-[8.5rem_1fr]">
        {/* sidebar */}
        <aside className="border-r border-slate-800 bg-slate-950/50 p-2.5">
          {SECTIONS.map((s, i) => (
            <div
              key={s.key}
              className={`mb-1 flex items-center gap-2 rounded-lg px-2 py-1.5 text-[11px] ${
                i === 0 ? 'bg-blue-600 text-white' : 'text-slate-500'
              }`}
            >
              <s.icon className="h-3.5 w-3.5 shrink-0" />
              <span className="hidden truncate sm:inline">{s.title}</span>
            </div>
          ))}
        </aside>

        {/* main */}
        <div className="p-3 sm:p-4">
          <div className="grid grid-cols-3 gap-2">
            {['Actual cost', 'Latest month', 'Daily burn'].map((label, i) => (
              <div key={label} className="rounded-xl border border-slate-800 bg-slate-950/60 p-2.5">
                <p className="truncate text-[10px] font-medium text-slate-500">{label}</p>
                <div className="mt-2 h-3 w-4/5 rounded bg-slate-700/70" />
                <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-blue-500 to-cyan-400"
                    style={{
                      width: `${[72, 48, 33][i]}%`,
                      animation: `aca-grow .9s cubic-bezier(.22,1,.36,1) ${200 + i * 120}ms both`,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>

          <div className="mt-2 grid gap-2 lg:grid-cols-[1.4fr_1fr]">
            <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
              <div className="flex items-center justify-between">
                <p className="text-[10px] font-medium text-slate-500">Spend by day</p>
                <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[9px] text-emerald-300">
                  Live from Azure
                </span>
              </div>
              <div className="mt-2 flex h-24 items-end gap-1 sm:h-28">
                {bars.map((h, i) => (
                  <div
                    key={i}
                    className="flex-1 rounded-t-sm bg-gradient-to-t from-blue-600/40 to-cyan-400/80"
                    style={{
                      height: `${h}%`,
                      animation: `aca-rise .8s cubic-bezier(.22,1,.36,1) ${i * 45}ms both`,
                    }}
                  />
                ))}
              </div>
            </div>

            <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
              <p className="text-[10px] font-medium text-slate-500">Trend &amp; forecast</p>
              <svg viewBox="0 0 320 80" className="mt-2 h-24 w-full sm:h-28" aria-hidden="true">
                <defs>
                  <linearGradient id="aca-mock-fill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.35" />
                    <stop offset="100%" stopColor="#38bdf8" stopOpacity="0" />
                  </linearGradient>
                </defs>
                <path d={`${line} L320 80 L0 80 Z`} fill="url(#aca-mock-fill)" />
                <path d={line} fill="none" stroke="#38bdf8" strokeWidth="2" strokeLinecap="round" />
                <path d="M240 34 S 290 28, 320 18" fill="none" stroke="#38bdf8" strokeWidth="2" strokeDasharray="4 4" opacity=".6" />
              </svg>
            </div>
          </div>

          <div className="mt-2 flex items-center gap-2 rounded-xl border border-violet-500/25 bg-violet-500/10 px-3 py-2">
            <Sparkles className="h-3.5 w-3.5 shrink-0 text-violet-300" />
            <p className="text-[10px] leading-relaxed text-slate-300">
              Cost change explained: reservation purchase, new resources, and rate changes — each named from billing data.
            </p>
          </div>
        </div>
      </div>

      <p className="border-t border-slate-800 px-4 py-2 text-[10px] text-slate-500">
        Illustration only — the app shows figures read from your own Azure account, never sample data.
      </p>
    </div>
  );
}

/** A tiny, honest sketch of the read-only assistant. */
function ChatMock() {
  return (
    <div className="mt-6 space-y-2 rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-[12px] leading-relaxed">
      <div className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-md bg-blue-600 px-3 py-2 text-white">
        Which resource group grew the most this month?
      </div>
      <div className="w-fit max-w-[90%] rounded-2xl rounded-bl-md border border-slate-800 bg-slate-900 px-3 py-2 text-slate-300">
        Answered from your Cost Management data, named exactly as Azure returns it. When a figure is unavailable, it says so.
      </div>
    </div>
  );
}

/** Tabbed feature browser generated from the app's own navigation. */
function FeatureTabs() {
  const [active, setActive] = useState(SECTIONS[0].key);
  const section = SECTIONS.find((s) => s.key === active) ?? SECTIONS[0];
  const items = section.items.filter((item) => !item.overview);

  return (
    <div className="mt-12">
      <div
        role="tablist"
        aria-label="Product areas"
        className="flex gap-1.5 overflow-x-auto rounded-2xl border border-slate-800 bg-slate-900/60 p-1.5 [scrollbar-width:none] sm:inline-flex"
      >
        {SECTIONS.map((s) => {
          const selected = s.key === section.key;
          return (
            <button
              key={s.key}
              role="tab"
              id={`tab-${s.key}`}
              aria-selected={selected}
              aria-controls={`panel-${s.key}`}
              onClick={() => setActive(s.key)}
              className={`flex shrink-0 items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition ${
                selected
                  ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/25'
                  : 'text-slate-400 hover:bg-slate-800/70 hover:text-white'
              }`}
            >
              <s.icon className="h-4 w-4" />
              {s.title}
            </button>
          );
        })}
      </div>

      <div
        key={section.key}
        role="tabpanel"
        id={`panel-${section.key}`}
        aria-labelledby={`tab-${section.key}`}
        className="animate-fade-up mt-6 grid gap-5 lg:grid-cols-[0.8fr_1.6fr]"
      >
        <div className="rounded-2xl border border-blue-500/20 bg-gradient-to-br from-blue-600/15 via-slate-900 to-slate-900 p-7 lg:sticky lg:top-24 lg:self-start">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-blue-600 text-white">
            <section.icon className="h-5 w-5" />
          </span>
          <h3 className="mt-5 text-2xl font-semibold tracking-tight">{section.title}</h3>
          <p className="mt-2 text-base leading-7 text-slate-400">{section.tagline}</p>
          <p className="mt-6 text-xs text-slate-500">
            {items.length} pages · generated from the app's own navigation
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {items.map((item) => (
            <div
              key={item.to}
              className="group rounded-2xl border border-slate-800 bg-slate-900/70 p-5 transition-colors hover:border-blue-500/40"
            >
              <div className="flex items-center justify-between">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-800/80 text-slate-300 transition-colors group-hover:bg-blue-600/20 group-hover:text-blue-300">
                  <item.icon className="h-4 w-4" />
                </span>
                <ArrowUpRight className="h-4 w-4 text-slate-600 opacity-0 transition group-hover:opacity-100" />
              </div>
              <p className="mt-4 text-sm font-semibold">{item.label}</p>
              <p className="mt-1.5 text-[13px] leading-6 text-slate-400">{item.blurb}</p>
            </div>
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
  const [progress, setProgress] = useState(0);
  const [activeId, setActiveId] = useState('');
  const theme = useTheme((s) => s.theme);
  const toggleTheme = useTheme((s) => s.toggleTheme);

  useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      setScrolled(y > 12);
      setProgress(max > 0 ? Math.min(1, y / max) : 0);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Highlight the nav link for the section currently on screen.
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return undefined;
    const nodes = NAV_LINKS.map((l) => document.getElementById(l.id)).filter(Boolean);
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting);
        if (visible.length) setActiveId(visible[0].target.id);
      },
      { rootMargin: '-40% 0px -55% 0px' },
    );
    nodes.forEach((n) => observer.observe(n));
    return () => observer.disconnect();
  }, []);

  // The mobile menu must not leave the page scrolled behind it.
  useEffect(() => {
    if (!menuOpen) return undefined;
    const close = () => setMenuOpen(false);
    window.addEventListener('resize', close);
    return () => window.removeEventListener('resize', close);
  }, [menuOpen]);

  const signIn = () => navigate('/login');

  const themeToggle = (
    <button
      onClick={toggleTheme}
      aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      className="flex h-10 w-10 items-center justify-center rounded-xl border border-slate-800 text-slate-400 transition-colors hover:border-slate-700 hover:text-slate-200"
    >
      {theme === 'dark' ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
    </button>
  );

  return (
    <div className="aca-motion min-h-screen scroll-smooth bg-slate-950 text-white">
      <style>{`
        @media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }
      `}</style>

      <a
        href="#top"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-lg focus:bg-blue-600 focus:px-3 focus:py-2 focus:text-sm focus:text-white"
      >
        Skip to content
      </a>

      {/* --- header ------------------------------------------------ */}
      <header
        className={`fixed inset-x-0 top-0 z-50 transition-colors duration-300 ${
          scrolled ? 'border-b border-slate-800/80 bg-slate-950/85 backdrop-blur-xl' : ''
        }`}
      >
        <div
          aria-hidden="true"
          className="absolute inset-x-0 top-0 h-0.5 origin-left bg-gradient-to-r from-blue-500 to-cyan-400"
          style={{ transform: `scaleX(${progress})`, transition: 'transform 80ms linear' }}
        />
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 sm:px-8">
          <a href="#top" className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-600 text-white shadow-lg shadow-blue-600/30">
              <Cloud className="h-4.5 w-4.5" />
            </span>
            <span className="text-sm font-bold tracking-wide">CLOUDLEDGER</span>
          </a>

          <nav className="hidden items-center gap-1 rounded-full border border-slate-800/80 bg-slate-900/60 p-1 lg:flex">
            {NAV_LINKS.map((l) => (
              <a
                key={l.href}
                href={l.href}
                aria-current={activeId === l.id ? 'true' : undefined}
                className={`rounded-full px-3.5 py-1.5 text-sm transition-colors ${
                  activeId === l.id
                    ? 'bg-slate-800 text-white'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                {l.label}
              </a>
            ))}
          </nav>

          <div className="flex items-center gap-2">
            {themeToggle}
            <button
              onClick={signIn}
              className="hidden rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-500 sm:block"
            >
              Sign in
            </button>
            <button
              onClick={() => setMenuOpen((v) => !v)}
              aria-label={menuOpen ? 'Close menu' : 'Open menu'}
              aria-expanded={menuOpen}
              className="flex h-10 w-10 items-center justify-center rounded-xl border border-slate-800 text-slate-300 lg:hidden"
            >
              {menuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
          </div>
        </div>

        {menuOpen && (
          <div className="animate-fade-up border-t border-slate-800 bg-slate-950/95 px-5 py-4 backdrop-blur-xl lg:hidden">
            {NAV_LINKS.map((l) => (
              <a
                key={l.href}
                href={l.href}
                onClick={() => setMenuOpen(false)}
                className="block rounded-lg px-2 py-2.5 text-sm text-slate-300 hover:bg-slate-900"
              >
                {l.label}
              </a>
            ))}
            <button
              onClick={signIn}
              className="mt-3 w-full rounded-xl bg-blue-600 py-2.5 text-sm font-semibold text-white"
            >
              Sign in with Microsoft
            </button>
          </div>
        )}
      </header>

      {/* --- hero -------------------------------------------------- */}
      <section id="top" className="relative overflow-hidden px-5 pb-16 pt-28 sm:px-8 sm:pt-36">
        <div className="aca-grid-lines pointer-events-none absolute inset-0 [mask-image:radial-gradient(ellipse_at_top,black_30%,transparent_75%)]" />
        <div
          className="pointer-events-none absolute -left-40 -top-40 h-[34rem] w-[34rem] rounded-full bg-blue-600/25 blur-3xl"
          style={{ animation: 'aca-drift 18s ease-in-out infinite' }}
        />
        <div
          className="pointer-events-none absolute -right-32 top-32 h-[28rem] w-[28rem] rounded-full bg-cyan-400/10 blur-3xl"
          style={{ animation: 'aca-drift 22s ease-in-out infinite reverse' }}
        />

        <div className="relative mx-auto grid max-w-6xl items-center gap-14 lg:grid-cols-[1fr_1.05fr]">
          <Reveal>
            <span className="inline-flex items-center gap-2 rounded-full border border-blue-500/30 bg-blue-500/10 px-3.5 py-1.5 text-xs font-medium text-blue-300">
              <ShieldCheck className="h-3.5 w-3.5" />
              Read-only by default · Microsoft Entra sign-in
            </span>

            <h1 className="mt-6 text-4xl font-semibold leading-[1.06] tracking-tight sm:text-5xl lg:text-[3.6rem]">
              Know what Azure is costing you,
              <span className="aca-accent-text"> and why it moved.</span>
            </h1>

            <p className="mt-6 max-w-xl text-base leading-7 text-slate-400 sm:text-lg sm:leading-8">
              Cost, running resources, changes and access across every Azure tenant you can
              reach — read live from your own account with your own permissions. Nothing is
              estimated, and nothing is written back.
            </p>

            <div className="mt-9 flex flex-col gap-3 sm:flex-row">
              <button
                onClick={signIn}
                className="group inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-6 py-3.5 text-sm font-semibold text-white shadow-lg shadow-blue-600/30 transition hover:bg-blue-500"
              >
                Sign in with Microsoft
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </button>
              <a
                href="#features"
                className="inline-flex items-center justify-center rounded-xl border border-slate-700 px-6 py-3.5 text-sm font-medium text-slate-300 transition hover:border-slate-500 hover:text-white"
              >
                Explore the product
              </a>
            </div>

            <ul className="mt-7 flex flex-wrap gap-x-5 gap-y-2 text-xs text-slate-500">
              {['No new password', 'No credit card', 'No agent to install', 'Nothing written back'].map((t) => (
                <li key={t} className="flex items-center gap-1.5">
                  <Check className="h-3.5 w-3.5 text-emerald-400" />
                  {t}
                </li>
              ))}
            </ul>
          </Reveal>

          <Reveal delay={140}>
            <div className="relative">
              <div className="pointer-events-none absolute -inset-6 rounded-[2rem] bg-gradient-to-br from-blue-500/20 via-transparent to-cyan-400/10 blur-2xl" />
              <div className="relative" style={{ animation: 'aca-float 8s ease-in-out infinite' }}>
                <ProductMock />
              </div>
            </div>
          </Reveal>
        </div>

        {/* data sources */}
        <Reveal delay={260} className="relative mx-auto mt-20 max-w-6xl">
          <p className="text-center text-xs font-medium uppercase tracking-[0.18em] text-slate-500">
            Reads directly from Microsoft services
          </p>
          <ul className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {SOURCES.map((s) => (
              <li
                key={s.label}
                className="flex items-center justify-center gap-2 rounded-xl border border-slate-800 bg-slate-900/50 px-3 py-3 text-sm text-slate-300"
              >
                <s.icon className="h-4 w-4 text-blue-400" />
                {s.label}
              </li>
            ))}
          </ul>
        </Reveal>
      </section>

      {/* --- features --------------------------------------------- */}
      <section id="features" className="scroll-mt-16 border-t border-slate-800 px-5 py-24 sm:px-8">
        <div className="mx-auto max-w-6xl">
          <SectionHeading
            eyebrow="Product"
            title="Four questions, answered properly"
            body="Every page exists to answer one question. This list is generated from the application's own navigation, so it describes the product as it is today."
          />
          <FeatureTabs />
        </div>
      </section>

      {/* --- how it works ----------------------------------------- */}
      <section id="how" className="scroll-mt-16 border-t border-slate-800 px-5 py-24 sm:px-8">
        <div className="mx-auto max-w-6xl">
          <SectionHeading
            eyebrow="How it works"
            title="Running in about a minute"
            body="There is nothing to deploy and no agent to install. The app reads Azure's own APIs on your behalf."
            align="center"
          />

          <ol className="relative mt-14 grid gap-5 md:grid-cols-3">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute left-[16.6%] right-[16.6%] top-11 hidden h-px bg-gradient-to-r from-blue-500/0 via-blue-500/50 to-blue-500/0 md:block"
            />
            {STEPS.map((step, i) => (
              <Reveal key={step.title} delay={i * 90}>
                <li className="relative h-full rounded-2xl border border-slate-800 bg-slate-900/70 p-6">
                  <span className="relative flex h-10 w-10 items-center justify-center rounded-xl bg-blue-600 text-sm font-bold text-white shadow-lg shadow-blue-600/30">
                    {i + 1}
                  </span>
                  <p className="mt-5 text-base font-semibold">{step.title}</p>
                  <p className="mt-2.5 text-sm leading-6 text-slate-400">{step.body}</p>
                </li>
              </Reveal>
            ))}
          </ol>
        </div>
      </section>

      {/* --- assistants ------------------------------------------- */}
      <section id="assistants" className="scroll-mt-16 border-t border-slate-800 px-5 py-24 sm:px-8">
        <div className="mx-auto max-w-6xl">
          <SectionHeading
            eyebrow="Assistants"
            title="Two assistants, kept apart on purpose"
            body="Asking a question and building infrastructure are different acts with different consequences, so they are different tools. The one that could spend money is deliberately harder to reach than the one that reads."
          />

          <div className="mt-12 grid gap-5 lg:grid-cols-2">
            <Reveal>
              <div className="h-full rounded-2xl border border-slate-800 bg-slate-900/70 p-7">
                <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-sky-600/15 text-sky-300">
                  <MessageCircle className="h-5 w-5" />
                </span>
                <p className="mt-5 text-lg font-semibold">Ask anything</p>
                <p className="mt-2.5 text-sm leading-6 text-slate-400">
                  A bubble in the corner of every page, because questions about spend arrive while
                  you are looking at spend. It answers from your subscriptions, costs and running
                  resources.
                </p>
                <ul className="mt-5 space-y-2.5 text-sm text-slate-400">
                  {[
                    'Read-only by construction — it is given no tool that changes anything',
                    'Says "Not available" rather than filling a gap with a guess',
                    'Never names a resource that a tool did not return',
                  ].map((t) => (
                    <li key={t} className="flex gap-2.5">
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-sky-400" />
                      <span>{t}</span>
                    </li>
                  ))}
                </ul>
                <ChatMock />
              </div>
            </Reveal>

            <Reveal delay={90}>
              <div className="h-full rounded-2xl border border-slate-800 bg-slate-900/70 p-7">
                <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-violet-600/15 text-violet-300">
                  <FileCode className="h-5 w-5" />
                </span>
                <p className="mt-5 text-lg font-semibold">Deployment assistant</p>
                <p className="mt-2.5 text-sm leading-6 text-slate-400">
                  Upload a Pricing Calculator estimate or describe what you need. It drafts the
                  resources, prices them against Azure's public retail rates and writes Terraform
                  or Bicep.
                </p>
                <ul className="mt-5 space-y-2.5 text-sm text-slate-400">
                  {[
                    'Templates are generated, never applied — you run them',
                    'Lines it could not represent are named, with the reason',
                    'A review step always sits in front of the step that spends money',
                  ].map((t) => (
                    <li key={t} className="flex gap-2.5">
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-violet-400" />
                      <span>{t}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-6 overflow-hidden rounded-xl border border-slate-800 bg-slate-950/70">
                  <div className="flex items-center gap-2 border-b border-slate-800 px-3 py-2 text-[11px] text-slate-500">
                    <Code2 className="h-3.5 w-3.5" /> main.tf · generated for review
                  </div>
                  <pre className="overflow-x-auto p-3 text-[11px] leading-5 text-slate-300">
{`resource "azurerm_linux_virtual_machine" "app" {
  name     = "vm-app-01"
  size     = "Standard_D2s_v5"
  # priced from Azure retail rates; review before apply
}`}
                  </pre>
                </div>
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* --- security --------------------------------------------- */}
      <section id="security" className="scroll-mt-16 border-t border-slate-800 px-5 py-24 sm:px-8">
        <div className="mx-auto max-w-6xl">
          <SectionHeading
            eyebrow="Security"
            title="What it can and cannot do"
            body="Worth reading before you connect a tenant. These are constraints in the code, not promises in a policy."
          />

          <div className="mt-12 grid gap-5 md:grid-cols-5">
            {SECURITY.map((s, i) => (
              <Reveal key={s.title} delay={i * 70} className={s.wide ? 'md:col-span-3' : 'md:col-span-2'}>
                <div className="h-full rounded-2xl border border-slate-800 bg-slate-900/70 p-6">
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-300">
                    <s.icon className="h-5 w-5" />
                  </span>
                  <p className="mt-5 text-base font-semibold">{s.title}</p>
                  <p className="mt-2.5 text-sm leading-6 text-slate-400">{s.body}</p>
                </div>
              </Reveal>
            ))}
          </div>

          <Reveal delay={100}>
            <div className="mt-5 flex flex-col items-start gap-4 rounded-2xl border border-slate-800 bg-slate-900/40 p-6 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3">
                <Globe2 className="h-5 w-5 text-blue-400" />
                <p className="text-sm text-slate-300">
                  Every Microsoft endpoint behind the app is listed in the API Catalog once you sign in.
                </p>
              </div>
              <a
                href="https://github.com/anuj7052/Azure-Cost-Analysis"
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1.5 text-sm font-medium text-blue-400 hover:text-blue-300"
              >
                Read the source <ArrowUpRight className="h-4 w-4" />
              </a>
            </div>
          </Reveal>
        </div>
      </section>

      {/* --- faq --------------------------------------------------- */}
      <section id="faq" className="scroll-mt-16 border-t border-slate-800 px-5 py-24 sm:px-8">
        <div className="mx-auto grid max-w-6xl gap-10 lg:grid-cols-[0.8fr_1.4fr]">
          <SectionHeading
            eyebrow="FAQ"
            title="Questions people actually ask"
            body="Short answers, and honest ones. If yours is not here, the source is open."
          />

          <div className="divide-y divide-slate-800 rounded-2xl border border-slate-800 bg-slate-900/50 px-6">
            {FAQ.map((item, i) => (
              <Reveal key={item.q} delay={i * 50}>
                <details className="group py-5">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-[15px] font-medium">
                    {item.q}
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-slate-700 text-slate-400 transition-transform group-open:rotate-45">
                      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                        <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                      </svg>
                    </span>
                  </summary>
                  <p className="mt-3 text-sm leading-7 text-slate-400">{item.a}</p>
                </details>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* --- closing cta ------------------------------------------ */}
      <section className="px-5 pb-24 sm:px-8">
        <Reveal>
          <div className="aca-on-dark relative mx-auto max-w-6xl overflow-hidden rounded-3xl border border-blue-500/30 px-7 py-16 text-center sm:px-12 sm:py-20"
            style={{ background: 'linear-gradient(135deg, #1d4ed8 0%, #0f172a 55%, #020617 100%)' }}
          >
            <div className="aca-grid-lines pointer-events-none absolute inset-0 opacity-60 [mask-image:radial-gradient(ellipse_at_center,black,transparent_70%)]" />
            <div
              className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-cyan-400/15 blur-3xl"
              style={{ animation: 'aca-drift 20s ease-in-out infinite' }}
            />
            <h2 className="relative text-3xl font-semibold tracking-tight text-[#ffffff] sm:text-4xl">
              See your own numbers
            </h2>
            <p className="relative mx-auto mt-4 max-w-lg text-base leading-7 text-[#cbd5e1]">
              Sign in with your work account and connect a tenant. If you do not like what you
              see, disconnect it — nothing was changed.
            </p>
            <div className="relative mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <button
                onClick={signIn}
                className="group inline-flex items-center gap-2 rounded-xl bg-white px-7 py-3.5 text-sm font-semibold text-[#0f172a] transition hover:bg-slate-100"
              >
                Sign in with Microsoft
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </button>
              <a
                href="#security"
                className="inline-flex items-center justify-center rounded-xl border border-[#ffffff33] px-7 py-3.5 text-sm font-medium text-[#ffffff] transition hover:border-[#ffffff66]"
              >
                Read the security notes
              </a>
            </div>
          </div>
        </Reveal>
      </section>

      {/* --- footer ------------------------------------------------ */}
      <footer className="border-t border-slate-800 px-5 py-12 sm:px-8">
        <div className="mx-auto grid max-w-6xl gap-10 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div>
            <div className="flex items-center gap-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600 text-white">
                <Cloud className="h-4 w-4" />
              </span>
              <span className="text-xs font-bold tracking-wide">CLOUDLEDGER</span>
            </div>
            <p className="mt-4 max-w-xs text-sm leading-6 text-slate-500">
              Azure cost, estate and access — read live from your own account, with your own
              permissions.
            </p>
          </div>

          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Product</p>
            <ul className="mt-4 space-y-2.5 text-sm text-slate-400">
              {SECTIONS.map((s) => (
                <li key={s.key}>
                  <a href="#features" className="hover:text-white">{s.title}</a>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Learn</p>
            <ul className="mt-4 space-y-2.5 text-sm text-slate-400">
              {NAV_LINKS.slice(1).map((l) => (
                <li key={l.href}>
                  <a href={l.href} className="hover:text-white">{l.label}</a>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Open</p>
            <ul className="mt-4 space-y-2.5 text-sm text-slate-400">
              <li>
                <a
                  href="https://github.com/anuj7052/Azure-Cost-Analysis"
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-1.5 hover:text-white"
                >
                  <Code2 className="h-3.5 w-3.5" /> Source on GitHub
                </a>
              </li>
              <li>
                <button onClick={signIn} className="hover:text-white">Sign in</button>
              </li>
            </ul>
          </div>
        </div>
        <div className="mx-auto mt-10 flex max-w-6xl flex-col gap-2 border-t border-slate-800 pt-6 text-[11px] text-slate-600 sm:flex-row sm:items-center sm:justify-between">
          <p>Not affiliated with Microsoft. Azure and Microsoft Entra are trademarks of Microsoft Corporation.</p>
          <p>Figures shown in the app are read from your Azure account. This page contains no sample data.</p>
        </div>
      </footer>
    </div>
  );
}
