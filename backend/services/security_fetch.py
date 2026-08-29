"""
Reading Advisor, Defender, Policy and RBAC out of Azure, and storing snapshots.

Every function here shares one rule, taken from the roadmap and worth stating
because it drives most of the code: **an absent permission must degrade the
page, never break it.** These four data sources sit behind four different
providers, and a real tenant almost never grants all four evenly. Reader covers
`Microsoft.Authorization/*/read`; Defender needs Security Reader; Policy Insights
is frequently scoped only at management-group level. A design that requires all
of them returns a stack trace to somebody who was entitled to see three quarters
of the answer.

So a 403 on one subscription is recorded as a named gap and the other
subscriptions are still returned, with the response saying exactly which
permission was missing and where. Silence would be worse than an error: an empty
Defender page reads as "nothing wrong", which is the single most dangerous thing
a security tool can imply.
"""
import asyncio
import json
import logging
from typing import Any, Dict, List, Optional, Tuple

import httpx

from services import security_posture as posture

log = logging.getLogger(__name__)

MGMT_BASE = "https://management.azure.com"

ADVISOR_API = "2020-01-01"
ASSESSMENTS_API = "2021-06-01"
ALERTS_API = "2022-01-01"
SECURE_SCORE_API = "2020-01-01"
PRICINGS_API = "2023-01-01"
POLICY_STATES_API = "2019-10-01"
POLICY_ASSIGNMENTS_API = "2022-06-01"
POLICY_EXEMPTIONS_API = "2022-07-01-preview"
ROLE_ASSIGNMENTS_API = "2022-04-01"
ROLE_DEFINITIONS_API = "2022-04-01"

# Which permission a caller is missing, per source. Reported verbatim so the
# person reading the gap can hand it to whoever grants roles without translating.
PERMISSION_FOR = {
    posture.ADVISOR: "Reader (Microsoft.Advisor/recommendations/read)",
    posture.DEFENDER: "Security Reader (Microsoft.Security/assessments/read)",
    posture.POLICY: "Reader (Microsoft.PolicyInsights/policyStates/read)",
    posture.RBAC: "Reader (Microsoft.Authorization/roleAssignments/read)",
}

# One subscription should never hold up the rest. Ninety seconds is past the
# point where the answer is still wanted.
PER_SUBSCRIPTION_BUDGET = 90.0
MAX_CONCURRENT = 4

# Azure throttles per-subscription per-provider. Two retries is enough to ride
# out a burst caused by our own fan-out without turning one slow subscription
# into a ninety-second stall for everybody else.
THROTTLE_RETRIES = 2
MAX_RETRY_WAIT = 20.0


def _retry_after(response: httpx.Response) -> float:
    """How long Azure asked us to wait, clamped to something a request can survive."""
    raw = response.headers.get("Retry-After") or response.headers.get("retry-after")
    try:
        wait = float(raw)
    except (TypeError, ValueError):
        wait = 2.0
    return max(0.5, min(wait, MAX_RETRY_WAIT))


def _headers(token: str) -> Dict[str, str]:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def describe_failure(exc: Exception, source: str, subscription_id: str) -> Dict[str, Any]:
    """
    One failed subscription, described in terms the reader can act on.

    The distinction that matters is 403 versus everything else. A 403 is a
    configuration fact — this account was not granted that provider — and the
    fix is a role assignment. Anything else is a transient failure and the fix
    is to try again. Presenting both as "failed" sends people to the wrong
    place.
    """
    entry = {
        "source": source,
        "subscription_id": subscription_id,
        "kind": "error",
        "permission": "",
        "message": str(exc),
    }

    if isinstance(exc, asyncio.TimeoutError):
        entry["message"] = (
            f"Timed out after {PER_SUBSCRIPTION_BUDGET:.0f}s. Everything else on "
            "this page is complete; only this subscription is missing."
        )
        return entry

    if isinstance(exc, httpx.HTTPStatusError):
        code = exc.response.status_code
        if code in (401, 403):
            entry["kind"] = "permission"
            entry["permission"] = PERMISSION_FOR.get(source, "")
            entry["message"] = (
                f"Access denied. This needs {PERMISSION_FOR.get(source, 'read access')} "
                "on the subscription. Results below exclude it — they are not a "
                "statement that it is clean."
            )
            return entry
        if code == 404:
            entry["kind"] = "unavailable"
            entry["message"] = (
                "The provider is not registered on this subscription, so it has "
                "no data to give rather than data being withheld."
            )
            return entry
        if code == 429:
            # Distinct from a plain failure: the data exists and we are
            # entitled to it, Azure is simply rate limiting. Telling somebody
            # to check their permissions here sends them to the wrong place.
            entry["kind"] = "throttled"
            entry["message"] = (
                "Azure rate limited this request after "
                f"{THROTTLE_RETRIES} retries. The data exists and this account "
                "can read it — narrow the subscription selection or try again "
                "shortly."
            )
            return entry
        entry["message"] = f"Azure returned HTTP {code}."

    return entry


async def _send(client: httpx.AsyncClient, request) -> httpx.Response:
    """
    Issue one ARM request, riding out throttling.

    A 429 is not a failure of the query, it is Azure asking us to slow down --
    usually because of our own fan-out. Retrying it here keeps a transient
    burst from being reported to the user as a missing subscription, which
    would read as "no findings" on a security page.
    """
    attempt = 0
    while True:
        response = await request()
        if response.status_code != 429 or attempt >= THROTTLE_RETRIES:
            response.raise_for_status()
            return response
        await asyncio.sleep(_retry_after(response))
        attempt += 1


async def _get_all(
    client: httpx.AsyncClient,
    url: str,
    token: str,
    max_pages: int = 20,
    flags: Optional[Dict[str, Any]] = None,
) -> List[Dict[str, Any]]:
    """
    GET a paged ARM collection, following nextLink.

    If the collection is longer than `max_pages` the caller is told so through
    `flags`. Silently returning the first slice would be the worst possible
    outcome here: the short read gets written to a snapshot as if it were
    complete, and the next diff reports every unread finding as "resolved".
    """
    values: List[Dict[str, Any]] = []
    next_url: Optional[str] = url
    pages = 0

    while next_url and pages < max_pages:
        response = await _send(client, lambda u=next_url: client.get(u, headers=_headers(token)))
        payload = response.json()
        values.extend(payload.get("value") or [])
        next_url = payload.get("nextLink")
        pages += 1

    if next_url and flags is not None:
        flags["truncated"] = True

    return values


async def _post_all(
    client: httpx.AsyncClient,
    url: str,
    token: str,
    body: Dict[str, Any],
    max_pages: int = 20,
    flags: Optional[Dict[str, Any]] = None,
) -> List[Dict[str, Any]]:
    """POST a paged ARM collection (Policy Insights uses POST for queries)."""
    values: List[Dict[str, Any]] = []
    next_url: Optional[str] = url
    pages = 0

    while next_url and pages < max_pages:
        response = await _send(
            client, lambda u=next_url: client.post(u, headers=_headers(token), json=body)
        )
        payload = response.json()
        values.extend(payload.get("value") or [])
        next_url = payload.get("@odata.nextLink") or payload.get("nextLink")
        pages += 1

    if next_url and flags is not None:
        flags["truncated"] = True

    return values


# ---------------------------------------------------------------------------
# Per-subscription fetchers
# ---------------------------------------------------------------------------

async def fetch_advisor(token: str, subscription_id: str) -> List[Dict[str, Any]]:
    """Advisor recommendations for one subscription."""
    url = (
        f"{MGMT_BASE}/subscriptions/{subscription_id}"
        f"/providers/Microsoft.Advisor/recommendations?api-version={ADVISOR_API}"
    )
    async with httpx.AsyncClient(timeout=60) as client:
        raw = await _get_all(client, url, token)
    return [posture.normalise_advisor(item) for item in raw]


async def fetch_defender(token: str, subscription_id: str) -> Dict[str, Any]:
    """
    Defender assessments, alerts, secure score and plan coverage for one subscription.

    Assessments are filtered to the unhealthy ones. A healthy assessment is a
    finding that does not exist, and a large estate produces tens of thousands
    of them -- carrying those into a diff would swamp every real change.

    Plan coverage is read because without it an empty result is unreadable. A
    subscription with every Defender plan on Free tier reports no assessments
    at all, which is indistinguishable from a subscription that is genuinely
    clean unless we go and ask which plans are switched on.
    """
    base = f"{MGMT_BASE}/subscriptions/{subscription_id}/providers/Microsoft.Security"
    flags: Dict[str, Any] = {}

    async with httpx.AsyncClient(timeout=90) as client:
        # Each of the four reads is a separate permission in practice. A tenant
        # that grants alert access but not assessment access must still get its
        # alerts -- those are the findings saying something may already have
        # been exploited, and they are the worst possible thing to drop.
        assessments_raw, assessments_error = await _optional(
            _get_all(client, f"{base}/assessments?api-version={ASSESSMENTS_API}", token, flags=flags)
        )
        alerts_raw, _ = await _optional(
            _get_all(client, f"{base}/alerts?api-version={ALERTS_API}", token)
        )
        scores_raw, _ = await _optional(
            _get_all(client, f"{base}/secureScores?api-version={SECURE_SCORE_API}", token)
        )
        pricings_raw, _ = await _optional(
            _get_all(client, f"{base}/pricings?api-version={PRICINGS_API}", token)
        )

    # If assessments were denied *and* nothing else came back, there is no
    # answer here at all -- report it as the permission failure it is rather
    # than as a clean subscription.
    if assessments_error is not None and not alerts_raw and not scores_raw:
        raise assessments_error

    assessments = [posture.normalise_assessment(a) for a in assessments_raw]
    unhealthy = [a for a in assessments if a["status"].lower() != "healthy"]

    active = [
        posture.normalise_alert(a) for a in alerts_raw
        if str((a.get("properties") or {}).get("status", "")).lower() not in ("dismissed", "resolved")
    ]

    return {
        "assessments": unhealthy,
        "alerts": active,
        "secure_score": _secure_score(scores_raw, subscription_id),
        "assessed_count": len(assessments),
        "plans": _defender_plans(pricings_raw, subscription_id),
        "assessments_denied": assessments_error is not None,
        "truncated": bool(flags.get("truncated")),
    }


async def _optional(coro) -> Tuple[List[Dict[str, Any]], Optional[Exception]]:
    """Await a secondary read, returning the failure instead of raising it."""
    try:
        return await coro, None
    except httpx.HTTPError as exc:
        return [], exc


def _defender_plans(raw: List[Dict[str, Any]], subscription_id: str) -> Dict[str, Any]:
    """
    Which Defender plans are actually paid for on this subscription.

    Without this, "no findings" is ambiguous. With it, the page can say "no
    findings because Defender is not switched on for these five resource
    types", which is a completely different sentence and the only honest one.
    """
    enabled: List[str] = []
    disabled: List[str] = []

    for item in raw:
        name = str(item.get("name") or "").strip()
        if not name:
            continue
        tier = str(((item.get("properties") or {}).get("pricingTier")) or "").lower()
        if tier == "standard":
            enabled.append(name)
        elif tier == "free":
            disabled.append(name)

    if not raw:
        return {
            "subscription_id": subscription_id,
            "known": False,
            "enabled": [],
            "disabled": [],
            "note": (
                "Defender plan coverage could not be read for this subscription, "
                "so an empty result here cannot be read as either clean or "
                "unmonitored."
            ),
        }

    return {
        "subscription_id": subscription_id,
        "known": True,
        "enabled": sorted(enabled),
        "disabled": sorted(disabled),
        "note": "",
    }


def _secure_score(raw: List[Dict[str, Any]], subscription_id: str) -> Optional[Dict[str, Any]]:
    """
    The ASC default secure score, as a percentage and its raw fraction.

    Both are kept. The percentage is what people quote; the fraction is what
    makes it comparable, because a score of 70% over 40 controls and 70% over
    400 are not the same achievement.
    """
    for item in raw:
        props = item.get("properties") or {}
        score = props.get("score") or {}
        if score.get("max"):
            return {
                "subscription_id": subscription_id,
                "name": item.get("name") or "ascScore",
                "current": round(float(score.get("current") or 0), 2),
                "max": round(float(score.get("max") or 0), 2),
                "percentage": round(float(score.get("percentage") or 0) * 100, 1),
                "weight": props.get("weight"),
            }
    return None


async def fetch_policy(token: str, subscription_id: str, now_iso: str = "") -> Dict[str, Any]:
    """
    Policy compliance states, assignments and exemptions for one subscription.

    `latest` is the summarise-at-source query: it returns the current evaluation
    per resource rather than the full evaluation history, which for a large
    estate is the difference between a page load and a timeout.
    """
    states_url = (
        f"{MGMT_BASE}/subscriptions/{subscription_id}"
        f"/providers/Microsoft.PolicyInsights/policyStates/latest/queryResults"
        f"?api-version={POLICY_STATES_API}&$top=1000"
    )
    assignments_url = (
        f"{MGMT_BASE}/subscriptions/{subscription_id}"
        f"/providers/Microsoft.Authorization/policyAssignments"
        f"?api-version={POLICY_ASSIGNMENTS_API}"
    )
    exemptions_url = (
        f"{MGMT_BASE}/subscriptions/{subscription_id}"
        f"/providers/Microsoft.Authorization/policyExemptions"
        f"?api-version={POLICY_EXEMPTIONS_API}"
    )

    flags: Dict[str, Any] = {}
    async with httpx.AsyncClient(timeout=90) as client:
        states_raw = await _post_all(client, states_url, token, {}, flags=flags)
        assignments_raw, _ = await _optional(_get_all(client, assignments_url, token))
        exemptions_raw, _ = await _optional(_get_all(client, exemptions_url, token))

    states = [posture.normalise_policy_state(s) for s in states_raw]

    return {
        # Only the non-compliant states are findings. The compliant ones are
        # still counted, because a compliance rate needs both halves.
        "states": [s for s in states if not s["is_compliant"]],
        "evaluated_count": len(states),
        "compliant_count": sum(1 for s in states if s["is_compliant"]),
        "assignments": [posture.normalise_policy_assignment(a) for a in assignments_raw],
        "exemptions": [posture.normalise_exemption(e, now_iso) for e in exemptions_raw],
        "truncated": bool(flags.get("truncated")),
    }


async def fetch_role_assignments(
    token: str,
    subscription_id: str,
    subscription_names: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    """
    Role assignments and role definitions for one subscription.

    Definitions are fetched alongside because an assignment carries only a
    definition GUID. Resolving those names client-side would be one request per
    distinct role; fetching the definition list once is a single request that
    resolves all of them.

    Subscription display names are passed in rather than fetched, because the
    caller already read the subscription list to decide this request was
    allowed at all. Asking Azure again, once per subscription, for a name it
    has already handed over would be the classic N+1.

    Principal *names* are resolved separately, by the router, using Microsoft
    Graph. That needs its own consent, so it cannot be done here and must not
    be allowed to fail this read.
    """
    base = f"{MGMT_BASE}/subscriptions/{subscription_id}/providers/Microsoft.Authorization"

    flags: Dict[str, Any] = {}
    async with httpx.AsyncClient(timeout=90) as client:
        assignments_raw = await _get_all(
            client, f"{base}/roleAssignments?api-version={ROLE_ASSIGNMENTS_API}", token, flags=flags
        )
        definitions_raw, _ = await _optional(
            _get_all(client, f"{base}/roleDefinitions?api-version={ROLE_DEFINITIONS_API}", token)
        )

    role_names = {}
    custom = set()
    permissions: Dict[str, Dict[str, Any]] = {}
    for definition in definitions_raw:
        props = definition.get("properties") or {}
        key = str(definition.get("name") or "").lower()
        role_names[key] = props.get("roleName") or ""
        if str(props.get("type") or "").lower() == "customrole":
            custom.add(key)
        permissions[key] = _role_power(props)

    from services import access_review

    assignments = []
    for raw in assignments_raw:
        item = access_review.normalise_assignment(
            raw, role_names=role_names, subscription_names=subscription_names
        )
        definition_key = item["role_definition_id"].rsplit("/", 1)[-1].lower()
        if definition_key in custom:
            item["is_custom"] = True
        # What the role can actually do, taken from the definition rather than
        # inferred from its name. A custom role called "Reader" that holds a
        # write action is exactly the assignment a name-based check misses.
        item["permissions"] = permissions.get(definition_key) or _role_power({})
        assignments.append(item)

    return {
        "assignments": assignments,
        "definition_count": len(definitions_raw),
        "definitions_read": bool(definitions_raw),
        "truncated": bool(flags.get("truncated")),
    }


def _role_power(props: Dict[str, Any]) -> Dict[str, Any]:
    """
    Reduce a role definition's permission arrays to what a reviewer needs.

    Three questions decide whether an assignment is dangerous, and none of them
    can be answered from the role's name: can it write, can it delete, and can
    it grant access to somebody else. The last is the one that matters most --
    a principal that can write role assignments can give itself anything else.
    """
    actions: List[str] = []
    data_actions: List[str] = []
    for block in props.get("permissions") or []:
        actions.extend(str(a) for a in (block.get("actions") or []))
        data_actions.extend(str(a) for a in (block.get("dataActions") or []))

    lowered = [a.lower() for a in actions]

    def covers(action: str, needle: str) -> bool:
        """Does one declared action grant `needle`, honouring a trailing wildcard?"""
        if action == "*":
            return True
        if action.endswith("*"):
            return needle.startswith(action[:-1])
        return action == needle

    can_write = any(a == "*" or a.endswith("/write") or a.endswith("*") for a in lowered)
    can_delete = any(a == "*" or a.endswith("/delete") or a.endswith("*") for a in lowered)
    can_grant = any(
        covers(a, "microsoft.authorization/roleassignments/write") for a in lowered
    )

    return {
        "known": bool(actions or data_actions),
        "action_count": len(actions),
        "data_action_count": len(data_actions),
        "can_write": can_write,
        "can_delete": can_delete,
        "can_grant_access": can_grant,
    }


# ---------------------------------------------------------------------------
# Fan-out
# ---------------------------------------------------------------------------

async def across_subscriptions(
    subscription_ids: List[str],
    fetch,
    source: str,
) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    """
    Run one fetcher over every subscription at once, keeping partial results.

    Concurrent rather than sequential: eight subscriptions read one after
    another is eight round trips of latency stacked end to end, and that alone
    is what turns a working page into a timeout as an estate grows.

    A failure never propagates. It becomes a named gap and the remaining
    subscriptions still return, because three quarters of a security answer is
    considerably more useful than none of it.
    """
    semaphore = asyncio.Semaphore(MAX_CONCURRENT)
    results: Dict[str, Any] = {}
    errors: List[Dict[str, Any]] = []

    async def one(subscription_id: str):
        async with semaphore:
            try:
                results[subscription_id] = await asyncio.wait_for(
                    fetch(subscription_id), timeout=PER_SUBSCRIPTION_BUDGET
                )
            except Exception as exc:  # noqa: BLE001 - every failure is reported, none is fatal
                log.warning("%s failed for %s: %s", source, subscription_id, exc)
                errors.append(describe_failure(exc, source, subscription_id))

    await asyncio.gather(*(one(s) for s in subscription_ids))
    return results, errors


def coverage_note(
    requested: List[str],
    errors: List[Dict[str, Any]],
    source: str,
) -> str:
    """
    How much of the estate this answer actually covers.

    An empty security page means one of two very different things: nothing is
    wrong, or nothing could be read. Saying which is not optional.
    """
    blocked = {e["subscription_id"] for e in errors if e["kind"] == "permission"}
    throttled = {e["subscription_id"] for e in errors if e["kind"] == "throttled"} - blocked
    unavailable = {e["subscription_id"] for e in errors if e["kind"] == "unavailable"} - blocked
    failed = {e["subscription_id"] for e in errors} - blocked - throttled - unavailable
    covered = len(requested) - len(blocked) - len(throttled) - len(unavailable) - len(failed)

    if not errors:
        return f"All {len(requested)} subscription(s) read successfully."

    parts = [f"{covered} of {len(requested)} subscription(s) read."]
    if blocked:
        parts.append(
            f"{len(blocked)} denied access — this needs "
            f"{PERMISSION_FOR.get(source, 'read permission')}. Those subscriptions "
            "are absent from these results, which is not the same as being clean."
        )
    if throttled:
        parts.append(
            f"{len(throttled)} were rate limited by Azure after retries. That is a "
            "temporary limit, not a permission problem — the findings for those "
            "subscriptions are missing rather than absent."
        )
    if unavailable:
        parts.append(
            f"{len(unavailable)} do not have the provider registered, so they have "
            "no data to give."
        )
    if failed:
        parts.append(f"{len(failed)} failed for other reasons and can be retried.")
    return " ".join(parts)


# ---------------------------------------------------------------------------
# Snapshot storage
# ---------------------------------------------------------------------------

async def save_snapshot(
    db,
    user_id: int,
    tenant_id: str,
    kind: str,
    findings: List[Dict[str, Any]],
    subscriptions: List[str],
    errors: Optional[List[Dict[str, Any]]] = None,
) -> int:
    """
    Write one reading down, so a future scan has something to compare against.

    A snapshot taken while half the estate was denied would poison the next
    diff — every unreadable subscription's findings would show as resolved. The
    errors are stored with the snapshot so the comparison can say so.
    """
    summary = posture.summarise(findings)
    cursor = await db.execute(
        """
        INSERT INTO posture_snapshots
            (user_id, tenant_id, kind, subscriptions, finding_count,
             high_count, summary, findings, errors)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
        """,
        (
            user_id,
            tenant_id,
            kind,
            json.dumps(subscriptions),
            summary["total"],
            summary["high_count"],
            json.dumps(summary),
            posture.pack(findings),
            json.dumps(errors or []),
        ),
    )
    snapshot_id = (await cursor.fetchone())[0]
    await db.commit()
    return snapshot_id


async def recent_snapshots(
    db,
    user_id: int,
    tenant_id: str,
    kind: str,
    limit: int = 20,
) -> List[Dict[str, Any]]:
    """
    Snapshot headers, newest first. Ownership is enforced in SQL.

    Filtering by owner after the fact would mean the row was already read;
    snapshot ids are sequential and therefore guessable, so the ownership test
    belongs in the WHERE clause where it cannot be forgotten.
    """
    async with db.execute(
        """
        SELECT id, captured_at, finding_count, high_count, summary, subscriptions, errors
        FROM posture_snapshots
        WHERE user_id = ? AND tenant_id = ? AND kind = ?
        ORDER BY id DESC LIMIT ?
        """,
        (user_id, tenant_id, kind, limit),
    ) as cursor:
        rows = await cursor.fetchall()

    return [
        {
            "id": row[0],
            "captured_at": row[1],
            "finding_count": row[2],
            "high_count": row[3],
            "summary": json.loads(row[4] or "{}"),
            "subscriptions": json.loads(row[5] or "[]"),
            "errors": json.loads(row[6] or "[]"),
        }
        for row in rows
    ]


async def load_snapshot(
    db,
    user_id: int,
    tenant_id: str,
    snapshot_id: int,
) -> Optional[Dict[str, Any]]:
    """One snapshot with its findings, or None if it is not this user's."""
    async with db.execute(
        """
        SELECT id, kind, captured_at, findings, subscriptions, errors
        FROM posture_snapshots
        WHERE id = ? AND user_id = ? AND tenant_id = ?
        """,
        (snapshot_id, user_id, tenant_id),
    ) as cursor:
        row = await cursor.fetchone()

    if not row:
        return None
    return {
        "id": row[0],
        "kind": row[1],
        "captured_at": row[2],
        "findings": posture.unpack(row[3]),
        "subscriptions": json.loads(row[4] or "[]"),
        "errors": json.loads(row[5] or "[]"),
    }


async def previous_snapshot(
    db,
    user_id: int,
    tenant_id: str,
    kind: str,
    before_id: Optional[int] = None,
) -> Optional[Dict[str, Any]]:
    """The snapshot immediately before a given one — the other half of a diff."""
    if before_id:
        sql = """
            SELECT id FROM posture_snapshots
            WHERE user_id = ? AND tenant_id = ? AND kind = ? AND id < ?
            ORDER BY id DESC LIMIT 1
        """
        args = (user_id, tenant_id, kind, before_id)
    else:
        sql = """
            SELECT id FROM posture_snapshots
            WHERE user_id = ? AND tenant_id = ? AND kind = ?
            ORDER BY id DESC LIMIT 1
        """
        args = (user_id, tenant_id, kind)

    async with db.execute(sql, args) as cursor:
        row = await cursor.fetchone()

    if not row:
        return None
    return await load_snapshot(db, user_id, tenant_id, row[0])
