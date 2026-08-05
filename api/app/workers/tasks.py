from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any

from croniter import croniter
from sqlalchemy import select

from app.core.db import engine, session_scope
from app.core.logging import configure_logging, tenant_id_ctx
from app.models.tenant import Tenant
from app.repositories import ReportRunRepo, ReportScheduleRepo
from app.services.alert_service import AlertService
from app.services.notifications import deliver_report
from app.services.report_service import ReportService
from app.services.sync_service import SyncService
from app.workers.celery_app import celery_app

log = logging.getLogger(__name__)
configure_logging()

SYNC_HANDLERS = {
    "inventory": "sync_inventory",
    "cost": "sync_cost",
    "metrics": "sync_metrics",
    "activity": "sync_activity",
    "security": "sync_security",
    "recommendations": "sync_recommendations",
}


def _run(coro):
    """Celery workers are sync; each task owns its own event loop.

    The engine's connection pool is disposed inside that loop before it closes:
    asyncpg connections are bound to the loop that created them, so leaving them
    pooled would make the next task fail with "Event loop is closed".
    """

    async def _wrapped():
        try:
            return await coro
        finally:
            await engine.dispose()

    return asyncio.run(_wrapped())


async def _active_tenant_ids() -> list[str]:
    async with session_scope() as session:
        rows = await session.execute(
            select(Tenant.tenant_id).where(Tenant.is_active.is_(True))
        )
        return [r[0] for r in rows.all()]


@celery_app.task(name="app.workers.tasks.schedule_all_tenants")
def schedule_all_tenants(kind: str) -> dict[str, Any]:
    tenant_ids = _run(_active_tenant_ids())
    for tenant_id in tenant_ids:
        run_sync_task.delay(tenant_id, kind)
    return {"kind": kind, "tenants": len(tenant_ids)}


@celery_app.task(
    name="app.workers.tasks.run_sync_task",
    bind=True,
    max_retries=3,
    default_retry_delay=120,
)
def run_sync_task(self, tenant_id: str, kind: str) -> dict[str, Any]:
    method = SYNC_HANDLERS.get(kind)
    if method is None:
        return {"error": f"unknown sync kind: {kind}"}

    tenant_id_ctx.set(tenant_id)

    async def _do() -> dict[str, Any]:
        async with session_scope() as session:
            service = SyncService(session, tenant_id)
            return await getattr(service, method)()

    try:
        return _run(_do())
    except Exception as exc:  # noqa: BLE001 - retried with backoff
        log.exception("sync task failed", extra={"kind": kind})
        raise self.retry(exc=exc)


@celery_app.task(name="app.workers.tasks.evaluate_alerts_all_tenants")
def evaluate_alerts_all_tenants() -> dict[str, Any]:
    tenant_ids = _run(_active_tenant_ids())
    for tenant_id in tenant_ids:
        evaluate_alerts_task.delay(tenant_id)
    return {"tenants": len(tenant_ids)}


@celery_app.task(name="app.workers.tasks.evaluate_alerts_task")
def evaluate_alerts_task(tenant_id: str) -> dict[str, Any]:
    tenant_id_ctx.set(tenant_id)

    async def _do() -> dict[str, Any]:
        async with session_scope() as session:
            return {"raised": await AlertService(session, tenant_id).evaluate_all()}

    return _run(_do())


@celery_app.task(name="app.workers.tasks.run_report_task", bind=True, max_retries=2)
def run_report_task(
    self, tenant_id: str, run_id: str, report_type: str, export_format: str
) -> dict[str, Any]:
    tenant_id_ctx.set(tenant_id)

    async def _do() -> dict[str, Any]:
        async with session_scope() as session:
            runs = ReportRunRepo(session, tenant_id)
            run = await runs.get_or_404(run_id)
            try:
                service = ReportService(session, tenant_id)
                payload = await service.build_payload(report_type)
                content = service.render(payload, export_format)
                run.blob_path = await deliver_report(
                    tenant_id, run_id, report_type, export_format, content
                )
                run.state = "completed"
            except Exception as exc:  # noqa: BLE001 - surfaced on the report row
                run.state = "failed"
                run.error = str(exc)[:2000]
                raise
            return {"run_id": run_id, "state": run.state, "path": run.blob_path}

    try:
        return _run(_do())
    except Exception as exc:  # noqa: BLE001
        log.exception("report task failed", extra={"run_id": run_id})
        raise self.retry(exc=exc)


@celery_app.task(name="app.workers.tasks.dispatch_scheduled_reports")
def dispatch_scheduled_reports() -> dict[str, Any]:
    """Enqueue every schedule whose cron expression is due in this hour."""
    now = datetime.now(timezone.utc)

    async def _do() -> int:
        dispatched = 0
        for tenant_id in await _active_tenant_ids():
            async with session_scope() as session:
                schedules = await ReportScheduleRepo(session, tenant_id).list(limit=200)
                for schedule in schedules:
                    if not schedule.enabled or not croniter.is_valid(schedule.cron):
                        continue
                    previous = croniter(schedule.cron, now).get_prev(datetime)
                    if schedule.last_run_at and schedule.last_run_at >= previous:
                        continue
                    run = await ReportRunRepo(session, tenant_id).add(
                        report_type=schedule.report_type,
                        export_format=schedule.export_format,
                        state="queued",
                        requested_by=f"schedule:{schedule.name}",
                    )
                    await session.flush()
                    schedule.last_run_at = now
                    schedule.last_status = "queued"
                    run_report_task.delay(
                        tenant_id,
                        str(run.id),
                        schedule.report_type,
                        schedule.export_format,
                    )
                    dispatched += 1
        return dispatched

    return {"dispatched": _run(_do())}
