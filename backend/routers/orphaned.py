"""
Orphaned resource findings.

Everything here is read-only. Deleting cloud resources from a cost tool is a
foot-gun: the blast radius is unbounded and the audit trail lives somewhere
else, so this endpoint reports what to remove and leaves the removal to the
owner in the portal or their own IaC.
"""
import logging
from typing import Any, Dict, List

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException

from auth.dependencies import get_current_user
from services.azure_errors import azure_error
from core.db import get_db
from models.schemas import OrphanedRequest, OrphanedResponse
from services.analysis import resource_cost_index
from services.cost_client import query_costs
from services.orphaned import find_orphaned_resources
from services.token_resolver import resolve_tenant_token

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

    cost_records: List[Dict[str, Any]] = []
    for sub_id in body.subscription_ids:
        try:
            cost_records.extend(await query_costs(
                token=token,
                subscription_id=sub_id,
                months=1,
                group_by=["ResourceId", "ServiceName", "Meter"],
                granularity="Monthly",
            ))
        except Exception as exc:
            log.warning("Orphan cost lookup failed for %s: %s", sub_id, exc)
            continue

    cost_index = resource_cost_index(cost_records)
    currency = next((r.get("Currency") for r in cost_records if r.get("Currency")), "USD")

    try:
        result = await find_orphaned_resources(token, body.subscription_ids, cost_index)
    except Exception as exc:
        raise azure_error(exc, "your resources")

    return OrphanedResponse(currency=currency, **result)
