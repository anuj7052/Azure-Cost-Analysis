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
    ElevateAccessRequest,
    RemoveElevationRequest,
    SnapshotRequest,
    TagRequest,
)
from services import actions, disk_ops, elevate_access, tagging
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


@router.post("/disk/snapshot", response_model=ActionRecord)
async def snapshot_disk(
    body: SnapshotRequest,
    idempotency_key: Optional[str] = Header(default=None, alias="Idempotency-Key"),
    current_user: dict = Depends(require_workspace_admin),
    db: aiosqlite.Connection = Depends(get_db),
):
    """Copy a disk, so that deleting it stops meaning losing it.

    The savings panel names unattached disks and cannot act on them, because
    the only action that would act on them is the one marked irreversible. This
    is the step that changes that, and it is the reason it is worth having on
    its own: a snapshot taken and never used costs a few pence, and a disk kept
    for years because nobody dared delete it costs a great deal more.
    """
    spec = actions.get_spec("disk.snapshot")

    # Checked before Azure is touched. `execute` checks again, but by then this
    # endpoint has already read the disk -- and a caller who may not make the
    # change should not be able to use it to find out the disk's size or SKU.
    try:
        actions.authorize(spec, current_user, confirmed=True)
    except actions.ActionError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message)

    parts = disk_ops.parse_disk_id(body.resource_id)
    if not parts:
        # Named for what it is. "Not a managed disk" is something the caller can
        # act on; a 404 from ARM three calls later is not.
        raise HTTPException(
            status_code=400,
            detail="That resource is not a managed disk, so it cannot be snapshotted.",
        )

    subscription_id = body.subscription_id or parts["sub"]
    token = await resolve_tenant_token(body.tenant_id, current_user, db)

    allowed = await authorize_subscriptions(token, body.tenant_id, [subscription_id])
    if not allowed:
        raise HTTPException(
            status_code=403, detail="This account cannot read that subscription."
        )

    async with httpx.AsyncClient(timeout=disk_ops.REQUEST_TIMEOUT) as client:
        # Unlike the tag path, a failure to read here IS fatal. Tags have a
        # sensible empty previous state; a disk does not have a sensible
        # unknown region, and a snapshot cannot be created without one.
        disk, read_error = await disk_ops.read_disk(client, token, body.resource_id)
        if read_error:
            raise HTTPException(status_code=502, detail=read_error)

        previous = disk_ops.describe(disk)
        name = disk_ops.snapshot_name(previous.get("name") or parts["name"])

        async def run():
            ok, message, snapshot = await disk_ops.create_snapshot(
                client,
                token,
                disk=disk,
                disk_id=body.resource_id,
                name=name,
            )
            if not ok:
                raise HTTPException(status_code=502, detail=message)
            return snapshot

        try:
            row = await actions.execute(
                db,
                spec=spec,
                user=current_user,
                tenant_id=body.tenant_id,
                run=run,
                confirmed=True,
                subscription_id=subscription_id,
                resource_id=body.resource_id,
                resource_name=body.resource_name or previous.get("name") or "",
                resource_kind="Microsoft.Compute/disks",
                request={"snapshot_name": name},
                previous_state=previous,
                idempotency_key=idempotency_key,
            )
        except actions.ActionError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.message)

    return _record(row)


def _own_tenant_token(body_tenant_id: str, current_user: dict) -> str:
    """The caller's own ARM token, refusing any tenant that is not theirs.

    Elevation is the one write in this router that must not go through
    `resolve_tenant_token`. That resolver is built to find *any* usable
    credential for a tenant, including a stored service principal -- and a
    service principal is exactly the wrong identity here. Azure permits this
    call only for Global Administrators, which is a directory role a service
    principal cannot hold; and if one somehow could, the elevation would land
    on the service principal rather than on the person who asked for it.
    Either outcome is worse than a refusal.

    The tenant is checked against the token's own `tid` for the same reason.
    Elevation applies to the directory you are signed in to and to no other, so
    a request naming a tenant connected by some other credential is not a
    narrower version of this operation -- it is a different one that does not
    exist.
    """
    signed_in = current_user.get("tenant_id") or ""
    if body_tenant_id and signed_in and body_tenant_id != signed_in:
        raise HTTPException(
            status_code=400,
            detail=(
                "Elevation applies only to the tenant you are signed in to. "
                "Sign in with an account in that tenant and try again."
            ),
        )
    token = current_user.get("azure_token") or ""
    if not token:
        raise HTTPException(
            status_code=401, detail="No Azure session to elevate. Sign in again."
        )
    return token


@router.get("/access/elevation")
async def elevation_status(
    tenant_id: str = "",
    current_user: dict = Depends(get_current_user),
):
    """Whether the caller currently holds root-scope access, asked of Azure.

    Read live rather than remembered. An elevation can be removed from the
    portal, from the CLI, or by somebody else holding the same rights, so a
    stored answer would be a guess about the present dressed as a fact -- and
    this is not a fact worth being wrong about.

    Deliberately not admin-gated. Knowing whether you are elevated is how a
    person finds out why their subscription list is empty, and that question is
    reasonable from anybody who can sign in.
    """
    token = _own_tenant_token(tenant_id, current_user)
    principal_id = current_user.get("user_id") or ""

    async with httpx.AsyncClient(timeout=elevate_access.REQUEST_TIMEOUT) as client:
        assignment, error = await elevate_access.read_elevation(client, token, principal_id)

    if error:
        # Not a 502. Failing to read this is not failing to do anything, and
        # the page that asks needs to render either way -- so the uncertainty
        # is returned as a fact rather than thrown as a failure.
        return {"elevated": False, "unknown": True, "error": error}

    return {**elevate_access.describe(assignment), "unknown": False, "error": ""}


@router.post("/access/elevate", response_model=ActionRecord)
async def elevate_tenant_access(
    body: ElevateAccessRequest,
    idempotency_key: Optional[str] = Header(default=None, alias="Idempotency-Key"),
    current_user: dict = Depends(require_workspace_admin),
    db: aiosqlite.Connection = Depends(get_db),
):
    """Assign the caller User Access Administrator above the whole tenant.

    This exists for the worst moment in onboarding: a Global Administrator
    signs in, connects their tenant, and sees no subscriptions at all. Nothing
    is broken. Entra directory roles and Azure RBAC are separate systems, and
    the highest role in one grants nothing in the other. Elevation is Azure's
    own supported way out, and without it the honest thing this product could
    say to such a user is "go and read a documentation page".

    It cannot give anybody anything they could not already take. Azure refuses
    unless the caller already holds Global Administrator, so the operation only
    converts authority somebody has into a form Resource Manager recognises.
    """
    spec = actions.get_spec("access.elevate")

    try:
        actions.authorize(spec, current_user, confirmed=body.confirmation)
    except actions.ActionError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message)

    token = _own_tenant_token(body.tenant_id, current_user)
    principal_id = current_user.get("user_id") or ""

    async with httpx.AsyncClient(timeout=elevate_access.REQUEST_TIMEOUT) as client:
        # Read first, so the audit record can say what access looked like
        # before. A failure to read is not fatal here -- unlike a disk, there
        # is a sensible unknown prior state, and refusing to elevate because
        # the past could not be described would strand the user for nothing.
        before, _ = await elevate_access.read_elevation(client, token, principal_id)

        async def run():
            ok, message = await elevate_access.elevate(client, token)
            if not ok:
                raise HTTPException(status_code=502, detail=message)
            # Read back rather than assume. The assignment id is what the
            # removal path needs, and an id constructed here would be a claim
            # rather than an observation.
            after, _ = await elevate_access.read_elevation(client, token, principal_id)
            return elevate_access.describe(after)

        try:
            row = await actions.execute(
                db,
                spec=spec,
                user=current_user,
                tenant_id=body.tenant_id or current_user.get("tenant_id", ""),
                run=run,
                confirmed=body.confirmation,
                subscription_id="",
                resource_id=elevate_access.ROOT_SCOPE,
                resource_name="Tenant root",
                resource_kind="Microsoft.Authorization/roleAssignments",
                request={"role": "User Access Administrator", "principal_id": principal_id},
                previous_state=elevate_access.describe(before),
                idempotency_key=idempotency_key,
            )
        except actions.ActionError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.message)

    return _record(row)


@router.post("/access/elevation/remove", response_model=ActionRecord)
async def remove_tenant_elevation(
    body: RemoveElevationRequest,
    idempotency_key: Optional[str] = Header(default=None, alias="Idempotency-Key"),
    current_user: dict = Depends(require_workspace_admin),
    db: aiosqlite.Connection = Depends(get_db),
):
    """Give back the root-scope assignment, returning the tenant to normal.

    A first-class endpoint rather than a note pointing at the portal, because
    an elevation nobody removes is a standing tenant-wide administrator that no
    access review has ever looked at -- precisely the finding this product
    exists to raise. Offering the elevation without offering its removal would
    be creating the problem it reports.
    """
    spec = actions.get_spec("access.remove_elevation")

    try:
        actions.authorize(spec, current_user, confirmed=True)
    except actions.ActionError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message)

    token = _own_tenant_token(body.tenant_id, current_user)
    principal_id = current_user.get("user_id") or ""

    async with httpx.AsyncClient(timeout=elevate_access.REQUEST_TIMEOUT) as client:
        assignment, error = await elevate_access.read_elevation(client, token, principal_id)
        if error:
            raise HTTPException(status_code=502, detail=error)
        if not assignment:
            # Named for what it is. The caller wanted the elevation gone and it
            # is gone, but reporting success would imply this call removed it.
            raise HTTPException(
                status_code=409,
                detail="You do not currently hold tenant-wide elevated access.",
            )

        previous = elevate_access.describe(assignment)
        assignment_id = previous["assignment_id"]

        async def run():
            ok, message = await elevate_access.remove_elevation(client, token, assignment_id)
            if not ok:
                raise HTTPException(status_code=502, detail=message)
            return {"elevated": False, "removed": assignment_id}

        try:
            row = await actions.execute(
                db,
                spec=spec,
                user=current_user,
                tenant_id=body.tenant_id or current_user.get("tenant_id", ""),
                run=run,
                confirmed=True,
                subscription_id="",
                resource_id=elevate_access.ROOT_SCOPE,
                resource_name="Tenant root",
                resource_kind="Microsoft.Authorization/roleAssignments",
                request={"assignment_id": assignment_id},
                previous_state=previous,
                idempotency_key=idempotency_key,
            )
        except actions.ActionError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.message)

    return _record(row)
