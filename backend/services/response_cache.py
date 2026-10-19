"""Shared cache for finished API responses.

The Azure query cache (services/cost_cache.py) stores raw Cost Management
pages, but every request still re-ran the merging and analysis on top of them,
and Resource Graph / Monitor reads were not cached at all. This caches the
finished JSON instead, so a repeat visit is answered in milliseconds.

Backend:
- Redis when REDIS_URL is set (shared across workers, instances and restarts).
- Otherwise an in-process TTL cache, so nothing breaks without Redis.

Safety:
- Keys include the workspace, the signed-in person and the full request body,
  so one user never sees another user's results, and Azure permissions that
  differ between people are respected.
- Partial answers (any subscription failed) are never cached, so a temporary
  Azure error cannot stick.
- Send the header `X-Refresh: 1` to bypass the cache and store a fresh answer.
"""
from __future__ import annotations

import functools
import hashlib
import inspect
import json
import logging
import time
from collections import OrderedDict
from contextvars import ContextVar
from datetime import date, timedelta
from typing import Any, Awaitable, Callable

from fastapi.encoders import jsonable_encoder

from core.config import settings

log = logging.getLogger(__name__)

VERSION = "v1"
OPEN_TTL = 5 * 60          # selection still being billed
SETTLED_TTL = 6 * 60 * 60  # every day selected ended more than 3 days ago
MEMORY_LIMIT = 300

# Set per request by the middleware in main.py from the X-Refresh header.
refresh_requested: ContextVar[bool] = ContextVar("refresh_requested", default=False)

_memory: "OrderedDict[str, tuple[float, str]]" = OrderedDict()
_redis = None
_redis_failed_at = 0.0


def _client():
    """Lazily connect to Redis; back off for a minute after a failure."""
    global _redis, _redis_failed_at
    url = getattr(settings, "REDIS_URL", "") or ""
    if not url or time.monotonic() - _redis_failed_at < 60:
        return None
    if _redis is None:
        try:
            import redis.asyncio as redis
            _redis = redis.from_url(url, socket_timeout=2, socket_connect_timeout=2, decode_responses=True)
        except Exception as exc:  # pragma: no cover - import/config failure
            log.warning("Redis unavailable, using in-process cache: %s", exc)
            _redis_failed_at = time.monotonic()
            return None
    return _redis


def _drop_redis(exc: Exception) -> None:
    global _redis, _redis_failed_at
    log.warning("Redis error, falling back to in-process cache for 60s: %s", exc)
    _redis, _redis_failed_at = None, time.monotonic()


def backend_name() -> str:
    return "redis" if _client() is not None else "memory"


def make_key(namespace: str, user: dict, body: Any) -> str:
    who = f"{user.get('account_id', '')}:{user.get('actor_id', user.get('user_id', ''))}"
    payload = json.dumps(jsonable_encoder(body), sort_keys=True, default=str)
    digest = hashlib.sha256(f"{who}|{payload}".encode()).hexdigest()[:40]
    return f"resp:{VERSION}:{namespace}:{digest}"


def ttl_for(body: Any) -> int:
    """Longer for periods that are fully billed; short while still open."""
    to_date = getattr(body, "to_date", None) or (body.get("to_date") if isinstance(body, dict) else None)
    try:
        if to_date and date.fromisoformat(str(to_date)[:10]) < date.today() - timedelta(days=3):
            return SETTLED_TTL
    except ValueError:
        pass
    return OPEN_TTL


def cacheable(result: Any) -> bool:
    """Never keep an answer that some subscription failed to contribute to."""
    if not isinstance(result, dict):
        return True
    if result.get("errors"):
        return False
    coverage = result.get("coverage") or {}
    return not (isinstance(coverage, dict) and coverage.get("partial"))


async def get(key: str) -> Any | None:
    client = _client()
    if client is not None:
        try:
            raw = await client.get(key)
            return json.loads(raw) if raw else None
        except Exception as exc:
            _drop_redis(exc)
    hit = _memory.get(key)
    if not hit:
        return None
    expires, raw = hit
    if expires < time.monotonic():
        _memory.pop(key, None)
        return None
    _memory.move_to_end(key)
    return json.loads(raw)


async def set(key: str, value: Any, ttl: int) -> None:  # noqa: A001 - mirrors the Redis verb
    raw = json.dumps(value, default=str)
    client = _client()
    if client is not None:
        try:
            await client.set(key, raw, ex=ttl)
            return
        except Exception as exc:
            _drop_redis(exc)
    _memory[key] = (time.monotonic() + ttl, raw)
    _memory.move_to_end(key)
    while len(_memory) > MEMORY_LIMIT:
        _memory.popitem(last=False)


def clear_memory() -> None:
    _memory.clear()


def cached_endpoint(namespace: str, ttl: int | Callable[[Any], int] | None = None):
    """
    Wrap a POST handler that takes `body` and `current_user`.

    FastAPI reads the wrapped signature, so dependencies are unchanged. The
    X-Refresh header (read by middleware into `refresh_requested`) bypasses the
    cached copy and stores the fresh answer.
    """
    def decorate(handler: Callable[..., Awaitable[Any]]):
        signature = inspect.signature(handler)

        @functools.wraps(handler)
        async def wrapper(*args, **kwargs):
            bound = signature.bind_partial(*args, **kwargs).arguments
            body = bound.get("body")
            user = bound.get("current_user") or {}
            if body is None or not isinstance(user, dict):
                return await handler(*args, **kwargs)
            refresh = refresh_requested.get()
            key = make_key(namespace, user, body)
            if not refresh:
                hit = await get(key)
                if hit is not None:
                    return hit
            result = await handler(*args, **kwargs)
            encoded = jsonable_encoder(result)
            if cacheable(encoded):
                await set(key, encoded, ttl(body) if callable(ttl) else (ttl or ttl_for(body)))
            return result
        return wrapper
    return decorate
