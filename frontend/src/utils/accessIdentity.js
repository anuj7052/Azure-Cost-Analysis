/**
 * The two views that make up the Access & Identity page.
 *
 * Kept out of the page component so the list and the URL rule can be tested
 * without a DOM, and so the page file exports nothing but a component.
 */

export const VIEW_KEYS = ['optimization', 'assignments'];

export const VIEW_LABEL = {
  optimization: 'Access Optimization',
  assignments: 'Role Assignments',
};

export const VIEW_BLURB = {
  optimization: 'Grants that look unused, stale, over-privileged or duplicated.',
  assignments: 'Start from a person and see everything they can reach.',
};

/**
 * Which view a set of query parameters asks for.
 *
 * Anything unrecognised falls back to the first view rather than rendering
 * nothing. A mistyped or stale link should land somewhere useful, not on a
 * blank page.
 */
export function viewFromParams(params) {
  const asked = String(params?.get?.('view') || '').toLowerCase();
  return VIEW_KEYS.includes(asked) ? asked : VIEW_KEYS[0];
}
