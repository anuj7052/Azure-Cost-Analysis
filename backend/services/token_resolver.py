"""
Work out which Azure access token to use for a given tenant.

Three ways in, tried in order:
  1. A session token the user pasted in Settings — takes priority because the
     user added it deliberately and it usually carries wider rights than their
     own login.
  2. A stored service principal for that tenant.
  3. The caller's own delegated token from the Microsoft sign-in.

Stored credentials are always filtered by the calling account, so one customer
can never borrow another's service principal by guessing a tenant id.
"""
import hashlib
import time
from typing import List

import aiosqlite
from fastapi import HTTPException

from services import azure_names
from services.azure_mgmt import get_sp_token, is_expired, list_subscriptions


async def resolve_tenant_token(
    tenant_id: str,
    current_user: dict,
    db: aiosqlite.Connection,
) -> str:
    account_id = current_user["account_id"]

    async with db.execute(
        "SELECT access_token, expires_at FROM session_tokens "
        "WHERE tenant_id = ? AND user_id = ?",
        (tenant_id, account_id),
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
        "SELECT client_id, client_secret FROM service_principals "
        "WHERE tenant_id = ? AND user_id = ?",
        (tenant_id, account_id),
    ) as cursor:
        row = await cursor.fetchone()
    if not row:
        raise HTTPException(
            status_code=403,
            detail="You do not have access to this tenant.",
        )

    try:
        return get_sp_token(tenant_id, row["client_id"], row["client_secret"])
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


# ---------------------------------------------------------------------------
# Subscription authorisation
# ---------------------------------------------------------------------------

# Which subscriptions a token can see, cached briefly. Without this every
# security endpoint would add an ARM round trip to prove something that cannot
# change from one panel to the next inside a single page load.
_SUBSCRIPTION_CACHE: dict = {}
_SUBSCRIPTION_TTL = 300.0


def _cache_key(tenant_id: str, token: str) -> tuple:
    # The token is hashed rather than stored: this dict lives for the process
    # lifetime and a bearer token has no business sitting in it.
    return (tenant_id, hashlib.sha256(token.encode("utf-8")).hexdigest())


async def authorize_subscriptions(
    token: str,
    tenant_id: str,
    subscription_ids: List[str],
) -> List[str]:
    """
    Reduce a client-supplied subscription list to the ones this token really holds.

    The frontend sends subscription ids, and until now they were passed
    straight to Azure. Azure would refuse a foreign subscription with a 403,
    but that 403 is reported to the user as a coverage gap -- which means a
    caller could probe for the existence of subscriptions outside their tenant
    and, worse, have those ids written into their own stored snapshots.

    Deciding it here keeps the answer scoped to what the caller actually has,
    and makes a bad id an explicit refusal rather than a silent gap.
    """
    requested = [s for s in subscription_ids if s]
    if not requested:
        return []

    key = _cache_key(tenant_id, token)
    cached = _SUBSCRIPTION_CACHE.get(key)
    now = time.monotonic()
    if cached and now - cached[0] < _SUBSCRIPTION_TTL:
        allowed = cached[1]
    else:
        try:
            raw = await list_subscriptions(token)
        except Exception as exc:  # noqa: BLE001
            # If the directory itself cannot be read we cannot prove the
            # caller is entitled to anything, and guessing in either direction
            # is wrong. Fail closed with a reason.
            raise HTTPException(
                status_code=502,
                detail=(
                    "Could not confirm which subscriptions this account can read, "
                    f"so the request was not sent to Azure. ({exc})"
                ),
            )
        allowed = {
            str(item.get("subscriptionId") or "")
            for item in raw
            if not tenant_id
            or not item.get("tenantId")
            or str(item.get("tenantId")) == str(tenant_id)
        }
        allowed.discard("")
        _SUBSCRIPTION_CACHE[key] = (now, allowed)
        # This listing already carries every subscription's display name.
        # Keeping it costs nothing and is the difference between one Azure
        # call and one per finding on the access pages, which would otherwise
        # have to ask what "9f062503-..." is called each time it printed it.
        azure_names.remember_subscription_names(key, raw)

    permitted = [s for s in requested if s in allowed]
    if not permitted:
        raise HTTPException(
            status_code=403,
            detail=(
                "None of the selected subscriptions are readable by this account "
                "in this tenant."
            ),
        )
    return permitted


def subscription_names(tenant_id: str, token: str) -> dict:
    """
    Display names for the subscriptions this token can see.

    Keyed identically to the authorisation cache, so a name can only ever be
    read back by the same tenant and token that fetched it. A miss returns an
    empty map and callers fall back to saying the subscription is unnamed --
    never to printing its GUID as though that were a name.
    """
    return azure_names.subscription_names(_cache_key(tenant_id, token))
