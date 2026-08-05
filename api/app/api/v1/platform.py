from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, Request

from app.auth.dependencies import CurrentUser, DbSession, require
from app.auth.rbac import Permission
from app.core.errors import RateLimitedError
from app.repositories import ReportRunRepo, SyncRunRepo
from app.schemas import AssistantAnswer, AssistantQuery, ReportRequest, ReportRunOut
from app.services.assistant_service import AssistantService
from app.services.audit import AuditService
from app.workers.tasks import run_report_task, run_sync_task

log = logging.getLogger(__name__)
router = APIRouter()


@router.post(
    "/sync/{kind}",
    status_code=202,
    dependencies=[Depends(require(Permission.TRIGGER_SYNC))],
    tags=["sync"],
    summary="Queue a synchronisation pass",
)
async def trigger_sync(kind: str, principal: CurrentUser, db: DbSession):
    allowed = {"inventory", "cost", "metrics", "activity", "security", "recommendations"}
    if kind not in allowed:
        from app.core.errors import ValidationError

        raise ValidationError(f"Unknown sync kind. Allowed: {sorted(allowed)}")

    run_sync_task.delay(principal.tenant_id, kind)
    await AuditService(db, principal.tenant_id).record(
        principal=principal, action="sync.trigger", target_type="sync", target_id=kind
    )
    return {"queued": True, "kind": kind}


@router.get(
    "/sync/status",
    dependencies=[Depends(require(Permission.READ))],
    tags=["sync"],
)
async def sync_status(principal: CurrentUser, db: DbSession):
    repo = SyncRunRepo(db, principal.tenant_id)
    kinds = ["inventory", "cost", "metrics", "activity", "security", "advisor"]
    out = []
    for kind in kinds:
        run = await repo.latest(kind)
        out.append(
            {
                "kind": kind,
                "state": run.state if run else "never_run",
                "finished_at": run.finished_at if run else None,
                "items_synced": run.items_synced if run else 0,
                "error": run.error if run else None,
            }
        )
    return out


@router.post(
    "/reports",
    status_code=202,
    response_model=ReportRunOut,
    dependencies=[Depends(require(Permission.RUN_REPORTS))],
    tags=["reports"],
    summary="Queue a report export",
)
async def create_report(payload: ReportRequest, principal: CurrentUser, db: DbSession):
    run = await ReportRunRepo(db, principal.tenant_id).add(
        report_type=payload.report_type,
        export_format=payload.export_format,
        state="queued",
        requested_by=principal.email,
    )
    await db.flush()
    run_report_task.delay(
        principal.tenant_id, str(run.id), payload.report_type, payload.export_format
    )
    await AuditService(db, principal.tenant_id).record(
        principal=principal,
        action="report.request",
        target_type="report",
        target_id=str(run.id),
        details=payload.model_dump(mode="json"),
    )
    return run


@router.get(
    "/reports",
    response_model=list[ReportRunOut],
    dependencies=[Depends(require(Permission.READ))],
    tags=["reports"],
)
async def list_reports(principal: CurrentUser, db: DbSession):
    return await ReportRunRepo(db, principal.tenant_id).list(limit=50)


@router.post(
    "/assistant/ask",
    response_model=AssistantAnswer,
    dependencies=[Depends(require(Permission.READ))],
    tags=["assistant"],
    summary="Ask a natural-language question about your Azure estate",
)
async def ask_assistant(
    payload: AssistantQuery, request: Request, principal: CurrentUser, db: DbSession
):
    limiter = getattr(request.app.state, "rate_limiter", None)
    if limiter is not None and not await limiter.allow(
        f"assistant:{principal.tenant_id}:{principal.object_id}"
    ):
        raise RateLimitedError("Assistant hourly limit reached for this user.")

    answer = await AssistantService(db, principal.tenant_id).ask(
        payload.question, payload.resource_id
    )
    await AuditService(db, principal.tenant_id).record(
        principal=principal,
        action="assistant.ask",
        target_type="assistant",
        target_id=payload.resource_id or "",
        details={"question": payload.question[:500], "tools": answer.used_tools},
    )
    return answer
