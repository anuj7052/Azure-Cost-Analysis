from fastapi import APIRouter

from app.api.v1 import boq, costs, inventory, operations, platform, tenancy

api_router = APIRouter()
api_router.include_router(tenancy.router)
api_router.include_router(costs.router)
api_router.include_router(inventory.router)
api_router.include_router(operations.router)
api_router.include_router(platform.router)
api_router.include_router(boq.router)

__all__ = ["api_router"]
