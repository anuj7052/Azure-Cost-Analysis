"use client";

import {
  Configuration,
  PublicClientApplication,
  type SilentRequest,
} from "@azure/msal-browser";

const clientId = process.env.NEXT_PUBLIC_AZURE_CLIENT_ID ?? "";
const authority =
  process.env.NEXT_PUBLIC_AZURE_AUTHORITY ??
  "https://login.microsoftonline.com/organizations";

export const apiScope =
  process.env.NEXT_PUBLIC_API_SCOPE ?? `api://${clientId}/access_as_user`;

/**
 * Local-development only. If the app registration does not expose an API,
 * Entra rejects the `api://<client-id>/access_as_user` scope with AADSTS500011.
 * Setting this asks only for OIDC scopes and sends the ID token to the backend,
 * which must have ACCEPT_ID_TOKEN_AUDIENCE enabled to match.
 */
export const useIdTokenOnly =
  process.env.NEXT_PUBLIC_USE_ID_TOKEN === "true";

export const msalConfig: Configuration = {
  auth: {
    clientId,
    authority,
    redirectUri:
      typeof window === "undefined" ? "/" : `${window.location.origin}/`,
    postLogoutRedirectUri: "/",
    navigateToLoginRequestUrl: false,
  },
  cache: {
    // sessionStorage limits token lifetime to the browser session and is not
    // shared across tabs, reducing token exfiltration surface vs localStorage.
    cacheLocation: "sessionStorage",
    storeAuthStateInCookie: false,
  },
  system: {
    allowPlatformBroker: false,
  },
};

export const loginRequest = {
  scopes: useIdTokenOnly
    ? ["openid", "profile", "offline_access"]
    : ["openid", "profile", "offline_access", apiScope],
};

export const msalInstance = new PublicClientApplication(msalConfig);

/**
 * MSAL v4 must be initialized before any other call, and the redirect response
 * has to be consumed before the router touches the URL fragment. Both are done
 * once here; `Providers` awaits this before rendering the tree.
 */
export const msalReady: Promise<Error | null> =
  typeof window === "undefined"
    ? Promise.resolve(null)
    : msalInstance
        .initialize()
        .then(() => msalInstance.handleRedirectPromise())
        .then((result) => {
          const account =
            result?.account ?? msalInstance.getAllAccounts()[0] ?? null;
          if (account) msalInstance.setActiveAccount(account);
          return null;
        })
        .catch((error: unknown) => {
          // Surfacing this is essential: a misconfigured app registration
          // otherwise just bounces the user back to the sign-in screen.
          console.error("MSAL redirect failed", error);
          return error instanceof Error ? error : new Error(String(error));
        });

export async function acquireToken(): Promise<string | null> {
  await msalReady;
  const account = msalInstance.getActiveAccount() ?? msalInstance.getAllAccounts()[0];
  if (!account) return null;

  if (useIdTokenOnly) {
    const result = await msalInstance.acquireTokenSilent({
      scopes: ["openid", "profile"],
      account,
    });
    return result.idToken;
  }

  const request: SilentRequest = { scopes: [apiScope], account };
  try {
    const result = await msalInstance.acquireTokenSilent(request);
    return result.accessToken;
  } catch {
    const result = await msalInstance.acquireTokenPopup(request);
    return result.accessToken;
  }
}
