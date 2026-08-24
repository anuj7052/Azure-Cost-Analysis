"""
RBAC auditing and access optimisation.

Azure answers "who can touch this resource". It does not answer the two
questions that actually matter to a security review:

    1. What can *this person* reach, across the whole estate?
    2. Of the access they hold, how much do they actually use?

The first is a matter of turning the data inside out — Azure indexes
assignments by scope, this module re-indexes them by principal. The second
cannot be answered from assignments at all, because an assignment records what
was granted, never what was exercised. Usage evidence has to come from the
Activity Log, and that carries a hard limit worth stating plainly: Azure keeps
90 days. Beyond that window "no activity" means "no record", not "no use", and
this module refuses to call the two the same thing.

Every finding here is a candidate for review, not a verdict. Removing access is
irreversible in the way that matters — someone's job stops working — so each
finding carries the evidence it was drawn from and the reason it might be wrong.
"""
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

# Roles that can grant further access, or take any action. Losing track of one
# of these is the difference between an incident and a catastrophe, so they are
# named explicitly rather than inferred.
CRITICAL_ROLES = {
    "owner",
    "user access administrator",
    "role based access control administrator",
    "contributor",
}

# Roles that change things but cannot grant access to others.
MANAGEMENT_HINTS = (
    "contributor", "administrator", "admin", "operator", "writer",
    "publisher", "sender", "manager", "developer",
)

# Roles that can only look.
READ_HINTS = ("reader", "read", "viewer", "monitoring reader")

CRITICAL = "critical"
MANAGEMENT = "management"
READ = "read"

# Operations that prove someone used a *permission-granting* role for what it
# is for. A user with Owner who only ever reads has Owner for no reason.
RBAC_OPERATIONS = (
    "microsoft.authorization/roleassignments",
    "microsoft.authorization/roledefinitions",
    "microsoft.authorization/denyassignments",
)

# Finding kinds. Strings rather than an enum because they cross the API boundary
# and end up as CSS class keys on the other side.
UNUSED = "unused"
STALE = "stale"
OVER_PRIVILEGED = "over-privileged"
OVER_SCOPED = "over-scoped"
SPRAWL = "sprawl"
REDUNDANT = "redundant"

SEVERITY_ORDER = {"high": 0, "medium": 1, "low": 2}

# ---------------------------------------------------------------------------
# The least-privilege ladder
#
# Azure has hundreds of roles, but for the question "was this grant sized to
# the work?" only three rungs matter, because only three kinds of thing show up
# in the Activity Log: reads, changes, and changes to who can change.
#
# The recommendation is deliberately a *tier*, not a specific role. Recommending
# "Storage Blob Data Contributor" would require knowing which resource types the
# principal touched and which of the 400-odd built-in roles is the tightest fit
# — a judgement this data cannot support. Naming Reader or Contributor is a
# claim we can actually defend from the evidence.
# ---------------------------------------------------------------------------
TIER_NONE = "none"
TIER_READ = "read"
TIER_WRITE = "write"
TIER_GRANT = "grant"

TIER_ORDER = {TIER_NONE: 0, TIER_READ: 1, TIER_WRITE: 2, TIER_GRANT: 3}

TIER_ROLE = {
    TIER_NONE: "No standing access",
    TIER_READ: "Reader",
    TIER_WRITE: "Contributor",
    TIER_GRANT: "Owner or User Access Administrator",
}

TIER_LABEL = {
    TIER_NONE: "nothing recorded",
    TIER_READ: "read only",
    TIER_WRITE: "creates and changes resources",
    TIER_GRANT: "manages who has access",
}

# What to do about a grant, once observed use is compared with what was given.
KEEP = "keep"
DOWNGRADE = "downgrade"
REMOVE = "remove"
REVIEW = "review"

# How many subscriptions carrying the same role for the same principal starts to
# look like sprawl rather than design. Three is where a pattern becomes a habit.
SPRAWL_THRESHOLD = 3

# Below this share of the assigned scope, the grant is wider than the work.
OVER_SCOPE_SHARE = 0.34


def _text(value: Any) -> str:
    return str(value or "").strip()


def _lower(value: Any) -> str:
    return _text(value).lower()


# ---------------------------------------------------------------------------
# Shaping what Azure returns
# ---------------------------------------------------------------------------

def scope_kind(scope: str) -> str:
    """
    How wide a grant is, from its scope string alone.

    Breadth is the single most important property of an assignment and it is not
    a field — it is encoded in the shape of the path. A management group grant
    and a resource grant look identical in every other respect.
    """
    text = _lower(scope)
    if not text or text == "/":
        return "tenant root"
    if "/providers/microsoft.management/managementgroups/" in text:
        return "management group"
    if "/providers/" in text and "/resourcegroups/" in text:
        return "resource"
    if "/resourcegroups/" in text:
        return "resource group"
    if text.startswith("/subscriptions/"):
        return "subscription"
    return "other"


SCOPE_BREADTH = {
    "tenant root": 0,
    "management group": 1,
    "subscription": 2,
    "resource group": 3,
    "resource": 4,
    "other": 5,
}


def classify_role(role_name: str) -> str:
    """
    Critical, management, or read.

    Matching is on the role name because the permission arrays behind custom
    roles are not comparable across tenants. A custom role called "Reader" that
    can write is therefore misclassified — which is why the response says the
    classification came from the name, and custom roles are flagged separately.
    """
    name = _lower(role_name)
    if not name:
        return READ
    if name in CRITICAL_ROLES:
        return CRITICAL
    # Order matters: "Storage Blob Data Reader" is a read role even though it
    # contains no management hint, but "Log Analytics Contributor" is not a read
    # role despite containing neither. Read is checked last so that a name
    # carrying both signals is treated as the more dangerous one.
    if any(hint in name for hint in MANAGEMENT_HINTS):
        return MANAGEMENT
    if any(hint in name for hint in READ_HINTS):
        return READ
    return MANAGEMENT


def principal_kind(raw_type: str) -> str:
    """User, Group, or Service principal — normalised across Azure's spellings."""
    text = _lower(raw_type)
    if text.startswith("group"):
        return "Group"
    if text.startswith("serviceprincipal") or text == "sp":
        return "Service principal"
    if text.startswith("user") or text == "foreignidentity":
        return "User"
    return _text(raw_type) or "Unknown"


def subscription_of(scope: str) -> str:
    """The subscription a scope sits in, or empty for tenant/MG-wide grants."""
    parts = [p for p in _text(scope).split("/") if p]
    lowered = [p.lower() for p in parts]
    try:
        return parts[lowered.index("subscriptions") + 1]
    except (ValueError, IndexError):
        return ""


def normalise_assignment(
    raw: Dict[str, Any],
    role_names: Optional[Dict[str, str]] = None,
    principals: Optional[Dict[str, Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """
    One role assignment, flattened and enriched.

    Azure returns role *definition ids* and principal *object ids*. Neither is
    readable, and a review that shows GUIDs is a review nobody completes, so
    both are resolved against lookups where those are available and left
    honestly unresolved where they are not.
    """
    props = raw.get("properties") or raw
    role_names = role_names or {}
    principals = principals or {}

    definition_id = _text(props.get("roleDefinitionId"))
    definition_key = definition_id.rsplit("/", 1)[-1].lower()
    role_name = (
        _text(props.get("roleDefinitionName"))
        or role_names.get(definition_key)
        or ""
    )

    principal_id = _text(props.get("principalId"))
    lookup = principals.get(principal_id.lower(), {})
    display = _text(props.get("principalName")) or _text(lookup.get("display_name"))
    upn = _text(props.get("principalUpn")) or _text(lookup.get("upn"))

    scope = _text(props.get("scope"))

    return {
        "id": _text(raw.get("id")),
        "principal_id": principal_id,
        "principal_name": display or upn or principal_id or "Unknown principal",
        "principal_upn": upn,
        "principal_type": principal_kind(
            props.get("principalType") or lookup.get("type")
        ),
        "resolved": bool(display or upn),
        "role_name": role_name or "Unknown role",
        "role_definition_id": definition_id,
        "privilege": classify_role(role_name),
        "is_custom": bool(props.get("isCustomRole")) or _lower(lookup.get("role_kind")) == "customrole",
        "scope": scope,
        "scope_kind": scope_kind(scope),
        "scope_name": scope.rsplit("/", 1)[-1] if scope else "",
        "subscription_id": subscription_of(scope),
        "created_at": _text(props.get("createdOn")),
        "created_by": _text(props.get("createdBy")),
        # An assignment inherited from a group is the hardest kind to trace,
        # because the user never appears in the assignment at all.
        "via_group": principal_kind(props.get("principalType")) == "Group",
    }


# ---------------------------------------------------------------------------
# Principal-centric view
# ---------------------------------------------------------------------------

def build_principal_view(assignments: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Turn scope-indexed assignments into principal-indexed ones.

    This is the whole point of the Role Assignments page: start from a person
    and see everything they can reach, which the portal cannot do without
    visiting every scope by hand.
    """
    people: Dict[str, Dict[str, Any]] = {}

    for item in assignments:
        key = (item["principal_id"] or item["principal_name"]).lower()
        entry = people.setdefault(key, {
            "principal_id": item["principal_id"],
            "principal_name": item["principal_name"],
            "principal_upn": item["principal_upn"],
            "principal_type": item["principal_type"],
            "resolved": item["resolved"],
            "assignments": [],
            "roles": set(),
            "subscriptions": set(),
            "scope_kinds": set(),
            "privileges": {CRITICAL: 0, MANAGEMENT: 0, READ: 0},
            "custom_role_count": 0,
        })

        entry["assignments"].append(item)
        entry["roles"].add(item["role_name"])
        entry["scope_kinds"].add(item["scope_kind"])
        entry["privileges"][item["privilege"]] += 1
        if item["subscription_id"]:
            entry["subscriptions"].add(item["subscription_id"])
        if item["is_custom"]:
            entry["custom_role_count"] += 1
        if item["resolved"]:
            entry["resolved"] = True

    rows = []
    for entry in people.values():
        privileges = entry["privileges"]
        # A principal's risk is set by its *widest* grant, not by the average of
        # its grants. Someone with one Owner and forty Readers is an Owner.
        top = (
            CRITICAL if privileges[CRITICAL]
            else MANAGEMENT if privileges[MANAGEMENT]
            else READ
        )
        widest = min(
            (SCOPE_BREADTH.get(k, 9) for k in entry["scope_kinds"]),
            default=9,
        )
        rows.append({
            **entry,
            "roles": sorted(entry["roles"]),
            "subscriptions": sorted(entry["subscriptions"]),
            "scope_kinds": sorted(entry["scope_kinds"]),
            "assignment_count": len(entry["assignments"]),
            "subscription_count": len(entry["subscriptions"]),
            "top_privilege": top,
            "widest_scope": next(
                (k for k, v in SCOPE_BREADTH.items() if v == widest), "other"
            ),
        })

    rows.sort(
        key=lambda r: (
            SEVERITY_ORDER.get("high" if r["top_privilege"] == CRITICAL else "medium", 2),
            -r["assignment_count"],
            r["principal_name"].lower(),
        )
    )

    return {
        "principals": rows,
        "totals": {
            "principal_count": len(rows),
            "assignment_count": sum(r["assignment_count"] for r in rows),
            "critical_count": sum(1 for r in rows if r["top_privilege"] == CRITICAL),
            "management_count": sum(1 for r in rows if r["top_privilege"] == MANAGEMENT),
            "read_count": sum(1 for r in rows if r["top_privilege"] == READ),
            "unresolved_count": sum(1 for r in rows if not r["resolved"]),
            "by_type": _count_by(rows, "principal_type"),
        },
    }


def _count_by(rows: List[Dict[str, Any]], field: str) -> Dict[str, int]:
    counts: Dict[str, int] = {}
    for row in rows:
        counts[row[field]] = counts.get(row[field], 0) + 1
    return counts


# ---------------------------------------------------------------------------
# Usage evidence
# ---------------------------------------------------------------------------

def index_activity(events: Iterable[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """
    Who did what, keyed by principal, from normalised Activity Log entries.

    Keyed on both UPN and object id, lower-cased, because the log identifies a
    caller by whichever it has and an assignment identifies them by the other.
    Matching on one alone silently reports active users as unused, which is the
    worst possible failure for this feature — it recommends revoking access
    somebody is using every day.
    """
    index: Dict[str, Dict[str, Any]] = {}

    for event in events:
        caller = _lower(event.get("caller"))
        if not caller:
            continue

        entry = index.setdefault(caller, {
            "caller": event.get("caller"),
            "count": 0,
            "write_count": 0,
            "rbac_count": 0,
            "last_at": "",
            "scopes": set(),
            "subscriptions": set(),
        })

        entry["count"] += 1
        if event.get("is_write"):
            entry["write_count"] += 1

        operation = _lower(event.get("operation"))
        if any(op in operation for op in RBAC_OPERATIONS):
            entry["rbac_count"] += 1

        at = _text(event.get("at"))
        if at > entry["last_at"]:
            entry["last_at"] = at

        resource_id = _lower(event.get("resource_id"))
        if resource_id:
            entry["scopes"].add(resource_id)
        sub = _lower(event.get("subscription_id")) or subscription_of(resource_id)
        if sub:
            entry["subscriptions"].add(sub)

    return index


def _usage_for(assignment: Dict[str, Any], activity: Dict[str, Dict[str, Any]]):
    """
    The activity record for whoever holds this assignment, by any identifier.

    Three keys are tried because the Activity Log records a caller by whichever
    identifier the calling path happened to carry — a UPN for an interactive
    sign-in, an object id for a service principal — while an assignment carries
    whichever one ARM returned. Matching on a single field would report active
    users as unused, which is the worst failure this module can produce: it
    recommends revoking access somebody uses every day.
    """
    for key in (
        assignment.get("principal_upn"),
        assignment.get("principal_id"),
        assignment.get("principal_name"),
    ):
        found = activity.get(_lower(key))
        if found:
            return found
    return None


# ---------------------------------------------------------------------------
# Right-sizing: what role would the observed work actually have needed?
# ---------------------------------------------------------------------------

def granted_tier(privilege: str) -> str:
    """Where a held role sits on the ladder, from its classification."""
    if privilege == CRITICAL:
        return TIER_GRANT
    if privilege == MANAGEMENT:
        return TIER_WRITE
    return TIER_READ


def observed_tier(usage: Optional[Dict[str, Any]]) -> str:
    """
    The highest rung the principal was actually seen standing on.

    Note what this cannot see. The Activity Log is a management-plane record:
    it captures writes, deletes and actions reliably, but read operations only
    patchily, and data-plane traffic — reading a blob, querying a database —
    not at all. So a principal with zero recorded operations is *not* proven
    idle; they may have spent the whole window reading. That asymmetry is why
    `TIER_NONE` never produces a confident recommendation on its own.
    """
    if not usage:
        return TIER_NONE
    if usage.get("rbac_count", 0) > 0:
        return TIER_GRANT
    if usage.get("write_count", 0) > 0:
        return TIER_WRITE
    if usage.get("count", 0) > 0:
        return TIER_READ
    return TIER_NONE


def recommend_role(
    assignment: Dict[str, Any],
    usage: Optional[Dict[str, Any]],
    window_days: int = 90,
    has_evidence: bool = True,
) -> Dict[str, Any]:
    """
    Compare what a principal was given with what they were seen doing.

    This is the answer to "if they only need Reader, why do they have Owner?".
    The gap is computed, not guessed: a role assignment names a tier, the
    Activity Log shows a tier, and the difference between the two is the
    privilege being carried for no observed reason.

    Two rules keep this from becoming dangerous advice:

    * A custom role is never right-sized. Its tier was inferred from its *name*,
      and a custom role's name is whatever somebody typed. Downgrading on that
      basis could remove permissions the role actually needs.
    * Zero recorded operations produces `REVIEW`, never `REMOVE`. Reads are
      under-recorded and scheduled jobs can run less often than the window, so
      silence is a question, not a verdict.
    """
    granted = granted_tier(assignment.get("privilege", READ))
    observed = observed_tier(usage)

    counts = {
        "operations": (usage or {}).get("count", 0),
        "writes": (usage or {}).get("write_count", 0),
        "rbac": (usage or {}).get("rbac_count", 0),
    }

    base = {
        "principal_id": assignment.get("principal_id", ""),
        "principal_name": assignment.get("principal_name", ""),
        "principal_type": assignment.get("principal_type", ""),
        "granted_role": assignment.get("role_name", ""),
        "granted_tier": granted,
        "observed_tier": observed,
        "observed_label": TIER_LABEL[observed],
        "scope": assignment.get("scope", ""),
        "scope_kind": assignment.get("scope_kind", ""),
        "subscription_id": assignment.get("subscription_id", ""),
        "window_days": window_days,
        "evidence": counts,
        "is_custom": bool(assignment.get("is_custom")),
    }

    if not has_evidence:
        return {
            **base,
            "action": REVIEW,
            "recommended_role": "",
            "confidence": "none",
            "reason": (
                "No Activity Log was read, so there is no evidence of what this "
                "principal does. Nothing can be right-sized without it."
            ),
        }

    if assignment.get("is_custom"):
        return {
            **base,
            "action": REVIEW,
            "recommended_role": "",
            "confidence": "none",
            "reason": (
                f"{assignment.get('role_name')} is a custom role. Its permissions "
                "were guessed from its name, so recommending a smaller role could "
                "remove something it genuinely needs. Read its permission list "
                "before changing it."
            ),
        }

    if observed == TIER_NONE:
        return {
            **base,
            "action": REVIEW,
            "recommended_role": "",
            "confidence": "low",
            "reason": (
                f"No operations recorded in {window_days} days. That is not proof "
                "of disuse — the Activity Log records reads unreliably and not at "
                "all for data-plane work, and a job that runs quarterly would look "
                "identical. Confirm with the owner before removing anything."
            ),
        }

    if TIER_ORDER[observed] >= TIER_ORDER[granted]:
        return {
            **base,
            "action": KEEP,
            "recommended_role": assignment.get("role_name", ""),
            "confidence": "high",
            "reason": (
                f"Observed behaviour ({TIER_LABEL[observed]}) matches the role "
                f"held. {counts['operations']:,} operations in {window_days} days."
            ),
        }

    recommended = TIER_ROLE[observed]
    return {
        **base,
        "action": DOWNGRADE,
        "recommended_role": recommended,
        "confidence": "high" if observed == TIER_WRITE else "medium",
        "reason": (
            f"Holds {assignment.get('role_name')}, but across "
            f"{counts['operations']:,} operations in {window_days} days did only "
            f"{TIER_LABEL[observed]} — {counts['writes']:,} changes and "
            f"{counts['rbac']:,} access grants. {recommended} covers everything "
            "that was actually done."
        ),
    }


def summarise_right_sizing(recommendations: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Headline counts for the right-sizing panel."""
    by_action: Dict[str, int] = {}
    by_recommended: Dict[str, int] = {}
    for item in recommendations:
        by_action[item["action"]] = by_action.get(item["action"], 0) + 1
        if item["action"] == DOWNGRADE:
            key = item["recommended_role"]
            by_recommended[key] = by_recommended.get(key, 0) + 1

    # Grants that hand out the power to grant, held by somebody never seen using
    # it. This is the single number a security review is actually judged on.
    excess_grant = sum(
        1 for item in recommendations
        if item["granted_tier"] == TIER_GRANT
        and item["action"] == DOWNGRADE
    )

    return {
        "total": len(recommendations),
        "by_action": by_action,
        "by_recommended_role": by_recommended,
        "downgradable": by_action.get(DOWNGRADE, 0),
        "excess_grant_power": excess_grant,
    }


def _days_since(timestamp: str, now_iso: str) -> Optional[int]:
    """Whole days between two ISO timestamps, or None if either is unusable."""
    from datetime import datetime

    def parse(text: str):
        text = _text(text).replace("Z", "+00:00")
        if not text:
            return None
        try:
            return datetime.fromisoformat(text[:26] if "." in text else text)
        except ValueError:
            return None

    then, current = parse(timestamp), parse(now_iso)
    if not then or not current:
        return None
    if then.tzinfo is None or current.tzinfo is None:
        then = then.replace(tzinfo=None)
        current = current.replace(tzinfo=None)
    return max((current - then).days, 0)


# ---------------------------------------------------------------------------
# The review
# ---------------------------------------------------------------------------

def review_access(
    assignments: List[Dict[str, Any]],
    events: Optional[List[Dict[str, Any]]] = None,
    window_days: int = 90,
    stale_days: int = 30,
    now_iso: str = "",
) -> Dict[str, Any]:
    """
    Every assignment, judged against evidence of use.

    `window_days` is how far back the Activity Log was actually read, and it is
    carried into every finding. A grant that looks unused over 7 days and one
    that looks unused over 90 are wildly different claims, and presenting them
    identically would be dishonest.
    """
    events = events or []
    activity = index_activity(events)
    has_evidence = bool(activity)

    findings: List[Dict[str, Any]] = []
    findings.extend(_usage_findings(assignments, activity, window_days, stale_days, now_iso, has_evidence))
    findings.extend(_sprawl_findings(assignments))
    findings.extend(_redundancy_findings(assignments))

    findings.sort(key=lambda f: (SEVERITY_ORDER.get(f["severity"], 3), -f.get("weight", 0)))

    # Right-sizing runs over every assignment, not only the ones that produced a
    # finding. "This grant is correctly sized" is a useful answer too, and a
    # review that only ever shows problems gives no sense of what proportion of
    # the estate is actually fine.
    recommendations = [
        recommend_role(item, _usage_for(item, activity), window_days, has_evidence)
        for item in assignments
    ]
    recommendations.sort(key=lambda r: (
        {DOWNGRADE: 0, REVIEW: 1, REMOVE: 2, KEEP: 3}.get(r["action"], 4),
        -TIER_ORDER.get(r["granted_tier"], 0),
        r["principal_name"].lower(),
    ))

    by_kind: Dict[str, int] = {}
    for finding in findings:
        by_kind[finding["kind"]] = by_kind.get(finding["kind"], 0) + 1

    return {
        "findings": findings,
        "right_sizing": {
            "recommendations": recommendations,
            "totals": summarise_right_sizing(recommendations),
            "note": (
                "Recommendations compare the role a principal holds against the "
                "highest kind of operation they were seen performing. The Activity "
                "Log records changes reliably but reads only patchily, and no "
                "data-plane traffic at all, so a recommendation to downgrade is "
                "evidence that a smaller role would have covered the recorded "
                "work — not proof that nothing else was done."
            ),
        },
        "totals": {
            "assignment_count": len(assignments),
            "finding_count": len(findings),
            "high_count": sum(1 for f in findings if f["severity"] == "high"),
            "by_kind": by_kind,
            "principals_with_findings": len({f["principal_id"] for f in findings}),
        },
        "evidence": {
            "window_days": window_days,
            "stale_days": stale_days,
            "event_count": len(events),
            "active_principals": len(activity),
            "available": has_evidence,
            "note": _evidence_note(has_evidence, window_days, len(events)),
        },
    }


def _evidence_note(has_evidence: bool, window_days: int, event_count: int) -> str:
    if not has_evidence:
        return (
            "No Activity Log entries were read, so nothing here is based on "
            "usage. Findings below come only from the shape of the assignments "
            "themselves. Do not treat any assignment as unused on this basis."
        )
    return (
        f"Usage is drawn from {event_count:,} Activity Log entries over "
        f"{window_days} days. Azure keeps 90 days at most, so a longer view is "
        "not available from this API at any price — and access used less often "
        "than the window will look unused when it is not."
    )


def _usage_findings(assignments, activity, window_days, stale_days, now_iso, has_evidence):
    """Unused, stale, over-privileged and over-scoped — all evidence-based."""
    findings = []

    for item in assignments:
        usage = _usage_for(item, activity)
        base = {
            "principal_id": item["principal_id"],
            "principal_name": item["principal_name"],
            "principal_type": item["principal_type"],
            "role_name": item["role_name"],
            "privilege": item["privilege"],
            "scope": item["scope"],
            "scope_kind": item["scope_kind"],
            "subscription_id": item["subscription_id"],
            "window_days": window_days,
        }

        # Without evidence we must not claim anything is unused. Saying so is
        # the only honest option; guessing here revokes real people's access.
        if not has_evidence:
            continue

        if not usage:
            findings.append({
                **base,
                "kind": UNUSED,
                "severity": "high" if item["privilege"] == CRITICAL else "medium",
                "weight": 3 if item["privilege"] == CRITICAL else 1,
                "headline": f"{item['principal_name']} has not used {item['role_name']}",
                "detail": (
                    f"No Activity Log entries at all from this principal in "
                    f"{window_days} days, while holding {item['role_name']} on "
                    f"this {item['scope_kind']}. Service principals that run "
                    "monthly, and people on long leave, will look identical to "
                    "genuinely dead access — confirm before revoking."
                ),
                "evidence": "0 operations recorded",
            })
            continue

        days = _days_since(usage["last_at"], now_iso) if now_iso else None
        if days is not None and days > stale_days:
            findings.append({
                **base,
                "kind": STALE,
                "severity": "medium",
                "weight": 2 if item["privilege"] == CRITICAL else 1,
                "headline": f"{item['principal_name']} last acted {days} days ago",
                "detail": (
                    f"Still holds {item['role_name']}, but the most recent "
                    f"operation was {days} days ago — beyond the {stale_days}-day "
                    "threshold. Active enough to prove the account is real, "
                    "quiet enough to question the grant."
                ),
                "evidence": f"last operation {usage['last_at'][:10]}",
            })

        # Owner and User Access Administrator exist to manage access. Holding
        # one and never touching a role assignment means a lesser role would do.
        if item["privilege"] == CRITICAL and usage["rbac_count"] == 0:
            findings.append({
                **base,
                "kind": OVER_PRIVILEGED,
                "severity": "high",
                "weight": 3,
                "headline": f"{item['principal_name']} holds {item['role_name']} but never grants access",
                "detail": (
                    f"{usage['count']} operations in {window_days} days, none of "
                    "them a role assignment or definition change. The power to "
                    "grant access is the part of this role being carried "
                    f"unused — {'Contributor' if _lower(item['role_name']) == 'owner' else 'a narrower role'} "
                    "would cover the observed behaviour."
                ),
                "evidence": f"{usage['count']} operations, 0 RBAC operations",
            })

        # A subscription-wide grant used in one resource group is a grant that
        # was never sized to the work.
        if item["scope_kind"] in ("subscription", "management group", "tenant root"):
            touched = usage["subscriptions"]
            if touched and item["subscription_id"]:
                share = 1.0 if _lower(item["subscription_id"]) in touched else 0.0
                if share == 0.0:
                    findings.append({
                        **base,
                        "kind": OVER_SCOPED,
                        "severity": "medium",
                        "weight": 2,
                        "headline": f"{item['principal_name']} never acted in this subscription",
                        "detail": (
                            f"Holds {item['role_name']} across the whole "
                            f"{item['scope_kind']}, but every recorded operation "
                            f"was in {len(touched)} other subscription(s). The "
                            "grant is wider than the work it supports."
                        ),
                        "evidence": f"active in {len(touched)} other subscription(s)",
                    })

    return findings


def _sprawl_findings(assignments):
    """The same role, for the same principal, repeated across subscriptions."""
    groups: Dict[Tuple[str, str], List[Dict[str, Any]]] = {}
    for item in assignments:
        if not item["subscription_id"]:
            continue
        groups.setdefault((item["principal_id"], _lower(item["role_name"])), []).append(item)

    findings = []
    for (principal_id, _), items in groups.items():
        subs = {i["subscription_id"] for i in items}
        if len(subs) < SPRAWL_THRESHOLD:
            continue
        first = items[0]
        findings.append({
            "kind": SPRAWL,
            "severity": "high" if first["privilege"] == CRITICAL else "low",
            "weight": len(subs),
            "principal_id": principal_id,
            "principal_name": first["principal_name"],
            "principal_type": first["principal_type"],
            "role_name": first["role_name"],
            "privilege": first["privilege"],
            "scope": "",
            "scope_kind": "subscription",
            "subscription_id": "",
            "headline": (
                f"{first['principal_name']} holds {first['role_name']} on "
                f"{len(subs)} subscriptions"
            ),
            "detail": (
                "The same role granted separately in many places is usually "
                "history rather than design. One assignment at a management "
                "group would be equivalent, visible in one place, and removable "
                "in one action — or several of these are simply no longer needed."
            ),
            "evidence": f"{len(subs)} subscriptions",
            "subscriptions": sorted(subs),
        })

    return findings


def _redundancy_findings(assignments):
    """
    Grants that another grant already covers.

    RBAC is additive and inherited: a role held at subscription level applies to
    every resource group inside it. A second assignment of the same role further
    down grants nothing at all — but it still appears in audits, still has to be
    reviewed, and still has to be removed twice.
    """
    by_principal: Dict[str, List[Dict[str, Any]]] = {}
    for item in assignments:
        by_principal.setdefault(item["principal_id"], []).append(item)

    findings = []
    for principal_id, items in by_principal.items():
        for item in items:
            broader = _covering_assignment(item, items)
            if not broader:
                continue
            findings.append({
                "kind": REDUNDANT,
                "severity": "low",
                "weight": 1,
                "principal_id": principal_id,
                "principal_name": item["principal_name"],
                "principal_type": item["principal_type"],
                "role_name": item["role_name"],
                "privilege": item["privilege"],
                "scope": item["scope"],
                "scope_kind": item["scope_kind"],
                "subscription_id": item["subscription_id"],
                "headline": (
                    f"{item['principal_name']}'s {item['role_name']} on this "
                    f"{item['scope_kind']} grants nothing new"
                ),
                "detail": (
                    f"The same role is already held at {broader['scope_kind']} "
                    "level, and RBAC inherits downward. Removing this assignment "
                    "changes no one's effective access — it only shortens the "
                    "list an auditor has to read."
                ),
                "evidence": f"covered by {broader['scope_kind']} assignment",
                "covered_by": broader["scope"],
            })

    return findings


def _covering_assignment(item, siblings) -> Optional[Dict[str, Any]]:
    """A strictly broader assignment of the same role over the same path."""
    scope = _lower(item["scope"])
    mine = SCOPE_BREADTH.get(item["scope_kind"], 9)

    for other in siblings:
        if other is item:
            continue
        if _lower(other["role_name"]) != _lower(item["role_name"]):
            continue
        theirs = SCOPE_BREADTH.get(other["scope_kind"], 9)
        if theirs >= mine:
            continue
        # Inheritance only applies along the same path. Two subscriptions are
        # not related, however broad either grant is.
        if scope.startswith(_lower(other["scope"])):
            return other

    return None
