"""What this platform is allowed to change in Azure, and how it is allowed to.

Three write features existed before this module: VM resize, role assignment
grant/revoke, and ARM deployment. Each of them arrived with its own audit
table, its own duplicate guard and its own permission check, and each of those
was written slightly differently from the last. Adding a fourth action that way
would mean a fourth schema change and a fourth chance to forget something that
matters.

So the safety rules live here once, and an action supplies only the part that
is genuinely specific to it: the call to Azure.

Two ideas carry most of the weight.

**The registry is the answer to "what can this product change?"**  Not a
comment, not a page in the docs, not a grep across the routers -- a list that
the API itself serves. An action that is not in the registry cannot be run,
which means the catalogue cannot quietly fall out of date with the code.

**Destructive and reversible are recorded separately, and neither is
cosmetic.**  Deallocating a VM stops a workload and is undone by starting it
again. Deleting a disk is not undone by anything. Both are dangerous; only one
of them is recoverable, and a person deciding whether to click needs to be told
which one they are looking at. `execute` refuses to run an irreversible action
that has not been explicitly enabled, so shipping a delete is a deliberate act
rather than a consequence of adding a dictionary entry.
"""
from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Dict, Optional

from fastapi import HTTPException, status

# States a row in `resource_actions` can hold.
#
# PENDING exists as a distinct state from RUNNING because the row is written
# before Azure is called. A process that dies between the two leaves PENDING,
# which reads as "we intended to, and cannot prove we did" -- the honest answer,
# and a different one from RUNNING.
PENDING = "PENDING"
RUNNING = "RUNNING"
SUCCEEDED = "SUCCEEDED"
FAILED = "FAILED"

# An action still in one of these has not reached Azure's final answer, and is
# what the duplicate guard looks for.
OPEN_STATES = (PENDING, RUNNING)


@dataclass(frozen=True)
class ActionSpec:
    """One thing this platform can do to a resource in Azure."""

    key: str
    title: str
    # Written for the person clicking the button, not for the developer. It
    # appears in the confirmation dialog, so it says what will happen to the
    # running system rather than which API is called.
    description: str
    # Does this change the state of a running workload or remove something?
    destructive: bool = False
    # Can the change be undone by another action in this registry? Deallocate
    # is reversible (start). Delete is not, by anything.
    reversible: bool = True
    # The ARM permission Azure itself will require. Recorded so the UI can tell
    # a user *why* they were refused by Azure rather than showing a raw 403,
    # and so the catalogue is checkable against a role definition.
    azure_permission: str = ""
    # Actions are off until someone decides otherwise. A registry entry is a
    # description of a capability, not permission to ship it.
    enabled: bool = False
    # Extra guard for the actions where a single mistaken click is unrecoverable.
    requires_confirmation: bool = True
    # Free-form notes surfaced in the catalogue, e.g. what the action will not do.
    caveats: tuple[str, ...] = field(default_factory=tuple)


# The catalogue.
#
# The three pre-existing write features are listed as `enabled=True` because
# they already ship and already have their own equivalent guards; they are here
# so that the catalogue is complete rather than only describing what happens to
# be new. They are not routed through `execute` -- rewriting three working,
# well-tested features to prove a point would risk three working features.
REGISTRY: Dict[str, ActionSpec] = {
    "vm.resize": ActionSpec(
        key="vm.resize",
        title="Resize virtual machine",
        description=(
            "Changes the VM's size. The machine is stopped and restarted, so "
            "anything running on it is interrupted."
        ),
        destructive=True,
        reversible=True,
        azure_permission="Microsoft.Compute/virtualMachines/write",
        enabled=True,
        caveats=("Served by the existing /api/compute/resize endpoint.",),
    ),
    "access.grant": ActionSpec(
        key="access.grant",
        title="Grant a role",
        description="Gives a person or application a role on a subscription or resource.",
        destructive=False,
        reversible=True,
        azure_permission="Microsoft.Authorization/roleAssignments/write",
        enabled=True,
        caveats=("Served by the existing /api/security/access/grant endpoint.",),
    ),
    "access.revoke": ActionSpec(
        key="access.revoke",
        title="Revoke a role",
        description="Removes a role assignment. The person loses that access immediately.",
        destructive=True,
        reversible=True,
        azure_permission="Microsoft.Authorization/roleAssignments/delete",
        enabled=True,
        caveats=("Served by the existing /api/security/access/revoke endpoint.",),
    ),
    "access.downgrade": ActionSpec(
        key="access.downgrade",
        title="Replace a role with a smaller one",
        description=(
            "Grants a narrower role and then removes the wider one. The person "
            "keeps working; they simply can do less."
        ),
        destructive=True,
        reversible=True,
        azure_permission=(
            "Microsoft.Authorization/roleAssignments/write and "
            "Microsoft.Authorization/roleAssignments/delete"
        ),
        enabled=True,
        caveats=(
            "Two Azure operations, not one. The grant happens first, so a "
            "failure part-way leaves too much access rather than none.",
            "Served by the /api/security/access/downgrade endpoint.",
        ),
    ),
    "resource.tag": ActionSpec(
        key="resource.tag",
        title="Apply tags",
        description=(
            "Adds or updates tags on a resource. Nothing about the running "
            "resource changes -- only how it is labelled and grouped in cost "
            "reporting."
        ),
        destructive=False,
        reversible=True,
        azure_permission="Microsoft.Resources/tags/write",
        enabled=True,
        caveats=(
            "Merges with existing tags; it does not replace the whole set.",
            "Tag changes can take a few hours to appear in cost reports.",
        ),
    ),
    # Described, deliberately not enabled.
    #
    # These are the actions the product's own findings point at: the savings
    # panel names unattached disks and idle VMs and today cannot act on either.
    # They are written down here so the gap is visible in the catalogue instead
    # of being invisible in a backlog. Enabling them is a decision about
    # someone else's production estate, and is the owner's to make.
    "vm.deallocate": ActionSpec(
        key="vm.deallocate",
        title="Stop (deallocate) virtual machine",
        description=(
            "Stops the machine and releases its compute, which stops compute "
            "billing. Disks are kept and still cost money. Anything running on "
            "the machine stops."
        ),
        destructive=True,
        reversible=True,
        azure_permission="Microsoft.Compute/virtualMachines/deallocate/action",
        enabled=False,
    ),
    "vm.start": ActionSpec(
        key="vm.start",
        title="Start virtual machine",
        description="Starts a stopped machine. Compute billing resumes.",
        destructive=False,
        reversible=True,
        azure_permission="Microsoft.Compute/virtualMachines/start/action",
        enabled=False,
    ),
    "disk.delete": ActionSpec(
        key="disk.delete",
        title="Delete unattached disk",
        description=(
            "Permanently deletes the disk and everything on it. There is no "
            "undo, and Azure keeps no copy."
        ),
        destructive=True,
        reversible=False,
        azure_permission="Microsoft.Compute/disks/delete",
        enabled=False,
        caveats=("Requires a snapshot policy or an explicit acceptance of data loss.",),
    ),
}


class ActionError(Exception):
    """An action could not be started. Carries the HTTP status to answer with."""

    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.message = message


def get_spec(key: str) -> ActionSpec:
    spec = REGISTRY.get(key)
    if spec is None:
        # Named explicitly rather than 404'd anonymously: a typo in an action
        # key should read as a typo, not as "that resource does not exist".
        raise ActionError(status.HTTP_400_BAD_REQUEST, f"Unknown action '{key}'.")
    return spec


def authorize(spec: ActionSpec, user: dict, *, confirmed: bool) -> None:
    """Everything that must be true before Azure is called at all.

    Azure's own RBAC is still the real boundary -- this runs on the caller's
    delegated token, so a viewer in Azure cannot be given write access by this
    application no matter what it decides here. These checks exist so that a
    refusal is a clear sentence instead of a raw ARM 403, and so that an action
    nobody has enabled cannot be reached by guessing its name.
    """
    if not spec.enabled:
        raise ActionError(
            status.HTTP_403_FORBIDDEN,
            f"'{spec.title}' is not enabled on this platform.",
        )

    if not spec.reversible:
        # Belt and braces with `enabled`. An irreversible action is one commit
        # away from being switched on by someone who has not thought about what
        # "no undo" means on a customer's estate; this makes that require a
        # second, visible change.
        raise ActionError(
            status.HTTP_403_FORBIDDEN,
            f"'{spec.title}' cannot be undone and is not available.",
        )

    if not user.get("can_administer"):
        raise ActionError(
            status.HTTP_403_FORBIDDEN,
            "You have view access to this workspace. Ask the workspace owner "
            "or an administrator to make this change.",
        )

    if spec.requires_confirmation and not confirmed:
        # The client must say it meant it. This is not a UI concern: the API is
        # callable directly, and an unconfirmed change to somebody's estate
        # should fail on the server.
        raise ActionError(
            status.HTTP_400_BAD_REQUEST,
            f"This change must be confirmed before it runs: {spec.description}",
        )


async def find_replay(db, user_id: int, key: Optional[str]) -> Optional[dict]:
    """The earlier run of this exact request, if there was one.

    Without this, a retried request -- a double click, a proxy retry, a phone
    losing signal mid-POST -- is a second change to Azure. Returning the first
    result is the only answer that keeps "I pressed it twice" from meaning
    "it happened twice".
    """
    if not key:
        return None
    async with db.execute(
        "SELECT * FROM resource_actions WHERE user_id = ? AND idempotency_key = ?",
        (user_id, key),
    ) as cursor:
        row = await cursor.fetchone()
    return dict(row) if row else None


async def find_open_on_resource(db, resource_id: str) -> Optional[dict]:
    """An action already in flight against this resource, if any.

    Deliberately not scoped to the caller. Two administrators acting on the
    same VM at the same time is a worse problem than one person double
    clicking, and scoping this to the person would miss it entirely.
    """
    if not resource_id:
        return None
    placeholders = ",".join("?" for _ in OPEN_STATES)
    async with db.execute(
        f"SELECT * FROM resource_actions WHERE resource_id = ? "
        f"AND state IN ({placeholders}) ORDER BY id DESC LIMIT 1",
        (resource_id, *OPEN_STATES),
    ) as cursor:
        row = await cursor.fetchone()
    return dict(row) if row else None


async def begin(
    db,
    *,
    spec: ActionSpec,
    user: dict,
    tenant_id: str,
    subscription_id: str = "",
    resource_id: str = "",
    resource_name: str = "",
    resource_kind: str = "",
    request: Optional[dict] = None,
    previous_state: Optional[dict] = None,
    idempotency_key: Optional[str] = None,
) -> str:
    """Record the intent to change Azure, and return the new action id.

    Written *before* the call, not after. An audit trail assembled from
    successful outcomes only is the one trail that cannot answer the question
    it is kept for.
    """
    action_id = str(uuid.uuid4())
    await db.execute(
        """
        INSERT INTO resource_actions
            (action_id, idempotency_key, user_id, actor_id, actor_name, actor_email,
             tenant_id, action, subscription_id, resource_id, resource_name,
             resource_kind, request, previous_state, state)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            action_id,
            idempotency_key,
            user["account_id"],
            user.get("actor_id"),
            user.get("name") or "",
            user.get("preferred_username") or user.get("email") or "",
            tenant_id,
            spec.key,
            subscription_id,
            resource_id,
            resource_name,
            resource_kind,
            json.dumps(request or {}),
            json.dumps(previous_state or {}),
            PENDING,
        ),
    )
    await db.commit()
    return action_id


async def finish(
    db,
    action_id: str,
    *,
    state: str,
    new_state: Optional[dict] = None,
    failure_reason: str = "",
    azure_operation: str = "",
) -> None:
    """Close the record with what actually happened."""
    await db.execute(
        """
        UPDATE resource_actions
           SET state = ?, new_state = ?, failure_reason = ?, azure_operation = ?,
               updated_at = CURRENT_TIMESTAMP, completed_at = CURRENT_TIMESTAMP
         WHERE action_id = ?
        """,
        (
            state,
            json.dumps(new_state or {}),
            failure_reason,
            azure_operation,
            action_id,
        ),
    )
    await db.commit()


async def get(db, action_id: str, user_id: int) -> Optional[dict]:
    """One action, scoped to the workspace that owns it.

    The `user_id` argument is not optional and has no default. Knowing an
    action id must not be enough to read another customer's change history.
    """
    async with db.execute(
        "SELECT * FROM resource_actions WHERE action_id = ? AND user_id = ?",
        (action_id, user_id),
    ) as cursor:
        row = await cursor.fetchone()
    return dict(row) if row else None


async def history(db, user_id: int, tenant_id: str, limit: int = 50) -> list[dict]:
    """This workspace's changes to this tenant, newest first."""
    async with db.execute(
        "SELECT * FROM resource_actions WHERE user_id = ? AND tenant_id = ? "
        "ORDER BY id DESC LIMIT ?",
        (user_id, tenant_id, limit),
    ) as cursor:
        rows = await cursor.fetchall()
    return [dict(row) for row in rows]


async def execute(
    db,
    *,
    spec: ActionSpec,
    user: dict,
    tenant_id: str,
    run: Callable[[], Awaitable[dict]],
    confirmed: bool,
    subscription_id: str = "",
    resource_id: str = "",
    resource_name: str = "",
    resource_kind: str = "",
    request: Optional[dict] = None,
    previous_state: Optional[dict] = None,
    idempotency_key: Optional[str] = None,
) -> dict:
    """Run one action against Azure with every guard applied, and record it.

    `run` is an async callable that performs the Azure call and returns the
    resulting state as a dict. It is the only part an action has to write; if
    it raises, the failure is recorded and re-raised as an HTTP error rather
    than leaving a row stuck open.

    Returns the finished `resource_actions` row.
    """
    authorize(spec, user, confirmed=confirmed)

    replay = await find_replay(db, user["account_id"], idempotency_key)
    if replay is not None:
        # The same request, already answered. Returning the original outcome is
        # the whole point of the key -- doing the work again would defeat it.
        return replay

    in_flight = await find_open_on_resource(db, resource_id)
    if in_flight is not None:
        raise ActionError(
            status.HTTP_409_CONFLICT,
            f"Another change ({in_flight['action']}) is already running "
            f"against {resource_name or resource_id}. Wait for it to finish.",
        )

    action_id = await begin(
        db,
        spec=spec,
        user=user,
        tenant_id=tenant_id,
        subscription_id=subscription_id,
        resource_id=resource_id,
        resource_name=resource_name,
        resource_kind=resource_kind,
        request=request,
        previous_state=previous_state,
        idempotency_key=idempotency_key,
    )

    try:
        result = await run()
    except HTTPException as exc:
        # The Azure error translators already turn a 403 or a 429 into a
        # sentence worth showing. Keep it, both in the record and in the reply.
        await finish(db, action_id, state=FAILED, failure_reason=str(exc.detail))
        raise
    except Exception as exc:  # noqa: BLE001 - the record matters more than the type
        await finish(db, action_id, state=FAILED, failure_reason=str(exc))
        raise

    await finish(db, action_id, state=SUCCEEDED, new_state=result)
    row = await get(db, action_id, user["account_id"])
    assert row is not None  # just written, in this transaction's database
    return row


def catalogue() -> list[dict]:
    """The registry as the API serves it.

    Disabled actions are included rather than hidden. A platform that lists
    only what it can do leaves the reader to guess about the rest; saying
    "this exists and is switched off" is more useful than silence.
    """
    return [
        {
            "key": spec.key,
            "title": spec.title,
            "description": spec.description,
            "destructive": spec.destructive,
            "reversible": spec.reversible,
            "azure_permission": spec.azure_permission,
            "enabled": spec.enabled,
            "requires_confirmation": spec.requires_confirmation,
            "caveats": list(spec.caveats),
        }
        for spec in REGISTRY.values()
    ]
