"""Taking a snapshot of a managed disk before anything irreversible happens.

This exists to solve a specific problem with `disk.delete`. That action is the
single largest saving the product can point at -- an unattached premium disk
costs money every hour and does nothing -- and it is also the only entry in the
registry marked `reversible=False`. Both of those are true at once, so the
button that saves the most is the one nobody dares press, and the disks stay.

A snapshot changes which of those two facts is true. It is a full copy of the
disk held by Azure independently of the disk itself, so deleting the disk stops
being "there is no undo" and becomes "there is an undo, and here is its
resource id". The cost of keeping one is a small fraction of the cost of
keeping the disk it replaces, which is the entire argument for doing this.

Three decisions worth stating.

**Incremental, not full.** An incremental snapshot is billed only for changed
blocks rather than for the whole disk, which for a disk nobody is writing to is
close to nothing. A cost product that recommends an expensive safety net is not
going to be believed about anything else.

**Standard_LRS storage.** Snapshots default to the storage type of the disk
they came from, so a premium disk yields a premium snapshot and most of the
saving disappears at the moment it is realised. Recovery speed does not matter
for a copy that exists to be restored once, if ever.

**The name is generated, never taken from the caller.** It is derived from the
disk's own name and the time, so two snapshots of the same disk cannot collide
and a snapshot found in the portal a year later says what it came from. It also
means no caller-supplied string reaches a resource path.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any, Dict, Tuple

import httpx

from services import azure_retry

MGMT_BASE = "https://management.azure.com"
DISK_API = "2023-04-02"
REQUEST_TIMEOUT = 60.0

# Azure's limit for a snapshot name is 80 characters. The suffix this module
# adds is 16 ("-snap-YYYYMMDDHHMM"), so the disk's own name is truncated to fit
# rather than the request being refused for a reason the caller cannot act on.
MAX_NAME = 80
SUFFIX_LENGTH = 18

# Azure accepts letters, digits, underscores, hyphens and full stops in a
# snapshot name, and it may not end in a full stop or hyphen.
_UNSAFE = re.compile(r"[^A-Za-z0-9._-]")

# A managed disk id, which is the only thing this module will act on. Matching
# it here means a resource id for something that is not a disk is refused
# before a token is spent on it, and that no path segment is taken on trust.
DISK_ID = re.compile(
    r"^/subscriptions/(?P<sub>[0-9a-fA-F-]{36})"
    r"/resourceGroups/(?P<rg>[^/]+)"
    r"/providers/Microsoft\.Compute/disks/(?P<name>[^/]+)$"
)


def _headers(token: str) -> Dict[str, str]:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def parse_disk_id(resource_id: str) -> Dict[str, str]:
    """Split a managed disk id into its parts, or return an empty dict.

    Returns rather than raises so the caller can record a refused action with a
    reason, which is what every other write path here does.
    """
    match = DISK_ID.match((resource_id or "").strip())
    return dict(match.groupdict()) if match else {}


def snapshot_name(disk_name: str, *, now: datetime | None = None) -> str:
    """A name that says what this is a copy of, and when it was taken.

    Somebody finding this in the portal in six months has no other way to know
    why it exists, and an unexplained snapshot is one that gets deleted or --
    worse -- kept forever because nobody dares.
    """
    stamp = (now or datetime.now(timezone.utc)).strftime("%Y%m%d%H%M")
    safe = _UNSAFE.sub("-", disk_name)[: MAX_NAME - SUFFIX_LENGTH]
    # A trailing hyphen or dot is rejected by Azure, and truncation is how one
    # appears: the character that made the cut is not chosen, it is wherever
    # the limit fell.
    safe = safe.rstrip(".-") or "disk"
    return f"{safe}-snap-{stamp}"


async def read_disk(
    client: httpx.AsyncClient, token: str, resource_id: str
) -> Tuple[Dict[str, Any], str]:
    """The disk as Azure describes it, or why it could not be read.

    Read before the snapshot is created, for two reasons that both matter. The
    location is needed -- a snapshot must be created in the disk's own region
    and there is no way to infer it from the id. And the size and SKU are what
    the audit record needs in order to mean anything later: "deleted a disk" is
    not a fact anybody can act on, "deleted a 1 TiB Premium_LRS disk" is.
    """
    url = f"{MGMT_BASE}{resource_id}"
    try:
        response = await azure_retry.send_with_retry(
            lambda: client.get(
                url, params={"api-version": DISK_API},
                headers=_headers(token), timeout=REQUEST_TIMEOUT,
            )
        )
    except httpx.HTTPError as exc:
        return {}, f"Azure could not be reached ({exc.__class__.__name__})."

    if response.status_code == 404:
        return {}, "That disk no longer exists in Azure."
    if response.status_code >= 400:
        return {}, _azure_message(response)

    try:
        return response.json(), ""
    except ValueError:
        return {}, "Azure returned a disk description that could not be read."


def describe(disk: Dict[str, Any]) -> Dict[str, Any]:
    """The handful of facts about a disk worth keeping in an audit record.

    Deliberately not the whole payload. A record that stores everything is one
    nobody reads, and the fields that matter when reviewing a deletion are what
    it cost, how big it was, and whether anything was attached to it.
    """
    properties = disk.get("properties") or {}
    sku = disk.get("sku") or {}
    return {
        "name": disk.get("name") or "",
        "location": disk.get("location") or "",
        "sku": sku.get("name") or "",
        "size_gb": properties.get("diskSizeGB"),
        # "Unattached" is the state that makes a disk a candidate for deletion,
        # so it is recorded as Azure reported it at the moment of the change
        # rather than as the finding that led here, which may be hours old.
        "disk_state": properties.get("diskState") or "",
        "managed_by": properties.get("managedBy") or disk.get("managedBy") or "",
    }


async def create_snapshot(
    client: httpx.AsyncClient,
    token: str,
    *,
    disk: Dict[str, Any],
    disk_id: str,
    name: str,
) -> Tuple[bool, str, Dict[str, Any]]:
    """Copy a disk into a snapshot. Returns (ok, error message, snapshot facts).

    The disk is untouched by this: a snapshot is a read of it, and nothing
    about the running system changes. That is what makes this safe to offer
    without the confirmation an actual deletion needs.
    """
    parts = parse_disk_id(disk_id)
    if not parts:
        return False, "That is not a managed disk.", {}

    location = disk.get("location") or ""
    if not location:
        # Refused rather than guessed. A snapshot must live in the disk's own
        # region, and a wrong guess would either fail confusingly or -- worse --
        # succeed somewhere that quietly costs cross-region money.
        return False, "Azure did not report which region that disk is in.", {}

    url = (
        f"{MGMT_BASE}/subscriptions/{parts['sub']}"
        f"/resourceGroups/{parts['rg']}"
        f"/providers/Microsoft.Compute/snapshots/{name}"
    )
    body = {
        "location": location,
        "sku": {"name": "Standard_LRS"},
        "properties": {
            "incremental": True,
            "creationData": {"createOption": "Copy", "sourceResourceId": disk_id},
        },
    }

    try:
        response = await azure_retry.send_with_retry(
            lambda: client.put(
                url, params={"api-version": DISK_API},
                headers=_headers(token), json=body, timeout=REQUEST_TIMEOUT,
            )
        )
    except httpx.HTTPError as exc:
        return False, f"Azure could not be reached ({exc.__class__.__name__}).", {}

    if response.status_code >= 400:
        return False, _azure_message(response), {}

    snapshot_id = f"{url.removeprefix(MGMT_BASE)}"
    return True, "", {
        "snapshot_id": snapshot_id,
        "snapshot_name": name,
        "location": location,
        "incremental": True,
        "sku": "Standard_LRS",
        "source_disk_id": disk_id,
        # Azure answers a snapshot creation with 202 and completes it in the
        # background. Saying "Creating" is the truth at the moment of the
        # reply; claiming it is finished would be a guess, and the difference
        # matters to anyone about to delete the disk on the strength of it.
        "state": "Succeeded" if response.status_code == 200 else "Creating",
    }


def _azure_message(response: httpx.Response) -> str:
    """Azure's own explanation, preferred over anything invented here.

    Azure knows why it refused; this module only knows that it did. A quota
    message or a named missing permission is worth far more to the reader than
    a tidy sentence written in advance.
    """
    try:
        payload = response.json()
    except ValueError:
        payload = {}
    error = payload.get("error") or {}
    message = error.get("message") or ""
    if message:
        return message
    if response.status_code == 403:
        return (
            "Azure refused this change. Creating a snapshot needs "
            "Microsoft.Compute/snapshots/write on the resource group."
        )
    return f"Azure refused the request ({response.status_code})."
