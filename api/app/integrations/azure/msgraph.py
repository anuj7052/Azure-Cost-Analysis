from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

import httpx

from app.integrations.azure.credentials import ConnectionContext, credential_provider
from app.integrations.azure.retry import with_retry

log = logging.getLogger(__name__)

GRAPH_BASE = "https://graph.microsoft.com/v1.0"
GRAPH_BETA = "https://graph.microsoft.com/beta"
GRAPH_SCOPE = "https://graph.microsoft.com/.default"


class GraphGateway:
    """Microsoft Graph: identity posture (MFA, risky users, privileged roles)."""

    def __init__(self, ctx: ConnectionContext) -> None:
        self.ctx = ctx

    async def _token(self) -> str:
        credential = await credential_provider.get(self.ctx)
        try:
            token = await credential.get_token(GRAPH_SCOPE)
            return token.token
        finally:
            await credential.close()

    @with_retry()
    async def _get_all(self, url: str, token: str) -> list[dict[str, Any]]:
        """Follow `@odata.nextLink` until the collection is exhausted."""
        items: list[dict[str, Any]] = []
        headers = {"Authorization": f"Bearer {token}"}
        async with httpx.AsyncClient(timeout=30) as client:
            next_url: str | None = url
            while next_url:
                response = await client.get(next_url, headers=headers)
                response.raise_for_status()
                body = response.json()
                items.extend(body.get("value", []))
                next_url = body.get("@odata.nextLink")
        return items

    async def identity_posture(self) -> list[dict[str, Any]]:
        token = await self._token()

        registrations = {
            item.get("id"): item
            for item in await self._get_all(
                f"{GRAPH_BETA}/reports/authenticationMethods/userRegistrationDetails",
                token,
            )
        }
        risky = {
            item.get("id"): item
            for item in await self._get_all(
                f"{GRAPH_BASE}/identityProtection/riskyUsers", token
            )
        }

        rows: list[dict[str, Any]] = []
        for user_id, reg in registrations.items():
            risk = risky.get(user_id, {})
            last_sign_in = risk.get("riskLastUpdatedDateTime")
            rows.append(
                {
                    "user_object_id": user_id,
                    "user_principal_name": reg.get("userPrincipalName", ""),
                    "risk_level": (risk.get("riskLevel") or "none").lower(),
                    "risk_state": (risk.get("riskState") or "none").lower(),
                    "mfa_enabled": bool(reg.get("isMfaRegistered")),
                    "is_privileged": bool(reg.get("isAdmin")),
                    "last_sign_in_at": _parse(last_sign_in),
                }
            )
        return rows


def _parse(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return datetime.now(timezone.utc)
