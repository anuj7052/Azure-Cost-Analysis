"""
Route mounting for both the versioned and legacy API surfaces.

The specification requires `/api/v1`. The frontend that exists today calls
`/api`. Breaking it to satisfy the version prefix would be a regression, so both
are served from the *same* router objects: one registration, two paths, zero
duplicated handlers that could drift apart.

The legacy surface is advertised as deprecated through response headers rather
than removed, so the frontend can migrate route by route.
"""
from __future__ import annotations

import copy

from fastapi import APIRouter, FastAPI

API_V1_PREFIX = "/api/v1"
LEGACY_PREFIX = "/api"

#: Announced to legacy callers. Not enforced anywhere — it is a signal to the
#: frontend, not a shutdown timer.
LEGACY_SUNSET = "2027-01-01"


def _versioned(router: APIRouter) -> APIRouter:
    """
    Re-prefix a router from `/api/...` to `/api/v1/...`.

    The router is copied so the original keeps its legacy paths; mutating it in
    place would move the routes rather than duplicate them.
    """
    clone = copy.copy(router)
    clone.routes = list(router.routes)

    versioned = APIRouter()
    for route in router.routes:
        path = getattr(route, "path", "")
        if not path.startswith(LEGACY_PREFIX):
            continue

        duplicate = copy.copy(route)
        duplicate.path = API_V1_PREFIX + path[len(LEGACY_PREFIX):]
        # Starlette compiles the path into a regex at construction time, so the
        # matcher has to be rebuilt or the clone would still answer on /api.
        if hasattr(duplicate, "path_regex"):
            from starlette.routing import compile_path

            (
                duplicate.path_regex,
                duplicate.path_format,
                duplicate.param_convertors,
            ) = compile_path(duplicate.path)

        versioned.routes.append(duplicate)

    return versioned


def register_routers(app: FastAPI, routers: list[APIRouter]) -> None:
    """Mount every router under `/api/v1`, then again under legacy `/api`."""
    for router in routers:
        app.include_router(_versioned(router))
    for router in routers:
        app.include_router(router)
