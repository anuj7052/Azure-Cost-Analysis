from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
import aiosqlite

from auth.token_validator import validate_azure_token
from core.db import get_db
from services.user_service import ROLE_ADMIN, STATUS_SUSPENDED, upsert_user
from services.team_service import workspace_id

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

    # "account_id" is the workspace, not the person. For an owner the two are
    # the same id; for an invited team member it is the owner's id, which is
    # what makes every ownership-scoped query in the app return the owner's
    # tenants without any of those queries having to know that teams exist.
    #
    # "actor_id" is the person, and is what audit trails and self-checks must
    # use. Conflating the two would attribute a member's actions to the owner.
    workspace = workspace_id(user)
    is_owner = user["owner_id"] is None
    # The owner is always an administrator of their own workspace. For everyone
    # else it is whatever role they were given when they were added.
    workspace_role = "admin" if is_owner else (user["workspace_role"] or "user")

    return {
        **claims,
        "account_id": workspace,
        "actor_id": user["id"],
        "is_owner": is_owner,
        "owner_id": workspace,
        "workspace_role": workspace_role,
        "can_administer": is_owner or workspace_role == "admin",
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


async def require_workspace_admin(
    current_user: dict = Depends(get_current_user),
) -> dict:
    """
    Gate for actions that change the workspace itself or change Azure.

    Everyone with a seat can read everything the owner connected, because that
    is the point of adding them. Only the owner and the people they gave the
    Administrator role can connect or disconnect a tenant, edit stored
    credentials, or push a change into Azure.

    This is administration of one workspace and nothing wider. The platform
    Admin Centre, which sees every account on the server, stays behind
    `require_admin` and is not reachable from here.
    """
    if not current_user.get("can_administer"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                "You have view access to this workspace. Ask the workspace "
                "owner or an administrator to make this change."
            ),
        )
    return current_user


async def require_workspace_owner(
    current_user: dict = Depends(get_current_user),
) -> dict:
    """
    Gate for the seats themselves: who is in the workspace, and at what role.

    Kept narrower than `require_workspace_admin` on purpose. An administrator
    can change what the workspace does; only the owner decides who is in it,
    so an administrator cannot quietly add more administrators or remove the
    person who added them.
    """
    if not current_user["is_owner"]:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                "You have view access to this workspace. Ask the workspace "
                "owner to make this change."
            ),
        )
    return current_user
