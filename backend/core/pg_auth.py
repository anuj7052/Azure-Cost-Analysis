"""
Getting a password for a database that has no passwords.

The Azure Postgres server was created with password authentication disabled,
which is the reason it is worth using: there is no shared secret to leak, put
in an app setting, or forget to rotate. The cost is that `DATABASE_URL` alone
cannot connect. Entra issues a short-lived token instead, and the driver has
to present that token where a password would normally go.

So the flow is: ask the platform's identity endpoint for a token scoped to
Postgres, hand it to asyncpg as the password, and get a new one when it
expires. Nothing is stored on disk and nothing is stored in configuration.

Local development is unaffected. When no identity endpoint is present -- a
laptop -- this returns None and asyncpg uses whatever the DSN already says,
which for a local server is usually nothing at all.
"""
import logging
import os
import time

import httpx

log = logging.getLogger(__name__)

# The audience Azure Database for PostgreSQL accepts. Not the ARM audience:
# a management token is valid, signed, and rejected at the database.
RESOURCE = "https://ossrdbms-aad.database.windows.net"

# Renew this long before the token actually expires. A token that is valid
# when the request starts and expired when the connection completes fails in
# a way that looks like an outage rather than a clock.
RENEW_MARGIN_SECONDS = 300

_cached_token: str | None = None
_cached_until: float = 0.0


def _identity_endpoint() -> tuple[str, str] | None:
    """
    Where to ask for a token, if anywhere.

    App Service injects these two variables into the container and rotates
    the header value; they are not the IMDS address used on a plain VM, which
    is why hard-coding 169.254.169.254 would work on a VM and quietly fail
    here.
    """
    endpoint = os.environ.get("IDENTITY_ENDPOINT")
    header = os.environ.get("IDENTITY_HEADER")
    if endpoint and header:
        return endpoint, header
    return None


async def fetch_token(force: bool = False) -> str | None:
    """
    A Postgres token for this app's managed identity, or None off-platform.

    Cached, because a token is issued per identity and not per connection, and
    connections here are opened per request. Fetching one every time would put
    an HTTP round trip in front of every database call.
    """
    global _cached_token, _cached_until

    if not force and _cached_token and time.time() < _cached_until:
        return _cached_token

    identity = _identity_endpoint()
    if identity is None:
        return None

    endpoint, header = identity
    async with httpx.AsyncClient(timeout=10.0) as client:
        response = await client.get(
            endpoint,
            params={"resource": RESOURCE, "api-version": "2019-08-01"},
            headers={"X-IDENTITY-HEADER": header},
        )
        response.raise_for_status()
        payload = response.json()

    token = payload["access_token"]
    # expires_on is a unix timestamp as a string in this API.
    expires_on = float(payload.get("expires_on") or 0)
    _cached_token = token
    _cached_until = max(expires_on - RENEW_MARGIN_SECONDS, time.time() + 60)
    log.info("obtained a Postgres token for the managed identity")
    return token


def reset_cache() -> None:
    """Forget the cached token. Used by tests and after an auth failure."""
    global _cached_token, _cached_until
    _cached_token = None
    _cached_until = 0.0


async def connect(dsn: str):
    """
    Open an asyncpg connection, supplying an Entra token when one is needed.

    A rejected token is retried exactly once with a freshly fetched one. That
    covers the realistic failure -- a cached token that expired between the
    check and the handshake -- without turning a genuine permissions problem
    into an infinite retry.
    """
    import asyncpg

    token = await fetch_token()
    if token is None:
        return await asyncpg.connect(dsn)

    try:
        return await asyncpg.connect(dsn, password=token)
    except asyncpg.InvalidPasswordError:
        log.warning("Postgres rejected the cached token; fetching a new one")
        reset_cache()
        return await asyncpg.connect(dsn, password=await fetch_token())
