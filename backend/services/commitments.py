"""
Reservations and savings plans -- what you have committed to, and whether you
are using it.

A commitment is a promise to spend, made in advance, in exchange for a lower
rate. Two things go wrong with them and they fail in opposite directions: one
expires and the rate silently reverts to pay-as-you-go, or one sits underused
and you pay for hours nobody consumed. Both are invisible on a normal cost
report, because in the first case the bill goes up for no visible reason and in
the second it does not move at all.

Two rules shape this module.

Utilisation percentages come from Azure's own aggregates and are never
recomputed here. Azure knows which hours a reservation actually absorbed;
inferring that from cost records would produce a confident number that quietly
disagrees with the portal, and a wrong utilisation figure is worse than none
because people cancel real commitments on the strength of it.

Money is only ever reported when a cost query returned it. Wastage in
particular is a product of two numbers, and if either is missing the answer is
"Not available" rather than a plausible-looking figure. A fabricated wastage
number is an argument for cancelling a commitment somebody is relying on.
"""
import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

import httpx

from services import azure_retry

log = logging.getLogger(__name__)

MGMT_BASE = "https://management.azure.com"

# Reservations and savings plans are read tenant-wide rather than per
# subscription: a single reservation can apply across many subscriptions, and
# asking each subscription separately would report the same commitment many
# times over.
RESERVATIONS_URL = (
    f"{MGMT_BASE}/providers/Microsoft.Capacity/reservations"
    "?api-version=2022-11-01&$refreshSummary=true"
)
SAVINGS_PLANS_URL = (
    f"{MGMT_BASE}/providers/Microsoft.BillingBenefits/savingsPlans"
    "?api-version=2022-11-01&$refreshSummary=true"
)
RECOMMENDATIONS_API = "2023-05-01"
COST_API_VERSION = "2023-11-01"

RESERVATION = "reservation"
SAVINGS_PLAN = "savings-plan"

# The grains Azure actually publishes. Offering a 90-day window in the UI would
# invite a question this data cannot answer.
UTILISATION_GRAINS = (1, 7, 30)
DEFAULT_GRAIN = 30

# Expiry bands. A reservation that lapses does not fail loudly -- the rate just
# reverts -- so the warning has to arrive with enough time to act on it, and a
# three-year renewal is not a same-week decision.
CRITICAL_DAYS = 30
WARNING_DAYS = 60
WATCH_DAYS = 90

# Below this, a commitment is paying for hours nobody used. Chosen to sit under
# the break-even point of most one-year terms rather than at a round number,
# so the flag means "this is probably costing you money" and not "this is not
# a perfect score".
UNDERUSED_BELOW = 80.0

EXPIRED = "expired"
ACTIVE = "active"


def _text(value: Any) -> str:
    return str(value) if value is not None else ""


def _number(value: Any) -> Optional[float]:
    """
    A float, or None -- never a defaulted zero.

    Zero is a real and meaningful utilisation figure. Turning a missing value
    into one would report an unused commitment where there is only an unread
    one, and that is an argument for cancelling something in active use.
    """
    if value is None or isinstance(value, bool):
        return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if out == out and out not in (float("inf"), float("-inf")) else None


async def _get_all(url: str, token: str, timeout: int = 60) -> List[Dict[str, Any]]:
    """Follow `nextLink` to the end and return every `value` entry."""
    headers = {"Authorization": f"Bearer {token}"}
    out: List[Dict[str, Any]] = []
    async with httpx.AsyncClient(timeout=timeout) as client:
        next_url = url
        while next_url:
            target = next_url
            resp = await azure_retry.send_with_retry(
                lambda: client.get(target, headers=headers)
            )
            resp.raise_for_status()
            data = resp.json()
            out.extend(data.get("value") or [])
            next_url = data.get("nextLink") or ""
    return out


def utilisation(row: Dict[str, Any], grain: int = DEFAULT_GRAIN) -> Optional[float]:
    """
    The percentage of the commitment Azure says was used over `grain` days.

    Read straight from Azure's aggregates and never recomputed. Azure knows
    which hours a reservation actually absorbed; deriving that here from cost
    records would produce a confident number that quietly disagrees with the
    portal, and people cancel real commitments on the strength of this figure.

    Returns None when Azure did not publish that grain, which is normal for a
    commitment younger than the window.
    """
    props = row.get("properties") or {}
    aggregates = ((props.get("utilization") or {}).get("aggregates")) or []
    for entry in aggregates:
        if not isinstance(entry, dict):
            continue
        if int(_number(entry.get("grain")) or -1) != grain:
            continue
        if _text(entry.get("grainUnit")).lower() not in ("days", "day", ""):
            continue
        return _number(entry.get("value"))
    return None


def days_until(expiry: str, today: Optional[datetime] = None) -> Optional[int]:
    """
    Whole days from today to `expiry`, negative once it has passed.

    Returns None on an unparseable date rather than a large positive number: a
    date this code cannot read must not become "expires in a long time", which
    is the one reading that causes nobody to look at it.
    """
    raw = _text(expiry).strip()
    if not raw:
        return None
    cleaned = raw.replace("Z", "+00:00")
    parsed = None
    for attempt in (cleaned, f"{cleaned}T00:00:00+00:00"):
        try:
            parsed = datetime.fromisoformat(attempt)
            break
        except ValueError:
            continue
    if parsed is None:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    now = today or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    return (parsed.date() - now.date()).days


def expiry_band(days: Optional[int]) -> str:
    """Which urgency band an expiry falls into, or '' when it is far off."""
    if days is None:
        return ""
    if days < 0:
        return EXPIRED
    if days <= CRITICAL_DAYS:
        return "critical"
    if days <= WARNING_DAYS:
        return "warning"
    if days <= WATCH_DAYS:
        return "watch"
    return ""


def wastage(monthly_cost: Optional[float], used_percent: Optional[float]) -> Optional[float]:
    """
    The part of a month's commitment nobody consumed.

    Both inputs are required. This number is the argument somebody will use to
    cancel a commitment, so half of it is not better than none of it -- an
    estimate built on a guessed cost would be indistinguishable from a measured
    one on screen.
    """
    if monthly_cost is None or used_percent is None:
        return None
    if monthly_cost < 0:
        return None
    unused = max(0.0, min(100.0, 100.0 - used_percent))
    return round(monthly_cost * unused / 100.0, 2)


def wastage_of(item: Dict[str, Any], grain: int = DEFAULT_GRAIN) -> Tuple[Optional[float], str]:
    """
    One commitment's wasted money, and where the figure came from.

    Azure bills the unused portion of a benefit as its own charge type, so when
    that came back it is used directly -- it is measured rather than derived,
    and it survives a tenant where the utilisation API returns nothing. Only
    when it is absent does this fall back to cost multiplied by the unused
    percentage. The basis travels with the number so the page can say which of
    the two it is showing instead of presenting them as the same thing.
    """
    measured = item.get("measured_wastage")
    if measured is not None:
        return round(float(measured), 2), "measured"
    derived = wastage(item.get("monthly_cost"), (item.get("utilisation") or {}).get(grain))
    return derived, ("derived" if derived is not None else "")


def normalise_reservation(row: Dict[str, Any], today: Optional[datetime] = None) -> Dict[str, Any]:
    props = row.get("properties") or {}
    sku = (row.get("sku") or {}).get("name") or ""
    expiry = _text(props.get("expiryDateTime") or props.get("expiryDate"))
    days = days_until(expiry, today)
    return {
        "id": _text(row.get("id")),
        "kind": RESERVATION,
        "name": _text(props.get("displayName") or row.get("name")),
        "sku": _text(sku),
        "resource_type": _text(props.get("reservedResourceType")),
        "term": _text(props.get("term")),
        "quantity": _number(props.get("quantity")),
        "quantity_unit": "instances",
        "state": _text(props.get("provisioningState") or props.get("displayProvisioningState")),
        "scope_type": _text(props.get("appliedScopeType")),
        "scopes": [s for s in (props.get("appliedScopes") or []) if s],
        "location": _text(row.get("location")),
        "billing_plan": _text(props.get("billingPlan")),
        "renew": bool(props.get("renew")),
        "purchase_date": _text(props.get("purchaseDateTime") or props.get("purchaseDate")),
        "expiry": expiry,
        "days_to_expiry": days,
        "expiry_band": expiry_band(days),
        "utilisation": {g: utilisation(row, g) for g in UTILISATION_GRAINS},
        # Filled in later, and only from a cost query that actually returned.
        "monthly_cost": None,
        "measured_wastage": None,
        "currency": "",
    }


def normalise_savings_plan(row: Dict[str, Any], today: Optional[datetime] = None) -> Dict[str, Any]:
    props = row.get("properties") or {}
    expiry = _text(props.get("expiryDateTime") or props.get("effectiveDateTime"))
    days = days_until(_text(props.get("expiryDateTime")), today)
    commitment = props.get("commitment") or {}
    return {
        "id": _text(row.get("id")),
        "kind": SAVINGS_PLAN,
        "name": _text(props.get("displayName") or row.get("name")),
        "sku": _text((row.get("sku") or {}).get("name")),
        "resource_type": _text(props.get("benefitType") or "Compute"),
        "term": _text(props.get("term")),
        "quantity": _number(commitment.get("amount")),
        "quantity_unit": _text(commitment.get("grain") or "hour").lower(),
        "state": _text(props.get("provisioningState")),
        "scope_type": _text(props.get("appliedScopeType")),
        "scopes": [s for s in (props.get("appliedScopes") or []) if s],
        "location": "",
        "billing_plan": _text(props.get("billingPlan")),
        "renew": bool(props.get("renew")),
        "purchase_date": _text(props.get("purchaseDateTime")),
        "expiry": _text(props.get("expiryDateTime")) or expiry,
        "days_to_expiry": days,
        "expiry_band": expiry_band(days),
        "utilisation": {g: utilisation(row, g) for g in UTILISATION_GRAINS},
        "monthly_cost": None,
        "measured_wastage": None,
        "currency": _text(commitment.get("currencyCode")),
    }


def normalise_recommendation(row: Dict[str, Any]) -> Dict[str, Any]:
    """
    One "you could buy this" suggestion, as Azure phrased it.

    The savings figure is Azure's own arithmetic and is passed through
    untouched. Recomputing it from a retail price sheet would produce a second,
    slightly different number with no way for the reader to tell which one their
    invoice will agree with.
    """
    props = row.get("properties") or {}
    net = _number(props.get("netSavings"))
    without = _number(props.get("costWithNoReservedInstances"))
    with_ri = _number(props.get("totalCostWithReservedInstances"))
    percent = None
    if net is not None and without not in (None, 0):
        percent = round(net / without * 100.0, 1)
    return {
        "id": _text(row.get("id")),
        "sku": _text(props.get("skuName") or props.get("displaySkuName")),
        "resource_type": _text(props.get("resourceType") or "VirtualMachines"),
        "term": _text(props.get("term")),
        "lookback": _text(props.get("lookBackPeriod")),
        "quantity": _number(props.get("recommendedQuantity")),
        "scope": _text(props.get("scope")),
        "subscription_id": _text(props.get("subscriptionId")),
        "location": _text(row.get("location")),
        "currency": _text(props.get("currencyCode") or props.get("currency")),
        # These four are the whole recommendation. Each is either Azure's number
        # or None, and the caller renders "Not available" for None.
        "net_savings": net,
        "cost_without": without,
        "cost_with": with_ri,
        "savings_percent": percent,
        "first_usage": _text(props.get("firstUsageDate")),
    }


def attach_costs(items: List[Dict[str, Any]], costs: Dict[str, Any], currency: str) -> List[Dict[str, Any]]:
    """
    Join measured amortised cost onto each commitment.

    Tried by resource id first and display name second. The id is what Cost
    Management calls `BenefitId` and it is stable; a display name can be edited
    at any time and past cost rows keep the old one, so joining on the name
    alone silently loses money from renamed commitments. Both the full ARM id
    and its trailing GUID are tried, because the two APIs disagree on how much
    of the path they return.

    Nothing is joined on a near miss. A commitment whose cost did not come back
    keeps `monthly_cost = None` and shows as "Not available", which is a smaller
    error than showing somebody else's money against it.

    Values may be a bare number or a `{cost, unused}` mapping; the mapping form
    carries Azure's own measurement of the unused portion, which is recorded as
    `measured_wastage` and is preferred later over anything inferred from a
    utilisation percentage.
    """
    lookup = {str(k).strip().lower(): v for k, v in (costs or {}).items() if str(k).strip()}

    def candidates(item: Dict[str, Any]) -> List[str]:
        ident = _text(item.get("id")).strip()
        keys = [ident, ident.rsplit("/", 1)[-1] if ident else "", _text(item.get("name")).strip()]
        return [k.lower() for k in keys if k]

    for item in items:
        matched = next((lookup[k] for k in candidates(item) if k in lookup), None)
        if matched is None:
            continue
        if isinstance(matched, dict):
            amount = _number(matched.get("cost"))
            unused = _number(matched.get("unused"))
        else:
            amount = _number(matched)
            unused = None
        if amount is None:
            continue
        item["monthly_cost"] = round(float(amount), 2)
        # Only recorded when the query that produced it actually distinguished
        # unused rows. Zero here means "Azure reported no waste", which is a
        # real answer and must not be confused with never having asked.
        if unused is not None:
            item["measured_wastage"] = round(float(unused), 2)
        item["currency"] = item.get("currency") or currency
    return items


def is_expired(item: Dict[str, Any]) -> bool:
    days = item.get("days_to_expiry")
    if days is not None:
        return days < 0
    return _text(item.get("state")).lower() in ("expired", "cancelled", "canceled")


def summarise(items: List[Dict[str, Any]], grain: int = DEFAULT_GRAIN) -> Dict[str, Any]:
    """
    The headline numbers.

    Overall utilisation is weighted by monthly cost, but only across the
    commitments whose cost is known -- a large underused reservation and a tiny
    well-used one must not count equally. When no costs came back it falls back
    to a plain average and says so through `utilisation_basis`, so the caller
    can label the figure rather than presenting two different calculations under
    one name.
    """
    live = [i for i in items if not is_expired(i)]
    spend = [i["monthly_cost"] for i in live if i.get("monthly_cost") is not None]

    weighted_top = 0.0
    weighted_bottom = 0.0
    plain: List[float] = []
    waste_total = 0.0
    waste_known = 0
    waste_measured = 0

    for item in live:
        # Waste is counted first and separately, because the measured figure
        # exists even where utilisation does not and skipping the item on a
        # missing percentage would throw that money away.
        lost, basis = wastage_of(item, grain)
        if lost is not None:
            waste_total += lost
            waste_known += 1
            if basis == "measured":
                waste_measured += 1

        used = (item.get("utilisation") or {}).get(grain)
        if used is None:
            continue
        plain.append(used)
        cost = item.get("monthly_cost")
        if cost is not None and cost > 0:
            weighted_top += used * cost
            weighted_bottom += cost

    if weighted_bottom > 0:
        overall = round(weighted_top / weighted_bottom, 1)
        basis = "weighted by monthly cost"
    elif plain:
        overall = round(sum(plain) / len(plain), 1)
        basis = "a plain average, because no commitment costs were returned"
    else:
        overall = None
        basis = ""

    expiring = [i for i in live if i.get("expiry_band") in ("critical", "warning", "watch")]
    soonest = min(
        (i for i in live if i.get("days_to_expiry") is not None),
        key=lambda i: i["days_to_expiry"],
        default=None,
    )

    return {
        "total": len(items),
        "active": len(live),
        "expired": len(items) - len(live),
        "reservations": sum(1 for i in live if i.get("kind") == RESERVATION),
        "savings_plans": sum(1 for i in live if i.get("kind") == SAVINGS_PLAN),
        "utilisation": overall,
        "utilisation_basis": basis,
        "utilisation_grain": grain,
        # Stated so the reader can see how much of the estate the money numbers
        # actually cover, instead of assuming they cover all of it.
        "costed": len(spend),
        "monthly_spend": round(sum(spend), 2) if spend else None,
        "wastage": round(waste_total, 2) if waste_known else None,
        "wastage_counted": waste_known,
        # How many of those came from Azure's own unused-benefit charge rather
        # than from cost multiplied by an unused percentage. The page says which,
        # because one is a bill and the other is an inference.
        "wastage_measured": waste_measured,
        "underused": sum(
            1 for i in live
            if (i.get("utilisation") or {}).get(grain) is not None
            and (i["utilisation"][grain] < UNDERUSED_BELOW)
        ),
        "expiring_soon": len(expiring),
        "next_expiry_days": soonest["days_to_expiry"] if soonest else None,
        "next_expiry_name": soonest["name"] if soonest else "",
    }


def expiring_soon(items: List[Dict[str, Any]], within_days: int = WATCH_DAYS) -> List[Dict[str, Any]]:
    """Live commitments lapsing inside the window, soonest first."""
    out = [
        i for i in items
        if not is_expired(i)
        and i.get("days_to_expiry") is not None
        and i["days_to_expiry"] <= within_days
    ]
    return sorted(out, key=lambda i: (i["days_to_expiry"], _text(i.get("name"))))


def sort_commitments(items: List[Dict[str, Any]], grain: int = DEFAULT_GRAIN) -> List[Dict[str, Any]]:
    """
    Worst utilisation first, with unknowns last rather than first.

    A commitment whose utilisation Azure has not published yet is not the
    worst-performing one; sorting it to the top would put the least actionable
    rows where the eye lands.
    """
    def key(item):
        used = (item.get("utilisation") or {}).get(grain)
        return (used is None, used if used is not None else 0.0, _text(item.get("name")))
    return sorted(items, key=key)


def note(items: List[Dict[str, Any]], summary: Dict[str, Any], errors: List[str]) -> str:
    if errors and not items:
        return (
            "No commitments could be read. This is not the same as having none "
            "-- reservations and savings plans are read at tenant level and the "
            "call did not return."
        )
    if not items:
        return (
            "No reservations or savings plans were found in this tenant. Every "
            "eligible resource is being billed at pay-as-you-go rates."
        )
    parts = [f"{summary['active']} active of {summary['total']} commitments read from Azure."]
    if summary.get("costed", 0) < summary.get("active", 0):
        parts.append(
            f"Cost was returned for {summary['costed']} of them; the rest show "
            "the amount as not available rather than an estimate."
        )
    if summary.get("utilisation_basis"):
        parts.append(f"Overall utilisation is {summary['utilisation_basis']}.")
    return " ".join(parts)


async def fetch_reservations(token: str) -> Tuple[List[Dict[str, Any]], str]:
    try:
        return await _get_all(RESERVATIONS_URL, token), ""
    except Exception as exc:  # noqa: BLE001 - reported, never swallowed
        log.warning("reservations read failed: %s", exc)
        return [], f"Reservations could not be read: {exc}"


async def fetch_savings_plans(token: str) -> Tuple[List[Dict[str, Any]], str]:
    try:
        return await _get_all(SAVINGS_PLANS_URL, token), ""
    except Exception as exc:  # noqa: BLE001
        log.warning("savings plan read failed: %s", exc)
        return [], f"Savings plans could not be read: {exc}"


async def fetch_recommendations(token: str, subscription_ids: List[str]) -> Tuple[List[Dict[str, Any]], List[str]]:
    """
    Purchase suggestions, gathered per subscription.

    One subscription failing does not sink the rest -- a partial list of
    opportunities is useful, and the failures are returned alongside so the page
    can say which subscriptions are missing instead of quietly showing fewer.
    """
    async def one(sub: str):
        url = (
            f"{MGMT_BASE}/subscriptions/{sub}/providers/Microsoft.Consumption"
            f"/reservationRecommendations?api-version={RECOMMENDATIONS_API}"
        )
        return await _get_all(url, token, timeout=45)

    results = await asyncio.gather(
        *(one(sub) for sub in subscription_ids), return_exceptions=True
    )
    rows: List[Dict[str, Any]] = []
    errors: List[str] = []
    for sub, result in zip(subscription_ids, results):
        if isinstance(result, Exception):
            log.info("recommendations failed for %s: %s", sub, result)
            errors.append(f"{sub}: {result}")
        else:
            rows.extend(result)
    return rows, errors


async def fetch_amortised_costs(
    token: str, subscription_ids: List[str], from_date: str, to_date: str,
) -> Tuple[Dict[str, Dict[str, float]], str, List[str]]:
    """
    What each commitment actually cost over the window, from Cost Management.

    Deliberately an amortised query rather than an actual one. An actual-cost
    query shows an upfront reservation as its entire purchase price in the month
    it was bought and zero every month after, which would read as a single
    enormous commitment surrounded by free ones. Amortised spreads it across the
    term, which is the shape this page is describing.

    Grouped by `BenefitId` and `BenefitName` rather than `ReservationName`.
    Microsoft documents the Benefit dimensions as covering savings plans as well
    as reservations, whereas `ReservationName` is empty for every savings plan --
    so the old query could never return a cost for half the page, and every
    savings plan read "Not available" no matter how healthy the tenant was.

    `ChargeType` is grouped too, because amortised data carries the unused
    portion of a benefit as its own `UnusedReservation` / `UnusedSavingsPlan`
    rows. That is Azure's own measurement of waste in money, which is a far
    better answer than multiplying a cost by an unused percentage, and it is
    the only figure available when utilisation itself does not come back.

    Returns costs keyed by *both* the lowercased benefit id and the lowercased
    benefit name, so the join afterwards can prefer the id and fall back to the
    name rather than depending on a display name nobody promised was stable.
    """
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    def query_body(grouping: List[Dict[str, str]]) -> Dict[str, Any]:
        return {
            "type": "AmortizedCost",
            "timeframe": "Custom",
            "timePeriod": {"from": from_date, "to": to_date},
            "dataset": {
                "granularity": "None",
                "aggregation": {"totalCost": {"name": "PreTaxCost", "function": "Sum"}},
                "grouping": grouping,
            },
        }

    benefit_body = query_body([
        {"type": "Dimension", "name": "BenefitId"},
        {"type": "Dimension", "name": "BenefitName"},
        {"type": "Dimension", "name": "ChargeType"},
    ])
    # Kept as a fallback because the Benefit dimensions are not offered on every
    # agreement type. Losing the savings plans is better than losing the page.
    legacy_body = query_body([{"type": "Dimension", "name": "ReservationName"}])

    totals: Dict[str, Dict[str, float]] = {}
    currency = ""
    errors: List[str] = []

    def add(key: str, amount: float, unused: bool) -> None:
        key = str(key).strip().lower()
        if not key:
            return
        entry = totals.setdefault(key, {"cost": 0.0, "unused": 0.0})
        entry["cost"] += amount
        if unused:
            entry["unused"] += amount

    async with httpx.AsyncClient(timeout=90) as client:
        for sub in subscription_ids:
            url = (
                f"{MGMT_BASE}/subscriptions/{sub}/providers/Microsoft.CostManagement"
                f"/query?api-version={COST_API_VERSION}"
            )

            payload = None
            for body in (benefit_body, legacy_body):
                try:
                    resp = await azure_retry.send_with_retry(
                        lambda b=body: client.post(url, headers=headers, json=b)
                    )
                    resp.raise_for_status()
                    payload = resp.json()
                    break
                except Exception as exc:  # noqa: BLE001
                    log.info("amortised cost failed for %s: %s", sub, exc)
                    last_error = exc
            if payload is None:
                errors.append(f"{sub}: {last_error}")
                continue

            props = payload.get("properties") or {}
            columns = [c.get("name") for c in (props.get("columns") or [])]
            for row in props.get("rows") or []:
                record = dict(zip(columns, row))
                amount = _number(record.get("PreTaxCost") or record.get("Cost"))
                if amount is None:
                    continue
                charge = _text(record.get("ChargeType")).lower()
                unused = charge.startswith("unused")
                # The same money is filed under the id and the name so either
                # can resolve it. `add` accumulates, so a commitment matched by
                # both keys is still only counted once against itself.
                for field in ("BenefitId", "BenefitName", "ReservationName"):
                    value = _text(record.get(field)).strip()
                    if value:
                        add(value, amount, unused)
                currency = currency or _text(record.get("Currency"))

    return totals, currency, errors


def month_window(today: Optional[datetime] = None) -> Tuple[str, str]:
    """
    The last 30 days, as Cost Management wants them.

    Thirty days rather than the calendar month so that the figure beside a
    30-day utilisation percentage covers the same period. Reading 90% used
    against a cost that covers eleven days would make the wastage number wrong
    by a factor of three.
    """
    now = today or datetime.now(timezone.utc)
    start = now - timedelta(days=30)
    return start.strftime("%Y-%m-%dT00:00:00Z"), now.strftime("%Y-%m-%dT23:59:59Z")


async def fetch_commitments(
    token: str,
    subscription_ids: List[str],
    grain: int = DEFAULT_GRAIN,
    include_recommendations: bool = True,
) -> Dict[str, Any]:
    """
    Everything the Commitments page needs, in one pass.

    The four reads are independent and are run together, and each is allowed to
    fail on its own. A tenant where recommendations are blocked but reservations
    are readable should still see its reservations -- an all-or-nothing page
    would show nothing at all in the common case where one permission is
    missing.
    """
    if grain not in UTILISATION_GRAINS:
        grain = DEFAULT_GRAIN

    from_date, to_date = month_window()

    reservations_task = fetch_reservations(token)
    plans_task = fetch_savings_plans(token)
    costs_task = fetch_amortised_costs(token, subscription_ids, from_date, to_date)
    recs_task = (
        fetch_recommendations(token, subscription_ids)
        if include_recommendations else _no_recommendations()
    )

    (raw_reservations, res_error), (raw_plans, plan_error), \
        (costs, currency, cost_errors), (raw_recs, rec_errors) = await asyncio.gather(
            reservations_task, plans_task, costs_task, recs_task,
        )

    today = datetime.now(timezone.utc)
    items = (
        [normalise_reservation(r, today) for r in raw_reservations]
        + [normalise_savings_plan(p, today) for p in raw_plans]
    )
    items = attach_costs(items, costs, currency)
    items = sort_commitments(items, grain)

    recommendations = sorted(
        (normalise_recommendation(r) for r in raw_recs),
        key=lambda r: (r["net_savings"] is None, -(r["net_savings"] or 0.0)),
    )

    errors = [e for e in (res_error, plan_error) if e]
    summary = summarise(items, grain)

    return {
        "items": items,
        "summary": summary,
        "expiring": expiring_soon(items),
        "recommendations": recommendations,
        "currency": currency or next(
            (i["currency"] for i in items if i.get("currency")), ""
        ),
        "grain": grain,
        "grains": list(UTILISATION_GRAINS),
        "window": {"from": from_date, "to": to_date},
        "note": note(items, summary, errors),
        "errors": errors,
        # Kept apart from `errors` because these are partial gaps, not a failed
        # page: the reader needs to know which subscriptions are missing without
        # being told the whole result is untrustworthy.
        "partial": {
            "cost_subscriptions": cost_errors,
            "recommendation_subscriptions": rec_errors,
        },
    }


async def _no_recommendations() -> Tuple[List[Dict[str, Any]], List[str]]:
    return [], []
