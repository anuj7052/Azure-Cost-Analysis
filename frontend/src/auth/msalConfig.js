import { PublicClientApplication, LogLevel } from '@azure/msal-browser';

export const msalConfig = {
  auth: {
    clientId: import.meta.env.VITE_AZURE_CLIENT_ID || '',
    // "organizations" lets a user from ANY Azure AD tenant sign in, which is
    // required for a multi-tenant SaaS offer. Pinning a single tenant id here
    // rejects every external customer with AADSTS90072.
    authority: `https://login.microsoftonline.com/${import.meta.env.VITE_AZURE_TENANT_ID || 'organizations'}`,
    redirectUri: import.meta.env.VITE_AZURE_REDIRECT_URI || 'http://localhost:5174',
    postLogoutRedirectUri: import.meta.env.VITE_AZURE_REDIRECT_URI || 'http://localhost:5174',
    navigateToLoginRequestUrl: false,
  },
  cache: {
    cacheLocation: 'localStorage',
    storeAuthStateInCookie: true,
  },
  system: {
    loggerOptions: {
      loggerCallback: (level, message, containsPii) => {
        if (containsPii) return;
        if (level === 0) console.error('[MSAL]', message); // errors only
      },
      logLevel: LogLevel.Error,
    },
  },
};

// Only use basic scopes for login — avoids admin-consent failures during auth.
// The management API token is acquired separately when making API calls.
export const loginRequest = {
  scopes: ['openid', 'profile', 'email', 'User.Read'],
};

// Separate request for Azure Management API — acquired silently after login
export const managementRequest = {
  scopes: ['https://management.azure.com/user_impersonation'],
};

// @azure/msal-react v5: pass uninitialized instance — MsalProvider calls initialize() internally
export const msalInstance = new PublicClientApplication(msalConfig);
