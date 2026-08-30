/**
 * Sign-in and token hooks.
 *
 * Split out of AuthProvider.jsx so that file exports only components. A module
 * mixing components with plain functions breaks Fast Refresh, which then
 * full-reloads the app on every edit during development.
 */
import { useMsal } from '@azure/msal-react';

import { loginRequest, managementRequest } from './msalConfig';
import { endMySession } from '../api/client';

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
