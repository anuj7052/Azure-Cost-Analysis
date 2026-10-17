"""What the signed-in person is actually allowed to do in Azure, asked of Azure.

The delete button on the orphaned-resources page needs an answer to "may this
person remove this?", and there are two ways to get one. The tempting way is to
read the caller's role assignments and look for the words "Owner" or
"Contributor". The right way is to ask Azure for the permissions those
assignments add up to, which is what this module does.

The difference matters three times over:

  * **Custom roles.** An estate with a "Cleanup Operator" role granting
    `Microsoft.Compute/disks/delete` is common, and a name check would refuse
    the very person the role was created for.
  * **notActions.** Contributor is `*` minus a list. A role can grant `*` and
    subtract the one permission being asked about, and only the subtraction
    makes that role's answer correct.
  * **Inheritance.** A role held at the subscription applies to a resource
    inside it. Asking at the resource's own scope is what makes inherited
    access count, without this module having to model the hierarchy.

None of this is the security boundary. Every call this product makes to Azure
carries the caller's own delegated token, so Azure enforces the answer whatever
this module concludes. What this buys is a button that is disabled with a
reason instead of one that fails with a 403 after the user has committed to it.
"""
from __future__ import annotations

from typing import Any, Dict, List, Tuple

import httpx

from services import azure_retry

MGMT_BASE = "https://management.azure.com"
PERMISSIONS_API = "2022-04-01"
REQUEST_TIMEOUT = 30.0


def _headers(token: str) -> Dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def matches(pattern: str, action: str) -> bool:
    """Does one permission pattern cover one concrete action?

    Azure permission strings are matched case-insensitively and use `*` as a
    wildcard that may appear anywhere -- `*`, `Microsoft.Compute/*` and
    `Microsoft.Compute/disks/*` are all real, and so is the rarer
    `Microsoft.Compute/*/delete`. Splitting on `*` and walking the literal
    segments in order handles every one of those without pulling in a regex
    built from a string Azure controls.
    """
    pattern = (pattern or "").strip().lower()
    action = (action or "").strip().lower()
    if not pattern or not action:
        return False
    if "*" not in pattern:
        return pattern == action

    segments = pattern.split("*")
    if not action.startswith(segments[0]):
        return False
    if not action.endswith(segments[-1]):
        return False

    # Walk the middle segments left to right. Each has to appear after the one
    # before it, which is what stops `a*b*c` matching a string holding those
    # letters in the wrong order.
    position = len(segments[0])
    for segment in segments[1:-1]:
        if not segment:
            continue
        found = action.find(segment, position)
        if found == -1:
            return False
        position = found + len(segment)

    # The leading and trailing literals must not overlap in a short string.
    return position <= len(action) - len(segments[-1])


def allows(permissions: List[Dict[str, Any]], action: str) -> bool:
    """Whether a set of Azure permission blocks grants one action.

    A block grants the action when `actions` covers it and `notActions` does
    not take it back. Any single block granting it is enough, which is how
    Azure combines multiple role assignments at the same scope.
    """
    for block in permissions or []:
        granted = any(matches(p, action) for p in block.get("actions") or [])
        if not granted:
            continue
        denied = any(matches(p, action) for p in block.get("notActions") or [])
        if not denied:
            return True
    return False


async def read_permissions(
    client: httpx.AsyncClient, token: str, scope: str
) -> Tuple[List[Dict[str, Any]], str]:
    """Every permission the caller holds at a scope, as Azure computes it.

    Returns (blocks, error). The blocks already account for inheritance: Azure
    resolves assignments from the management group down to the resource before
    answering, so this module never walks the hierarchy itself.
    """
    url = f"{MGMT_BASE}{scope}/providers/Microsoft.Authorization/permissions"
    try:
        response = await azure_retry.send_with_retry(
            lambda: client.get(
                url,
                params={"api-version": PERMISSIONS_API},
                headers=_headers(token),
                timeout=REQUEST_TIMEOUT,
            )
        )
    except httpx.HTTPError as exc:
        return [], f"Azure could not be reached ({exc.__class__.__name__})."

    if response.status_code == 404:
        # The resource is gone, or this account cannot see it. Either way the
        # honest answer is that permission cannot be established -- not that
        # the caller lacks it.
        return [], "That resource could not be found in Azure."
    if response.status_code == 403:
        return [], "This account cannot read permissions on that resource."
    if response.status_code >= 400:
        return [], _azure_message(response)

    try:
        payload = response.json()
    except ValueError:
        return [], "Azure returned a permission list that could not be read."

    return list(payload.get("value") or []), ""


async def can_perform(
    client: httpx.AsyncClient, token: str, scope: str, action: str
) -> Tuple[bool, str]:
    """May the caller perform one action at one scope?

    Returns (allowed, reason). `reason` is empty when allowed, and otherwise
    says why in a sentence worth showing: either Azure's own explanation of a
    failed lookup, or the named permission that is missing.

    An unreadable permission list is reported as not-allowed with the reason,
    never as allowed. Guessing in the permissive direction here would put a
    live delete button in front of somebody Azure is about to refuse.
    """
    blocks, error = await read_permissions(client, token, scope)
    if error:
        return False, error
    if allows(blocks, action):
        return True, ""
    return False, (
        f"Your Azure role on this resource does not include {action}. "
        "Owner or Contributor on the resource, its resource group or its "
        "subscription would grant it."
    )


def _azure_message(response: httpx.Response) -> str:
    try:
        payload = response.json()
    except ValueError:
        payload = {}
    message = (payload.get("error") or {}).get("message") or ""
    return message or f"Azure refused the request ({response.status_code})."
