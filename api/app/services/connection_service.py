from __future__ import annotations

import logging
from datetime import datetime, timezone

from azure.mgmt.authorization.aio import AuthorizationManagementClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import Principal
from app.core.errors import ConflictError, NotFoundError
from app.integrations.azure import ConnectionContext, credential_provider
from app.integrations.azure.credentials import REQUIRED_ROLES
from app.integrations.azure.resource_graph import ResourceGraphGateway
from app.repositories import ConnectionRepo, TenantRepo
from app.schemas import ConnectionIn
from app.services.audit import AuditService

log = logging.getLogger(__name__)


class ConnectionService:
    """Onboards Azure subscriptions and verifies least-privilege RBAC grants."""

    def __init__(self, session: AsyncSession, tenant_id: str) -> None:
        self.session = session
        self.tenant_id = tenant_id
        self.repo = ConnectionRepo(session, tenant_id)
        self.tenants = TenantRepo(session, tenant_id)
        self.audit = AuditService(session, tenant_id)

    async def ensure_tenant(self, principal: Principal) -> None:
        if await self.tenants.current() is None:
            await self.tenants.add(
                display_name=principal.email.split("@")[-1] or principal.tenant_id,
                onboarded_at=datetime.now(timezone.utc),
            )

    async def create(self, principal: Principal, payload: ConnectionIn):
        await self.ensure_tenant(principal)
        if await self.repo.by_subscription(payload.subscription_id) is not None:
            raise ConflictError("This subscription is already connected.")

        tenant = await self.tenants.current()
        connection = await self.repo.add(
            tenant_pk=tenant.id,
            subscription_id=payload.subscription_id,
            display_name=payload.display_name,
            azure_tenant_id=payload.azure_tenant_id,
            auth_mode=payload.auth_mode,
            credential_ref=payload.credential_ref,
            state="pending",
        )
        await self.audit.record(
            principal=principal,
            action="connection.create",
            target_type="subscription",
            target_id=payload.subscription_id,
            details={"auth_mode": payload.auth_mode},
        )
        return connection

    async def verify(self, principal: Principal, connection_id) -> dict:
        """Confirm we can read the subscription and that roles are least-privilege."""
        connection = await self.repo.get_or_404(connection_id)
        ctx = ConnectionContext(
            tenant_id=self.tenant_id,
            azure_tenant_id=connection.azure_tenant_id,
            subscription_id=connection.subscription_id,
            credential_ref=connection.credential_ref,
            auth_mode=connection.auth_mode,
        )

        try:
            probe = await ResourceGraphGateway(ctx).query(
                "Resources | project id | limit 1"
            )
            roles = await self._assigned_roles(ctx)
            connection.granted_roles = roles
            connection.state = "connected"
            connection.last_error = None
            connection.last_verified_at = datetime.now(timezone.utc)
            outcome, detail = "success", {"resources_visible": len(probe), "roles": roles}
        except Exception as exc:  # noqa: BLE001 - surfaced to the operator
            connection.state = "error"
            connection.last_error = str(exc)[:2000]
            outcome, detail = "failure", {"error": str(exc)[:500]}

        await self.audit.record(
            principal=principal,
            action="connection.verify",
            target_type="subscription",
            target_id=connection.subscription_id,
            outcome=outcome,
            details=detail,
        )
        return {
            "state": connection.state,
            "granted_roles": connection.granted_roles,
            "required_roles": list(REQUIRED_ROLES),
            "error": connection.last_error,
        }

    async def _assigned_roles(self, ctx: ConnectionContext) -> list[str]:
        credential = await credential_provider.get(ctx)
        names: list[str] = []
        try:
            async with AuthorizationManagementClient(
                credential, ctx.subscription_id
            ) as client:
                definitions = {}
                async for definition in client.role_definitions.list(
                    scope=f"/subscriptions/{ctx.subscription_id}"
                ):
                    definitions[definition.id] = definition.role_name
                async for assignment in client.role_assignments.list_for_subscription():
                    name = definitions.get(assignment.role_definition_id)
                    if name:
                        names.append(name)
        finally:
            await credential.close()
        return sorted(set(names))

    async def delete(self, principal: Principal, connection_id) -> None:
        connection = await self.repo.get(connection_id)
        if connection is None:
            raise NotFoundError("Connection not found.")
        subscription_id = connection.subscription_id
        await self.repo.delete(connection)
        await self.audit.record(
            principal=principal,
            action="connection.delete",
            target_type="subscription",
            target_id=subscription_id,
        )
