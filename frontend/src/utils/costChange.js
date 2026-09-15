/**
 * Why a bill moved, stated as billing arithmetic.
 *
 * `compareServices` already answers "by how much did each service change".
 * That is a table, and a table is not an explanation: the reader still has to
 * find the three rows that matter, notice which services are new, notice which
 * stopped billing, and work out whether the named rows even add up to the
 * change in the total.
 *
 * This does that reading once, so the UI can say it in a sentence. It is
 * deliberately arithmetic only — it can say "Virtual Machines billed 40% more",
 * never "because someone resized a VM". Attributing a cause needs usage and
 * rate detail this input does not carry, and guessing one would be worse than
 * staying quiet.
 */
import { compareServices } from './dailyTimeline';

/** Services whose movement is too small to be worth a sentence. */
const NOISE = 0.01;

/** How many named movers a headline carries before it stops being readable. */
const TOP_N = 3;

function sum(rows, pick) {
  return rows.reduce((total, row) => total + pick(row), 0);
}

/**
 * @param current  the later period ({ [totalKey], by_service, currency })
 * @param prior    the earlier period, or undefined when none was returned
 * @param options  totalKey, label, priorLabel, partial (current period is
 *                 still being billed), priorPartial
 * @returns a structured reading; `status` says whether the rest is meaningful.
 */
export function explainChange(current, prior, options = {}) {
  const { totalKey = 'total', label = 'this period', priorLabel = 'the previous period', partial = false, priorPartial = false } = options;
  const empty = {
    status: 'missing', direction: 'flat', delta: null, percent: null,
    currentTotal: null, priorTotal: null, risers: [], fallers: [],
    started: [], stopped: [], residual: null, residualShare: null,
    grossUp: 0, grossDown: 0, attributed: false, notes: [],
  };

  if (!current) return { ...empty, notes: [`No billing was returned for ${label}. A period with no returned data is not a period that cost nothing.`] };
  if (!prior) {
    return {
      ...empty, status: 'no-prior', currentTotal: current[totalKey] ?? null,
      notes: [`There is nothing returned for ${priorLabel} to compare against, so no change is calculated. The earlier period may sit outside the selected range or simply not have been returned; it is not read as zero.`],
    };
  }

  const comparison = compareServices(current, prior, totalKey);
  const currentTotal = current[totalKey] ?? null;
  const priorTotal = prior[totalKey] ?? null;

  if (comparison.delta === null) {
    return {
      ...empty, status: 'incomparable', currentTotal, priorTotal,
      notes: [current.currency && prior.currency && current.currency !== prior.currency
        ? `${label} is billed in ${current.currency} and ${priorLabel} in ${prior.currency}. Two currencies cannot be subtracted, so no change is shown.`
        : 'One of the two totals is missing, so no change can be calculated.'],
    };
  }

  const moved = comparison.rows.filter(row => Number.isFinite(row.delta) && Math.abs(row.delta) >= NOISE);
  const risers = moved.filter(row => row.delta > 0).sort((a, b) => b.delta - a.delta);
  const fallers = moved.filter(row => row.delta < 0).sort((a, b) => a.delta - b.delta);
  const grossUp = sum(risers, row => row.delta);
  const grossDown = Math.abs(sum(fallers, row => row.delta));

  // "New" and "stopped" are only claims we can make when both periods carried a
  // service breakdown. Without one, an absent name means unknown, not zero.
  const attributed = Boolean(current.by_service && prior.by_service);
  const started = attributed ? risers.filter(row => !prior.by_service[row.name] && row.current > 0).map(row => row.name) : [];
  const stopped = attributed ? fallers.filter(row => !current.by_service[row.name] && row.prior > 0).map(row => row.name) : [];

  const withShare = (rows) => rows.slice(0, TOP_N).map(row => ({
    ...row,
    // Share of the movement in the same direction, not of the net change: a
    // service can be 120% of a net rise that other services partly offset, and
    // a percentage over 100 reads as a bug rather than as the real shape.
    share: (row.delta > 0 ? grossUp : grossDown) ? Math.abs(row.delta) / (row.delta > 0 ? grossUp : grossDown) : null,
  }));

  const notes = [];
  if (partial) notes.push(`${label} is still being billed. Comparing a part-period against a finished one understates it — a fall here is not yet a saving.`);
  if (priorPartial) notes.push(`${priorLabel} is a partial period, so the baseline is lower than a full one would be.`);
  if (!attributed) notes.push('Azure returned no service breakdown for one of the two periods, so the change can be counted but not attributed.');
  if (comparison.residual !== null && Math.abs(comparison.residual) >= NOISE) {
    notes.push('Named services do not fully reconcile to the change in the total; the remainder carries no service name in Azure\u2019s grouped totals.');
  }
  notes.push('These are billed deltas — what changed on the invoice. They do not identify the operational cause, and late or revised billing can move them.');

  return {
    status: 'ok',
    direction: comparison.delta > NOISE ? 'up' : comparison.delta < -NOISE ? 'down' : 'flat',
    delta: comparison.delta,
    percent: comparison.percent,
    currentTotal,
    priorTotal,
    risers: withShare(risers),
    fallers: withShare(fallers),
    riserCount: risers.length,
    fallerCount: fallers.length,
    started,
    stopped,
    residual: comparison.residual,
    residualShare: comparison.residual !== null && comparison.delta ? comparison.residual / Math.abs(comparison.delta) : null,
    grossUp,
    grossDown,
    attributed,
    notes,
  };
}

/**
 * One sentence naming the movement and what carried it.
 *
 * `money` is injected rather than imported so the caller's currency formatting
 * stays the single one on screen.
 */
export function changeHeadline(reading, money = String) {
  if (reading.status !== 'ok') return reading.notes[0] || '';
  if (reading.direction === 'flat') return 'The total barely moved, though individual services may still have offset each other.';

  const verb = reading.direction === 'up' ? 'rose' : 'fell';
  const size = `${money(Math.abs(reading.delta))}${reading.percent === null ? '' : ` (${Math.abs(reading.percent).toFixed(1)}%)`}`;
  const drivers = reading.direction === 'up' ? reading.risers : reading.fallers;

  if (!drivers.length) return `Spend ${verb} by ${size}, with no single service movement large enough to name.`;

  const lead = drivers[0];
  const leadShare = lead.share === null ? '' : ` — ${Math.round(lead.share * 100)}% of the ${reading.direction === 'up' ? 'increase' : 'decrease'}`;
  const rest = drivers.length > 1 ? `, then ${drivers.slice(1).map(row => row.name).join(' and ')}` : '';
  const offset = reading.direction === 'up' && reading.grossDown >= NOISE
    ? ` ${money(reading.grossDown)} of falls elsewhere offset part of it.`
    : reading.direction === 'down' && reading.grossUp >= NOISE
      ? ` ${money(reading.grossUp)} of rises elsewhere worked against it.`
      : '';

  return `Spend ${verb} by ${size}. The largest mover was ${lead.name}${leadShare}${rest}.${offset}`;
}
