from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from auth.token_validator import validate_azure_token

bearer_scheme = HTTPBearer()


def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
) -> dict:
    """
    FastAPI dependency. Validates the Bearer token and returns token claims.
    Inject into any route that requires authentication.
    """
    token = credentials.credentials
    claims = validate_azure_token(token)
    return {
        "token": token,
        "user_id": claims.get("oid") or claims.get("sub"),
        "name": claims.get("name", ""),
        "email": claims.get("preferred_username", claims.get("upn", "")),
        "tenant_id": claims.get("tid", ""),
    }
