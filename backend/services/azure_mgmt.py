"""
Azure Management API calls:
- List tenants accessible to the signed-in user
- List subscriptions per tenant (delegated token)
- Acquire token for a stored Service Principal tenant
"""
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
