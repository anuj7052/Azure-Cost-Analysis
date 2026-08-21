"""
Structured logging with secret redaction.

The platform holds Azure access tokens, service principal secrets and customer
API keys. A single `logger.exception()` around the wrong call is enough to write
one into a log aggregator, where it lives far longer than the token does and is
readable by people who were never granted the customer's Azure environment.

So redaction is applied as a logging *filter* rather than at call sites. Call
sites are where the mistake gets made; the filter cannot be forgotten.
"""
from __future__ import annotations

import json
import logging
import re
import sys
from contextvars import ContextVar
from typing import Any, Dict

#: Correlation values for the request being handled, set by middleware.
request_id_var: ContextVar[str] = ContextVar("request_id", default="")
account_id_var: ContextVar[str] = ContextVar("account_id", default="")

# Patterns are deliberately broad. A false positive costs a redacted log line;
# a false negative costs a leaked credential.
_REDACTIONS: list[tuple[re.Pattern[str], str]] = [
    # JWTs — Azure access tokens and our own bearer tokens.
    (re.compile(r"\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*"), "[REDACTED_JWT]"),
    # Authorization headers in any casing.
    (re.compile(r"(?i)\b(bearer)\s+[A-Za-z0-9._\-~+/]{8,}=*"), r"\1 [REDACTED]"),
    # OpenAI / Anthropic style keys.
    (re.compile(r"\bsk-[A-Za-z0-9_\-]{16,}"), "[REDACTED_API_KEY]"),
    # key=value forms for anything that names itself a secret.
    (
        re.compile(
            r"(?i)\b(client_secret|clientsecret|api_key|apikey|access_token|"
            r"refresh_token|password|secret|authorization)\b"
            r"(\s*[=:]\s*)"
            r"[\"']?([^\s,;\"'}\)]{4,})[\"']?"
        ),
        r"\1\2[REDACTED]",
    ),
    # Azure Storage / Service Bus connection strings.
    (re.compile(r"(?i)(SharedAccessKey|AccountKey)=[^;\s]+"), r"\1=[REDACTED]"),
]


def scrub(text: str) -> str:
    """Remove anything that looks like a credential from a string."""
    if not text:
        return text
    for pattern, replacement in _REDACTIONS:
        text = pattern.sub(replacement, text)
    return text


class RedactingFilter(logging.Filter):
    """Scrubs the formatted message and args of every record that passes."""

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            if isinstance(record.msg, str):
                record.msg = scrub(record.msg)

            # Only strings are scrubbed. Coercing every argument would turn an
            # int into "42" and break the `%d` in someone else's format string —
            # which is a real failure this filter caused before it was fixed.
            if record.args:
                if isinstance(record.args, dict):
                    record.args = {
                        k: scrub(v) if isinstance(v, str) else v
                        for k, v in record.args.items()
                    }
                else:
                    record.args = tuple(
                        scrub(a) if isinstance(a, str) else a for a in record.args
                    )
        except Exception:
            # Logging must never be the thing that breaks a request.
            pass
        return True


class ContextFilter(logging.Filter):
    """Attaches the current request's correlation ids to every record."""

    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = request_id_var.get()
        record.account_id = account_id_var.get()
        return True


_STANDARD_ATTRS = set(
    logging.LogRecord("", 0, "", 0, "", (), None).__dict__
) | {"asctime", "message", "request_id", "account_id", "taskName"}


class JsonFormatter(logging.Formatter):
    """
    One JSON object per line.

    Log aggregators can filter on request_id and account_id without parsing
    prose, which is what makes a customer-reported problem traceable to the
    Azure calls that produced it.
    """

    def format(self, record: logging.LogRecord) -> str:
        payload: Dict[str, Any] = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }

        if request_id := getattr(record, "request_id", ""):
            payload["request_id"] = request_id
        if account_id := getattr(record, "account_id", ""):
            payload["account_id"] = account_id

        # Anything passed via `extra=` — scan_id, tenant_id, azure latency.
        for key, value in record.__dict__.items():
            if key not in _STANDARD_ATTRS and not key.startswith("_"):
                payload[key] = value

        if record.exc_info:
            payload["exception"] = scrub(self.formatException(record.exc_info))

        return scrub(json.dumps(payload, default=str))


def configure_logging(level: str = "INFO", json_output: bool = True) -> None:
    """
    Install the root handler. Idempotent, so repeated calls (reload, tests)
    do not stack duplicate handlers.
    """
    root = logging.getLogger()
    for handler in list(root.handlers):
        root.removeHandler(handler)

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(
        JsonFormatter()
        if json_output
        else logging.Formatter(
            "%(asctime)s %(levelname)-7s %(name)s [%(request_id)s] %(message)s"
        )
    )
    handler.addFilter(ContextFilter())
    handler.addFilter(RedactingFilter())

    root.addHandler(handler)
    root.setLevel(level.upper())

    # Access logs duplicate our own request log line, and uvicorn's version has
    # the query string in it — which is where a token pasted into a URL ends up.
    logging.getLogger("uvicorn.access").disabled = True
