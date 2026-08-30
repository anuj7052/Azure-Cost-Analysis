"""
Access findings a reviewer has looked at and accepted.

An access review is only useful if somebody can finish it. Real estates contain
grants that are *supposed* to look wrong: a break-glass account that is meant to
be unused, a disaster-recovery service principal that wakes up twice a year, a
vendor's support identity that nobody can remove. Every quarter those appear at
the top of the list again, and the reviewer who has already dismissed them three
times starts skimming — which is exactly when the real finding gets skipped.

So acceptance is recorded, with two deliberate limits:

  * **It hides, it never deletes.** The assignment is untouched in Azure and the
    finding is still produced; it is only filtered from the default view, always
    counted, and always retrievable. An audit that cannot see what was
    suppressed is not an audit.
  * **It is scoped to the workspace and the tenant.** One team's decision that a
    grant is fine is not evidence for another team, and the same principal id in
    a different tenant is a different account entirely.

A rule with an empty `finding_key` accepts everything about that principal --
the "hide principal" action -- and a rule with a key accepts one kind of finding
about one assignment.
"""
from typing import Any, Dict, Iterable, List, Optional

import aiosqlite

# The whole principal, rather than one finding about it.
WHOLE_PRINCIPAL = ""

# Long enough to record why, short enough that the column stays a note rather
# than becoming a document store.
MAX_NOTE = 300


def _text(value: Any) -> str:
    return str(value or "").strip()


def finding_key(finding: Dict[str, Any]) -> str:
    """
    A stable identifier for one finding about one grant.

    Built from the kind and the assignment id, because neither alone is enough:
    the same assignment can produce an unused finding *and* an over-privileged
    one, and accepting "yes, this service principal is dormant on purpose" must
    not also silence "and it holds Owner it never uses".

    Sprawl findings have no single assignment, so they fall back to the role
    name — which is correct for them, since the finding is about a role held in
    many places rather than about any one grant.
    """
    kind = _text(finding.get("kind")).lower()
    anchor = (
        _text(finding.get("assignment_id"))
        or _text(finding.get("scope"))
        or _text(finding.get("role_name"))
    ).lower()
    return f"{kind}:{anchor}"


async def list_rules(
    db: aiosqlite.Connection,
    user_id: int,
    tenant_id: str,
) -> List[Dict[str, Any]]:
    """Every acceptance this workspace holds for this tenant, newest first."""
    cursor = await db.execute(
        "SELECT principal_id, finding_key, note, created_by, created_at "
        "FROM access_ignores WHERE user_id = ? AND tenant_id = ? "
        "ORDER BY created_at DESC, id DESC",
        (user_id, _text(tenant_id)),
    )
    rows = await cursor.fetchall()
    return [
        {
            "principal_id": row[0],
            "finding_key": row[1],
            "note": row[2],
            "created_by": row[3],
            "created_at": row[4],
        }
        for row in rows
    ]


async def accept(
    db: aiosqlite.Connection,
    user_id: int,
    tenant_id: str,
    principal_id: str,
    key: str = WHOLE_PRINCIPAL,
    note: str = "",
    created_by: str = "",
) -> None:
    """
    Record an acceptance, or update the note on one that already exists.

    Accepting twice is not an error and does not create a second rule. A
    reviewer who clicks Hide again — most often because they want to correct the
    reason they gave — should end up with one rule carrying the newer note, not
    a constraint violation.
    """
    await db.execute(
        "INSERT INTO access_ignores "
        "(user_id, tenant_id, principal_id, finding_key, note, created_by) "
        "VALUES (?, ?, ?, ?, ?, ?) "
        "ON CONFLICT (user_id, tenant_id, principal_id, finding_key) "
        "DO UPDATE SET note = excluded.note",
        (
            user_id,
            _text(tenant_id),
            _text(principal_id).lower(),
            _text(key).lower(),
            _text(note)[:MAX_NOTE],
            _text(created_by),
        ),
    )
    await db.commit()


async def restore(
    db: aiosqlite.Connection,
    user_id: int,
    tenant_id: str,
    principal_id: str,
    key: str = WHOLE_PRINCIPAL,
) -> int:
    """Lift one acceptance. Lifting one that was never recorded is not an error."""
    cursor = await db.execute(
        "DELETE FROM access_ignores WHERE user_id = ? AND tenant_id = ? "
        "AND principal_id = ? AND finding_key = ?",
        (user_id, _text(tenant_id), _text(principal_id).lower(), _text(key).lower()),
    )
    await db.commit()
    return cursor.rowcount or 0


def index_rules(rules: Iterable[Dict[str, Any]]) -> Dict[str, Dict[str, str]]:
    """
    Rules arranged for lookup: principal id → finding key → note.

    Lower-cased on both sides. Azure is inconsistent about the case of object
    ids between APIs, and a rule that stops matching because one endpoint
    returned uppercase is a suppression that silently un-suppresses itself.
    """
    index: Dict[str, Dict[str, str]] = {}
    for rule in rules:
        principal = _text(rule.get("principal_id")).lower()
        if not principal:
            continue
        index.setdefault(principal, {})[_text(rule.get("finding_key")).lower()] = _text(
            rule.get("note")
        )
    return index


def accepted_note(
    finding: Dict[str, Any],
    index: Dict[str, Dict[str, str]],
) -> Optional[str]:
    """
    Why this finding was accepted, or None if it was not.

    Returns a string — possibly empty, when the reviewer gave no reason — so
    that "accepted with no note" stays distinguishable from "not accepted".
    Collapsing the two would make every unaccepted finding look dismissed.
    """
    rules = index.get(_text(finding.get("principal_id")).lower())
    if not rules:
        return None
    if WHOLE_PRINCIPAL in rules:
        return rules[WHOLE_PRINCIPAL]
    key = finding_key(finding)
    if key in rules:
        return rules[key]
    return None


def apply_rules(
    findings: List[Dict[str, Any]],
    rules: Iterable[Dict[str, Any]],
    show_hidden: bool = False,
) -> Dict[str, Any]:
    """
    Mark and, by default, remove accepted findings.

    Every finding is marked either way. The count of what was hidden is returned
    alongside, because a page that shows eleven findings when there are forty is
    lying unless it says so — and the number is what makes the "Show hidden"
    control worth clicking.
    """
    index = index_rules(rules)

    marked: List[Dict[str, Any]] = []
    hidden = 0
    for finding in findings:
        note = accepted_note(finding, index)
        entry = {
            **finding,
            "hidden": note is not None,
            "hidden_note": note or "",
            "finding_key": finding_key(finding),
        }
        if note is not None:
            hidden += 1
            if not show_hidden:
                continue
        marked.append(entry)

    return {"findings": marked, "hidden_count": hidden}


def principal_rows(findings: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    One row per principal, with its findings counted by severity.

    This is the left-hand column of the review: the list is sorted by how much
    there is to look at, so the account with eleven findings is read before the
    account with one. Sorting alphabetically would be sorting by an accident of
    somebody's surname.
    """
    people: Dict[str, Dict[str, Any]] = {}

    for finding in findings:
        key = _text(finding.get("principal_id")).lower() or _text(
            finding.get("principal_name")
        ).lower()
        entry = people.setdefault(key, {
            "principal_id": _text(finding.get("principal_id")),
            "principal_name": _text(finding.get("principal_name")),
            "principal_upn": _text(finding.get("principal_upn")),
            "principal_type": _text(finding.get("principal_type")),
            "resolved": bool(finding.get("resolved")),
            "severities": {},
            "kinds": {},
            "roles": set(),
            "finding_count": 0,
            "hidden_count": 0,
        })

        entry["finding_count"] += 1
        if finding.get("hidden"):
            entry["hidden_count"] += 1
        severity = _text(finding.get("severity")).lower() or "low"
        entry["severities"][severity] = entry["severities"].get(severity, 0) + 1
        kind = _text(finding.get("kind"))
        if kind:
            entry["kinds"][kind] = entry["kinds"].get(kind, 0) + 1
        role = _text(finding.get("role_name"))
        if role:
            entry["roles"].add(role)
        if finding.get("resolved"):
            entry["resolved"] = True

    rows = [{**entry, "roles": sorted(entry["roles"])} for entry in people.values()]
    rows.sort(
        key=lambda r: (
            -r["severities"].get("high", 0),
            -r["finding_count"],
            r["principal_name"].lower(),
        )
    )
    return rows
