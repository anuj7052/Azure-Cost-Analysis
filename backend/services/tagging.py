"""Applying tags to a resource in Azure.

Tags are the first action written on top of `services/actions.py`, and they
were chosen on purpose: this is a cost product, and the single most common
reason a cost report cannot answer "which team is spending this?" is that
nothing is tagged. Until now the app could show that gap and not close it.

The operation is also the safest write in Azure. Nothing about the running
resource changes -- not its size, not its power state, not its data. If a tag
is applied wrongly, applying the right one over it is a complete fix.

One decision worth stating: this **merges** with what is already there rather
than replacing it. Azure's `PUT .../providers/Microsoft.Resources/tags/default`
replaces the entire tag set, which would silently delete tags this application
never knew about -- including the ones another team's automation depends on.
`PATCH` with `operation: Merge` is used instead, and the previous tags are read
first so the audit record can show what changed.
"""
from __future__ import annotations

import re
from typing import Any, Dict, Tuple

import httpx

from services import azure_retry

MGMT_BASE = "https://management.azure.com"
TAGS_API = "2021-04-01"
REQUEST_TIMEOUT = 30.0

# Azure's documented limits. Checked here rather than left to ARM so the caller
# gets a sentence naming the offending tag instead of a generic 400.
MAX_TAGS = 50
MAX_KEY_LENGTH = 512
MAX_VALUE_LENGTH = 256

# Azure rejects these characters in a tag name outright.
INVALID_KEY_CHARS = re.compile(r"[<>%&\\?/]")


def _headers(token: str) -> Dict[str, str]:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def validate_tags(tags: Dict[str, str]) -> str:
    """Return an empty string if the tags are acceptable, else why they are not.

    Returns a message rather than raising for the same reason the resize and
    access services do: the caller has an audit row to close either way, and a
    validation failure should be recorded as a refused change, not lost as an
    exception.
    """
    if not tags:
        return "No tags were given."
    if len(tags) > MAX_TAGS:
        return f"Azure allows at most {MAX_TAGS} tags on a resource; {len(tags)} were given."

    for key, value in tags.items():
        if not key or not key.strip():
            return "A tag name cannot be empty."
        if len(key) > MAX_KEY_LENGTH:
            return f"Tag name '{key[:40]}…' is longer than {MAX_KEY_LENGTH} characters."
        if INVALID_KEY_CHARS.search(key):
            return f"Tag name '{key}' contains a character Azure does not allow (< > % & \\ ? /)."
        if value is None:
            return f"Tag '{key}' has no value. Use an empty string if that is intended."
        if len(str(value)) > MAX_VALUE_LENGTH:
            return f"The value for tag '{key}' is longer than {MAX_VALUE_LENGTH} characters."
    return ""


async def read_tags(
    client: httpx.AsyncClient, token: str, resource_id: str
) -> Tuple[Dict[str, str], str]:
    """The resource's current tags, and an error message if they could not be read.

    Read before every write so the audit record can say what the tags *were*.
    A record that only says what they became cannot answer whether anything
    actually changed.
    """
    url = f"{MGMT_BASE}{resource_id}/providers/Microsoft.Resources/tags/default"
    try:
        response = await azure_retry.send_with_retry(
            lambda: client.get(
                url, params={"api-version": TAGS_API},
                headers=_headers(token), timeout=REQUEST_TIMEOUT,
            )
        )
    except httpx.HTTPError as exc:
        return {}, f"Azure could not be reached ({exc.__class__.__name__})."

    if response.status_code == 404:
        # The resource exists but has never been tagged. An empty set is the
        # correct previous state, not a failure.
        return {}, ""
    if response.status_code >= 400:
        return {}, _azure_message(response)

    try:
        return dict((response.json().get("properties") or {}).get("tags") or {}), ""
    except ValueError:
        return {}, "Azure returned a tag response that could not be read."


async def apply_tags(
    client: httpx.AsyncClient, token: str, resource_id: str, tags: Dict[str, str]
) -> Tuple[bool, str, Dict[str, str]]:
    """Merge `tags` into whatever the resource already carries.

    Returns (ok, error message, the resulting full tag set).
    """
    url = f"{MGMT_BASE}{resource_id}/providers/Microsoft.Resources/tags/default"
    body = {"operation": "Merge", "properties": {"tags": tags}}

    try:
        response = await azure_retry.send_with_retry(
            lambda: client.patch(
                url, params={"api-version": TAGS_API},
                headers=_headers(token), json=body, timeout=REQUEST_TIMEOUT,
            )
        )
    except httpx.HTTPError as exc:
        return False, f"Azure could not be reached ({exc.__class__.__name__}).", {}

    if response.status_code >= 400:
        return False, _azure_message(response), {}

    try:
        applied = dict((response.json().get("properties") or {}).get("tags") or {})
    except ValueError:
        # The write succeeded; only the echo was unreadable. Reporting failure
        # here would tell the user nothing happened when something did.
        applied = {}
    return True, "", applied


def _azure_message(response: httpx.Response) -> str:
    """Azure's own explanation, preferred over anything invented here.

    ARM nests the useful sentence two levels down and sometimes puts it in a
    different place; a status code alone tells the user nothing they can act on.
    """
    try:
        payload = response.json()
    except ValueError:
        return f"Azure refused the tag change (HTTP {response.status_code})."

    error = payload.get("error") if isinstance(payload, dict) else None
    if isinstance(error, dict):
        message = error.get("message") or ""
        if message:
            return str(message)
    return f"Azure refused the tag change (HTTP {response.status_code})."
