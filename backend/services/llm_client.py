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

import re
from typing import Any, Dict, Optional
from urllib.parse import urlsplit

from fastapi import HTTPException
from openai import AsyncAzureOpenAI, AsyncOpenAI

from core.config import settings

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
