/**
 * Reading an Azure access token that somebody pasted.
 *
 * The API already checks all of this and refuses a bad token, so nothing here
 * is a security control -- the browser could never be one, since the claims are
 * read without verifying the signature. What this buys is the difference
 * between finding out immediately and finding out after a round trip: the four
 * ways a paste goes wrong (wrong resource, already expired, not a token at all,
 * the JSON without the token in it) are all visible from the text itself.
 *
 * The extraction rules deliberately mirror `AddSessionTokenRequest.strip_bearer`
 * on the server. If the two ever disagree, the screen would reject something
 * the API would have accepted, which is the more annoying of the two failures.
 */

/** What the token has to be issued for. Anything else cannot read costs. */
const MANAGEMENT_AUDIENCES = ['management.azure.com', 'management.core.windows.net'];

/**
 * Dig the raw JWT out of whatever was pasted.
 *
 * People paste the whole `az account get-access-token` blob far more often than
 * the bare token, so that is handled rather than corrected.
 */
export function extractToken(pasted) {
  let value = String(pasted || '').trim();
  if (!value) return { error: 'Paste a token to continue.' };

  if (value.startsWith('{')) {
    let blob;
    try {
      blob = JSON.parse(value);
    } catch {
      return {
        error: 'That looks like JSON but it could not be parsed. Paste the whole output of '
          + 'the command above, or just the accessToken value.',
      };
    }
    const token = blob?.accessToken || blob?.access_token;
    if (!token) return { error: "That JSON has no 'accessToken' field in it." };
    value = String(token).trim();
  }

  value = value.replace(/^["']|["']$/g, '').trim();
  if (/^bearer\s/i.test(value)) value = value.slice(7).trim();
  // A token copied out of a terminal arrives with wrapped lines. A JWT never
  // contains whitespace, so anything in the middle is safe to drop.
  value = value.split(/\s+/).join('');

  if (!value) return { error: 'Paste a token to continue.' };
  return { token: value };
}

/** Decode one base64url segment to text, or null if it is not base64url. */
function decodeSegment(segment) {
  try {
    const padded = segment.replace(/-/g, '+').replace(/_/g, '/')
      + '='.repeat((4 - (segment.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Everything the screen can know about a pasted token before the API sees it.
 *
 * Returns `{ ok: false, error, hint }` for anything wrong, and never throws:
 * a paste is untrusted input and a crash here would look like a broken dialog
 * rather than a bad token.
 */
export function inspectToken(pasted) {
  const extracted = extractToken(pasted);
  if (extracted.error) return { ok: false, error: extracted.error };
  const token = extracted.token;

  const parts = token.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1]) {
    return {
      ok: false,
      error: 'That is not an access token.',
      hint: 'An Azure token is three dot-separated blocks starting with "eyJ". Check you '
        + 'copied the accessToken value and not the subscription id or a connection string.',
    };
  }

  const payload = decodeSegment(parts[1]);
  if (payload === null) {
    return {
      ok: false,
      error: 'The token is damaged and could not be read.',
      hint: 'It was probably truncated on the way here. Copy the whole value and paste again.',
    };
  }

  let claims;
  try {
    claims = JSON.parse(payload);
  } catch {
    return {
      ok: false,
      error: 'The token payload is not readable.',
      hint: 'Generate a fresh token with the command above and paste that.',
    };
  }
  if (!claims || typeof claims !== 'object') {
    return { ok: false, error: 'The token payload is not readable.' };
  }

  const audience = String(claims.aud || '');
  if (!MANAGEMENT_AUDIENCES.some(a => audience.includes(a))) {
    return {
      ok: false,
      error: audience
        ? `This token is for "${audience}", not the Azure management API.`
        : 'This token names no audience, so it is not an Azure management token.',
      hint: 'Add --resource https://management.azure.com to the command above. A Graph or '
        + 'Storage token will be refused even though it is a valid token.',
      claims,
    };
  }

  if (!claims.tid) {
    return {
      ok: false,
      error: 'The token carries no tenant (tid) claim, so there is nothing to connect.',
      claims,
    };
  }

  const expiresAt = Number(claims.exp) ? new Date(Number(claims.exp) * 1000) : null;
  if (expiresAt && expiresAt <= new Date()) {
    return {
      ok: false,
      error: `That token expired ${describeAge(expiresAt)}.`,
      hint: 'Azure tokens last about an hour. Run the command again and paste the new one.',
      claims,
      expiresAt,
    };
  }

  return {
    ok: true,
    token,
    claims,
    tenantId: String(claims.tid),
    account: claims.upn || claims.unique_name || claims.appid || '',
    expiresAt,
    // Below roughly five minutes the token will very likely die mid-query, so
    // it is accepted but said out loud rather than left to fail later.
    expiringSoon: Boolean(expiresAt && expiresAt - Date.now() < 5 * 60 * 1000),
  };
}

/** "12 minutes ago", for an expiry that has already passed. */
function describeAge(when) {
  const minutes = Math.round((Date.now() - when.getTime()) / 60000);
  if (minutes < 1) return 'moments ago';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** How long a valid token has left, phrased for a caption. */
export function timeLeft(expiresAt) {
  if (!expiresAt) return null;
  const minutes = Math.round((expiresAt.getTime() - Date.now()) / 60000);
  if (minutes <= 0) return 'expired';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours} hour${hours === 1 ? '' : 's'}`;
}
