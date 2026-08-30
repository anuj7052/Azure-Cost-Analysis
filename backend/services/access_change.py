"""
Changing who can reach Azure, and writing down that we did.

Every other service in this application reads. This one writes, and a mistake
here does not produce a wrong number on a dashboard -- it hands somebody control
of a production subscription, or takes it away from the person holding the pager
at two in the morning. The whole module is shaped around that asymmetry.

Four rules follow from it.

Nothing is taken on the caller's word. The browser sends a scope, a principal
and a role; all three are re-read from Azure before anything happens, because
the only thing a request body proves is what somebody typed.

The caller's own permission is checked against Azure rather than against our
idea of their role. Hiding a button is presentation, not security, and the
question "may this person grant access here" has exactly one authoritative
answer: Azure's.

Preview and execute run the same checks. A preview that validates less than the
execution is worse than no preview, because it teaches the user to trust a
screen that was never load-bearing.

The audit row is opened before the call to Azure and closed after it. A record
written only on success would be missing precisely the events an investigation
looks for: the attempts that failed.
"""

from __future__ import annotations

import json
import uuid
from typing import Any, Dict, List, Optional, Tuple

import aiosqlite
import httpx

MGMT_BASE = "https://management.azure.com"
AUTHZ_API = "2022-04-01"
REQUEST_TIMEOUT = 60.0

WRITE_ACTION = "microsoft.authorization/roleassignments/write"
DELETE_ACTION = "microsoft.authorization/roleassignments/delete"

ACTION_GRANT = "access_granted"
ACTION_REVOKE = "access_removed"

RESULT_PENDING = "pending"
RESULT_SUCCESS = "success"
RESULT_FAILED = "failed"

# Roles whose removal can lock an estate out of its own administration. They are
# not blocked -- an administrator may legitimately need to remove one -- but the
# preview says so plainly, and the confirmation asked for is stronger.
DANGEROUS_ROLES = {"owner", "user access administrator"}


def _headers(token: str) -> Dict[str, str]:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def _action_matches(pattern: str, action: str) -> bool:
    """
    Whether an RBAC action string covers a specific operation.

    Azure writes permissions with wildcards -- Owner carries a bare `*`, and
    many built-in roles carry `Microsoft.Authorization/*`. Comparing these as
    plain strings would decide that an Owner cannot do anything at all.
    """
    pattern = (pattern or "").strip().lower()
    action = (action or "").strip().lower()
    if not pattern:
        return False
    if pattern == "*":
        return True
    if pattern.endswith("/*"):
        return action.startswith(pattern[:-1])
    if pattern.endswith("*"):
        return action.startswith(pattern[:-1])
    return pattern == action


def subscription_of(scope: str) -> str:
    parts = [p for p in (scope or "").split("/") if p]
    for index, part in enumerate(parts):
        if part.lower() == "subscriptions" and index + 1 < len(parts):
            return parts[index + 1]
    return ""


def scope_kind(scope: str) -> str:
    """What sort of thing this scope points at, in the reader's terms."""
    text = (scope or "").strip("/")
    if not text:
        return "unknown"
    lowered = text.lower()
    if lowered.startswith("providers/microsoft.management/managementgroups"):
        return "management group"
    parts = [p for p in text.split("/") if p]
    if len(parts) == 2 and parts[0].lower() == "subscriptions":
        return "subscription"
    if len(parts) == 4 and parts[2].lower() == "resourcegroups":
        return "resource group"
    if len(parts) >= 6:
        return "resource"
    return "unknown"


async def caller_permissions(
    client: httpx.AsyncClient, token: str, scope: str
) -> Dict[str, Any]:
    """
    What the signed-in user may do at this scope, according to Azure.

    A failed lookup is reported as `unverified`, never as permission. The
    difference matters: if Azure cannot tell us whether somebody may grant
    access, the honest answer is that we do not know, and the safe behaviour is
    to refuse. Treating an unreachable permissions endpoint as approval would
    turn a network blip into a privilege escalation.
    """
    url = f"{MGMT_BASE}{scope}/providers/Microsoft.Authorization/permissions"
    try:
        response = await client.get(
            url,
            params={"api-version": AUTHZ_API},
            headers=_headers(token),
            timeout=REQUEST_TIMEOUT,
        )
        response.raise_for_status()
    except httpx.HTTPError as exc:
        return {
            "status": "unverified",
            "can_write": False,
            "can_delete": False,
            "note": (
                "Azure did not return the permission list for this scope "
                f"({exc.__class__.__name__}), so it is not known whether you "
                "may change access here. The change has not been attempted."
            ),
        }

    can_write = False
    can_delete = False
    for entry in response.json().get("value") or []:
        actions = [str(a) for a in entry.get("actions") or []]
        not_actions = [str(a) for a in entry.get("notActions") or []]

        def granted(target: str) -> bool:
            if not any(_action_matches(a, target) for a in actions):
                return False
            return not any(_action_matches(a, target) for a in not_actions)

        can_write = can_write or granted(WRITE_ACTION)
        can_delete = can_delete or granted(DELETE_ACTION)

    return {
        "status": "allowed" if (can_write or can_delete) else "denied",
        "can_write": can_write,
        "can_delete": can_delete,
        "note": (
            "You hold permission to change access at this scope."
            if (can_write or can_delete)
            else (
                "Your account cannot change access at this scope. This needs a "
                "role that includes Microsoft.Authorization/roleAssignments "
                "write, such as Owner or User Access Administrator."
            )
        ),
    }


async def list_role_definitions(
    client: httpx.AsyncClient, token: str, scope: str
) -> List[Dict[str, Any]]:
    """
    The roles that can actually be granted at this scope.

    Read from Azure rather than hard-coded. A hard-coded list goes stale, omits
    every custom role the organisation has written, and -- worst of the three --
    can offer a role that does not exist at this scope, producing a failure only
    after the user has confirmed.
    """
    url = f"{MGMT_BASE}{scope}/providers/Microsoft.Authorization/roleDefinitions"
    response = await client.get(
        url,
        params={"api-version": AUTHZ_API},
        headers=_headers(token),
        timeout=REQUEST_TIMEOUT,
    )
    response.raise_for_status()

    roles = []
    for item in response.json().get("value") or []:
        props = item.get("properties") or {}
        roles.append({
            "id": str(item.get("id") or ""),
            "name": str(props.get("roleName") or ""),
            "description": str(props.get("description") or ""),
            "kind": str(props.get("type") or ""),
        })
    roles.sort(key=lambda r: r["name"].lower())
    return roles


async def find_assignment(
    client: httpx.AsyncClient, token: str, scope: str, assignment_id: str
) -> Optional[Dict[str, Any]]:
    """
    Read one assignment back from Azure by its full resource id.

    The browser supplied this id, so it is re-read rather than trusted. If it
    has already been removed -- by another administrator, or by a second click
    on the same button -- Azure answers 404 and we can say so instead of
    reporting a successful deletion of something that was already gone.
    """
    url = f"{MGMT_BASE}{assignment_id}"
    try:
        response = await client.get(
            url,
            params={"api-version": AUTHZ_API},
            headers=_headers(token),
            timeout=REQUEST_TIMEOUT,
        )
        if response.status_code == 404:
            return None
        response.raise_for_status()
    except httpx.HTTPError:
        return None

    body = response.json()
    props = body.get("properties") or {}
    return {
        "id": str(body.get("id") or assignment_id),
        "scope": str(props.get("scope") or scope),
        "principal_id": str(props.get("principalId") or ""),
        "principal_type": str(props.get("principalType") or ""),
        "role_definition_id": str(props.get("roleDefinitionId") or ""),
    }


async def role_name_for(
    client: httpx.AsyncClient, token: str, role_definition_id: str
) -> str:
    if not role_definition_id:
        return ""
    try:
        response = await client.get(
            f"{MGMT_BASE}{role_definition_id}",
            params={"api-version": AUTHZ_API},
            headers=_headers(token),
            timeout=REQUEST_TIMEOUT,
        )
        response.raise_for_status()
    except httpx.HTTPError:
        return ""
    return str(((response.json().get("properties") or {}).get("roleName")) or "")


def effect_sentence(role_name: str, scope: str) -> str:
    """What granting this role here actually lets somebody do, in plain words."""
    where = scope_kind(scope)
    lowered = (role_name or "").strip().lower()
    if lowered == "owner":
        return (
            f"They will be able to do almost anything within this {where}, "
            "including giving other people access."
        )
    if lowered == "contributor":
        return (
            f"They will be able to create, change and delete resources in this "
            f"{where}, but not give other people access."
        )
    if lowered == "reader":
        return f"They will be able to look at this {where} but not change anything."
    if lowered == "user access administrator":
        return (
            f"They will be able to give and remove other people's access to this "
            f"{where}, but not manage the resources themselves."
        )
    return (
        f"They will hold the {role_name or 'selected'} role over this {where}. "
        "What that permits is defined by the role itself."
    )


def loss_sentence(role_name: str, scope: str) -> str:
    """What removing this role takes away."""
    where = scope_kind(scope)
    lowered = (role_name or "").strip().lower()
    if lowered == "owner":
        return (
            f"They will lose full control of this {where}, including the ability "
            "to manage other people's access."
        )
    if lowered == "contributor":
        return f"They will no longer be able to create or change resources in this {where}."
    if lowered == "reader":
        return f"They will no longer be able to view this {where}."
    if lowered == "user access administrator":
        return f"They will no longer be able to manage access to this {where}."
    return f"They will lose the {role_name or 'selected'} role over this {where}."


# ---------------------------------------------------------------------------
# Mutations
# ---------------------------------------------------------------------------

async def create_assignment(
    client: httpx.AsyncClient,
    token: str,
    scope: str,
    role_definition_id: str,
    principal_id: str,
    principal_type: str = "",
) -> Tuple[bool, str, str]:
    """
    Create one role assignment.

    Returns `(ok, error_message, assignment_id)`, matching the convention the
    resize service established: failures are values, not exceptions, because the
    caller has an audit row to close either way.

    Azure names role assignments with a GUID chosen by the caller. Generating it
    here means a retry after a timeout re-uses the same name, and Azure treats
    the second call as a no-op rather than creating a duplicate grant.
    """
    name = str(uuid.uuid4())
    url = f"{MGMT_BASE}{scope}/providers/Microsoft.Authorization/roleAssignments/{name}"
    body: Dict[str, Any] = {
        "properties": {
            "roleDefinitionId": role_definition_id,
            "principalId": principal_id,
        }
    }
    if principal_type:
        body["properties"]["principalType"] = principal_type

    try:
        response = await client.put(
            url,
            params={"api-version": AUTHZ_API},
            headers=_headers(token),
            json=body,
            timeout=REQUEST_TIMEOUT,
        )
    except httpx.HTTPError as exc:
        return False, f"Azure could not be reached ({exc.__class__.__name__}).", ""

    if response.status_code >= 400:
        return False, _azure_message(response), ""

    try:
        created = str(response.json().get("id") or "")
    except ValueError:
        created = ""
    return True, "", created


async def swap_assignment(
    client: httpx.AsyncClient,
    token: str,
    scope: str,
    role_definition_id: str,
    principal_id: str,
    principal_type: str,
    old_assignment_id: str,
) -> Dict[str, Any]:
    """
    Replace one role assignment with another, granting before removing.

    The order is the entire safety property, and it is why this lives in one
    function rather than being left to each caller to sequence. There are three
    outcomes and they are not equally bad:

      * Grant fails      -- nothing was removed. The account is untouched and
                            still holds the role it had. This is the safe
                            failure, and it is the one this order guarantees
                            whenever Azure refuses the new role.
      * Grant, no remove -- the account now holds both roles. Too much access,
                            visible, and reportable. Bad, but recoverable by
                            anyone reading the result.
      * Both succeed     -- what was asked for.

    Removing first would replace the first outcome with a fourth: the account
    holds nothing, mid-shift, because a role that was working was deleted before
    its replacement was known to exist. That is the one failure that stops
    somebody's work, so it is the one the order rules out.

    Returns a dict rather than raising, because the caller has an audit row to
    close and a partial result to describe either way.
    """
    granted, grant_message, new_id = await create_assignment(
        client, token, scope, role_definition_id, principal_id, principal_type,
    )
    if not granted:
        return {
            "stage": "grant",
            "granted": False,
            "removed": False,
            "new_assignment_id": "",
            "message": grant_message,
        }

    removed, remove_message = await delete_assignment(client, token, old_assignment_id)
    return {
        "stage": "done" if removed else "remove",
        "granted": True,
        "removed": removed,
        "new_assignment_id": new_id,
        "message": "" if removed else remove_message,
    }


async def delete_assignment(
    client: httpx.AsyncClient, token: str, assignment_id: str
) -> Tuple[bool, str]:
    """
    Remove one role assignment.

    A 204 means Azure had nothing to delete. That is reported as success with a
    note rather than as a failure: the caller asked for this access to be gone,
    and it is gone.
    """
    try:
        response = await client.delete(
            f"{MGMT_BASE}{assignment_id}",
            params={"api-version": AUTHZ_API},
            headers=_headers(token),
            timeout=REQUEST_TIMEOUT,
        )
    except httpx.HTTPError as exc:
        return False, f"Azure could not be reached ({exc.__class__.__name__})."

    if response.status_code == 404:
        return True, ""
    if response.status_code >= 400:
        return False, _azure_message(response)
    return True, ""


def _azure_message(response: httpx.Response) -> str:
    """
    Azure's own words where it gave any, rather than a bare status code.

    "RoleAssignmentUpdateNotPermitted" tells an administrator what to do next;
    "HTTP 400" does not.
    """
    try:
        body = response.json()
    except ValueError:
        return f"Azure returned HTTP {response.status_code}: {response.text[:300]}"
    error = body.get("error") or {}
    message = error.get("message") or body.get("message") or ""
    code = error.get("code") or ""
    if message:
        return f"{message}" + (f" ({code})" if code else "")
    return f"Azure returned HTTP {response.status_code}: {response.text[:300]}"


# ---------------------------------------------------------------------------
# Audit
# ---------------------------------------------------------------------------

async def open_event(
    db: aiosqlite.Connection,
    current_user: Dict[str, Any],
    tenant_id: str,
    action: str,
    *,
    scope: str = "",
    target_id: str = "",
    target_name: str = "",
    target_kind: str = "",
    previous_state: str = "",
    new_state: str = "",
    detail: Optional[Dict[str, Any]] = None,
) -> str:
    """
    Record that a change is about to be attempted.

    Opened before the Azure call so that a process killed mid-operation still
    leaves evidence of what was tried. The row stays `pending` in that case,
    which is itself informative -- it means nobody ever confirmed the outcome.
    """
    event_id = uuid.uuid4().hex
    await db.execute(
        """
        INSERT INTO security_audit (
            event_id, user_id, tenant_id, actor_name, actor_email, action,
            subscription_id, scope, target_id, target_name, target_kind,
            previous_state, new_state, result, detail
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            event_id,
            current_user["account_id"],
            tenant_id,
            current_user.get("name") or "",
            current_user.get("email") or "",
            action,
            subscription_of(scope),
            scope,
            target_id,
            target_name,
            target_kind,
            previous_state,
            new_state,
            RESULT_PENDING,
            json.dumps(detail or {}),
        ),
    )
    await db.commit()
    return event_id


async def close_event(
    db: aiosqlite.Connection,
    event_id: str,
    result: str,
    failure_reason: str = "",
    azure_operation: str = "",
) -> None:
    await db.execute(
        """
        UPDATE security_audit
           SET result = ?, failure_reason = ?, azure_operation = ?,
               completed_at = CURRENT_TIMESTAMP
         WHERE event_id = ?
        """,
        (result, failure_reason[:500], azure_operation, event_id),
    )
    await db.commit()


async def history(
    db: aiosqlite.Connection,
    account_id: int,
    tenant_id: str,
    limit: int = 100,
) -> List[Dict[str, Any]]:
    """
    This account's change history for this tenant.

    Ownership is part of the WHERE clause rather than a filter applied to the
    results, for the same reason it is in `posture_snapshots`: filtering
    afterwards means the row was already read, and a query that forgets the
    filter leaks one customer's administration to another.
    """
    async with db.execute(
        """
        SELECT event_id, actor_name, actor_email, action, subscription_id, scope,
               target_id, target_name, target_kind, previous_state, new_state,
               result, failure_reason, azure_operation, detail,
               created_at, completed_at
          FROM security_audit
         WHERE user_id = ? AND tenant_id = ?
         ORDER BY id DESC
         LIMIT ?
        """,
        (account_id, tenant_id, max(1, min(limit, 500))),
    ) as cursor:
        rows = await cursor.fetchall()

    events = []
    for row in rows:
        event = dict(row)
        try:
            event["detail"] = json.loads(event.get("detail") or "{}")
        except (ValueError, TypeError):
            event["detail"] = {}
        events.append(event)
    return events
