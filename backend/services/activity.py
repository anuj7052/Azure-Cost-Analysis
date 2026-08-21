"""
Who changed what, from the Azure Activity Log.

Snapshot diffs answer "what is different"; they cannot answer "who did it",
because a photograph of the result contains no trace of the actor. The Activity
Log is the only place that identity exists, so this is what turns "a VM was
resized" into "Anna resized it on Tuesday at 14:02".

Two limits are inherent and are surfaced rather than hidden:

  * Azure retains roughly **90 days** of activity. Older changes have an actor
    that no longer exists anywhere, and no amount of querying will recover it.
  * The log records **control-plane operations** — creating, updating, deleting
    resources. Something changed from inside a VM leaves no entry at all.
"""
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import httpx

MGMT_BASE = "https://management.azure.com"
ACTIVITY_API_VERSION = "2015-04-01"

# Azure's own retention. Asking for more returns an empty window rather than an
# error, which reads as "nothing happened" — so the ceiling is enforced here and
# reported to the caller.
MAX_RETENTION_DAYS = 90

log = logging.getLogger(__name__)

# Operations that represent an actual change, as opposed to somebody reading.
# A log dominated by list/read entries buries the handful of writes that matter.
WRITE_HINTS = ("write", "delete", "action", "create")

READ_HINTS = ("read", "list")


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def clamp_window(days: int) -> int:
    """Keep the requested window inside what Azure actually retains."""
    return max(1, min(int(days or 7), MAX_RETENTION_DAYS))


def _value(entry: Dict[str, Any], *path: str) -> str:
    """Read a nested localizedValue, which is where Azure hides readable text."""
    node: Any = entry
    for key in path:
        if not isinstance(node, dict):
            return ""
        node = node.get(key)
    if isinstance(node, dict):
        return str(node.get("localizedValue") or node.get("value") or "")
    return str(node or "")


def caller_of(entry: Dict[str, Any]) -> str:
    """
    Who performed the operation.

    Azure reports a user principal name for a person and a GUID for a service
    principal. The GUID is kept rather than blanked: "an application did this"
    is a materially different answer to "we do not know", and the id is what
    identifies which application.
    """
    caller = (entry.get("caller") or "").strip()
    if caller:
        return caller

    claims = entry.get("claims") or {}
    for key in ("name", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn",
                "appid"):
        value = (claims.get(key) or "").strip()
        if value:
            return value

    return "Unknown"


def is_write(operation: str) -> bool:
    """
    Whether an operation changed something.

    Matching on the operation's last segment, because "…/virtualMachines/write"
    is a change while "…/virtualMachines/read" is not, and both contain the
    resource type.
    """
    tail = (operation or "").rsplit("/", 1)[-1].lower()
    if any(hint in tail for hint in READ_HINTS):
        return False
    return any(hint in tail for hint in WRITE_HINTS)


def describe_operation(operation: str) -> str:
    """
    A readable verb for an operation id.

    "Microsoft.Compute/virtualMachines/write" tells a reader almost nothing at a
    glance; "Created or updated virtual machine" tells them what happened.
    """
    if not operation:
        return "Unknown operation"

    parts = [p for p in operation.split("/") if p]
    verb = parts[-1].lower() if parts else ""
    subject = parts[-2] if len(parts) >= 2 else "resource"

    readable = subject.replace("_", " ")
    readable = "".join(f" {c.lower()}" if c.isupper() else c for c in readable).strip()
    if readable.endswith("sses"):
        readable = readable[:-2]
    elif readable.endswith("ies"):
        readable = f"{readable[:-3]}y"
    elif readable.endswith("s") and not readable.endswith("ss"):
        readable = readable[:-1]

    verbs = {
        "write": "Created or updated",
        "delete": "Deleted",
        "action": "Performed an action on",
        "read": "Read",
        "list": "Listed",
    }
    return f"{verbs.get(verb, verb.title() or 'Changed')} {readable}".strip()


def normalise(entry: Dict[str, Any]) -> Dict[str, Any]:
    """One Activity Log entry, reduced to the fields worth showing."""
    operation = _value(entry, "operationName") or entry.get("operationName", "")
    status = _value(entry, "status") or ""

    return {
        "id": entry.get("eventDataId") or entry.get("id") or "",
        "at": entry.get("eventTimestamp") or entry.get("submissionTimestamp") or "",
        "caller": caller_of(entry),
        "operation": operation,
        "summary": describe_operation(operation),
        "status": status,
        # A failed attempt is not a change, but it is often the more interesting
        # entry — somebody tried and was refused.
        "succeeded": status.lower() in ("succeeded", "success", "accepted", "started"),
        "resource_id": entry.get("resourceId") or "",
        "resource_group": entry.get("resourceGroupName") or "",
        "subscription_id": entry.get("subscriptionId") or "",
        "level": entry.get("level") or "",
        "is_write": is_write(operation),
    }


async def fetch_activity(
    token: str,
    subscription_id: str,
    days: int = 7,
    resource_id: Optional[str] = None,
    resource_group: Optional[str] = None,
    start: Optional[datetime] = None,
    end: Optional[datetime] = None,
    select: Optional[List[str]] = None,
    max_entries: int = 5000,
    timeout: float = 60.0,
) -> List[Dict[str, Any]]:
    """
    Read the Activity Log for one subscription.

    Filtering happens server-side wherever Azure allows it. An estate can
    produce tens of thousands of entries a week, and pulling them all back to
    discard nearly every one wastes the caller's time and Azure's quota — and,
    more practically, takes long enough that the request times out before any of
    it reaches the screen.

    Three narrowing tools, in descending order of effect:

      * ``resource_id`` / ``resource_group`` — Azure filters these itself. Both
        are on the small list of fields ``$filter`` accepts, and either one
        typically removes 99% of an estate's log.
      * ``start`` / ``end`` — an explicit window instead of "N days back from
        now". Asking for one month costs a fraction of asking for ninety days.
      * ``select`` — return five fields instead of the whole entry, including
        the nested properties bag that dominates the payload size.
    """
    finish = end or datetime.now(timezone.utc)
    begin = start or (finish - timedelta(days=clamp_window(days)))

    # Azure returns an empty window rather than an error for a start date beyond
    # retention, which reads as "nothing happened". Clamping keeps the answer
    # truthful and the caller reports the clamp.
    floor = datetime.now(timezone.utc) - timedelta(days=MAX_RETENTION_DAYS)
    if begin < floor:
        begin = floor

    conditions = [
        f"eventTimestamp ge '{_iso(begin)}'",
        f"eventTimestamp le '{_iso(finish)}'",
    ]
    # resourceUri is the narrower of the two, so a caller supplying both gets
    # the narrower one; combining them is not accepted by the endpoint.
    if resource_id:
        conditions.append(f"resourceUri eq '{resource_id}'")
    elif resource_group:
        conditions.append(f"resourceGroupName eq '{resource_group}'")

    url = (
        f"{MGMT_BASE}/subscriptions/{subscription_id}"
        f"/providers/Microsoft.Insights/eventtypes/management/values"
        f"?api-version={ACTIVITY_API_VERSION}"
    )
    params = {"$filter": " and ".join(conditions)}
    if select:
        params["$select"] = ",".join(select)
    headers = {"Authorization": f"Bearer {token}"}

    results: List[Dict[str, Any]] = []
    async with httpx.AsyncClient(timeout=timeout) as client:
        next_url: Optional[str] = url
        first = True
        while next_url:
            response = await client.get(
                next_url,
                headers=headers,
                params=params if first else None,
            )
            response.raise_for_status()
            payload = response.json()
            results.extend(payload.get("value", []))
            next_url = payload.get("nextLink")
            first = False

            # An unbounded follow of nextLink can walk a very large log. Several
            # thousand entries is already past what any UI presents usefully.
            if len(results) >= max_entries:
                break

    return results


def summarise_activity(
    entries: List[Dict[str, Any]],
    writes_only: bool = True,
) -> Dict[str, Any]:
    """
    Group raw Activity Log entries into something readable.

    Reads are excluded by default: they outnumber writes by orders of magnitude
    and answer nobody's question about what changed.
    """
    events = [normalise(e) for e in entries]
    if writes_only:
        events = [e for e in events if e["is_write"]]

    events.sort(key=lambda e: e["at"], reverse=True)

    by_caller: Dict[str, int] = {}
    by_operation: Dict[str, int] = {}
    failed = 0

    for event in events:
        by_caller[event["caller"]] = by_caller.get(event["caller"], 0) + 1
        by_operation[event["summary"]] = by_operation.get(event["summary"], 0) + 1
        if not event["succeeded"]:
            failed += 1

    return {
        "events": events,
        "total": len(events),
        "failed": failed,
        "callers": [
            {"caller": caller, "count": count}
            for caller, count in sorted(by_caller.items(), key=lambda kv: -kv[1])
        ],
        "operations": [
            {"operation": operation, "count": count}
            for operation, count in sorted(by_operation.items(), key=lambda kv: -kv[1])
        ],
        "retention_days": MAX_RETENTION_DAYS,
    }
