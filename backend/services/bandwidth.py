"""
Bandwidth / data-transfer analytics.

Turns raw Cost Management usage records (meter level) into a normalised
egress / ingress / intra-region breakdown, with byte-accurate sizes so the
UI can render proper GB / TB values next to the amount charged.
"""
from typing import Any, Dict, List

GB = 1024 ** 3
TB = 1024 ** 4

# Meter categories that represent network data transfer.
BANDWIDTH_CATEGORIES = {
    "bandwidth",
    "content delivery network",
    "azure front door service",
    "vpn gateway",
    "expressroute",
    "traffic manager",
    "nat gateway",
}

# Keyword hints used when the meter category is not explicitly bandwidth.
TRANSFER_KEYWORDS = (
    "data transfer",
    "data processed",
    "data out",
    "data in",
    "egress",
    "ingress",
    "bandwidth",
    "routing rules",
    "geo-replication data transfer",
)

EGRESS_HINTS = ("out", "egress", "outbound", "download", "from ")
INGRESS_HINTS = ("in ", " in", "ingress", "inbound", "upload", "to ")
INTRA_HINTS = ("intra-region", "intra region", "availability zone", "zone 1", "same region")

# Azure reports usage in these units for network meters.
UNIT_TO_BYTES = {
    "b": 1,
    "byte": 1,
    "bytes": 1,
    "kb": 1024,
    "mb": 1024 ** 2,
    "gb": GB,
    "tb": TB,
    "pb": 1024 ** 5,
    "gib": GB,
    "tib": TB,
    "1 gb": GB,
    "10 gb": 10 * GB,
    "100 gb": 100 * GB,
    "1 tb": TB,
    "1/gb": GB,
    "gb/month": GB,
}


def _norm(value: Any) -> str:
    return (value or "").strip().lower()


def is_bandwidth_record(rec: Dict[str, Any]) -> bool:
    category = _norm(rec.get("MeterCategory"))
    if category in BANDWIDTH_CATEGORIES:
        return True
    haystack = " ".join(
        _norm(rec.get(key)) for key in ("Meter", "MeterSubcategory", "MeterSubCategory")
    )
    return any(kw in haystack for kw in TRANSFER_KEYWORDS)


def detect_unit_bytes(rec: Dict[str, Any]) -> int:
    """Resolve how many bytes one unit of UsageQuantity represents."""
    unit = _norm(rec.get("UnitOfMeasure") or rec.get("unitOfMeasure"))
    if unit in UNIT_TO_BYTES:
        return UNIT_TO_BYTES[unit]
    for key, factor in UNIT_TO_BYTES.items():
        if key and key in unit:
            return factor
    # Meter names almost always end with the unit, e.g. "Data Transfer Out - GB"
    meter = _norm(rec.get("Meter"))
    for token, factor in (("tb", TB), ("gb", GB), ("mb", 1024 ** 2)):
        if meter.endswith(token) or f" {token}" in meter:
            return factor
    return GB  # Azure network meters default to GB


def classify_direction(rec: Dict[str, Any]) -> str:
    """Return one of: egress | ingress | intra | other."""
    text = " ".join(
        _norm(rec.get(key))
        for key in ("Meter", "MeterSubcategory", "MeterSubCategory", "MeterCategory")
    )
    if any(h in text for h in INTRA_HINTS):
        return "intra"
    if any(h in text for h in EGRESS_HINTS):
        return "egress"
    if any(h in text for h in INGRESS_HINTS):
        return "ingress"
    return "other"


def _record_month(rec: Dict[str, Any]) -> str:
    raw = rec.get("BillingMonth") or rec.get("UsageDate") or rec.get("UsageDateTime")
    if raw is None:
        return "unknown"
    text = str(raw)
    if text.isdigit() and len(text) == 8:      # 20260131
        return f"{text[:4]}-{text[4:6]}"
    return text[:7]                             # 2026-01-31T00:00:00 -> 2026-01


def _quantity(rec: Dict[str, Any]) -> float:
    for key in ("UsageQuantity", "usageQuantity", "Quantity"):
        if rec.get(key) is not None:
            try:
                return float(rec[key])
            except (TypeError, ValueError):
                return 0.0
    return 0.0


def _cost(rec: Dict[str, Any]) -> float:
    for key in ("PreTaxCost", "totalCost", "Cost"):
        if rec.get(key) is not None:
            try:
                return float(rec[key])
            except (TypeError, ValueError):
                return 0.0
    return 0.0


def build_bandwidth_report(records: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Aggregate raw meter records into the bandwidth report payload."""
    currency = "INR"
    by_direction: Dict[str, Dict[str, float]] = {
        d: {"bytes": 0.0, "cost": 0.0} for d in ("egress", "ingress", "intra", "other")
    }
    meters: Dict[str, Dict[str, Any]] = {}
    months: Dict[str, Dict[str, float]] = {}
    subs: Dict[str, Dict[str, float]] = {}

    for rec in records:
        if not is_bandwidth_record(rec):
            continue

        currency = rec.get("Currency") or rec.get("BillingCurrency") or currency
        qty = _quantity(rec)
        cost = _cost(rec)
        size_bytes = qty * detect_unit_bytes(rec)
        direction = classify_direction(rec)

        by_direction[direction]["bytes"] += size_bytes
        by_direction[direction]["cost"] += cost

        meter_name = rec.get("Meter") or rec.get("MeterSubcategory") or "Unknown meter"
        meter = meters.setdefault(
            meter_name,
            {
                "meter": meter_name,
                "category": rec.get("MeterCategory") or "Bandwidth",
                "direction": direction,
                "bytes": 0.0,
                "cost": 0.0,
                "quantity": 0.0,
            },
        )
        meter["bytes"] += size_bytes
        meter["cost"] += cost
        meter["quantity"] += qty

        month_key = _record_month(rec)
        month = months.setdefault(
            month_key,
            {"month": month_key, "egress_bytes": 0.0, "ingress_bytes": 0.0,
             "intra_bytes": 0.0, "other_bytes": 0.0, "total_bytes": 0.0, "cost": 0.0},
        )
        month[f"{direction}_bytes"] += size_bytes
        month["total_bytes"] += size_bytes
        month["cost"] += cost

        sub_id = rec.get("SubscriptionId") or "unknown"
        sub = subs.setdefault(
            sub_id,
            {
                "subscription_id": sub_id, "bytes": 0.0, "cost": 0.0,
                "egress_bytes": 0.0, "egress_cost": 0.0,
                "ingress_bytes": 0.0, "ingress_cost": 0.0,
                "intra_bytes": 0.0, "intra_cost": 0.0,
                "other_bytes": 0.0, "other_cost": 0.0,
                "_meters": {},
            },
        )
        sub["bytes"] += size_bytes
        sub["cost"] += cost
        sub[f"{direction}_bytes"] += size_bytes
        sub[f"{direction}_cost"] += cost
        sub["_meters"][meter_name] = sub["_meters"].get(meter_name, 0.0) + cost

    total_bytes = sum(v["bytes"] for v in by_direction.values())
    total_cost = sum(v["cost"] for v in by_direction.values())

    month_list = sorted(months.values(), key=lambda m: m["month"])
    mom_change_pct = None
    if len(month_list) >= 2:
        prev = month_list[-2]["total_bytes"]
        curr = month_list[-1]["total_bytes"]
        if prev > 0:
            mom_change_pct = round((curr - prev) / prev * 100, 2)

    cost_per_gb = round(total_cost / (total_bytes / GB), 4) if total_bytes else 0.0

    def _round(item: Dict[str, Any]) -> Dict[str, Any]:
        item["bytes"] = round(item["bytes"])
        item["cost"] = round(item["cost"], 2)
        return item

    def _finish_sub(sub: Dict[str, Any]) -> Dict[str, Any]:
        """Add the derived rate / meter fields and drop the internal accumulator."""
        meter_costs = sub.pop("_meters", {})
        sub["meter_count"] = len(meter_costs)
        sub["top_meter"] = max(meter_costs, key=meter_costs.get) if meter_costs else None
        sub["cost_per_gb"] = round(sub["cost"] / (sub["bytes"] / GB), 4) if sub["bytes"] else 0.0
        for key in list(sub):
            if key.endswith("_bytes"):
                sub[key] = round(sub[key])
            elif key.endswith("_cost"):
                sub[key] = round(sub[key], 2)
        return _round(sub)

    return {
        "currency": currency,
        "total_bytes": round(total_bytes),
        "total_cost": round(total_cost, 2),
        "cost_per_gb": cost_per_gb,
        "mom_change_pct": mom_change_pct,
        "egress_bytes": round(by_direction["egress"]["bytes"]),
        "egress_cost": round(by_direction["egress"]["cost"], 2),
        "ingress_bytes": round(by_direction["ingress"]["bytes"]),
        "ingress_cost": round(by_direction["ingress"]["cost"], 2),
        "intra_bytes": round(by_direction["intra"]["bytes"]),
        "intra_cost": round(by_direction["intra"]["cost"], 2),
        "other_bytes": round(by_direction["other"]["bytes"]),
        "other_cost": round(by_direction["other"]["cost"], 2),
        "months": [
            {
                k: (round(v) if k.endswith("_bytes") else round(v, 2) if k == "cost" else v)
                for k, v in m.items()
            }
            for m in month_list
        ],
        "meters": [
            _round(m) for m in sorted(meters.values(), key=lambda m: m["cost"], reverse=True)
        ],
        "by_subscription": [
            _finish_sub(s)
            for s in sorted(subs.values(), key=lambda s: (s["cost"], s["bytes"]), reverse=True)
        ],
    }
