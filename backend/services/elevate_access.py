"""Elevating a Global Administrator so they can see their own Azure estate.

This exists because of the single most confusing thing that happens during
onboarding. Somebody signs in as Global Administrator -- the highest role their
directory has -- connects their tenant, and the subscription list comes back
empty. Nothing is broken, and no error is true enough to show them.

The reason is that Entra ID and Azure Resource Manager are two different
permission systems. Global Administrator is a directory role: it governs users,
groups, applications and licences. It conveys no rights over subscriptions,
resource groups or resources, because those are governed by Azure RBAC, which
the directory role does not touch. A Global Administrator with no RBAC
assignment can genuinely see nothing, and telling them "you do not have access"
reads as an accusation rather than an explanation.

Azure's supported answer is elevation. A Global Administrator may assign
themselves User Access Administrator at the root scope -- `/`, above every
management group and subscription in the tenant -- which is enough to then see
the estate and grant themselves or others whatever they actually need.

Four things about it are worth stating plainly, because each one is a way this
could be got wrong.

**It cannot escalate anybody.** Azure refuses the call unless the caller is
already a Global Administrator. Someone who is not one gains nothing by
reaching this code, which is why it can be offered in the product at all.

**It is tenant-wide, not subscription-wide.** The assignment lands at `/`, so
it covers every subscription and management group that exists now and every one
created afterwards. That is far more reach than the onboarding problem needs,
and it is the reason the removal below is written first-class rather than left
to the portal.

**It is meant to be temporary.** Microsoft's own guidance is to elevate, do the
one thing that needed it, and remove the elevation. A permanent root-scope
assignment is a standing tenant-wide administrator that nobody reviews, and
every access review this product runs would be right to flag it.

**Azure audits it independently of us.** The elevation appears in the Entra
directory activity log whatever this application records. That is a feature:
an action this significant should not be visible only in the tool that
performed it.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

import httpx

from services import azure_retry

MGMT_BASE = "https://management.azure.com"

# The elevation endpoint has never been versioned past its original release.
# A newer date here is not a newer API, it is a 400.
ELEVATE_API = "2016-07-01"
ROLE_API = "2022-04-01"

# Root. Everything in the tenant sits under it.
ROOT_SCOPE = "/"

# User Access Administrator. The id is the same in every tenant and every
# cloud, which is why it can be compared against rather than looked up.
USER_ACCESS_ADMINISTRATOR = "18d7d88d-d35e-4fb5-a5c3-7773c20a72d9"

REQUEST_TIMEOUT = 30.0


def _headers(token: str) -> Dict[str, str]:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def _azure_message(response: httpx.Response) -> str:
    """Azure's own explanation, or a plain one when it did not give a usable one.

    Preferred over a status code because the caller can act on "you are not a
    Global Administrator" and cannot act on "403".
    """
    try:
        body = response.json()
    except ValueError:
        body = {}

    error = body.get("error") if isinstance(body, dict) else None
    if isinstance(error, dict):
        message = error.get("message")
        if isinstance(message, str) and message.strip():
            return message.strip()

    if response.status_code == 403:
        return (
            "Azure refused the elevation. This is only permitted for accounts "
            "holding the Global Administrator role in Entra ID."
        )
    if response.status_code == 401:
        return "The Azure session has expired. Sign in again and retry."
    return f"Azure refused the request ({response.status_code})."


async def elevate(client: httpx.AsyncClient, token: str) -> Tuple[bool, str]:
    """Assign the caller User Access Administrator at the root scope.

    Azure answers this with an empty body, so there is nothing to return but
    whether it worked. The assignment that results is found by reading it back
    -- see `read_elevation` -- rather than guessed at here, because an id we
    constructed ourselves would be a claim rather than an observation, and the
    removal path depends on that id being real.
    """
    url = f"{MGMT_BASE}/providers/Microsoft.Authorization/elevateAccess"
    try:
        response = await azure_retry.send_with_retry(
            lambda: client.post(
                url,
                params={"api-version": ELEVATE_API},
                headers=_headers(token),
                timeout=REQUEST_TIMEOUT,
            )
        )
    except httpx.HTTPError as exc:
        return False, f"Azure could not be reached ({exc.__class__.__name__})."

    # 200 and 204 both mean done. Azure returns no body either way, and
    # elevating twice is not an error -- the second call is a no-op.
    if response.status_code in (200, 204):
        return True, ""
    return False, _azure_message(response)


async def read_elevation(
    client: httpx.AsyncClient, token: str, principal_id: str
) -> Tuple[Optional[Dict[str, Any]], str]:
    """The caller's root-scope assignment, if they currently hold one.

    Read rather than remembered. An elevation can be removed from the portal,
    from the CLI, or by another person holding the same rights, so anything
    this application stored about it would be a guess about the present dressed
    as a fact. Asking Azure costs one request and cannot be stale.

    Returns `(None, "")` for the ordinary case of not being elevated, which is
    deliberately distinct from `(None, "some error")`. "You are not elevated"
    and "we could not find out" lead to different buttons.
    """
    url = f"{MGMT_BASE}/providers/Microsoft.Authorization/roleAssignments"
    try:
        response = await azure_retry.send_with_retry(
            lambda: client.get(
                url,
                # atScope() excludes assignments inherited from nowhere -- at
                # the root there is nowhere above to inherit from, but it also
                # excludes every child scope, which is the whole estate. Without
                # it this call would try to enumerate the tenant.
                params={"api-version": ROLE_API, "$filter": "atScope()"},
                headers=_headers(token),
                timeout=REQUEST_TIMEOUT,
            )
        )
    except httpx.HTTPError as exc:
        return None, f"Azure could not be reached ({exc.__class__.__name__})."

    if response.status_code >= 400:
        return None, _azure_message(response)

    try:
        payload = response.json()
    except ValueError:
        return None, "Azure returned a role assignment list that could not be read."

    for item in _assignments(payload):
        props = item.get("properties") or {}
        if props.get("principalId") != principal_id:
            continue
        if props.get("scope", ROOT_SCOPE) != ROOT_SCOPE:
            continue
        role = str(props.get("roleDefinitionId") or "")
        # Compared by suffix: the full id carries the scope in front of it and
        # differs between clouds, while the guid does not.
        if role.rsplit("/", 1)[-1].lower() == USER_ACCESS_ADMINISTRATOR:
            return item, ""

    return None, ""


async def remove_elevation(
    client: httpx.AsyncClient, token: str, assignment_id: str
) -> Tuple[bool, str]:
    """Delete a root-scope assignment, returning access to what it was before.

    A 204 means Azure had already removed it. Treated as success rather than as
    an error, because the caller asked for the elevation to be gone and it is
    gone -- reporting a failure would invite them to try again at something
    that has already happened.
    """
    url = f"{MGMT_BASE}{assignment_id}"
    try:
        response = await azure_retry.send_with_retry(
            lambda: client.delete(
                url,
                params={"api-version": ROLE_API},
                headers=_headers(token),
                timeout=REQUEST_TIMEOUT,
            )
        )
    except httpx.HTTPError as exc:
        return False, f"Azure could not be reached ({exc.__class__.__name__})."

    if response.status_code in (200, 204):
        return True, ""
    return False, _azure_message(response)


def _assignments(payload: Any) -> List[Dict[str, Any]]:
    """The assignment list out of a response, whatever shape it arrived in."""
    if not isinstance(payload, dict):
        return []
    value = payload.get("value")
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def describe(assignment: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """The facts about an elevation worth keeping in an audit record.

    `created_on` is carried because it is the one that turns a finding into a
    judgement: an elevation from four minutes ago is somebody working, and the
    same elevation from four months ago is a standing tenant-wide administrator
    that no review has ever looked at.
    """
    if not assignment:
        return {"elevated": False}

    props = assignment.get("properties") or {}
    return {
        "elevated": True,
        "assignment_id": assignment.get("id") or "",
        "principal_id": props.get("principalId") or "",
        "scope": props.get("scope") or ROOT_SCOPE,
        "role": "User Access Administrator",
        "created_on": props.get("createdOn") or "",
    }
