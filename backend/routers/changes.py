"""
Change tracking over the stored snapshots.

Reads only what previous scans captured, so it never calls Azure and cannot be
throttled — and it can report on resources Azure no longer knows about.
"""
from typing import Optional

import aiosqlite
from fastapi import APIRouter, Depends, Query

from auth.dependencies import get_current_user
from core.db import get_db
from models.schemas import ChangeDiffResponse, EntityHistoryResponse
from services.changes import diff_by_date, diff_scans, entity_history

router = APIRouter(prefix="/api/changes", tags=["changes"])


@router.get("", response_model=ChangeDiffResponse)
async def get_changes(
    tenant_id: str = Query(...),
    from_date: Optional[str] = Query(None, description="YYYY-MM-DD"),
    to_date: Optional[str] = Query(None, description="YYYY-MM-DD"),
    before: Optional[int] = Query(None, description="Earlier scan id"),
    after: Optional[int] = Query(None, description="Later scan id"),
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    """
    What changed between two points in time.

    A date range is the natural way to ask this — people think in days, not scan
    ids. Each date resolves to the capture that best represents it, and the
    response always reports which scans were actually compared, because a range
    that silently resolved to something else could not be trusted.

    Explicit scan ids remain supported for drilling into a specific pair. Both
    are checked against the calling account in SQL: a scan id is a small integer
    and therefore trivially guessable.
    """
    if from_date and to_date:
        return await diff_by_date(
            db=db,
            user_id=current_user["account_id"],
            tenant_id=tenant_id,
            from_date=from_date,
            to_date=to_date,
        )

    return await diff_scans(
        db=db,
        user_id=current_user["account_id"],
        tenant_id=tenant_id,
        before_id=before,
        after_id=after,
    )


@router.get("/history", response_model=EntityHistoryResponse)
async def get_entity_history(
    tenant_id: str = Query(...),
    resource_id: str = Query(..., description="Full Azure resource id"),
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    """
    Every recorded change for one resource.

    The view a diff cannot provide: a diff says a VM was resized, a history says
    it has been resized four times this quarter.
    """
    return await entity_history(
        db=db,
        user_id=current_user["account_id"],
        tenant_id=tenant_id,
        resource_id=resource_id,
    )
