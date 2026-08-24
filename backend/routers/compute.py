"""
Compute intelligence — the VM fleet, what it costs, and what it actually did.

This endpoint joins four independent Azure sources, and the joining is the
whole value: none of them can answer the question alone.

  * **Resource Graph** — what VMs exist, their size, region and power state.
  * **Cost Management** — what each one cost last month.
  * **Azure Monitor** — what each one was actually doing.
  * **Retail Prices** — what the proposed smaller size would cost instead.

Every one of them can fail independently, and three of the four are optional.
A missing Monitor permission must produce a fleet list with "not enough data"
against each VM, not an error page — the inventory and the cost are still true
and still useful. Which sources succeeded is reported in `sources` so the UI
can say why a column is empty rather than showing a blank cell.
"""
import asyncio
import logging
from typing import Any, Dict, List, Optional

import aiosqlite
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from auth.dependencies import get_current_user
from core.db import get_db
from services import azure_metrics, compute_intel
from services.analysis import resource_cost_index
from services.azure_errors import azure_error
from services.cost_client import query_costs
from services.orphaned import run_graph_query
from services.retail_prices import fetch_prices
from services.token_resolver import resolve_tenant_token

router = APIRouter(prefix="/api/compute", tags=["compute"])

log = logging.getLogger(__name__)

# Power state is a per-instance property, so it is only available through the
# `instanceView` expansion Resource Graph exposes as `properties.extended`.
# Without it every VM reads as "unknown" and stopped-but-billed VMs — the most
# valuable finding here — become undetectable.
VM_QUERY = """
resources
| where type =~ 'microsoft.compute/virtualMachines'
| extend powerState = tostring(properties.extended.instanceView.powerState.code)
| extend sku = tostring(properties.hardwareProfile.vmSize)
| extend osType = tostring(properties.storageProfile.osDisk.osType)
| project id, name, sku, location, resourceGroup, subscriptionId,
          powerState, osType, tags
| order by name asc
"""


class ComputeRequest(BaseModel):
    tenant_id: str
    subscription_ids: List[str] = Field(default_factory=list)
    # 30 days matches Azure Monitor's 1-minute retention and gives a stable
    # P99. Shorter windows make the periodic-peak veto unreliable.
    days: int = Field(default=30, ge=7, le=90)
    currency: str = "USD"


async def _fleet(token: str, subscription_ids: List[str]) -> List[Dict[str, Any]]:
    """The VM inventory, normalised into the shape `compute_intel` expects."""
    rows = await run_graph_query(token, subscription_ids, VM_QUERY)
    return [{
        "id": row.get("id"),
        "name": row.get("name"),
        "sku": row.get("sku") or "",
        "region": row.get("location") or "",
        "resource_group": row.get("resourceGroup") or "",
        "subscription_id": row.get("subscriptionId") or "",
        "power_state": row.get("powerState") or "",
        "os_type": row.get("osType") or "",
        "tags": row.get("tags") or {},
        # Resource Graph carries the type in lower case, which is what
        # `metrics_for` matches on.
        "type": "microsoft.compute/virtualmachines",
    } for row in rows]


async def _price_lookup(
    skus: List[str], region: str, currency: str
) -> Dict[str, float]:
    """
    Hourly retail prices for the sizes involved in a recommendation.

    Only Consumption prices for Windows-free (Linux) meters are used, because
    mixing a Windows-licensed price for one size with a Linux price for another
    would produce a saving figure that is arithmetic on two different products.
    Returns whatever it could read — a partial map simply means fewer priced
    recommendations, which `estimate_savings` already handles honestly.
    """
    if not skus or not region:
        return {}

    quoted = ", ".join(f"'{s}'" for s in sorted(set(skus)) if s)
    if not quoted:
        return {}

    odata = (
        f"serviceName eq 'Virtual Machines' and armRegionName eq '{region}' "
        f"and type eq 'Consumption' and armSkuName in ({quoted})"
    )

    try:
        items = await fetch_prices(odata, currency=currency)
    except Exception as exc:
        log.warning("retail price lookup failed for %s: %s", region, exc)
        return {}

    prices: Dict[str, float] = {}
    for item in items:
        # `fetch_prices` returns the normalised shape, not Microsoft's raw
        # camelCase envelope.
        name = item.get("arm_sku_name") or ""
        meter = (item.get("meter_name") or "").lower()
        price = item.get("retail_price")
        # Spot and low-priority meters are a different product with a different
        # availability guarantee; quoting them as the saving would be wrong.
        if not name or price is None:
            continue
        if "spot" in meter or "low priority" in meter:
            continue
        if "windows" in (item.get("product_name") or "").lower():
            continue
        # Several meters can match one SKU; the lowest on-demand rate is the
        # one a customer would actually pay.
        if name not in prices or price < prices[name]:
            prices[name] = float(price)

    return prices


@router.post("")
async def analyse_compute(
    body: ComputeRequest,
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
) -> Dict[str, Any]:
    """
    The VM fleet with a right-sizing verdict and an evidenced saving per machine.

    Read-only. Nothing here resizes, stops or deletes anything — the actions are
    described so an owner can carry them out in the portal or in their own IaC,
    which is where the change belongs and where it will be audited.
    """
    token = await resolve_tenant_token(body.tenant_id, current_user, db)

    sources = {"inventory": "ok", "cost": "ok", "metrics": "ok", "prices": "ok"}

    try:
        fleet = await _fleet(token, body.subscription_ids)
    except Exception as exc:
        # Inventory is the one source with no fallback. Without it there is no
        # list to annotate, so this is the only failure that ends the request.
        raise azure_error(exc, "your virtual machines")

    if not fleet:
        return {
            "vms": [], "summary": compute_intel.summarise_fleet([]),
            "currency": body.currency, "sources": sources,
            "note": "No virtual machines were found in the selected subscriptions.",
        }

    # ── cost, per resource ──
    cost_records: List[Dict[str, Any]] = []
    for sub_id in body.subscription_ids:
        try:
            cost_records.extend(await query_costs(
                token=token, subscription_id=sub_id, months=1,
                group_by=["ResourceId", "ServiceName"], granularity="Monthly",
            ))
        except Exception as exc:
            log.warning("compute cost lookup failed for %s: %s", sub_id, exc)
            sources["cost"] = "partial"

    cost_index = resource_cost_index(cost_records)
    currency = next((r.get("Currency") for r in cost_records if r.get("Currency")),
                    body.currency)

    for vm in fleet:
        vm["monthly_cost"] = cost_index.get((vm["id"] or "").lower())

    # ── utilization ──
    metrics_by_id: Dict[str, Dict[str, Any]] = {}
    try:
        raw = await azure_metrics.fetch_many(token, fleet, days=body.days)
        metrics_by_id = {rid: (r.get("metrics") or {}) for rid, r in raw.items()}
        if any(r.get("kind") == "permission" for r in raw.values()):
            sources["metrics"] = "permission"
        elif any(r.get("kind") == "throttled" for r in raw.values()):
            sources["metrics"] = "partial"
    except Exception as exc:
        log.warning("metrics fetch failed: %s", exc)
        sources["metrics"] = "error"

    # ── prices for the proposed targets ──
    # Grouped by region, because the same size costs different amounts in
    # different regions and a single lookup would silently apply one region's
    # price to the whole fleet.
    by_region: Dict[str, List[str]] = {}
    for vm in fleet:
        target = compute_intel.smaller_sku(vm["sku"])
        if target:
            by_region.setdefault(vm["region"], []).extend([vm["sku"], target])

    price_lookups = await asyncio.gather(*(
        _price_lookup(skus, region, currency) for region, skus in by_region.items()
    ), return_exceptions=True)

    prices_by_region: Dict[str, Dict[str, float]] = {}
    for region, result in zip(by_region.keys(), price_lookups):
        prices_by_region[region] = result if isinstance(result, dict) else {}
    if by_region and not any(prices_by_region.values()):
        sources["prices"] = "unavailable"

    analyses = [
        compute_intel.analyse_vm(
            vm,
            metrics_by_id.get(vm["id"], {}),
            prices_by_region.get(vm["region"], {}),
        )
        for vm in fleet
    ]
    analyses.sort(key=compute_intel.sort_key)

    return {
        "vms": analyses,
        "summary": compute_intel.summarise_fleet(analyses),
        "currency": currency,
        "window_days": body.days,
        "sources": sources,
        "note": (
            "Verdicts are based on the 95th and 99th percentile of CPU over the "
            f"last {body.days} days. A machine with a low 95th percentile but a high "
            "99th has a recurring peak and is deliberately not proposed for a "
            "downsize."
        ),
    }
