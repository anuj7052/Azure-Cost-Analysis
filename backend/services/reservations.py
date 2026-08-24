"""
Reserved Instances, Savings Plans and Spot — who is actually paying for a line.

Two questions this answers, and one it deliberately refuses to.

**What is covering this usage?** Azure bills the same VM very differently
depending on the commitment behind it. Cost Management exposes this as the
`PricingModel` dimension: `OnDemand`, `Reservation`, `SavingsPlan`, `Spot`.
Where that dimension is unavailable — it is not offered on every agreement type
— we fall back to a signal that is always present: usage with a quantity but no
cost is being paid for by something other than this line.

**What moved?** A resource shifting between Pay-as-you-go and a reservation is
the single largest explicable swing in an Azure bill, and it looks identical to
a fault: the cost drops to near zero, or leaps, with no change in usage. Naming
the transition turns an alarming number into an expected one.

**What this will not claim.** Under `ActualCost`, reservation-covered usage
reads as zero because the money was spent at purchase, in a different month,
often on a different subscription. So a covered line is *not* free, and this
module never reports the difference as a saving that was realised this month. It
reports avoided on-demand cost — what the same usage would have cost unreserved
— and says so in those words. Conflating the two overstates savings by the
entire value of the reservation.
"""
from typing import Any, Dict, Iterable, List, Tuple

# Azure's own vocabulary, lowercased, mapped to ours. The API has used more than
# one spelling for the committed-use models over time, so both are accepted.
PRICING_MODELS = {
    "ondemand": "on-demand",
    "on demand": "on-demand",
    "reservation": "reservation",
    "reserved": "reservation",
    "savingsplan": "savings-plan",
    "savings plan": "savings-plan",
    "spot": "spot",
}

# Shown after a resource or meter name, e.g. "web-prod-vm01 (RI)".
MODEL_SUFFIX = {
    "reservation": "(RI)",
    "savings-plan": "(SP)",
    "spot": "(Spot)",
    "on-demand": "",
    "unknown": "",
}

MODEL_LABEL = {
    "reservation": "Reserved Instance",
    "savings-plan": "Savings Plan",
    "spot": "Spot",
    "on-demand": "Pay-as-you-go",
    "unknown": "Unknown",
}

# Models that represent a paid-ahead commitment, as opposed to metered usage.
COMMITTED = ("reservation", "savings-plan")

# A share of quantity must move by more than this before it counts as a
# transition. Reservations rarely line up exactly with usage — a few percent
# drifts month to month as instances start and stop — and reporting that drift
# as "moved to RI" would cry wolf every month.
MOVE_THRESHOLD = 0.05


def _num(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _text(value: Any) -> str:
    return str(value or "").strip()


def classify(rec: Dict[str, Any]) -> str:
    """
    Return on-demand | reservation | savings-plan | spot | unknown.

    Prefers Azure's `PricingModel`. Where that is absent, usage that has a
    quantity but no cost is being paid for by a commitment bought elsewhere —
    the defining shape of reservation-covered usage under ActualCost. That
    fallback cannot tell a reservation from a savings plan, so it says
    "unknown" rather than guessing between them.
    """
    for key in ("PricingModel", "pricingModel"):
        raw = _text(rec.get(key)).lower()
        if raw:
            return PRICING_MODELS.get(raw, "unknown")

    if _text(rec.get("BenefitId")) or _text(rec.get("BenefitName")):
        return "reservation"

    quantity = _num(rec.get("UsageQuantity") or rec.get("usageQuantity"))
    cost = _num(rec.get("PreTaxCost") or rec.get("totalCost") or rec.get("Cost"))
    if quantity > 0 and cost == 0:
        return "unknown"
    return "on-demand"


def suffix(model: str) -> str:
    """The tag appended to a display name, or '' for ordinary usage."""
    return MODEL_SUFFIX.get(model, "")


def label(model: str) -> str:
    return MODEL_LABEL.get(model, "Unknown")


def decorate(name: str, model: str) -> str:
    """`decorate("vm01", "reservation")` -> `"vm01 (RI)"`."""
    tag = suffix(model)
    return f"{name} {tag}" if tag and name else name


def is_committed(model: str) -> bool:
    return model in COMMITTED


def _month_of(rec: Dict[str, Any]) -> str:
    raw = rec.get("BillingMonth") or rec.get("UsageDate") or rec.get("UsageDateTime")
    if raw is None:
        return "unknown"
    text = str(raw)
    if text.isdigit() and len(text) == 8:
        return f"{text[:4]}-{text[4:6]}"
    return text[:7]


def _key_of(rec: Dict[str, Any]) -> Tuple[str, str]:
    service = _text(rec.get("ServiceName") or rec.get("MeterCategory")) or "Unknown service"
    meter = _text(rec.get("Meter") or rec.get("MeterName")) or "All meters"
    return service, meter


def summarise(records: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Fold raw records into a per-meter, per-month, per-model breakdown.

    Returns `{"meters": [...], "months": [...], "coverage": {...}}` where each
    meter carries the month-by-month split across pricing models.
    """
    meters: Dict[Tuple[str, str], Dict[str, Any]] = {}
    months: set = set()
    totals: Dict[str, Dict[str, float]] = {}

    for rec in records:
        model = classify(rec)
        month = _month_of(rec)
        service, meter_name = _key_of(rec)
        cost = _num(rec.get("PreTaxCost") or rec.get("totalCost") or rec.get("Cost"))
        quantity = _num(rec.get("UsageQuantity") or rec.get("usageQuantity"))

        months.add(month)
        bucket = totals.setdefault(model, {"cost": 0.0, "quantity": 0.0})
        bucket["cost"] += cost
        bucket["quantity"] += quantity

        entry = meters.setdefault(
            (service, meter_name),
            {
                "service": service,
                "meter": meter_name,
                "unit": _text(rec.get("UnitOfMeasure") or rec.get("unitOfMeasure")),
                "months": {},
            },
        )
        if not entry["unit"]:
            entry["unit"] = _text(rec.get("UnitOfMeasure") or rec.get("unitOfMeasure"))

        per_month = entry["months"].setdefault(month, {})
        cell = per_month.setdefault(model, {"cost": 0.0, "quantity": 0.0})
        cell["cost"] += cost
        cell["quantity"] += quantity

    ordered_months = sorted(m for m in months if m != "unknown")
    total_quantity = sum(b["quantity"] for b in totals.values())
    committed_quantity = sum(
        b["quantity"] for model, b in totals.items() if is_committed(model)
    )

    meter_list = []
    for entry in meters.values():
        entry = dict(entry)
        entry["months"] = {
            month: {
                model: {"cost": round(cell["cost"], 4), "quantity": round(cell["quantity"], 4)}
                for model, cell in per_model.items()
            }
            for month, per_model in sorted(entry["months"].items())
        }
        entry["models"] = sorted({m for per in entry["months"].values() for m in per})
        entry["is_committed"] = any(is_committed(m) for m in entry["models"])
        meter_list.append(entry)

    meter_list.sort(key=lambda e: (e["service"], e["meter"]))

    return {
        "meters": meter_list,
        "months": ordered_months,
        "coverage": {
            "total_quantity": round(total_quantity, 4),
            "committed_quantity": round(committed_quantity, 4),
            "committed_share": (
                round(committed_quantity / total_quantity, 4) if total_quantity else 0.0
            ),
            "by_model": {
                model: {"cost": round(b["cost"], 4), "quantity": round(b["quantity"], 4)}
                for model, b in sorted(totals.items())
            },
        },
    }


def _dominant(per_model: Dict[str, Dict[str, float]]) -> str:
    """Which pricing model carried most of the quantity that month."""
    if not per_model:
        return "unknown"
    return max(per_model, key=lambda m: per_model[m]["quantity"])


def _share(per_model: Dict[str, Dict[str, float]], model: str) -> float:
    total = sum(cell["quantity"] for cell in per_model.values())
    if not total:
        return 0.0
    return per_model.get(model, {}).get("quantity", 0.0) / total


def _rate(cell: Dict[str, float]) -> float | None:
    quantity = cell.get("quantity", 0.0)
    return round(cell["cost"] / quantity, 6) if quantity else None


def transitions(summary: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    Every meter that changed how it was paid for, between consecutive months.

    A transition is reported when the share of quantity sitting on committed
    pricing moves by more than MOVE_THRESHOLD. Each one carries the numbers
    needed to check the claim: quantity and cost on each side, the effective
    rate before and after, and — for a move onto a reservation — what the newly
    covered usage would have cost at the previous month's on-demand rate.

    That last figure is labelled `avoided_on_demand_cost`, not "saving". Under
    ActualCost the reservation was paid for in an earlier month, so the money
    leaving the account this month is genuinely lower while the true cost of the
    capacity is not. Calling it a saving would double-count the purchase.
    """
    found: List[Dict[str, Any]] = []

    for entry in summary.get("meters", []):
        months = entry["months"]
        ordered = sorted(months)
        for prev_month, curr_month in zip(ordered, ordered[1:]):
            prev = months[prev_month]
            curr = months[curr_month]

            prev_committed = sum(_share(prev, m) for m in COMMITTED)
            curr_committed = sum(_share(curr, m) for m in COMMITTED)
            delta = curr_committed - prev_committed
            if abs(delta) <= MOVE_THRESHOLD:
                continue

            direction = "to-committed" if delta > 0 else "to-on-demand"
            from_model = _dominant(prev)
            to_model = _dominant(curr)

            prev_total = {
                "cost": sum(c["cost"] for c in prev.values()),
                "quantity": sum(c["quantity"] for c in prev.values()),
            }
            curr_total = {
                "cost": sum(c["cost"] for c in curr.values()),
                "quantity": sum(c["quantity"] for c in curr.values()),
            }

            prev_on_demand = prev.get("on-demand", {"cost": 0.0, "quantity": 0.0})
            on_demand_rate = _rate(prev_on_demand)
            moved_quantity = abs(delta) * curr_total["quantity"]
            avoided = (
                round(moved_quantity * on_demand_rate, 4)
                if direction == "to-committed" and on_demand_rate
                else None
            )

            found.append({
                "service": entry["service"],
                "meter": entry["meter"],
                "unit": entry.get("unit", ""),
                "from_month": prev_month,
                "to_month": curr_month,
                "direction": direction,
                "from_model": from_model,
                "to_model": to_model,
                "from_label": label(from_model),
                "to_label": label(to_model),
                "committed_share_before": round(prev_committed, 4),
                "committed_share_after": round(curr_committed, 4),
                "share_change": round(delta, 4),
                "quantity_moved": round(moved_quantity, 4),
                "cost_before": round(prev_total["cost"], 4),
                "cost_after": round(curr_total["cost"], 4),
                "cost_change": round(curr_total["cost"] - prev_total["cost"], 4),
                "quantity_before": round(prev_total["quantity"], 4),
                "quantity_after": round(curr_total["quantity"], 4),
                "rate_before": (
                    round(prev_total["cost"] / prev_total["quantity"], 6)
                    if prev_total["quantity"] else None
                ),
                "rate_after": (
                    round(curr_total["cost"] / curr_total["quantity"], 6)
                    if curr_total["quantity"] else None
                ),
                "on_demand_rate": on_demand_rate,
                "avoided_on_demand_cost": avoided,
                "headline": _headline(entry, direction, from_model, to_model),
                "detail": _detail(direction, avoided, entry.get("unit", "")),
            })

    found.sort(key=lambda t: abs(t["cost_change"]), reverse=True)
    return found


def _headline(entry: Dict[str, Any], direction: str, from_model: str, to_model: str) -> str:
    name = entry["meter"] or entry["service"]
    if direction == "to-committed":
        return f"{name} moved from {label(from_model)} to {label(to_model)}"
    return f"{name} moved off {label(from_model)} back to {label(to_model)}"


def _detail(direction: str, avoided: float | None, unit: str) -> str:
    per_unit = f" per {unit}" if unit else ""
    if direction == "to-committed":
        base = (
            "This usage is now covered by a commitment, so the amount billed "
            "against it drops even though the resource is running exactly as "
            "before."
        )
        if avoided:
            return (
                base
                + f" At last month's on-demand rate{per_unit}, the newly covered "
                f"usage would have cost {avoided:,.2f} — that is avoided "
                "on-demand cost, not money saved this month, because the "
                "commitment itself was paid for when it was bought."
            )
        return base
    return (
        "This usage is no longer covered by a commitment and is being billed at "
        "on-demand rates again. A reservation that expired, was exchanged, or "
        "no longer matches the running size will do this — the cost rises with "
        "no change in usage."
    )
