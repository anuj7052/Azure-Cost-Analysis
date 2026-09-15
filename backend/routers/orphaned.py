"""
Orphaned resource findings.

Everything here is read-only. Deleting cloud resources from a cost tool is a
foot-gun: the blast radius is unbounded and the audit trail lives somewhere
else, so this endpoint reports what to remove and leaves the removal to the
owner in the portal or their own IaC.
"""
import asyncio
import logging

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException

from auth.dependencies import get_current_user
from services.azure_errors import azure_error
from core.db import get_db
from models.schemas import OrphanedRequest, OrphanedResponse
from services.analysis import latest_billing_month, resource_cost_index
from services.cost_client import gather_by_subscription, query_costs
from services.orphaned import find_orphaned_resources
from services.token_resolver import resolve_tenant_token, subscription_names

router = APIRouter(prefix="/api/orphaned", tags=["orphaned"])

log = logging.getLogger(__name__)


@router.post("", response_model=OrphanedResponse)
async def get_orphaned_resources(
    body: OrphanedRequest,
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    """
    Find resources that are billed but attached to nothing.

    The token is resolved through the same path as every other tenant query, so
    a caller can only scan a tenant they have registered themselves.

    Cost is a best-effort join: Cost Management throttles independently of
    Resource Graph, so a findings list without prices is still returned rather
    than failing the request. The findings are true either way.
    """
    token = await resolve_tenant_token(body.tenant_id, current_user, db)
    async def read_cost(sub_id):
        return await query_costs(
            token=token, subscription_id=sub_id, months=2,
            group_by=["ResourceId", "ServiceName", "Meter"], granularity="Monthly",
        )

    # Inventory is independent of billing. Start both now, and bound the
    # optional price join so a throttled cost query cannot hide the findings.
    try:
        (cost_records, cost_errors), result = await asyncio.gather(
            gather_by_subscription(body.subscription_ids, read_cost, budget=15),
            find_orphaned_resources(token, body.subscription_ids),
        )
    except Exception as exc:
        raise azure_error(exc, "your resources")

    names = subscription_names(body.tenant_id, token)
    for error in cost_errors:
        error["subscription_name"] = names.get(error["subscription_id"], error["subscription_id"])

    # One month of the two, or the sum would be double what any of these costs
    # to run for a month.
    cost_month, cost_partial = latest_billing_month(cost_records)
    cost_index = resource_cost_index(cost_records, month=cost_month)
    currency = next((r.get("Currency") for r in cost_records if r.get("Currency")), "USD")

    for category in result["categories"]:
        for item in category["items"]:
            item["monthly_cost"] = cost_index.get(item["id"].lower(), {}).get("cost")
        category["items"].sort(key=lambda item: (item["monthly_cost"] is None, -(item["monthly_cost"] or 0)))
        category["monthly_cost"] = round(sum(item["monthly_cost"] or 0 for item in category["items"]), 2)
    result["categories"].sort(key=lambda category: (-category["monthly_cost"], -category["count"]))
    result["total_monthly_cost"] = round(sum(category["monthly_cost"] for category in result["categories"]), 2)

    return OrphanedResponse(
        currency=currency,
        cost_month=cost_month,
        cost_partial=cost_partial,
        cost_errors=cost_errors,
        priced_count=len(cost_index),
        **result,
    )
