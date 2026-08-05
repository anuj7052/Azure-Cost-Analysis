import { MsalProvider, useMsal, useIsAuthenticated } from '@azure/msal-react';
import { InteractionStatus } from '@azure/msal-browser';
import { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import { msalInstance, loginRequest, managementRequest } from './msalConfig';
import { useTheme } from '../store/useTheme';

export function AuthProvider({ children }) {
  return <MsalProvider instance={msalInstance}>{children}</MsalProvider>;
}

export function useLogin() {
  const { instance } = useMsal();
  const login = () => { instance.loginRedirect(loginRequest); };
  const logout = () => { instance.logoutRedirect(); };
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

export function RequireAuth({ children }) {
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
    return <LoginScreen />;
  }

  return children;
}

function LoginScreen() {
  const { login } = useLogin();
  const theme = useTheme(s => s.theme);
  const toggleTheme = useTheme(s => s.toggleTheme);

  return (
    <div className="relative flex h-screen items-center justify-center bg-slate-950 px-6">
      <button
        onClick={toggleTheme}
        aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        className="absolute top-5 right-5 w-9 h-9 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 flex items-center justify-center transition-colors"
      >
        {theme === 'dark' ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
      </button>

      <div className="w-full max-w-[380px] text-center">
        <div className="flex justify-center mb-6">
          <div className="w-20 h-20 rounded-2xl bg-blue-600 flex items-center justify-center elevated-lg">
            <svg viewBox="0 0 96 96" className="w-11 h-11 fill-[#fff]">
              <path d="M33.4 6.4L10 73.8h19.3l13.6-36.1 14.1 25.2-10.2 10.9H66l17.8 17.7H96L57.3 6.4H33.4z" />
            </svg>
          </div>
        </div>

        <h1 className="text-2xl font-bold text-white mb-2">Azure Cost Analysis</h1>
        <p className="text-sm text-slate-400 leading-relaxed mb-8">
          Multi-tenant cloud cost tracking, anomaly detection, and spend analysis
        </p>

        <button
          onClick={login}
          className="w-full flex items-center justify-center gap-3 bg-blue-600 hover:bg-blue-500 text-[#fff] font-semibold text-[0.95rem] px-6 py-3.5 rounded-xl transition-colors elevated-lg"
        >
          <svg viewBox="0 0 21 21" className="w-5 h-5 fill-[#fff] shrink-0">
            <rect x="1" y="1" width="9" height="9" />
            <rect x="11" y="1" width="9" height="9" />
            <rect x="1" y="11" width="9" height="9" />
            <rect x="11" y="11" width="9" height="9" />
          </svg>
          Sign in with Microsoft
        </button>

        <p className="text-xs text-slate-500 mt-4">Use your company Azure AD account</p>
      </div>
    </div>
  );
}
