"""
Azure Control & Intelligence Platform — API entry point.

Composition only: configuration, cross-cutting middleware, error handling and
route mounting. Domain logic lives in `services/`, HTTP surfaces in `routers/`.
"""
import logging

from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
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
from models.schemas import ProfileUpdate
from routers import (
    admin, tenants, subscriptions, costs, services, upload, bandwidth, boq,
    guide, integrations, orphaned, scans, changes, activity, prices, security,
    compute, anomalies, team, provision,
)

log = logging.getLogger("app")

API_ROUTERS = [
    tenants.router,
    subscriptions.router,
    costs.router,
    anomalies.router,
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
    security.router,
    compute.router,
    team.router,
    provision.router,
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
    title="Cloudledger API",
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
    # X-Graph-Token carries a Microsoft Graph credential used only to look up
    # directory names. Omitting it here makes the browser strip the header on a
    # cross-origin request, and account names silently fall back to object ids.
    #
    # X-Azure-Token carries the delegated ARM credential. Omitting it would be
    # worse than the Graph case: the browser strips it silently, the request
    # still authenticates, and every Azure read then fails as though the user
    # had lost access to their own subscriptions.
    allow_headers=[
        "Authorization", "Content-Type", "X-Request-ID",
        "X-Graph-Token", "X-Azure-Token",
    ],
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
    async with db.execute(
        "SELECT phone, login_count FROM users WHERE id = ?", (current_user["actor_id"],)
    ) as cursor:
        profile = await cursor.fetchone()

    owner_email = current_user["email"]
    if not current_user["is_owner"]:
        async with db.execute(
            "SELECT email FROM users WHERE id = ?", (current_user["account_id"],)
        ) as cursor:
            row = await cursor.fetchone()
        owner_email = row["email"] if row else ""

    return {
        "id": current_user["actor_id"],
        "workspace_id": current_user["account_id"],
        "email": current_user["email"],
        "name": current_user["name"],
        "phone": (profile["phone"] if profile else "") or "",
        "login_count": (profile["login_count"] if profile else 0) or 0,
        "role": current_user["role"],
        "status": current_user["status"],
        "created_at": current_user["created_at"],
        "is_admin": current_user["role"] == "admin",
        # What the person sees in the account menu. "Administrator" is the
        # platform-wide role that opens the admin centre; everyone else is
        # "Standard", whether they own a workspace or were invited into one.
        "access_level": "Administrator" if current_user["role"] == "admin" else "Standard",
        "is_owner": current_user["is_owner"],
        # What they may do inside *this* workspace. Separate from the two above
        # on purpose: "administrator of this workspace" and "administrator of
        # the whole installation" are different powers and must not be read off
        # the same field.
        "workspace_role": current_user["workspace_role"],
        "workspace_access": (
            "Owner" if current_user["is_owner"]
            else ("Administrator" if current_user["can_administer"] else "User")
        ),
        "can_administer": current_user["can_administer"],
        "owner_email": owner_email,
        "tenant_count": counts.get(current_user["account_id"], 0),
    }


@app.patch("/api/me", tags=["account"])
@app.patch(f"{API_V1_PREFIX}/me", tags=["account"])
async def update_me(
    body: ProfileUpdate,
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    """
    Update the parts of the profile this app owns.

    Name, email and tenant come from Entra and are refreshed from the token on
    every request, so they are deliberately not editable here -- an edit would
    be silently overwritten on the next call. The phone number has no source
    other than the person themselves.
    """
    if body.phone is None:
        raise HTTPException(status_code=400, detail="Nothing to update.")

    await db.execute(
        "UPDATE users SET phone = ? WHERE id = ?",
        (body.phone, current_user["actor_id"]),
    )
    await db.commit()
    return await me(current_user=current_user, db=db)


@app.get("/api/health", tags=["system"])
@app.get(f"{API_V1_PREFIX}/health", tags=["system"])
async def health():
    """Liveness only. Deliberately reveals nothing about configuration."""
    return {"status": "ok", "version": app.version}


# ─────────────────────────────────────────────────────────────────────────────
# Built frontend
#
# The single-page app is served by this same process rather than from a
# separate host. That is not only about saving a resource: the browser client
# calls `/api/v1/...` as a relative path, so sharing an origin means the
# production wiring is identical to the development proxy. Splitting the two
# would require a cross-origin base URL, a CORS allow-list that has to be kept
# in step with it, and a second redirect URI on the app registration -- three
# things to get wrong in exchange for nothing this deployment needs.
#
# Mounted last so every API route is matched first, and only when a build is
# actually present, so local development and the test suite are untouched.
# ─────────────────────────────────────────────────────────────────────────────
_FRONTEND_DIR = Path(__file__).resolve().parent / "static"

if (_FRONTEND_DIR / "index.html").is_file():
    app.mount(
        "/assets",
        StaticFiles(directory=_FRONTEND_DIR / "assets"),
        name="assets",
    )

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa(full_path: str):
        """
        Hand any non-API path back to the SPA so client-side routes survive a
        refresh. Without this, reloading on /anomalies asks the server for a
        file that was never built and gets a 404 -- the page works until the
        moment someone bookmarks it.

        An unmatched /api path must still 404 as an API, not silently return
        HTML, or a typo in a route reads as a JSON parse error in the client.
        """
        if full_path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Not found")

        # Serve a real file when one exists (favicon, manifest, robots), and
        # fall back to the shell for everything else. `resolve()` plus the
        # prefix check is what stops `../` in the URL reaching outside the
        # build directory.
        candidate = (_FRONTEND_DIR / full_path).resolve()
        if (
            full_path
            and candidate.is_file()
            and str(candidate).startswith(str(_FRONTEND_DIR))
        ):
            return FileResponse(candidate)

        return FileResponse(_FRONTEND_DIR / "index.html")
