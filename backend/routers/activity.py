"""
Activity Explorer — who changed what, and when.

Reads the Azure Activity Log, which is the only source that records the actor
behind a change. Snapshot diffs elsewhere in this app see results; this sees
the operations that produced them.
"""
import logging
from typing import List, Optional

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException, Query

from auth.dependencies import get_current_user
from core.db import get_db
from models.schemas import ActivityResponse
from services.activity import MAX_RETENTION_DAYS, clamp_window, fetch_activity, summarise_activity
from services.token_resolver import resolve_tenant_token

router = APIRouter(prefix="/api/activity", tags=["activity"])

log = logging.getLogger(__name__)


@router.get("", response_model=ActivityResponse)
async def get_activity(
    tenant_id: str = Query(...),
    subscription_ids: List[str] = Query(...),
    days: int = Query(7, ge=1, le=MAX_RETENTION_DAYS),
    resource_id: Optional[str] = Query(None, description="Limit to one resource"),
    resource_group: Optional[str] = Query(
        None,
        description=(
            "Limit to one resource group. Ignored when resource_id is given, "
            "which is narrower."
        ),
    ),
    writes_only: bool = Query(True),
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    """
    Control-plane operations across the selected subscriptions.

    One subscription failing does not fail the request: a tenant may grant
    activity read on some subscriptions and not others, and returning what is
    readable beats returning nothing. The shortfall is reported rather than
    silently swallowed, because a short list looks identical to a quiet week.

    Narrowing by resource group is worth exposing because Azure applies it
    itself. Reading a group's history by pulling the whole subscription and
    discarding the rest costs the same quota as every other caller's read and
    is slow enough to time out on a large estate - and asking per resource
    instead would turn one request into dozens.
    """
    token = await resolve_tenant_token(tenant_id, current_user, db)

    entries = []
    errors = []
    for subscription_id in subscription_ids:
        try:
            entries.extend(await fetch_activity(
                token=token,
                subscription_id=subscription_id,
                days=days,
                resource_id=resource_id,
                resource_group=resource_group,
            ))
        except Exception as exc:
            log.warning("Activity read failed for %s: %s", subscription_id, exc)
            errors.append({
                "subscription_id": subscription_id,
                "error": str(exc)[:200],
            })

    if not entries and errors:
        raise HTTPException(
            status_code=502,
            detail=(
                f"Could not read the Activity Log for {len(errors)} subscription(s). "
                "The credential needs the Reader role, which includes "
                "Microsoft.Insights/eventtypes/values/read."
            ),
        )

    summary = summarise_activity(entries, writes_only=writes_only)
    summary["window_days"] = clamp_window(days)
    summary["errors"] = errors
    return summary
