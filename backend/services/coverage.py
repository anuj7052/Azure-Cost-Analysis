"""
How much of the estate a number actually covers.

Every aggregate in this app is summed across subscriptions, and any one of them
can fail on its own — throttled, unauthorised, or simply slow. When that
happens the total is still a number, and it still looks like an answer. It is
not: it is the answer for the subscriptions that responded.

Presenting that as complete is the single most damaging thing this app could
do. Somebody reconciles it against an invoice, finds a shortfall, and either
distrusts the tool or — worse — trusts it and reports the wrong figure.

So every aggregated response carries its coverage, and the UI says so.
"""
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional


def build_coverage(
    requested: List[str],
    errors: List[Dict[str, Any]],
    source: str = "Azure Cost Management",
) -> Dict[str, Any]:
    """
    Describe what a result actually covers.

    `errors` are the per-subscription failures already collected by the callers;
    this only turns them into something the UI can state plainly.
    """
    failed_ids = [e.get("subscription_id") for e in errors if e.get("subscription_id")]
    total = len(requested)
    succeeded = total - len(failed_ids)

    return {
        "source": source,
        # UTC with an explicit marker: the frontend renders in local time, and a
        # naive timestamp there is silently read as local, putting "updated at"
        # hours out.
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "requested_subscriptions": total,
        "succeeded_subscriptions": succeeded,
        "failed_subscriptions": failed_ids,
        # The flag the UI keys off. Derived here rather than in each caller so
        # "partial" cannot come to mean different things on different pages.
        "partial": bool(failed_ids),
        "errors": errors,
    }


def empty_coverage(source: str = "Azure Cost Management") -> Dict[str, Any]:
    """Coverage for a result that came from somewhere other than Azure."""
    return {
        "source": source,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "requested_subscriptions": 0,
        "succeeded_subscriptions": 0,
        "failed_subscriptions": [],
        "partial": False,
        "errors": [],
    }


def describe(coverage: Optional[Dict[str, Any]]) -> str:
    """
    One sentence a person can read.

    Kept on the backend so the wording is identical everywhere it appears.
    """
    if not coverage:
        return ""

    total = coverage.get("requested_subscriptions", 0)
    ok = coverage.get("succeeded_subscriptions", 0)

    if not coverage.get("partial"):
        return f"Complete — {ok} of {total} subscriptions."

    missing = total - ok
    return (
        f"Partial data — {missing} of {total} subscription"
        f"{'s' if missing != 1 else ''} could not be queried."
    )
