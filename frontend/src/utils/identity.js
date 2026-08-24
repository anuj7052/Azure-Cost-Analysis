/**
 * Turning Azure identifiers into something a person can read.
 *
 * Azure names almost nothing. A subscription is a GUID, a principal is a GUID,
 * and a scope is a path built out of both. A security review that shows
 * `7f801a91-3d36-4d34-9b38-619fc8588362` is a review nobody finishes: the
 * reader cannot tell which subscription that is, cannot tell whether two rows
 * refer to the same person, and cannot judge whether a grant is reasonable.
 *
 * So the rule everywhere in this app is: show the name, keep the id available,
 * never show a bare GUID as if it were a label. Where no name is known we say
 * so in words and abbreviate the id rather than pretending the GUID is a name.
 *
 * Pure functions only — the React bindings live in components/Common/Identity.jsx.
 */

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a canonical 8-4-4-4-12 GUID. */
export function isGuid(value) {
  return GUID.test(String(value || '').trim());
}

/**
 * A GUID shortened to its first and last block: `7f801a91…8362`.
 *
 * Both ends are kept because Azure GUIDs from one tenant frequently share a
 * prefix, so a leading fragment alone does not distinguish them. Non-GUID
 * values are returned untouched — this must never mangle a real name.
 */
export function shortId(value) {
  const text = String(value || '').trim();
  if (!isGuid(text)) return text;
  return `${text.slice(0, 8)}…${text.slice(-4)}`;
}

/**
 * A label for a security principal.
 *
 * `resolved` is set by the backend when it managed to find a display name or
 * UPN. When it did not, `principal_name` falls back to the object id, and
 * printing that would put a bare GUID on screen — so instead we say what kind
 * of thing it is and abbreviate the id.
 */
export function principalLabel(item) {
  if (!item) return 'Unknown principal';
  const name = String(item.principal_name || '').trim();
  if (name && !isGuid(name)) return name;

  const kind = String(item.principal_type || '').trim() || 'Principal';
  const id = item.principal_id || name;
  return id ? `Unnamed ${kind.toLowerCase()} ${shortId(id)}` : `Unnamed ${kind.toLowerCase()}`;
}

/** True when the label had to be invented because Azure gave us no name. */
export function isUnresolved(item) {
  if (!item) return true;
  if (item.resolved === true) return false;
  const name = String(item.principal_name || '').trim();
  return !name || isGuid(name);
}

/**
 * A subscription's display name, or an honest stand-in.
 *
 * `names` is a map of lower-cased subscription id to display name, built from
 * the subscription list the app has already loaded — no extra request.
 */
export function subscriptionLabel(id, names = {}) {
  const key = String(id || '').trim();
  if (!key) return '';
  const found = names[key.toLowerCase()];
  if (found) return found;
  return isGuid(key) ? `Subscription ${shortId(key)}` : key;
}

/**
 * An ARM scope path, rewritten with names instead of ids.
 *
 * Returns `{ text, parts, kind }`. `parts` is the breadcrumb from broadest to
 * narrowest, so a caller can render it as segments rather than one string.
 */
export function scopeLabel(scope, names = {}) {
  const raw = String(scope || '').trim();
  if (!raw || raw === '/') {
    return { text: 'Tenant root — every subscription', parts: ['Tenant root'], kind: 'tenant root' };
  }

  const segments = raw.split('/').filter(Boolean);
  const lower = segments.map(s => s.toLowerCase());

  const mgIndex = lower.indexOf('managementgroups');
  if (mgIndex >= 0 && segments[mgIndex + 1]) {
    const parts = [`Management group ${segments[mgIndex + 1]}`];
    return { text: parts[0], parts, kind: 'management group' };
  }

  const subIndex = lower.indexOf('subscriptions');
  if (subIndex < 0) return { text: raw, parts: [raw], kind: 'other' };

  const parts = [subscriptionLabel(segments[subIndex + 1], names)];
  let kind = 'subscription';

  const rgIndex = lower.indexOf('resourcegroups');
  if (rgIndex >= 0 && segments[rgIndex + 1]) {
    parts.push(segments[rgIndex + 1]);
    kind = 'resource group';
  }

  // A resource path ends `/providers/{namespace}/{type}/{name}`, and the name
  // is the only readable part of it.
  const provIndex = lower.lastIndexOf('providers');
  if (provIndex >= 0 && segments.length > provIndex + 3) {
    parts.push(segments[segments.length - 1]);
    kind = 'resource';
  }

  return { text: parts.join(' / '), parts, kind };
}

/** Build the id → name map `subscriptionLabel` and `scopeLabel` expect. */
export function subscriptionNameMap(subscriptions = []) {
  const map = {};
  for (const sub of subscriptions) {
    const id = String(sub?.subscription_id || '').trim().toLowerCase();
    const name = String(sub?.display_name || '').trim();
    if (id && name) map[id] = name;
  }
  return map;
}
