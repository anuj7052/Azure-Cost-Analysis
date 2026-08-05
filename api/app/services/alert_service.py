from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.inventory import BackupStatus, Resource, ResourceType
from app.repositories import (
    AlertRepo,
    AlertRuleRepo,
    BackupRepo,
    CostRepo,
    ExpiringSecretRepo,
    MetricRepo,
    ResourceRepo,
    SecurityFindingRepo,
)
from app.services.periods import month_to_date

log = logging.getLogger(__name__)


class AlertService:
    """Evaluates alert rules against synced data and de-duplicates alerts."""

    def __init__(self, session: AsyncSession, tenant_id: str) -> None:
        self.rules = AlertRuleRepo(session, tenant_id)
        self.alerts = AlertRepo(session, tenant_id)
        self.resources = ResourceRepo(session, tenant_id)
        self.metrics = MetricRepo(session, tenant_id)
        self.costs = CostRepo(session, tenant_id)
        self.backups = BackupRepo(session, tenant_id)
        self.secrets = ExpiringSecretRepo(session, tenant_id)
        self.findings = SecurityFindingRepo(session, tenant_id)

    async def evaluate_all(self) -> int:
        raised = 0
        for rule in await self.rules.enabled():
            handler = getattr(self, f"_eval_{rule.kind}", None)
            if handler is None:
                log.warning("no handler for alert rule kind", extra={"kind": rule.kind})
                continue
            for candidate in await handler(rule):
                if await self._raise(rule, **candidate):
                    raised += 1
        return raised

    async def _raise(
        self,
        rule,
        *,
        azure_resource_id: str,
        title: str,
        description: str,
        context: dict[str, Any],
        subscription_id: str = "",
    ) -> bool:
        """Create an alert unless an identical one is already active or cooling down."""
        existing = await self.alerts.find_active(rule.kind, azure_resource_id)
        if existing is not None:
            cooldown = timedelta(minutes=rule.cooldown_minutes)
            last = existing.last_notified_at or existing.triggered_at
            if datetime.now(timezone.utc) - last < cooldown:
                return False
            existing.last_notified_at = datetime.now(timezone.utc)
            return False

        await self.alerts.add(
            rule=rule.kind,
            rule_name=rule.name,
            azure_resource_id=azure_resource_id,
            subscription_id=subscription_id,
            severity=rule.severity,
            title=title,
            description=description,
            state="active",
            triggered_at=datetime.now(timezone.utc),
            last_notified_at=datetime.now(timezone.utc),
            context=context,
        )
        return True

    # --- rule handlers ------------------------------------------------
    async def _eval_budget_exceeded(self, rule) -> list[dict]:
        budget = float(rule.threshold or 0)
        if budget <= 0:
            return []
        period = month_to_date()
        spend = await self.costs.total_between(period.start, period.end)
        if spend < budget:
            return []
        return [
            {
                "azure_resource_id": "",
                "title": f"Month-to-date spend exceeded the {budget:,.0f} budget",
                "description": f"Current month-to-date spend is {spend:,.2f}.",
                "context": {"budget": budget, "spend": round(spend, 2)},
            }
        ]

    async def _eval_high_cpu(self, rule) -> list[dict]:
        threshold = float(rule.threshold or 90)
        hours = max(rule.window_minutes // 60, 1)
        out = []
        vms = await self.resources.list(
            limit=500, filters=[Resource.resource_type == ResourceType.VIRTUAL_MACHINE]
        )
        for vm in vms:
            points = await self.metrics.series(vm.azure_resource_id, "cpu", hours=hours)
            values = [float(p.average) for p in points if p.average is not None]
            if not values:
                continue
            avg = sum(values) / len(values)
            if avg >= threshold:
                out.append(
                    {
                        "azure_resource_id": vm.azure_resource_id,
                        "subscription_id": vm.subscription_id,
                        "title": f"High CPU on {vm.name}",
                        "description": f"Average CPU {avg:.1f}% over the last {hours}h.",
                        "context": {"avg_cpu_pct": round(avg, 2), "threshold": threshold},
                    }
                )
        return out

    async def _eval_high_storage(self, rule) -> list[dict]:
        threshold = float(rule.threshold or 85)
        out = []
        databases = await self.resources.list(
            limit=500, filters=[Resource.resource_type == ResourceType.SQL_DATABASE]
        )
        for db in databases:
            usage = await self.metrics.aggregate(db.azure_resource_id, "storage", 1)
            if usage["max"] is not None and usage["max"] >= threshold:
                out.append(
                    {
                        "azure_resource_id": db.azure_resource_id,
                        "subscription_id": db.subscription_id,
                        "title": f"Storage nearly full on {db.name}",
                        "description": f"Storage usage peaked at {usage['max']:.1f}%.",
                        "context": {"max_storage_pct": usage["max"]},
                    }
                )
        return out

    async def _eval_vm_stopped(self, rule) -> list[dict]:
        vms = await self.resources.list(
            limit=500,
            filters=[
                Resource.resource_type == ResourceType.VIRTUAL_MACHINE,
                Resource.power_state.ilike("%stopped%"),
            ],
        )
        return [
            {
                "azure_resource_id": vm.azure_resource_id,
                "subscription_id": vm.subscription_id,
                "title": f"{vm.name} is stopped",
                "description": (
                    "The VM is not running. If this was unplanned, investigate the "
                    "activity log for the stop operation."
                ),
                "context": {"power_state": vm.power_state},
            }
            for vm in vms
        ]

    async def _eval_backup_failed(self, rule) -> list[dict]:
        rows = await self.backups.list(
            limit=500, filters=[BackupStatus.last_backup_status.ilike("%fail%")]
        )
        return [
            {
                "azure_resource_id": row.azure_resource_id,
                "title": "Backup failed",
                "description": f"Last backup status: {row.last_backup_status}.",
                "context": {
                    "policy": row.policy_name,
                    "last_backup_time": row.last_backup_time.isoformat()
                    if row.last_backup_time
                    else None,
                },
            }
            for row in rows
        ]

    async def _eval_certificate_expiry(self, rule) -> list[dict]:
        days = int(rule.threshold or 30)
        horizon = datetime.now(timezone.utc) + timedelta(days=days)
        from app.models.ops import ExpiringSecret  # local import avoids cycle

        rows = await self.secrets.list(
            limit=500, filters=[ExpiringSecret.expires_on <= horizon]
        )
        return [
            {
                "azure_resource_id": row.item_id,
                "title": f"{row.item_type} '{row.item_name}' expires in {row.days_remaining} days",
                "description": f"Stored in Key Vault {row.vault_name}.",
                "context": {"days_remaining": row.days_remaining},
            }
            for row in rows
        ]

    async def _eval_security_incident(self, rule) -> list[dict]:
        from app.models.ops import SecurityFinding  # local import avoids cycle

        rows = await self.findings.list(
            limit=200,
            filters=[
                SecurityFinding.severity == "High",
                SecurityFinding.status != "Healthy",
            ],
        )
        return [
            {
                "azure_resource_id": row.azure_resource_id,
                "subscription_id": row.subscription_id,
                "title": f"High severity finding: {row.title}",
                "description": row.remediation or "",
                "context": {"assessment_id": row.assessment_id},
            }
            for row in rows
        ]
