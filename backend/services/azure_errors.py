"""
Turning an Azure API failure into something the user can act on.

An upstream error carries a status that says exactly what went wrong — the
token expired, the role is missing, Azure is throttling — and collapsing all of
them into "502: Resource Graph query failed: <stack trace>" throws that away.
The user is left with a number and no next step.
"""
from typing import Optional

import httpx
from fastapi import HTTPException


def _status_of(exc: Exception) -> Optional[int]:
    response = getattr(exc, "response", None)
    return getattr(response, "status_code", None)


def azure_error(exc: Exception, what: str = "Azure") -> HTTPException:
    """
    Map an upstream failure to a status and a sentence worth reading.

    The status is chosen so the frontend's existing handling applies: 401 clears
    the cached token and prompts a fresh sign-in, 429 shows the throttling
    notice. Reporting everything as 502 meant none of that fired.
    """
    status = _status_of(exc)

    if status == 401:
        # This is the common case after an hour: the token that worked on page
        # load has since expired. Saying "unauthorized" alone sends people to
        # check role assignments that were never the problem.
        return HTTPException(
            status_code=401,
            detail=(
                "Azure rejected the credential while reading your resources. "
                "The access token has most likely expired — sign out and sign in "
                "again, or paste a fresh session token in Settings."
            ),
        )

    if status == 403:
        return HTTPException(
            status_code=403,
            detail=(
                f"Access denied reading {what}. The service principal needs the "
                "Reader role on the selected subscriptions."
            ),
        )

    if status == 429:
        retry = ""
        response = getattr(exc, "response", None)
        if response is not None:
            seconds = response.headers.get("retry-after")
            if seconds:
                retry = f" Retry in about {seconds}s."
        return HTTPException(
            status_code=429,
            detail=f"Azure is rate limiting these requests.{retry}",
        )

    if isinstance(exc, (httpx.ConnectError, httpx.ReadTimeout, httpx.ConnectTimeout)):
        return HTTPException(
            status_code=504,
            detail=f"Azure did not respond while reading {what}. Try again shortly.",
        )

    # Anything genuinely unexpected keeps its detail, truncated: a full stack
    # trace in a toast is unreadable, but the first line is often the clue.
    reason = str(exc)
    if len(reason) > 200:
        reason = f"{reason[:200]}…"
    return HTTPException(status_code=502, detail=f"Could not read {what}: {reason}")
