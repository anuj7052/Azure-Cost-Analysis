"""
Estate scans and search over them.

Scans are the foundation the visibility features read from: search over deleted
resources, point-in-time browsing and change tracking are all questions about
history, and Azure keeps none.
"""
from typing import List

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException, Query

from auth.dependencies import get_current_user
from core.db import get_db
from models.schemas import ScanRequest, ScanSummary, SearchResponse
from services.scanner import run_scan
from services.search import search_resources
from services.token_resolver import resolve_tenant_token

router = APIRouter(prefix="/api/scans", tags=["scans"])
search_router = APIRouter(prefix="/api/search", tags=["search"])


@router.post("", response_model=ScanSummary, status_code=201)
async def create_scan(
    body: ScanRequest,
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    """
    Capture the estate now and store it as a snapshot.

    The token is resolved through the same path as every other tenant query, so
    a caller can only scan a tenant they registered themselves.
    """
    token = await resolve_tenant_token(body.tenant_id, current_user, db)

    result = await run_scan(
        db=db,
        user_id=current_user["account_id"],
        tenant_id=body.tenant_id,
        token=token,
        subscription_ids=body.subscription_ids,
    )

    async with db.execute(
        "SELECT * FROM scans WHERE id = ? AND user_id = ?",
        (result["scan_id"], current_user["account_id"]),
    ) as cursor:
        row = await cursor.fetchone()

    return ScanSummary(
        id=row["id"],
        tenant_id=row["tenant_id"],
        status=row["status"],
        started_at=row["started_at"],
        finished_at=row["finished_at"],
        resource_count=row["resource_count"],
        error=row["error"],
    )


@router.get("", response_model=List[ScanSummary])
async def list_scans(
    tenant_id: str = Query(...),
    limit: int = Query(20, ge=1, le=100),
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    """Scan history for one tenant, newest first."""
    async with db.execute(
        """
        SELECT * FROM scans
         WHERE user_id = ? AND tenant_id = ?
         ORDER BY id DESC LIMIT ?
        """,
        (current_user["account_id"], tenant_id, limit),
    ) as cursor:
        rows = await cursor.fetchall()

    return [
        ScanSummary(
            id=r["id"],
            tenant_id=r["tenant_id"],
            status=r["status"],
            started_at=r["started_at"],
            finished_at=r["finished_at"],
            resource_count=r["resource_count"],
            error=r["error"],
        )
        for r in rows
    ]


@search_router.get("", response_model=SearchResponse)
async def search(
    tenant_id: str = Query(...),
    q: str = Query("", description="Resource name, or part of one"),
    include_deleted: bool = Query(True),
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    """
    Find resources by name across every scan, including deleted ones.

    Reads only from stored snapshots, so it never calls Azure and cannot be
    throttled — and it can answer for resources Azure no longer knows about.
    """
    if len(q.strip()) == 1:
        # A single character matches most of the estate and costs a full scan of
        # the table to return something nobody wanted.
        raise HTTPException(
            status_code=400,
            detail="Enter at least two characters to search.",
        )

    return await search_resources(
        db=db,
        user_id=current_user["account_id"],
        tenant_id=tenant_id,
        query=q,
        include_deleted=include_deleted,
    )
