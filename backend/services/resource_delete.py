"""Removing a resource the orphaned-resources scan has flagged.

This is the only irreversible thing the platform does, so the constraints are
worth stating before the code.

**An allowlist, not a generic delete.** `DELETABLE` names the seven resource
types the orphan scan can flag as leftover infrastructure, and a resource id
that does not match one of them is refused before a token is spent. A generic
"delete whatever this id points at" endpoint would be a far larger capability
than the page asking for it needs, and the difference between the two is a
resource group id typed into the wrong field.

**Stopped virtual machines are deliberately absent.** The scan flags them, and
they are the one finding where deletion is not cleanup: a stopped VM is a
machine somebody may intend to start again, and removing it destroys its
configuration along with it. Deallocated compute already costs nothing, so the
saving that would justify the risk is not there either.

**Locks are read before the delete, not discovered through a 409.** Azure
refuses a locked resource with an error that names the lock, which is fine for
a script and useless in a UI: by then the person has already confirmed a
deletion that was never going to happen. Reading first turns that into a
disabled button with a reason.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Dict, List, Tuple

import httpx

from services import azure_retry

MGMT_BASE = "https://management.azure.com"
LOCKS_API = "2016-09-01"
REQUEST_TIMEOUT = 60.0


@dataclass(frozen=True)
class Deletable:
    """One resource type this module will remove, and what that needs."""

    # The orphan scan rule that flags it, so the UI can map a finding to this.
    rule: str
    provider: str
    resource_type: str
    api_version: str
    label: str
    # What Azure will require. Also what the UI checks before enabling the
    # button, so a refusal names the missing permission instead of showing 403.
    permission: str
    # Shown in the confirmation dialog. Says what is lost, not what is called.
    consequence: str


DELETABLE: Dict[str, Deletable] = {
    "unattached_disks": Deletable(
        rule="unattached_disks",
        provider="Microsoft.Compute",
        resource_type="disks",
        api_version="2023-04-02",
        label="managed disk",
        permission="Microsoft.Compute/disks/delete",
        consequence=(
            "The disk and everything written on it are removed. Azure keeps no "
            "copy unless you took a snapshot first."
        ),
    ),
    "old_snapshots": Deletable(
        rule="old_snapshots",
        provider="Microsoft.Compute",
        resource_type="snapshots",
        api_version="2023-04-02",
        label="snapshot",
        permission="Microsoft.Compute/snapshots/delete",
        consequence=(
            "The snapshot is removed. Anything that was only recoverable from "
            "it stops being recoverable."
        ),
    ),
    "unassociated_public_ips": Deletable(
        rule="unassociated_public_ips",
        provider="Microsoft.Network",
        resource_type="publicIPAddresses",
        api_version="2023-09-01",
        label="public IP address",
        permission="Microsoft.Network/publicIPAddresses/delete",
        consequence=(
            "The address is released back to Azure. A static address cannot be "
            "reclaimed, so anything pointing at it stops resolving."
        ),
    ),
    "orphaned_nics": Deletable(
        rule="orphaned_nics",
        provider="Microsoft.Network",
        resource_type="networkInterfaces",
        api_version="2023-09-01",
        label="network interface",
        permission="Microsoft.Network/networkInterfaces/delete",
        consequence="The interface and its IP configuration are removed.",
    ),
    "unused_nsgs": Deletable(
        rule="unused_nsgs",
        provider="Microsoft.Network",
        resource_type="networkSecurityGroups",
        api_version="2023-09-01",
        label="network security group",
        permission="Microsoft.Network/networkSecurityGroups/delete",
        consequence=(
            "The group and every rule in it are removed. If it is reattached "
            "later those rules have to be written again."
        ),
    ),
    "empty_load_balancers": Deletable(
        rule="empty_load_balancers",
        provider="Microsoft.Network",
        resource_type="loadBalancers",
        api_version="2023-09-01",
        label="load balancer",
        permission="Microsoft.Network/loadBalancers/delete",
        consequence=(
            "The load balancer, its rules and its probes are removed. Its "
            "frontend address stops answering."
        ),
    ),
    "empty_app_service_plans": Deletable(
        rule="empty_app_service_plans",
        provider="Microsoft.Web",
        resource_type="serverfarms",
        api_version="2023-12-01",
        label="App Service plan",
        permission="Microsoft.Web/serverfarms/delete",
        consequence=(
            "The plan is removed. Any app later assigned to it would need a "
            "new plan first."
        ),
    ),
}

# Indexed the other way too: a resource id names its type, and the caller does
# not always know which rule flagged it.
_BY_TYPE = {
    (item.provider.lower(), item.resource_type.lower()): item
    for item in DELETABLE.values()
}

# A resource id, split strictly. Every segment is captured and none is taken on
# trust: the provider and type are checked against the allowlist, and the
# remaining parts are re-assembled rather than the caller's string being
# forwarded to Azure.
RESOURCE_ID = re.compile(
    r"^/subscriptions/(?P<sub>[0-9a-fA-F-]{36})"
    r"/resourceGroups/(?P<rg>[^/]+)"
    r"/providers/(?P<provider>[^/]+)"
    r"/(?P<type>[^/]+)"
    r"/(?P<name>[^/]+)$"
)


def _headers(token: str) -> Dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def classify(resource_id: str) -> Tuple[Deletable | None, Dict[str, str], str]:
    """Work out what a resource id points at, and whether we will delete it.

    Returns (spec, parts, error). Returns rather than raises so a caller can
    record a refused action with a reason, which is what every other write path
    in this codebase does.
    """
    match = RESOURCE_ID.match((resource_id or "").strip())
    if not match:
        return None, {}, (
            "That is not a resource this page can remove. Only individual "
            "resources inside a resource group can be deleted here."
        )

    parts = dict(match.groupdict())
    spec = _BY_TYPE.get((parts["provider"].lower(), parts["type"].lower()))
    if spec is None:
        return None, parts, (
            f"{parts['provider']}/{parts['type']} is not a resource type this "
            "page can remove. Delete it from the Azure portal or your "
            "infrastructure-as-code."
        )
    return spec, parts, ""


def canonical_id(spec: Deletable, parts: Dict[str, str]) -> str:
    """Rebuild the id from checked parts, using the allowlist's own casing."""
    return (
        f"/subscriptions/{parts['sub']}"
        f"/resourceGroups/{parts['rg']}"
        f"/providers/{spec.provider}/{spec.resource_type}/{parts['name']}"
    )


async def read_locks(
    client: httpx.AsyncClient, token: str, resource_id: str
) -> Tuple[List[Dict[str, Any]], str]:
    """Locks that apply to a resource, including ones inherited from above.

    `ListForResource`-style scoping returns locks set on the resource, its
    resource group and its subscription, which is what makes this worth reading:
    the lock that stops a delete is usually not on the resource itself.
    """
    url = f"{MGMT_BASE}{resource_id}/providers/Microsoft.Authorization/locks"
    try:
        response = await azure_retry.send_with_retry(
            lambda: client.get(
                url,
                params={"api-version": LOCKS_API},
                headers=_headers(token),
                timeout=REQUEST_TIMEOUT,
            )
        )
    except httpx.HTTPError as exc:
        return [], f"Azure could not be reached ({exc.__class__.__name__})."

    if response.status_code >= 400:
        return [], _azure_message(response)

    try:
        payload = response.json()
    except ValueError:
        return [], "Azure returned a lock list that could not be read."

    return list(payload.get("value") or []), ""


def blocking_lock(locks: List[Dict[str, Any]]) -> Dict[str, str]:
    """The first lock that would refuse a delete, described for a person.

    `CanNotDelete` and `ReadOnly` both block removal. A lock's `notes` field is
    where whoever set it explained why, so it is carried through rather than
    replaced with a sentence written here.
    """
    for lock in locks or []:
        level = ((lock.get("properties") or {}).get("level") or "").lower()
        if level in ("cannotdelete", "readonly"):
            return {
                "name": lock.get("name") or "",
                "level": (lock.get("properties") or {}).get("level") or "",
                "notes": (lock.get("properties") or {}).get("notes") or "",
            }
    return {}


async def delete_resource(
    client: httpx.AsyncClient, token: str, *, spec: Deletable, resource_id: str
) -> Tuple[bool, str, Dict[str, Any]]:
    """Remove the resource. Returns (ok, error message, outcome).

    Azure answers a delete with 200, 202 or 204, and all three mean it accepted
    the request. 204 specifically means there was nothing there, which is
    reported as removed rather than as a failure: the caller wanted it gone and
    it is gone, and failing a cleanup because somebody else finished it first
    would be unhelpfully literal.
    """
    url = f"{MGMT_BASE}{resource_id}"
    try:
        response = await azure_retry.send_with_retry(
            lambda: client.delete(
                url,
                params={"api-version": spec.api_version},
                headers=_headers(token),
                timeout=REQUEST_TIMEOUT,
            )
        )
    except httpx.HTTPError as exc:
        return False, f"Azure could not be reached ({exc.__class__.__name__}).", {}

    if response.status_code in (200, 202, 204):
        return True, "", {
            "deleted": True,
            "resource_id": resource_id,
            "kind": f"{spec.provider}/{spec.resource_type}",
            # 202 means Azure is still working. Saying "Deleted" then would be
            # a guess, and the difference matters to anyone watching the bill.
            "state": "Deleted" if response.status_code in (200, 204) else "Deleting",
            "already_absent": response.status_code == 204,
        }

    if response.status_code == 403:
        return False, (
            "Azure refused this deletion. It needs "
            f"{spec.permission} on the resource."
        ), {}
    if response.status_code == 409:
        # Azure's own message names the dependency or the lock, and is worth
        # far more than anything that could be written in advance here.
        return False, _azure_message(response), {}

    return False, _azure_message(response), {}


def _azure_message(response: httpx.Response) -> str:
    try:
        payload = response.json()
    except ValueError:
        payload = {}
    message = (payload.get("error") or {}).get("message") or ""
    return message or f"Azure refused the request ({response.status_code})."
