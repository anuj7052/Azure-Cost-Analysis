"""
Cross-cutting request handling: correlation, security headers, rate limiting.

These are middleware rather than per-route dependencies on purpose. A route
added next month gets all three without anyone remembering to opt in, which is
the only way a guarantee like "every response has a request id" stays true.
"""
from __future__ import annotations

import logging
import time
import uuid
from collections import deque
from typing import Deque, Dict, Tuple

from fastapi import Request, Response
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

from core.config import settings
from core.errors import ErrorCode, error_body
from core.logging_config import account_id_var, request_id_var

log = logging.getLogger("api.request")


class RequestContextMiddleware(BaseHTTPMiddleware):
    """
    Give every request an id, log its outcome, and hand the id back.

    A client-supplied `X-Request-ID` is honoured so a trace can span the
    frontend and backend, but it is length-capped: it is attacker-controlled
    text that ends up in log lines.
    """

    MAX_CLIENT_ID_LENGTH = 64

    async def dispatch(self, request: Request, call_next):
        incoming = request.headers.get("x-request-id", "")
        request_id = (
            incoming[: self.MAX_CLIENT_ID_LENGTH]
            if incoming
            else uuid.uuid4().hex
        )

        request.state.request_id = request_id
        token = request_id_var.set(request_id)
        account_token = account_id_var.set("")

        started = time.perf_counter()
        try:
            response = await call_next(request)
        except Exception:
            duration_ms = round((time.perf_counter() - started) * 1000, 2)
            log.exception(
                "request failed",
                extra={
                    "method": request.method,
                    "path": request.url.path,
                    "duration_ms": duration_ms,
                },
            )
            raise
        finally:
            request_id_var.reset(token)
            account_id_var.reset(account_token)

        duration_ms = round((time.perf_counter() - started) * 1000, 2)
        response.headers["X-Request-ID"] = request_id

        # The query string is omitted deliberately: it is a common place for a
        # pasted token to appear, and the path alone is enough to trace a route.
        log.info(
            "request",
            extra={
                "method": request.method,
                "path": request.url.path,
                "status_code": response.status_code,
                "duration_ms": duration_ms,
            },
        )
        return response


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """
    Defensive response headers.

    The API serves JSON to a separate frontend origin, so the CSP here is the
    restrictive API-only one. It is not the policy for the frontend host, which
    belongs wherever the SPA is served from.
    """

    BASE_HEADERS = {
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer",
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Resource-Policy": "same-site",
        "Permissions-Policy": "geolocation=(), camera=(), microphone=(), payment=()",
        "Content-Security-Policy": (
            "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
        ),
        # Financial and infrastructure data has no business in a shared cache.
        "Cache-Control": "no-store",
    }

    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)

        for header, value in self.BASE_HEADERS.items():
            response.headers.setdefault(header, value)

        if settings.SECURITY_HEADERS_HSTS:
            response.headers.setdefault(
                "Strict-Transport-Security",
                "max-age=31536000; includeSubDomains",
            )

        return response


class RateLimitMiddleware(BaseHTTPMiddleware):
    """
    A sliding-window limit keyed on the caller.

    This protects Azure as much as it protects us: an uncontrolled client loop
    against a cost endpoint burns the tenant's Cost Management quota, and the
    resulting throttle lands on every other user of that tenant.

    In-process only. It is correct for the single-process deployment that exists
    today and is replaced by a Redis token bucket when the API runs replicated
    (roadmap Stage 3) — a per-replica limit is not a real limit.
    """

    EXEMPT_PATHS = frozenset({"/api/health", "/api/v1/health", "/docs", "/openapi.json", "/redoc"})

    def __init__(self, app):
        super().__init__(app)
        self._hits: Dict[str, Deque[float]] = {}
        self._last_sweep = time.monotonic()

    def _identify(self, request: Request) -> str:
        """
        Prefer the bearer token over the client IP.

        Everything behind a corporate NAT shares one IP, so limiting on address
        alone would let one busy user throttle a whole customer's office.
        The token is hashed to a short prefix — never stored or logged whole.
        """
        auth = request.headers.get("authorization", "")
        if auth.lower().startswith("bearer "):
            token = auth[7:]
            if token:
                import hashlib

                return "t:" + hashlib.sha256(token.encode()).hexdigest()[:32]

        client = request.client
        return f"ip:{client.host}" if client else "ip:unknown"

    def _sweep(self, now: float, window: int) -> None:
        """Drop idle callers so the dict cannot grow without bound."""
        if now - self._last_sweep < window:
            return
        cutoff = now - window
        for key in [k for k, v in self._hits.items() if not v or v[-1] <= cutoff]:
            self._hits.pop(key, None)
        self._last_sweep = now

    async def dispatch(self, request: Request, call_next):
        if not settings.RATE_LIMIT_ENABLED or request.url.path in self.EXEMPT_PATHS:
            return await call_next(request)

        window = settings.RATE_LIMIT_WINDOW_SECONDS
        limit = settings.RATE_LIMIT_REQUESTS
        now = time.monotonic()

        self._sweep(now, window)

        key = self._identify(request)
        hits = self._hits.setdefault(key, deque())
        cutoff = now - window
        while hits and hits[0] <= cutoff:
            hits.popleft()

        if len(hits) >= limit:
            retry_after = max(1, int(window - (now - hits[0])))
            request_id = getattr(request.state, "request_id", "")
            log.warning(
                "rate limit exceeded",
                extra={"path": request.url.path, "limit": limit, "window_seconds": window},
            )
            return JSONResponse(
                status_code=429,
                content=error_body(
                    ErrorCode.RATE_LIMITED,
                    "Too many requests. Slow down and retry shortly.",
                    request_id,
                    {"retry_after_seconds": retry_after, "limit": limit, "window_seconds": window},
                ),
                headers={
                    "Retry-After": str(retry_after),
                    "X-RateLimit-Limit": str(limit),
                    "X-RateLimit-Remaining": "0",
                },
            )

        hits.append(now)
        response = await call_next(request)
        response.headers["X-RateLimit-Limit"] = str(limit)
        response.headers["X-RateLimit-Remaining"] = str(max(0, limit - len(hits)))
        return response
