from fastapi import APIRouter, Depends, HTTPException
import aiosqlite
from auth.dependencies import get_current_user
from services.azure_mgmt import list_user_tenants
from models.schemas import TenantInfo, AddTenantRequest
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

    return results


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
    """Remove a stored Service Principal tenant."""
    await db.execute(
        "DELETE FROM service_principals WHERE tenant_id = ?", (tenant_id,)
    )
    await db.commit()
