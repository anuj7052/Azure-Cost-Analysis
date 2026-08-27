"""
Turning directory object ids into the names of the people they belong to.

Azure's role-assignment API answers with object ids and nothing else. It knows
who "265b1023-8610-487b-8eac-76245f735289" is, but it will not say -- that
belongs to Microsoft Graph, which is a different service, a different audience
and a different consent. Until now the application had no way to ask, so every
screen in the security section showed the GUID and hoped the reader recognised
it. Nobody recognises a GUID.

Two things follow from Graph being a separate audience.

The first is that the ARM token the rest of this application uses cannot be
reused here; Graph rejects it. The browser holds a Graph token or it does not,
so this module takes one as an argument and is honest when it is absent.

The second is that consent may be missing even when a token is present.
`Directory.Read.All` is admin-consented in most tenants, and a signed-in user
who has not been granted it gets a 403. That is a configuration fact the reader
can act on, so it is reported as such rather than being flattened into "no name
found" -- an unresolved id because nobody asked and an unresolved id because
Azure refused are different problems with different fixes.

Nothing here ever fails a request. A security page that cannot show names is
degraded; a security page that shows nothing is broken.
"""

from __future__ import annotations

import asyncio
import hashlib
import time
from typing import Any, Dict, Iterable, List, Optional, Tuple

import httpx

GRAPH_BASE = "https://graph.microsoft.com/v1.0"

# Graph accepts up to 1000 ids per getByIds call. Larger estates are chunked.
BATCH_SIZE = 1000

# Chunks run in parallel, but only a few at a time. Graph throttles hard and
# answers 429 with a Retry-After, and a burst that trips it is slower than a
# trickle that does not.
MAX_CONCURRENT = 3

REQUEST_TIMEOUT = 30.0
THROTTLE_RETRIES = 2
MAX_RETRY_WAIT = 20.0

# Directory membership changes rarely, and the same ids are requested by every
# page in the section on every scan. Five minutes matches the subscription
# cache in token_resolver.
_CACHE: Dict[Tuple[str, str], Tuple[float, Dict[str, Any]]] = {}
_CACHE_TTL = 300.0

# Graph's @odata.type values, mapped to the vocabulary the rest of the
# application already speaks. `access_review.principal_kind` expects these.
_TYPE_MAP = {
    "#microsoft.graph.user": "User",
    "#microsoft.graph.group": "Group",
    "#microsoft.graph.serviceprincipal": "Service principal",
    "#microsoft.graph.application": "Application",
    "#microsoft.graph.device": "Device",
    "#microsoft.graph.orgcontact": "Contact",
}

REASON_NO_TOKEN = "no_token"
REASON_DENIED = "denied"
REASON_UNAVAILABLE = "unavailable"

NOTE_NO_TOKEN = (
    "Names were not looked up because the browser did not supply a Microsoft "
    "Graph token. Object ids below are unresolved, not unknown to Azure."
)
NOTE_DENIED = (
    "Microsoft Graph refused the directory lookup, so accounts appear by object "
    "id. This needs the Directory.Read.All permission to be consented for this "
    "application. An object id here means nobody was allowed to ask who it is."
)
NOTE_UNAVAILABLE = (
    "Microsoft Graph could not be reached, so accounts appear by object id. "
    "This is a failed lookup, not a finding about the accounts themselves."
)
NOTE_OK = (
    "Account names were read from Microsoft Graph. Any remaining object id is "
    "an account Graph did not return -- usually one deleted from the directory "
    "while its access was left behind."
)


def _cache_key(tenant_id: str, token: str) -> Tuple[str, str]:
    """
    A cache key that identifies the credential without storing it.

    The raw token is a bearer credential; keeping it as a dictionary key would
    put it in every heap dump and every debugger session for the life of the
    process. The digest identifies it just as precisely and is worthless to an
    attacker.
    """
    digest = hashlib.sha256((token or "").encode("utf-8")).hexdigest()
    return (tenant_id or "", digest)


def _headers(token: str) -> Dict[str, str]:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def _retry_after(response: httpx.Response) -> float:
    raw = response.headers.get("Retry-After", "")
    try:
        wait = float(raw)
    except (TypeError, ValueError):
        wait = 2.0
    return min(max(wait, 1.0), MAX_RETRY_WAIT)


def _classify(exc: Exception) -> str:
    """Which of the three failures this was, in the reader's terms."""
    if isinstance(exc, httpx.HTTPStatusError):
        code = exc.response.status_code
        if code in (401, 403):
            return REASON_DENIED
    return REASON_UNAVAILABLE


def chunk(ids: List[str], size: int = BATCH_SIZE) -> List[List[str]]:
    return [ids[i : i + size] for i in range(0, len(ids), size)]


def clean_ids(values: Iterable[Any]) -> List[str]:
    """
    The distinct, lower-cased object ids worth asking about.

    Duplicates matter here: one principal commonly holds forty assignments, and
    sending its id forty times would waste most of the batch budget on repeats.
    """
    seen: Dict[str, None] = {}
    for value in values:
        text = str(value or "").strip().lower()
        if text:
            seen.setdefault(text, None)
    return list(seen.keys())


def _entry(obj: Dict[str, Any]) -> Dict[str, Any]:
    """
    One Graph object, reduced to what a security screen needs.

    `display_name` falls back through the fields Graph populates for different
    object types -- users have displayName, some service principals only carry
    appDisplayName -- so that a name is missed only when Graph really has none.
    """
    kind = _TYPE_MAP.get(str(obj.get("@odata.type") or "").lower(), "")
    display = (
        obj.get("displayName")
        or obj.get("appDisplayName")
        or obj.get("userPrincipalName")
        or ""
    )
    return {
        "display_name": str(display).strip(),
        "upn": str(obj.get("userPrincipalName") or obj.get("mail") or "").strip(),
        "type": kind,
        "object_id": str(obj.get("id") or "").strip(),
        "enabled": obj.get("accountEnabled"),
    }


async def _send(client: httpx.AsyncClient, request) -> httpx.Response:
    """POST with a bounded retry on 429, mirroring the ARM client's behaviour."""
    attempt = 0
    while True:
        response = await request()
        if response.status_code != 429 or attempt >= THROTTLE_RETRIES:
            response.raise_for_status()
            return response
        await asyncio.sleep(_retry_after(response))
        attempt += 1


async def _fetch_batch(
    client: httpx.AsyncClient, token: str, ids: List[str]
) -> List[Dict[str, Any]]:
    """
    One getByIds call.

    `types` is restricted to the three kinds that can actually hold an Azure
    role. Leaving it open makes Graph search object types that can never appear
    in a role assignment, which is slower and returns nothing useful.
    """
    body = {"ids": ids, "types": ["user", "group", "servicePrincipal"]}
    response = await _send(
        client,
        lambda: client.post(
            f"{GRAPH_BASE}/directoryObjects/getByIds",
            headers=_headers(token),
            json=body,
            timeout=REQUEST_TIMEOUT,
        ),
    )
    payload = response.json()
    return payload.get("value") or []


async def resolve_principals(
    graph_token: Optional[str],
    object_ids: Iterable[Any],
    tenant_id: str = "",
) -> Dict[str, Any]:
    """
    Look up who each object id belongs to.

    Returns `principals` keyed by lower-cased object id, in exactly the shape
    `access_review.normalise_assignment` already accepts as its `principals`
    argument -- that parameter has been there all along with nothing to fill it.

    The `resolved` flag says whether the lookup happened at all, which the
    caller needs in order to tell "this account has no name" apart from "nobody
    looked". `reason` and `note` explain which of the three ways it failed.
    """
    wanted = clean_ids(object_ids)
    if not wanted:
        return {
            "principals": {},
            "resolved": bool(graph_token),
            "reason": None if graph_token else REASON_NO_TOKEN,
            "note": "" if graph_token else NOTE_NO_TOKEN,
            "requested": 0,
            "found": 0,
        }

    if not graph_token:
        return {
            "principals": {},
            "resolved": False,
            "reason": REASON_NO_TOKEN,
            "note": NOTE_NO_TOKEN,
            "requested": len(wanted),
            "found": 0,
        }

    key = _cache_key(tenant_id, graph_token)
    cached = _CACHE.get(key)
    known: Dict[str, Dict[str, Any]] = {}
    if cached and (time.monotonic() - cached[0]) < _CACHE_TTL:
        known = dict(cached[1])

    missing = [oid for oid in wanted if oid not in known]

    if missing:
        semaphore = asyncio.Semaphore(MAX_CONCURRENT)

        async def one(
            client: httpx.AsyncClient, batch: List[str]
        ) -> List[Dict[str, Any]]:
            async with semaphore:
                return await _fetch_batch(client, graph_token, batch)

        try:
            async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
                batches = await asyncio.gather(
                    *(one(client, part) for part in chunk(missing))
                )
        except Exception as exc:  # noqa: BLE001 - degraded, never fatal
            reason = _classify(exc)
            return {
                "principals": known,
                "resolved": False,
                "reason": reason,
                "note": NOTE_DENIED if reason == REASON_DENIED else NOTE_UNAVAILABLE,
                "requested": len(wanted),
                "found": len(known),
            }

        for group in batches:
            for obj in group:
                entry = _entry(obj)
                if entry["object_id"]:
                    known[entry["object_id"].lower()] = entry

        _CACHE[key] = (time.monotonic(), dict(known))

    found = {oid: known[oid] for oid in wanted if oid in known}
    return {
        "principals": found,
        "resolved": True,
        "reason": None,
        "note": NOTE_OK,
        "requested": len(wanted),
        "found": len(found),
    }


def apply_names(
    assignments: List[Dict[str, Any]], principals: Dict[str, Dict[str, Any]]
) -> int:
    """
    Write resolved names onto already-normalised assignment rows.

    Patching afterwards rather than threading the directory through the
    per-subscription fan-out is deliberate: the fan-out runs once per
    subscription and would repeat the same directory lookup for each, whereas
    one pass over the merged list asks Graph exactly once for each distinct id.

    Only `resolved: False` rows are touched, so a name Azure did supply is never
    overwritten by a Graph result.
    """
    updated = 0
    for row in assignments:
        if row.get("resolved"):
            continue
        entry = principals.get(str(row.get("principal_id") or "").lower())
        if not entry:
            continue
        name = entry.get("display_name") or entry.get("upn")
        if not name:
            continue
        row["principal_name"] = name
        row["principal_upn"] = entry.get("upn") or row.get("principal_upn") or ""
        row["resolved"] = True
        if entry.get("type"):
            row["principal_type"] = entry["type"]
        if entry.get("enabled") is False:
            row["principal_disabled"] = True
        updated += 1
    return updated


def reset_cache() -> None:
    """Drop the directory cache. Tests rely on this; nothing else should."""
    _CACHE.clear()
