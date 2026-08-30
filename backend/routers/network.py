"""
Network topology.

Read-only, and deliberately so. This draws what Azure reports; it does not
change routing, peerings or security rules. A diagram that can also edit the
network is a diagram people stop trusting to be a faithful record.
"""
import logging
from typing import List

import aiosqlite
from fastapi import APIRouter, Depends
from pydantic import BaseModel

from auth.dependencies import get_current_user
from core.db import get_db
from services import network_topology
from services.token_resolver import authorize_subscriptions, resolve_tenant_token

router = APIRouter(prefix="/api/network", tags=["network"])

log = logging.getLogger(__name__)


class TopologyRequest(BaseModel):
    tenant_id: str
    subscription_ids: List[str] = []


@router.post("/topology")
async def get_topology(
    body: TopologyRequest,
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    """
    Every virtual network in the selected subscriptions, and how they connect.

    The subscription list is reduced to what this token actually holds before
    anything is fetched. Passing the browser's list straight through would let a
    caller probe for subscriptions outside their tenant and have those ids
    written into the response.
    """
    token = await resolve_tenant_token(body.tenant_id, current_user, db)
    allowed = await authorize_subscriptions(token, body.tenant_id, body.subscription_ids)

    result = await network_topology.fetch_topology(token, allowed)
    result["coverage"] = {
        "requested": len(body.subscription_ids),
        "scanned": len(allowed),
        # Said plainly, because a smaller diagram than expected otherwise looks
        # like an estate that shrank rather than a selection that was refused.
        "refused": len(body.subscription_ids) - len(allowed),
    }
    return result
