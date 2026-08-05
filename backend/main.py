from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
from core.config import settings
from core.db import init_db
from routers import tenants, subscriptions, costs, services, upload, bandwidth, boq


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


@app.get("/api/health")
async def health():
    return {"status": "ok", "version": "1.0.0"}
