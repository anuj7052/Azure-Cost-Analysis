from __future__ import annotations

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import Principal
from app.core.logging import redact, request_id_ctx
from app.repositories import AuditRepo


class AuditService:
    """Writes the append-only audit trail. Called on every mutating action."""

    def __init__(self, session: AsyncSession, tenant_id: str) -> None:
        self.repo = AuditRepo(session, tenant_id)

    async def record(
        self,
        *,
        principal: Principal | None,
        action: str,
        target_type: str = "",
        target_id: str = "",
        outcome: str = "success",
        ip_address: str = "",
        details: dict[str, Any] | None = None,
    ) -> None:
        await self.repo.record(
            actor_object_id=principal.object_id if principal else "system",
            actor_email=principal.email if principal else "system",
            actor_role=str(principal.role) if principal else "system",
            action=action,
            target_type=target_type,
            target_id=target_id,
            outcome=outcome,
            request_id=request_id_ctx.get(),
            ip_address=ip_address,
            details=redact(details or {}),
        )
