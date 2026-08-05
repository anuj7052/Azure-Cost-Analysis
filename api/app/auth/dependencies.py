from __future__ import annotations

from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.rbac import Permission, Role, has_permission, role_from_claims
from app.auth.token_validator import validate_token
from app.core.db import get_db
from app.core.errors import ForbiddenError, UnauthorizedError
from app.core.logging import tenant_id_ctx

bearer = HTTPBearer(auto_error=False)


@dataclass(frozen=True, slots=True)
class Principal:
    """The authenticated caller. `tenant_id` is the isolation boundary."""

    tenant_id: str
    object_id: str
    email: str
    name: str
    role: Role

    def require(self, permission: Permission) -> None:
        if not has_permission(self.role, permission):
            raise ForbiddenError(
                f"Role '{self.role}' lacks permission '{permission}'."
            )


async def get_principal(
    request: Request,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
) -> Principal:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise UnauthorizedError("Missing bearer token.")

    claims = await validate_token(credentials.credentials)
    principal = Principal(
        tenant_id=claims["tid"],
        object_id=claims.get("oid", ""),
        email=claims.get("preferred_username") or claims.get("email", ""),
        name=claims.get("name", ""),
        role=role_from_claims(claims),
    )
    request.state.principal = principal
    tenant_id_ctx.set(principal.tenant_id)
    return principal


CurrentUser = Annotated[Principal, Depends(get_principal)]
DbSession = Annotated[AsyncSession, Depends(get_db)]


def require(permission: Permission):
    """Route dependency enforcing a single permission.

    Usage: `dependencies=[Depends(require(Permission.MANAGE_CONNECTIONS))]`
    """

    async def _guard(principal: CurrentUser) -> Principal:
        principal.require(permission)
        return principal

    return _guard


require_read = require(Permission.READ)
require_admin = require(Permission.MANAGE_CONNECTIONS)
