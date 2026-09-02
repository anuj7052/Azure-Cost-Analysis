from fastapi import APIRouter, Depends, HTTPException
import aiosqlite
from auth.dependencies import get_current_user, require_workspace_admin
from core.config import settings
from services import azure_cli
from services.azure_mgmt import (
    get_sp_token, is_expired, list_subscriptions, read_token_claims, token_expiry,
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

    # Only the signed-in tenant and credentials explicitly registered by this
    # account are returned. Do not enumerate every directory the user can see.
    async with db.execute(
        "SELECT tenant_id, tenant_name FROM service_principals WHERE user_id = ?",
        (current_user["account_id"],),
    ) as cursor:
        rows = await cursor.fetchall()
        for row in rows:
            if row["tenant_id"] not in seen_ids:
                results.append(TenantInfo(
                    tenant_id=row["tenant_id"],
                    tenant_name=row["tenant_name"],
                    source="service_principal",
                ))
                seen_ids.add(row["tenant_id"])

    # Every directory the machine's `az login` can reach, when that is turned
    # on. Enumerating them is safe here in a way it would not be for a
    # delegated login, because the operator and the caller are the same person
    # -- which is the only configuration in which the flag may be set at all.
    if settings.AZURE_CLI_AUTH:
        try:
            for entry in await azure_cli.list_tenants():
                if entry["tenant_id"] in seen_ids:
                    continue
                results.append(TenantInfo(
                    tenant_id=entry["tenant_id"],
                    tenant_name=entry["tenant_name"],
                    source="azure_cli",
                    account=entry["account"],
                    subscription_count=entry["subscription_count"],
                ))
                seen_ids.add(entry["tenant_id"])
        except azure_cli.CliUnavailable:
            # The list is context, not the point of the call. A signed-out CLI
            # must not empty a page that has stored credentials to show.
            pass

    # Pasted session tokens win over a delegated entry for the same
    #    tenant, because the user added them to reach something their own login
    #    could not.
    async with db.execute(
        "SELECT tenant_id, tenant_name, expires_at, account FROM session_tokens "
        "WHERE user_id = ?",
        (current_user["account_id"],),
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


@router.get("/cli")
async def get_cli_status(current_user: dict = Depends(get_current_user)):
    """
    Whether the machine's Azure CLI can be used instead of stored credentials.

    Three outcomes, kept apart on purpose: turned off, installed but signed
    out, and ready. A single disabled button covering all three is what leaves
    somebody re-reading the documentation for a setting they already applied.
    """
    if not settings.AZURE_CLI_AUTH:
        return {
            "enabled": False, "available": azure_cli.cli_installed(),
            "signed_in": False, "account": "", "tenants": [],
            "reason": (
                "CLI sign-in is switched off. Set AZURE_CLI_AUTH=true in the "
                "backend environment to use it. It is only safe when the "
                "person running this service is the person using it."
            ),
        }
    return {"enabled": True, **await azure_cli.status()}


def _require_cli_enabled():
    if not settings.AZURE_CLI_AUTH:
        raise HTTPException(
            status_code=403,
            detail=(
                "CLI sign-in is switched off. Set AZURE_CLI_AUTH=true in the "
                "backend environment and restart to use it."
            ),
        )


@router.post("/cli/login", dependencies=[Depends(require_workspace_admin)])
async def start_cli_login(tenant_id: str | None = None):
    """
    Begin a device-code sign-in and return the code to type.

    Nothing secret travels through this service: it starts the CLI, reads the
    code the CLI printed, and reports what happened. The password is entered
    at Microsoft, in the operator's own browser.

    Signing the host in is signing *everybody* in, since the CLI identity is
    the machine's rather than the caller's, so this is restricted to a
    workspace administrator on top of the deployment-level flag.
    """
    _require_cli_enabled()
    try:
        return await azure_cli.begin_login(tenant_id)
    except azure_cli.CliUnavailable as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/cli/login", dependencies=[Depends(require_workspace_admin)])
async def get_cli_login(current_user: dict = Depends(get_current_user)):
    """Where the sign-in that is already running has got to."""
    _require_cli_enabled()
    return azure_cli.login_status()


@router.delete("/cli/login", dependencies=[Depends(require_workspace_admin)])
async def cancel_cli_login():
    """Abandon a sign-in, so the waiting `az` process does not outlive the page."""
    _require_cli_enabled()
    return await azure_cli.cancel_login()


@router.post(
    "/token", response_model=TenantInfo, status_code=201,
    dependencies=[Depends(require_workspace_admin)],
)
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
        INSERT INTO session_tokens (user_id, tenant_id, tenant_name, access_token,
                                    expires_at, account)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, tenant_id) DO UPDATE SET
            tenant_name=excluded.tenant_name,
            access_token=excluded.access_token,
            expires_at=excluded.expires_at,
            account=excluded.account
        """,
        (current_user["account_id"], tenant_id, name, body.access_token, expires_at, account),
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


@router.post(
    "", response_model=TenantInfo, status_code=201,
    dependencies=[Depends(require_workspace_admin)],
)
async def add_tenant(
    body: AddTenantRequest,
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    """Validate and store a Service Principal tenant configuration."""
    try:
        subscriptions = await list_subscriptions(
            get_sp_token(body.tenant_id, body.client_id, body.client_secret)
        )
    except Exception as exc:
        reason = str(exc)
        for secret in (body.client_secret, body.client_id):
            reason = reason.replace(secret, "<redacted>")
        if len(reason) > 200:
            reason = reason[:200] + "..."
        raise HTTPException(
            status_code=502,
            detail=f"Azure rejected these service principal credentials: {reason}",
        )
    try:
        await db.execute(
            """
            INSERT INTO service_principals (user_id, tenant_id, tenant_name,
                                            client_id, client_secret)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(user_id, tenant_id) DO UPDATE SET
                tenant_name=excluded.tenant_name,
                client_id=excluded.client_id,
                client_secret=excluded.client_secret
            """,
            (current_user["account_id"], body.tenant_id, body.tenant_name,
             body.client_id, body.client_secret),
        )
        await db.commit()
    except Exception:
        raise HTTPException(status_code=500, detail="Could not save the tenant connection.")

    return TenantInfo(
        tenant_id=body.tenant_id,
        tenant_name=body.tenant_name,
        source="service_principal",
        subscription_count=len(subscriptions),
    )


@router.delete(
    "/{tenant_id}", status_code=204,
    dependencies=[Depends(require_workspace_admin)],
)
async def delete_tenant(
    tenant_id: str,
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    """Remove a stored Service Principal or session-token tenant."""
    account_id = current_user["account_id"]
    await db.execute(
        "DELETE FROM service_principals WHERE tenant_id = ? AND user_id = ?",
        (tenant_id, account_id),
    )
    await db.execute(
        "DELETE FROM session_tokens WHERE tenant_id = ? AND user_id = ?",
        (tenant_id, account_id),
    )
    await db.commit()
