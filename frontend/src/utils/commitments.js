/**
 * Commitments -- the decision logic behind the reservations page.
 *
 * Lives here rather than in the component because there is no DOM in the test
 * environment, and because every function below decides something a person will
 * act on: whether to renew a reservation, whether to cancel one, whether a
 * number on screen was measured or guessed.
 *
 * One rule runs through all of it. A missing value is rendered as the words
 * "Not available" and never as a zero, a dash that looks like a zero, or a
 * plausible average. On a page about money, an invented number is
 * indistinguishable from a measured one at a glance, and the reader has no way
 * to tell which kind they are looking at.
 */
import { formatAmount } from './currency';

export const MISSING = 'Not available';

export const RESERVATION = 'reservation';
export const SAVINGS_PLAN = 'savings-plan';

export const KIND_LABEL = {
  [RESERVATION]: 'RI',
  [SAVINGS_PLAN]: 'SP',
};

export const KIND_FULL = {
  [RESERVATION]: 'Reserved Instance',
  [SAVINGS_PLAN]: 'Savings Plan',
};

/** The windows Azure actually publishes. Offering a fourth would invite a
 *  question the data cannot answer. */
export const GRAINS = [
  { key: 1, label: '1 day' },
  { key: 7, label: '7 days' },
  { key: 30, label: '30 days' },
];

export const TYPE_FILTERS = [
  { key: 'all', label: 'All' },
  { key: RESERVATION, label: 'Reservations' },
  { key: SAVINGS_PLAN, label: 'Savings Plans' },
];

/**
 * Utilisation bands.
 *
 * The boundary that matters is the one below which a commitment is losing money
 * against pay-as-you-go, not a round number. Anything under it is coloured to
 * be noticed; a commitment Azure has not measured yet is grey rather than red,
 * because "unmeasured" and "unused" call for opposite reactions.
 */
export const GOOD_ABOVE = 90;
export const POOR_BELOW = 80;

export function utilisationTone(percent) {
  if (percent === null || percent === undefined) return 'text-slate-500';
  if (percent < POOR_BELOW) return 'text-rose-400';
  if (percent < GOOD_ABOVE) return 'text-amber-400';
  return 'text-emerald-400';
}

export function utilisationBar(percent) {
  if (percent === null || percent === undefined) return 'bg-slate-700';
  if (percent < POOR_BELOW) return 'bg-rose-500';
  if (percent < GOOD_ABOVE) return 'bg-amber-500';
  return 'bg-emerald-500';
}

export const EXPIRY_TONE = {
  expired: 'text-slate-500',
  critical: 'text-rose-400',
  warning: 'text-amber-400',
  watch: 'text-sky-400',
};

export const EXPIRY_LABEL = {
  expired: 'Expired',
  critical: 'Critical',
  warning: 'Soon',
  watch: 'Watch',
};

/**
 * A percentage for display, or the words that say there is not one.
 *
 * A genuine zero survives. Azure reporting a commitment as 0% used is one of
 * the most important things this page can say, and a helper that treated it as
 * missing would delete exactly that.
 */
export function percent(value, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(value)) return MISSING;
  return `${Number(value).toFixed(digits)}%`;
}

export function money(value, currency) {
  if (value === null || value === undefined || Number.isNaN(value)) return MISSING;
  return formatAmount(value, currency || 'USD');
}

/**
 * Azure writes terms as ISO durations. Nobody says "P3Y" out loud.
 */
export function termLabel(term) {
  const raw = String(term || '').trim().toUpperCase();
  const match = raw.match(/^P(\d+)Y$/);
  if (match) return `${match[1]}-Year`;
  const months = raw.match(/^P(\d+)M$/);
  if (months) return `${months[1]}-Month`;
  return raw || MISSING;
}

/**
 * How long is left, phrased the way somebody would say it.
 *
 * Days rather than a date up to a quarter out, because "in 21 days" prompts an
 * action and "Sep 20, 2026" prompts a mental subtraction that often does not
 * happen.
 */
export function expiryLabel(days) {
  if (days === null || days === undefined) return MISSING;
  if (days < 0) return `Expired ${Math.abs(days)} days ago`;
  if (days === 0) return 'Expires today';
  if (days === 1) return 'Expires tomorrow';
  if (days <= 90) return `${days} days`;
  return `${Math.round(days / 30)} months`;
}

/**
 * Narrow the inventory to what the reader asked for.
 *
 * Expired commitments are hidden by default and counted rather than dropped
 * silently, because a page that quietly omits rows makes its own totals
 * unexplainable.
 */
export function filterCommitments(items, { type = 'all', hideExpired = true, query = '' } = {}) {
  const q = String(query || '').trim().toLowerCase();
  return (items || []).filter((item) => {
    if (type !== 'all' && item.kind !== type) return false;
    if (hideExpired && (item.days_to_expiry ?? 0) < 0) return false;
    if (!q) return true;
    return [item.name, item.sku, item.resource_type, item.term, item.scope_type]
      .some(field => String(field || '').toLowerCase().includes(q));
  });
}

/**
 * Utilisation for the chosen window.
 *
 * The backend keys these by number and JSON turns those keys into strings, so
 * both are tried. Reading only one would silently report every commitment as
 * unmeasured, which looks exactly like a page that is still loading.
 */
export function usedAt(item, grain) {
  const table = (item && item.utilisation) || {};
  const value = table[grain] ?? table[String(grain)];
  return value === undefined ? null : value;
}

/**
 * What a commitment is costing that nobody is using.
 *
 * Azure bills the unused portion of a benefit as its own charge, so where that
 * came back it is used directly: it is a measured figure rather than a derived
 * one, and it exists even in tenants where the utilisation API returns nothing.
 * Only when it is absent does this fall back to cost multiplied by the unused
 * percentage, and that fallback still needs both halves -- this is the number
 * somebody quotes when they propose cancelling a reservation, and an estimate
 * built on a guessed cost would look identical on screen to a measured one.
 */
export function wastageOf(item, grain) {
  const measured = item && item.measured_wastage;
  if (measured !== null && measured !== undefined) return Math.round(measured * 100) / 100;
  const cost = item && item.monthly_cost;
  const used = usedAt(item, grain);
  if (cost === null || cost === undefined) return null;
  if (used === null || used === undefined) return null;
  const unused = Math.max(0, Math.min(100, 100 - used));
  return Math.round(cost * unused) / 100;
}

/** Whether a wastage figure was billed by Azure or inferred from a percentage. */
export function wastageBasis(item, grain) {
  if (item && item.measured_wastage !== null && item.measured_wastage !== undefined) return 'measured';
  return wastageOf(item, grain) === null ? '' : 'derived';
}

/**
 * Utilisation grouped by what the commitment covers.
 *
 * Averaged plainly and only across commitments Azure has measured, because a
 * bar drawn over a mix of measured and assumed values is a bar nobody can act
 * on. Groups where nothing was measured are dropped rather than drawn at zero.
 */
export function byResourceType(items, grain) {
  const groups = new Map();
  for (const item of items || []) {
    const used = usedAt(item, grain);
    if (used === null) continue;
    const key = item.resource_type || 'Other';
    const held = groups.get(key) || { name: key, total: 0, count: 0, cost: 0 };
    held.total += used;
    held.count += 1;
    held.cost += item.monthly_cost || 0;
    groups.set(key, held);
  }
  return [...groups.values()]
    .map(g => ({ name: g.name, used: Math.round((g.total / g.count) * 10) / 10, count: g.count, cost: g.cost }))
    .sort((a, b) => a.used - b.used);
}

/**
 * The commitments losing the most money right now, worst first.
 *
 * Ranked by measured waste rather than by low utilisation, because a 60%-used
 * reservation costing a little is a smaller problem than an 88%-used one
 * costing a great deal, and only one of those is worth an afternoon.
 */
export function worstWaste(items, grain, limit = 5) {
  return (items || [])
    .map(item => ({ item, lost: wastageOf(item, grain) }))
    .filter(entry => entry.lost !== null && entry.lost > 0)
    .sort((a, b) => b.lost - a.lost)
    .slice(0, limit);
}

/**
 * A one-line honest reading of the headline utilisation.
 *
 * Says what the number is, not whether the estate is "healthy". A grade implies
 * this page weighed everything that bears on the decision, and it has weighed
 * utilisation and nothing else -- not the workloads that are about to be
 * retired, nor the migration that makes an underused reservation correct.
 */
export function utilisationVerdict(summary, grain) {
  const value = summary && summary.utilisation;
  if (value === null || value === undefined) {
    return 'Azure has not published utilisation for these commitments yet.';
  }
  const window = `over ${grain} days`;
  if (value < POOR_BELOW) {
    return `${percent(value)} used ${window}. Some of what you have committed to is not being consumed.`;
  }
  if (value < GOOD_ABOVE) {
    return `${percent(value)} used ${window}. There is some headroom left unconsumed.`;
  }
  return `${percent(value)} used ${window}. Nearly all of what you committed to is being consumed.`;
}
