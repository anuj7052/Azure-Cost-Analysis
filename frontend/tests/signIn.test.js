import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { InteractionStatus } from '@azure/msal-browser';
import { isResolvingSignIn } from '../src/auth/interaction';

describe('waiting for MSAL to finish', () => {
  it('waits during every state that precedes an answer', () => {
    // Startup is the one that was missing. MSAL reports it before the redirect
    // hash has been read, so there is no account yet and "are you signed in"
    // answers false -- truthfully, and misleadingly.
    expect(isResolvingSignIn(InteractionStatus.Startup)).toBe(true);
    expect(isResolvingSignIn(InteractionStatus.HandleRedirect)).toBe(true);
    expect(isResolvingSignIn(InteractionStatus.Login)).toBe(true);
  });

  it('stops waiting once MSAL has settled', () => {
    // None is a real answer, not a pending one. Treating it as waiting would
    // hang a genuinely signed-out visitor on a spinner forever.
    expect(isResolvingSignIn(InteractionStatus.None)).toBe(false);
  });

  it('does not wait on an interaction that is not a sign-in', () => {
    // Acquiring a token for a second audience, or signing out, both report a
    // status of their own. Neither says anything about whether the person is
    // signed in, and blocking the page on them would blank the app mid-use.
    expect(isResolvingSignIn(InteractionStatus.AcquireToken)).toBe(false);
    expect(isResolvingSignIn(InteractionStatus.Logout)).toBe(false);
  });
});

describe('which account the app acts as', () => {
  const source = readFileSync(
    resolve(import.meta.dirname, '../src/auth/AuthProvider.jsx'),
    'utf8',
  );

  it('names an active account when a sign-in succeeds', () => {
    // MSAL sets no active account after a redirect sign-in, and every reader
    // here falls back to accounts[0]. That fallback is right exactly once: the
    // cache is in insertion order, so on a machine where two people have ever
    // signed in it returns the first, not the one who just authenticated.
    expect(source).toContain('setActiveAccount');
    expect(source).toContain('EventType.LOGIN_SUCCESS');
  });
});
