"""
What changed in the estate while a cost moved.

The anomaly engine deliberately refuses to say why a cost moved, and that
refusal is right: billing data records what was charged, never what anybody
did, and a guess phrased as a cause is worse than no cause at all.

This module does not overturn that. It answers a different and answerable
question -- *what else happened in the same place at the same time* -- by
lining the anomaly's window and scope up against the resource snapshots we
already hold and the Activity Log. A VM resized from four cores to eight on the
14th, sitting beside a compute cost that rose in the same resource group in the
same week, is evidence. It is strong evidence. It is still not proof, because
nothing in either data set links the charge to the change.

So everything returned here is labelled as evidence and ranked by how well it
lines up, and the wording never says "caused". The distinction survives all the
way to the screen or it was not worth making.
"""
import re
from typing import Any, Dict, List, Optional

# How well a change lines up with the cost move.
STRONG = "strong"      # in scope, in window, and moving the same way as the bill
POSSIBLE = "possible"  # in scope and in window, but not obviously related

# Words that carry no meaning when matching a resource type against a billed
# service name. Every Azure type contains "microsoft"; matching on it would
# make every resource relevant to every service.
_STOPWORDS = frozenset({
    "microsoft", "azure", "the", "and", "service", "services",
    "standard", "basic", "premium", "general",
})

_WORD = re.compile(r"[a-z]+")
_NUMBER = re.compile(r"\d+")


def _tokens(text: str) -> set:
    """
    Lower-cased words from a type or service name, camelCase split apart.

    `Microsoft.Compute/virtualMachines` and the billed service `Virtual
    Machines` are the same thing written two ways, and they only match once the
    camel hump is treated as a space.
    """
    spaced = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", text or "")
    return {w for w in _WORD.findall(spaced.lower()) if w not in _STOPWORDS and len(w) > 2}


def type_matches_service(resource_type: str, service: str) -> bool:
    """
    Whether a resource type plausibly bills under this service name.

    Deliberately loose. Azure's billed service names are marketing names and do
    not map cleanly onto ARM types -- there is no published table that does it
    -- so this is a word overlap, and a miss only costs the finding its
    promotion to strong. Nothing is discarded for failing it.
    """
    if not resource_type or not service:
        return False
    return bool(_tokens(resource_type) & _tokens(service))


def sku_direction(before: str, after: str) -> Optional[str]:
    """
    Whether a SKU change made the resource bigger or smaller.

    Read from the numbers in the name, because that is the only signal a SKU
    string reliably carries: `Standard_D2s_v3` to `Standard_D4s_v3` is a
    doubling, `P10` to `P30` is a bigger disk. It is a heuristic and it is
    treated as one -- when the numbers do not move, or there are none, this
    returns None and the change is reported as a change rather than as growth.

    The version suffix is dropped first. `_v3` to `_v5` is a hardware
    generation, not a size, and reading it as growth turns every modernisation
    into a phantom cost rise.
    """
    def sizes(text: str) -> List[int]:
        stripped = re.sub(r"[_-]v\d+\b", "", text or "", flags=re.IGNORECASE)
        return [int(n) for n in _NUMBER.findall(stripped)]

    old, new = sizes(before), sizes(after)
    if not old or not new:
        return None
    if max(new) > max(old):
        return "larger"
    if max(new) < max(old):
        return "smaller"
    return None


def _field(changes: List[Dict[str, Any]], name: str) -> Optional[Dict[str, Any]]:
    for change in changes or []:
        if change.get("field") == name:
            return change
    return None


def _pair(change: Dict[str, Any]) -> tuple:
    """
    The old and new value of a changed field.

    The diff calls these "from" and "to", following the FieldChange schema.
    Reading them as "before"/"after" is a silent failure rather than a loud
    one: every lookup returns None, so no resize is ever recognised as growth
    and every headline reads "changed from - to -". Worth naming once here.
    """
    return str(change.get("from") or ""), str(change.get("to") or "")


def headline(kind: str, resource: Dict[str, Any]) -> str:
    """One line saying what happened, in the words somebody would use."""
    name = resource.get("name") or "A resource"

    if kind == "added":
        return f"{name} was created"
    if kind == "removed":
        return f"{name} was deleted"

    sku = _field(resource.get("changes", []), "sku")
    if sku:
        old, new = _pair(sku)
        grew = sku_direction(old, new)
        suffix = f" ({grew})" if grew else ""
        return f"{name} changed from {old or '—'} to {new or '—'}{suffix}"

    fields = [c.get("field") for c in resource.get("changes", []) if c.get("field")]
    if fields:
        return f"{name} had {', '.join(fields[:3])} changed"
    return f"{name} was modified"


def in_scope(resource: Dict[str, Any], scope: Dict[str, Any]) -> bool:
    """
    Whether a changed resource sits where the anomaly was measured.

    Subscription and resource group only. Matching on the service name as well
    was tried and it hid the interesting findings: a disk resized inside a
    resource group bills under Storage while the anomaly was raised against
    Virtual Machines, and excluding it removed exactly the change somebody
    needed to see. Service is used to rank, never to filter.
    """
    subscription = (scope.get("subscription_id") or "").lower()
    group = (scope.get("resource_group") or "").lower()

    if subscription and (resource.get("subscription_id") or "").lower() != subscription:
        return False
    if group and (resource.get("resource_group") or "").lower() != group:
        return False
    return True


def _agrees_with(kind: str, resource: Dict[str, Any], direction: str) -> bool:
    """
    Whether this change would move the bill the way the bill actually moved.

    A deletion next to a rising cost is not evidence for the rise, and listing
    it as though it were is how a reader stops reading the list.
    """
    rising = direction in ("increase", "new")
    falling = direction in ("decrease", "removed")

    if kind == "added":
        return rising
    if kind == "removed":
        return falling

    sku = _field(resource.get("changes", []), "sku")
    if sku:
        grew = sku_direction(*_pair(sku))
        if grew == "larger":
            return rising
        if grew == "smaller":
            return falling
    return False


def _reason(kind: str, agrees: bool, service_match: bool, direction: str) -> str:
    if not agrees:
        return "Happened in the same place and period, but would not move the bill this way."
    moved = "rise" if direction in ("increase", "new") else "fall"
    if service_match:
        return f"Same service, same period, and this change would make the cost {moved}."
    return f"Same period and location, and this change would make the cost {moved}."


def explain(
    diff: Dict[str, Any],
    scope: Dict[str, Any],
    direction: str,
    limit: int = 25,
) -> List[Dict[str, Any]]:
    """
    Rank the changes that could account for an anomaly, strongest first.

    `diff` is a `changes.diff_by_date` result covering the anomaly's window.
    `scope` carries the anomaly's subscription, resource group and service.

    Nothing here is filtered out for being weak. A reader who scrolls past the
    strong findings and sees the weak ones has learned that we looked and found
    nothing better, which is a real answer; a short list with no explanation is
    indistinguishable from a broken query.
    """
    service = scope.get("service") or ""
    found: List[Dict[str, Any]] = []

    for kind in ("added", "removed", "modified"):
        for resource in diff.get(kind) or []:
            if not in_scope(resource, scope):
                continue

            agrees = _agrees_with(kind, resource, direction)
            service_match = type_matches_service(resource.get("type", ""), service)

            found.append({
                "kind": kind,
                "resource_id": resource.get("resource_id", ""),
                "name": resource.get("name", ""),
                "type": resource.get("type", ""),
                "resource_group": resource.get("resource_group", ""),
                "subscription_id": resource.get("subscription_id", ""),
                "headline": headline(kind, resource),
                "changes": resource.get("changes", []),
                "relevance": STRONG if agrees else POSSIBLE,
                "service_match": service_match,
                "why_relevant": _reason(kind, agrees, service_match, direction),
            })

    # Strong first, then a service match, then creations and deletions ahead of
    # edits -- a resource appearing or vanishing explains more of a bill than a
    # property moving on one that was there throughout.
    weight = {"added": 2, "removed": 2, "modified": 1}
    found.sort(
        key=lambda f: (
            f["relevance"] == STRONG,
            f["service_match"],
            weight[f["kind"]],
        ),
        reverse=True,
    )
    return found[:limit]


def summarise(evidence: List[Dict[str, Any]], direction: str) -> str:
    """
    The sentence shown above the list.

    Written to be read by somebody who will not read the list. It has to convey
    both what we found and that we are not claiming it caused anything, in one
    line, without hedging so heavily that it says nothing.
    """
    if not evidence:
        return (
            "Nothing in your scans changed in this subscription and resource "
            "group during this period. The cost moved for a reason our "
            "snapshots cannot see -- usage of resources that already existed, "
            "a price change, or a discount starting or ending."
        )

    strong = [e for e in evidence if e["relevance"] == STRONG]
    moved = "increase" if direction in ("increase", "new") else "decrease"

    if not strong:
        return (
            f"{len(evidence)} change{'' if len(evidence) == 1 else 's'} happened "
            f"here during this period, but none of them would produce this "
            f"{moved}. Usage of existing resources is the more likely explanation."
        )

    if len(strong) == 1:
        return (
            f"One change here could account for this {moved}: "
            f"{strong[0]['headline']}. It happened in the same period, which is "
            f"evidence rather than proof -- billing data never records who did what."
        )

    return (
        f"{len(strong)} changes here could account for this {moved}, listed "
        f"strongest first. They happened in the same period, which is evidence "
        f"rather than proof -- billing data never records who did what."
    )
