import { MsalProvider, useMsal, useIsAuthenticated } from '@azure/msal-react';
import { InteractionStatus } from '@azure/msal-browser';
import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, CheckCircle2, ChevronDown, Cloud, Lock, Moon, ShieldCheck, Sun } from 'lucide-react';
import { msalInstance, loginRequest, managementRequest } from './msalConfig';
import { endMySession } from '../api/client';
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
  const logout = async () => {
    // Close the session record first, while the token is still valid. After
    // `clearCache` there is nothing left to authenticate with, so the sign-out
    // time would never be recorded and every session would read as still open.
    //
    // A failure here is swallowed on purpose: nobody should be held inside an
    // app because a bookkeeping write did not land. The session simply stays
    // open, which is the honest outcome and is what `last_seen_at` is for.
    try {
      await endMySession();
    } catch {
      /* Sign out regardless. */
    }
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
  const { inProgress } = useMsal();
  const [timedOut, setTimedOut] = useState(false);

  const waiting =
    inProgress === InteractionStatus.HandleRedirect ||
    inProgress === InteractionStatus.Login;

  const isLoading = waiting && !timedOut;

  /**
   * Stop waiting on MSAL, without throwing the sign-in away.
   *
   * This used to call `instance.clearCache()`, which deletes the cached
   * account and every token with it. That turned "MSAL is taking a while" into
   * "you are now signed out": the account disappeared, `useIsAuthenticated`
   * went false, and the user was returned to the sign-in screen having done
   * nothing wrong. A slow network was enough to trigger it, and the damage was
   * permanent even when MSAL would have finished a moment later.
   *
   * Giving up on the spinner is a display decision and nothing more. If MSAL
   * does resolve, `isAuthenticated` turns true and the app appears; if it does
   * not, the sign-in screen shows anyway. Neither outcome needs credentials
   * destroyed to reach it. The wait is also longer now, because eight seconds
   * of redirect handling is unusual but not wrong.
   */
  useEffect(() => {
    if (!waiting) return undefined;
    const t = setTimeout(() => setTimedOut(true), 8000);
    // Reset on the way out rather than on the way in. Doing it in the effect
    // body would set state during render and cascade; the cleanup already runs
    // at exactly the moment the wait ends, which is when the flag stops being
    // true of anything.
    return () => { clearTimeout(t); setTimedOut(false); };
  }, [waiting]);

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
 * The assurances this screen used to shout.
 *
 * They are the reason a cautious person is willing to hand over a work
 * account, so they cannot be deleted -- but they are also not what anyone came
 * here to read. Someone arriving at a sign-in screen has already decided to
 * sign in; the claims matter to the minority who have not, and to them they
 * matter a great deal.
 */
const ASSURANCES = [
  {
    title: 'Read-only',
    body: 'Every screen reads. Nothing is written back to your subscription, and the app holds no credential that could.',
  },
  {
    title: 'Your permissions, never more',
    body: 'Calls to Azure carry your own delegated token. If Azure would refuse you, it refuses the app.',
  },
  {
    title: 'Figures come from Azure',
    body: 'Nothing is estimated or modelled. When a number is genuinely unavailable the screen says so rather than showing a zero.',
  },
  {
    title: 'Microsoft holds the password',
    body: 'Your credentials go to Microsoft Entra. This app never sees them and has no password of its own to store or leak.',
  },
];

export function LoginScreen() {
  const { login } = useLogin();
  const { instance } = useMsal();
  const theme = useTheme(s => s.theme);
  const toggleTheme = useTheme(s => s.toggleTheme);

  /**
   * The detail is a disclosure, not a panel of the page.
   *
   * This screen used to be a two-column wall: a headline, a paragraph of
   * positioning, an animation and four claims, with the one button anybody
   * needed sharing space with all of it. On a laptop the button sat below the
   * fold of the card on smaller viewports, and on a phone the entire left half
   * was hidden anyway -- which is the honest admission that it was never
   * load-bearing.
   *
   * Collapsed by default because the common case is a returning user who wants
   * one click. Available in one click because the uncommon case -- somebody
   * deciding whether to trust this with a work account -- is the one where
   * being vague would cost us the account entirely.
   */
  const [showDetail, setShowDetail] = useState(false);

  /**
   * There is no email or tenant box here on purpose.
   *
   * Whatever someone types into it, Microsoft asks them again on the next
   * screen -- so the field only ever added a step, and a chance to mistype a
   * directory name and land on an error they cannot read. `login('')` falls
   * through to the multi-tenant authority with the account chooser, which is
   * the same outcome the field was trying to produce.
   */
  const signIn = () => login('');

  /**
   * Registering is a different intent to signing in: the person is here to
   * onboard an account, which is very often not the one already cached in the
   * browser. Clearing the local cache and asking Microsoft for the account
   * chooser stops a stale session from silently logging the previous user in.
   */
  const register = () => {
    instance.clearCache();
    login('', { prompt: 'select_account' });
  };

  return (
    <div className="aca-motion relative flex min-h-screen flex-col bg-slate-950 px-4 py-5 text-white sm:px-6">
      <div
        className="pointer-events-none absolute -left-32 -top-40 h-[32rem] w-[32rem] rounded-full bg-blue-600/20 blur-3xl"
        style={{ animation: 'aca-drift 18s ease-in-out infinite' }}
      />
      <div
        className="pointer-events-none absolute -bottom-48 -right-20 h-[30rem] w-[30rem] rounded-full bg-cyan-400/10 blur-3xl"
        style={{ animation: 'aca-drift 22s ease-in-out infinite reverse' }}
      />

      <div className="relative z-10 flex items-center justify-between">
        {/* Somebody who arrived here by mistake, or who wants to know what this
            is before handing over an account, needs a way back that is not the
            browser button. */}
        <a
          href="/"
          className="inline-flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-900/70 px-3.5 py-2 text-xs font-medium text-slate-400 backdrop-blur transition-colors hover:text-slate-200"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back
        </a>

        <button
          onClick={toggleTheme}
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          className="flex h-10 w-10 items-center justify-center rounded-xl border border-slate-800 bg-slate-900/70 text-slate-300 backdrop-blur transition-colors hover:bg-slate-800"
        >
          {theme === 'dark' ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
        </button>
      </div>

      <div className="relative z-10 flex flex-1 items-center justify-center py-8">
        <div
          className="w-full max-w-[26rem]"
          style={{ animation: 'aca-enter .6s cubic-bezier(.22,1,.36,1) both' }}
        >
          <div className="rounded-3xl border border-slate-800 bg-slate-900/80 p-7 elevated-xl backdrop-blur-xl sm:p-9">
            <div className="flex items-center gap-3">
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-blue-600">
                <Cloud className="h-5 w-5" />
              </span>
              <span className="text-sm font-bold tracking-[0.18em]">CLOUDLEDGER</span>
            </div>

            <h1 className="mt-7 text-2xl font-semibold tracking-tight">
              Sign in to your workspace
            </h1>
            <p className="mt-2 text-sm leading-6 text-slate-400">
              Use the work account you already have. Microsoft will ask which one.
            </p>

            <button
              type="button"
              onClick={signIn}
              className="group mt-7 flex h-14 w-full items-center justify-center gap-3 rounded-xl bg-blue-600 font-semibold text-white elevated-lg transition hover:bg-blue-500"
            >
              <span className="flex h-5 w-5 items-center justify-center rounded bg-white/95">
                <MicrosoftMark className="h-3.5 w-3.5" />
              </span>
              Continue with Microsoft
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
            </button>

            <div className="my-6 flex items-center gap-3 text-xs text-slate-500">
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
            <p className="mt-2.5 text-center text-xs leading-5 text-slate-500">
              Sign in first, then connect the tenant you want to read.
            </p>
          </div>

          {/* Outside the card, so opening it reads as extra reading rather than
              as the sign-in form having grown a section. */}
          <button
            type="button"
            onClick={() => setShowDetail(v => !v)}
            aria-expanded={showDetail}
            aria-controls="signin-assurances"
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-3 text-xs font-medium text-slate-400 backdrop-blur transition-colors hover:border-slate-700 hover:text-slate-200"
          >
            <ShieldCheck className="h-3.5 w-3.5 text-cyan-300" />
            What this app can and cannot do
            <ChevronDown
              className={`h-3.5 w-3.5 transition-transform ${showDetail ? 'rotate-180' : ''}`}
            />
          </button>

          {showDetail && (
            <div
              id="signin-assurances"
              className="mt-3 space-y-4 rounded-2xl border border-slate-800 bg-slate-900/70 p-5 backdrop-blur"
              style={{ animation: 'aca-enter .35s cubic-bezier(.22,1,.36,1) both' }}
            >
              {ASSURANCES.map(item => (
                <div key={item.title} className="flex gap-3">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-cyan-300" />
                  <div>
                    <p className="text-[13px] font-semibold text-slate-200">{item.title}</p>
                    <p className="mt-1 text-xs leading-5 text-slate-400">{item.body}</p>
                  </div>
                </div>
              ))}
            </div>
          )}

          <p className="mt-5 flex items-center justify-center gap-2 text-xs text-slate-500">
            <Lock className="h-3.5 w-3.5" />
            Your credentials go to Microsoft, never to us.
          </p>
        </div>
      </div>
    </div>
  );
}
