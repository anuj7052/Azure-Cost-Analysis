"""
Find people in the signed-in user's own Microsoft directory.

This exists so that adding a colleague is a matter of typing three letters of
their name and picking them, rather than typing an email address correctly from
memory. It is the same shape as assigning a role in Azure IAM, and for the same
reason: a picker that only offers real people cannot produce a typo, and a typo
in this particular field would send an invitation to an address nobody owns.

Two things are deliberate.

The search is always scoped to the caller's own tenant, because Graph resolves
`/users` against the directory the token was issued for. There is no tenant
parameter to get wrong and no way to ask about somebody else's directory.

Directory read is admin-consented in most tenants and may simply be refused.
When that happens this returns an empty result with a reason rather than an
error, so the page can say what is missing and fall back to typing an address
by hand. Losing the convenience is not a reason to lose the feature.
"""

from __future__ import annotations

import logging
import re
from typing import Any, Dict, List, Optional

import httpx

GRAPH_BASE = "https://graph.microsoft.com/v1.0"
REQUEST_TIMEOUT = 15.0
MAX_RESULTS = 10

# Reasons a search came back empty that are not "nobody matched". The page
# says something different for each, because "your administrator has not
# granted this" and "no such person" need different responses from the reader.
REASON_NO_TOKEN = "no_graph_token"
REASON_FORBIDDEN = "no_directory_consent"
REASON_UPSTREAM = "graph_unavailable"

NOTE_NO_TOKEN = (
    "Directory search needs Microsoft Graph access, which this session does "
    "not have. Type the person's full email address instead."
)
NOTE_FORBIDDEN = (
    "Your administrator has not granted this app permission to read the "
    "directory, so people cannot be listed. Type the person's full email "
    "address instead."
)
NOTE_UPSTREAM = (
    "Microsoft Graph could not be reached just now. Type the person's full "
    "email address instead."
)

log = logging.getLogger(__name__)

# Graph's OData filters take a quoted string, and a stray apostrophe in a
# surname such as O'Neill would otherwise end the literal early. Doubling it
# is the OData escape.
def _quote(value: str) -> str:
    return value.replace("'", "''")


# A search box is a free-text field on a path to an upstream query, so the
# input is bounded rather than trusted. Letters, digits, spaces and the
# handful of punctuation marks that appear in real names and addresses.
_ALLOWED = re.compile(r"[^A-Za-z0-9 .@_\-']")


def clean_query(query: str) -> str:
    return _ALLOWED.sub("", (query or "").strip())[:60]


def _to_person(item: Dict[str, Any]) -> Dict[str, Any]:
    email = item.get("mail") or item.get("userPrincipalName") or ""
    return {
        "id": item.get("id", ""),
        "name": item.get("displayName") or email or "Unknown",
        "email": email,
        # Shown next to the name so two people called the same thing can be
        # told apart without opening another tab.
        "job_title": item.get("jobTitle") or "",
        "department": item.get("department") or "",
    }


async def search_people(
    graph_token: Optional[str], query: str
) -> Dict[str, Any]:
    """
    People in the caller's directory whose name or address starts with `query`.

    Returns a result envelope rather than a bare list, because "we could not
    look" and "we looked and found nobody" are different answers and the page
    has to tell the reader which one happened.
    """
    cleaned = clean_query(query)
    if len(cleaned) < 2:
        # Prefix search on one character returns most of a directory and helps
        # nobody. Say so rather than sending it.
        return {"people": [], "reason": None, "note": "Type at least two characters."}

    if not graph_token:
        return {"people": [], "reason": REASON_NO_TOKEN, "note": NOTE_NO_TOKEN}

    literal = _quote(cleaned)
    params = {
        "$filter": (
            f"startswith(displayName,'{literal}') or "
            f"startswith(mail,'{literal}') or "
            f"startswith(userPrincipalName,'{literal}') or "
            f"startswith(surname,'{literal}')"
        ),
        "$select": "id,displayName,mail,userPrincipalName,jobTitle,department",
        "$top": str(MAX_RESULTS),
        # Guest accounts belong to another directory. Offering one here would
        # produce an invitation that acceptance would then correctly refuse,
        # which is a confusing way to learn the rule.
        "$orderby": "displayName",
    }

    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
            response = await client.get(
                f"{GRAPH_BASE}/users",
                headers={"Authorization": f"Bearer {graph_token}"},
                params=params,
            )
    except Exception:
        log.warning("Directory search failed", exc_info=True)
        return {"people": [], "reason": REASON_UPSTREAM, "note": NOTE_UPSTREAM}

    if response.status_code in (401, 403):
        return {"people": [], "reason": REASON_FORBIDDEN, "note": NOTE_FORBIDDEN}
    if response.status_code >= 400:
        log.warning("Graph answered %s to a directory search", response.status_code)
        return {"people": [], "reason": REASON_UPSTREAM, "note": NOTE_UPSTREAM}

    try:
        items: List[Dict[str, Any]] = (response.json() or {}).get("value") or []
    except ValueError:
        return {"people": [], "reason": REASON_UPSTREAM, "note": NOTE_UPSTREAM}

    people = [_to_person(i) for i in items]
    # Someone with no address cannot be invited, so they are not offered.
    people = [p for p in people if p["email"]]
    return {"people": people, "reason": None, "note": ""}
