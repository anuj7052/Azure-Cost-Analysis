"""
Work out which Azure access token to use for a given tenant.

Three ways in, tried in order:
  1. A session token the user pasted in Settings — takes priority because the
     user added it deliberately and it usually carries wider rights than their
     own login.
  2. A stored service principal for that tenant.
  3. The caller's own delegated token from the Microsoft sign-in.
"""
import aiosqlite
from fastapi import HTTPException

from services.azure_mgmt import get_sp_token, is_expired


async def resolve_tenant_token(
    tenant_id: str,
    current_user: dict,
    db: aiosqlite.Connection,
) -> str:
    async with db.execute(
        "SELECT access_token, expires_at FROM session_tokens WHERE tenant_id = ?",
        (tenant_id,),
    ) as cursor:
        row = await cursor.fetchone()
    if row:
        if is_expired(row["expires_at"]):
            raise HTTPException(
                status_code=401,
                detail=(
                    "The session token for this tenant has expired. "
                    "Paste a fresh one in Settings, or remove it to fall back to your own sign-in."
                ),
            )
        return row["access_token"]

    if tenant_id == current_user.get("tenant_id"):
        return current_user["token"]

    async with db.execute(
        "SELECT client_id, client_secret FROM service_principals WHERE tenant_id = ?",
        (tenant_id,),
    ) as cursor:
        row = await cursor.fetchone()
    if not row:
        return current_user["token"]

    try:
        return get_sp_token(tenant_id, row["client_id"], row["client_secret"])
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
