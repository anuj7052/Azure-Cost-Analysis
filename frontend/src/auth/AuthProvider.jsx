import { MsalProvider, useMsal, useIsAuthenticated } from '@azure/msal-react';
import { InteractionStatus } from '@azure/msal-browser';
import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, Building2, CheckCircle2, Cloud, Moon, ShieldCheck, Sun } from 'lucide-react';
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
    <div className="aca-motion relative min-h-screen overflow-hidden bg-slate-950 px-6 py-8 text-white sm:px-10">
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
        className="absolute left-5 top-5 z-10 inline-flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-900/70 px-3.5 py-2 text-xs font-medium text-slate-400 backdrop-blur transition-colors hover:text-slate-200"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back
      </a>

      <button
        onClick={toggleTheme}
        aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        className="absolute right-5 top-5 z-10 flex h-10 w-10 items-center justify-center rounded-xl border border-slate-800 bg-slate-900/70 text-slate-300 backdrop-blur transition-colors hover:bg-slate-800"
      >
        {theme === 'dark' ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
      </button>

      <div className="relative mx-auto flex min-h-[calc(100vh-4rem)] w-full max-w-5xl items-center justify-center">
        <div
          className="grid w-full overflow-hidden rounded-[2rem] border border-slate-800 bg-slate-900/75 elevated-xl backdrop-blur-xl lg:grid-cols-[1.05fr_0.95fr]"
          style={{ animation: 'aca-enter .7s cubic-bezier(.22,1,.36,1) both' }}
        >
          <div className="hidden flex-col justify-between bg-gradient-to-br from-blue-600 via-blue-700 to-indigo-900 p-10 lg:flex">
            <div>
              <div className="mb-16 flex items-center gap-3 text-sm font-semibold tracking-wide text-blue-100">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/15"><Cloud className="h-5 w-5" /></span>
                CLOUDLEDGER
              </div>
              <p className="mb-4 max-w-md text-4xl font-semibold leading-tight tracking-tight">Bring every cloud decision into focus.</p>
              <p className="max-w-sm text-sm leading-6 text-blue-100/80">Understand spend, spot anomalies, and move faster across every Azure tenant.</p>
            </div>
            <div className="space-y-4 text-sm text-blue-100/90">
              {['Multi-tenant visibility', 'Intelligent cost insights', 'Secure Microsoft sign-in'].map((t, i) => (
                <p
                  key={t}
                  className="flex items-center gap-3"
                  style={{ animation: `aca-enter .6s cubic-bezier(.22,1,.36,1) ${260 + i * 110}ms both` }}
                >
                  <CheckCircle2 className="h-4 w-4" /> {t}
                </p>
              ))}
            </div>
          </div>

          <div className="w-full p-7 sm:p-12">
            <div className="mb-8 flex items-center gap-3 lg:hidden">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-blue-600"><Cloud className="h-5 w-5" /></div>
              <span className="text-sm font-bold tracking-wide">CLOUDLEDGER</span>
            </div>
            <div className="mb-8">
              <p className="mb-3 text-sm font-medium text-blue-400">Welcome back</p>
              <h1 className="mb-3 text-3xl font-semibold tracking-tight">Sign in to your workspace</h1>
              <p className="text-sm leading-6 text-slate-400">Choose the Microsoft Entra tenant you want to access.</p>
            </div>

            <form onSubmit={submit}>
              <label htmlFor="tenant" className="mb-2 block text-sm font-medium text-slate-200">Email or tenant</label>
              <div className="relative mb-5">
                <Building2 className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-500" />
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
              <p className="mb-7 flex items-start gap-2 text-xs leading-5 text-slate-500"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />Enter your work email to sign in as that account, or leave blank to choose from your signed-in accounts.</p>
              <button type="submit" className="group flex h-14 w-full items-center justify-center gap-3 rounded-xl bg-blue-600 font-semibold text-white shadow-lg shadow-blue-950/40 transition hover:bg-blue-500">
                Continue with Microsoft <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
              </button>
            </form>
            <div className="my-7 flex items-center gap-3 text-xs text-slate-600">
              <span className="h-px flex-1 bg-slate-800" />
              <span>New to the workspace?</span>
              <span className="h-px flex-1 bg-slate-800" />
            </div>
            <button
              type="button"
              onClick={register}
              className="flex h-12 w-full items-center justify-center rounded-xl border border-slate-700 bg-slate-800/50 text-sm font-semibold text-slate-200 transition hover:border-blue-500/60 hover:bg-slate-800"
            >
              Register your tenant
            </button>
            <p className="mt-3 text-center text-xs leading-5 text-slate-500">Sign in first, then add your Service Principal credentials and subscriptions.</p>
            <p className="mt-6 text-center text-xs text-slate-500">Your organization credentials are handled securely by Microsoft.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
