from __future__ import annotations

import logging
import sys
import uuid
from contextvars import ContextVar

from pythonjsonlogger import jsonlogger

from app.core.config import settings

request_id_ctx: ContextVar[str] = ContextVar("request_id", default="")
tenant_id_ctx: ContextVar[str] = ContextVar("tenant_id", default="")

_REDACT_KEYS = {
    "password",
    "secret",
    "client_secret",
    "authorization",
    "token",
    "access_token",
    "api_key",
    "connection_string",
}


class ContextFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = request_id_ctx.get()
        record.tenant_id = tenant_id_ctx.get()
        return True


def redact(payload: dict) -> dict:
    """Strip secret-looking values before they reach logs or the LLM."""
    return {
        k: ("***" if k.lower() in _REDACT_KEYS else v) for k, v in payload.items()
    }


def new_request_id() -> str:
    return uuid.uuid4().hex


def configure_logging() -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(
        jsonlogger.JsonFormatter(
            "%(asctime)s %(levelname)s %(name)s %(request_id)s %(tenant_id)s %(message)s"
        )
    )
    handler.addFilter(ContextFilter())

    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(settings.LOG_LEVEL.upper())
    logging.getLogger("uvicorn.access").handlers = [handler]
