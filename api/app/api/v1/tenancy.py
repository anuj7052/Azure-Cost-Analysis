from __future__ import annotations

from fastapi import APIRouter, Depends

from app.auth.dependencies import CurrentUser, DbSession, require
from app.auth.rbac import Permission, ROLE_PERMISSIONS
from app.schemas import ConnectionIn, ConnectionOut, MeOut
from app.services.connection_service import ConnectionService

router = APIRouter(tags=["tenancy"])


@router.get("/me", response_model=MeOut, summary="Current signed-in principal")
async def me(principal: CurrentUser) -> MeOut:
    return MeOut(
        tenant_id=principal.tenant_id,
        object_id=principal.object_id,
        email=principal.email,
        name=principal.name,
        role=str(principal.role),
        permissions=sorted(str(p) for p in ROLE_PERMISSIONS[principal.role]),
    )


@router.get(
    "/connections",
    response_model=list[ConnectionOut],
    dependencies=[Depends(require(Permission.READ))],
    summary="List connected Azure subscriptions",
)
async def list_connections(principal: CurrentUser, db: DbSession):
    service = ConnectionService(db, principal.tenant_id)
    return await service.repo.list(limit=200)


@router.post(
    "/connections",
    response_model=ConnectionOut,
    status_code=201,
    dependencies=[Depends(require(Permission.MANAGE_CONNECTIONS))],
    summary="Connect an Azure subscription",
)
async def create_connection(payload: ConnectionIn, principal: CurrentUser, db: DbSession):
    return await ConnectionService(db, principal.tenant_id).create(principal, payload)


@router.post(
    "/connections/{connection_id}/verify",
    dependencies=[Depends(require(Permission.MANAGE_CONNECTIONS))],
    summary="Verify RBAC access for a connection",
)
async def verify_connection(connection_id: str, principal: CurrentUser, db: DbSession):
    return await ConnectionService(db, principal.tenant_id).verify(principal, connection_id)


@router.delete(
    "/connections/{connection_id}",
    status_code=204,
    response_model=None,
    dependencies=[Depends(require(Permission.MANAGE_CONNECTIONS))],
    summary="Remove a subscription connection",
)
async def delete_connection(connection_id: str, principal: CurrentUser, db: DbSession) -> None:
    await ConnectionService(db, principal.tenant_id).delete(principal, connection_id)
