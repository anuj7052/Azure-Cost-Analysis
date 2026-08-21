"""
Build a Bill of Quantities from what is actually running.

The BOQ elsewhere in this app runs the other way: a pricing-calculator estimate
is uploaded and compared against reality. This builds the estimate *from*
reality — take the live estate, group it the way a quotation is written, and
produce the document.

That reversal is the point. Reconstructing a BOQ by hand from a running
subscription means reading the portal resource by resource and copying SKUs into
a spreadsheet, which is where the errors come from.

Prices are what Azure actually billed, not list prices. A quotation built on
list prices disagrees with the invoice the moment any discount, reservation or
negotiated rate applies — which is to say, almost always.
"""
from typing import Any, Dict, List

# Resources Azure reports but nobody quotes: they carry no independent charge
# and padding a BOQ with them makes it harder to read, not more complete.
NON_BILLABLE_TYPES = {
    "microsoft.resources/subscriptions/resourcegroups",
    "microsoft.network/networkwatchers",
    "microsoft.insights/autoscalesettings",
}


def _service_of(resource: Dict[str, Any]) -> str:
    """
    A readable service name.

    Cost Management supplies one for anything that was billed. For the rest the
    resource type is the honest fallback: "Microsoft.Compute/virtualMachines"
    becomes "Virtual Machines".
    """
    billed = (resource.get("service") or "").strip()
    if billed:
        return billed

    type_id = (resource.get("type") or "").strip()
    if not type_id:
        return "Other"

    last = type_id.split("/")[-1]
    spaced = "".join(f" {c}" if c.isupper() else c for c in last).strip()
    return spaced.title() or "Other"


def _spec_of(resource: Dict[str, Any]) -> str:
    """The size a quotation would list: SKU, VM size, or disk capacity."""
    for key in ("sku", "size", "tier"):
        value = (resource.get(key) or "").strip()
        if value:
            return value
    return "Standard"


def build_boq(resources: List[Dict[str, Any]], currency: str = "USD") -> Dict[str, Any]:
    """
    Group live resources into quotable line items.

    Grouping is by service, spec and region together, because those three are
    what determine a price. Ten identical VMs in one region are one line with a
    quantity of ten — which is how a quotation is written, and how it stays
    readable. The same VM size in another region is a separate line, because it
    is a different rate.
    """
    groups: Dict[tuple, Dict[str, Any]] = {}
    unpriced = 0

    for resource in resources:
        type_id = (resource.get("type") or "").lower()
        if type_id in NON_BILLABLE_TYPES:
            continue

        service = _service_of(resource)
        spec = _spec_of(resource)
        region = (resource.get("location") or "").strip() or "unknown"
        key = (service, spec, region)

        cost = resource.get("cost")
        if cost is None:
            # No billed cost is not the same as free: Cost Management may simply
            # not have reported it yet, or the query was throttled. Counted so
            # the total can be honest about what it excludes.
            unpriced += 1

        entry = groups.get(key)
        if entry is None:
            entry = {
                "service": service,
                "spec": spec,
                "region": region,
                "quantity": 0,
                "monthly_cost": 0.0,
                "priced_quantity": 0,
                "resource_groups": set(),
                "examples": [],
            }
            groups[key] = entry

        entry["quantity"] += 1
        if cost is not None:
            entry["monthly_cost"] += float(cost)
            entry["priced_quantity"] += 1

        rg = (resource.get("resource_group") or "").strip()
        if rg:
            entry["resource_groups"].add(rg)
        if len(entry["examples"]) < 3 and resource.get("name"):
            entry["examples"].append(resource["name"])

    items = []
    for entry in groups.values():
        priced = entry["priced_quantity"]
        items.append({
            "service": entry["service"],
            "spec": entry["spec"],
            "region": entry["region"],
            "quantity": entry["quantity"],
            # Averaged over the priced resources only. Dividing by the full
            # quantity would quietly understate the rate whenever some of the
            # group had no cost reported.
            "unit_monthly_cost": round(entry["monthly_cost"] / priced, 2) if priced else None,
            "monthly_cost": round(entry["monthly_cost"], 2),
            "resource_groups": sorted(entry["resource_groups"]),
            "examples": entry["examples"],
            "priced_quantity": priced,
        })

    # Most expensive first: a quotation is read top-down, and the lines that
    # matter are the ones carrying the money.
    items.sort(key=lambda i: -i["monthly_cost"])

    total = round(sum(i["monthly_cost"] for i in items), 2)

    return {
        "items": items,
        "currency": currency,
        "total_monthly": total,
        # A yearly figure is what a quotation is usually asked for, and it is a
        # projection of current spend rather than a commitment.
        "total_yearly": round(total * 12, 2),
        "resource_count": sum(i["quantity"] for i in items),
        "line_count": len(items),
        "unpriced_count": unpriced,
    }


def to_csv_rows(boq: Dict[str, Any]) -> List[List[str]]:
    """
    Flatten a BOQ for export.

    Returned as rows rather than a CSV string so the caller decides on encoding
    and delimiters — Excel in some locales expects a semicolon.
    """
    currency = boq.get("currency", "USD")
    rows = [[
        "Service",
        "Spec / SKU",
        "Region",
        "Quantity",
        f"Unit monthly ({currency})",
        f"Monthly total ({currency})",
        f"Yearly total ({currency})",
        "Resource groups",
        "Examples",
    ]]

    for item in boq.get("items", []):
        rows.append([
            item["service"],
            item["spec"],
            item["region"],
            str(item["quantity"]),
            "" if item["unit_monthly_cost"] is None else f"{item['unit_monthly_cost']:.2f}",
            f"{item['monthly_cost']:.2f}",
            f"{item['monthly_cost'] * 12:.2f}",
            "; ".join(item["resource_groups"]),
            "; ".join(item["examples"]),
        ])

    rows.append([])
    rows.append([
        "TOTAL", "", "",
        str(boq.get("resource_count", 0)),
        "",
        f"{boq.get('total_monthly', 0):.2f}",
        f"{boq.get('total_yearly', 0):.2f}",
        "", "",
    ])

    return rows
