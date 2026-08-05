"""
Azure AD token validation using JWKS endpoint.
Validates the Bearer token sent from the MSAL.js frontend.
"""
import time
import httpx
import jwt
from jwt import PyJWKClient
from fastapi import HTTPException, status
from core.config import settings

# Azure AD JWKS endpoint (works for both single-tenant and multi-tenant)
JWKS_URI = "https://login.microsoftonline.com/common/discovery/v2.0/keys"
AZURE_AD_ISSUER_PREFIXES = [
    "https://login.microsoftonline.com/",
    "https://sts.windows.net/",
]

_jwks_client: PyJWKClient | None = None


def get_jwks_client() -> PyJWKClient:
    global _jwks_client
    if _jwks_client is None:
        _jwks_client = PyJWKClient(JWKS_URI, cache_jwk_set=True, lifespan=3600)
    return _jwks_client


def allowed_audiences() -> set[str]:
    """Audiences this API accepts: its own app registration, and Azure ARM."""
    client_id = settings.AZURE_CLIENT_ID
    auds = {
        "https://management.azure.com/",
        "https://management.azure.com",
        "https://management.core.windows.net/",
    }
    if client_id:
        auds |= {client_id, f"api://{client_id}"}
    return auds


def validate_azure_token(token: str) -> dict:
    """
    Validate an Azure AD Bearer token (v2.0 or v1.0).
    Returns the decoded token claims on success.
    Raises HTTPException 401 on any failure.
    """
    try:
        jwks_client = get_jwks_client()
        signing_key = jwks_client.get_signing_key_from_jwt(token)

        # Read the audience first so we can verify against it, then confirm it is
        # one we actually accept. Trusting the token's own audience blindly would
        # let a token minted for any other application be replayed against us.
        unverified = jwt.decode(token, options={"verify_signature": False})
        audience = unverified.get("aud", "")
        expected = allowed_audiences()
        if expected and audience not in expected:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Token was not issued for this application",
            )

        claims = jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            audience=audience,
            options={"verify_exp": True},
        )

        # Validate issuer is from Azure AD
        issuer = claims.get("iss", "")
        if not any(issuer.startswith(p) for p in AZURE_AD_ISSUER_PREFIXES):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Token issuer is not Azure AD",
            )

        return claims

    except HTTPException:
        raise
    except jwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token has expired",
        )
    except jwt.InvalidTokenError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Invalid token: {exc}",
        )
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Token validation failed: {exc}",
        )
