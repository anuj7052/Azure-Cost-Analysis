"""
Turning a model provider's failure into something the reader can act on.

Every one of these failures has a specific cause and a specific fix: the key is
wrong, the deployment name is wrong, the endpoint is unreachable, the account is
out of quota. Collapsing all of them into "Something went wrong handling this
request" means the person who configured the endpoint has to guess which of
those it was, and there is nothing on the screen to guess from.

So the provider's own message is passed through, prefixed by what it means. The
one thing that is not passed through is anything that looks like a credential:
some providers echo the key back in the error body, and an error message is one
of the easiest things in a web application to end up in a log or a screenshot.
"""

from __future__ import annotations

import logging
import re

from fastapi import HTTPException

log = logging.getLogger(__name__)

# Long opaque strings that follow a key-ish prefix, plus bare tokens of the
# length providers use. Redaction is deliberately eager: a redacted message is
# a small loss, a leaked key is not.
_SECRETS = re.compile(
    r"(sk-[A-Za-z0-9_\-]{8,}|Bearer\s+[A-Za-z0-9._\-]{16,}|[A-Za-z0-9]{32,})"
)

MAX_DETAIL = 400


def redact(text: str) -> str:
    return _SECRETS.sub("[redacted]", text or "")


def _provider_message(exc: Exception) -> str:
    """The most specific text the provider gave us, or the exception itself."""
    body = getattr(exc, "body", None)
    if isinstance(body, dict):
        error = body.get("error")
        if isinstance(error, dict) and error.get("message"):
            return str(error["message"])
        if isinstance(error, str) and error:
            return error
        if body.get("message"):
            return str(body["message"])

    message = getattr(exc, "message", None) or str(exc)
    return str(message)


def label_for(source: str | None) -> str:
    """
    Name the endpoint the way the customer named it.

    These labels open the sentence, so a bare "Test" reads as a broken string
    rather than as the name they chose. Quoting it makes it obviously their
    label and keeps the sentence grammatical whatever they typed.
    """
    name = (source or "").strip()
    if not name or name == "platform":
        return "The model endpoint"
    return f"The endpoint \u201c{name}\u201d"


def as_http_error(exc: Exception, endpoint_label: str = "The model endpoint") -> HTTPException:
    """
    Map a provider exception onto a status and a sentence that names the fix.

    The status matters as much as the words: 502 says the upstream failed and
    retrying may work, 400 says the configuration is wrong and retrying will
    not.
    """
    name = type(exc).__name__
    detail = redact(_provider_message(exc))[:MAX_DETAIL]
    status = getattr(exc, "status_code", None)

    # Logged in full (still redacted) because the reader only gets one sentence
    # and whoever operates the server may need the rest.
    log.warning("Model endpoint %s failed: %s: %s", endpoint_label, name, detail)

    if name == "AuthenticationError" or status == 401:
        return HTTPException(
            status_code=400,
            detail=(
                f"{endpoint_label} rejected the API key. Check the key under "
                f"Settings \u2192 Integrations. The provider said: {detail}"
            ),
        )

    if status == 403:
        return HTTPException(
            status_code=400,
            detail=(
                f"{endpoint_label} refused this request. The key may not have "
                f"access to that model. The provider said: {detail}"
            ),
        )

    if name == "NotFoundError" or status == 404:
        return HTTPException(
            status_code=400,
            detail=(
                f"{endpoint_label} could not find that model. For Azure OpenAI "
                f"the model box must hold the deployment name, and the URL "
                f"must be the resource address ending in .openai.azure.com. "
                f"The provider said: {detail}"
            ),
        )

    if name == "RateLimitError" or status == 429:
        return HTTPException(
            status_code=429,
            detail=(
                f"{endpoint_label} is rate limited or out of quota right now. "
                f"The provider said: {detail}"
            ),
        )

    if name in {"APIConnectionError", "APITimeoutError"}:
        return HTTPException(
            status_code=502,
            detail=(
                f"Could not reach {endpoint_label}. Check the base URL under "
                f"Settings \u2192 Integrations, and that the endpoint is "
                f"reachable from this server. The error was: {detail}"
            ),
        )

    if name == "BadRequestError" or status == 400:
        return HTTPException(
            status_code=400,
            detail=(
                f"{endpoint_label} refused the request as malformed. This "
                f"usually means the model does not support tool calling. The "
                f"provider said: {detail}"
            ),
        )

    return HTTPException(
        status_code=502,
        detail=(
            f"{endpoint_label} could not answer. The error was: {name}: {detail}"
        ),
    )
