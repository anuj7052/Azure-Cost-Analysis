from __future__ import annotations

from celery import Celery
from celery.schedules import crontab

from app.core.config import settings

celery_app = Celery(
    "cloudinsight",
    broker=settings.CELERY_BROKER_URL,
    backend=settings.CELERY_RESULT_BACKEND,
    include=["app.workers.tasks"],
)

celery_app.conf.update(
    task_acks_late=True,
    task_reject_on_worker_lost=True,
    task_time_limit=1800,
    task_soft_time_limit=1500,
    worker_prefetch_multiplier=1,
    worker_max_tasks_per_child=100,
    result_expires=3600,
    timezone="UTC",
    beat_schedule={
        "sync-inventory": {
            "task": "app.workers.tasks.schedule_all_tenants",
            "schedule": crontab(minute=f"*/{settings.SYNC_INVENTORY_MINUTES}"),
            "args": ("inventory",),
        },
        "sync-metrics": {
            "task": "app.workers.tasks.schedule_all_tenants",
            "schedule": crontab(minute=f"*/{settings.SYNC_METRICS_MINUTES}"),
            "args": ("metrics",),
        },
        "sync-cost": {
            "task": "app.workers.tasks.schedule_all_tenants",
            "schedule": crontab(hour=2, minute=0),
            "args": ("cost",),
        },
        "sync-activity": {
            "task": "app.workers.tasks.schedule_all_tenants",
            "schedule": crontab(hour="*/6", minute=10),
            "args": ("activity",),
        },
        "sync-security": {
            "task": "app.workers.tasks.schedule_all_tenants",
            "schedule": crontab(hour=3, minute=0),
            "args": ("security",),
        },
        "sync-recommendations": {
            "task": "app.workers.tasks.schedule_all_tenants",
            "schedule": crontab(hour=4, minute=0),
            "args": ("recommendations",),
        },
        "evaluate-alerts": {
            "task": "app.workers.tasks.evaluate_alerts_all_tenants",
            "schedule": crontab(minute="*/20"),
        },
        "scheduled-reports": {
            "task": "app.workers.tasks.dispatch_scheduled_reports",
            "schedule": crontab(minute=0),
        },
    },
)
