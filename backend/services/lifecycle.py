"""
When a resource was created, changed and deleted -- and how well we know it.

Three sources can answer "when was this made", and they disagree in ways that
matter:

  * The resource's own configuration bag. Many providers stamp a `timeCreated`
    into it, and that is Azure's own record of the moment the resource came
    into existence. Exact, and true no matter how long ago it happened.
  * The Activity Log. Exact to the second and it also names the person, but
    Azure keeps only ninety days of it. Beyond that the log is empty, which is
    not the same as nothing having happened.
  * Our own scan snapshots. Always available for anything we ever captured,
    but only as precise as the scan interval. A weekly scan can say "this
    existed by Tuesday" and cannot say it was made on Tuesday.

The temptation is to pick whichever is available and present a single date.
That produces a column where some rows are accurate to the second and others
are accurate to the week, with nothing on screen to tell them apart, and a
reader who trusts one row learns to distrust all of them. So every date here
carries its source and whether it is exact, and the caller is expected to show
that. A date qualified as approximate is worth far more than a precise-looking
date that quietly is not.
"""
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

# Where a date came from. Ordered by how much it can be trusted.
SOURCE_AZURE = "azure"        # the resource's own creation stamp
SOURCE_ACTIVITY = "activity"  # an Activity Log entry, with a named caller
SOURCE_SNAPSHOT = "snapshot"  # inferred from when our scans saw it

# Keys a provider might use for a creation timestamp. Azure is not consistent
# about this across resource types, and there is no schema that says which one
# a given provider uses -- so we look for any of them.
CREATED_KEYS = frozenset({
    "timecreated",
    "creationtime",
    "createdtime",
    "createddate",
    "creationdate",
    "createdon",
    "creationdata",  # disks nest the real stamp under here
    "starttime",
})

# How far into the configuration bag to look for a creation stamp. Providers
# nest it one or two levels down at most; going deeper starts finding the
# creation dates of unrelated child objects, which is worse than finding none.
MAX_CREATED_DEPTH = 3


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _looks_like_timestamp(value: str) -> bool:
    """
    Whether a string is plausibly an ISO 8601 instant.

    Checked rather than assumed because these keys also hold things like
    `"startTime": "02:00"` on a maintenance window, and a schedule presented as
    a creation date is a straightforwardly wrong answer.
    """
    if len(value) < 10:
        return False
    candidate = value.replace("Z", "+00:00")
    try:
        datetime.fromisoformat(candidate)
    except ValueError:
        return False
    return True


def created_timestamp(properties: Optional[Dict[str, Any]], depth: int = 0) -> Optional[str]:
    """
    Azure's own record of when the resource was made, if the provider stamped one.

    Returns None rather than a guess. The caller falls back to the scan
    snapshot and says so, which is honest; inventing a date here would be
    indistinguishable from the real thing further up.
    """
    if not isinstance(properties, dict) or depth > MAX_CREATED_DEPTH:
        return None

    for key, value in properties.items():
        if not isinstance(key, str):
            continue
        if key.lower() in CREATED_KEYS:
            text = _text(value)
            if text and _looks_like_timestamp(text):
                return text

    # Nothing at this level, so look one deeper. Done as a second pass so a
    # stamp on the resource itself always wins over one on a nested child.
    for value in properties.values():
        if isinstance(value, dict):
            found = created_timestamp(value, depth + 1)
            if found:
                return found

    return None


def _parse(value: Optional[str]) -> Optional[datetime]:
    text = _text(value or "")
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    # Scan timestamps are stored without a zone. Treating them as UTC keeps
    # them comparable with Activity Log entries, which always carry one;
    # comparing a naive and an aware datetime raises instead of sorting.
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _dated(
    at: Optional[str],
    source: str,
    exact: bool,
    by: str = "",
    detail: str = "",
) -> Optional[Dict[str, Any]]:
    if not at:
        return None
    return {"at": at, "source": source, "exact": exact, "by": by, "detail": detail}


# Activity Log operations end in a verb. `write` covers both creating a
# resource and updating one -- Azure does not distinguish them, so neither do
# we. Calling every write a creation would date a resource to the last time
# somebody edited a tag on it.
def is_create_or_update(event: Dict[str, Any]) -> bool:
    return _text(event.get("operation", "")).lower().endswith("/write")


def is_delete(event: Dict[str, Any]) -> bool:
    return _text(event.get("operation", "")).lower().endswith("/delete")


def _successful(events: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Writes that actually took effect.

    A refused attempt is worth showing elsewhere, but it changed nothing, and
    dating a resource to an operation that failed would be wrong twice over.
    """
    return [e for e in events if e.get("succeeded")]


def build_lifecycle(
    first_seen: Optional[str],
    last_seen: Optional[str],
    properties: Optional[Dict[str, Any]],
    removed_at: Optional[str] = None,
    activity: Optional[List[Dict[str, Any]]] = None,
    activity_covers_from: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Assemble the creation, deletion and last-change dates for one resource.

    `activity_covers_from` is the oldest instant the Activity Log could speak
    for. Without it, a resource created before the retention window looks
    identical to one nobody ever touched, and the difference is the whole point
    of reporting a source.
    """
    events = _successful(activity or [])
    events = sorted(events, key=lambda e: _text(e.get("at", "")))

    writes = [e for e in events if is_create_or_update(e)]
    deletes = [e for e in events if is_delete(e)]

    horizon = _parse(activity_covers_from)
    first_seen_at = _parse(first_seen)

    created: Optional[Dict[str, Any]] = None

    # Azure's own stamp first: it is exact and it survives past the log's
    # ninety day retention, which is where most resources live.
    stamped = created_timestamp(properties)
    if stamped:
        created = _dated(
            stamped, SOURCE_AZURE, exact=True,
            detail="Reported by Azure as the resource's creation time.",
        )

    # Otherwise the earliest write we can see, but only when the log actually
    # reaches back far enough to have caught the creation. A write from three
    # weeks ago on a two year old resource is an edit, not a birth.
    if created is None and writes and horizon and first_seen_at and first_seen_at >= horizon:
        earliest = writes[0]
        created = _dated(
            earliest.get("at"), SOURCE_ACTIVITY, exact=True,
            by=_text(earliest.get("caller", "")),
            detail="Taken from the Activity Log entry that created the resource.",
        )

    # Failing both, the first scan that saw it. This is a bound, not a date:
    # the resource existed by then and may have existed long before.
    if created is None and first_seen:
        created = _dated(
            first_seen, SOURCE_SNAPSHOT, exact=False,
            detail=(
                "The resource already existed when this scan ran. It was not "
                "created then -- it was created at or before then."
            ),
        )

    deleted: Optional[Dict[str, Any]] = None
    if deletes:
        last_delete = deletes[-1]
        deleted = _dated(
            last_delete.get("at"), SOURCE_ACTIVITY, exact=True,
            by=_text(last_delete.get("caller", "")),
            detail="Taken from the Activity Log entry that deleted the resource.",
        )
    elif removed_at:
        deleted = _dated(
            removed_at, SOURCE_SNAPSHOT, exact=False,
            detail=(
                "Gone by the time this scan ran, and present in the one before "
                "it. The deletion happened somewhere between the two."
            ),
        )

    # The most recent write that is not the creation. Shown as "last changed",
    # so counting the creation would make every brand new resource look as
    # though it had already been edited.
    last_changed: Optional[Dict[str, Any]] = None
    created_at = _parse(created["at"]) if created else None
    for event in reversed(writes):
        moment = _parse(event.get("at"))
        if created_at and moment and moment <= created_at:
            continue
        last_changed = _dated(
            event.get("at"), SOURCE_ACTIVITY, exact=True,
            by=_text(event.get("caller", "")),
            detail=_text(event.get("summary", "")),
        )
        break

    return {
        "created": created,
        "deleted": deleted,
        "last_changed": last_changed,
        "still_present": deleted is None,
        # Reported so the page can say "the Activity Log only goes back to X"
        # instead of implying nothing happened before it.
        "activity_covers_from": activity_covers_from,
        "last_seen": last_seen,
    }


def attach_activity(
    events: List[Dict[str, Any]],
    activity: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """
    Name the person behind each recorded change, where the log can say.

    A snapshot diff knows a VM went from four cores to eight and knows it
    happened between two scans. It cannot know who did it. The Activity Log
    can, and matching the two on their time windows is the only way to put a
    name next to a change.

    The match is a window, not a moment, and it is reported as such: every
    successful write between the previous scan and this one is offered as a
    candidate. Picking one and presenting it as the cause would be a guess
    dressed as a fact, and on a busy resource it would frequently be the wrong
    guess.

    `events` must be newest-first, which is how `changes.entity_history`
    returns them.
    """
    writes = _successful(activity)
    enriched: List[Dict[str, Any]] = []

    for index, event in enumerate(events):
        moment = _parse(event.get("at"))
        # The previous scan, in a newest-first list, is the next entry along.
        previous = _parse(events[index + 1].get("at")) if index + 1 < len(events) else None

        candidates: List[Dict[str, Any]] = []
        if moment:
            for entry in writes:
                when = _parse(entry.get("at"))
                if not when or when > moment:
                    continue
                if previous and when <= previous:
                    continue
                candidates.append({
                    "at": entry.get("at"),
                    "caller": _text(entry.get("caller", "")),
                    "operation": _text(entry.get("operation", "")),
                    "summary": _text(entry.get("summary", "")),
                })

        candidates.sort(key=lambda c: c["at"] or "", reverse=True)
        enriched.append({
            **event,
            "by": candidates[0]["caller"] if len(candidates) == 1 else "",
            "activity": candidates,
            # The window the candidates were drawn from, so the page can say
            # "between these two scans" rather than implying a single instant.
            "window_from": events[index + 1].get("at") if index + 1 < len(events) else None,
            "window_to": event.get("at"),
        })

    return enriched
