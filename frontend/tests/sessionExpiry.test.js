/**
 * Which credential failed, and what that entitles us to do about it.
 *
 * Two unrelated things return 401 from this API. A pasted tenant session token
 * is a data-source credential: it says which Azure directory may be read, and
 * it expiring says nothing about who the user is. The Microsoft sign-in is the
 * identity itself. Treating the first as the second is what told signed-in
 * people their session had gone and offered them the sign-out button.
 *
 * The classifier is the hinge, so it is pinned here against the exact wording
 * the server returns rather than a paraphrase of it.
 */
import { describe as group, it, expect } from 'vitest';
import { isTenantTokenExpiry } from '../src/api/client';

// The literal text from token_resolver.resolve_tenant_token. If the server ever
// rewords this, the copy below stops matching and this test is the thing that
// notices - which is the whole reason it is quoted in full.
const TENANT_TOKEN_401 =
  'The session token for this tenant has expired. '
  + 'Paste a fresh one in Settings, or remove it to fall back to your own sign-in.';

// The literal text from token_validator, raised for jwt.ExpiredSignatureError.
const SIGN_IN_401 = 'Token has expired';

group('telling the two expired credentials apart', () => {
  it('recognises the tenant session token by the server\'s own wording', () => {
    expect(isTenantTokenExpiry(TENANT_TOKEN_401)).toBe(true);
  });

  it('does not mistake an expired sign-in for a tenant token', () => {
    expect(isTenantTokenExpiry(SIGN_IN_401)).toBe(false);
  });

  it('does not mistake other sign-in failures for a tenant token', () => {
    expect(isTenantTokenExpiry('Invalid token: signature verification failed')).toBe(false);
    expect(isTenantTokenExpiry('Token issuer is not Azure AD')).toBe(false);
    expect(isTenantTokenExpiry('Not authenticated')).toBe(false);
  });

  it('treats a missing message as a sign-in problem rather than guessing', () => {
    // The safe default: a tenant-token verdict suppresses renewal of the
    // caller's own token, so an unknown 401 must not be allowed to claim it.
    expect(isTenantTokenExpiry(undefined)).toBe(false);
    expect(isTenantTokenExpiry('')).toBe(false);
    expect(isTenantTokenExpiry(null)).toBe(false);
  });
});
