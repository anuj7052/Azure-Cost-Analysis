import { MsalProvider, useMsal, useIsAuthenticated } from '@azure/msal-react';
import { InteractionStatus } from '@azure/msal-browser';
import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, Building2, CheckCircle2, Cloud, Lock, Moon, ShieldCheck, Sun } from 'lucide-react';
import { msalInstance, loginRequest, managementRequest } from './msalConfig';
import { useTheme } from '../store/useTheme';

export function AuthProvider({ children }) {
  return <MsalProvider instance={msalInstance}>{children}</MsalProvider>;
}

export function useLogin() {
  const { instance } = useMsal();
  /**
   * Always ask Microsoft which account to use.
   *
   * Without `select_account`, Microsoft silently reuses whichever account the
   * browser session already holds, so a shared machine — or anyone with more
   * than one work account — has no way to sign in as somebody else. The chooser
   * costs one extra click and is skipped automatically when only one account is
   * signed in, so nothing is lost by asking.
   *
   * `loginHint` is the exception: when the user has already told us which
   * address they want, sending them to the chooser to repeat themselves is
   * pointless, so that account is targeted directly.
   */
  const login = (tenant = '', { prompt, loginHint } = {}) => {
    const value = tenant.trim();
    // A tenant field holding an email identifies an account, not a directory.
    // Microsoft resolves the directory from the address itself, so the
    // authority stays multi-tenant and the address becomes the hint.
    const isEmail = value.includes('@');
    const hint = loginHint || (isEmail ? value : '');
    const authorityTenant = (!isEmail && value)
      || import.meta.env.VITE_AZURE_TENANT_ID
      || 'organizations';

    instance.loginRedirect({
      ...loginRequest,
      authority: `https://login.microsoftonline.com/${authorityTenant}`,
      ...(hint ? { loginHint: hint } : { prompt: prompt || 'select_account' }),
      ...(prompt ? { prompt } : {}),
    });
  };

  /**
   * Clear this app's cached tokens before handing off to Microsoft.
   *
   * `logoutRedirect` alone ends the Microsoft session but can leave MSAL's
   * local account entry behind, which is what makes the next visit log the
   * previous person straight back in.
   */
  const logout = () => {
    instance.clearCache();
    instance.logoutRedirect();
  };

  return { login, logout };
}

export function useAccessToken() {
  const { instance, accounts } = useMsal();

  const getToken = async () => {
    const account = instance.getActiveAccount() || accounts[0];
    if (!account) throw new Error('No authenticated account');
    try {
      const result = await instance.acquireTokenSilent({ ...managementRequest, account });
      return result.accessToken;
    } catch {
      await instance.acquireTokenRedirect({ ...managementRequest, account });
      return null;
    }
  };

  return { getToken, account: instance.getActiveAccount() || accounts[0] || null };
}

export function RequireAuth({ children, signedOut }) {
  const isAuthenticated = useIsAuthenticated();
  const { inProgress, instance } = useMsal();
  const [timedOut, setTimedOut] = useState(false);

  const isLoading =
    !timedOut && (
      inProgress === InteractionStatus.HandleRedirect ||
      inProgress === InteractionStatus.Login
    );

  // Safety timeout — if MSAL is stuck loading for >6s, clear state and show login
  useEffect(() => {
    if (!isLoading) { setTimedOut(false); return; }
    const t = setTimeout(() => {
      instance.clearCache();
      setTimedOut(true);
    }, 6000);
    return () => clearTimeout(t);
  }, [isLoading, instance]);

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-950">
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        <div className="text-center">
          <div
            className="w-10 h-10 rounded-full mx-auto mb-4 border-[3px] border-blue-500"
            style={{ borderTopColor: 'transparent', animation: 'spin 0.8s linear infinite' }}
          />
          <p className="text-slate-400 text-sm">Signing you in…</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    // The sign-out view is passed in rather than fixed here, because what an
    // anonymous visitor should see is a product decision (a landing page, a
    // sign-in form) and this module's job is only to know whether they are
    // signed in. Defaulting to the form keeps every existing caller working.
    return signedOut ?? <LoginScreen />;
  }

  return children;
}

/** Microsoft's own mark, so the button looks like the thing it actually does. */
function MicrosoftMark({ className = 'h-4 w-4' }) {
  return (
    <svg viewBox="0 0 20 20" className={className} aria-hidden="true">
      <rect x="0" y="0" width="9" height="9" fill="#F25022" />
      <rect x="11" y="0" width="9" height="9" fill="#7FBA00" />
      <rect x="0" y="11" width="9" height="9" fill="#00A4EF" />
      <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
    </svg>
  );
}

/**
 * The left half of the sign-in card.
 *
 * A ledger, drawn rather than described: ruled lines, rows that settle into
 * place, and a light that passes over them once. The rows carry no figures —
 * this screen belongs to a product whose argument is that it does not invent
 * numbers, and a decorative one here would be the first thing a visitor sees
 * and the first thing that is untrue.
 */
function LedgerArt() {
  const rows = [
    { w: '68%', accent: 'from-sky-400 to-cyan-300' },
    { w: '46%', accent: 'from-blue-400 to-sky-300' },
    { w: '81%', accent: 'from-indigo-400 to-blue-300' },
    { w: '34%', accent: 'from-cyan-400 to-teal-300' },
    { w: '59%', accent: 'from-sky-400 to-blue-300' },
  ];

  return (
    <div className="relative mt-12 select-none" aria-hidden="true">
      <div className="space-y-3.5">
        {rows.map((row, i) => (
          <div
            key={i}
            className="flex items-center gap-3"
            style={{ animation: `aca-enter .7s cubic-bezier(.22,1,.36,1) ${380 + i * 110}ms both` }}
          >
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-white/40" />
            <span className="h-2 flex-1 overflow-hidden rounded-full bg-white/10">
              <span
                className={`block h-full rounded-full bg-gradient-to-r ${row.accent}`}
                style={{
                  width: row.w,
                  animation: `aca-grow 1s cubic-bezier(.22,1,.36,1) ${520 + i * 110}ms both`,
                }}
              />
            </span>
          </div>
        ))}
      </div>

      {/* One pass of light across the rows — enough to feel alive, not enough
          to compete with the sign-in form for attention. */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div
          className="h-full w-1/3 bg-gradient-to-r from-transparent via-white/12 to-transparent"
          style={{ animation: 'aca-sweep 4.5s ease-in-out 1.4s infinite' }}
        />
      </div>
    </div>
  );
}

export function LoginScreen() {
  const { login } = useLogin();
  const { instance } = useMsal();
  const theme = useTheme(s => s.theme);
  const toggleTheme = useTheme(s => s.toggleTheme);
  const [tenant, setTenant] = useState(() => localStorage.getItem('azure-login-tenant') || '');

  const submit = (event) => {
    event.preventDefault();
    localStorage.setItem('azure-login-tenant', tenant.trim());
    login(tenant);
  };

  /**
   * Registering is a different intent to signing in: the person is here to
   * onboard an account, which is very often not the one already cached in the
   * browser. Clearing the local cache and asking Microsoft for the account
   * chooser stops a stale session from silently logging the previous user in.
   */
  const register = () => {
    localStorage.setItem('azure-login-tenant', tenant.trim());
    instance.clearCache();
    login(tenant, { prompt: 'select_account' });
  };

  return (
    <div className="aca-motion relative min-h-screen overflow-hidden bg-slate-950 px-4 py-6 text-white sm:px-10 sm:py-8">
      <div
        className="pointer-events-none absolute -left-32 -top-40 h-[32rem] w-[32rem] rounded-full bg-blue-600/20 blur-3xl"
        style={{ animation: 'aca-drift 18s ease-in-out infinite' }}
      />
      <div
        className="pointer-events-none absolute -bottom-48 -right-20 h-[30rem] w-[30rem] rounded-full bg-cyan-400/10 blur-3xl"
        style={{ animation: 'aca-drift 22s ease-in-out infinite reverse' }}
      />

      {/* Somebody who arrived here by mistake, or who wants to know what this
          is before handing over an account, needs a way back that is not the
          browser button. */}
      <a
        href="/"
        className="absolute left-4 top-4 z-10 inline-flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-900/70 px-3.5 py-2 text-xs font-medium text-slate-400 backdrop-blur transition-colors hover:text-slate-200 sm:left-5 sm:top-5"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back
      </a>

      <button
        onClick={toggleTheme}
        aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        className="absolute right-4 top-4 z-10 flex h-10 w-10 items-center justify-center rounded-xl border border-slate-800 bg-slate-900/70 text-slate-300 backdrop-blur transition-colors hover:bg-slate-800 sm:right-5 sm:top-5"
      >
        {theme === 'dark' ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
      </button>

      <div className="relative mx-auto flex min-h-[calc(100vh-3rem)] w-full max-w-5xl items-center justify-center">
        <div
          className="grid w-full overflow-hidden rounded-[1.75rem] border border-slate-800 bg-slate-900/80 elevated-xl backdrop-blur-xl sm:rounded-[2rem] lg:grid-cols-[1.05fr_0.95fr]"
          style={{ animation: 'aca-enter .7s cubic-bezier(.22,1,.36,1) both' }}
        >
          {/* --- brand half ------------------------------------------- */}
          <div className="aca-on-dark relative hidden flex-col justify-between overflow-hidden bg-[#0b1220] p-10 text-white lg:flex">
            <div
              className="pointer-events-none absolute -inset-1/2 opacity-70"
              style={{
                background:
                  'conic-gradient(from 180deg at 50% 50%, #1d4ed8 0deg, #0e7490 110deg, #4338ca 220deg, #1d4ed8 360deg)',
                filter: 'blur(72px)',
                animation: 'aca-aurora 26s linear infinite',
              }}
            />
            <div className="aca-grid-lines pointer-events-none absolute inset-0 opacity-40" />
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-[#0b1220] via-[#0b1220]/55 to-transparent" />

            <div className="relative">
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/10 ring-1 ring-white/20 backdrop-blur">
                  <Cloud className="h-5 w-5" />
                </span>
                <span className="text-sm font-bold tracking-[0.18em] text-white/90">CLOUDLEDGER</span>
              </div>

              <p className="mt-14 max-w-md text-[2.6rem] font-semibold leading-[1.06] tracking-tight">
                Every Azure charge,
                <br />
                accounted for.
              </p>
              <p className="mt-5 max-w-sm text-sm leading-6 text-white/60">
                Cost, running resources, changes and access — read from your own account, with
                your own permissions, at the moment you ask.
              </p>

              <LedgerArt />
            </div>

            <div className="relative mt-12 space-y-3.5 text-[13px] text-white/70">
              {[
                'Read-only — nothing is written back',
                'Your delegated permissions, never more',
                'Figures come from Azure, or the screen says so',
              ].map((t, i) => (
                <p
                  key={t}
                  className="flex items-center gap-3"
                  style={{ animation: `aca-enter .6s cubic-bezier(.22,1,.36,1) ${900 + i * 110}ms both` }}
                >
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-cyan-300" /> {t}
                </p>
              ))}
            </div>
          </div>

          {/* --- form half -------------------------------------------- */}
          <div className="w-full p-6 sm:p-12">
            <div className="mb-8 flex items-center gap-3 lg:hidden">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-blue-600">
                <Cloud className="h-5 w-5" />
              </div>
              <span className="text-sm font-bold tracking-[0.18em]">CLOUDLEDGER</span>
            </div>

            <div className="mb-8">
              <span className="inline-flex items-center gap-2 rounded-full border border-blue-500/25 bg-blue-500/10 px-3 py-1 text-[11px] font-medium tracking-wide text-blue-300">
                <ShieldCheck className="h-3.5 w-3.5" />
                Microsoft Entra single sign-on
              </span>
              <h1 className="mt-5 text-[1.75rem] font-semibold tracking-tight sm:text-3xl">
                Sign in to your workspace
              </h1>
              <p className="mt-2.5 text-sm leading-6 text-slate-400">
                Use the work account you already have. There is no separate password to remember.
              </p>
            </div>

            <form onSubmit={submit}>
              <label htmlFor="tenant" className="mb-2 block text-[13px] font-medium text-slate-300">
                Work email or tenant
                <span className="ml-1.5 font-normal text-slate-500">· optional</span>
              </label>
              <div className="group relative mb-3">
                <Building2 className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-500 transition-colors group-focus-within:text-blue-400" />
                <input
                  id="tenant"
                  type="text"
                  value={tenant}
                  onChange={(event) => setTenant(event.target.value)}
                  placeholder="you@company.com"
                  autoComplete="username"
                  className="h-14 w-full rounded-xl border border-slate-700 bg-slate-950/60 pl-12 pr-4 text-sm text-white outline-none transition focus:border-blue-500 focus:ring-4 focus:ring-blue-500/15"
                />
              </div>
              <p className="mb-7 text-xs leading-5 text-slate-500">
                Leave it blank to pick from the accounts you are already signed in to.
              </p>

              <button
                type="submit"
                className="group flex h-14 w-full items-center justify-center gap-3 rounded-xl bg-blue-600 font-semibold text-white elevated-lg transition hover:bg-blue-500"
              >
                <span className="flex h-5 w-5 items-center justify-center rounded bg-white/95">
                  <MicrosoftMark className="h-3.5 w-3.5" />
                </span>
                Continue with Microsoft
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
              </button>
            </form>

            <div className="my-7 flex items-center gap-3 text-xs text-slate-500">
              <span className="h-px flex-1 bg-slate-800" />
              <span>New to Cloudledger?</span>
              <span className="h-px flex-1 bg-slate-800" />
            </div>

            <button
              type="button"
              onClick={register}
              className="flex h-12 w-full items-center justify-center rounded-xl border border-slate-700 bg-slate-800/50 text-sm font-semibold text-slate-200 transition hover:border-blue-500/60 hover:bg-slate-800"
            >
              Register your tenant
            </button>
            <p className="mt-3 text-center text-xs leading-5 text-slate-500">
              Sign in first, then connect the tenant you want to read.
            </p>

            <p className="mt-8 flex items-center justify-center gap-2 text-xs text-slate-500">
              <Lock className="h-3.5 w-3.5" />
              Your credentials go to Microsoft, never to us.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
