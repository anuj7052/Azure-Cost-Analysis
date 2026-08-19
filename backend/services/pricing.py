"""
Split spend by how it was priced: reserved, on-demand, spot or savings plan.

A single "total cost" hides the question people actually have about
reservations, which is not "what did we spend" but "how much of our spend is
already committed, and how much is still being bought at list price".

Azure answers this through the `PricingModel` dimension. Its values are the
authority here — nothing is inferred from meter or service names, because a VM
meter looks identical whether or not a reservation happened to cover it.
"""
from collections import defaultdict
from typing import Any, Dict, List

# Values Azure returns for the PricingModel dimension.
RESERVATION = "Reservation"
ON_DEMAND = "OnDemand"
SPOT = "Spot"
SAVINGS_PLAN = "SavingsPlan"

# Anything Azure reports that is not one of the above is kept under its own name
# rather than folded into on-demand, so a new pricing model shows up as itself
# instead of quietly inflating the figure people benchmark against.
KNOWN_MODELS = (RESERVATION, ON_DEMAND, SPOT, SAVINGS_PLAN)

# Committed spend is bought ahead of use. Grouping the savings plan with the
# reservation matches how the commitment is actually managed and renewed.
COMMITTED_MODELS = (RESERVATION, SAVINGS_PLAN)


def _first(record: Dict[str, Any], *keys: str) -> str:
    for key in keys:
        value = record.get(key)
        if value:
            return str(value)
    return ""


def _model_of(record: Dict[str, Any]) -> str:
    """
    The pricing model for one row.

    Azure omits the dimension entirely on some rows rather than returning a
    value, and those are genuinely unknown. Defaulting them to on-demand would
    overstate uncommitted spend, which is the number this whole feature exists
    to report, so they are labelled honestly instead.
    """
    model = _first(record, "PricingModel", "pricingModel").strip()
    if not model:
        return "Unknown"
    for known in KNOWN_MODELS:
        if model.lower() == known.lower():
            return known
    return model


def _cost_of(record: Dict[str, Any]) -> float:
    for key in ("PreTaxCost", "Cost", "totalCost"):
        if record.get(key) is not None:
            try:
                return float(record[key])
            except (TypeError, ValueError):
                return 0.0
    return 0.0


def _service_of(record: Dict[str, Any]) -> str:
    return _first(record, "ServiceName", "MeterCategory") or "Unknown"


def _month_of(record: Dict[str, Any]) -> str:
    """Cost Management returns the period as YYYYMMDD, or an ISO timestamp."""
    raw = _first(record, "UsageDate", "BillingMonth", "usageDate")
    if not raw:
        return ""
    digits = raw.split("T")[0].replace("-", "")
    return f"{digits[:4]}-{digits[4:6]}" if len(digits) >= 6 else ""


def parse_resource_id(resource_id: str) -> Dict[str, str]:
    """
    Pull the readable parts out of an Azure resource id.

    Cost Management returns the full path and nothing else, so the resource
    group and the resource name — the two things needed to actually go and look
    at the thing — have to be recovered from the string.

    Shape:
      /subscriptions/{sub}/resourceGroups/{rg}/providers/{ns}/{type}/{name}
    """
    parts = [p for p in (resource_id or "").split("/") if p]
    out = {"subscription_id": "", "resource_group": "", "resource_type": "", "name": ""}

    for index, part in enumerate(parts):
        lowered = part.lower()
        if lowered == "subscriptions" and index + 1 < len(parts):
            out["subscription_id"] = parts[index + 1]
        elif lowered == "resourcegroups" and index + 1 < len(parts):
            out["resource_group"] = parts[index + 1]
        elif lowered == "providers" and index + 2 < len(parts):
            # Everything after the namespace up to the final segment is the
            # type; the last segment is the resource's own name.
            out["resource_type"] = "/".join(parts[index + 2:-1]) or parts[index + 2]
            out["name"] = parts[-1]

    # A malformed or truncated id still yields something identifiable rather
    # than an empty row the user cannot act on.
    if not out["name"] and parts:
        out["name"] = parts[-1]

    return out


def reserved_detail(records: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Which resources a reservation actually paid for.

    "You spent X on reserved instances" is not actionable on its own — the
    question that follows is always *which* machines, in *which* resource group,
    on *which* SKU. This resolves each reserved charge back to the resource and
    meter behind it.

    Meters are kept per resource rather than summed away, because the meter name
    is where the SKU lives (e.g. "D2s v3"), and that is what a renewal decision
    turns on.
    """
    by_resource: Dict[str, Dict[str, Any]] = {}
    currency = "USD"
    total = 0.0

    for record in records:
        if _model_of(record) != RESERVATION:
            continue

        resource_id = _first(record, "ResourceId", "resourceId", "Resource")
        cost = _cost_of(record)
        total += cost

        found = _first(record, "Currency", "BillingCurrency", "currency")
        if found:
            currency = found

        # Azure is inconsistent about the casing of resource ids between APIs,
        # so the key is normalised or the same machine appears twice.
        key = resource_id.lower()
        entry = by_resource.get(key)
        if entry is None:
            parsed = parse_resource_id(resource_id)
            entry = {
                "resource_id": resource_id,
                "name": parsed["name"] or "Unattributed",
                "resource_group": parsed["resource_group"],
                "subscription_id": parsed["subscription_id"] or _first(
                    record, "SubscriptionId", "subscriptionId"
                ),
                "resource_type": parsed["resource_type"],
                "service": _service_of(record),
                "cost": 0.0,
                "meters": {},
            }
            by_resource[key] = entry

        entry["cost"] += cost
        meter = _first(record, "Meter", "MeterName", "MeterSubcategory")
        if meter:
            entry["meters"][meter] = entry["meters"].get(meter, 0.0) + cost

    resources = []
    for entry in by_resource.values():
        resources.append({
            "resource_id": entry["resource_id"],
            "name": entry["name"],
            "resource_group": entry["resource_group"],
            "subscription_id": entry["subscription_id"],
            "resource_type": entry["resource_type"],
            "service": entry["service"],
            "cost": round(entry["cost"], 2),
            # Priciest meter first — it is the one that identifies the SKU.
            "meters": [
                {"name": name, "cost": round(amount, 2)}
                for name, amount in sorted(
                    entry["meters"].items(), key=lambda kv: kv[1], reverse=True
                )
            ],
        })

    resources.sort(key=lambda r: -r["cost"])

    return {
        "currency": currency,
        "total": round(total, 2),
        "resource_count": len(resources),
        "resources": resources,
    }


def summarise_pricing(records: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Group spend by pricing model, with the per-service and per-month splits.

    Percentages are of the total, so "coverage" here means the share of spend
    already committed — not the share of *capacity* covered, which needs
    reservation utilisation data this query does not return. The distinction
    matters: 70% committed spend does not mean 70% of VMs are covered.
    """
    by_model: Dict[str, float] = defaultdict(float)
    by_service: Dict[str, Dict[str, float]] = defaultdict(lambda: defaultdict(float))
    by_month: Dict[str, Dict[str, float]] = defaultdict(lambda: defaultdict(float))
    currency = "USD"

    for record in records:
        model = _model_of(record)
        cost = _cost_of(record)
        by_model[model] += cost
        by_service[_service_of(record)][model] += cost

        month = _month_of(record)
        if month:
            by_month[month][model] += cost

        found = _first(record, "Currency", "BillingCurrency", "currency")
        if found:
            currency = found

    total = sum(by_model.values())
    committed = sum(by_model.get(m, 0.0) for m in COMMITTED_MODELS)
    on_demand = by_model.get(ON_DEMAND, 0.0)

    services = [
        {
            "service": service,
            "total": round(sum(models.values()), 2),
            "reserved": round(models.get(RESERVATION, 0.0), 2),
            "on_demand": round(models.get(ON_DEMAND, 0.0), 2),
            "spot": round(models.get(SPOT, 0.0), 2),
            "savings_plan": round(models.get(SAVINGS_PLAN, 0.0), 2),
        }
        for service, models in by_service.items()
    ]
    # Biggest uncommitted spend first: that is where a reservation would pay
    # for itself, which is the decision this table exists to inform.
    services.sort(key=lambda s: -s["on_demand"])

    months = [
        {
            "month": month,
            "reserved": round(by_month[month].get(RESERVATION, 0.0), 2),
            "on_demand": round(by_month[month].get(ON_DEMAND, 0.0), 2),
            "spot": round(by_month[month].get(SPOT, 0.0), 2),
            "savings_plan": round(by_month[month].get(SAVINGS_PLAN, 0.0), 2),
            "total": round(sum(by_month[month].values()), 2),
        }
        for month in sorted(by_month)
    ]

    return {
        "currency": currency,
        "total": round(total, 2),
        "reserved": round(by_model.get(RESERVATION, 0.0), 2),
        "savings_plan": round(by_model.get(SAVINGS_PLAN, 0.0), 2),
        "spot": round(by_model.get(SPOT, 0.0), 2),
        "on_demand": round(on_demand, 2),
        "committed": round(committed, 2),
        # Share of spend already committed. Zero total means no data, not 100%
        # coverage — dividing anyway would report a perfect score for an empty
        # subscription.
        "committed_pct": round(committed / total * 100, 1) if total else None,
        "by_model": {model: round(cost, 2) for model, cost in sorted(by_model.items())},
        "services": services,
        "months": months,
        # True only when Azure actually reported the dimension. Without it the
        # split is meaningless and the UI must say so rather than draw a chart
        # showing everything as on-demand.
        "has_pricing_data": any(m != "Unknown" for m in by_model),
    }
