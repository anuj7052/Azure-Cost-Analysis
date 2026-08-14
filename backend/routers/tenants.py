from fastapi import APIRouter, Depends, HTTPException
import aiosqlite
from auth.dependencies import get_current_user
from services.azure_mgmt import (
    is_expired, list_subscriptions, list_user_tenants, read_token_claims, token_expiry,
)
from models.schemas import TenantInfo, AddTenantRequest, AddSessionTokenRequest
from core.db import get_db

router = APIRouter(prefix="/api/tenants", tags=["tenants"])


@router.get("", response_model=list[TenantInfo])
async def get_tenants(
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    """Return tenants from the user's delegated token + any stored service principals."""
    results = []
    seen_ids = set()

    # 0. Always include the user's own login tenant first (guaranteed from JWT tid claim)
    own_tenant_id = current_user.get("tenant_id", "")
    if own_tenant_id:
        results.append(TenantInfo(
            tenant_id=own_tenant_id,
            tenant_name=own_tenant_id,  # will be enriched below if possible
            source="delegated",
        ))
        seen_ids.add(own_tenant_id)

    # 1. Try to enrich / list more tenants via management API (non-fatal)
    try:
        user_tenants = await list_user_tenants(current_user["token"])
        for t in user_tenants:
            tid = t.get("tenantId", "")
            display = t.get("displayName") or tid
            if not tid:
                continue
            if tid in seen_ids:
                # Update the display name for the already-added tenant
                for r in results:
                    if r.tenant_id == tid:
                        r.tenant_name = display
                        break
            else:
                results.append(TenantInfo(
                    tenant_id=tid,
                    tenant_name=display,
                    source="delegated",
                ))
                seen_ids.add(tid)
    except Exception:
        pass  # Non-fatal: user's own tenant already added above

    # 2. Service principal tenants from DB
    async with db.execute("SELECT tenant_id, tenant_name FROM service_principals") as cursor:
        rows = await cursor.fetchall()
        for row in rows:
            if row["tenant_id"] not in seen_ids:
                results.append(TenantInfo(
                    tenant_id=row["tenant_id"],
                    tenant_name=row["tenant_name"],
                    source="service_principal",
                ))
                seen_ids.add(row["tenant_id"])

    # 3. Pasted session tokens. These win over a delegated entry for the same
    #    tenant, because the user added them to reach something their own login
    #    could not.
    async with db.execute(
        "SELECT tenant_id, tenant_name, expires_at, account FROM session_tokens"
    ) as cursor:
        rows = await cursor.fetchall()

    for row in rows:
        entry = TenantInfo(
            tenant_id=row["tenant_id"],
            tenant_name=row["tenant_name"],
            source="session_token",
            expires_at=row["expires_at"],
            account=row["account"],
        )
        existing = next((r for r in results if r.tenant_id == row["tenant_id"]), None)
        if existing:
            results[results.index(existing)] = entry
        else:
            results.append(entry)
            seen_ids.add(row["tenant_id"])

    return results


@router.post("/token", response_model=TenantInfo, status_code=201)
async def add_session_token(
    body: AddSessionTokenRequest,
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    """
    Connect a tenant with an access token copied from an existing Azure session.

    Useful when the signed-in user cannot register an app but can already read
    costs in the portal or CLI. The token is proved against Azure before it is
    stored, so a bad paste fails immediately instead of at the first query.
    """
    try:
        claims = read_token_claims(body.access_token)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    audience = str(claims.get("aud") or "")
    if "management.azure.com" not in audience and "management.core.windows.net" not in audience:
        raise HTTPException(
            status_code=400,
            detail=(
                "This token is for "
                f"'{audience or 'an unknown audience'}', not the Azure management API. "
                "Get one with: az account get-access-token --resource https://management.azure.com"
            ),
        )

    tenant_id = claims.get("tid")
    if not tenant_id:
        raise HTTPException(status_code=400, detail="The token carries no tenant (tid) claim.")

    expires_at = token_expiry(claims)
    if is_expired(expires_at):
        raise HTTPException(
            status_code=400,
            detail="That token has already expired. Generate a fresh one and paste it again.",
        )

    account = claims.get("upn") or claims.get("unique_name") or claims.get("appid")

    # Prove the token actually works before storing it.
    try:
        subscriptions = await list_subscriptions(body.access_token)
    except Exception as exc:
        # Never echo the exception verbatim — Azure SDK errors quote the
        # Authorization header, which would print the token back into the UI.
        reason = str(exc).replace(body.access_token, "<token>")
        if len(reason) > 200:
            reason = reason[:200] + "…"
        raise HTTPException(
            status_code=502,
            detail=f"Azure rejected that token when listing subscriptions: {reason}",
        )

    name = body.tenant_name or claims.get("tenant_display_name") or account or tenant_id

    await db.execute(
        """
        INSERT INTO session_tokens (tenant_id, tenant_name, access_token, expires_at, account)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(tenant_id) DO UPDATE SET
            tenant_name=excluded.tenant_name,
            access_token=excluded.access_token,
            expires_at=excluded.expires_at,
            account=excluded.account
        """,
        (tenant_id, name, body.access_token, expires_at, account),
    )
    await db.commit()

    return TenantInfo(
        tenant_id=tenant_id,
        tenant_name=name,
        source="session_token",
        expires_at=expires_at,
        account=account,
        subscription_count=len(subscriptions),
    )


@router.post("", response_model=TenantInfo, status_code=201)
async def add_tenant(
    body: AddTenantRequest,
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    """Store a Service Principal tenant configuration."""
    try:
        await db.execute(
            """
            INSERT INTO service_principals (tenant_id, tenant_name, client_id, client_secret)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(tenant_id) DO UPDATE SET
                tenant_name=excluded.tenant_name,
                client_id=excluded.client_id,
                client_secret=excluded.client_secret
            """,
            (body.tenant_id, body.tenant_name, body.client_id, body.client_secret),
        )
        await db.commit()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"DB error: {exc}")

    return TenantInfo(
        tenant_id=body.tenant_id,
        tenant_name=body.tenant_name,
        source="service_principal",
    )


@router.delete("/{tenant_id}", status_code=204)
async def delete_tenant(
    tenant_id: str,
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    """Remove a stored Service Principal or session-token tenant."""
    await db.execute(
        "DELETE FROM service_principals WHERE tenant_id = ?", (tenant_id,)
    )
    await db.execute(
        "DELETE FROM session_tokens WHERE tenant_id = ?", (tenant_id,)
    )
    await db.commit()
