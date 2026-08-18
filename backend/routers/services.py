from fastapi import APIRouter, Depends, HTTPException, Query
from typing import Any, Dict, List
import logging
import aiosqlite
from auth.dependencies import get_current_user
from services.token_resolver import resolve_tenant_token
from services.cost_client import query_active_resources, query_costs
from services.analysis import resource_cost_index
from models.schemas import ActiveService, ServiceMeter
from core.db import get_db

router = APIRouter(prefix="/api/services", tags=["services"])

log = logging.getLogger(__name__)


def _describe_sku(r: Dict[str, Any]) -> Dict[str, str]:
    """
    Reduce the provider-specific size fields to one SKU / size / tier trio.

    A VM reports its size under properties, a managed disk reports a SKU name
    plus a capacity in GB, and everything else uses the sku object. Callers
    only want to know "how big is this thing".
    """
    sku_name = (r.get("skuName") or "").strip()
    vm_size = (r.get("vmSize") or "").strip()
    sku_size = (r.get("skuSize") or "").strip()
    disk_gb = (r.get("diskGb") or "").strip()

    sku = sku_name or vm_size
    size = vm_size if vm_size and vm_size != sku else sku_size
    if not size and disk_gb:
        size = f"{disk_gb} GB"

    return {
        "sku": sku,
        "size": size,
        "tier": (r.get("skuTier") or r.get("diskTier") or "").strip(),
    }


@router.get("", response_model=list[ActiveService])
async def get_active_services(
    tenant_id: str = Query(...),
    subscription_ids: List[str] = Query(...),
    months: int = Query(1, ge=1, le=12),
    from_date: str | None = Query(None),
    to_date: str | None = Query(None),
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    """
    List all active Azure resources with their size and what they cost.

    Inventory comes from Resource Graph and the money from Cost Management, so
    the two are joined on resource id here. The cost half is best effort: a
    throttled or unauthorised billing query still leaves a usable inventory
    rather than failing the whole page.
    """
    token = await resolve_tenant_token(tenant_id, current_user, db)

    try:
        resources = await query_active_resources(token, subscription_ids)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Resource Graph query failed: {exc}")

    cost_records: List[Dict[str, Any]] = []
    for sub_id in subscription_ids:
        try:
            cost_records.extend(await query_costs(
                token=token,
                subscription_id=sub_id,
                months=months,
                from_date=from_date,
                to_date=to_date,
                # Three dimensions is the maximum the Cost Management API takes.
                group_by=["ResourceId", "ServiceName", "Meter"],
                granularity="Monthly",
            ))
        except Exception as exc:
            # Inventory without prices is still worth showing, but a silent
            # failure here looks identical to "nothing was billed", so say so.
            log.warning("Resource cost lookup failed for %s: %s", sub_id, exc)
            continue

    costs = resource_cost_index(cost_records)
    currency = next((r.get("Currency") for r in cost_records if r.get("Currency")), "USD")

    out: List[ActiveService] = []
    for r in resources:
        spec = _describe_sku(r)
        billed = costs.get((r.get("id") or "").lower(), {})
        out.append(ActiveService(
            name=r.get("name", ""),
            type=r.get("type", ""),
            resource_group=r.get("resourceGroup", ""),
            subscription_id=r.get("subscriptionId", ""),
            location=r.get("location", ""),
            tags=r.get("tags") or {},
            sku=spec["sku"],
            size=spec["size"],
            tier=spec["tier"],
            service=billed.get("service", ""),
            cost=billed.get("cost"),
            currency=currency,
            meters=[ServiceMeter(**m) for m in billed.get("meters", [])],
        ))

    # Most expensive first: an inventory sorted by cost answers "what should I
    # look at" far better than one sorted by resource type.
    out.sort(key=lambda s: (s.cost is None, -(s.cost or 0.0)))
    return out
