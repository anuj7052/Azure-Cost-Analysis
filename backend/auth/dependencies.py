from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
import aiosqlite

from auth.token_validator import validate_azure_token
from core.db import get_db
from services.user_service import ROLE_ADMIN, STATUS_SUSPENDED, upsert_user

bearer_scheme = HTTPBearer()


def _token_claims(
    credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
) -> dict:
    """Validate the Bearer token and flatten the claims this app cares about."""
    token = credentials.credentials
    claims = validate_azure_token(token)
    return {
        "token": token,
        "user_id": claims.get("oid") or claims.get("sub"),
        "name": claims.get("name", ""),
        "email": claims.get("preferred_username", claims.get("upn", "")),
        "tenant_id": claims.get("tid", ""),
    }


async def get_current_user(
    claims: dict = Depends(_token_claims),
    db: aiosqlite.Connection = Depends(get_db),
) -> dict:
    """
    FastAPI dependency for any route that requires authentication.

    Validates the token, then resolves the local account behind it, creating it
    on first sign-in. Every authenticated route already depends on this, so
    ownership ("account_id") and suspension enforcement apply everywhere by
    construction rather than by remembering to add a check per route.
    """
    try:
        user = await upsert_user(db, claims)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc))

    if user["status"] == STATUS_SUSPENDED:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This account has been suspended. Contact your administrator.",
        )

    return {
        **claims,
        "account_id": user["id"],
        "role": user["role"],
        "status": user["status"],
        "created_at": user["created_at"],
    }


async def require_admin(current_user: dict = Depends(get_current_user)) -> dict:
    """Gate for the admin center. Everything under /api/admin depends on this."""
    if current_user["role"] != ROLE_ADMIN:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Administrator access is required.",
        )
    return current_user
