"""
What one resource cost, period by period, lined up against when it changed.

A change timeline says a VM was resized from four cores to eight on the 14th.
That is interesting. What people actually want to know is what it did to the
bill, and answering that needs the two series side by side: the events from our
snapshots, and the spend from Cost Management, joined on the period the event
falls in.

Everything here is pure. The Azure reads happen in the router; this module only
arranges what came back, which is what makes it testable without a tenant.
"""
from typing import Any, Dict, List, Optional

MONTHLY = "monthly"
DAILY = "daily"

# Below this, a "change" in spend is rounding and currency noise rather than
# anything anybody did. Reporting a 900% rise on half a cent is technically
# accurate and completely useless.
COST_EPSILON = 0.01


def _amount(record: Dict[str, Any]) -> float:
    for key in ("PreTaxCost", "Cost", "totalCost"):
        value = record.get(key)
        if value is not None:
            try:
                return float(value)
            except (TypeError, ValueError):
                return 0.0
    return 0.0


def _raw_date(record: Dict[str, Any]) -> str:
    raw = record.get("UsageDate") or record.get("Date") or record.get("BillingMonth") or ""
    return str(raw).strip()


def period_of(raw_date: str, granularity: str) -> str:
    """
    The bucket a usage row belongs to, as `YYYY-MM` or `YYYY-MM-DD`.

    Cost Management returns dates as integers like 20260114, and sometimes as
    ISO strings depending on the granularity and the API version. Both are
    handled here so callers never have to care which one they got.
    """
    text = raw_date.replace("-", "").split("T")[0]
    if len(text) < 6 or not text[:6].isdigit():
        return ""
    month = f"{text[:4]}-{text[4:6]}"
    if granularity == DAILY and len(text) >= 8 and text[:8].isdigit():
        return f"{month}-{text[6:8]}"
    return month


def _resource_id_of(record: Dict[str, Any]) -> str:
    for key in ("ResourceId", "resourceId", "Resource"):
        value = record.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def cost_series(
    records: List[Dict[str, Any]],
    resource_id: str,
    granularity: str = MONTHLY,
) -> List[Dict[str, Any]]:
    """
    One row per period for a single resource, oldest first.

    Matched case-insensitively on purpose: Resource Graph and Cost Management
    disagree about the casing of resource ids -- typically `resourcegroups`
    against `resourceGroups` -- and an exact string match silently returns
    nothing at all, which reads on screen as "this resource is free".
    """
    wanted = (resource_id or "").strip().lower()
    if not wanted:
        return []

    totals: Dict[str, float] = {}
    for record in records:
        if _resource_id_of(record).lower() != wanted:
            continue
        period = period_of(_raw_date(record), granularity)
        if not period:
            continue
        totals[period] = totals.get(period, 0.0) + _amount(record)

    return [
        {"period": period, "cost": round(totals[period], 2)}
        for period in sorted(totals)
    ]


def _period_index(series: List[Dict[str, Any]]) -> Dict[str, int]:
    return {row["period"]: index for index, row in enumerate(series)}


def attach_cost(
    events: List[Dict[str, Any]],
    series: List[Dict[str, Any]],
    granularity: str = MONTHLY,
) -> List[Dict[str, Any]]:
    """
    Put the spend either side of each change next to the change itself.

    The comparison is deliberately the period *before* against the period
    *after*, skipping the one the change landed in. A resize on the 14th leaves
    that month half billed at the old size and half at the new, so comparing it
    against either neighbour understates the move -- and understating it is how
    a real doubling gets dismissed as noise.

    When there is no later period yet, the change's own period is used and the
    row is marked partial, because a month still in progress compared against a
    complete one is not a like-for-like number and should not be read as one.
    """
    if not series:
        return [dict(event) for event in events]

    index = _period_index(series)
    enriched: List[Dict[str, Any]] = []

    for event in events:
        period = period_of(str(event.get("at") or ""), granularity)
        position = index.get(period)

        before = after = None
        partial = False

        if position is not None:
            if position > 0:
                before = series[position - 1]
            if position + 1 < len(series):
                after = series[position + 1]
            else:
                after = series[position]
                partial = True

        delta = None
        delta_pct = None
        if before and after:
            delta = round(after["cost"] - before["cost"], 2)
            if abs(before["cost"]) > COST_EPSILON:
                delta_pct = round((delta / before["cost"]) * 100, 1)
            elif abs(delta) > COST_EPSILON:
                # Went from nothing to something. A percentage against zero is
                # infinity, which no chart can draw and no reader can use.
                delta_pct = None

        enriched.append({
            **event,
            "cost_period": period,
            "cost_before": before["cost"] if before else None,
            "cost_after": after["cost"] if after else None,
            "cost_before_period": before["period"] if before else None,
            "cost_after_period": after["period"] if after else None,
            "cost_delta": delta,
            "cost_delta_pct": delta_pct,
            # True when the "after" figure is a period still being billed.
            "cost_after_partial": partial,
        })

    return enriched


def summarise(series: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Headline figures for the resource across everything we fetched."""
    if not series:
        return {
            "total": 0.0,
            "latest": None,
            "latest_period": None,
            "periods": 0,
            "average": 0.0,
        }

    total = sum(row["cost"] for row in series)
    return {
        "total": round(total, 2),
        "latest": series[-1]["cost"],
        "latest_period": series[-1]["period"],
        "periods": len(series),
        "average": round(total / len(series), 2),
    }


def subscription_of(resource_id: str) -> Optional[str]:
    """
    The subscription an Azure resource id belongs to.

    Read from the id rather than asked for, so a caller opening one resource
    does not have to pass the whole estate's subscription list and we do not
    query cost for subscriptions the answer cannot possibly come from.
    """
    parts = [p for p in (resource_id or "").split("/") if p]
    for index, part in enumerate(parts):
        if part.lower() == "subscriptions" and index + 1 < len(parts):
            return parts[index + 1]
    return None
