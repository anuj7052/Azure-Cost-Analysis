"""
Commitments -- reservations and savings plans.

One POST rather than several GETs because the page needs a tenant token that is
resolved from the request body, exactly as the other Azure-reading routers do.
"""
import logging
from typing import List

import aiosqlite
from fastapi import APIRouter, Depends
from pydantic import BaseModel

from auth.dependencies import get_current_user
from core.db import get_db
from services import commitments
from services.azure_errors import azure_error
from services.token_resolver import authorize_subscriptions, resolve_tenant_token

router = APIRouter(prefix="/api/commitments", tags=["commitments"])

log = logging.getLogger(__name__)


class CommitmentsRequest(BaseModel):
    tenant_id: str
    subscription_ids: List[str] = []
    grain: int = commitments.DEFAULT_GRAIN
    include_recommendations: bool = True


@router.post("")
async def get_commitments(
    body: CommitmentsRequest,
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    token = await resolve_tenant_token(body.tenant_id, current_user, db)
    allowed = await authorize_subscriptions(token, body.tenant_id, body.subscription_ids)

    try:
        result = await commitments.fetch_commitments(
            token,
            allowed,
            grain=body.grain,
            include_recommendations=body.include_recommendations,
        )
    except Exception as exc:  # noqa: BLE001
        raise azure_error(exc, "your reservations and savings plans")

    # Reservations themselves are tenant-wide, but cost and recommendations are
    # not, so the reader is told how much of their selection those two numbers
    # actually cover rather than being left to assume all of it.
    result["coverage"] = {
        "requested": len(body.subscription_ids),
        "scanned": len(allowed),
        "refused": max(0, len(body.subscription_ids) - len(allowed)),
    }
    return result
