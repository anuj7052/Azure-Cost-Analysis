from __future__ import annotations

import logging
import smtplib
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from pathlib import Path

from azure.identity.aio import DefaultAzureCredential
from azure.storage.blob.aio import BlobServiceClient

from app.core.config import settings

log = logging.getLogger(__name__)

_EXTENSIONS = {"pdf": "pdf", "excel": "xlsx", "csv": "csv"}
_CONTENT_TYPES = {
    "pdf": "application/pdf",
    "excel": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "csv": "text/csv",
}


async def deliver_report(
    tenant_id: str,
    run_id: str,
    report_type: str,
    export_format: str,
    content: bytes,
) -> str:
    """Upload the rendered report and return its storage path.

    Reports are written to Blob Storage under a tenant-prefixed path; the API
    hands out short-lived, user-delegated SAS links rather than streaming bytes
    through the request path.
    """
    extension = _EXTENSIONS[export_format]
    blob_name = (
        f"{tenant_id}/{datetime.now(timezone.utc):%Y/%m}/"
        f"{report_type}-{run_id}.{extension}"
    )

    if not settings.REPORTS_STORAGE_ACCOUNT_URL:
        local = Path("./data/reports") / blob_name
        local.parent.mkdir(parents=True, exist_ok=True)
        local.write_bytes(content)
        log.info("report written locally", extra={"path": str(local)})
        return str(local)

    credential = DefaultAzureCredential()
    try:
        async with BlobServiceClient(
            settings.REPORTS_STORAGE_ACCOUNT_URL, credential=credential
        ) as service:
            container = service.get_container_client(settings.REPORTS_CONTAINER)
            await container.upload_blob(
                name=blob_name,
                data=content,
                overwrite=True,
                content_type=_CONTENT_TYPES[export_format],
            )
    finally:
        await credential.close()
    return blob_name


def send_email(recipients: list[str], subject: str, body: str) -> None:
    if not settings.SMTP_HOST or not recipients:
        log.info("email delivery skipped (SMTP not configured)")
        return

    message = EmailMessage()
    message["From"] = settings.SMTP_FROM
    message["To"] = ", ".join(recipients)
    message["Subject"] = subject
    message.set_content(body)

    with smtplib.SMTP(settings.SMTP_HOST, settings.SMTP_PORT, timeout=30) as smtp:
        smtp.starttls()
        if settings.SMTP_USER:
            smtp.login(settings.SMTP_USER, settings.SMTP_PASSWORD)
        smtp.send_message(message)


def sas_expiry() -> datetime:
    return datetime.now(timezone.utc) + timedelta(minutes=15)
