from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.middleware.gzip import GZipMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware

from app.api.v1 import api_router
from app.core.cache import RateLimiter, create_redis
from app.core.config import settings
from app.core.errors import AppError
from app.core.logging import configure_logging, new_request_id, request_id_ctx

log = logging.getLogger(__name__)

SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Permissions-Policy": "geolocation=(), camera=(), microphone=()",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
}


@asynccontextmanager
async def lifespan(app: FastAPI):
    configure_logging()
    app.state.redis = create_redis()
    app.state.rate_limiter = RateLimiter(
        app.state.redis, settings.ASSISTANT_RATE_LIMIT_PER_HOUR
    )
    log.info("api started", extra={"environment": settings.ENVIRONMENT})
    try:
        yield
    finally:
        await app.state.redis.aclose()


app = FastAPI(
    title=settings.APP_NAME,
    version="1.0.0",
    description=(
        "Multi-tenant Azure cloud management API. All endpoints are scoped to the "
        "Entra ID tenant of the caller's access token."
    ),
    docs_url="/docs",
    openapi_url="/openapi.json",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    allow_headers=["Authorization", "Content-Type"],
    max_age=600,
)
app.add_middleware(GZipMiddleware, minimum_size=1024)
if settings.ENVIRONMENT == "production":
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=["*.azurecontainerapps.io"])


@app.middleware("http")
async def request_context(request: Request, call_next):
    request_id = request.headers.get("x-request-id") or new_request_id()
    request_id_ctx.set(request_id)
    started = time.perf_counter()

    response = await call_next(request)

    response.headers["x-request-id"] = request_id
    response.headers["x-response-time-ms"] = f"{(time.perf_counter() - started) * 1000:.1f}"
    for header, value in SECURITY_HEADERS.items():
        response.headers.setdefault(header, value)
    return response


@app.exception_handler(AppError)
async def app_error_handler(_: Request, exc: AppError) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"error": exc.detail})


@app.exception_handler(Exception)
async def unhandled_error_handler(_: Request, exc: Exception) -> JSONResponse:
    log.exception("unhandled error", exc_info=exc)
    return JSONResponse(
        status_code=500,
        content={"error": {"code": "internal_error", "message": "Unexpected error."}},
    )


@app.get("/health", tags=["system"], summary="Liveness probe")
async def health() -> dict[str, str]:
    return {"status": "ok", "environment": settings.ENVIRONMENT}


@app.get("/ready", tags=["system"], summary="Readiness probe")
async def ready(request: Request) -> dict[str, str]:
    await request.app.state.redis.ping()
    return {"status": "ready"}


app.include_router(api_router, prefix=settings.API_V1_PREFIX)
