from __future__ import annotations

import time
from typing import Any

import httpx
from jose import jwt
from jose.exceptions import JWTError

from app.core.config import settings
from app.core.errors import UnauthorizedError

_OIDC_TEMPLATE = "{host}/{tenant}/v2.0/.well-known/openid-configuration"


class JwksCache:
    """Caches signing keys per issuing tenant (multi-tenant app)."""

    def __init__(self) -> None:
        self._keys: dict[str, tuple[float, list[dict[str, Any]]]] = {}

    async def get(self, tenant_id: str) -> list[dict[str, Any]]:
        cached = self._keys.get(tenant_id)
        if cached and cached[0] > time.time():
            return cached[1]

        async with httpx.AsyncClient(timeout=10) as client:
            oidc_url = _OIDC_TEMPLATE.format(
                host=settings.AZURE_AUTHORITY_HOST, tenant=tenant_id
            )
            oidc = (await client.get(oidc_url)).raise_for_status().json()
            jwks = (await client.get(oidc["jwks_uri"])).raise_for_status().json()

        keys = jwks.get("keys", [])
        self._keys[tenant_id] = (time.time() + settings.JWKS_CACHE_SECONDS, keys)
        return keys


jwks_cache = JwksCache()


def _unverified_tenant(token: str) -> str:
    try:
        claims = jwt.get_unverified_claims(token)
    except JWTError as exc:  # pragma: no cover - malformed token
        raise UnauthorizedError("Malformed access token.") from exc
    tid = claims.get("tid")
    if not tid:
        raise UnauthorizedError("Token is missing the 'tid' claim.")
    return tid


async def validate_token(token: str) -> dict[str, Any]:
    """Validate an Entra ID access token: signature, issuer, audience, expiry."""
    tenant_id = _unverified_tenant(token)

    allowed = settings.allowed_tenants
    if allowed and tenant_id not in allowed:
        raise UnauthorizedError("Tenant is not permitted to access this API.")

    keys = await jwks_cache.get(tenant_id)
    header = jwt.get_unverified_header(token)
    key = next((k for k in keys if k.get("kid") == header.get("kid")), None)
    if key is None:
        raise UnauthorizedError("Token signing key not found.")

    issuer = f"{settings.AZURE_AUTHORITY_HOST}/{tenant_id}/v2.0"
    # Entra issues v1.0 tokens (iss = sts.windows.net) for an exposed API whose
    # 'requestedAccessTokenVersion' is not set to 2. Both issuers are legitimate
    # for the same tenant and are signed by the same JWKS.
    accepted_issuers = [issuer, f"https://sts.windows.net/{tenant_id}/"]
    accepted = settings.accepted_audiences
    try:
        claims = jwt.decode(
            token,
            key,
            algorithms=[header.get("alg", "RS256")],
            options={
                "require_exp": True,
                "require_iat": True,
                # Audience and issuer are checked below so that more than one
                # accepted value is possible.
                "verify_aud": False,
                "verify_iss": False,
            },
        )
    except JWTError as exc:
        raise UnauthorizedError(f"Token validation failed: {exc}") from exc

    if claims.get("iss") not in accepted_issuers:
        raise UnauthorizedError("Token issuer is not trusted.")
    if claims.get("aud") not in accepted:
        raise UnauthorizedError("Token audience is not accepted by this API.")

    return claims
