from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Query

from app.auth.dependencies import CurrentUser, DbSession, require
from app.auth.rbac import Permission
from app.repositories import (
    AlertRepo,
    AlertRuleRepo,
    NetworkExposureRepo,
    RecommendationRepo,
)
from app.schemas import (
    AlertOut,
    AlertRuleIn,
    NetworkExposureOut,
    RecommendationOut,
    SecuritySummaryOut,
)
from app.services.audit import AuditService
from app.services.security_service import SecurityService

router = APIRouter(dependencies=[Depends(require(Permission.READ))])


# --- optimization -----------------------------------------------------
@router.get("/recommendations", response_model=list[RecommendationOut], tags=["optimization"])
async def recommendations(
    principal: CurrentUser, db: DbSession, limit: int = Query(100, ge=1, le=500)
):
    return await RecommendationRepo(db, principal.tenant_id).open_items(limit=limit)


@router.get("/recommendations/savings", tags=["optimization"])
async def total_savings(principal: CurrentUser, db: DbSession):
    repo = RecommendationRepo(db, principal.tenant_id)
    return {"estimated_monthly_savings": await repo.total_savings()}


@router.post(
    "/recommendations/{recommendation_id}/dismiss",
    response_model=RecommendationOut,
    dependencies=[Depends(require(Permission.MANAGE_RECOMMENDATIONS))],
    tags=["optimization"],
)
async def dismiss_recommendation(
    recommendation_id: str, principal: CurrentUser, db: DbSession
):
    repo = RecommendationRepo(db, principal.tenant_id)
    item = await repo.get_or_404(recommendation_id)
    item.state = "dismissed"
    item.dismissed_by = principal.email
    item.dismissed_at = datetime.now(timezone.utc)
    await AuditService(db, principal.tenant_id).record(
        principal=principal,
        action="recommendation.dismiss",
        target_type="recommendation",
        target_id=str(recommendation_id),
        details={"rule": item.rule, "resource": item.azure_resource_id},
    )
    return item


# --- security ---------------------------------------------------------
@router.get("/security/summary", response_model=SecuritySummaryOut, tags=["security"])
async def security_summary(principal: CurrentUser, db: DbSession):
    return await SecurityService(db, principal.tenant_id).summary()


@router.get("/security/exposures", response_model=list[NetworkExposureOut], tags=["networking"])
async def exposures(principal: CurrentUser, db: DbSession, limit: int = Query(100, ge=1, le=500)):
    return await NetworkExposureRepo(db, principal.tenant_id).list(limit=limit)


@router.get("/security/open-ports", tags=["networking"])
async def open_ports(principal: CurrentUser, db: DbSession):
    return await SecurityService(db, principal.tenant_id).open_ports()


# --- alerts -----------------------------------------------------------
@router.get("/alerts", response_model=list[AlertOut], tags=["alerts"])
async def alerts(principal: CurrentUser, db: DbSession, limit: int = Query(100, ge=1, le=500)):
    return await AlertRepo(db, principal.tenant_id).active(limit=limit)


@router.post(
    "/alerts/{alert_id}/acknowledge",
    response_model=AlertOut,
    dependencies=[Depends(require(Permission.MANAGE_ALERT_RULES))],
    tags=["alerts"],
)
async def acknowledge(alert_id: str, principal: CurrentUser, db: DbSession):
    repo = AlertRepo(db, principal.tenant_id)
    alert = await repo.get_or_404(alert_id)
    alert.state = "acknowledged"
    alert.acknowledged_at = datetime.now(timezone.utc)
    await AuditService(db, principal.tenant_id).record(
        principal=principal,
        action="alert.acknowledge",
        target_type="alert",
        target_id=str(alert_id),
    )
    return alert


@router.post(
    "/alert-rules",
    status_code=201,
    dependencies=[Depends(require(Permission.MANAGE_ALERT_RULES))],
    tags=["alerts"],
)
async def create_alert_rule(payload: AlertRuleIn, principal: CurrentUser, db: DbSession):
    rule = await AlertRuleRepo(db, principal.tenant_id).add(**payload.model_dump())
    await AuditService(db, principal.tenant_id).record(
        principal=principal,
        action="alert_rule.create",
        target_type="alert_rule",
        target_id=payload.name,
        details=payload.model_dump(),
    )
    return {"id": str(rule.id), "name": rule.name, "kind": rule.kind}


@router.get("/alert-rules", tags=["alerts"])
async def list_alert_rules(principal: CurrentUser, db: DbSession):
    rules = await AlertRuleRepo(db, principal.tenant_id).list(limit=200)
    return [
        {
            "id": str(r.id),
            "name": r.name,
            "kind": r.kind,
            "enabled": r.enabled,
            "threshold": float(r.threshold) if r.threshold is not None else None,
            "severity": r.severity,
            "channels": r.channels,
        }
        for r in rules
    ]
