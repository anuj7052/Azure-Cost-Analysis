"""
Per-account integrations: the endpoints, models and keys a customer brings
themselves.

Every route is scoped to the signed-in account, so one customer can neither
list nor edit another's endpoints even by guessing an id.
"""

from typing import List

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException

from auth.dependencies import get_current_user, require_workspace_admin
from core.db import get_db
from models.schemas import (
    CreateIntegrationRequest,
    Integration,
    UpdateIntegrationRequest,
)
from services import integration_service

router = APIRouter(prefix="/api/integrations", tags=["integrations"])


@router.get("", response_model=List[Integration])
async def list_integrations(
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    return await integration_service.list_integrations(db, current_user["account_id"])


@router.post(
    "", response_model=Integration, status_code=201,
    dependencies=[Depends(require_workspace_admin)],
)
async def create_integration(
    body: CreateIntegrationRequest,
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    try:
        return await integration_service.create_integration(
            db, current_user["account_id"], body.model_dump()
        )
    except aiosqlite.IntegrityError:
        raise HTTPException(
            status_code=409,
            detail=f'You already have an integration named "{body.label}".',
        )
    except ValueError as exc:
        # The daily limit is a required answer, not a field with a default.
        raise HTTPException(status_code=400, detail=str(exc)) from None


@router.patch(
    "/{integration_id}", response_model=Integration,
    dependencies=[Depends(require_workspace_admin)],
)
async def update_integration(
    integration_id: int,
    body: UpdateIntegrationRequest,
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    try:
        updated = await integration_service.update_integration(
            db, current_user["account_id"], integration_id, body.model_dump(exclude_unset=True)
        )
    except aiosqlite.IntegrityError:
        raise HTTPException(status_code=409, detail="That name is already in use.")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    if updated is None:
        raise HTTPException(status_code=404, detail="Integration not found.")
    return updated


@router.delete(
    "/{integration_id}", status_code=204,
    dependencies=[Depends(require_workspace_admin)],
)
async def delete_integration(
    integration_id: int,
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    if not await integration_service.delete_integration(
        db, current_user["account_id"], integration_id
    ):
        raise HTTPException(status_code=404, detail="Integration not found.")
