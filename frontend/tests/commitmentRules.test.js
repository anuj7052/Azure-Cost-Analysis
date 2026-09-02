/**
 * Commitment rules.
 *
 * Two kinds of test here and they are guarding different things. The first
 * kind checks the arithmetic of the refund estimator. The second kind checks
 * the rule catalogue itself -- that every claim still carries a working
 * Microsoft source, and that the two facts most often got wrong (savings plans
 * cannot be cancelled; the 12% fee is not being charged) are still stated the
 * way Microsoft states them. If somebody edits the copy into something more
 * confident than the policy, these fail.
 */
import { describe, expect, it } from 'vitest';

import {
  CANCELLATION_CAP_USD, POSSIBLE_FEE_RATE, RULES, SOURCES, TOPICS,
  daysBetween, estimateRefund, findRules, rulesFor, sourceOf,
} from '../src/utils/commitmentRules';

const at = (iso) => new Date(`${iso}T00:00:00Z`);

describe('refund arithmetic', () => {
  // Microsoft's own worked example: bought 10 July 2024, cancelled 9 July 2025
  // on a one-year term leaves a single day, and a refund to match. Anything
  // that rounds to months would return a month's money here.
  it('refunds by remaining days, not remaining months', () => {
    const r = estimateRefund({
      totalCommitment: 3650, termMonths: 12,
      purchasedOn: '2024-07-10', asOf: at('2025-07-09'),
    });
    expect(r.remainingDays).toBe(1);
    expect(r.refundNow).toBeLessThan(15);
    expect(r.refundNow).toBeGreaterThan(0);
  });

  it('counts days in UTC', () => {
    expect(daysBetween(at('2026-01-01'), at('2026-01-31'))).toBe(30);
  });

  it('refunds the whole commitment on the day of purchase', () => {
    const r = estimateRefund({
      totalCommitment: 1200, termMonths: 12,
      purchasedOn: '2026-01-01', asOf: at('2026-01-01'),
    });
    expect(r.refundNow).toBe(1200);
    expect(r.consumed).toBe(0);
  });

  it('refunds nothing once the term is over, and never goes negative', () => {
    const r = estimateRefund({
      totalCommitment: 1200, termMonths: 12,
      purchasedOn: '2026-01-01', asOf: at('2030-01-01'),
    });
    expect(r.refundNow).toBe(0);
    expect(r.remainingDays).toBe(0);
  });

  // The fee is the thing most likely to be misread off this screen. It must
  // read as zero today and be shown separately as an exposure.
  it('charges no early termination fee today', () => {
    const r = estimateRefund({
      totalCommitment: 1200, termMonths: 12,
      purchasedOn: '2026-01-01', asOf: at('2026-07-01'),
    });
    expect(r.feeChargedToday).toBe(0);
    expect(r.possibleFee).toBeCloseTo(r.refundNow * POSSIBLE_FEE_RATE, 1);
    expect(r.refundIfFeeApplied).toBeLessThan(r.refundNow);
  });

  it('returns nothing rather than a zero when it cannot compute', () => {
    expect(estimateRefund({})).toBeNull();
    expect(estimateRefund({ totalCommitment: 100, termMonths: 12 })).toBeNull();
    expect(estimateRefund({ totalCommitment: 0, termMonths: 12, purchasedOn: '2026-01-01' }))
      .toBeNull();
    expect(estimateRefund({ totalCommitment: 100, termMonths: 12, purchasedOn: 'nonsense' }))
      .toBeNull();
  });
});

describe('the USD 50,000 rolling cap', () => {
  it('passes a small cancellation', () => {
    const r = estimateRefund({
      totalCommitment: 3600, termMonths: 36,
      purchasedOn: '2026-01-01', asOf: at('2026-07-01'),
    });
    expect(r.withinCap).toBe(true);
    expect(r.capShortfallUsd).toBe(0);
  });

  // Microsoft's second worked example: a USD 108,000 commitment cannot be
  // cancelled until USD 58,000 of it has been spent.
  it('refuses a cancellation larger than the cap and says when it becomes possible', () => {
    const r = estimateRefund({
      totalCommitment: 108000, termMonths: 36,
      purchasedOn: '2026-01-01', asOf: at('2026-06-01'),
    });
    expect(r.withinCap).toBe(false);
    expect(r.capShortfallUsd).toBeGreaterThan(0);
    expect(r.cancellableOn).toBeInstanceOf(Date);
    // It becomes cancellable once the remaining commitment is USD 50,000, which
    // on a straight line is a little past the halfway mark of the term.
    expect(r.cancellableOn.toISOString().slice(0, 7)).toBe('2027-08');
  });

  it('depletes the pool with what has already been cancelled', () => {
    const args = {
      totalCommitment: 20000, termMonths: 36,
      purchasedOn: '2026-01-01', asOf: at('2026-02-01'),
    };
    expect(estimateRefund(args).withinCap).toBe(true);
    expect(estimateRefund({ ...args, cancelledUsd: 45000 }).withinCap).toBe(false);
    expect(estimateRefund({ ...args, cancelledUsd: 45000 }).remainingCapUsd).toBe(5000);
  });

  it('converts a non-USD commitment before testing it against a USD cap', () => {
    const inr = estimateRefund({
      totalCommitment: 8000000, termMonths: 36,
      purchasedOn: '2026-01-01', asOf: at('2026-01-01'), usdRate: 0.012,
    });
    expect(inr.cancelledCommitmentUsd).toBe(96000);
    expect(inr.withinCap).toBe(false);
  });

  it('states the cap as the number Microsoft publishes', () => {
    expect(CANCELLATION_CAP_USD).toBe(50000);
    expect(POSSIBLE_FEE_RATE).toBe(0.12);
  });
});

describe('the rule catalogue', () => {
  it('cites a real Microsoft article for every rule', () => {
    for (const rule of RULES) {
      const source = sourceOf(rule);
      expect(source, rule.id).toBeTruthy();
      expect(source.url).toMatch(/^https:\/\/(learn\.microsoft\.com|portal\.azure\.com)\//);
    }
  });

  it('files every rule under a topic the page can show', () => {
    const topics = new Set(TOPICS.map(t => t.key));
    for (const rule of RULES) expect(topics.has(rule.topic), rule.id).toBe(true);
  });

  it('gives every rule a unique id', () => {
    expect(new Set(RULES.map(r => r.id)).size).toBe(RULES.length);
  });

  // The savings plan rule is the one that costs the most to get wrong, because
  // the mistake is only discovered after the money is spent.
  it('states plainly that a savings plan cannot be cancelled', () => {
    const rule = RULES.find(r => r.id === 'sp-final');
    expect(rule.weight).toBe('blocker');
    expect(rule.answer.toLowerCase()).toContain('cannot cancel it');
    expect(sourceOf(rule).url).toContain('savings-plan/cancel-savings-plan');
  });

  it('does not present the 12% fee as a live charge', () => {
    const rule = RULES.find(r => r.id === 'refund-fee');
    expect(rule.answer).toContain('no early termination fee being charged today');
    expect(rule.answer).toContain('might in future');
  });

  it('keeps exchanges out of the cancellation cap', () => {
    const rule = RULES.find(r => r.id === 'limit-exchange-exempt');
    expect(rule.answer).toContain('do not count against the refund limit');
  });
});

describe('finding rules', () => {
  it('orders blockers above costs above notes', () => {
    const weights = findRules(RULES, {}).map(r => r.weight);
    expect(weights.indexOf('blocker')).toBe(0);
    expect(weights.lastIndexOf('blocker')).toBeLessThan(weights.indexOf('note'));
  });

  it('narrows to a topic', () => {
    const found = findRules(RULES, { topic: 'savings' });
    expect(found.length).toBeGreaterThan(0);
    expect(found.every(r => r.topic === 'savings')).toBe(true);
  });

  it('searches the answers and the examples, not just the questions', () => {
    expect(findRules(RULES, { query: 'F1s' }).map(r => r.id))
      .toContain('exchange-premium-storage');
    expect(findRules(RULES, { query: '47,600' }).map(r => r.id)).toContain('limit-50k');
  });

  it('finds nothing rather than everything for an unmatched query', () => {
    expect(findRules(RULES, { query: 'zzzzz' })).toEqual([]);
  });

  // A savings plan holder reading reservation exchange rules will reach exactly
  // the wrong conclusion, so the two sets never mix.
  it('shows a savings plan only the rules that apply to it', () => {
    const found = rulesFor({ kind: 'savings-plan' });
    expect(found.map(r => r.id)).toContain('sp-final');
    expect(found.map(r => r.id)).not.toContain('exchange-family');
  });

  it('shows a reservation everything except the savings plan rules', () => {
    const found = rulesFor({ kind: 'reservation' });
    expect(found.map(r => r.id)).toContain('refund-prorated');
    expect(found.map(r => r.id)).not.toContain('sp-final');
  });

  it('lists every source it cites', () => {
    for (const rule of RULES) expect(SOURCES[rule.source], rule.id).toBeTruthy();
  });
});
