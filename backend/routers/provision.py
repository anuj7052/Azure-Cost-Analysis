"""
Build Azure resources from the assistant, on the signed-in user's own rights.

Two routes matter here and they are deliberately different.

`/chat` talks to a language model and produces a draft. It costs the customer
model credits, so it spends one unit of the daily limit they set on their own
endpoint before the request goes out.

`/deploy` creates resources and starts a monthly charge. It takes a
specification, not a sentence; it requires an explicit confirmation flag; it is
refused for team members, who have view access rather than the owner's rights;
and it runs entirely on the caller's delegated Azure token, so Azure's own RBAC
decides whether it is allowed. Nothing here elevates anybody.
"""

import asyncio
import logging
from typing import Any, Dict, List, Optional

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from auth.dependencies import get_current_user, require_workspace_admin
from core.db import DB_PATH
from core.db import get_db
from models.schemas import (
    ProvisionChatRequest,
    ProvisionChatResponse,
    ProvisionDeployRequest,
    ProvisionDeployment,
)
from services import integration_service, provision_service
from services.azure_errors import azure_error
from services.provision_chat_service import ProvisionChatService
from services.token_resolver import resolve_tenant_token

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/provision", tags=["provision"])

POLL_INTERVAL_SECONDS = 10.0
POLL_TIMEOUT_SECONDS = 1800.0


@router.get("/catalog")
async def catalog(current_user: dict = Depends(get_current_user)):
    """What the assistant can build, and what each resource needs to be built."""
    return {"resources": provision_service.describe_catalog()}


@router.post("/chat", response_model=ProvisionChatResponse)
async def chat(
    body: ProvisionChatRequest,
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    llm = await integration_service.llm_config(db, current_user["account_id"])
    try:
        # Charged before the call, not after: a request the provider billed
        # for and then failed still used the customer's allowance.
        await integration_service.consume(
            db, llm.get("integration_id"), llm.get("source", "your endpoint")
        )
    except integration_service.RateLimitExceeded as exc:
        raise HTTPException(status_code=429, detail=str(exc)) from None

    service = ProvisionChatService(
        location=body.location, currency=body.currency, llm=llm
    )
    result = await service.chat(body.message, body.history)
    return {
        "answer": result["answer"],
        "used_tools": result["used_tools"],
        "drafts": result["drafts"],
        "model_source": llm.get("source", ""),
    }


@router.post(
    "/deploy",
    response_model=ProvisionDeployment,
    status_code=202,
    dependencies=[Depends(require_workspace_admin)],
)
async def deploy(
    body: ProvisionDeployRequest,
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    if not body.confirm:
        raise HTTPException(
            status_code=400,
            detail="This request creates resources and was not confirmed.",
        )
    if not body.resources:
        raise HTTPException(status_code=400, detail="Nothing was selected to create.")

    # Re-draft server-side from the raw fields. The browser sends what the
    # person reviewed, but the specification that reaches Azure is rebuilt and
    # re-validated here, so an edited payload cannot smuggle in a field the
    # catalogue does not allow.
    specs: List[Dict[str, Any]] = []
    try:
        for item in body.resources:
            spec = provision_service.draft(item.kind, item.fields)
            if not spec["ready"]:
                missing = ", ".join(f["label"] for f in spec["missing"])
                raise HTTPException(
                    status_code=400,
                    detail=f"{spec['label']} is missing: {missing}.",
                )
            specs.append(spec)
        template = provision_service.build_template(
            specs, body.location, body.ssh_public_key
        )
    except provision_service.ProvisionError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from None

    token = await resolve_tenant_token(body.tenant_id, current_user, db)

    estimated = 0.0
    priced_any = False
    for spec in specs:
        price = await provision_service.estimate_monthly(spec, body.location, body.currency)
        if price.get("monthly") is not None:
            estimated += float(price["monthly"])
            priced_any = True

    record = await provision_service.record(
        db, current_user["account_id"], current_user.get("actor_id"),
        body.tenant_id, body.subscription_id, body.resource_group, body.location,
        specs, estimated if priced_any else None, body.currency,
    )

    try:
        await provision_service.ensure_resource_group(
            token, body.subscription_id, body.resource_group, body.location
        )
        await provision_service.validate(
            token, body.subscription_id, body.resource_group,
            record["deployment_name"], template,
        )
    except provision_service.ProvisionError as exc:
        await provision_service.set_state(db, record["id"], provision_service.FAILED, exc.message)
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from None
    except Exception as exc:
        await provision_service.set_state(
            db, record["id"], provision_service.FAILED, "Azure could not be reached."
        )
        raise azure_error(exc, "Azure")

    try:
        await provision_service.start_deployment(
            token, body.subscription_id, body.resource_group,
            record["deployment_name"], template,
        )
    except provision_service.ProvisionError as exc:
        await provision_service.set_state(db, record["id"], provision_service.FAILED, exc.message)
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from None

    await provision_service.set_state(db, record["id"], provision_service.CREATING)

    # This connection closes with the request; a deployment outlives it.
    asyncio.create_task(
        _watch(record["id"], token, body.subscription_id, body.resource_group,
               record["deployment_name"])
    )

    created = await provision_service.get_deployment(db, current_user["account_id"], record["id"])
    return created


async def _watch(
    deployment_id: str, token: str, subscription_id: str,
    resource_group: str, deployment_name: str,
) -> None:
    """Follow Azure until it settles, writing each verdict to the database."""
    waited = 0.0
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        while waited < POLL_TIMEOUT_SECONDS:
            await asyncio.sleep(POLL_INTERVAL_SECONDS)
            waited += POLL_INTERVAL_SECONDS
            try:
                state, message, resources = await provision_service.deployment_status(
                    token, subscription_id, resource_group, deployment_name
                )
            except Exception:
                log.warning("Could not read deployment %s", deployment_name, exc_info=True)
                continue
            if state in provision_service.TERMINAL_STATES:
                await provision_service.set_state(db, deployment_id, state, message, resources)
                return
        # Timing out is reported as exactly that. The deployment may still be
        # running in Azure, and saying it failed would be a claim we cannot
        # support.
        await provision_service.set_state(
            db, deployment_id, provision_service.CREATING,
            "Still running after 30 minutes. Check the deployment in the Azure portal.",
        )


@router.get("/deployments", response_model=List[ProvisionDeployment])
async def list_deployments(
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    return await provision_service.list_deployments(db, current_user["account_id"])


@router.get("/deployments/{deployment_id}", response_model=ProvisionDeployment)
async def get_deployment(
    deployment_id: str,
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    found = await provision_service.get_deployment(
        db, current_user["account_id"], deployment_id
    )
    if found is None:
        raise HTTPException(status_code=404, detail="Deployment not found.")
    return found
