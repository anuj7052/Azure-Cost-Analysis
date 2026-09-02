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
from services.analysis import latest_billing_month, resource_cost_index
from services.cost_client import error_entry, query_costs
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
    # Named rather than a GUID, because "this subscription's costs are missing"
    # is only actionable if the reader can tell which subscription it is.
    names = subscription_names(body.tenant_id, token)

    cost_records: List[Dict[str, Any]] = []
    cost_errors: List[Dict[str, Any]] = []
    for sub_id in body.subscription_ids:
        try:
            cost_records.extend(await query_costs(
                token=token,
                subscription_id=sub_id,
                # Two months, not one. One month means month-to-date, and on
                # the 1st -- or on the 2nd, with Azure's billing latency --
                # that window is empty, which put "Not available" against every
                # orphan on the page and made the whole scan look worthless.
                months=2,
                group_by=["ResourceId", "ServiceName", "Meter"],
                granularity="Monthly",
            ))
        except Exception as exc:
            # Logged *and* returned. Swallowing this was the second half of the
            # missing-cost problem: a throttled or unauthorised billing query
            # left every finding priced at nothing, and the page had no way to
            # tell that apart from an estate where nothing is being billed. One
            # of those means "look again later", the other means "delete these".
            log.warning("Orphan cost lookup failed for %s: %s", sub_id, exc)
            cost_errors.append(error_entry(sub_id, exc, names))

    # One month of the two, or the sum would be double what any of these costs
    # to run for a month.
    cost_month, cost_partial = latest_billing_month(cost_records)
    cost_index = resource_cost_index(cost_records, month=cost_month)
    currency = next((r.get("Currency") for r in cost_records if r.get("Currency")), "USD")

    try:
        result = await find_orphaned_resources(token, body.subscription_ids, cost_index)
    except Exception as exc:
        raise azure_error(exc, "your resources")

    return OrphanedResponse(
        currency=currency,
        cost_month=cost_month,
        cost_partial=cost_partial,
        cost_errors=cost_errors,
        priced_count=len(cost_index),
        **result,
    )
