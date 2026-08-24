"""
Access & Security: RBAC auditing, Advisor, Defender for Cloud, and Azure Policy.

Five views over four Azure providers, sharing one design decision: every
endpoint captures a snapshot as it reads, so the *next* call can say what
changed. Advisor, Defender and Policy all report only the present tense — there
is no "what did this look like last month" endpoint on any of them — which makes
the question every security programme is judged on unanswerable unless somebody
wrote the previous reading down.

The second shared decision is that a missing permission degrades the answer and
names itself. These four providers are rarely granted evenly, and returning an
error to somebody entitled to three quarters of the data helps nobody. Worse, an
empty security page reads as "nothing is wrong" — so the coverage note is part
of every response, not an optional extra.
"""
import logging
from typing import Any, Dict, List, Optional

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from auth.dependencies import get_current_user
from core.db import get_db
from services import access_review, security_fetch
from services import security_posture as posture
from services.activity import fetch_activity, normalise
from services.token_resolver import resolve_tenant_token

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/security", tags=["security"])


class PostureRequest(BaseModel):
    tenant_id: str
    subscription_ids: List[str] = Field(default_factory=list)
    # When set, the response also diffs against the snapshot stored under this
    # id instead of the most recent one, so a specific pair can be compared.
    compare_to: Optional[int] = None
    save: bool = True


class AccessRequest(PostureRequest):
    # How far back the Activity Log is read for usage evidence. Azure keeps 90
    # days at most; asking for more silently returns the same 90.
    window_days: int = 30
    stale_days: int = 14
    # Reading the Activity Log is by far the slowest part of this page, and the
    # assignment list is useful without it, so it can be turned off.
    include_usage: bool = True


def _now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


async def _token(body: PostureRequest, current_user: dict, db: aiosqlite.Connection) -> str:
    """The Azure token for the requested tenant, checked against this account."""
    return await resolve_tenant_token(body.tenant_id, current_user, db)


def _require_subscriptions(body: PostureRequest) -> List[str]:
    if not body.subscription_ids:
        raise HTTPException(
            status_code=400,
            detail="Select at least one subscription before running this.",
        )
    return body.subscription_ids


async def _compare(
    db: aiosqlite.Connection,
    current_user: dict,
    body: PostureRequest,
    kind: str,
    findings: List[Dict[str, Any]],
    errors: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """
    Diff this reading against the previous one, then store it.

    Order matters: the comparison is taken *before* the new snapshot is written,
    otherwise the newest snapshot would be compared against itself and every
    page would report that nothing ever changes.
    """
    user_id = current_user["account_id"]

    if body.compare_to:
        baseline = await security_fetch.load_snapshot(
            db, user_id, body.tenant_id, body.compare_to
        )
    else:
        baseline = await security_fetch.previous_snapshot(
            db, user_id, body.tenant_id, kind
        )

    change = None
    if baseline:
        change = {
            **posture.diff_findings(baseline["findings"], findings),
            "baseline_id": baseline["id"],
            "baseline_at": baseline["captured_at"],
        }
        # A baseline captured while subscriptions were unreadable makes every
        # missing finding look resolved. Saying so costs one sentence and
        # prevents a false claim of progress.
        if baseline.get("errors"):
            change["caveat"] = (
                f"The earlier snapshot could not read "
                f"{len(baseline['errors'])} subscription(s), so some findings "
                "shown as resolved may simply have been invisible then."
            )

    snapshot_id = None
    if body.save:
        snapshot_id = await security_fetch.save_snapshot(
            db, user_id, body.tenant_id, kind, findings,
            body.subscription_ids, errors,
        )

    return {
        "change": change,
        "snapshot_id": snapshot_id,
        "history": await security_fetch.recent_snapshots(
            db, user_id, body.tenant_id, kind, limit=12
        ),
    }


# ---------------------------------------------------------------------------
# Role assignments — principal-centric RBAC
# ---------------------------------------------------------------------------

@router.post("/role-assignments")
async def get_role_assignments(
    body: PostureRequest,
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    """
    Every principal, and everything it can reach.

    Azure indexes access by scope; this turns it inside out and indexes it by
    principal, which is the only orientation in which "what can this contractor
    touch" is a single question rather than a walk through every resource group.
    """
    subscriptions = _require_subscriptions(body)
    token = await _token(body, current_user, db)

    results, errors = await security_fetch.across_subscriptions(
        subscriptions,
        lambda sub: security_fetch.fetch_role_assignments(token, sub),
        posture.RBAC,
    )

    assignments: List[Dict[str, Any]] = []
    for payload in results.values():
        assignments.extend(payload["assignments"])

    view = access_review.build_principal_view(assignments)

    return {
        **view,
        "errors": errors,
        "coverage": security_fetch.coverage_note(subscriptions, errors, posture.RBAC),
        "note": (
            "Principals are shown by display name where Azure supplied one and "
            "by object id where it did not. Resolving the rest needs Microsoft "
            "Graph directory read consent, which this app does not hold — so an "
            "object id here means unresolved, not unknown to Azure."
        ),
        "nested_group_note": (
            "Group assignments are listed as the group. Members of that group "
            "inherit the access and are not listed, because expanding "
            "membership also requires Microsoft Graph. Treat a group row as "
            "'everyone in this group', not as one identity."
        ),
        "subscription_count": len(subscriptions),
    }


# ---------------------------------------------------------------------------
# Access optimisation
# ---------------------------------------------------------------------------

@router.post("/access-review")
async def get_access_review(
    body: AccessRequest,
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    """
    Which grants look like they should not exist.

    Every finding here is a candidate for review and none is a verdict. Access
    is easy to revoke and expensive to be wrong about — a service principal that
    runs quarterly is indistinguishable from dead access over a 30-day window —
    so each finding carries the evidence it rests on and the reason it might be
    a false positive.
    """
    subscriptions = _require_subscriptions(body)
    token = await _token(body, current_user, db)

    assignment_results, errors = await security_fetch.across_subscriptions(
        subscriptions,
        lambda sub: security_fetch.fetch_role_assignments(token, sub),
        posture.RBAC,
    )

    assignments: List[Dict[str, Any]] = []
    for payload in assignment_results.values():
        assignments.extend(payload["assignments"])

    events: List[Dict[str, Any]] = []
    if body.include_usage:
        activity_results, activity_errors = await security_fetch.across_subscriptions(
            subscriptions,
            lambda sub: fetch_activity(
                token,
                sub,
                days=body.window_days,
                # The Activity Log's full entries are enormous and none of the
                # detail is used here — only who, what, when and where.
                select=[
                    "eventTimestamp", "caller", "operationName",
                    "resourceId", "subscriptionId", "status",
                ],
            ),
            "activity",
        )
        errors.extend(activity_errors)
        for entries in activity_results.values():
            events.extend(normalise(entry) for entry in entries)

    review = access_review.review_access(
        assignments,
        events=events,
        window_days=body.window_days,
        stale_days=body.stale_days,
        now_iso=_now_iso(),
    )

    return {
        **review,
        "errors": errors,
        "coverage": security_fetch.coverage_note(subscriptions, errors, posture.RBAC),
        "caveats": [
            "Activity Log retention is 90 days. Access used less often than the "
            "window will appear unused when it is not.",
            "Group members inherit access without appearing in any assignment. "
            "A quiet group is not proof that nobody inside it is active.",
            "Data-plane actions — reading a blob, querying a database — are not "
            "in the Activity Log at all, so a storage reader can be busy and "
            "look idle here.",
        ],
    }


# ---------------------------------------------------------------------------
# Azure Advisor
# ---------------------------------------------------------------------------

@router.post("/advisor")
async def get_advisor(
    body: PostureRequest,
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    """Advisor recommendations across every selected subscription, and what changed."""
    subscriptions = _require_subscriptions(body)
    token = await _token(body, current_user, db)

    results, errors = await security_fetch.across_subscriptions(
        subscriptions,
        lambda sub: security_fetch.fetch_advisor(token, sub),
        posture.ADVISOR,
    )

    findings: List[Dict[str, Any]] = []
    for items in results.values():
        findings.extend(items)
    findings = posture.sort_findings(findings)

    tracking = await _compare(db, current_user, body, posture.ADVISOR, findings, errors)

    return {
        "findings": findings,
        "summary": posture.summarise(findings),
        "errors": errors,
        "coverage": security_fetch.coverage_note(subscriptions, errors, posture.ADVISOR),
        **tracking,
    }


# ---------------------------------------------------------------------------
# Microsoft Defender for Cloud
# ---------------------------------------------------------------------------

@router.post("/defender")
async def get_defender(
    body: PostureRequest,
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    """
    Defender findings and secure score, with movement since the last reading.

    Assessments and alerts are returned separately and never summed. An
    assessment says a resource *could* be exploited; an alert says it may
    already have been. Merging them lets a hundred configuration notes bury one
    live intrusion signal.
    """
    subscriptions = _require_subscriptions(body)
    token = await _token(body, current_user, db)

    results, errors = await security_fetch.across_subscriptions(
        subscriptions,
        lambda sub: security_fetch.fetch_defender(token, sub),
        posture.DEFENDER,
    )

    assessments: List[Dict[str, Any]] = []
    alerts: List[Dict[str, Any]] = []
    scores: List[Dict[str, Any]] = []
    assessed = 0

    for payload in results.values():
        assessments.extend(payload["assessments"])
        alerts.extend(payload["alerts"])
        assessed += payload["assessed_count"]
        if payload["secure_score"]:
            scores.append(payload["secure_score"])

    assessments = posture.sort_findings(assessments)
    alerts = posture.sort_findings(alerts)

    # Only assessments are diffed. Alerts are events rather than states — an
    # alert that stops appearing was closed or aged out, which is not the same
    # kind of "resolved" as a misconfiguration being fixed.
    tracking = await _compare(db, current_user, body, posture.DEFENDER, assessments, errors)

    return {
        "assessments": assessments,
        "alerts": alerts,
        "summary": posture.summarise(assessments),
        "alert_summary": posture.summarise(alerts),
        "secure_scores": scores,
        "secure_score_overall": _overall_score(scores),
        "assessed_count": assessed,
        "healthy_count": max(assessed - len(assessments), 0),
        "errors": errors,
        "coverage": security_fetch.coverage_note(subscriptions, errors, posture.DEFENDER),
        "alert_note": (
            "Alerts are shown separately from assessments and are not part of "
            "the change comparison. An alert that disappears was closed or aged "
            "out; that is not evidence anything was fixed."
        ),
        **tracking,
    }


def _overall_score(scores: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """
    One score across subscriptions, computed from the raw points.

    Averaging the percentages would weight a two-resource subscription equally
    with a two-thousand-resource one. Summing current and max first gives the
    figure that actually describes the estate.
    """
    if not scores:
        return None
    current = sum(s["current"] for s in scores)
    maximum = sum(s["max"] for s in scores)
    if not maximum:
        return None
    return {
        "current": round(current, 2),
        "max": round(maximum, 2),
        "percentage": round(current / maximum * 100, 1),
        "subscription_count": len(scores),
        "note": (
            "Points are summed across subscriptions before dividing, so a large "
            "subscription counts for more than a small one. Averaging the "
            "per-subscription percentages would not."
        ),
    }


# ---------------------------------------------------------------------------
# Azure Policy
# ---------------------------------------------------------------------------

@router.post("/policy")
async def get_policy(
    body: PostureRequest,
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    """
    Compliance, assignments and exemptions, with movement since the last reading.

    The exemption list is the part most worth reading. Exemptions expire
    silently, the resource becomes non-compliant that night, and nobody connects
    the two — so anything lapsing inside 30 days, including what already has, is
    pulled to the front.
    """
    subscriptions = _require_subscriptions(body)
    token = await _token(body, current_user, db)
    now = _now_iso()

    results, errors = await security_fetch.across_subscriptions(
        subscriptions,
        lambda sub: security_fetch.fetch_policy(token, sub, now),
        posture.POLICY,
    )

    states: List[Dict[str, Any]] = []
    assignments: List[Dict[str, Any]] = []
    exemptions: List[Dict[str, Any]] = []
    evaluated = 0
    compliant = 0

    for payload in results.values():
        states.extend(payload["states"])
        assignments.extend(payload["assignments"])
        exemptions.extend(payload["exemptions"])
        evaluated += payload["evaluated_count"]
        compliant += payload["compliant_count"]

    states = posture.sort_findings(states)

    # Assignments and exemptions are folded into the same snapshot as the
    # compliance states so that one comparison covers all three — an assignment
    # quietly deleted is exactly the kind of change this page exists to catch.
    snapshot_items = states + assignments + exemptions
    tracking = await _compare(db, current_user, body, posture.POLICY, snapshot_items, errors)

    return {
        "non_compliant": states,
        "assignments": assignments,
        "exemptions": exemptions,
        "expiring_exemptions": posture.expiring_soon(exemptions),
        "summary": posture.summarise(states),
        "evaluated_count": evaluated,
        "compliant_count": compliant,
        "compliance_rate": round(compliant / evaluated * 100, 1) if evaluated else None,
        "unenforced_count": sum(1 for a in assignments if not a["enforced"]),
        "errors": errors,
        "coverage": security_fetch.coverage_note(subscriptions, errors, posture.POLICY),
        "enforcement_note": (
            "Assignments in DoNotEnforce mode report compliance but block "
            "nothing. They look like governance and are not, so they are counted "
            "separately."
        ),
        **tracking,
    }


# ---------------------------------------------------------------------------
# Snapshot history, shared by all four
# ---------------------------------------------------------------------------

@router.get("/snapshots")
async def list_snapshots(
    tenant_id: str = Query(...),
    kind: str = Query(..., description="advisor | defender | policy | rbac"),
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    """
    Every stored reading of one source, newest first.

    This is what makes trend analysis possible at all: the counts here are the
    only record of what the estate looked like on a date Azure no longer
    remembers.
    """
    if kind not in (posture.ADVISOR, posture.DEFENDER, posture.POLICY, posture.RBAC):
        raise HTTPException(status_code=400, detail=f"Unknown snapshot kind '{kind}'.")

    snapshots = await security_fetch.recent_snapshots(
        db, current_user["account_id"], tenant_id, kind, limit=60
    )
    return {
        "kind": kind,
        "snapshots": snapshots,
        "trend": [
            {
                "id": s["id"],
                "captured_at": s["captured_at"],
                "total": s["finding_count"],
                "high": s["high_count"],
                # A reading taken while subscriptions were unreadable is not
                # comparable with a complete one, and a trend line that hides
                # that shows a cliff where there was only a permission change.
                "partial": bool(s["errors"]),
            }
            for s in reversed(snapshots)
        ],
    }
