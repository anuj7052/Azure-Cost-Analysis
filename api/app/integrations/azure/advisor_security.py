from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from azure.mgmt.advisor.aio import AdvisorManagementClient
from azure.mgmt.resourcehealth.aio import ResourceHealthMgmtClient
from azure.mgmt.security.aio import SecurityCenter

from app.integrations.azure.credentials import ConnectionContext, credential_provider

log = logging.getLogger(__name__)

_SEVERITY_FROM_IMPACT = {"High": "high", "Medium": "medium", "Low": "low"}


class AdvisorGateway:
    def __init__(self, ctx: ConnectionContext) -> None:
        self.ctx = ctx

    async def recommendations(self) -> list[dict[str, Any]]:
        credential = await credential_provider.get(self.ctx)
        items: list[dict[str, Any]] = []
        try:
            async with AdvisorManagementClient(
                credential, self.ctx.subscription_id
            ) as client:
                async for reco in client.recommendations.list():
                    props = reco.additional_properties or {}
                    extended = getattr(reco, "extended_properties", None) or {}
                    savings = extended.get("savingsAmount") or extended.get(
                        "annualSavingsAmount"
                    )
                    monthly = 0.0
                    if savings:
                        try:
                            monthly = float(savings)
                            if "annualSavingsAmount" in extended:
                                monthly /= 12
                        except (TypeError, ValueError):
                            monthly = 0.0
                    items.append(
                        {
                            "azure_resource_id": (
                                getattr(reco, "resource_metadata", None)
                                and reco.resource_metadata.resource_id
                                or ""
                            ).lower(),
                            "subscription_id": self.ctx.subscription_id,
                            "rule": f"advisor_{(reco.category or 'cost')}".lower(),
                            "category": str(reco.category or "Cost"),
                            "source": "advisor",
                            "impact": _SEVERITY_FROM_IMPACT.get(
                                str(reco.impact), "medium"
                            ),
                            "confidence": "high",
                            "title": (reco.short_description.problem
                                      if reco.short_description else "")
                            or props.get("shortDescription", ""),
                            "recommended_action": (
                                reco.short_description.solution
                                if reco.short_description
                                else ""
                            ),
                            "estimated_monthly_savings": monthly,
                            "currency": extended.get("savingsCurrency", "USD"),
                            "evidence": dict(extended),
                        }
                    )
        finally:
            await credential.close()
        return items


class SecurityGateway:
    def __init__(self, ctx: ConnectionContext) -> None:
        self.ctx = ctx

    async def assessments(self) -> list[dict[str, Any]]:
        scope = f"/subscriptions/{self.ctx.subscription_id}"
        credential = await credential_provider.get(self.ctx)
        findings: list[dict[str, Any]] = []
        try:
            async with SecurityCenter(credential, self.ctx.subscription_id) as client:
                async for item in client.assessments.list(scope=scope):
                    status = getattr(item.status, "code", "") or ""
                    metadata = getattr(item, "metadata", None)
                    findings.append(
                        {
                            "assessment_id": item.name or "",
                            "azure_resource_id": (item.id or "").split("/providers/Microsoft.Security")[0].lower(),
                            "subscription_id": self.ctx.subscription_id,
                            "title": item.display_name or "",
                            "severity": str(getattr(metadata, "severity", "Low")),
                            "status": str(status),
                            "category": ",".join(
                                str(c) for c in (getattr(metadata, "categories", None) or [])
                            ),
                            "remediation": getattr(metadata, "remediation_description", "") or "",
                            "first_seen_at": datetime.now(timezone.utc),
                        }
                    )
        finally:
            await credential.close()
        return findings

    async def secure_scores(self) -> list[dict[str, Any]]:
        credential = await credential_provider.get(self.ctx)
        scores: list[dict[str, Any]] = []
        try:
            async with SecurityCenter(credential, self.ctx.subscription_id) as client:
                async for score in client.secure_scores.list():
                    current = float(getattr(score, "current", 0) or 0)
                    maximum = float(getattr(score, "max", 0) or 0)
                    scores.append(
                        {
                            "subscription_id": self.ctx.subscription_id,
                            "captured_on": datetime.now(timezone.utc),
                            "current_score": current,
                            "max_score": maximum,
                            "percentage": round(current / maximum * 100, 2)
                            if maximum
                            else 0.0,
                        }
                    )
        finally:
            await credential.close()
        return scores


class HealthGateway:
    async def resource_health(self, ctx: ConnectionContext) -> dict[str, str]:
        """Map `azure_resource_id -> availabilityState`."""
        credential = await credential_provider.get(ctx)
        states: dict[str, str] = {}
        try:
            async with ResourceHealthMgmtClient(credential, ctx.subscription_id) as client:
                async for status in client.availability_statuses.list_by_subscription_id():
                    resource_id = (status.id or "").split("/providers/Microsoft.ResourceHealth")[0]
                    props = getattr(status, "properties", None)
                    states[resource_id.lower()] = str(
                        getattr(props, "availability_state", "Unknown")
                    ).lower()
        finally:
            await credential.close()
        return states
