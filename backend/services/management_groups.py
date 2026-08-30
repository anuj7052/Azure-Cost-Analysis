"""
The management group hierarchy, and the role assignments made on it.

Everything else in this application scopes to subscriptions, because that is
where cost lives. Access does not. In any estate large enough to have a platform
team, the grants that matter most are made at a management group and inherited
downward by every subscription underneath — which means a review that reads only
subscriptions sees the *effect* of those grants without ever seeing the grant.

That distinction is the whole reason this module exists. Two things are needed
and neither comes from the subscription APIs:

    1. The shape of the tree, so a finding can say "this applies to the fourteen
       subscriptions under Production" instead of naming one of them.
    2. The assignments written *at* each group, read with `atScope()` so a grant
       is reported once at the level it was made rather than once per
       subscription that inherits it.

Both reads are tenant-wide and neither is scoped by the subscription selector,
so both are guarded by the same rule used everywhere else: what the caller's own
token can see is the whole of what they get. Azure returns only the groups the
token has `Microsoft.Management/managementGroups/read` on, so a caller with no
management group access receives an empty tree — which is reported as "none
visible to this account", never as "this tenant has none".
"""
import asyncio
import logging
from typing import Any, Dict, List, Optional, Tuple

import httpx

from services import access_review
from services.security_fetch import (
    MGMT_BASE,
    ROLE_ASSIGNMENTS_API,
    _get_all,
    describe_failure,
)

log = logging.getLogger(__name__)

MANAGEMENT_API = "2021-04-01"

# The source name used in coverage notes and failure records, matching the
# convention the other security reads use.
SOURCE = "management-groups"

# A tenant with more groups than this is either enormous or misconfigured, and
# either way reading all of them one descendant call at a time is the wrong
# shape of request. The cap is reported rather than applied silently.
MAX_GROUPS = 60

# Descendant reads fan out one request per group. Four at a time is the same
# ceiling the other security fetchers use, for the same reason: the throttle is
# per-tenant and we are competing with ourselves.
MAX_CONCURRENT = 4

TENANT_ROOT_KIND = "tenant root"


def _text(value: Any) -> str:
    return str(value or "").strip()


def group_id(name: str) -> str:
    """The full scope path for a management group, from its short name."""
    return f"/providers/Microsoft.Management/managementGroups/{_text(name)}"


def normalise_group(raw: Dict[str, Any]) -> Dict[str, Any]:
    """
    One management group, flattened.

    `name` is the immutable id Azure addresses the group by, `display_name` is
    what a human called it, and the two are frequently unrelated — a group named
    `mg-prod-7742` displayed as "Production". Both are kept, because the id is
    what every other API needs and the name is the only one worth showing.
    """
    props = raw.get("properties") or {}
    name = _text(raw.get("name"))
    return {
        "id": _text(raw.get("id")) or group_id(name),
        "name": name,
        "display_name": _text(props.get("displayName")) or name,
        "tenant_id": _text(props.get("tenantId")),
        "parent": _parent_name(props),
    }


def _parent_name(props: Dict[str, Any]) -> str:
    """
    The short name of this group's parent, or "" for the tenant root.

    Azure puts the parent in two different places depending on which call
    returned the object: under `details` on a management group, and directly on
    a descendant. Both are read here rather than in two near-identical helpers,
    because getting it wrong in the descendant case does not raise — it silently
    attaches every subscription in the estate to the root group.
    """
    parent = props.get("parent") or (props.get("details") or {}).get("parent") or {}
    path = _text(parent.get("id"))
    if not path:
        return ""
    return path.rsplit("/", 1)[-1]


def build_tree(groups: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Nest a flat group list into the hierarchy Azure describes but does not return.

    Groups whose parent is not in the list are promoted to the top rather than
    dropped. That case is normal, not corrupt: a caller granted access to one
    mid-level group sees that group and everything under it, and never sees the
    parent it hangs from. Dropping it would show an empty tree to somebody who
    has perfectly good access to part of one.
    """
    by_name: Dict[str, Dict[str, Any]] = {}
    for group in groups:
        by_name[group["name"]] = {**group, "children": []}

    roots: List[Dict[str, Any]] = []
    for node in by_name.values():
        parent = by_name.get(node["parent"])
        if parent is None or parent is node:
            roots.append(node)
        else:
            parent["children"].append(node)

    def order(nodes: List[Dict[str, Any]]) -> None:
        nodes.sort(key=lambda n: n["display_name"].lower())
        for node in nodes:
            order(node["children"])

    order(roots)
    return roots


def flatten_tree(roots: List[Dict[str, Any]], depth: int = 0) -> List[Dict[str, Any]]:
    """
    The tree again, in reading order with a depth on each row.

    A select element cannot render a tree, and indenting by depth is how the
    hierarchy survives being put in a dropdown.
    """
    rows: List[Dict[str, Any]] = []
    for node in roots:
        rows.append({
            "id": node["id"],
            "name": node["name"],
            "display_name": node["display_name"],
            "parent": node["parent"],
            "depth": depth,
            "subscription_count": len(node.get("subscriptions") or []),
        })
        rows.extend(flatten_tree(node.get("children") or [], depth + 1))
    return rows


def attach_subscriptions(
    roots: List[Dict[str, Any]],
    membership: Dict[str, List[Dict[str, Any]]],
) -> None:
    """Hang each group's directly-contained subscriptions off its node."""
    for node in roots:
        node["subscriptions"] = membership.get(node["name"], [])
        attach_subscriptions(node.get("children") or [], membership)


def subscription_group_index(
    roots: List[Dict[str, Any]],
    inherited: Optional[List[Dict[str, Any]]] = None,
    index: Optional[Dict[str, List[Dict[str, Any]]]] = None,
) -> Dict[str, List[Dict[str, Any]]]:
    """
    For each subscription, the chain of groups above it, outermost first.

    This is what lets a subscription-scoped finding say which part of the
    hierarchy it sits under. Built once by walking down, rather than per
    subscription by walking up, because the walk-up version re-reads the same
    parents once per subscription in the tenant.
    """
    index = {} if index is None else index
    inherited = inherited or []

    for node in roots:
        chain = inherited + [{
            "name": node["name"],
            "display_name": node["display_name"],
            "id": node["id"],
        }]
        for sub in node.get("subscriptions") or []:
            index[str(sub.get("subscription_id") or "").lower()] = chain
        subscription_group_index(node.get("children") or [], chain, index)

    return index


# ---------------------------------------------------------------------------
# Azure reads
# ---------------------------------------------------------------------------

async def fetch_groups(token: str) -> Tuple[List[Dict[str, Any]], bool]:
    """
    Every management group this token can see, flat.

    Returns the groups and whether the list was cut short. A cut-short list is
    worth saying out loud: the tree drawn from it is a real part of the
    hierarchy, but it is not the hierarchy.
    """
    flags: Dict[str, Any] = {}
    url = f"{MGMT_BASE}/providers/Microsoft.Management/managementGroups?api-version={MANAGEMENT_API}"
    async with httpx.AsyncClient(timeout=60) as client:
        raw = await _get_all(client, url, token, max_pages=10, flags=flags)

    groups = [normalise_group(item) for item in raw if _text(item.get("name"))]
    truncated = bool(flags.get("truncated")) or len(groups) > MAX_GROUPS
    return groups[:MAX_GROUPS], truncated


async def fetch_descendants(token: str, name: str) -> List[Dict[str, Any]]:
    """
    Everything beneath one group: nested groups and subscriptions alike.

    Only the subscriptions are used here — the nested groups are already known
    from the flat list — but Azure returns both from one call and separating
    them costs nothing.
    """
    url = (
        f"{MGMT_BASE}/providers/Microsoft.Management/managementGroups/{name}"
        f"/descendants?api-version={MANAGEMENT_API}"
    )
    async with httpx.AsyncClient(timeout=60) as client:
        return await _get_all(client, url, token, max_pages=10)


def subscriptions_of(descendants: List[Dict[str, Any]], parent: str) -> List[Dict[str, Any]]:
    """
    The subscriptions directly inside one group, from its descendant list.

    "Directly" matters. The descendants call is recursive, so without the parent
    check every subscription in the estate would be attached to the root group
    as well as to the group it actually lives in, and the counts shown next to
    each node would be wrong in the least obvious way — too large, and only for
    the nodes nearest the top.
    """
    rows: List[Dict[str, Any]] = []
    for item in descendants:
        if _text(item.get("type")).lower() != "microsoft.management/managementgroups/subscriptions":
            continue
        props = item.get("properties") or {}
        if _parent_name(props) != parent:
            continue
        rows.append({
            "subscription_id": _text(item.get("name")),
            "display_name": _text(props.get("displayName")) or _text(item.get("name")),
        })
    rows.sort(key=lambda r: r["display_name"].lower())
    return rows


async def fetch_hierarchy(token: str) -> Dict[str, Any]:
    """
    The tree, with subscriptions attached, and an honest note about what it is.

    A failure to read descendants for one group is not allowed to fail the
    hierarchy: the group still exists and still holds assignments, it simply
    shows no subscription count. Losing the whole tree because one node was
    unreadable would be a much worse trade.
    """
    errors: List[Dict[str, Any]] = []

    try:
        groups, truncated = await fetch_groups(token)
    except Exception as exc:  # noqa: BLE001 - reported, not swallowed
        return {
            "groups": [],
            "flat": [],
            "truncated": False,
            "errors": [describe_failure(exc, SOURCE, "")],
            "note": (
                "Management groups could not be read with this account's token. "
                "Access findings below are scoped to subscriptions only, which "
                "means a grant made at a management group is visible through "
                "its effect and not by name."
            ),
        }

    semaphore = asyncio.Semaphore(MAX_CONCURRENT)

    async def one(group: Dict[str, Any]) -> Tuple[str, List[Dict[str, Any]]]:
        async with semaphore:
            try:
                descendants = await fetch_descendants(token, group["name"])
            except Exception as exc:  # noqa: BLE001
                errors.append(describe_failure(exc, SOURCE, group["name"]))
                return group["name"], []
            return group["name"], subscriptions_of(descendants, group["name"])

    membership = dict(await asyncio.gather(*(one(g) for g in groups)))

    roots = build_tree(groups)
    attach_subscriptions(roots, membership)

    return {
        "groups": roots,
        "flat": flatten_tree(roots),
        "truncated": truncated,
        "errors": errors,
        "note": _hierarchy_note(groups, truncated),
    }


def _hierarchy_note(groups: List[Dict[str, Any]], truncated: bool) -> str:
    if not groups:
        return (
            "No management groups are visible to this account. That is a "
            "statement about this token's access, not about the tenant — "
            "reading the hierarchy needs Management Group Reader, which is "
            "granted separately from subscription access."
        )
    if truncated:
        return (
            f"Showing the first {MAX_GROUPS} management groups. The hierarchy "
            "is larger than this, so treat the tree as a section of the estate "
            "rather than all of it."
        )
    return (
        f"{len(groups)} management group(s) visible to this account. Grants made "
        "here are inherited by every subscription underneath and are listed once, "
        "at the level they were made."
    )


async def fetch_role_assignments_at_group(
    token: str,
    name: str,
    display_name: str = "",
) -> Dict[str, Any]:
    """
    The assignments written *at* one management group.

    `atScope()` is the entire point of this filter. Without it Azure returns
    every assignment inherited from above as well, and merging that with the
    per-subscription reads would list a single tenant-root Owner grant once for
    the root, once for every group beneath it, and once for every subscription
    beneath those — turning one grant into dozens of identical findings and
    making the sprawl detector report a pattern that does not exist.
    """
    url = (
        f"{MGMT_BASE}{group_id(name)}/providers/Microsoft.Authorization"
        f"/roleAssignments?api-version={ROLE_ASSIGNMENTS_API}&$filter=atScope()"
    )

    flags: Dict[str, Any] = {}
    async with httpx.AsyncClient(timeout=90) as client:
        raw = await _get_all(client, url, token, flags=flags)

    assignments = []
    for item in raw:
        assignment = access_review.normalise_assignment(item)
        # The scope path carries the group's immutable id, never its display
        # name, so a page built only from the assignment would label the row
        # `mg-prod-7742`. The readable name is only available here, from the
        # hierarchy read that already happened.
        if display_name:
            assignment["management_group_name"] = display_name
            assignment["scope_label"] = display_name
            assignment["scope_sentence"] = (
                f"Applies to every subscription under the {display_name} "
                "management group."
            )
        assignments.append(assignment)

    return {
        "assignments": assignments,
        "truncated": bool(flags.get("truncated")),
    }


async def fetch_group_assignments(
    token: str,
    groups: List[Dict[str, Any]],
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], bool]:
    """
    Assignments across every visible group, with per-group failures named.

    Returns (assignments, errors, truncated). One unreadable group is recorded
    and skipped for the same reason a 403 on one subscription is: an access
    review that refuses to render is worse than one that says which part is
    missing.
    """
    assignments: List[Dict[str, Any]] = []
    errors: List[Dict[str, Any]] = []
    truncated = False

    semaphore = asyncio.Semaphore(MAX_CONCURRENT)

    async def one(group: Dict[str, Any]) -> None:
        nonlocal truncated
        async with semaphore:
            try:
                payload = await fetch_role_assignments_at_group(
                    token, group["name"], group.get("display_name", "")
                )
            except Exception as exc:  # noqa: BLE001
                errors.append(describe_failure(exc, SOURCE, group["name"]))
                return
        assignments.extend(payload["assignments"])
        if payload["truncated"]:
            truncated = True

    await asyncio.gather(*(one(g) for g in groups))
    return assignments, errors, truncated
