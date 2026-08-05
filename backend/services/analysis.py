"""
Cost analysis logic:
- Aggregate raw records into monthly buckets
- Month-over-month comparison
- Spike detection (>20% MoM increase)
- Top cost drivers
- Savings detection (negative MoM change)
"""
from collections import defaultdict
from typing import List, Dict, Any


def _parse_usage_date(date_val) -> str:
    """Convert YYYYMMDD int or YYYY-MM-DD string to 'YYYY-MM' month key."""
    s = str(date_val)
    if len(s) == 8 and s.isdigit():
        return f"{s[:4]}-{s[4:6]}"
    if "-" in s:
        return s[:7]
    return s[:7]


def aggregate_by_month(records: List[Dict[str, Any]]) -> Dict[str, Dict]:
    """
    Group raw cost records into:
    {
      "2026-01": {
        "total": 1234.56,
        "currency": "USD",
        "by_service": { "Virtual Machines": 800.0, ... },
        "by_subscription": { "sub-id": 1234.56, ... }
      }
    }
    """
    monthly: Dict[str, Dict] = defaultdict(lambda: {
        "total": 0.0,
        "currency": "USD",
        "by_service": defaultdict(float),
        "by_subscription": defaultdict(float),
    })

    for r in records:
        # Locate cost value — key may vary
        cost_val = r.get("PreTaxCost") or r.get("Cost") or r.get("totalCost") or 0.0
        cost = float(cost_val)

        month_key = _parse_usage_date(
            r.get("BillingMonth") or r.get("UsageDate") or r.get("Date") or "19700101"
        )

        service = r.get("ServiceName") or r.get("MeterCategory") or "Unknown"
        sub_id = r.get("SubscriptionId") or r.get("SubscriptionGuid") or "unknown"
        currency = r.get("Currency") or "USD"

        monthly[month_key]["total"] += cost
        monthly[month_key]["currency"] = currency
        monthly[month_key]["by_service"][service] += cost
        monthly[month_key]["by_subscription"][sub_id] += cost

    # Convert defaultdicts to regular dicts
    return {
        k: {
            "total": round(v["total"], 4),
            "currency": v["currency"],
            "by_service": dict(v["by_service"]),
            "by_subscription": dict(v["by_subscription"]),
        }
        for k, v in sorted(monthly.items())
    }


def mom_change_pct(current: float, previous: float) -> float | None:
    """Calculate month-over-month percentage change."""
    if previous == 0:
        return None
    return round((current - previous) / previous * 100, 2)


def detect_anomalies(monthly: Dict[str, Dict], threshold_pct: float = 20.0) -> List[Dict]:
    """
    Detect service-level cost spikes (MoM increase > threshold_pct%).
    Returns list of { service, month, prev_month, pct_change, current_cost, prev_cost,
                       reason, subscription_ids }
    """
    months = sorted(monthly.keys())
    anomalies = []

    for i in range(1, len(months)):
        prev_month = months[i - 1]
        curr_month = months[i]
        prev_services = monthly[prev_month]["by_service"]
        curr_services = monthly[curr_month]["by_service"]

        all_services = set(prev_services) | set(curr_services)
        for service in all_services:
            prev_cost = prev_services.get(service, 0.0)
            curr_cost = curr_services.get(service, 0.0)
            if prev_cost == 0:
                continue
            pct = mom_change_pct(curr_cost, prev_cost)
            if pct is not None and pct > threshold_pct:
                # Identify which subscriptions contributed to this month's cost
                sub_ids = list(monthly[curr_month].get("by_subscription", {}).keys())
                anomalies.append({
                    "service": service,
                    "month": curr_month,
                    "prev_month": prev_month,
                    "pct_change": pct,
                    "current_cost": round(curr_cost, 2),
                    "prev_cost": round(prev_cost, 2),
                    "reason": _explain_spike(service, pct, curr_cost, prev_cost),
                    "subscription_ids": sub_ids,
                })

    return sorted(anomalies, key=lambda x: x["pct_change"], reverse=True)


def detect_savings(monthly: Dict[str, Dict]) -> List[Dict]:
    """
    Detect service-level cost reductions (MoM decrease).
    Returns list of { service, month, pct_change, saved_amount }
    """
    months = sorted(monthly.keys())
    savings = []

    for i in range(1, len(months)):
        prev_month = months[i - 1]
        curr_month = months[i]
        prev_services = monthly[prev_month]["by_service"]
        curr_services = monthly[curr_month]["by_service"]

        for service in set(prev_services) | set(curr_services):
            prev_cost = prev_services.get(service, 0.0)
            curr_cost = curr_services.get(service, 0.0)
            if prev_cost == 0:
                continue
            pct = mom_change_pct(curr_cost, prev_cost)
            if pct is not None and pct < -5:
                savings.append({
                    "service": service,
                    "month": curr_month,
                    "pct_change": pct,
                    "saved_amount": round(prev_cost - curr_cost, 2),
                })

    return sorted(savings, key=lambda x: x["saved_amount"], reverse=True)


def top_services(monthly: Dict[str, Dict], top_n: int = 10) -> List[Dict]:
    """
    Return top N services by total cost across all months, with MoM change
    between the two most recent months.
    """
    if not monthly:
        return []

    months = sorted(monthly.keys())
    totals: Dict[str, float] = defaultdict(float)
    for m in months:
        for svc, cost in monthly[m]["by_service"].items():
            totals[svc] += cost

    top = sorted(totals.items(), key=lambda x: x[1], reverse=True)[:top_n]

    # Compute MoM change using last two months
    prev_month_data = monthly[months[-2]]["by_service"] if len(months) >= 2 else {}
    curr_month_data = monthly[months[-1]]["by_service"] if months else {}

    result = []
    for svc, total in top:
        pct = mom_change_pct(
            curr_month_data.get(svc, 0.0),
            prev_month_data.get(svc, 0.0),
        )
        result.append({
            "service": svc,
            "total_cost": round(total, 2),
            "latest_month_cost": round(curr_month_data.get(svc, 0.0), 2),
            "mom_change_pct": pct,
        })

    return result


def aggregate_by_rg(records: List[Dict[str, Any]]) -> Dict[str, Dict]:
    """
    Group raw cost records by Resource Group:
    {
      "rg-name": {
        "total": 1234.56,
        "currency": "USD",
        "by_service": { "Virtual Machines": 800.0, ... },
        "by_month": { "2026-01": 200.0, ... },
      }
    }
    """
    by_rg: Dict[str, Dict] = defaultdict(lambda: {
        "total": 0.0,
        "currency": "USD",
        "by_service": defaultdict(float),
        "by_month": defaultdict(float),
    })

    for r in records:
        cost_val = r.get("PreTaxCost") or r.get("Cost") or r.get("totalCost") or 0.0
        cost = float(cost_val)
        rg = r.get("ResourceGroupName") or r.get("ResourceGroup") or "Unknown"
        service = r.get("ServiceName") or r.get("MeterCategory") or "Unknown"
        currency = r.get("Currency") or "USD"
        month_key = _parse_usage_date(
            r.get("BillingMonth") or r.get("UsageDate") or r.get("Date") or "19700101"
        )
        by_rg[rg]["total"] += cost
        by_rg[rg]["currency"] = currency
        by_rg[rg]["by_service"][service] += cost
        by_rg[rg]["by_month"][month_key] += cost

    return {
        k: {
            "rg_name": k,
            "total": round(v["total"], 4),
            "currency": v["currency"],
            "by_service": dict(v["by_service"]),
            "by_month": dict(sorted(v["by_month"].items())),
        }
        for k, v in sorted(by_rg.items(), key=lambda x: x[1]["total"], reverse=True)
    }


def aggregate_daily(records: List[Dict[str, Any]]) -> Dict[str, Dict]:
    """
    Group raw cost records by daily bucket.
    Records must come from a Daily granularity query.
    Returns { "2026-01-15": { "total": 123.4, "currency": "USD", "by_service": {...} } }
    """
    daily: Dict[str, Dict] = defaultdict(lambda: {
        "total": 0.0,
        "currency": "USD",
        "by_service": defaultdict(float),
    })

    for r in records:
        cost_val = r.get("PreTaxCost") or r.get("Cost") or r.get("totalCost") or 0.0
        cost = float(cost_val)
        raw_date = r.get("UsageDate") or r.get("Date") or r.get("BillingMonth") or "19700101"
        # Parse YYYYMMDD int or YYYY-MM-DD string to YYYY-MM-DD
        s = str(raw_date)
        if len(s) == 8 and s.isdigit():
            day_key = f"{s[:4]}-{s[4:6]}-{s[6:8]}"
        elif len(s) >= 10:
            day_key = s[:10]
        else:
            day_key = s
        service = r.get("ServiceName") or r.get("MeterCategory") or "Unknown"
        currency = r.get("Currency") or "USD"
        daily[day_key]["total"] += cost
        daily[day_key]["currency"] = currency
        daily[day_key]["by_service"][service] += cost

    return {
        k: {
            "date": k,
            "total": round(v["total"], 4),
            "currency": v["currency"],
            "by_service": dict(v["by_service"]),
        }
        for k, v in sorted(daily.items())
    }


def _explain_spike(service: str, pct: float, curr: float, prev: float) -> str:
    diff = round(curr - prev, 2)
    if pct > 200:
        return (
            f"{service} cost surged {pct:.0f}% (+${diff:,.2f}) — "
            "likely a new large deployment, scaling event, or licensing change."
        )
    if pct > 50:
        return (
            f"{service} increased {pct:.0f}% (+${diff:,.2f}) — "
            "possible resource scaling, new service activation, or unexpected usage."
        )
    return (
        f"{service} rose {pct:.0f}% (+${diff:,.2f}) — "
        "review recent deployments or configuration changes for this service."
    )


def build_summary(monthly: Dict[str, Dict]) -> Dict:
    """Build the full analysis summary from aggregated monthly data."""
    months = sorted(monthly.keys())
    total_6m = round(sum(v["total"] for v in monthly.values()), 2)

    curr_total = monthly[months[-1]]["total"] if months else 0
    prev_total = monthly[months[-2]]["total"] if len(months) >= 2 else 0
    overall_mom = mom_change_pct(curr_total, prev_total)

    return {
        "months": [
            {
                "month": m,
                "total_cost": round(monthly[m]["total"], 2),
                "currency": monthly[m]["currency"],
                "by_service": monthly[m]["by_service"],
                "by_subscription": monthly[m]["by_subscription"],
            }
            for m in months
        ],
        "total_6m": total_6m,
        "mom_change_pct": overall_mom,
        "top_services": top_services(monthly),
        "anomalies": detect_anomalies(monthly),
        "savings": detect_savings(monthly),
    }
