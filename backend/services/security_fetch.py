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
        entry["message"] = f"Azure returned HTTP {code}."

    return entry


async def _get_all(
    client: httpx.AsyncClient,
    url: str,
    token: str,
    max_pages: int = 20,
) -> List[Dict[str, Any]]:
    """GET a paged ARM collection, following nextLink."""
    values: List[Dict[str, Any]] = []
    next_url: Optional[str] = url
    pages = 0

    while next_url and pages < max_pages:
        response = await client.get(next_url, headers=_headers(token))
        response.raise_for_status()
        payload = response.json()
        values.extend(payload.get("value") or [])
        next_url = payload.get("nextLink")
        pages += 1

    return values


async def _post_all(
    client: httpx.AsyncClient,
    url: str,
    token: str,
    body: Dict[str, Any],
    max_pages: int = 20,
) -> List[Dict[str, Any]]:
    """POST a paged ARM collection (Policy Insights uses POST for queries)."""
    values: List[Dict[str, Any]] = []
    next_url: Optional[str] = url
    pages = 0

    while next_url and pages < max_pages:
        response = await client.post(next_url, headers=_headers(token), json=body)
        response.raise_for_status()
        payload = response.json()
        values.extend(payload.get("value") or [])
        next_url = payload.get("@odata.nextLink") or payload.get("nextLink")
        pages += 1

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
    Defender assessments, alerts and secure score for one subscription.

    Assessments are filtered to the unhealthy ones. A healthy assessment is a
    finding that does not exist, and a large estate produces tens of thousands
    of them — carrying those into a diff would swamp every real change.
    """
    base = f"{MGMT_BASE}/subscriptions/{subscription_id}/providers/Microsoft.Security"

    async with httpx.AsyncClient(timeout=90) as client:
        assessments_raw = await _get_all(
            client, f"{base}/assessments?api-version={ASSESSMENTS_API}", token
        )
        # Alerts and secure score are secondary. If either provider is not
        # enabled, the assessments still stand on their own.
        try:
            alerts_raw = await _get_all(
                client, f"{base}/alerts?api-version={ALERTS_API}", token
            )
        except httpx.HTTPError:
            alerts_raw = []
        try:
            scores_raw = await _get_all(
                client, f"{base}/secureScores?api-version={SECURE_SCORE_API}", token
            )
        except httpx.HTTPError:
            scores_raw = []

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

    async with httpx.AsyncClient(timeout=90) as client:
        states_raw = await _post_all(client, states_url, token, {})
        try:
            assignments_raw = await _get_all(client, assignments_url, token)
        except httpx.HTTPError:
            assignments_raw = []
        try:
            exemptions_raw = await _get_all(client, exemptions_url, token)
        except httpx.HTTPError:
            exemptions_raw = []

    states = [posture.normalise_policy_state(s) for s in states_raw]

    return {
        # Only the non-compliant states are findings. The compliant ones are
        # still counted, because a compliance rate needs both halves.
        "states": [s for s in states if not s["is_compliant"]],
        "evaluated_count": len(states),
        "compliant_count": sum(1 for s in states if s["is_compliant"]),
        "assignments": [posture.normalise_policy_assignment(a) for a in assignments_raw],
        "exemptions": [posture.normalise_exemption(e, now_iso) for e in exemptions_raw],
    }


async def fetch_role_assignments(token: str, subscription_id: str) -> Dict[str, Any]:
    """
    Role assignments and role definitions for one subscription.

    Definitions are fetched alongside because an assignment carries only a
    definition GUID. Resolving those names client-side would be one request per
    distinct role; fetching the definition list once is a single request that
    resolves all of them.

    Principal *names* are not resolved here. That needs Microsoft Graph, which
    is a separate consent this app does not hold, so principals appear by object
    id and the response says so rather than pretending the GUID is a name.
    """
    base = f"{MGMT_BASE}/subscriptions/{subscription_id}/providers/Microsoft.Authorization"

    async with httpx.AsyncClient(timeout=90) as client:
        assignments_raw = await _get_all(
            client, f"{base}/roleAssignments?api-version={ROLE_ASSIGNMENTS_API}", token
        )
        try:
            definitions_raw = await _get_all(
                client, f"{base}/roleDefinitions?api-version={ROLE_DEFINITIONS_API}", token
            )
        except httpx.HTTPError:
            definitions_raw = []

    role_names = {}
    custom = set()
    for definition in definitions_raw:
        props = definition.get("properties") or {}
        key = str(definition.get("name") or "").lower()
        role_names[key] = props.get("roleName") or ""
        if str(props.get("type") or "").lower() == "customrole":
            custom.add(key)

    from services import access_review

    assignments = []
    for raw in assignments_raw:
        item = access_review.normalise_assignment(raw, role_names=role_names)
        if item["role_definition_id"].rsplit("/", 1)[-1].lower() in custom:
            item["is_custom"] = True
        assignments.append(item)

    return {"assignments": assignments, "definition_count": len(definitions_raw)}


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
    failed = {e["subscription_id"] for e in errors} - blocked
    covered = len(requested) - len(blocked) - len(failed)

    if not errors:
        return f"All {len(requested)} subscription(s) read successfully."

    parts = [f"{covered} of {len(requested)} subscription(s) read."]
    if blocked:
        parts.append(
            f"{len(blocked)} denied access — this needs "
            f"{PERMISSION_FOR.get(source, 'read permission')}. Those subscriptions "
            "are absent from these results, which is not the same as being clean."
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
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    await db.commit()
    return cursor.lastrowid


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
