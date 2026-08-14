"""
Azure Management API calls:
- List tenants accessible to the signed-in user
- List subscriptions per tenant (delegated token)
- Acquire token for a stored Service Principal tenant
- Read the claims of a pasted session token
"""
import base64
import binascii
import json
from datetime import datetime, timezone

import httpx
import msal
from typing import List, Dict


MGMT_BASE = "https://management.azure.com"
MGMT_SCOPE = ["https://management.azure.com/.default"]


async def list_user_tenants(user_token: str) -> List[Dict]:
    """List all tenants accessible to the signed-in user."""
    url = f"{MGMT_BASE}/tenants?api-version=2022-12-01"
    headers = {"Authorization": f"Bearer {user_token}"}
    results = []
    async with httpx.AsyncClient(timeout=30) as client:
        while url:
            resp = await client.get(url, headers=headers)
            resp.raise_for_status()
            data = resp.json()
            results.extend(data.get("value", []))
            url = data.get("nextLink")
    return results


async def list_subscriptions(token: str) -> List[Dict]:
    """List all subscriptions accessible with the given token."""
    url = f"{MGMT_BASE}/subscriptions?api-version=2022-12-01"
    headers = {"Authorization": f"Bearer {token}"}
    results = []
    async with httpx.AsyncClient(timeout=30) as client:
        while url:
            resp = await client.get(url, headers=headers)
            resp.raise_for_status()
            data = resp.json()
            results.extend(data.get("value", []))
            url = data.get("nextLink")
    return results


def get_sp_token(tenant_id: str, client_id: str, client_secret: str) -> str:
    """Acquire an access token using Service Principal client credentials."""
    app = msal.ConfidentialClientApplication(
        client_id=client_id,
        authority=f"https://login.microsoftonline.com/{tenant_id}",
        client_credential=client_secret,
    )
    result = (
        app.acquire_token_silent(scopes=MGMT_SCOPE, account=None)
        or app.acquire_token_for_client(scopes=MGMT_SCOPE)
    )
    if "access_token" not in result:
        error = result.get("error_description", "Unknown error")
        raise RuntimeError(f"Failed to acquire SP token for tenant {tenant_id}: {error}")
    return result["access_token"]


def read_token_claims(token: str) -> Dict:
    """
    Read the claims of an Azure access token without verifying its signature.

    The signature is deliberately not checked: this token was issued to the user
    by Azure, not to this app, so we could never validate it. Azure itself
    rejects the token if it is forged or expired, so the claims are only used to
    label the tenant in the UI — never to grant access to anything.
    """
    parts = token.strip().split(".")
    if len(parts) < 2:
        raise ValueError("That does not look like an access token (expected three dot-separated parts).")
    payload = parts[1]
    payload += "=" * (-len(payload) % 4)  # restore base64url padding
    try:
        claims = json.loads(base64.urlsafe_b64decode(payload))
    except (ValueError, binascii.Error) as exc:
        raise ValueError(f"Could not read the token payload: {exc}")
    if not isinstance(claims, dict):
        raise ValueError("Token payload was not a JSON object.")
    return claims


def token_expiry(claims: Dict) -> str | None:
    """ISO-8601 expiry from the `exp` claim, or None when it is missing."""
    exp = claims.get("exp")
    if not exp:
        return None
    try:
        return datetime.fromtimestamp(int(exp), tz=timezone.utc).isoformat()
    except (TypeError, ValueError, OSError):
        return None


def is_expired(expires_at: str | None) -> bool:
    """True when an ISO-8601 expiry is in the past. Missing expiry counts as valid."""
    if not expires_at:
        return False
    try:
        return datetime.fromisoformat(expires_at) <= datetime.now(timezone.utc)
    except ValueError:
        return False
