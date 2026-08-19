from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
import aiosqlite
from core.config import settings
from core.db import get_db, init_db
from auth.dependencies import get_current_user
from services.user_service import tenant_counts
from routers import (
    admin, tenants, subscriptions, costs, services, upload, bandwidth, boq,
    guide, integrations, orphaned, scans,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    yield


app = FastAPI(
    title="Azure Cost Analysis API",
    version="1.0.0",
    description="Multi-tenant Azure cost tracking and analysis backend",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(tenants.router)
app.include_router(subscriptions.router)
app.include_router(costs.router)
app.include_router(services.router)
app.include_router(upload.router)
app.include_router(bandwidth.router)
app.include_router(boq.router)
app.include_router(admin.router)
app.include_router(guide.router)
app.include_router(integrations.router)
app.include_router(orphaned.router)
app.include_router(scans.router)
app.include_router(scans.search_router)


@app.get("/api/me")
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


@app.get("/api/health")
async def health():
    return {"status": "ok", "version": "1.0.0"}
