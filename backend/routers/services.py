from fastapi import APIRouter, Depends, HTTPException, Query
from typing import List
import aiosqlite
from auth.dependencies import get_current_user
from services.token_resolver import resolve_tenant_token
from services.cost_client import query_active_resources
from models.schemas import ActiveService
from core.db import get_db

router = APIRouter(prefix="/api/services", tags=["services"])


@router.get("", response_model=list[ActiveService])
async def get_active_services(
    tenant_id: str = Query(...),
    subscription_ids: List[str] = Query(...),
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    """List all active Azure resources using Resource Graph KQL."""
    token = await resolve_tenant_token(tenant_id, current_user, db)

    try:
        resources = await query_active_resources(token, subscription_ids)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Resource Graph query failed: {exc}")

    return [
        ActiveService(
            name=r.get("name", ""),
            type=r.get("type", ""),
            resource_group=r.get("resourceGroup", ""),
            subscription_id=r.get("subscriptionId", ""),
            location=r.get("location", ""),
            tags=r.get("tags") or {},
        )
        for r in resources
    ]
