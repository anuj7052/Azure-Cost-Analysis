"""
Deciding which cost changes are worth a person's attention.

The previous rule was a single line: flag any service whose month-over-month
cost rose more than 20%, then sort by percentage. Three things follow from that
which are worse than having no detection at all.

**A percentage is not an amount.** A meter that went from ₹0.04 to ₹0.90 is up
2,150% and sorted straight to the top, above a database that quietly added
₹18,000. Ranking by percentage systematically promotes the least important
findings, and a list whose first row never matters is a list nobody reads
twice.

**Rounding noise looked like a spike.** Costs arrive with fractional precision,
so a service resting at effectively zero produces enormous percentages from
nothing at all — the "Key Vault, +200%, previous ₹0, current ₹0, increase ₹0"
row, which is arithmetic on dust presented as a finding.

**A new cost was invisible.** `if previous == 0: continue` skipped exactly the
case that most deserves attention: something that was not running last month
and is running now. The one change guaranteed to be a deployment was the one
change never reported.

So this module separates the two questions the old code conflated. *Did this
change?* is a percentage. *Does it matter?* is an amount, judged against the
size of the bill it belongs to — which also sidesteps having to hard-code a
threshold in a currency, since a rule written in rupees is wrong for an account
billed in dollars and there is no honest way to convert one without a rate.

Nothing here decides *why* a cost moved. Billing data records what was charged,
not what anybody did, and a guess phrased as a cause is worse than no cause at
all.
"""
from typing import Any, Dict, Iterable, List, Optional, Tuple

# Costs are reported to more decimal places than money has. Anything under half
# a cent renders as 0.00, and a change between two numbers that both display as
# zero is not a change anybody can act on -- it is rounding presented as news.
ZERO_EPSILON = 0.005

# The detection threshold stays at 20% because it is the established rule of
# this product and people have calibrated their expectations to it. What has
# changed is what happens after detection: ranking and severity are decided by
# money, not by this number.
DEFAULT_THRESHOLD_PCT = 20.0

# Impact bands, expressed as a share of the period's total spend rather than as
# an absolute figure. An account spending ₹200 a month and one spending ₹2m
# both get a sensible answer, and neither needs an exchange rate.
CRITICAL_SHARE = 0.10
HIGH_SHARE = 0.05
MEDIUM_SHARE = 0.01

DIRECTION_INCREASE = "increase"
DIRECTION_DECREASE = "decrease"
DIRECTION_NEW = "new"
DIRECTION_REMOVED = "removed"
DIRECTION_FLAT = "flat"

IMPACT_CRITICAL = "critical"
IMPACT_HIGH = "high"
IMPACT_MEDIUM = "medium"
IMPACT_LOW = "low"
IMPACT_NONE = "none"

_IMPACT_RANK = {
    IMPACT_CRITICAL: 4,
    IMPACT_HIGH: 3,
    IMPACT_MEDIUM: 2,
    IMPACT_LOW: 1,
    IMPACT_NONE: 0,
}


def is_zero(value: float) -> bool:
    """True when a cost is indistinguishable from nothing at display precision."""
    return abs(float(value or 0.0)) < ZERO_EPSILON


def pct_change(current: float, previous: float) -> Optional[float]:
    """
    Percentage change, or None when the question does not apply.

    Growth from zero has no percentage. The old code returned nothing here and
    callers rendered the gap as `∞%` or `NaN%`; returning None explicitly means
    the caller has to decide what to say, and the honest thing to say is "new",
    not a number.
    """
    previous = float(previous or 0.0)
    if is_zero(previous):
        return None
    return round((float(current or 0.0) - previous) / abs(previous) * 100, 2)


def direction_of(current: float, previous: float) -> str:
    """
    Which of the five things happened.

    "New" and "removed" are kept apart from "increase" and "decrease" because
    they call for different actions: an increase is a question about capacity,
    whereas a new cost is a question about what was deployed, and a removed one
    is a question about whether something was meant to stop.
    """
    curr_zero, prev_zero = is_zero(current), is_zero(previous)

    if curr_zero and prev_zero:
        return DIRECTION_FLAT
    if prev_zero:
        return DIRECTION_NEW
    if curr_zero:
        return DIRECTION_REMOVED

    delta = float(current) - float(previous)
    if is_zero(delta):
        return DIRECTION_FLAT
    return DIRECTION_INCREASE if delta > 0 else DIRECTION_DECREASE


def impact_of(delta: float, total_spend: float) -> str:
    """
    How much this change matters to the bill it belongs to.

    Judged on the absolute amount, because that is what appears on the invoice.
    A share of total is used rather than a fixed figure so the same code is
    correct for a hobby subscription and an enterprise estate, and so no
    currency is baked in.
    """
    amount = abs(float(delta or 0.0))
    if is_zero(amount):
        return IMPACT_NONE

    total = abs(float(total_spend or 0.0))
    if is_zero(total):
        # Money moved, but there is no bill to measure it against. Saying
        # "low" would be a guess; "medium" at least does not dismiss it.
        return IMPACT_MEDIUM

    share = amount / total
    if share >= CRITICAL_SHARE:
        return IMPACT_CRITICAL
    if share >= HIGH_SHARE:
        return IMPACT_HIGH
    if share >= MEDIUM_SHARE:
        return IMPACT_MEDIUM
    return IMPACT_LOW


def severity_of(pct: Optional[float], impact: str) -> str:
    """
    Severity is impact first, percentage second.

    A large percentage on a trivial amount is not urgent, and this is the whole
    reason the old ranking misled: it read the two as interchangeable. The
    percentage can only promote something that already carries real money, and
    it can never rescue something that does not.
    """
    if impact == IMPACT_NONE:
        return IMPACT_NONE

    # A steep rise on top of an already-significant amount is the genuinely
    # alarming combination, and the only route to critical.
    if impact in (IMPACT_CRITICAL, IMPACT_HIGH) and pct is not None and pct >= 100:
        return IMPACT_CRITICAL
    return impact


def materiality_note(pct: Optional[float], impact: str, direction: str) -> str:
    """
    The sentence that stops a reader misreading their own data.

    A row showing +2,020% is going to alarm somebody regardless of the amount
    beside it. Saying so in words, next to the number, is the difference
    between a report and a scare.
    """
    if impact == IMPACT_NONE:
        return "No material cost impact."
    if direction == DIRECTION_NEW:
        return "This cost did not exist in the previous period."
    if direction == DIRECTION_REMOVED:
        return "This cost stopped during the current period."
    if pct is not None and pct >= 100 and impact == IMPACT_LOW:
        return "Large percentage increase, but a small absolute impact."
    if pct is not None and abs(pct) < 25 and impact in (IMPACT_CRITICAL, IMPACT_HIGH):
        return "Small percentage change, but a large absolute impact."
    return ""


def _key_of(record: Dict[str, Any], dimensions: Tuple[str, ...]) -> Tuple:
    return tuple(record.get(d) or "" for d in dimensions)


def _sum_by_key(
    records: Iterable[Dict[str, Any]],
    dimensions: Tuple[str, ...],
    cost_field: str,
) -> Dict[Tuple, Dict[str, Any]]:
    totals: Dict[Tuple, Dict[str, Any]] = {}
    for r in records:
        key = _key_of(r, dimensions)
        entry = totals.setdefault(key, {"cost": 0.0, "sample": r})
        entry["cost"] += float(r.get(cost_field) or 0.0)
    return totals


def compare_periods(
    current: Iterable[Dict[str, Any]],
    previous: Iterable[Dict[str, Any]],
    *,
    dimensions: Tuple[str, ...] = ("service", "subscription_id"),
    cost_field: str = "cost",
    threshold_pct: float = DEFAULT_THRESHOLD_PCT,
) -> List[Dict[str, Any]]:
    """
    Every cost change between two periods, classified but not yet filtered.

    Grouping is by whatever dimensions the caller asks for, and both are
    grouped identically. The old code attributed a service-level spike to
    *every* subscription active that month, which meant a spike in one
    subscription was reported against all of them -- a wrong answer that looked
    like a thorough one. Comparing like with like on a shared key is what makes
    the attribution mean anything.

    Returned in financial-impact order. Callers filter; this only measures.
    """
    current = list(current)
    previous = list(previous)

    curr_totals = _sum_by_key(current, dimensions, cost_field)
    prev_totals = _sum_by_key(previous, dimensions, cost_field)

    # Impact is judged against the larger of the two periods so that a month in
    # which spend collapsed does not make every remaining change look enormous.
    total_spend = max(
        sum(v["cost"] for v in curr_totals.values()),
        sum(v["cost"] for v in prev_totals.values()),
    )

    changes: List[Dict[str, Any]] = []
    for key in set(curr_totals) | set(prev_totals):
        curr_cost = curr_totals.get(key, {}).get("cost", 0.0)
        prev_cost = prev_totals.get(key, {}).get("cost", 0.0)
        sample = (curr_totals.get(key) or prev_totals.get(key))["sample"]

        delta = curr_cost - prev_cost
        pct = pct_change(curr_cost, prev_cost)
        direction = direction_of(curr_cost, prev_cost)
        impact = impact_of(delta, total_spend)
        severity = severity_of(pct, impact)

        row = {
            "key": "|".join(str(k) for k in key),
            "previous_cost": round(prev_cost, 2),
            "current_cost": round(curr_cost, 2),
            "delta": round(delta, 2),
            # None, not Infinity and not 9999: there is no percentage change
            # from zero, and every fake stand-in for that fact has ended up
            # rendered on screen at some point.
            "pct_change": pct,
            "direction": direction,
            "impact": impact,
            "severity": severity,
            "note": materiality_note(pct, impact, direction),
            "meets_threshold": pct is not None and pct >= threshold_pct,
        }
        for d in dimensions:
            row[d] = sample.get(d) or ""
        changes.append(row)

    # Financial impact first. Percentage is the tie-break, not the ranking:
    # ₹1 -> ₹100 is not more urgent than ₹10,000 -> ₹12,000.
    changes.sort(key=lambda c: (abs(c["delta"]), _IMPACT_RANK[c["impact"]]), reverse=True)
    return changes


def split_changes(
    changes: Iterable[Dict[str, Any]],
    *,
    threshold_pct: float = DEFAULT_THRESHOLD_PCT,
) -> Dict[str, List[Dict[str, Any]]]:
    """
    Sort classified changes into the buckets the page presents.

    Reductions are deliberately *not* called savings. A cost that fell because
    a workload was rightsized is a saving; a cost that fell because a customer
    stopped using the product, or because a resource was deleted by accident,
    is not. Billing data cannot tell those apart, so this returns
    `reductions` and leaves the word "savings" to whatever can prove it.
    """
    anomalies: List[Dict[str, Any]] = []
    new_costs: List[Dict[str, Any]] = []
    removed: List[Dict[str, Any]] = []
    reductions: List[Dict[str, Any]] = []
    immaterial: List[Dict[str, Any]] = []

    for change in changes:
        if change["impact"] == IMPACT_NONE:
            # Kept rather than dropped: the reader is entitled to see that a
            # service was considered and found to be noise, instead of
            # wondering why it is missing.
            immaterial.append(change)
            continue

        direction = change["direction"]
        if direction == DIRECTION_NEW:
            new_costs.append(change)
        elif direction == DIRECTION_REMOVED:
            removed.append(change)
        elif direction == DIRECTION_DECREASE:
            reductions.append(change)
        elif direction == DIRECTION_INCREASE and change["meets_threshold"]:
            anomalies.append(change)
        else:
            immaterial.append(change)

    return {
        "anomalies": anomalies,
        "new_costs": new_costs,
        "removed_costs": removed,
        "reductions": reductions,
        "immaterial": immaterial,
    }


def summarise(buckets: Dict[str, List[Dict[str, Any]]]) -> Dict[str, Any]:
    """
    The KPI figures, computed once so the cards and the table cannot disagree.

    `verified_savings` is deliberately absent rather than zero. A ₹0 in a
    savings box reads as "we checked and there were none", when the truth is
    "nothing here can prove a saving". Those are different statements and only
    one of them is true.
    """
    anomalies = buckets["anomalies"]
    new_costs = buckets["new_costs"]
    increases = anomalies + new_costs

    by_severity = {IMPACT_CRITICAL: 0, IMPACT_HIGH: 0, IMPACT_MEDIUM: 0, IMPACT_LOW: 0}
    for a in increases:
        if a["severity"] in by_severity:
            by_severity[a["severity"]] += 1

    largest = max(increases, key=lambda c: c["delta"], default=None)

    return {
        "anomaly_count": len(anomalies),
        "new_cost_count": len(new_costs),
        "removed_cost_count": len(buckets["removed_costs"]),
        "reduction_count": len(buckets["reductions"]),
        "by_severity": by_severity,
        "total_increase": round(sum(c["delta"] for c in increases), 2),
        "total_reduction": round(
            sum(-c["delta"] for c in buckets["reductions"] + buckets["removed_costs"]), 2
        ),
        "largest_increase": largest,
        # Not zero. Absent, because it cannot be established from billing data
        # alone, and a number here would be an invention.
        "verified_savings": None,
    }
