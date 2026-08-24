"""
Security and governance posture: Advisor, Defender for Cloud, and Azure Policy.

All three of these APIs share one shape and one flaw. The shape: a list of
findings, each with a category, a severity, and an affected resource. The flaw:
they only ever report *now*. Ask Defender what your alerts are and you get
today's; ask what changed since last month and there is no endpoint for it,
because Azure does not keep the answer.

That missing history is the whole reason this module stores snapshots. A
finding list on its own cannot tell you whether you are improving, which is the
only question a security programme is actually judged on. Two snapshots can:
what appeared, what was resolved, and what has been sitting there untouched
since the first time anyone looked.

The diff is deliberately shared across all three sources rather than written
three times. "New since last scan", "resolved since last scan" and "still open"
mean the same thing whether the finding came from Advisor or Defender, and three
implementations of one idea would drift apart within a month.

Every finding is reduced to a stable `key` before comparison. Getting that key
wrong is the one failure mode that matters here: an unstable key reports the
entire estate as resolved-and-recreated on every scan, which looks like enormous
progress and enormous regression at the same time, and is worse than showing
nothing at all.
"""
import json
from typing import Any, Dict, Iterable, List, Optional

# Defender speaks in severities, Advisor in impacts. They are the same axis with
# different words on it, so both are mapped to one scale — otherwise the two
# cannot be counted together or sorted against each other.
SEVERITY_RANK = {
    "high": 0,
    "critical": 0,
    "medium": 1,
    "moderate": 1,
    "low": 2,
    "informational": 3,
    "information": 3,
    "none": 3,
}

IMPACT_TO_SEVERITY = {"high": "high", "medium": "medium", "low": "low"}

# The four things a snapshot can hold. Kept as constants because they are also
# the database discriminator, and a typo would silently create a fifth kind
# that never diffs against anything.
ADVISOR = "advisor"
DEFENDER = "defender"
POLICY = "policy"
RBAC = "rbac"

NEW = "new"
RESOLVED = "resolved"
PERSISTING = "persisting"


def _text(value: Any) -> str:
    return str(value or "").strip()


def _lower(value: Any) -> str:
    return _text(value).lower()


def normalise_severity(value: Any) -> str:
    """Any of Azure's severity or impact words, reduced to four."""
    text = _lower(value)
    if text in SEVERITY_RANK:
        return "high" if text == "critical" else "medium" if text == "moderate" else text
    return "medium"


def _resource_name(resource_id: str) -> str:
    return _text(resource_id).rsplit("/", 1)[-1]


def _subscription_of(resource_id: str) -> str:
    parts = [p for p in _text(resource_id).split("/") if p]
    lowered = [p.lower() for p in parts]
    try:
        return parts[lowered.index("subscriptions") + 1]
    except (ValueError, IndexError):
        return ""


# ---------------------------------------------------------------------------
# Advisor
# ---------------------------------------------------------------------------

def normalise_advisor(raw: Dict[str, Any]) -> Dict[str, Any]:
    """
    One Advisor recommendation.

    Advisor's `impact` is its severity axis and its `category` is one of Cost,
    Security, Reliability, Performance or OperationalExcellence. Both are kept
    because the two answer different questions — impact says how urgent, and
    category says which team it belongs to.
    """
    props = raw.get("properties") or raw
    short = props.get("shortDescription") or {}
    resource_id = _text(props.get("resourceMetadata", {}).get("resourceId")) or _text(raw.get("id"))

    return {
        "source": ADVISOR,
        # Advisor's own recommendation id changes when it re-evaluates, so the
        # stable identity is what the advice is *about*, not the advice record.
        "key": f"advisor::{_lower(props.get('recommendationTypeId'))}::{_lower(resource_id)}",
        "id": _text(raw.get("id")),
        "title": _text(short.get("problem")) or _text(props.get("recommendationTypeId")),
        "solution": _text(short.get("solution")),
        "category": _text(props.get("category")) or "Uncategorised",
        "severity": normalise_severity(IMPACT_TO_SEVERITY.get(_lower(props.get("impact")), "medium")),
        "impact": _text(props.get("impact")) or "Medium",
        "resource_id": resource_id,
        "resource_name": _resource_name(resource_id),
        "subscription_id": _subscription_of(resource_id),
        "last_updated": _text(props.get("lastUpdated")),
        # Cost recommendations carry a projected saving; the others do not, and
        # inventing a zero for them would make the total look like a real figure.
        "annual_saving": _saving(props),
        "currency": _text((props.get("extendedProperties") or {}).get("savingsCurrency")),
    }


def _saving(props: Dict[str, Any]) -> Optional[float]:
    extended = props.get("extendedProperties") or {}
    for key in ("annualSavingsAmount", "savingsAmount"):
        if key in extended:
            try:
                return round(float(extended[key]), 2)
            except (TypeError, ValueError):
                return None
    return None


# ---------------------------------------------------------------------------
# Defender for Cloud
# ---------------------------------------------------------------------------

def normalise_assessment(raw: Dict[str, Any]) -> Dict[str, Any]:
    """
    One Defender for Cloud assessment — a recommendation against a resource.

    Only unhealthy assessments are worth carrying. A healthy one is a finding
    that does not exist, and keeping them would swamp the diff with resources
    that are, correctly, fine.
    """
    props = raw.get("properties") or raw
    status = props.get("status") or {}
    metadata = props.get("metadata") or {}
    resource_id = _text((props.get("resourceDetails") or {}).get("Id")) or _text(raw.get("id"))

    return {
        "source": DEFENDER,
        "kind": "assessment",
        "key": f"defender::assessment::{_lower(raw.get('name'))}::{_lower(resource_id)}",
        "id": _text(raw.get("id")),
        "title": _text(props.get("displayName")) or _text(metadata.get("displayName")),
        "solution": _text(metadata.get("remediationDescription")),
        "category": (metadata.get("categories") or ["Security"])[0],
        "severity": normalise_severity(metadata.get("severity")),
        "status": _text(status.get("code")) or "Unhealthy",
        "cause": _text(status.get("cause")),
        "description": _text(status.get("description")) or _text(metadata.get("description")),
        "resource_id": resource_id,
        "resource_name": _resource_name(resource_id),
        "subscription_id": _subscription_of(resource_id),
        "last_updated": "",
    }


def normalise_alert(raw: Dict[str, Any]) -> Dict[str, Any]:
    """
    One Defender security alert — something that appears to have happened.

    Alerts and assessments are kept apart deliberately. An assessment says "this
    could be exploited"; an alert says "this may already have been". Counting
    them in one number would let a hundred configuration notes bury a live
    intrusion signal.
    """
    props = raw.get("properties") or raw
    resource_id = _text(props.get("compromisedEntity")) or _text(
        (props.get("resourceIdentifiers") or [{}])[0].get("azureResourceId")
    )

    return {
        "source": DEFENDER,
        "kind": "alert",
        "key": f"defender::alert::{_lower(props.get('systemAlertId') or raw.get('name'))}",
        "id": _text(raw.get("id")),
        "title": _text(props.get("alertDisplayName")),
        "solution": _text(props.get("remediationSteps") and " ".join(props["remediationSteps"])),
        "category": _text(props.get("intent")) or "Alert",
        "severity": normalise_severity(props.get("severity")),
        "status": _text(props.get("status")) or "Active",
        "description": _text(props.get("description")),
        "resource_id": resource_id,
        "resource_name": _resource_name(resource_id),
        "subscription_id": _subscription_of(_text(raw.get("id"))),
        "last_updated": _text(props.get("timeGeneratedUtc") or props.get("endTimeUtc")),
    }


# ---------------------------------------------------------------------------
# Azure Policy
# ---------------------------------------------------------------------------

def normalise_policy_state(raw: Dict[str, Any]) -> Dict[str, Any]:
    """
    One resource's compliance against one policy.

    The pair (policy, resource) is the identity. The same resource can be
    compliant with one policy and not another, and the same policy applies to
    thousands of resources — neither alone identifies a finding.
    """
    resource_id = _text(raw.get("resourceId"))
    definition = _text(raw.get("policyDefinitionName") or raw.get("policyDefinitionId"))

    return {
        "source": POLICY,
        "kind": "state",
        "key": f"policy::{_lower(definition)}::{_lower(resource_id)}",
        "title": _text(raw.get("policyDefinitionName")) or definition.rsplit("/", 1)[-1],
        "assignment_name": _text(raw.get("policyAssignmentName")),
        "assignment_id": _text(raw.get("policyAssignmentId")),
        "definition_id": _text(raw.get("policyDefinitionId")),
        "category": _text(raw.get("policyDefinitionGroupNames") and
                          raw["policyDefinitionGroupNames"][0]) or "Policy",
        "compliance_state": _text(raw.get("complianceState")) or "Unknown",
        "is_compliant": _lower(raw.get("complianceState")) == "compliant",
        "severity": "medium",
        "resource_id": resource_id,
        "resource_name": _resource_name(resource_id),
        "resource_type": _text(raw.get("resourceType")),
        "subscription_id": _text(raw.get("subscriptionId")) or _subscription_of(resource_id),
        "last_updated": _text(raw.get("timestamp")),
    }


def normalise_policy_assignment(raw: Dict[str, Any]) -> Dict[str, Any]:
    """One policy assignment, with the fields whose change matters."""
    props = raw.get("properties") or raw
    return {
        "source": POLICY,
        "kind": "assignment",
        "key": f"policy-assignment::{_lower(raw.get('id'))}",
        "id": _text(raw.get("id")),
        "name": _text(props.get("displayName")) or _text(raw.get("name")),
        "description": _text(props.get("description")),
        "scope": _text(props.get("scope")),
        "definition_id": _text(props.get("policyDefinitionId")),
        "enforcement_mode": _text(props.get("enforcementMode")) or "Default",
        # A policy in DoNotEnforce reports compliance but changes nothing. It
        # looks like governance and is not, so it is surfaced rather than buried.
        "enforced": _lower(props.get("enforcementMode")) != "donotenforce",
        "not_scopes": props.get("notScopes") or [],
        "severity": "medium",
    }


def normalise_exemption(raw: Dict[str, Any], now_iso: str = "") -> Dict[str, Any]:
    """
    One policy exemption, with how long it has left.

    Exemptions are the quiet failure mode of policy governance: they expire, the
    resource becomes non-compliant that night, and nobody connected the two.
    Days-remaining is computed here so the answer is a number, not a date the
    reader has to subtract in their head.
    """
    props = raw.get("properties") or raw
    expires = _text(props.get("expiresOn"))

    return {
        "source": POLICY,
        "kind": "exemption",
        "key": f"policy-exemption::{_lower(raw.get('id'))}",
        "id": _text(raw.get("id")),
        "name": _text(props.get("displayName")) or _text(raw.get("name")),
        "category": _text(props.get("exemptionCategory")) or "Waiver",
        "assignment_id": _text(props.get("policyAssignmentId")),
        "scope": _text(raw.get("id")).split("/providers/Microsoft.Authorization/")[0],
        "expires_on": expires,
        "days_remaining": _days_until(expires, now_iso),
        "severity": "medium",
    }


def _days_until(expires: str, now_iso: str) -> Optional[int]:
    """Days until an exemption lapses. Negative means it already has."""
    from datetime import datetime

    def parse(text: str):
        text = _text(text).replace("Z", "+00:00")
        if not text:
            return None
        try:
            return datetime.fromisoformat(text[:26] if "." in text else text)
        except ValueError:
            return None

    end, now = parse(expires), parse(now_iso)
    if not end or not now:
        return None
    if end.tzinfo is None or now.tzinfo is None:
        end, now = end.replace(tzinfo=None), now.replace(tzinfo=None)
    return (end - now).days


def expiring_soon(exemptions: List[Dict[str, Any]], within_days: int = 30) -> List[Dict[str, Any]]:
    """
    Exemptions that lapse inside the window, soonest first.

    Already-expired ones are included rather than filtered out: an exemption
    that lapsed last week is not history, it is a resource that silently became
    non-compliant and nobody was told.
    """
    at_risk = [
        e for e in exemptions
        if e["days_remaining"] is not None and e["days_remaining"] <= within_days
    ]
    at_risk.sort(key=lambda e: e["days_remaining"])
    return at_risk


# ---------------------------------------------------------------------------
# Change tracking — shared by all three sources
# ---------------------------------------------------------------------------

def diff_findings(
    before: Iterable[Dict[str, Any]],
    after: Iterable[Dict[str, Any]],
) -> Dict[str, Any]:
    """
    What appeared, what was resolved, and what is still open.

    Comparison is on `key`, which every normaliser builds from what a finding is
    *about* rather than from the record id Azure happens to have issued. Azure
    re-issues those ids freely on re-evaluation, and keying on them would report
    every finding as resolved and immediately recreated — a perfect score and a
    total regression, on the same screen, every scan.
    """
    before_map = {f["key"]: f for f in before if f.get("key")}
    after_map = {f["key"]: f for f in after if f.get("key")}

    new_keys = after_map.keys() - before_map.keys()
    resolved_keys = before_map.keys() - after_map.keys()
    persisting_keys = before_map.keys() & after_map.keys()

    new = [{**after_map[k], "change": NEW} for k in new_keys]
    resolved = [{**before_map[k], "change": RESOLVED} for k in resolved_keys]
    persisting = [{**after_map[k], "change": PERSISTING} for k in persisting_keys]

    for group in (new, resolved, persisting):
        group.sort(key=lambda f: (SEVERITY_RANK.get(f.get("severity", "medium"), 2),
                                  _lower(f.get("title"))))

    return {
        "new": new,
        "resolved": resolved,
        "persisting": persisting,
        "new_count": len(new),
        "resolved_count": len(resolved),
        "persisting_count": len(persisting),
        "before_count": len(before_map),
        "after_count": len(after_map),
        "net_change": len(after_map) - len(before_map),
        "verdict": _verdict(len(new), len(resolved), len(after_map) - len(before_map)),
    }


def _verdict(new_count: int, resolved_count: int, net: int) -> str:
    """
    Whether the posture improved, said in a sentence.

    A count of findings going down is not automatically progress — it also drops
    when a subscription loses permission, or when resources are deleted. The
    wording stays descriptive for that reason and does not congratulate anyone.
    """
    if new_count == 0 and resolved_count == 0:
        return "Nothing changed between these two scans."
    if net < 0:
        return (
            f"{resolved_count} finding(s) cleared and {new_count} appeared, a net "
            f"reduction of {abs(net)}. Check that the cleared ones were fixed "
            "rather than simply no longer visible — losing read access to a "
            "subscription looks identical to fixing everything in it."
        )
    if net > 0:
        return (
            f"{new_count} new finding(s) against {resolved_count} cleared, a net "
            f"increase of {net}. New resources arrive non-compliant by default, "
            "so growth alone can explain this."
        )
    return (
        f"{new_count} appeared and {resolved_count} cleared, leaving the total "
        "unchanged. The work is keeping pace with what arrives, not reducing it."
    )


def summarise(findings: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Counts by severity, category and subscription, for the filters."""
    by_severity: Dict[str, int] = {}
    by_category: Dict[str, int] = {}
    by_subscription: Dict[str, int] = {}

    for finding in findings:
        severity = finding.get("severity", "medium")
        by_severity[severity] = by_severity.get(severity, 0) + 1

        category = finding.get("category") or "Uncategorised"
        by_category[category] = by_category.get(category, 0) + 1

        sub = finding.get("subscription_id") or "unknown"
        by_subscription[sub] = by_subscription.get(sub, 0) + 1

    saving = sum(
        f["annual_saving"] for f in findings
        if isinstance(f.get("annual_saving"), (int, float))
    )

    return {
        "total": len(findings),
        "by_severity": by_severity,
        "by_category": dict(sorted(by_category.items(), key=lambda kv: -kv[1])),
        "by_subscription": by_subscription,
        "high_count": by_severity.get("high", 0),
        "annual_saving": round(saving, 2) if saving else 0.0,
    }


def sort_findings(findings: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Most severe first, then alphabetical so the order is stable between runs."""
    return sorted(
        findings,
        key=lambda f: (SEVERITY_RANK.get(f.get("severity", "medium"), 2), _lower(f.get("title"))),
    )


def pack(findings: List[Dict[str, Any]]) -> str:
    """Serialise a snapshot for storage. Separators trimmed; these get large."""
    return json.dumps(findings, separators=(",", ":"))


def unpack(payload: Optional[str]) -> List[Dict[str, Any]]:
    """
    Read a stored snapshot back.

    A snapshot that will not parse is treated as an empty one rather than an
    error: a corrupt row from an old shape should cost the comparison, not the
    page.
    """
    if not payload:
        return []
    try:
        data = json.loads(payload)
    except (TypeError, ValueError):
        return []
    return data if isinstance(data, list) else []
