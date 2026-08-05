from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.ops import ExpiringSecret, IdentityRisk, NetworkExposure
from app.repositories import (
    ExpiringSecretRepo,
    IdentityRiskRepo,
    NetworkExposureRepo,
    SecureScoreRepo,
    SecurityFindingRepo,
)
from app.schemas import SecuritySummaryOut

# Ports that must never be reachable from the public internet.
SENSITIVE_PORTS = {22, 3389, 445, 1433, 3306, 5432, 6379, 27017, 9200, 5984}
PUBLIC_SOURCES = {"*", "internet", "any", "0.0.0.0/0"}
CERT_WARNING_DAYS = 30
CERT_CRITICAL_DAYS = 7


def analyze_nsg_rules(rules: list[dict]) -> list[dict]:
    """Flag inbound Allow rules that expose sensitive ports to broad sources."""
    exposures: list[dict] = []
    for rule in rules:
        if str(rule.get("direction", "")).lower() != "inbound":
            continue
        if str(rule.get("access", "")).lower() != "allow":
            continue

        sources = {str(s).lower() for s in (rule.get("sourcePrefixes") or [])}
        if rule.get("sourcePrefix"):
            sources.add(str(rule["sourcePrefix"]).lower())
        if not sources & PUBLIC_SOURCES:
            continue

        ports = [p for p in (rule.get("destPorts") or []) if p]
        if rule.get("destPort"):
            ports.append(rule["destPort"])
        exposed = _expand_ports(ports)

        hits = sorted(exposed & SENSITIVE_PORTS)
        wildcard = "*" in ports
        if not hits and not wildcard:
            continue

        exposures.append(
            {
                "nsg_id": rule["nsgId"],
                "nsg_name": rule.get("nsgName", ""),
                "subscription_id": rule.get("subscriptionId", ""),
                "rule_name": rule.get("ruleName", ""),
                "direction": "Inbound",
                "priority": int(rule.get("priority") or 0),
                "protocol": str(rule.get("protocol") or "*"),
                "source": ",".join(sorted(sources)),
                "ports": ["*"] if wildcard else hits,
                "severity": "critical" if wildcard else "high",
                "reason": (
                    "All ports open to the internet"
                    if wildcard
                    else f"Sensitive port(s) {hits} reachable from the internet"
                ),
            }
        )
    return exposures


def _expand_ports(ports: list) -> set[int]:
    out: set[int] = set()
    for port in ports:
        text = str(port)
        if text == "*":
            continue
        if "-" in text:
            try:
                low, high = (int(p) for p in text.split("-", 1))
            except ValueError:
                continue
            if high - low > 10000:  # effectively a wildcard range
                out |= SENSITIVE_PORTS
            else:
                out |= set(range(low, high + 1))
        else:
            try:
                out.add(int(text))
            except ValueError:
                continue
    return out


def classify_expiry(expires_on: datetime | None) -> tuple[int, str]:
    if expires_on is None:
        return 9999, "ok"
    days = (expires_on - datetime.now(timezone.utc)).days
    if days <= CERT_CRITICAL_DAYS:
        return days, "critical"
    if days <= CERT_WARNING_DAYS:
        return days, "warning"
    return days, "ok"


class SecurityService:
    def __init__(self, session: AsyncSession, tenant_id: str) -> None:
        self.session = session
        self.tenant_id = tenant_id
        self.findings = SecurityFindingRepo(session, tenant_id)
        self.scores = SecureScoreRepo(session, tenant_id)
        self.secrets = ExpiringSecretRepo(session, tenant_id)
        self.identities = IdentityRiskRepo(session, tenant_id)
        self.exposures = NetworkExposureRepo(session, tenant_id)

    async def summary(self) -> SecuritySummaryOut:
        horizon = datetime.now(timezone.utc) + timedelta(days=CERT_WARNING_DAYS)
        expiring = await self.secrets.count([ExpiringSecret.expires_on <= horizon])
        risky = await self.identities.count(
            [IdentityRisk.risk_level.in_(["medium", "high"])]
        )
        no_mfa = await self.identities.count([IdentityRisk.mfa_enabled.is_(False)])
        open_exposures = await self.exposures.count(
            [NetworkExposure.severity.in_(["high", "critical"])]
        )
        return SecuritySummaryOut(
            secure_score_pct=await self.scores.latest_percentage(),
            findings_by_severity=await self.findings.severity_counts(),
            expiring_secrets=expiring,
            risky_identities=risky,
            users_without_mfa=no_mfa,
            open_exposures=open_exposures,
        )

    async def open_ports(self) -> list[dict]:
        stmt = (
            select(NetworkExposure.nsg_name, func.count())
            .where(NetworkExposure.tenant_id == self.tenant_id)
            .group_by(NetworkExposure.nsg_name)
        )
        return [
            {"nsg": row[0], "exposed_rules": int(row[1])}
            for row in (await self.session.execute(stmt)).all()
        ]
