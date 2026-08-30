"""Changing things in Azure, through one door.

This router is the platform surface for write operations added from here on.
It does three things that the older write endpoints each do in their own way:

  * it publishes a catalogue of what this product can change, so the capability
    list is served by the code rather than described in documentation that
    drifts;
  * it records every attempt in one table, so "what has this workspace changed"
    is one query;
  * it accepts an `Idempotency-Key`, so a retried request is not a second
    change.

The older endpoints -- `/api/compute/resize`, `/api/security/access/*`,
`/api/provision/deploy` -- keep working exactly as they did. They are listed in
the catalogue for completeness and were deliberately not rewritten to route
through here: they are covered by their own tests, and moving three working
destructive features at once to prove a pattern is a bad trade.
"""
import logging
from typing import Optional

import aiosqlite
import httpx
from fastapi import APIRouter, Depends, Header, HTTPException

from auth.dependencies import get_current_user, require_workspace_admin
from core.db import get_db
from models.schemas import (
    ActionCatalogueResponse,
    ActionRecord,
    ActionHistoryResponse,
    TagRequest,
)
from services import actions, tagging
from services.token_resolver import authorize_subscriptions, resolve_tenant_token

router = APIRouter(prefix="/api/actions", tags=["actions"])

log = logging.getLogger(__name__)


def _record(row: dict) -> ActionRecord:
    """Turn a stored row into the shape the API returns.

    The JSON columns are parsed here rather than by the client so that a
    malformed record is this server's problem, not the browser's.
    """
    import json

    def parsed(value):
        try:
            return json.loads(value or "{}")
        except (TypeError, ValueError):
            return {}

    return ActionRecord(
        action_id=row["action_id"],
        action=row["action"],
        state=row["state"],
        tenant_id=row["tenant_id"],
        subscription_id=row["subscription_id"] or "",
        resource_id=row["resource_id"] or "",
        resource_name=row["resource_name"] or "",
        resource_kind=row["resource_kind"] or "",
        actor_name=row["actor_name"] or "",
        actor_email=row["actor_email"] or "",
        request=parsed(row["request"]),
        previous_state=parsed(row["previous_state"]),
        new_state=parsed(row["new_state"]),
        failure_reason=row["failure_reason"] or "",
        created_at=row["created_at"],
        completed_at=row["completed_at"],
    )


@router.get("", response_model=ActionCatalogueResponse)
async def list_actions(current_user: dict = Depends(get_current_user)):
    """Everything this platform can change in Azure, including what is switched off.

    Readable by anyone with a seat. Knowing that an action exists is not
    permission to run it, and hiding the list from viewers would only make the
    product harder to understand.
    """
    return ActionCatalogueResponse(
        actions=actions.catalogue(),
        can_run=bool(current_user.get("can_administer")),
    )


@router.get("/history", response_model=ActionHistoryResponse)
async def action_history(
    tenant_id: str,
    limit: int = 50,
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    """This workspace's changes to one tenant, newest first."""
    rows = await actions.history(
        db, current_user["account_id"], tenant_id, min(max(limit, 1), 200)
    )
    return ActionHistoryResponse(items=[_record(r) for r in rows])


@router.get("/{action_id}", response_model=ActionRecord)
async def get_action(
    action_id: str,
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    """One change. Scoped to the workspace, so an id alone reveals nothing."""
    row = await actions.get(db, action_id, current_user["account_id"])
    if row is None:
        raise HTTPException(status_code=404, detail="No such action.")
    return _record(row)


@router.post("/tag", response_model=ActionRecord)
async def tag_resource(
    body: TagRequest,
    idempotency_key: Optional[str] = Header(default=None, alias="Idempotency-Key"),
    current_user: dict = Depends(require_workspace_admin),
    db: aiosqlite.Connection = Depends(get_db),
):
    """Merge tags onto a resource.

    The subscription is checked against the ones this caller's token actually
    holds before Azure is called, so a resource id from another directory is
    refused here rather than probed against ARM.
    """
    spec = actions.get_spec("resource.tag")

    # Checked here, before anything reaches Azure. `execute` checks again, but
    # by then this endpoint has already read the resource's existing tags --
    # and a caller who is not allowed to make the change should not be able to
    # use it to find out what the tags are either.
    try:
        actions.authorize(spec, current_user, confirmed=body.confirmation)
    except actions.ActionError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message)

    problem = tagging.validate_tags(body.tags)
    if problem:
        raise HTTPException(status_code=400, detail=problem)

    token = await resolve_tenant_token(body.tenant_id, current_user, db)

    if body.subscription_id:
        allowed = await authorize_subscriptions(
            token, body.tenant_id, [body.subscription_id]
        )
        if not allowed:
            raise HTTPException(
                status_code=403,
                detail="This account cannot read that subscription.",
            )

    async with httpx.AsyncClient(timeout=tagging.REQUEST_TIMEOUT) as client:
        # Read first, so the record can show what the tags were. A failure here
        # is not fatal: an unreadable previous state is worth noting, not worth
        # refusing a change the caller is entitled to make.
        previous, read_error = await tagging.read_tags(client, token, body.resource_id)
        if read_error:
            log.info("Could not read existing tags for %s: %s",
                     body.resource_id, read_error)

        async def run():
            ok, message, applied = await tagging.apply_tags(
                client, token, body.resource_id, body.tags
            )
            if not ok:
                raise HTTPException(status_code=502, detail=message)
            return {"tags": applied or {**previous, **body.tags}}

        try:
            row = await actions.execute(
                db,
                spec=spec,
                user=current_user,
                tenant_id=body.tenant_id,
                run=run,
                confirmed=body.confirmation,
                subscription_id=body.subscription_id,
                resource_id=body.resource_id,
                resource_name=body.resource_name,
                resource_kind=body.resource_kind,
                request={"tags": body.tags},
                previous_state={"tags": previous},
                idempotency_key=idempotency_key,
            )
        except actions.ActionError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.message)

    return _record(row)
