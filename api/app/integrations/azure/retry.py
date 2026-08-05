from __future__ import annotations

import asyncio
import functools
import logging
import random
from typing import Any, Awaitable, Callable, TypeVar

from azure.core.exceptions import (
    HttpResponseError,
    ServiceRequestError,
    ServiceResponseError,
)

from app.core.config import settings
from app.core.errors import AzureIntegrationError

log = logging.getLogger(__name__)
T = TypeVar("T")

RETRYABLE_STATUS = {408, 429, 500, 502, 503, 504}


def _retry_after(exc: HttpResponseError) -> float | None:
    response = getattr(exc, "response", None)
    headers = getattr(response, "headers", None) or {}
    value = headers.get("Retry-After") or headers.get("retry-after")
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def with_retry(
    max_attempts: int | None = None,
) -> Callable[[Callable[..., Awaitable[T]]], Callable[..., Awaitable[T]]]:
    """Retry Azure calls on throttling/transient failures.

    Honours `Retry-After`; otherwise exponential backoff with full jitter.
    """
    attempts = max_attempts or settings.AZURE_MAX_RETRIES

    def decorator(func: Callable[..., Awaitable[T]]) -> Callable[..., Awaitable[T]]:
        @functools.wraps(func)
        async def wrapper(*args: Any, **kwargs: Any) -> T:
            last: Exception | None = None
            for attempt in range(1, attempts + 1):
                try:
                    return await func(*args, **kwargs)
                except HttpResponseError as exc:
                    if exc.status_code not in RETRYABLE_STATUS or attempt == attempts:
                        raise AzureIntegrationError(
                            f"{func.__name__} failed: {exc.status_code} {exc.reason}"
                        ) from exc
                    delay = _retry_after(exc) or min(2**attempt, 60) * random.random()
                    log.warning(
                        "azure call throttled, retrying",
                        extra={"op": func.__name__, "attempt": attempt, "delay": delay},
                    )
                    await asyncio.sleep(delay)
                    last = exc
                except (ServiceRequestError, ServiceResponseError, asyncio.TimeoutError) as exc:
                    if attempt == attempts:
                        raise AzureIntegrationError(
                            f"{func.__name__} failed after {attempts} attempts"
                        ) from exc
                    await asyncio.sleep(min(2**attempt, 30) * random.random())
                    last = exc
            raise AzureIntegrationError(str(last) if last else "unknown Azure failure")

        return wrapper

    return decorator
