from fastapi import APIRouter, Depends, Query
import aiosqlite
from auth.dependencies import get_current_user
from services.azure_mgmt import list_subscriptions
from services.token_resolver import resolve_tenant_token
from models.schemas import SubscriptionInfo
from core.db import get_db

router = APIRouter(prefix="/api/subscriptions", tags=["subscriptions"])


@router.get("", response_model=list[SubscriptionInfo])
async def get_subscriptions(
    tenant_id: str = Query(..., description="Tenant ID to list subscriptions for"),
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    """
    List subscriptions for a given tenant.

    The token comes from a pasted session token, a stored service principal or
    the caller's own sign-in, whichever is available for that tenant.
    """
    token = await resolve_tenant_token(tenant_id, current_user, db)

    subs = await list_subscriptions(token)
    return [
        SubscriptionInfo(
            subscription_id=s.get("subscriptionId", ""),
            display_name=s.get("displayName", ""),
            tenant_id=s.get("tenantId", tenant_id),
            state=s.get("state", "Unknown"),
        )
        for s in subs
    ]
