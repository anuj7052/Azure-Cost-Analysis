"""Resource/meter detail for the three billing views exposed in Cost Explorer.

PAYG and RI are filtered by Azure PricingModel before grouping. DR/ASR is a
service view, not a pricing model; its explicitly named Site Recovery meters
may overlap the PAYG or RI views. Ordinary DR VMs/disks cannot be identified
from billing names alone and are not guessed into this view.
"""
import re

from services.pricing import _cost_of, _month_of, _service_of, parse_resource_id

PRICING_FILTERS = {"payg": "OnDemand", "ri": "Reservation"}


def is_site_recovery(record: dict) -> bool:
    for key in ("ServiceName", "MeterCategory", "Meter", "MeterName", "MeterSubcategory", "MeterSubCategory"):
        text = re.sub(r"[^a-z0-9]+", " ", str(record.get(key) or "").lower()).strip()
        if re.search(r"\bsite recovery\b|\basr\b", text):
            return True
    return False


def category_detail(records: list[dict], category: str) -> dict:
    # A sum across currencies would be a meaningless monetary amount.
    currencies = {str(r.get("Currency") or r.get("BillingCurrency") or "").strip()
                  for r in records} - {""}
    if len(currencies) > 1:
        raise ValueError("The selected subscriptions use different billing currencies. Select subscriptions with the same currency.")
    selected = [r for r in records if category != "asr" or is_site_recovery(r)]
    rows = []
    for record in selected:
        # Keep zero-cost RI-covered usage visible; it is not an absent record.
        resource_id = str(record.get("ResourceId") or "")
        identity = parse_resource_id(resource_id)
        rows.append({
            "month": _month_of(record), "cost": _cost_of(record),
            "service": _service_of(record), "meter": str(record.get("Meter") or record.get("MeterName") or ""),
            "resource_id": resource_id, "resource_name": identity["name"],
            "resource_group": identity["resource_group"],
            "subscription_id": record.get("SubscriptionId") or identity["subscription_id"],
        })
    rows.sort(key=lambda row: (-row["cost"], row["month"], row["resource_id"], row["meter"]))
    services = {}
    for row in rows:
        services[row["service"]] = services.get(row["service"], 0.0) + row["cost"]
    return {
        "category": category,
        "cost_basis": "ActualCost",
        "currency": next(iter(currencies), "USD"),
        "total": round(sum(row["cost"] for row in rows), 2),
        "rows": rows,
        "services": [{"service": service, "cost": round(cost, 2)}
                     for service, cost in sorted(services.items(), key=lambda item: -item[1])],
        "months": sorted({row["month"] for row in rows}),
        "resource_count": len({row["resource_id"].lower() for row in rows if row["resource_id"]}),
        "unattributed_cost": round(sum(row["cost"] for row in rows if not row["resource_id"]), 2),
    }
