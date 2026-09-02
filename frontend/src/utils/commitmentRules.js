/**
 * Commitment rules -- what Microsoft actually charges you to get out of a
 * reservation or a savings plan.
 *
 * The page this feeds is the one somebody opens ten minutes before they cancel
 * a three-year reservation, so every claim below is a quote of a published
 * Microsoft rule with the document it came from attached. Nothing here is
 * inferred, rounded off, or restated from memory: if a rule is not in the
 * linked article, it is not in this file.
 *
 * Two things about the money are easy to get wrong and are therefore stated
 * explicitly wherever they appear:
 *
 *   1. Microsoft is *not* currently charging an early termination fee. The
 *      widely-repeated "12% penalty" is a fee Microsoft has reserved the right
 *      to charge in future and has not enabled. Presenting it as a live charge
 *      would talk people out of refunds that are currently free.
 *   2. The USD 50,000 cancellation cap is a rolling 12-month pool of *cancelled
 *      commitment*, not of refunded cash, and it is shared across everything
 *      cancelled under the same billing profile or enrolment.
 *
 * Sources (all learn.microsoft.com, checked 2026-08-31):
 *   exchange-and-refund-azure-reservations -- ms.date 2026-07-22
 *   savings-plan/cancel-savings-plan       -- ms.date 2026-03-14
 */

const LEARN = 'https://learn.microsoft.com/en-us/azure/cost-management-billing';

export const SOURCES = {
  refund: {
    id: 'refund',
    title: 'Self-service exchanges and refunds for Azure Reservations',
    url: `${LEARN}/reservations/exchange-and-refund-azure-reservations`,
    revised: '2026-07-22',
  },
  cancelSavingsPlan: {
    id: 'cancelSavingsPlan',
    title: 'Savings plan cancellation policies',
    url: `${LEARN}/savings-plan/cancel-savings-plan`,
    revised: '2026-03-14',
  },
  tradeIn: {
    id: 'tradeIn',
    title: 'Self-service trade-in for Azure savings plans',
    url: `${LEARN}/savings-plan/reservation-trade-in`,
  },
  decide: {
    id: 'decide',
    title: 'Decide between a savings plan and a reservation',
    url: `${LEARN}/savings-plan/decide-between-savings-plan-reservation`,
  },
  manage: {
    id: 'manage',
    title: 'Who can manage a reservation by default',
    url: `${LEARN}/reservations/manage-reserved-vm-instance#who-can-manage-a-reservation-by-default`,
  },
  utilisation: {
    id: 'utilisation',
    title: 'View Azure reservation utilization',
    url: `${LEARN}/reservations/reservation-utilization`,
  },
  portal: {
    id: 'portal',
    title: 'Reservations in the Azure portal',
    url: 'https://portal.azure.com/#blade/Microsoft_Azure_Reservations/ReservationsBrowseBlade',
  },
};

export const TOPICS = [
  { key: 'cancel', label: 'Cancelling & refunds' },
  { key: 'limit', label: 'The USD 50,000 cap' },
  { key: 'exchange', label: 'Exchanges' },
  { key: 'savings', label: 'Savings plans' },
  { key: 'money', label: 'How the money comes back' },
  { key: 'who', label: 'Who is allowed to' },
];

/**
 * Every rule, phrased as the answer to the question somebody actually asked.
 *
 * `weight` orders the list: 'blocker' is something that stops the transaction
 * outright, 'cost' is something that costs money, 'note' is procedural.
 */
export const RULES = [
  // ── Cancelling and refunds ────────────────────────────────────────────────
  {
    id: 'refund-prorated',
    topic: 'cancel',
    weight: 'cost',
    question: 'If I cancel today, how much do I get back?',
    answer:
      'The unused portion, worked out by remaining days rather than remaining months. '
      + 'Azure cancels the reservation and refunds the pro-rated amount, calculated in UTC '
      + 'from the number of days left in the reservation term.',
    example:
      'Buy on 10 July 2024, cancel on 9 July 2025 on a one-year term and one day is left — '
      + 'so you get one day back, not a month.',
    source: 'refund',
  },
  {
    id: 'refund-lowest-price',
    topic: 'cancel',
    weight: 'cost',
    question: 'Is the refund based on what I paid?',
    answer:
      'Not necessarily. Refunds are calculated on the lower of your purchase price or the '
      + 'current price of the reservation. If Azure has cut the price since you bought, the '
      + 'refund follows the new, lower price.',
    source: 'refund',
  },
  {
    id: 'refund-fee',
    topic: 'cancel',
    weight: 'cost',
    question: 'What is the cancellation penalty — is it 12%?',
    answer:
      'There is no early termination fee being charged today. Microsoft states it is '
      + '"currently not charging an early termination fee", and that there might in future '
      + 'be a 12% early termination fee for cancellations. No date has been announced for '
      + 'enabling it.',
    caution:
      'Treat 12% as a risk to plan for, not a charge to budget for. Anyone quoting it as a '
      + 'live penalty is quoting a fee Microsoft has not switched on.',
    source: 'refund',
  },
  {
    id: 'refund-ineligible',
    topic: 'cancel',
    weight: 'blocker',
    question: 'Which reservations can never be refunded?',
    answer:
      'Red Hat plans, SUSE Linux plans, and all pre-purchase plans are not eligible for '
      + 'refunds. The same three are not eligible for exchange either.',
    source: 'refund',
  },
  {
    id: 'refund-expired-agreement',
    topic: 'cancel',
    weight: 'note',
    question: 'Our enterprise agreement has since been renewed — does that block it?',
    answer:
      'No. You can exchange or refund reservations even if the enterprise agreement used to '
      + 'buy the reservation has expired and was renewed as a new agreement.',
    source: 'refund',
  },

  // ── The cap ───────────────────────────────────────────────────────────────
  {
    id: 'limit-50k',
    topic: 'limit',
    weight: 'blocker',
    question: 'Is there a limit on how much I can cancel?',
    answer:
      'Yes. Total cancelled commitment cannot exceed USD 50,000 in a rolling 12-month window '
      + 'for a billing profile or a single enrolment. Azure does not process any refund that '
      + 'would exceed it. The pool is shared — every cancellation under the same billing '
      + 'profile or EA enrolment draws from it.',
    example:
      'A three-year reservation at USD 100/month refunded in month 12 cancels USD 2,400 of '
      + 'commitment (the remaining 24 months). Your available limit drops to USD 47,600, and '
      + '365 days after that refund the USD 2,400 is added back.',
    source: 'refund',
  },
  {
    id: 'limit-locks-large',
    topic: 'limit',
    weight: 'blocker',
    question: 'Can a large reservation be uncancellable?',
    answer:
      'Effectively, yes — until enough of it is consumed. Because the cap applies to the '
      + 'commitment being cancelled, a reservation with more than USD 50,000 of commitment '
      + 'remaining cannot be refunded at all until the remainder falls under the cap.',
    example:
      'A three-year reservation at USD 3,000/month is a USD 108,000 commitment. You cannot '
      + 'cancel it until USD 58,000 of that commitment has been spent, leaving USD 50,000 '
      + 'that can be refunded or exchanged.',
    source: 'refund',
  },
  {
    id: 'limit-exchange-exempt',
    topic: 'limit',
    weight: 'note',
    question: 'Do exchanges eat into the USD 50,000?',
    answer:
      'No. Refunds that result from an exchange do not count against the refund limit, and '
      + 'there is no penalty or annual limit on exchanges. Where an exchange will do the job, '
      + 'it leaves the cancellation pool untouched.',
    source: 'refund',
  },
  {
    id: 'limit-csp',
    topic: 'limit',
    weight: 'note',
    question: 'How does the cap work in CSP?',
    answer: 'For the CSP program the USD 50,000 limit is per customer.',
    source: 'refund',
  },

  // ── Exchanges ─────────────────────────────────────────────────────────────
  {
    id: 'exchange-2027',
    topic: 'exchange',
    weight: 'blocker',
    question: 'Is the exchange right going away?',
    answer:
      'For most compute and database reservations, yes. From 1 February 2027, reservations '
      + 'purchased after that date are not eligible for exchange where the service is covered '
      + 'by savings plans — Azure Virtual Machines, Azure App Service, Azure SQL Database and '
      + 'similar. Reservations purchased before that date keep the right to one final exchange.',
    caution:
      'Products that become savings-plan eligible after 1 February 2027 fall under the same '
      + 'change, making previously purchased reservations exchangeable one final time.',
    source: 'refund',
  },
  {
    id: 'exchange-2027-exclusions',
    topic: 'exchange',
    weight: 'note',
    question: 'What is excluded from the 2027 change?',
    answer:
      'Reservations for products approaching end-of-life; reservations for products not '
      + 'covered by savings plans, such as Azure VMware Solution; and cloud environments that '
      + 'do not support savings plans. Instance size flexibility for virtual machines is '
      + 'unaffected, and the cancellation policy is not changing.',
    source: 'refund',
  },
  {
    id: 'exchange-family',
    topic: 'exchange',
    weight: 'blocker',
    question: 'Can I swap one kind of reservation for another?',
    answer:
      'Only within the same product family. Exchange-eligible compute reservations can move '
      + 'between Azure Virtual Machines, Azure Dedicated Host, Azure VMware Solution and '
      + 'Nutanix on Azure BareMetal; exchange-eligible SQL reservations between SQL Managed '
      + 'Instance, SQL Database and Elastic Pool. A Cosmos DB reservation cannot become a SQL '
      + 'Database reservation.',
    source: 'refund',
  },
  {
    id: 'exchange-value',
    topic: 'exchange',
    weight: 'cost',
    question: 'How much do I have to spend on the replacement?',
    answer:
      'At least the remaining commitment of the reservation you are trading in — the new '
      + "reservation's total lifetime commitment must be equal to or greater than it. If the "
      + 'new purchase comes to less than the refund, the portal refuses the exchange.',
    example:
      'Eighteen months into a three-year reservation at USD 100/month, the remaining '
      + 'commitment is USD 1,800, so the replacement must be worth USD 1,800 or more — '
      + 'monthly or upfront, it makes no difference.',
    source: 'refund',
  },
  {
    id: 'exchange-term-resets',
    topic: 'exchange',
    weight: 'cost',
    question: 'Does exchanging restart the clock?',
    answer:
      'Yes. The reservation bought as part of an exchange has a new term starting at the time '
      + 'of the exchange. An exchange is processed as a refund plus a repurchase, as separate '
      + 'transactions: the pro-rated residual value comes back, and you pay in full for the '
      + 'new one.',
    source: 'refund',
  },
  {
    id: 'exchange-premium-storage',
    topic: 'exchange',
    weight: 'note',
    question: 'Is the premium-storage swap really free?',
    answer:
      'Yes, within limits. Exchanging a VM size that does not support premium storage for the '
      + 'corresponding size that does — an F1 for an F1s, or the reverse — does not reset the '
      + 'term, does not create a new transaction, stays in the same region, and carries no '
      + 'charge. Change the size, series, region or payment frequency instead and the term '
      + 'resets.',
    source: 'refund',
  },
  {
    id: 'exchange-partial',
    topic: 'exchange',
    weight: 'note',
    question: 'Can I exchange only part of a reservation?',
    answer:
      'Yes. With multiple quantities you can exchange fewer than you own — 5 of 10, for '
      + 'example — and you can return several reservations in one action, provided the new '
      + 'purchase amount is greater than or equal to the amount returned.',
    source: 'refund',
  },

  // ── Savings plans ─────────────────────────────────────────────────────────
  {
    id: 'sp-final',
    topic: 'savings',
    weight: 'blocker',
    question: 'Can I cancel a savings plan?',
    answer:
      'No. All savings plan purchases are final. After you buy a savings plan you cannot '
      + 'cancel it, and you cannot exchange it for a reservation. There is no pro-rated '
      + 'refund and no cancellation window.',
    caution:
      'This is the single biggest difference from a reservation. A savings plan is committed '
      + 'money for the whole term the moment it is bought.',
    source: 'cancelSavingsPlan',
  },
  {
    id: 'sp-trade-in',
    topic: 'savings',
    weight: 'note',
    question: 'Can a reservation become a savings plan?',
    answer:
      'In that direction only. You can trade in select reservations for a new savings plan, '
      + 'and the trade-in policy is unchanged by the 2027 exchange restrictions. The reverse '
      + 'is not possible.',
    source: 'tradeIn',
  },

  // ── How the money comes back ──────────────────────────────────────────────
  {
    id: 'money-ea',
    topic: 'money',
    weight: 'note',
    question: 'Enterprise Agreement — where does the refund land?',
    answer:
      'Into the Azure Prepayment, if the original purchase used one. If that prepayment term '
      + 'is no longer active the credit goes to your current term and is valid for 90 days; '
      + 'unused credit expires at the end of the 90 days. If the reservation was originally '
      + 'bought from an overage, the refund comes back as a partial credit note and does not '
      + 'affect the original or later invoices.',
    caution:
      'The 90-day expiry is the trap: a refund taken with nothing planned to spend it on can '
      + 'simply lapse.',
    source: 'refund',
  },
  {
    id: 'money-mca',
    topic: 'money',
    weight: 'note',
    question: 'Microsoft Customer Agreement — where does the refund land?',
    answer:
      "Paying by wire transfer, the refunded amount is applied automatically to next month's "
      + 'invoice and no new invoice is raised. Paying by credit card, it is returned to the '
      + 'card used for the original purchase.',
    source: 'refund',
  },
  {
    id: 'money-csp',
    topic: 'money',
    weight: 'note',
    question: 'Pay-as-you-go invoicing and CSP — where does the refund land?',
    answer:
      'The original purchase invoice is cancelled and a new invoice is created. On an '
      + 'exchange the new invoice shows both the refund and the new purchase, with the refund '
      + 'set against the purchase. On a refund alone the pro-rated amount stays with Microsoft '
      + 'and is adjusted against a future reservation purchase.',
    caution:
      'A CSP refund without a repurchase does not return cash — it becomes credit against the '
      + 'next reservation you buy.',
    source: 'refund',
  },
  {
    id: 'money-paygo-move',
    topic: 'money',
    weight: 'note',
    question: 'We moved from pay-as-you-go to CSP mid-term.',
    answer:
      'A reservation bought at pay-as-you-go rates can be returned and repurchased without a '
      + 'penalty after moving to CSP.',
    source: 'refund',
  },

  // ── Who ───────────────────────────────────────────────────────────────────
  {
    id: 'who-owner',
    topic: 'who',
    weight: 'blocker',
    question: 'Who can actually press the button?',
    answer:
      'You need Owner or Reservation administrator access on the Reservation Order to '
      + 'exchange or refund it. Reader access on the reservation is enough to see utilisation '
      + 'but not to change anything.',
    source: 'manage',
  },
  {
    id: 'who-csp-customer',
    topic: 'who',
    weight: 'blocker',
    question: 'We are a CSP customer and the Exchange button does nothing.',
    answer:
      'That is expected. A CSP customer cannot exchange, cancel, renew or refund a '
      + 'reservation themselves — the partner has to do it on their behalf.',
    source: 'refund',
  },
  {
    id: 'who-where',
    topic: 'who',
    weight: 'note',
    question: 'Where in the portal?',
    answer:
      'Azure portal → Reservations. Select the reservations and choose Exchange, or open a '
      + 'single reservation and choose Return to refund it. When exchanging several at once, '
      + '"Optimize for utilization (7-day)" fills in return quantities from the last seven '
      + 'days of usage.',
    source: 'portal',
  },
];

export const WEIGHT_ORDER = { blocker: 0, cost: 1, note: 2 };

export const WEIGHT_LABEL = {
  blocker: 'Can stop you',
  cost: 'Costs money',
  note: 'Worth knowing',
};

/** Narrow the catalogue to a topic and/or a free-text query. */
export function findRules(rules, { topic = 'all', query = '' } = {}) {
  const q = String(query || '').trim().toLowerCase();
  return (rules || [])
    .filter(rule => (topic === 'all' || rule.topic === topic))
    .filter(rule => !q || [rule.question, rule.answer, rule.example, rule.caution]
      .some(text => String(text || '').toLowerCase().includes(q)))
    .sort((a, b) => (WEIGHT_ORDER[a.weight] ?? 9) - (WEIGHT_ORDER[b.weight] ?? 9));
}

/** The Microsoft article a rule was taken from, ready to link. */
export const sourceOf = (rule) => SOURCES[rule?.source] || null;

const DAY = 24 * 60 * 60 * 1000;

/** Whole days between two dates, in UTC — the basis Microsoft states it uses. */
export function daysBetween(from, to) {
  const a = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const b = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  return Math.round((b - a) / DAY);
}

/**
 * The published early termination fee rate -- reserved for future use by
 * Microsoft and not currently charged. Exported so the number on screen and the
 * number in the arithmetic can never drift apart.
 */
export const POSSIBLE_FEE_RATE = 0.12;

/** The rolling cancellation cap, in USD, per billing profile or enrolment. */
export const CANCELLATION_CAP_USD = 50000;

/**
 * What a cancellation would look like today.
 *
 * Deliberately returns `null` for anything it cannot compute rather than a
 * zero: on this page a zero refund and an unanswerable question look identical
 * on screen, and only one of them means "do not cancel".
 *
 * @param totalCommitment  the whole term's commitment, in the reservation's currency
 * @param termMonths       12 or 36
 * @param purchasedOn      ISO date of purchase
 * @param asOf             the date to value it at (defaults to today)
 * @param cancelledUsd     commitment already cancelled in the last 12 months, USD
 * @param usdRate          how many USD one unit of the commitment currency is worth
 */
export function estimateRefund({
  totalCommitment,
  termMonths,
  purchasedOn,
  asOf = new Date(),
  cancelledUsd = 0,
  usdRate = 1,
} = {}) {
  const commitment = Number(totalCommitment);
  const months = Number(termMonths);
  const start = purchasedOn ? new Date(purchasedOn) : null;
  if (!commitment || commitment <= 0) return null;
  if (!months || months <= 0) return null;
  if (!start || Number.isNaN(start.getTime())) return null;

  const end = new Date(start.getTime());
  end.setUTCMonth(end.getUTCMonth() + months);

  const termDays = daysBetween(start, end);
  const elapsedDays = Math.min(Math.max(daysBetween(start, asOf), 0), termDays);
  const remainingDays = termDays - elapsedDays;

  // The refund and the commitment being cancelled are the same money seen two
  // ways: what comes back to you, and what is charged against the cap.
  const refund = round2((commitment * remainingDays) / termDays);
  const cancelledCommitmentUsd = round2(refund * (Number(usdRate) || 1));

  const alreadyUsd = Math.max(0, Number(cancelledUsd) || 0);
  const remainingCapUsd = round2(Math.max(0, CANCELLATION_CAP_USD - alreadyUsd));
  const withinCap = cancelledCommitmentUsd <= remainingCapUsd;

  // How much of the commitment has to be consumed before the remainder drops
  // under the cap — the answer to "when does this become cancellable at all".
  const cancellableOn = withinCap ? null : dateWhenUnderCap({
    start, termDays, commitment, usdRate: Number(usdRate) || 1, capUsd: remainingCapUsd,
  });

  return {
    termDays,
    elapsedDays,
    remainingDays,
    consumed: round2(commitment - refund),
    refundNow: refund,
    // Not charged today. Shown so a reader can see the exposure if Microsoft
    // ever enables the fee it has reserved the right to charge.
    feeChargedToday: 0,
    possibleFee: round2(refund * POSSIBLE_FEE_RATE),
    refundIfFeeApplied: round2(refund * (1 - POSSIBLE_FEE_RATE)),
    cancelledCommitmentUsd,
    remainingCapUsd,
    withinCap,
    capShortfallUsd: withinCap ? 0 : round2(cancelledCommitmentUsd - remainingCapUsd),
    cancellableOn,
  };
}

/**
 * The first date on which the remaining commitment fits inside the cap.
 *
 * Straight-line, because the refund itself is straight-line by day.
 */
function dateWhenUnderCap({ start, termDays, commitment, usdRate, capUsd }) {
  if (capUsd <= 0) return null;
  const perDayUsd = (commitment * usdRate) / termDays;
  if (perDayUsd <= 0) return null;
  const remainingDaysAllowed = Math.floor(capUsd / perDayUsd);
  const dayIndex = termDays - remainingDaysAllowed;
  if (dayIndex <= 0) return null;
  return new Date(start.getTime() + dayIndex * DAY);
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * The rules that apply to a specific commitment on the page, so the reader is
 * not left to work out which half of the catalogue is about them.
 */
export function rulesFor(item) {
  if (!item) return [];
  if (item.kind === 'savings-plan') {
    return RULES.filter(r => r.topic === 'savings' || r.id === 'who-owner');
  }
  return RULES.filter(r => r.topic !== 'savings');
}

/**
 * What would actually happen if this particular commitment were cancelled.
 *
 * The rules catalogue answers "what are the rules"; this answers "what happens
 * to mine", which is the question somebody looking at an underused reservation
 * is really asking. Everything returned is derived from the commitment in front
 * of the reader, so nothing here applies a reservation rule to a savings plan
 * or quotes a refund for something that cannot be refunded at all.
 *
 * Severities match the rest of the page: `blocker` means the action is not
 * available, `cost` means it is available but has a price, `note` is context.
 */
export function cancellationImpact(item, { grain = 30, today = new Date() } = {}) {
  if (!item) return [];
  const out = [];
  const used = (item.utilisation || {})[grain] ?? (item.utilisation || {})[String(grain)] ?? null;

  if (item.kind === 'savings-plan') {
    // Not a warning about a penalty: there is no cancellation to price.
    out.push({
      id: 'sp-final',
      severity: 'blocker',
      title: 'This savings plan cannot be cancelled',
      detail: 'Savings plan purchases are final. Microsoft does not cancel, refund or '
        + 'exchange them, so the commitment runs to the end of its term whatever the '
        + 'utilisation says.',
      source: SOURCES.cancelSavingsPlan,
    });
    out.push({
      id: 'sp-recover',
      severity: 'note',
      title: 'The only lever is usage, not cancellation',
      detail: 'Because the money is already committed, the recovery is to move eligible '
        + 'workloads into the plan\u2019s scope so the hourly commitment is consumed rather '
        + 'than wasted. Widening the scope to shared is usually the quickest change.',
      source: SOURCES.utilisation,
    });
    return out;
  }

  const type = (item.resource_type || '').toLowerCase();
  if (/redhat|red hat|suse|databricks|pre-purchase|prepurchase/.test(type)) {
    out.push({
      id: 'non-refundable',
      severity: 'blocker',
      title: 'This reservation type is not refundable',
      detail: 'Red Hat, SUSE and pre-purchase plans are bought outright. They cannot be '
        + 'cancelled or exchanged, so an underused one has to be consumed or written off.',
      source: SOURCES.refund,
    });
    return out;
  }

  out.push({
    id: 'refund-prorated',
    severity: 'cost',
    title: 'You get back the unused part, not the whole purchase',
    detail: 'The refund is prorated across the days left in the term and paid on the '
      + 'lower of what you paid and today\u2019s price. Everything consumed so far is gone '
      + 'whichever way the decision goes.',
    source: SOURCES.refund,
  });

  out.push({
    id: 'cap',
    severity: 'cost',
    title: `Counts against the USD ${CANCELLATION_CAP_USD.toLocaleString('en-US')} cancellation cap`,
    detail: 'Microsoft limits cancelled commitment to USD 50,000 in any rolling 12 months '
      + 'per billing profile or enrolment. Cancelling this one uses part of that allowance '
      + 'and blocks other cancellations until it replenishes 365 days later. Exchanges are '
      + 'exempt, so an exchange may be possible where a refund is not.',
    source: SOURCES.refund,
  });

  if (used !== null && used >= GOOD_ABOVE_USED) {
    out.push({
      id: 'well-used',
      severity: 'note',
      title: `This one is ${used}% used over ${grain} days`,
      detail: 'Cancelling it moves the covered usage back to pay-as-you-go rates, so the '
        + 'bill for the same workload goes up. The refund is a one-off; the higher rate is '
        + 'every month after.',
      source: SOURCES.utilisation,
    });
  }

  out.push({
    id: 'exchange-first',
    severity: 'note',
    title: 'An exchange is usually the better move',
    detail: 'Exchanging into the SKU or region you actually use is refund-and-repurchase '
      + 'in one step, is exempt from the cancellation cap, and keeps the discount. The '
      + 'replacement must commit at least as much as the remainder of this one, and its '
      + 'term restarts. From 1 February 2027 exchanges are restricted for services a '
      + 'savings plan can cover.',
    source: SOURCES.tradeIn,
  });

  const term = /^P(\d+)Y$/i.exec(item.term || '');
  const refund = term ? estimateRefund({
    totalCommitment: item.monthly_cost ? item.monthly_cost * Number(term[1]) * 12 : 0,
    termMonths: Number(term[1]) * 12,
    purchasedOn: item.purchase_date,
    asOf: today,
  }) : null;
  if (refund) {
    out.push({
      id: 'timing',
      severity: 'note',
      title: `${refund.remainingDays} of ${refund.termDays} days left on the term`,
      detail: 'The refund shrinks every day, so the arithmetic below is only true today. '
        + 'The estimate uses amortised cost because Azure does not report the purchase '
        + 'price here \u2014 check the reservation order in the portal before acting on it.',
      source: SOURCES.portal,
    });
  }

  out.push({
    id: 'permission',
    severity: 'note',
    title: 'Who can actually do it',
    detail: 'Only an Owner or a Reservation administrator on the Reservation Order can '
      + 'cancel or exchange. Rights on the subscription the reservation applies to are not '
      + 'enough. CSP customers cannot self-serve at all and must go through their partner.',
    source: SOURCES.manage,
  });

  return out;
}

/** Utilisation at or above which cancelling is likely to cost more than it returns. */
const GOOD_ABOVE_USED = 90;
