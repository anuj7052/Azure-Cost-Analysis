import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowRight, Check, Cloud, Code2, Database, FileCode, Lock,
  MessageCircle, Menu, ShieldCheck, Sparkles, X,
} from 'lucide-react';
import { SECTIONS } from '../nav';

/**
 * The public front door.
 *
 * Everything here is written from what the product actually does. The feature
 * grid is generated from SECTIONS — the same list the sidebar and the section
 * hubs are built from — so a page that is added, renamed or removed cannot
 * quietly leave a promise behind on the marketing page. That drift is the
 * normal failure of a landing page: it describes the product as it was on the
 * day someone wrote it.
 *
 * The product mock in the hero carries no figures. A hero image full of
 * invented spend would be the first thing a visitor sees and the first thing
 * that is untrue, and this app's whole claim is that it does not make numbers
 * up. Shapes convey "this is a cost tool" perfectly well without it.
 */

const NAV_LINKS = [
  { href: '#features', label: 'Features' },
  { href: '#how', label: 'How it works' },
  { href: '#assistants', label: 'Assistants' },
  { href: '#security', label: 'Security' },
  { href: '#faq', label: 'FAQ' },
];

const STEPS = [
  {
    title: 'Sign in with Microsoft',
    body:
      'No new password and no account to create. You sign in with the same work account you already use for Azure, through Microsoft Entra.',
  },
  {
    title: 'Connect a tenant',
    body:
      'Point the app at the Azure tenant you want to read. It uses your own delegated permissions, so it can never see more of Azure than you can.',
  },
  {
    title: 'Read your estate',
    body:
      'Cost, what is running, what changed and who can reach it — pulled live from Azure rather than from a copy that drifts.',
  },
];

const SECURITY = [
  {
    icon: Lock,
    title: 'Your permissions, not ours',
    body:
      'Every call to Azure is made with your own delegated token. If Azure would refuse you, it refuses the app. There is no service principal quietly holding more access than the person using it.',
  },
  {
    icon: ShieldCheck,
    title: 'Generation, never deployment',
    body:
      'The Deployment Assistant writes Terraform and Bicep for you to review and run. It holds no write credentials for your subscription, so nothing it produces can create or delete a resource on its own.',
  },
  {
    icon: Database,
    title: 'Uploads are not kept',
    body:
      'A BOQ spreadsheet travels with the request that parses it and is never written to disk. Text inside a cell is treated as data, never as an instruction.',
  },
  {
    icon: Sparkles,
    title: 'Bring your own model',
    body:
      'Point the assistants at your own OpenAI or Azure OpenAI endpoint and they run on your key, your quota and your data-handling agreement. Set a daily limit and they stop when it is reached.',
  },
];

const FAQ = [
  {
    q: 'Does it change anything in my Azure account?',
    a: 'No. Every screen reads. The only feature that produces infrastructure writes a template to a file for you to review and run yourself — the app never applies it.',
  },
  {
    q: 'What does it cost to run?',
    a: 'The app reads the Azure Cost Management and Resource Graph APIs, which Microsoft does not charge for. If you connect a model endpoint for the assistants, that is billed by your own provider against your own key.',
  },
  {
    q: 'Can I use it across more than one tenant?',
    a: 'Yes. Connect each tenant you have access to and switch between them from the top bar. Data from one is never mixed into another.',
  },
  {
    q: 'Where do the numbers come from?',
    a: 'From Azure, at the time you ask. Nothing is estimated or modelled. When a figure is genuinely unavailable the screen says so rather than showing a zero.',
  },
  {
    q: 'Can my colleagues use it?',
    a: 'You can invite people from your directory and choose what each of them is allowed to do. Roles are checked on the server, not just hidden in the menu.',
  },
];

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
  // Someone who has asked for less motion should get the finished state on the
  // very first paint, not a slower version of the animation — so this is the
  // initial state rather than something an effect corrects afterwards.
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

/**
 * An abstract stand-in for the dashboard.
 *
 * Deliberately unlabelled with figures — see the note at the top of the file.
 */
function ProductMock() {
  const bars = [38, 62, 45, 78, 55, 88, 70, 96, 64, 82, 58, 91];

  return (
    <div className="relative rounded-2xl border border-slate-800 bg-slate-900/80 p-4 shadow-2xl shadow-blue-950/40 backdrop-blur-xl sm:p-5">
      <div className="mb-4 flex items-center gap-2">
        <span className="h-2.5 w-2.5 rounded-full bg-rose-400/70" />
        <span className="h-2.5 w-2.5 rounded-full bg-amber-400/70" />
        <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/70" />
        <span className="ml-3 text-[11px] font-medium tracking-wide text-slate-500">
          Cost Explorer
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {['Compute', 'Storage', 'Network'].map((label, i) => (
          <div key={label} className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
            <p className="text-[11px] font-medium text-slate-500">{label}</p>
            <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-800">
              <div
                className="h-full rounded-full bg-gradient-to-r from-blue-500 to-cyan-400"
                style={{
                  width: `${[72, 48, 33][i]}%`,
                  animation: `acaGrow .9s cubic-bezier(.22,1,.36,1) ${200 + i * 120}ms both`,
                }}
              />
            </div>
          </div>
        ))}
      </div>

      <div className="mt-4 flex h-36 items-end gap-1.5 rounded-xl border border-slate-800 bg-slate-950/60 p-3 sm:h-44">
        {bars.map((h, i) => (
          <div
            key={i}
            className="flex-1 rounded-t bg-gradient-to-t from-blue-600/40 to-cyan-400/80"
            style={{
              height: `${h}%`,
              animation: `acaRise .8s cubic-bezier(.22,1,.36,1) ${i * 55}ms both`,
            }}
          />
        ))}
      </div>

      <div className="mt-4 flex items-center gap-2 rounded-xl border border-blue-500/20 bg-blue-500/5 p-3">
        <Sparkles className="h-4 w-4 shrink-0 text-blue-400" />
        <p className="text-[11px] leading-relaxed text-slate-400">
          Illustration only — this app shows figures read from your own Azure account, never sample data.
        </p>
      </div>
    </div>
  );
}

export default function Landing() {
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const signIn = () => navigate('/login');

  return (
    <div className="min-h-screen scroll-smooth bg-slate-950 text-white">
      <style>{`
        @keyframes acaRise { from { height: 0; opacity: 0 } }
        @keyframes acaGrow { from { width: 0 } }
        @keyframes acaFloat {
          0%, 100% { transform: translateY(0) }
          50% { transform: translateY(-14px) }
        }
        @keyframes acaDrift {
          0%, 100% { transform: translate3d(0,0,0) scale(1) }
          50% { transform: translate3d(24px,-18px,0) scale(1.08) }
        }
        @media (prefers-reduced-motion: reduce) {
          * { animation: none !important; transition: none !important; }
          html { scroll-behavior: auto; }
        }
      `}</style>

      {/* --- header ------------------------------------------------ */}
      <header
        className={`fixed inset-x-0 top-0 z-50 transition-colors duration-300 ${
          scrolled ? 'border-b border-slate-800/80 bg-slate-950/85 backdrop-blur-xl' : ''
        }`}
      >
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 sm:px-8">
          <a href="#top" className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-600">
              <Cloud className="h-4.5 w-4.5" />
            </span>
            <span className="text-sm font-bold tracking-wide">AZURE COST ANALYSIS</span>
          </a>

          <nav className="hidden items-center gap-7 lg:flex">
            {NAV_LINKS.map((l) => (
              <a
                key={l.href}
                href={l.href}
                className="text-sm text-slate-400 transition-colors hover:text-white"
              >
                {l.label}
              </a>
            ))}
          </nav>

          <div className="flex items-center gap-2">
            <button
              onClick={signIn}
              className="hidden rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold transition hover:bg-blue-500 sm:block"
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
          <div className="border-t border-slate-800 bg-slate-950/95 px-5 py-4 backdrop-blur-xl lg:hidden">
            {NAV_LINKS.map((l) => (
              <a
                key={l.href}
                href={l.href}
                onClick={() => setMenuOpen(false)}
                className="block py-2.5 text-sm text-slate-300"
              >
                {l.label}
              </a>
            ))}
            <button
              onClick={signIn}
              className="mt-3 w-full rounded-xl bg-blue-600 py-2.5 text-sm font-semibold"
            >
              Sign in
            </button>
          </div>
        )}
      </header>

      {/* --- hero -------------------------------------------------- */}
      <section id="top" className="relative overflow-hidden px-5 pb-20 pt-28 sm:px-8 sm:pt-36">
        <div
          className="pointer-events-none absolute -left-40 -top-40 h-[34rem] w-[34rem] rounded-full bg-blue-600/20 blur-3xl"
          style={{ animation: 'acaDrift 18s ease-in-out infinite' }}
        />
        <div
          className="pointer-events-none absolute -right-32 top-32 h-[28rem] w-[28rem] rounded-full bg-cyan-400/10 blur-3xl"
          style={{ animation: 'acaDrift 22s ease-in-out infinite reverse' }}
        />

        <div className="relative mx-auto grid max-w-6xl items-center gap-14 lg:grid-cols-[1.05fr_0.95fr]">
          <Reveal>
            <span className="inline-flex items-center gap-2 rounded-full border border-blue-500/30 bg-blue-500/10 px-3.5 py-1.5 text-xs font-medium text-blue-300">
              <ShieldCheck className="h-3.5 w-3.5" />
              Read-only by default · Microsoft Entra sign-in
            </span>

            <h1 className="mt-6 text-4xl font-semibold leading-[1.08] tracking-tight sm:text-5xl lg:text-6xl">
              Know what Azure is costing you,
              <span className="bg-gradient-to-r from-blue-400 to-cyan-300 bg-clip-text text-transparent">
                {' '}and why it moved.
              </span>
            </h1>

            <p className="mt-6 max-w-xl text-base leading-7 text-slate-400">
              Cost, running resources, changes and access across every Azure tenant you can
              reach — read live from your own account with your own permissions. Nothing is
              estimated, and nothing is written back.
            </p>

            <div className="mt-9 flex flex-col gap-3 sm:flex-row">
              <button
                onClick={signIn}
                className="group inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-6 py-3.5 text-sm font-semibold transition hover:bg-blue-500"
              >
                Sign in with Microsoft
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </button>
              <a
                href="#features"
                className="inline-flex items-center justify-center rounded-xl border border-slate-700 px-6 py-3.5 text-sm font-medium text-slate-300 transition hover:border-slate-600 hover:text-white"
              >
                See what it does
              </a>
            </div>

            <p className="mt-5 text-xs text-slate-500">
              Uses the work account you already have. No new password, no credit card, no agent to install.
            </p>
          </Reveal>

          <Reveal delay={140}>
            <div style={{ animation: 'acaFloat 7s ease-in-out infinite' }}>
              <ProductMock />
            </div>
          </Reveal>
        </div>
      </section>

      {/* --- features --------------------------------------------- */}
      <section id="features" className="border-t border-slate-900 scroll-mt-16 px-5 py-24 sm:px-8">
        <div className="mx-auto max-w-6xl">
          <Reveal>
            <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">
              Four questions, answered properly
            </h2>
            <p className="mt-4 max-w-2xl text-base leading-7 text-slate-400">
              Every page below exists to answer one question. This list is generated from the
              application's own navigation, so it describes the product as it is today.
            </p>
          </Reveal>

          <div className="mt-14 space-y-16">
            {SECTIONS.map((section, si) => (
              <Reveal key={section.key} delay={si * 60}>
                <div className="flex items-center gap-3">
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-blue-500/25 bg-blue-500/10 text-blue-300">
                    <section.icon className="h-5 w-5" />
                  </span>
                  <div>
                    <h3 className="text-lg font-semibold">{section.title}</h3>
                    <p className="text-sm text-slate-500">{section.tagline}</p>
                  </div>
                </div>

                <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {section.items
                    .filter((item) => !item.overview)
                    .map((item) => (
                      <div
                        key={item.to}
                        className="group rounded-2xl border border-slate-800 bg-slate-900/40 p-5 transition-colors hover:border-slate-700 hover:bg-slate-900/70"
                      >
                        <item.icon className="h-5 w-5 text-slate-500 transition-colors group-hover:text-blue-400" />
                        <p className="mt-3.5 text-sm font-semibold">{item.label}</p>
                        <p className="mt-1.5 text-[13px] leading-6 text-slate-400">{item.blurb}</p>
                      </div>
                    ))}
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* --- how it works ----------------------------------------- */}
      <section id="how" className="border-t border-slate-900 scroll-mt-16 px-5 py-24 sm:px-8">
        <div className="mx-auto max-w-6xl">
          <Reveal>
            <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">
              Running in about a minute
            </h2>
            <p className="mt-4 max-w-2xl text-base leading-7 text-slate-400">
              There is nothing to deploy and no agent to install. The app reads Azure's own APIs
              on your behalf.
            </p>
          </Reveal>

          <div className="mt-14 grid gap-5 md:grid-cols-3">
            {STEPS.map((step, i) => (
              <Reveal key={step.title} delay={i * 90}>
                <div className="h-full rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-600/15 text-sm font-bold text-blue-300">
                    {i + 1}
                  </span>
                  <p className="mt-5 text-base font-semibold">{step.title}</p>
                  <p className="mt-2.5 text-sm leading-6 text-slate-400">{step.body}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* --- assistants ------------------------------------------- */}
      <section id="assistants" className="border-t border-slate-900 scroll-mt-16 px-5 py-24 sm:px-8">
        <div className="mx-auto max-w-6xl">
          <Reveal>
            <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">
              Two assistants, kept apart on purpose
            </h2>
            <p className="mt-4 max-w-2xl text-base leading-7 text-slate-400">
              Asking a question and building infrastructure are different acts with different
              consequences, so they are different tools. The one that could spend money is
              deliberately harder to reach than the one that reads.
            </p>
          </Reveal>

          <div className="mt-12 grid gap-5 lg:grid-cols-2">
            <Reveal>
              <div className="h-full rounded-2xl border border-slate-800 bg-slate-900/40 p-7">
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
              </div>
            </Reveal>

            <Reveal delay={90}>
              <div className="h-full rounded-2xl border border-slate-800 bg-slate-900/40 p-7">
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
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* --- security --------------------------------------------- */}
      <section id="security" className="border-t border-slate-900 scroll-mt-16 px-5 py-24 sm:px-8">
        <div className="mx-auto max-w-6xl">
          <Reveal>
            <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">
              What it can and cannot do
            </h2>
            <p className="mt-4 max-w-2xl text-base leading-7 text-slate-400">
              Worth reading before you connect a tenant. These are constraints in the code, not
              promises in a policy.
            </p>
          </Reveal>

          <div className="mt-12 grid gap-5 md:grid-cols-2">
            {SECURITY.map((s, i) => (
              <Reveal key={s.title} delay={i * 70}>
                <div className="h-full rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-300">
                    <s.icon className="h-5 w-5" />
                  </span>
                  <p className="mt-5 text-base font-semibold">{s.title}</p>
                  <p className="mt-2.5 text-sm leading-6 text-slate-400">{s.body}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* --- faq --------------------------------------------------- */}
      <section id="faq" className="border-t border-slate-900 scroll-mt-16 px-5 py-24 sm:px-8">
        <div className="mx-auto max-w-3xl">
          <Reveal>
            <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">
              Questions people actually ask
            </h2>
          </Reveal>

          <div className="mt-10 divide-y divide-slate-800 border-y border-slate-800">
            {FAQ.map((item, i) => (
              <Reveal key={item.q} delay={i * 50}>
                <details className="group py-5">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-[15px] font-medium">
                    {item.q}
                    <span className="shrink-0 text-slate-500 transition-transform group-open:rotate-45">
                      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
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
          <div className="relative mx-auto max-w-6xl overflow-hidden rounded-3xl border border-blue-500/20 bg-gradient-to-br from-blue-600/15 via-slate-900 to-slate-900 px-7 py-16 text-center sm:px-12">
            <div
              className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-cyan-400/10 blur-3xl"
              style={{ animation: 'acaDrift 20s ease-in-out infinite' }}
            />
            <h2 className="relative text-3xl font-semibold tracking-tight sm:text-4xl">
              See your own numbers
            </h2>
            <p className="relative mx-auto mt-4 max-w-lg text-base leading-7 text-slate-400">
              Sign in with your work account and connect a tenant. If you do not like what you
              see, disconnect it — nothing was changed.
            </p>
            <button
              onClick={signIn}
              className="group relative mt-9 inline-flex items-center gap-2 rounded-xl bg-blue-600 px-7 py-3.5 text-sm font-semibold transition hover:bg-blue-500"
            >
              Sign in with Microsoft
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </button>
          </div>
        </Reveal>
      </section>

      {/* --- footer ------------------------------------------------ */}
      <footer className="border-t border-slate-900 px-5 py-10 sm:px-8">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-5 sm:flex-row">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600">
              <Cloud className="h-4 w-4" />
            </span>
            <span className="text-xs font-bold tracking-wide text-slate-400">
              AZURE COST ANALYSIS
            </span>
          </div>

          <div className="flex items-center gap-6 text-xs text-slate-500">
            {NAV_LINKS.map((l) => (
              <a key={l.href} href={l.href} className="transition-colors hover:text-slate-300">
                {l.label}
              </a>
            ))}
            <a
              href="https://github.com/anuj7052/Azure-Cost-Analysis"
              target="_blank"
              rel="noreferrer noopener"
              className="flex items-center gap-1.5 transition-colors hover:text-slate-300"
            >
              <Code2 className="h-3.5 w-3.5" />
              Source
            </a>
          </div>
        </div>
        <p className="mx-auto mt-6 max-w-6xl text-center text-[11px] text-slate-600 sm:text-left">
          Not affiliated with Microsoft. Azure and Microsoft Entra are trademarks of Microsoft Corporation.
        </p>
      </footer>
    </div>
  );
}
