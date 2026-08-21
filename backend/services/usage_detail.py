"""
A month of usage, day by day — and when the thing was actually running.

"720 → 738.98 hours" is a true statement that nobody can act on. The same total
can be twenty-four hours every day for a month, or a machine left on over a
weekend it should have been off, or a second instance appearing halfway through.
Those are different problems with different fixes, and a monthly total cannot
tell them apart. A daily series can.

Two sources are combined, and they answer different questions:

  * **Cost Management, daily granularity** — how many units were *billed* each
    day. This is the authoritative number, because it is the number on the
    invoice. For an hourly meter it is also a direct measure of running time.
  * **The Activity Log** — the control-plane operations that started, stopped
    or deallocated the resource, with a timestamp and the person who did it.

Neither is sufficient alone. Billing knows a VM ran nine hours on Tuesday but
not that Anna deallocated it at 17:04; the Activity Log knows the operation but
not what it cost. Read together they produce the sentence people actually want:
"it ran nine hours, because it was deallocated at 17:04, and that saved ₹430".

What is deliberately *not* claimed:

  * Downtime is inferred from billed hours against a baseline, never asserted
    from a power state — Cost Management does not report power state, and a
    resource can stop being billed for reasons other than being switched off.
  * The Activity Log retains about 90 days. Before that the events are gone,
    and a month with no events may be a quiet month or an old one. Which of the
    two is reported rather than left for the reader to assume.
"""
from __future__ import annotations

import logging
import math
from calendar import monthrange
from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Optional

log = logging.getLogger(__name__)

# Operations that change whether a resource is running. Keyed on the verb, which
# in an Azure operation id sits just before the trailing "/action".
POWER_OPERATIONS = {
    "start": ("started", "on"),
    "poweroff": ("powered off", "off"),
    "deallocate": ("deallocated", "off"),
    "restart": ("restarted", "on"),
    "redeploy": ("redeployed", "on"),
    "delete": ("deleted", "off"),
    "stop": ("stopped", "off"),
    "suspend": ("suspended", "off"),
    "resume": ("resumed", "on"),
}

# Units whose quantity is a duration, so "how many were billed" and "how long it
# ran" are the same question.
_TIME_UNITS = ("hour", "hours", "day", "days", "minute", "minutes", "second", "seconds")

_HOURS_IN = {"hour": 1.0, "day": 24.0, "minute": 1 / 60, "second": 1 / 3600}


def month_days(month: str) -> List[str]:
    """Every calendar day in "YYYY-MM", as ISO dates."""
    year, mon = int(month[:4]), int(month[5:7])
    count = monthrange(year, mon)[1]
    return [f"{month}-{day:02d}" for day in range(1, count + 1)]


def month_range(month: str) -> tuple:
    """First and last day of a month, for a Cost Management time period."""
    days = month_days(month)
    return days[0], days[-1]


def is_time_unit(unit: str) -> bool:
    """Whether this meter's quantity measures duration rather than volume."""
    return any(word in (unit or "").lower() for word in _TIME_UNITS)


def unit_hours(unit: str) -> float:
    """
    How many hours one billed unit represents.

    "10 Hours" is one unit per ten hours, so a quantity of 72 is 720 hours. Get
    this wrong and every uptime figure is out by the multiplier, silently.
    """
    words = (unit or "").lower().replace("/", " ").split()
    multiplier = 1.0
    per = 0.0
    for word in words:
        cleaned = word.rstrip("s")
        if word.replace(".", "", 1).isdigit():
            try:
                multiplier = float(word)
            except ValueError:
                multiplier = 1.0
        elif cleaned in _HOURS_IN:
            per = _HOURS_IN[cleaned]
    return multiplier * per if per else 0.0


def _day_of(value: Any) -> str:
    """Cost Management returns a day as 20260701 or an ISO timestamp."""
    text = str(value or "")
    if text.isdigit() and len(text) == 8:
        return f"{text[:4]}-{text[4:6]}-{text[6:8]}"
    return text[:10]


def power_event(operation: str) -> Optional[tuple]:
    """
    The readable verb and resulting state for a power operation, if it is one.

    Azure writes these as "Microsoft.Compute/virtualMachines/deallocate/action",
    so the verb is the segment *before* the trailing "/action" rather than the
    last one. Reading only the last segment matches every "/action" in the log,
    which is most of it.

    Matching is exact on the verb. A prefix match would turn
    "roleAssignments/write" and "policies/action" into power events, and a list
    that claims a tag edit shut a machine down is worse than no list.
    """
    parts = [p for p in (operation or "").lower().split("/") if p]
    if not parts:
        return None
    # ".../deallocate/action" -> "deallocate"; ".../delete" -> "delete".
    verb = parts[-2] if parts[-1] == "action" and len(parts) > 1 else parts[-1]
    return POWER_OPERATIONS.get(verb)


def daily_rows(records: List[Dict[str, Any]], month: str) -> List[Dict[str, Any]]:
    """
    One entry per calendar day of the month, including the days with nothing.

    Days with no usage are the point of the exercise — a chart that silently
    skips them draws a flat line across a shutdown and hides exactly the thing
    the reader opened it to see.
    """
    totals: Dict[str, Dict[str, float]] = {}
    for record in records:
        day = _day_of(record.get("UsageDate") or record.get("Date") or record.get("BillingMonth"))
        if not day.startswith(month):
            continue
        bucket = totals.setdefault(day, {"cost": 0.0, "quantity": 0.0})
        bucket["cost"] += float(record.get("PreTaxCost") or record.get("Cost") or 0.0)
        bucket["quantity"] += float(record.get("UsageQuantity") or 0.0)

    return [
        {
            "day": day,
            "cost": round(totals.get(day, {}).get("cost", 0.0), 6),
            "quantity": round(totals.get(day, {}).get("quantity", 0.0), 6),
            "billed": day in totals,
        }
        for day in month_days(month)
    ]


def _baseline(rows: List[Dict[str, Any]]) -> float:
    """
    What a full day of this meter looks like.

    Taken as the most common non-zero daily quantity rather than the maximum: a
    single day with a second instance running would otherwise redefine "normal"
    and make every ordinary day look like a partial one.
    """
    counts: Dict[float, int] = {}
    for row in rows:
        value = round(row["quantity"], 3)
        if value > 0:
            counts[value] = counts.get(value, 0) + 1
    if not counts:
        return 0.0
    best = max(counts.items(), key=lambda kv: (kv[1], kv[0]))
    return best[0]


def summarise(
    rows: List[Dict[str, Any]],
    unit: str,
    events_by_day: Dict[str, List[Dict[str, Any]]],
) -> Dict[str, Any]:
    """
    The shape of the month: full days, partial days, days off, and what the off
    days were worth.
    """
    baseline = _baseline(rows)
    per_unit_hours = unit_hours(unit)
    timed = is_time_unit(unit)

    # An hourly meter reading 24 a day is one instance; 48 is two. Rounding up
    # because a fractional instance is a partial day, not a partial machine.
    instances = 0
    if timed and per_unit_hours and baseline:
        instances = max(1, math.ceil(round(baseline * per_unit_hours, 3) / 24))

    full_day = baseline
    rate = 0.0
    billed = [r for r in rows if r["quantity"] > 0]
    total_qty = sum(r["quantity"] for r in rows)
    total_cost = sum(r["cost"] for r in rows)
    if total_qty:
        rate = total_cost / total_qty

    days_off = [r for r in rows if r["quantity"] <= 0]
    partial = [r for r in rows if 0 < r["quantity"] < full_day * 0.995]
    above = [r for r in rows if r["quantity"] > full_day * 1.005]

    # What was avoided by not running, priced at this meter's own effective rate.
    missing_units = sum(max(0.0, full_day - r["quantity"]) for r in rows)

    for row in rows:
        row["hours"] = round(row["quantity"] * per_unit_hours, 3) if per_unit_hours else None
        row["share_of_full_day"] = (
            round(row["quantity"] / full_day, 4) if full_day else None
        )
        row["state"] = (
            "off" if row["quantity"] <= 0
            else "high" if row["quantity"] > full_day * 1.005
            else "partial" if row["quantity"] < full_day * 0.995
            else "full"
        )
        row["events"] = events_by_day.get(row["day"], [])

    return {
        "unit": unit,
        "is_duration": timed,
        "hours_per_unit": per_unit_hours or None,
        "full_day_quantity": round(full_day, 4),
        "full_day_hours": round(full_day * per_unit_hours, 2) if per_unit_hours else None,
        "instances": instances or None,
        "total_quantity": round(total_qty, 4),
        "total_cost": round(total_cost, 4),
        "total_hours": round(total_qty * per_unit_hours, 2) if per_unit_hours else None,
        "effective_rate": round(rate, 8) if rate else None,
        "days_in_month": len(rows),
        "days_billed": len(billed),
        "days_off": len(days_off),
        "days_partial": len(partial),
        "days_above_normal": len(above),
        "off_days": [r["day"] for r in days_off],
        # Priced at this meter's own effective rate, so it is what *this* line
        # would have cost, not a list-price estimate.
        "unbilled_units": round(missing_units, 4),
        "unbilled_hours": round(missing_units * per_unit_hours, 2) if per_unit_hours else None,
        "avoided_cost": round(missing_units * rate, 4) if rate else None,
    }


def power_events(entries: List[Dict[str, Any]], month: str) -> Dict[str, List[Dict[str, Any]]]:
    """
    Start/stop operations from the Activity Log, bucketed by the day they
    happened.

    Only power operations are kept. A tag edit and a deallocation both appear in
    the log as writes, and mixing them turns the one list that explains a
    shutdown into a general-purpose audit trail nobody reads.
    """
    by_day: Dict[str, List[Dict[str, Any]]] = {}
    for entry in entries:
        verb = power_event(entry.get("operation", ""))
        if not verb:
            continue
        at = str(entry.get("at") or "")
        day = at[:10]
        if not day.startswith(month):
            continue
        label, state = verb
        by_day.setdefault(day, []).append({
            "at": at[:19].replace("T", " "),
            "time": at[11:16],
            "action": label,
            "state": state,
            "caller": entry.get("caller") or "Unknown",
            "resource": (entry.get("resource_id") or "").rsplit("/", 1)[-1],
            "succeeded": entry.get("succeeded", True),
        })

    for day in by_day:
        by_day[day].sort(key=lambda e: e["at"])
    return by_day


def activity_window(month: str, retention_days: int = 90) -> Dict[str, Any]:
    """
    Whether the Activity Log can still speak for this month.

    A month older than Azure's retention returns no events, which looks exactly
    like a month in which nobody touched anything. Saying which of the two it is
    costs one sentence and prevents the wrong conclusion.
    """
    first, last = month_range(month)
    horizon = date.today() - timedelta(days=retention_days)
    last_day = datetime.strptime(last, "%Y-%m-%d").date()
    first_day = datetime.strptime(first, "%Y-%m-%d").date()

    if last_day < horizon:
        return {
            "covered": False,
            "partial": False,
            "note": (
                f"Azure keeps about {retention_days} days of Activity Log. {month} is older "
                f"than that, so no start or stop events survive — the daily hours below are "
                f"still exact, but nothing can say who caused them."
            ),
        }
    if first_day < horizon:
        return {
            "covered": True,
            "partial": True,
            "note": (
                f"Azure keeps about {retention_days} days of Activity Log, which reaches back "
                f"to {horizon.isoformat()}. Events before that day in this month are gone."
            ),
        }
    return {"covered": True, "partial": False, "note": ""}
