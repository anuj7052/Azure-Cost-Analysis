"""
Change tracking over the stored snapshots.

Reads only what previous scans captured, so it never calls Azure and cannot be
throttled — and it can report on resources Azure no longer knows about.
"""
from typing import Optional

import aiosqlite
from fastapi import APIRouter, Depends, Query, status

from auth.dependencies import get_current_user
from core.db import get_db
from models.schemas import (
    ChangeDiffResponse,
    EntityHistoryResponse,
    IgnoreListResponse,
    IgnoreRequest,
)
from services import changes as svc

router = APIRouter(prefix="/api/changes", tags=["changes"])


@router.get("", response_model=ChangeDiffResponse)
async def get_changes(
    tenant_id: str = Query(...),
    from_date: Optional[str] = Query(None, description="YYYY-MM-DD"),
    to_date: Optional[str] = Query(None, description="YYYY-MM-DD"),
    before: Optional[int] = Query(None, description="Earlier scan id"),
    after: Optional[int] = Query(None, description="Later scan id"),
    show_ignored: bool = Query(False, description="Include changes marked expected"),
    group_by: Optional[str] = Query(
        None, description="subscription | resource_group | type | location"
    ),
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
    account_id = current_user["account_id"]

    if from_date and to_date:
        diff = await svc.diff_by_date(
            db=db, user_id=account_id, tenant_id=tenant_id,
            from_date=from_date, to_date=to_date,
        )
    else:
        diff = await svc.diff_scans(
            db=db, user_id=account_id, tenant_id=tenant_id,
            before_id=before, after_id=after,
        )

    rules = await svc.list_ignores(db, account_id, tenant_id)
    diff = svc.apply_ignores(diff, rules, show_ignored=show_ignored)

    # Grouping is computed after ignoring, so a subscription whose only changes
    # were all marked expected reads as zero rather than as a number that no
    # longer matches the rows underneath it.
    if group_by:
        diff["groups"] = svc.group_counts(diff, group_by)
        diff["grouped_by"] = group_by

    return diff


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
    return await svc.entity_history(
        db=db,
        user_id=current_user["account_id"],
        tenant_id=tenant_id,
        resource_id=resource_id,
    )


@router.get("/ignores", response_model=IgnoreListResponse)
async def list_ignores(
    tenant_id: str = Query(...),
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    """
    Every change currently being suppressed, and who suppressed it.

    Listed rather than only applied, because a suppression nobody can see is
    indistinguishable from a bug — and during an audit the question "what are we
    not being shown" has to have an answer.
    """
    rules = await svc.list_ignores(db, current_user["account_id"], tenant_id)
    return {"ignores": [dict(r) for r in rules], "count": len(rules)}


@router.post("/ignores", status_code=status.HTTP_204_NO_CONTENT)
async def create_ignore(
    body: IgnoreRequest,
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    """Mark a change as expected so it stops crowding out the rest."""
    await svc.add_ignore(
        db=db,
        user_id=current_user["account_id"],
        tenant_id=body.tenant_id,
        resource_id=body.resource_id,
        field=body.field,
        note=body.note,
        # Recorded per person, not per workspace: the rows are shared, so
        # "who decided this was expected" is the useful half of the answer.
        created_by=current_user.get("email") or str(current_user.get("actor_id") or ""),
    )


@router.delete("/ignores", status_code=status.HTTP_204_NO_CONTENT)
async def delete_ignore(
    tenant_id: str = Query(...),
    resource_id: str = Query(...),
    field: str = Query("", description="Empty means the whole-resource rule"),
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    """
    Stop suppressing a change.

    Removing a rule that is not there is not an error. The caller is asking for
    a state — "this should not be ignored" — and that state is already true.
    """
    await svc.remove_ignore(
        db=db,
        user_id=current_user["account_id"],
        tenant_id=tenant_id,
        resource_id=resource_id,
        field=field,
    )
