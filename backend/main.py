"""
Azure Control & Intelligence Platform — API entry point.

Composition only: configuration, cross-cutting middleware, error handling and
route mounting. Domain logic lives in `services/`, HTTP surfaces in `routers/`.
"""
import logging

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
import aiosqlite

from core.config import production_config_errors, settings
from core.db import get_db, init_db
from core.errors import (
    ApiError,
    api_error_handler,
    http_exception_handler,
    unhandled_exception_handler,
    validation_exception_handler,
)
from core.logging_config import configure_logging
from core.middleware import (
    RateLimitMiddleware,
    RequestContextMiddleware,
    SecurityHeadersMiddleware,
)
from core.versioning import API_V1_PREFIX, LEGACY_SUNSET, register_routers
from auth.dependencies import get_current_user
from services.user_service import tenant_counts
from routers import (
    admin, tenants, subscriptions, costs, services, upload, bandwidth, boq,
    guide, integrations, orphaned, scans, changes, activity, prices,
)

log = logging.getLogger("app")

API_ROUTERS = [
    tenants.router,
    subscriptions.router,
    costs.router,
    services.router,
    upload.router,
    bandwidth.router,
    boq.router,
    admin.router,
    guide.router,
    integrations.router,
    orphaned.router,
    scans.router,
    scans.search_router,
    changes.router,
    activity.router,
    prices.router,
]


def _verify_production_config() -> None:
    """
    Refuse to serve production traffic on development configuration.

    Failing at startup is the point. A default signing key or a plaintext origin
    that survives to runtime is a security defect nobody notices, because
    everything appears to work correctly.
    """
    if not settings.is_production:
        return

    problems = production_config_errors(settings)
    if problems:
        for problem in problems:
            log.critical("Insecure production configuration: %s", problem)
        raise RuntimeError(
            "Refusing to start in production with insecure configuration:\n  - "
            + "\n  - ".join(problems)
        )


@asynccontextmanager
async def lifespan(app: FastAPI):
    configure_logging(json_output=settings.is_production)
    _verify_production_config()
    await init_db()
    log.info("api started", extra={"environment": settings.ENVIRONMENT})
    yield


app = FastAPI(
    title="Azure Control & Intelligence Platform API",
    version="1.1.0",
    description=(
        "Multi-tenant Azure cost, inventory, change and governance backend.\n\n"
        f"Current API: `{API_V1_PREFIX}`. The unversioned `/api` paths are "
        "deprecated aliases retained for the existing frontend."
    ),
    lifespan=lifespan,
)

# Order matters, and Starlette runs the *last* added middleware outermost.
# The intended nesting, outermost first, is:
#
#   SecurityHeaders  -> hardens every response, including ones short-circuited
#                       below it. Registering it innermost meant a rate-limit
#                       rejection came back with no security headers at all.
#   RequestContext   -> assigns the request id, so a rejection is still traceable
#   RateLimit        -> may return early; everything above it still applies
#
# so they are added in reverse of that order.
app.add_middleware(RateLimitMiddleware)
app.add_middleware(RequestContextMiddleware)
app.add_middleware(SecurityHeadersMiddleware)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    # Enumerated rather than "*": a wildcard combined with credentials is the
    # configuration that turns one compromised origin into full account access.
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Request-ID"],
    expose_headers=[
        "X-Request-ID", "X-RateLimit-Limit", "X-RateLimit-Remaining", "Retry-After",
    ],
)

app.add_exception_handler(ApiError, api_error_handler)
app.add_exception_handler(HTTPException, http_exception_handler)
app.add_exception_handler(RequestValidationError, validation_exception_handler)
app.add_exception_handler(Exception, unhandled_exception_handler)

register_routers(app, API_ROUTERS)


@app.middleware("http")
async def mark_legacy_api(request: Request, call_next):
    """Tell callers still on the unversioned paths that they are deprecated."""
    response = await call_next(request)

    path = request.url.path
    if path.startswith("/api/") and not path.startswith(API_V1_PREFIX):
        response.headers["Deprecation"] = "true"
        response.headers["Sunset"] = LEGACY_SUNSET
        response.headers["Link"] = (
            f'<{API_V1_PREFIX}{path[len("/api"):]}>; rel="successor-version"'
        )

    return response


@app.get("/api/me", tags=["account"])
@app.get(f"{API_V1_PREFIX}/me", tags=["account"])
async def me(
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    """
    The signed-in account.

    Drives the admin navigation and decides whether to show onboarding, so it
    also reports how many tenants this account has connected. That count is
    scoped to the account — nobody sees a number that includes someone else's.
    """
    counts = await tenant_counts(db)
    return {
        "id": current_user["account_id"],
        "email": current_user["email"],
        "name": current_user["name"],
        "role": current_user["role"],
        "status": current_user["status"],
        "created_at": current_user["created_at"],
        "is_admin": current_user["role"] == "admin",
        "tenant_count": counts.get(current_user["account_id"], 0),
    }


@app.get("/api/health", tags=["system"])
@app.get(f"{API_V1_PREFIX}/health", tags=["system"])
async def health():
    """Liveness only. Deliberately reveals nothing about configuration."""
    return {"status": "ok", "version": app.version}
