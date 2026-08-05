from fastapi import APIRouter, Depends, Query
import aiosqlite
from auth.dependencies import get_current_user
from services.azure_mgmt import list_subscriptions, get_sp_token
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
    Uses the user's delegated token if the tenant matches the logged-in tenant,
    otherwise uses a stored Service Principal token.
    """
    # Determine which token to use
    if tenant_id == current_user.get("tenant_id"):
        token = current_user["token"]
    else:
        # Look up SP credentials
        async with db.execute(
            "SELECT client_id, client_secret FROM service_principals WHERE tenant_id = ?",
            (tenant_id,),
        ) as cursor:
            row = await cursor.fetchone()

        if not row:
            # Try with user token anyway (may work for cross-tenant guest accounts)
            token = current_user["token"]
        else:
            try:
                token = get_sp_token(tenant_id, row["client_id"], row["client_secret"])
            except RuntimeError as exc:
                from fastapi import HTTPException
                raise HTTPException(status_code=502, detail=str(exc))

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
