"""
Building the right client for whichever model endpoint the customer registered.

Azure OpenAI is not merely OpenAI on a different host. The classic Azure API
puts the deployment in the path and the API version in the query string, and
authenticates with an ``api-key`` header rather than a bearer token. Pointing
the plain client at an Azure resource therefore does not fail in some obvious
way -- it produces a bare ``404 Resource not found``, which reads as "your
model name is wrong" and sends people off to check the one thing that was
right. This module makes that distinction once, so neither assistant has to
know about it.

Two further kindnesses, because people paste whatever the Azure portal showed
them:

  * The endpoint is accepted in any of its shapes. The portal offers the bare
    resource URL, the ``/openai`` root, and the full
    ``/openai/deployments/<name>`` path at different points in the interface,
    and all three mean the same resource.
  * If they pasted the deployment path and left the model box empty, the
    deployment name is taken from the path rather than refused. They did tell
    us; they just told us in the other box.

Azure's newer ``/openai/v1`` surface *is* OpenAI-compatible, so a URL ending
that way is deliberately left to the plain client.
"""

from __future__ import annotations

import logging
import re
from typing import Any, Dict, List, Optional
from urllib.parse import urlsplit

import httpx
from fastapi import HTTPException
from openai import AsyncAzureOpenAI, AsyncOpenAI

from core.config import settings
from services import llm_errors

log = logging.getLogger(__name__)

AZURE_HOST_SUFFIX = ".openai.azure.com"

# The portal shows the deployment inside the path on the "target URI" line.
_DEPLOYMENT_IN_PATH = re.compile(r"/openai/deployments/([^/?]+)", re.IGNORECASE)

NOT_CONFIGURED = (
    "The assistant is not configured. Add your own model endpoint under "
    "Settings \u2192 Integrations, or ask your administrator to set "
    "OPENAI_API_KEY."
)


def _host(base_url: str) -> str:
    try:
        return (urlsplit(base_url).hostname or "").lower()
    except ValueError:
        return ""


def is_azure(kind: str, base_url: str) -> bool:
    """
    Whether this endpoint speaks the classic Azure OpenAI dialect.

    The declared kind is trusted first, but the host is also checked, because
    an Azure resource pasted under "OpenAI" or "Custom" is a mistake we can
    see and correct rather than one we have to punish.
    """
    url = (base_url or "").strip()
    if url.rstrip("/").lower().endswith("/openai/v1"):
        # Azure's OpenAI-compatible surface. The plain client is correct here.
        return False
    return kind == "azure_openai" or _host(url).endswith(AZURE_HOST_SUFFIX)


def azure_endpoint(base_url: str) -> str:
    """Reduce any of the pasted URL shapes back to the resource root."""
    url = (base_url or "").strip().rstrip("/")
    parts = urlsplit(url)
    if not parts.scheme or not parts.netloc:
        return url
    return f"{parts.scheme}://{parts.netloc}"


def deployment_in(base_url: str) -> str:
    match = _DEPLOYMENT_IN_PATH.search(base_url or "")
    return match.group(1) if match else ""


def model_for(llm: Dict[str, Any]) -> str:
    """
    The name to send as ``model``.

    For Azure this is the deployment name, which may have been given in the
    model box or buried in the endpoint URL.
    """
    model = (llm.get("model") or "").strip()
    if model:
        return model
    return deployment_in(llm.get("base_url") or "") or settings.OPENAI_MODEL


def build_client(llm: Dict[str, Any]) -> AsyncOpenAI:
    """
    An OpenAI-shaped async client for this configuration.

    Raises 503 when no key is present, because that is a setup step the
    customer can take, not a failure of the request they just made.
    """
    api_key = (llm.get("api_key") or "").strip()
    if not api_key:
        raise HTTPException(status_code=503, detail=NOT_CONFIGURED)

    base_url = (llm.get("base_url") or "").strip()
    kind = (llm.get("kind") or "").strip()

    if is_azure(kind, base_url):
        return AsyncAzureOpenAI(
            api_key=api_key,
            azure_endpoint=azure_endpoint(base_url),
            api_version=llm.get("api_version") or settings.OPENAI_API_VERSION,
        )

    return AsyncOpenAI(api_key=api_key, base_url=base_url or None)


def describe(llm: Dict[str, Any]) -> Optional[str]:
    """A short note on how this endpoint was interpreted, for error messages."""
    if is_azure(llm.get("kind") or "", llm.get("base_url") or ""):
        return "Azure OpenAI"
    return None


def cache_key(llm: Dict[str, Any]) -> str:
    """
    Identifies an endpoint-and-model pair, for remembering things about it.

    Built only from the address and the model name. The key is deliberately
    not part of it: this string ends up in process-wide dictionaries and in
    log lines, and a secret has no business in either.
    """
    return f"{azure_endpoint(llm.get('base_url') or '') or 'default'}|{model_for(llm)}"


# --- turning "that deployment does not exist" into "here are the ones that do"


# The data-plane listing endpoint. Pinned separately from the chat API version
# because it is an older, stable surface and we do not want a customer's newer
# chat api-version to take this diagnostic away from them.
DEPLOYMENTS_API_VERSION = "2023-03-15-preview"

LIST_TIMEOUT = 8.0

# Enough to identify the right one; a resource with more than this has bigger
# problems than a dropdown.
MAX_LISTED = 20


async def azure_deployments(llm: Dict[str, Any]) -> Optional[List[str]]:
    """
    The deployment names that actually exist on this Azure OpenAI resource.

    Returns ``None`` when we could not find out -- which is different from an
    empty list, and the difference matters. "There are no deployments" tells
    the customer to go and create one; "we could not check" must not be
    reported as though it were that.
    """
    endpoint = azure_endpoint(llm.get("base_url") or "")
    api_key = (llm.get("api_key") or "").strip()
    if not endpoint or not api_key:
        return None

    try:
        async with httpx.AsyncClient(timeout=LIST_TIMEOUT) as client:
            response = await client.get(
                f"{endpoint}/openai/deployments",
                params={"api-version": DEPLOYMENTS_API_VERSION},
                headers={"api-key": api_key},
            )
        if response.status_code >= 400:
            return None
        payload = response.json()
    except Exception:  # noqa: BLE001
        # This is a diagnostic. It must never turn one failure into two.
        log.info("Could not list Azure deployments for the failing endpoint", exc_info=True)
        return None

    if not isinstance(payload, dict):
        return None

    names: List[str] = []
    for item in payload.get("data") or []:
        if not isinstance(item, dict):
            continue
        name = item.get("id") or item.get("deploymentId") or item.get("name")
        if name:
            names.append(str(name))
    return sorted(set(names))


def _deployment_advice(asked_for: str, names: Optional[List[str]]) -> str:
    if names is None:
        return ""
    if not names:
        return (
            " This resource has no deployments at all yet. Create one in Azure "
            "AI Foundry, then put its name in the model box."
        )
    shown = ", ".join(f"\u201c{n}\u201d" for n in names[:MAX_LISTED])
    more = "" if len(names) <= MAX_LISTED else f", and {len(names) - MAX_LISTED} more"
    return (
        f" This resource has these deployments: {shown}{more}. "
        f"Put one of those in the model box instead of \u201c{asked_for}\u201d."
    )


async def explain_failure(exc: Exception, llm: Dict[str, Any]) -> HTTPException:
    """
    The provider's failure, plus whatever else we can find out cheaply.

    A bare "that deployment does not exist" leaves the customer guessing at a
    name, and the name is not something they can reason their way to. Since we
    hold a key for the resource, we can simply ask it what it has and say so.
    """
    error = llm_errors.as_http_error(exc, llm_errors.label_for(llm.get("source")))

    asked_for = model_for(llm)
    if error.status_code == 400 and getattr(exc, "status_code", None) == 404:
        if is_azure(llm.get("kind") or "", llm.get("base_url") or ""):
            advice = _deployment_advice(asked_for, await azure_deployments(llm))
            if advice:
                return HTTPException(status_code=400, detail=error.detail + advice)
        # Even without a listing, naming what we sent is worth a sentence: it
        # is often the moment someone notices they filled the wrong box.
        return HTTPException(
            status_code=400,
            detail=f"{error.detail} The name sent was \u201c{asked_for}\u201d.",
        )

    return error
