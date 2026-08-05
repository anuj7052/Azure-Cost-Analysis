from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.inventory import ResourceType
from app.repositories import MetricRepo, RecommendationRepo, ResourceRepo
from app.repositories import CostRepo
from app.services.periods import last_n_days

log = logging.getLogger(__name__)

LOOKBACK_DAYS = 14

# Approximate monthly unit prices used only when Azure gives us no cost row.
FALLBACK_DISK_GB_MONTH = 0.05
FALLBACK_PUBLIC_IP_MONTH = 3.60
FALLBACK_SNAPSHOT_GB_MONTH = 0.05

# Fractional saving from dropping one VM size in the same family.
DOWNSIZE_SAVING_FRACTION = 0.5


@dataclass(slots=True)
class Finding:
    azure_resource_id: str
    subscription_id: str
    resource_name: str
    rule: str
    title: str
    recommended_action: str
    estimated_monthly_savings: float
    evidence: dict[str, Any]
    impact: str = "medium"
    confidence: str = "medium"
    category: str = "Cost"
    source: str = "rules"
    currency: str = "USD"


class OptimizationService:
    """Evaluates cost-optimisation rules over already-synced data.

    Every rule reads from Postgres — never from Azure — so a full pass is cheap
    and can run nightly for all tenants.
    """

    def __init__(self, session: AsyncSession, tenant_id: str) -> None:
        self.session = session
        self.tenant_id = tenant_id
        self.resources = ResourceRepo(session, tenant_id)
        self.metrics = MetricRepo(session, tenant_id)
        self.costs = CostRepo(session, tenant_id)
        self.recommendations = RecommendationRepo(session, tenant_id)

    async def _monthly_cost(self, resource) -> float:
        if resource.monthly_cost:
            return float(resource.monthly_cost)
        period = last_n_days(30)
        rows = await self.costs.grouped("resource", period.start, period.end, limit=500)
        match = next(
            (r for r in rows if r["key"] == resource.azure_resource_id.lower()), None
        )
        return float(match["cost"]) if match else 0.0

    # --- individual rules --------------------------------------------
    async def _idle_vms(self, vms) -> list[Finding]:
        findings = []
        for vm in vms:
            cpu = await self.metrics.aggregate(
                vm.azure_resource_id, "cpu", LOOKBACK_DAYS
            )
            if not cpu["samples"] or cpu["avg"] is None:
                continue
            net_in = await self.metrics.aggregate(
                vm.azure_resource_id, "network_in", LOOKBACK_DAYS
            )
            if cpu["avg"] < 5 and (net_in["max"] or 0) < 1_000_000:
                cost = await self._monthly_cost(vm)
                findings.append(
                    Finding(
                        azure_resource_id=vm.azure_resource_id,
                        subscription_id=vm.subscription_id,
                        resource_name=vm.name,
                        rule="idle_vm",
                        title=f"{vm.name} is idle",
                        recommended_action=(
                            "Deallocate or delete this VM. Average CPU has been "
                            f"{cpu['avg']:.1f}% over {LOOKBACK_DAYS} days."
                        ),
                        estimated_monthly_savings=round(cost, 2),
                        evidence={
                            "avg_cpu_pct": round(cpu["avg"], 2),
                            "max_network_in_bytes": net_in["max"],
                            "lookback_days": LOOKBACK_DAYS,
                        },
                        impact="high",
                        confidence="high" if cpu["samples"] > 100 else "medium",
                    )
                )
        return findings

    async def _oversized_vms(self, vms) -> list[Finding]:
        findings = []
        for vm in vms:
            cpu = await self.metrics.aggregate(
                vm.azure_resource_id, "cpu", LOOKBACK_DAYS
            )
            if cpu["p95"] is None or cpu["p95"] >= 40 or cpu["avg"] is not None and cpu["avg"] < 5:
                continue  # idle VMs are handled by the idle rule
            cost = await self._monthly_cost(vm)
            findings.append(
                Finding(
                    azure_resource_id=vm.azure_resource_id,
                    subscription_id=vm.subscription_id,
                    resource_name=vm.name,
                    rule="oversized_vm",
                    title=f"{vm.name} is oversized",
                    recommended_action=(
                        f"Resize {vm.sku or 'this VM'} down one size. P95 CPU is "
                        f"{cpu['p95']:.1f}%."
                    ),
                    estimated_monthly_savings=round(cost * DOWNSIZE_SAVING_FRACTION, 2),
                    evidence={
                        "p95_cpu_pct": round(cpu["p95"], 2),
                        "current_sku": vm.sku,
                        "lookback_days": LOOKBACK_DAYS,
                    },
                    confidence="medium",
                )
            )
        return findings

    async def _stopped_not_deallocated(self, vms) -> list[Finding]:
        findings = []
        for vm in vms:
            if vm.power_state.lower() != "powerstate/stopped":
                continue
            cost = await self._monthly_cost(vm)
            findings.append(
                Finding(
                    azure_resource_id=vm.azure_resource_id,
                    subscription_id=vm.subscription_id,
                    resource_name=vm.name,
                    rule="stopped_not_deallocated",
                    title=f"{vm.name} is stopped but still billed",
                    recommended_action=(
                        "Deallocate the VM. A 'stopped' VM still reserves and bills "
                        "for compute; only 'deallocated' stops compute charges."
                    ),
                    estimated_monthly_savings=round(cost, 2),
                    evidence={"power_state": vm.power_state},
                    impact="high",
                    confidence="high",
                )
            )
        return findings

    async def _unattached_disks(self, disks) -> list[Finding]:
        findings = []
        for disk in disks:
            if disk.properties.get("managedBy"):
                continue
            size_gb = float(disk.properties.get("diskSizeGB") or 0)
            cost = await self._monthly_cost(disk) or size_gb * FALLBACK_DISK_GB_MONTH
            findings.append(
                Finding(
                    azure_resource_id=disk.azure_resource_id,
                    subscription_id=disk.subscription_id,
                    resource_name=disk.name,
                    rule="unattached_disk",
                    title=f"{disk.name} is not attached to any VM",
                    recommended_action="Snapshot then delete the disk if it is no longer needed.",
                    estimated_monthly_savings=round(cost, 2),
                    evidence={"size_gb": size_gb, "sku": disk.sku},
                    confidence="high",
                )
            )
        return findings

    async def _unused_public_ips(self, ips) -> list[Finding]:
        findings = []
        for ip in ips:
            if ip.properties.get("ipConfiguration"):
                continue
            cost = await self._monthly_cost(ip) or FALLBACK_PUBLIC_IP_MONTH
            findings.append(
                Finding(
                    azure_resource_id=ip.azure_resource_id,
                    subscription_id=ip.subscription_id,
                    resource_name=ip.name,
                    rule="unused_public_ip",
                    title=f"{ip.name} is a reserved but unassociated public IP",
                    recommended_action="Delete the public IP address if it is not reserved for future use.",
                    estimated_monthly_savings=round(cost, 2),
                    evidence={"sku": ip.sku},
                    confidence="high",
                )
            )
        return findings

    async def _old_snapshots(self, snapshots, *, max_age_days: int = 90) -> list[Finding]:
        findings = []
        now = datetime.now(timezone.utc)
        for snap in snapshots:
            created_raw = snap.properties.get("timeCreated")
            if not created_raw:
                continue
            try:
                created = datetime.fromisoformat(str(created_raw).replace("Z", "+00:00"))
            except ValueError:
                continue
            age = (now - created).days
            if age < max_age_days:
                continue
            size_gb = float(snap.properties.get("diskSizeGB") or 0)
            cost = await self._monthly_cost(snap) or size_gb * FALLBACK_SNAPSHOT_GB_MONTH
            findings.append(
                Finding(
                    azure_resource_id=snap.azure_resource_id,
                    subscription_id=snap.subscription_id,
                    resource_name=snap.name,
                    rule="old_snapshot",
                    title=f"{snap.name} is {age} days old",
                    recommended_action="Delete the snapshot if the retention requirement has passed.",
                    estimated_monthly_savings=round(cost, 2),
                    evidence={"age_days": age, "size_gb": size_gb},
                    confidence="medium",
                )
            )
        return findings

    async def _low_utilization_databases(self, databases) -> list[Finding]:
        findings = []
        for db in databases:
            usage = await self.metrics.aggregate(
                db.azure_resource_id, "dtu", LOOKBACK_DAYS
            )
            if usage["p95"] is None or usage["p95"] >= 20:
                continue
            cost = await self._monthly_cost(db)
            findings.append(
                Finding(
                    azure_resource_id=db.azure_resource_id,
                    subscription_id=db.subscription_id,
                    resource_name=db.name,
                    rule="low_utilization_database",
                    title=f"{db.name} is over-provisioned",
                    recommended_action="Move to a lower service tier or switch to serverless.",
                    estimated_monthly_savings=round(cost * DOWNSIZE_SAVING_FRACTION, 2),
                    evidence={"p95_dtu_pct": round(usage["p95"], 2)},
                )
            )
        return findings

    # --- orchestration -----------------------------------------------
    async def evaluate(self) -> int:
        """Run every rule and persist findings, honouring prior dismissals."""
        all_resources = await self.resources.list(limit=500)
        by_type: dict[str, list] = {}
        for resource in all_resources:
            by_type.setdefault(resource.resource_type, []).append(resource)

        findings: list[Finding] = []
        vms = by_type.get(ResourceType.VIRTUAL_MACHINE, [])
        findings += await self._idle_vms(vms)
        findings += await self._oversized_vms(vms)
        findings += await self._stopped_not_deallocated(vms)
        findings += await self._unattached_disks(by_type.get(ResourceType.DISK, []))
        findings += await self._unused_public_ips(by_type.get(ResourceType.PUBLIC_IP, []))
        findings += await self._old_snapshots(by_type.get(ResourceType.SNAPSHOT, []))
        findings += await self._low_utilization_databases(
            by_type.get(ResourceType.SQL_DATABASE, [])
        )

        dismissed = await self.recommendations.dismissed_keys()
        rows = [
            {
                "azure_resource_id": f.azure_resource_id,
                "subscription_id": f.subscription_id,
                "resource_name": f.resource_name,
                "rule": f.rule,
                "category": f.category,
                "source": f.source,
                "impact": f.impact,
                "confidence": f.confidence,
                "title": f.title,
                "evidence": f.evidence,
                "recommended_action": f.recommended_action,
                "estimated_monthly_savings": f.estimated_monthly_savings,
                "currency": f.currency,
                "state": "open",
            }
            for f in findings
            if (f.azure_resource_id, f.rule) not in dismissed
        ]
        return await self.recommendations.upsert(rows)

    async def merge_advisor(self, advisor_rows: list[dict]) -> int:
        """Merge Advisor output, preferring Advisor's savings figure on overlap."""
        dismissed = await self.recommendations.dismissed_keys()
        rows = [
            {**row, "state": "open", "resource_name": row.get("resource_name", "")}
            for row in advisor_rows
            if row.get("azure_resource_id")
            and (row["azure_resource_id"], row["rule"]) not in dismissed
        ]
        return await self.recommendations.upsert(rows)
