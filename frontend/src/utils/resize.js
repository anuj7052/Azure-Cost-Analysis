/**
 * The decisions behind the resize UI, separated from the markup that shows
 * them.
 *
 * This is the only feature in the application that can stop a customer's
 * machine, so the rules that decide whether a button is offered, whether it is
 * enabled, and what a finished operation actually meant are worth testing
 * directly rather than inferring from a rendered tree.
 *
 * Every function here is total: given a half-populated response from Azure, it
 * returns an honest answer rather than throwing or inventing a zero.
 */
import { formatAmountFull } from './currency';

export const UNAVAILABLE = 'Unavailable';
export const UNVERIFIED = 'Could not verify';
export const NOT_RETURNED = 'Not returned by Azure';

/**
 * May this row offer a resize *review*?
 *
 * Three things must hold, and they are independent of each other:
 *
 *   - the server named a specific target size (a verdict without a target is
 *     advice, not an action),
 *   - the VM is running (a deallocated VM is not costing compute, so there is
 *     nothing to save by restarting it into a smaller size),
 *   - the target is not the size it already is.
 *
 * Confidence is deliberately *not* a condition. It was, and the result was a
 * fleet where every VM read "Oversized · MEDIUM · Resize → D4as_v5" next to a
 * button that said "View details" — the page recommending an action it would
 * not let anyone look at. What this button opens is a read-only preview, so
 * gating it on confidence protects nobody; it only hides the evidence.
 *
 * Confidence belongs where the decision is made: it is shown prominently in
 * the review, and the backend re-validates every check before anything is
 * touched.
 *
 * Also deliberately absent: quota, region availability and permissions. Those
 * are infrastructure facts checked by the backend preview, and letting them
 * influence *this* gate would mean an empty region could talk us into a
 * resize we have no telemetry for.
 */
export function isResizable(vm) {
  const target = vm?.right_sizing?.recommendation;
  if (!target) return false;
  if (vm.power_state !== 'running') return false;
  // Resizing to the size it already is would be a stop and start for nothing.
  if (target.toLowerCase() === String(vm.sku || '').toLowerCase()) return false;
  return true;
}

/**
 * Whether the review can be opened at all, which is a far weaker question than
 * whether we have something to recommend.
 *
 * Every VM Azure will talk to us about can be reviewed, including deallocated
 * ones and ones the algorithm had no suggestion for. A machine that is too
 * *small* costs its owner in a way no cost report shows, and a machine with no
 * telemetry is exactly the one somebody needs to look at by hand. Withholding
 * the screen because we had no opinion leaves the user with no way to form
 * theirs.
 *
 * The review is read-only; every check that could block a real resize is done
 * by the backend against live Azure when a size is actually chosen.
 */
export function isReviewable(vm) {
  return Boolean(vm?.resource_id || vm?.id);
}

/**
 * Whether the review should open straight into the size picker.
 *
 * With a recommendation there is a proposal to react to. Without one there is
 * nothing to show but the choice itself, so the picker is the screen.
 */
export function opensOnPicker(vm) {
  return !isResizable(vm);
}

/**
 * How much weight the recommendation carries, as a sentence rather than a
 * bare word. LOW and MEDIUM are not failures — they are a shorter observation
 * window — but a person about to stop a production machine should be told so
 * in the same breath as the saving.
 */
export function confidenceAdvice(vm) {
  const level = vm?.right_sizing?.confidence;
  if (level === 'HIGH') {
    return {
      level, tone: 'good',
      text: 'Telemetry covered enough of the window to support this recommendation.',
    };
  }
  if (level === 'MEDIUM') {
    return {
      level, tone: 'medium',
      text: 'Based on a partial telemetry window. Confirm the workload’s busy '
          + 'periods are represented before resizing.',
    };
  }
  if (level === 'LOW') {
    return {
      level, tone: 'high',
      text: 'Very little telemetry was available. Treat this as a prompt to '
          + 'investigate rather than an instruction to resize.',
    };
  }
  return {
    level: null, tone: 'neutral',
    text: 'Azure did not return enough telemetry to rate this recommendation.',
  };
}

/**
 * The label the Action cell shows. Never "Resize VM" — that overstates it.
 * "Review" for a machine we have no proposal for, because the screen it opens
 * is a catalogue to choose from rather than a recommendation to accept.
 */
export function actionLabel(vm) {
  if (isResizable(vm)) return 'Review Resize';
  return isReviewable(vm) ? 'Review size' : 'View details';
}

/** The size the review would propose, or an empty string when there is none. */
export function targetSkuOf(vm) {
  return vm?.right_sizing?.recommendation || vm?.recommended_sku || '';
}

/**
 * The confirm button is enabled only when the backend cleared the resize *and*
 * the person ticked the acknowledgement *and* no request is already in flight.
 * The backend re-checks all of this anyway; this is the layer that stops the
 * click, not the layer that stops the resize.
 */
export function confirmDisabled({ plan, acknowledged, starting, operation }) {
  if (!plan) return true;
  if (operation) return true;
  if (starting) return true;
  if (!plan.can_resize) return true;
  return !acknowledged;
}

/** Why the button is off, in the backend's own words. Never invented here. */
export function blockersOf(plan) {
  if (!plan) return [];
  if (plan.can_resize) return [];
  return plan.blockers || [];
}

/**
 * Money, or a named gap.
 *
 * Always exact, never abbreviated. "₹2.60K/month" is fine on a dashboard tile
 * and wrong on a screen where somebody is deciding whether to stop a
 * production machine.
 *
 * Azure Retail Prices does not have a rate for every size in every region. A
 * missing rate rendered as 0 becomes "saves ₹0/month", which reads as "this is
 * pointless" — the opposite of "we don't know".
 */
export function displayMoney(value, currency) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return UNAVAILABLE;
  return formatAmountFull(value, currency);
}

/** A capability Azure declined to describe is named, not blanked. */
export function displayFact(value, suffix = '') {
  if (value === null || value === undefined || value === '') return NOT_RETURNED;
  return `${value}${suffix}`;
}

/**
 * The saving line, stated the way the spec asks for it: a monthly figure and
 * the arithmetic that turns it into an annual one, so nobody has to trust a
 * number they cannot reproduce.
 */
export function savingSummary(pricing) {
  const monthly = pricing?.monthly_saving;
  const currency = pricing?.currency;
  if (typeof monthly !== 'number' || !Number.isFinite(monthly)) {
    return {
      known: false,
      monthly: UNAVAILABLE,
      annual: UNAVAILABLE,
      arithmetic: pricing?.note || 'Azure did not return a price for these sizes.',
    };
  }
  const annual = pricing.annual_saving;
  return {
    known: true,
    monthly: formatAmountFull(monthly, currency),
    annual: displayMoney(annual, currency),
    arithmetic: `${formatAmountFull(monthly, currency)} × 12 = ${displayMoney(annual, currency)}`,
  };
}

/**
 * What a running or finished operation means.
 *
 * Three outcomes are kept apart because they need different actions from the
 * person reading them: a clean success, a failure that left the VM alone, and
 * the case where the size changed but the machine did not come back up. The
 * last one is the only one that is an emergency.
 */
export function outcomeOf(operation) {
  if (!operation) return { kind: 'idle' };
  if (!operation.terminal) {
    return { kind: 'running', label: operation.state_label };
  }
  if (operation.state === 'SUCCESS') {
    return {
      kind: 'success',
      label: operation.state_label,
      message: 'Azure VM resize completed and the VM is running again.',
    };
  }
  const stoppedAfterResize = operation.new_sku
    && operation.new_sku !== operation.old_sku
    && operation.final_power_state
    && operation.final_power_state !== 'running';
  return {
    kind: stoppedAfterResize ? 'resized_but_stopped' : 'failure',
    label: operation.state_label,
    message: operation.failure_reason || 'The resize did not complete.',
    needsAttention: Boolean(stoppedAfterResize),
  };
}

/**
 * Progress, taken from the backend's step record.
 *
 * There is no percentage here on purpose. A percentage would have to be made
 * up, and a made-up progress bar is exactly the wrong thing to show somebody
 * watching their production VM restart.
 */
export function stepsOf(operation) {
  return (operation?.steps || []).map(step => ({
    key: step.key,
    label: step.label,
    status: step.status,
    done: step.status === 'done',
    active: step.status === 'active',
    failed: step.status === 'failed',
  }));
}

/** Should the poller keep asking? Only while something is genuinely running. */
export function shouldPoll(operation) {
  return Boolean(operation) && !operation.terminal;
}

/** One line of audit history, e.g. for a table row or a screen reader. */
export function historySummary(op) {
  const saving = typeof op?.estimated_monthly_saving === 'number'
    ? `Estimated saving: ${formatAmountFull(op.estimated_monthly_saving, op.currency)}/month`
    : 'Estimated saving: not available';
  return `${op?.vm_name} · ${op?.old_sku} → ${op?.new_sku} · ${op?.state_label} · ${saving}`;
}

/* ── choosing a size ─────────────────────────────────────────────────────── */

/**
 * One row of the size picker, reduced to what the table cell should say.
 *
 * Every "not known" here is a value Azure did not return. None of them are
 * turned into zero: a size with no published price reads "Price not available",
 * because a machine shown at ₹0 is a machine somebody will resize to by
 * accident.
 */
export function describeOption(option, currency) {
  const price = typeof option?.monthly_list_price === 'number'
    ? `${formatAmountFull(option.monthly_list_price, currency)} / mo`
    : 'Price not available';

  const delta = option?.estimated_monthly_delta;
  let impact = { text: 'Not available', tone: 'neutral' };
  if (option?.is_current) {
    impact = { text: 'Current size', tone: 'info' };
  } else if (typeof delta === 'number') {
    if (delta > 0) {
      impact = { text: `Saves ${formatAmountFull(delta, currency)} / mo`, tone: 'good' };
    } else if (delta < 0) {
      impact = { text: `Costs ${formatAmountFull(-delta, currency)} / mo more`, tone: 'high' };
    } else {
      impact = { text: 'No change in cost', tone: 'neutral' };
    }
  }

  const specs = [
    typeof option?.vcpu === 'number' ? `${option.vcpu} vCPU` : 'vCPU not returned',
    typeof option?.memory_gb === 'number' ? `${option.memory_gb} GiB` : 'Memory not returned',
  ].join(' · ');

  return {
    name: option?.name || '',
    specs,
    price,
    impact,
    quota: option?.quota?.label || 'Quota could not be verified',
    quotaOk: option?.quota?.status === 'available',
    availability: option?.availability?.label || 'Not verified',
    availableOk: option?.availability?.status === 'available',
    selectable: Boolean(option?.selectable),
    blockers: option?.blockers || [],
    isCurrent: Boolean(option?.is_current),
    isRecommended: Boolean(option?.is_recommended),
    change: option?.change || 'same',
  };
}

/**
 * Sort order for the picker: the recommendation first, then the current size
 * for comparison, then by how much each option would save.
 *
 * Sizes Azure will not let this subscription use sink to the bottom rather
 * than being hidden — "why can't I pick this?" is a question the page should
 * answer, not dodge.
 */
export function sortOptions(options) {
  const rank = (o) => {
    if (o.is_recommended) return 0;
    if (o.is_current) return 1;
    return o.selectable ? 2 : 3;
  };
  return [...(options || [])].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    const da = typeof a.estimated_monthly_delta === 'number' ? a.estimated_monthly_delta : -Infinity;
    const db = typeof b.estimated_monthly_delta === 'number' ? b.estimated_monthly_delta : -Infinity;
    if (da !== db) return db - da;
    return String(a.name).localeCompare(String(b.name));
  });
}

/**
 * Narrow the catalogue down. A region can offer hundreds of sizes, and
 * scrolling all of them is not a choice, it is a chore.
 */
export function filterOptions(options, { search = '', change = 'all', onlySelectable = false } = {}) {
  const term = search.trim().toLowerCase();
  return (options || []).filter((o) => {
    if (term && !String(o.name || '').toLowerCase().includes(term)) return false;
    if (change !== 'all' && o.change !== change && !o.is_current) return false;
    if (onlySelectable && !o.selectable && !o.is_current) return false;
    return true;
  });
}

/**
 * What the picker header says about the catalogue it just loaded, including
 * the honest case where Azure returned nothing at all.
 */
export function optionsSummary(payload) {
  const options = payload?.options || [];
  if (!options.length) {
    return { total: 0, selectable: 0, text: 'Azure did not return any sizes for this VM.' };
  }
  const selectable = options.filter((o) => o.selectable).length;
  return {
    total: options.length,
    selectable,
    text: `${options.length} sizes offered by Azure for this VM · ${selectable} available to you now`,
  };
}

/**
 * Resizing a machine that is already stopped changes nothing a user can see,
 * so promising downtime would be a lie — and starting it afterwards would put
 * it back on the bill they stopped paying.
 */
export function downtimeFor(vm) {
  if (vm?.power_state === 'running') {
    return {
      tone: 'high',
      title: 'VM downtime required',
      text: 'This VM is running. Azure must stop and deallocate it to change its '
          + 'size, then start it again. Applications on it will be unavailable.',
    };
  }
  return {
    tone: 'info',
    title: 'No downtime — this VM is already stopped',
    text: 'The size is changed in place. The VM is left stopped exactly as it is '
        + 'now; it will not be started, so it will not begin billing for compute.',
  };
}
