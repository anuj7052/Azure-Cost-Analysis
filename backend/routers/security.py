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
from typing import Any, Dict, List, Optional, Tuple

import aiosqlite
import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Query
from pydantic import BaseModel, Field

from auth.dependencies import get_current_user
from core.db import get_db
from services import access_change, access_review, graph_identity, security_fetch
from services import security_posture as posture
from services.activity import fetch_activity, normalise
from services.azure_errors import azure_error
from services.token_resolver import (
    authorize_subscriptions,
    resolve_tenant_token,
    subscription_names as token_resolver_names,
)

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
    """At least one subscription must be chosen before anything is worth asking Azure."""
    if not body.subscription_ids:
        raise HTTPException(
            status_code=400,
            detail="Select at least one subscription before running this.",
        )
    return body.subscription_ids


async def _scope(
    body: PostureRequest,
    current_user: dict,
    db: aiosqlite.Connection,
) -> Tuple[str, List[str]]:
    """
    The token and the subscriptions this caller is actually entitled to read.

    The subscription ids arrive from the browser, so they are treated as a
    request rather than as fact. Anything the caller's token cannot see in this
    tenant is dropped before a single Azure call is made, and `body` is
    narrowed to match so that the snapshot written at the end of the request
    records the scope that was really read.
    """
    _require_subscriptions(body)
    token = await resolve_tenant_token(body.tenant_id, current_user, db)
    subscriptions = await authorize_subscriptions(
        token, body.tenant_id, body.subscription_ids
    )
    body.subscription_ids = subscriptions
    return token, subscriptions


async def _compare(
    db: aiosqlite.Connection,
    current_user: dict,
    body: PostureRequest,
    kind: str,
    findings: List[Dict[str, Any]],
    errors: List[Dict[str, Any]],
    truncated: bool = False,
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
    if body.save and not truncated:
        snapshot_id = await security_fetch.save_snapshot(
            db, user_id, body.tenant_id, kind, findings,
            body.subscription_ids, errors,
        )

    return {
        "change": change,
        "snapshot_id": snapshot_id,
        "snapshot_skipped": (
            "This reading was cut short by Azure's paging limit, so it was not "
            "stored as a baseline. Saving it would make every unread finding "
            "look resolved the next time this page is opened."
            if truncated and body.save else ""
        ),
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
    graph_token: Optional[str] = Header(None, alias="X-Graph-Token"),
):
    """
    Every principal, and everything it can reach.

    Azure indexes access by scope; this turns it inside out and indexes it by
    principal, which is the only orientation in which "what can this contractor
    touch" is a single question rather than a walk through every resource group.

    `X-Graph-Token` is a separate credential from the one in `Authorization`,
    because Microsoft Graph and Azure Resource Manager are different audiences
    and neither accepts the other's token. It is used to look up account names
    and for nothing else -- it grants no authority inside this application, and
    the request is authenticated entirely by the bearer token as before.
    """
    token, subscriptions = await _scope(body, current_user, db)

    # Read once from the subscription listing the authorisation check already
    # fetched, then handed to every subscription's normalisation. Without this
    # the pages print subscription GUIDs, which is what made findings read like
    # a sentence about a database key rather than about a person's access.
    sub_names = token_resolver_names(body.tenant_id, token)

    results, errors = await security_fetch.across_subscriptions(
        subscriptions,
        lambda sub: security_fetch.fetch_role_assignments(token, sub, sub_names),
        posture.RBAC,
    )

    assignments: List[Dict[str, Any]] = []
    truncated = False
    definitions_read = True
    for payload in results.values():
        assignments.extend(payload["assignments"])
        if payload.get("truncated"):
            truncated = True
        if not payload.get("definitions_read", True):
            definitions_read = False

    # Names are resolved across the merged list rather than per subscription:
    # the same handful of administrators hold access in most of them, and one
    # pass asks Graph once per distinct account instead of once per account per
    # subscription.
    directory = await graph_identity.resolve_principals(
        graph_token,
        (row.get("principal_id") for row in assignments),
        body.tenant_id,
    )
    graph_identity.apply_names(assignments, directory["principals"])

    view = access_review.build_principal_view(assignments)

    return {
        **view,
        "truncated": truncated,
        "truncation_note": (
            "Azure returned more role assignments than this read follows. The "
            "list below is incomplete — treat it as a sample, not an inventory."
            if truncated else ""
        ),
        "definitions_read": definitions_read,
        "directory": {
            "resolved": directory["resolved"],
            "reason": directory["reason"],
            "requested": directory["requested"],
            "found": directory["found"],
        },
        "errors": errors,
        "coverage": security_fetch.coverage_note(subscriptions, errors, posture.RBAC),
        "note": directory["note"],
        "nested_group_note": (
            "Group assignments are listed as the group. Members of that group "
            "inherit the access and are not listed, because expanding "
            "membership is a separate directory read. Treat a group row as "
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
    graph_token: Optional[str] = Header(None, alias="X-Graph-Token"),
):
    """
    Which grants look like they should not exist.

    Every finding here is a candidate for review and none is a verdict. Access
    is easy to revoke and expensive to be wrong about — a service principal that
    runs quarterly is indistinguishable from dead access over a 30-day window —
    so each finding carries the evidence it rests on and the reason it might be
    a false positive.
    """
    token, subscriptions = await _scope(body, current_user, db)

    # Read once from the subscription listing the authorisation check already
    # fetched, then handed to every subscription's normalisation. Without this
    # the pages print subscription GUIDs, which is what made findings read like
    # a sentence about a database key rather than about a person's access.
    sub_names = token_resolver_names(body.tenant_id, token)

    assignment_results, errors = await security_fetch.across_subscriptions(
        subscriptions,
        lambda sub: security_fetch.fetch_role_assignments(token, sub, sub_names),
        posture.RBAC,
    )

    assignments: List[Dict[str, Any]] = []
    for payload in assignment_results.values():
        assignments.extend(payload["assignments"])

    # Resolved before the findings are built, so that a finding's headline names
    # the person rather than their object id. Doing it afterwards would mean
    # rewriting sentences that had already been composed around a GUID.
    directory = await graph_identity.resolve_principals(
        graph_token,
        (row.get("principal_id") for row in assignments),
        body.tenant_id,
    )
    graph_identity.apply_names(assignments, directory["principals"])

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
        "directory": {
            "resolved": directory["resolved"],
            "reason": directory["reason"],
            "requested": directory["requested"],
            "found": directory["found"],
            "note": directory["note"],
        },
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
    token, subscriptions = await _scope(body, current_user, db)

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
    token, subscriptions = await _scope(body, current_user, db)

    results, errors = await security_fetch.across_subscriptions(
        subscriptions,
        lambda sub: security_fetch.fetch_defender(token, sub),
        posture.DEFENDER,
    )

    assessments: List[Dict[str, Any]] = []
    alerts: List[Dict[str, Any]] = []
    scores: List[Dict[str, Any]] = []
    plans: List[Dict[str, Any]] = []
    assessed = 0
    truncated = False
    partial_subscriptions: List[str] = []

    for subscription_id, payload in results.items():
        assessments.extend(payload["assessments"])
        alerts.extend(payload["alerts"])
        assessed += payload["assessed_count"]
        if payload["secure_score"]:
            scores.append(payload["secure_score"])
        if payload.get("plans"):
            plans.append(payload["plans"])
        if payload.get("truncated"):
            truncated = True
        if payload.get("assessments_denied"):
            partial_subscriptions.append(subscription_id)

    assessments = posture.sort_findings(assessments)
    alerts = posture.sort_findings(alerts)

    # Only assessments are diffed. Alerts are events rather than states — an
    # alert that stops appearing was closed or aged out, which is not the same
    # kind of "resolved" as a misconfiguration being fixed.
    tracking = await _compare(db, current_user, body, posture.DEFENDER, assessments, errors, truncated)

    return {
        "assessments": assessments,
        "alerts": alerts,
        "summary": posture.summarise(assessments),
        "alert_summary": posture.summarise(alerts),
        "secure_scores": scores,
        "secure_score_overall": _overall_score(scores),
        "assessed_count": assessed,
        "healthy_count": max(assessed - len(assessments), 0),
        "plans": plans,
        "plan_coverage": _plan_coverage(plans, len(subscriptions)),
        "truncated": truncated,
        "partial_subscriptions": partial_subscriptions,
        "errors": errors,
        "coverage": security_fetch.coverage_note(subscriptions, errors, posture.DEFENDER),
        "alert_note": (
            "Alerts are shown separately from assessments and are not part of "
            "the change comparison. An alert that disappears was closed or aged "
            "out; that is not evidence anything was fixed."
        ),
        **tracking,
    }


def _plan_coverage(plans: List[Dict[str, Any]], subscription_count: int) -> Dict[str, Any]:
    """
    How much of the selected estate Defender is actually switched on for.

    This exists so that "no findings" can be read. A subscription on the Free
    tier produces no assessments at all, and without knowing that, an empty
    page says "clean" when it means "not looking".
    """
    known = [p for p in plans if p.get("known")]
    if not known:
        return {
            "known": False,
            "monitored": 0,
            "unmonitored": 0,
            "subscription_count": subscription_count,
            "note": (
                "Defender plan coverage could not be read, so an empty result "
                "here cannot be taken as evidence that nothing is wrong."
            ),
        }

    monitored = [p for p in known if p.get("enabled")]
    unmonitored = [p for p in known if not p.get("enabled")]

    if unmonitored:
        note = (
            f"{len(unmonitored)} of {len(known)} subscription(s) have every "
            "Defender plan on the free tier. Those produce no assessments at "
            "all, so their absence from this page is not a clean bill of health."
        )
    else:
        note = (
            f"All {len(known)} readable subscription(s) have at least one paid "
            "Defender plan enabled."
        )

    return {
        "known": True,
        "monitored": len(monitored),
        "unmonitored": len(unmonitored),
        "subscription_count": subscription_count,
        "note": note,
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
    token, subscriptions = await _scope(body, current_user, db)
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
    truncated = False

    for payload in results.values():
        states.extend(payload["states"])
        assignments.extend(payload["assignments"])
        exemptions.extend(payload["exemptions"])
        evaluated += payload["evaluated_count"]
        compliant += payload["compliant_count"]
        if payload.get("truncated"):
            truncated = True

    states = posture.sort_findings(states)

    # Assignments and exemptions are folded into the same snapshot as the
    # compliance states so that one comparison covers all three — an assignment
    # quietly deleted is exactly the kind of change this page exists to catch.
    snapshot_items = states + assignments + exemptions
    tracking = await _compare(db, current_user, body, posture.POLICY, snapshot_items, errors, truncated)

    return {
        "non_compliant": states,
        "assignments": assignments,
        "exemptions": exemptions,
        "expiring_exemptions": posture.expiring_soon(exemptions),
        "summary": posture.summarise(states),
        "evaluated_count": evaluated,
        "compliant_count": compliant,
        "compliance_rate": round(compliant / evaluated * 100, 1) if evaluated else None,
        "truncated": truncated,
        "truncation_note": (
            "Azure returned more compliance records than this read follows, so "
            "the counts and the rate below cover only part of the estate."
            if truncated else ""
        ),
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


# ---------------------------------------------------------------------------
# Changing access
#
# The only endpoints in this application that alter Azure rather than read it.
# Each mutation is preceded by a preview that runs the identical checks, and
# each is recorded in security_audit whether it succeeds or fails.
# ---------------------------------------------------------------------------

class ScopeRequest(BaseModel):
    tenant_id: str
    scope: str


class GrantRequest(BaseModel):
    tenant_id: str
    scope: str
    principal_id: str
    role_definition_id: str
    principal_type: str = ""
    principal_name: str = ""
    role_name: str = ""
    confirmation: bool = False


class RevokeRequest(BaseModel):
    tenant_id: str
    assignment_id: str
    principal_name: str = ""
    role_name: str = ""
    confirmation: bool = False


def _require_scope(scope: str) -> str:
    """
    A scope must name a subscription this caller can be checked against.

    Tenant-root and management-group assignments are deliberately out of range
    for now: authorising them means reading the management-group hierarchy,
    which this application does not do, and a change at that level affects every
    subscription beneath it. Refusing is the honest answer; pretending to have
    validated it would not be.
    """
    text = (scope or "").strip()
    if not text.startswith("/subscriptions/"):
        raise HTTPException(
            status_code=400,
            detail=(
                "Access can only be changed at a subscription, resource group "
                "or resource. Changes at tenant or management-group level must "
                "be made in the Azure portal, because this application cannot "
                "verify who they would affect."
            ),
        )
    return text


async def _authorise_scope(
    tenant_id: str, scope: str, current_user: dict, db: aiosqlite.Connection
) -> str:
    """
    The token for this tenant, having confirmed the caller may read the
    subscription the scope sits in.

    This is the same fail-closed check the read endpoints use. It runs before
    the Azure permission check rather than instead of it: this one proves the
    subscription belongs to the caller's tenant, the next proves the caller may
    change access inside it.
    """
    _require_scope(scope)
    subscription_id = access_change.subscription_of(scope)
    if not subscription_id:
        raise HTTPException(status_code=400, detail="That scope names no subscription.")

    token = await resolve_tenant_token(tenant_id, current_user, db)
    await authorize_subscriptions(token, tenant_id, [subscription_id])
    return token


@router.post("/access/roles")
async def list_assignable_roles(
    body: ScopeRequest,
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    """
    The roles that can be granted at one scope, read live from Azure.

    Includes the organisation's own custom roles, which no hard-coded list
    could know about.
    """
    token = await _authorise_scope(body.tenant_id, body.scope, current_user, db)
    async with httpx.AsyncClient(timeout=60) as client:
        try:
            roles = await access_change.list_role_definitions(client, token, body.scope)
        except httpx.HTTPError as exc:
            raise azure_error(exc, "the roles available at this scope")
        permission = await access_change.caller_permissions(client, token, body.scope)

    return {
        "roles": roles,
        "permission": permission,
        "scope": body.scope,
        "scope_kind": access_change.scope_kind(body.scope),
    }


@router.post("/access/grant/preview")
async def preview_grant(
    body: GrantRequest,
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
    graph_token: Optional[str] = Header(None, alias="X-Graph-Token"),
):
    """
    Everything that would happen, before anything happens.

    Runs exactly the checks the execution runs. Nothing is written and nothing
    is changed, so this is safe to call while a user is still deciding.
    """
    token = await _authorise_scope(body.tenant_id, body.scope, current_user, db)

    async with httpx.AsyncClient(timeout=60) as client:
        permission = await access_change.caller_permissions(client, token, body.scope)
        role_name = body.role_name or await access_change.role_name_for(
            client, token, body.role_definition_id
        )

    directory = await graph_identity.resolve_principals(
        graph_token, [body.principal_id], body.tenant_id
    )
    entry = directory["principals"].get(body.principal_id.lower(), {})
    person = entry.get("display_name") or body.principal_name or ""

    checks = [
        {
            "key": "identity",
            "label": "Account identified",
            # A name is a courtesy, not a precondition -- Azure accepts an
            # object id whether or not we could look it up. Saying the name is
            # unknown is honest; refusing the change over it would not be.
            "ok": bool(body.principal_id),
            "note": (
                f"Granting access to {person}." if person
                else "This account could not be named, so it is identified by "
                     "its object id. Check the id carefully before confirming."
            ),
        },
        {
            "key": "role",
            "label": "Role found",
            "ok": bool(body.role_definition_id),
            "note": role_name or "The role could not be named.",
        },
        {
            "key": "scope",
            "label": "Scope accessible",
            "ok": True,
            "note": f"This is {access_change.scope_kind(body.scope)}.",
        },
        {
            "key": "permission",
            "label": "You may change access here",
            "ok": permission["can_write"],
            "note": permission["note"],
        },
    ]

    return {
        "action": "grant",
        "can_apply": all(c["ok"] for c in checks),
        "checks": checks,
        "principal_name": person,
        "principal_id": body.principal_id,
        "role_name": role_name,
        "scope": body.scope,
        "scope_kind": access_change.scope_kind(body.scope),
        "effect": access_change.effect_sentence(role_name, body.scope),
        "high_risk": role_name.strip().lower() in access_change.DANGEROUS_ROLES,
        "permission": permission,
    }


@router.post("/access/grant")
async def grant_access(
    body: GrantRequest,
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    """Create a role assignment, and record that we did."""
    if not body.confirmation:
        raise HTTPException(
            status_code=400,
            detail="Granting access requires explicit confirmation.",
        )
    token = await _authorise_scope(body.tenant_id, body.scope, current_user, db)

    async with httpx.AsyncClient(timeout=60) as client:
        permission = await access_change.caller_permissions(client, token, body.scope)
        # Re-checked server-side. The preview is a courtesy to the user; this is
        # the check that decides, because a preview response can be discarded
        # and this endpoint called directly.
        if not permission["can_write"]:
            raise HTTPException(status_code=403, detail=permission["note"])

        role_name = body.role_name or await access_change.role_name_for(
            client, token, body.role_definition_id
        )

        event_id = await access_change.open_event(
            db, current_user, body.tenant_id, access_change.ACTION_GRANT,
            scope=body.scope,
            target_id=body.principal_id,
            target_name=body.principal_name,
            target_kind=body.principal_type or "principal",
            previous_state="No access",
            new_state=role_name or body.role_definition_id,
            detail={"role_definition_id": body.role_definition_id},
        )

        ok, message, assignment_id = await access_change.create_assignment(
            client, token, body.scope, body.role_definition_id,
            body.principal_id, body.principal_type,
        )

    await access_change.close_event(
        db, event_id,
        access_change.RESULT_SUCCESS if ok else access_change.RESULT_FAILED,
        failure_reason=message,
        azure_operation=assignment_id,
    )

    if not ok:
        raise HTTPException(status_code=502, detail=message)

    return {
        "event_id": event_id,
        "assignment_id": assignment_id,
        "result": "success",
        "principal_name": body.principal_name,
        "role_name": role_name,
        "scope": body.scope,
        "message": (
            f"{body.principal_name or 'That account'} now holds "
            f"{role_name or 'the selected role'} here."
        ),
    }


@router.post("/access/revoke/preview")
async def preview_revoke(
    body: RevokeRequest,
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
    graph_token: Optional[str] = Header(None, alias="X-Graph-Token"),
):
    """What removing this access would take away, and whether it can be done."""
    scope = _assignment_scope(body.assignment_id)
    token = await _authorise_scope(body.tenant_id, scope, current_user, db)

    async with httpx.AsyncClient(timeout=60) as client:
        existing = await access_change.find_assignment(
            client, token, scope, body.assignment_id
        )
        permission = await access_change.caller_permissions(client, token, scope)
        role_name = body.role_name
        if existing and not role_name:
            role_name = await access_change.role_name_for(
                client, token, existing["role_definition_id"]
            )

    person = body.principal_name
    if existing and not person:
        directory = await graph_identity.resolve_principals(
            graph_token, [existing["principal_id"]], body.tenant_id
        )
        entry = directory["principals"].get(existing["principal_id"].lower(), {})
        person = entry.get("display_name") or ""

    checks = [
        {
            "key": "exists",
            "label": "Access still exists",
            "ok": existing is not None,
            "note": (
                "Found in Azure." if existing
                else "Azure no longer has this assignment. Somebody may have "
                     "removed it already; there is nothing left to remove."
            ),
        },
        {
            "key": "permission",
            "label": "You may change access here",
            "ok": permission["can_delete"],
            "note": permission["note"],
        },
    ]

    return {
        "action": "revoke",
        "can_apply": all(c["ok"] for c in checks),
        "checks": checks,
        "principal_name": person,
        "role_name": role_name,
        "scope": scope,
        "scope_kind": access_change.scope_kind(scope),
        "effect": access_change.loss_sentence(role_name, scope),
        "high_risk": (role_name or "").strip().lower() in access_change.DANGEROUS_ROLES,
        "permission": permission,
    }


@router.post("/access/revoke")
async def revoke_access(
    body: RevokeRequest,
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    """Remove a role assignment, and record that we did."""
    if not body.confirmation:
        raise HTTPException(
            status_code=400,
            detail="Removing access requires explicit confirmation.",
        )
    scope = _assignment_scope(body.assignment_id)
    token = await _authorise_scope(body.tenant_id, scope, current_user, db)

    async with httpx.AsyncClient(timeout=60) as client:
        permission = await access_change.caller_permissions(client, token, scope)
        if not permission["can_delete"]:
            raise HTTPException(status_code=403, detail=permission["note"])

        existing = await access_change.find_assignment(
            client, token, scope, body.assignment_id
        )
        role_name = body.role_name
        if existing and not role_name:
            role_name = await access_change.role_name_for(
                client, token, existing["role_definition_id"]
            )

        event_id = await access_change.open_event(
            db, current_user, body.tenant_id, access_change.ACTION_REVOKE,
            scope=scope,
            target_id=(existing or {}).get("principal_id", ""),
            target_name=body.principal_name,
            target_kind=(existing or {}).get("principal_type", "principal"),
            previous_state=role_name or "Unknown role",
            new_state="No access",
            detail={"assignment_id": body.assignment_id},
        )

        ok, message = await access_change.delete_assignment(
            client, token, body.assignment_id
        )

    await access_change.close_event(
        db, event_id,
        access_change.RESULT_SUCCESS if ok else access_change.RESULT_FAILED,
        failure_reason=message,
        azure_operation=body.assignment_id,
    )

    if not ok:
        raise HTTPException(status_code=502, detail=message)

    return {
        "event_id": event_id,
        "result": "success",
        "principal_name": body.principal_name,
        "role_name": role_name,
        "scope": scope,
        "message": (
            f"{body.principal_name or 'That account'} no longer holds "
            f"{role_name or 'that role'} here."
        ),
    }


def _assignment_scope(assignment_id: str) -> str:
    """
    The scope an assignment sits at, taken from its own resource id.

    Deriving it rather than accepting it from the browser closes an obvious
    hole: a caller could otherwise send a resource-group scope they are allowed
    to change alongside a subscription-level assignment id they are not, and the
    authorisation check would pass against the wrong thing.
    """
    text = (assignment_id or "").strip()
    marker = "/providers/microsoft.authorization/roleassignments/"
    lowered = text.lower()
    index = lowered.find(marker)
    if index <= 0:
        raise HTTPException(
            status_code=400,
            detail="That does not look like a role assignment id.",
        )
    return text[:index]


@router.get("/access/history")
async def access_history(
    tenant_id: str = Query(...),
    current_user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    """
    Every access change this account has made in this tenant.

    Scoped to the signed-in account and the named tenant in the query itself,
    so one customer's administration can never appear in another's history.
    """
    events = await access_change.history(db, current_user["account_id"], tenant_id)
    return {
        "events": events,
        "count": len(events),
        "note": (
            "This records changes made through this application. Changes made "
            "in the Azure portal or by other tools are not listed here."
        ),
    }
