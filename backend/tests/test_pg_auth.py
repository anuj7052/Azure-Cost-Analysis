"""
Fetching, caching and retrying the database token.

Everything here is about a credential that expires. The failures worth
guarding against are not "the token was wrong" -- that is loud -- but "the
token was fetched too often" and "the token expired mid-flight", both of
which look like intermittent database trouble.
"""
import time

import pytest

from core import pg_auth


@pytest.fixture(autouse=True)
def clean_cache(monkeypatch):
    pg_auth.reset_cache()
    monkeypatch.delenv("IDENTITY_ENDPOINT", raising=False)
    monkeypatch.delenv("IDENTITY_HEADER", raising=False)
    yield
    pg_auth.reset_cache()


class _FakeResponse:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload


class _FakeClient:
    """Counts calls, because the caching is the point."""

    calls = 0

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def get(self, url, params=None, headers=None):
        _FakeClient.calls += 1
        _FakeClient.last_params = params
        _FakeClient.last_headers = headers
        return _FakeResponse(
            {"access_token": "token-abc", "expires_on": str(int(time.time()) + 3600)}
        )


@pytest.fixture
def platform(monkeypatch):
    monkeypatch.setenv("IDENTITY_ENDPOINT", "http://127.0.0.1/identity")
    monkeypatch.setenv("IDENTITY_HEADER", "secret-header")
    _FakeClient.calls = 0
    monkeypatch.setattr(pg_auth.httpx, "AsyncClient", _FakeClient)


# ── off the platform ─────────────────────────────────────────────────────────

async def test_a_laptop_gets_no_token():
    # Local development must not be made to depend on Azure being reachable.
    assert await pg_auth.fetch_token() is None


async def test_half_the_variables_is_not_enough(monkeypatch):
    # Only one of the pair set means something is misconfigured; guessing the
    # other would produce a confusing 401 instead of falling back cleanly.
    monkeypatch.setenv("IDENTITY_ENDPOINT", "http://127.0.0.1/identity")

    assert await pg_auth.fetch_token() is None


# ── on the platform ──────────────────────────────────────────────────────────

async def test_a_token_is_returned(platform):
    assert await pg_auth.fetch_token() == "token-abc"


async def test_the_postgres_audience_is_requested(platform):
    # An ARM token is valid, signed, and rejected by the database.
    await pg_auth.fetch_token()

    assert _FakeClient.last_params["resource"] == pg_auth.RESOURCE
    assert pg_auth.RESOURCE == "https://ossrdbms-aad.database.windows.net"


async def test_the_identity_header_is_sent(platform):
    await pg_auth.fetch_token()

    assert _FakeClient.last_headers["X-IDENTITY-HEADER"] == "secret-header"


async def test_the_token_is_cached(platform):
    await pg_auth.fetch_token()
    await pg_auth.fetch_token()
    await pg_auth.fetch_token()

    assert _FakeClient.calls == 1


async def test_a_forced_fetch_bypasses_the_cache(platform):
    await pg_auth.fetch_token()
    await pg_auth.fetch_token(force=True)

    assert _FakeClient.calls == 2


async def test_resetting_the_cache_refetches(platform):
    await pg_auth.fetch_token()
    pg_auth.reset_cache()
    await pg_auth.fetch_token()

    assert _FakeClient.calls == 2


async def test_the_cache_expires_before_the_token_does(platform):
    # Renewing exactly at expiry means a token that is valid when the request
    # starts and expired when the handshake completes.
    await pg_auth.fetch_token()

    assert pg_auth._cached_until <= time.time() + 3600 - pg_auth.RENEW_MARGIN_SECONDS + 1


async def test_a_short_lived_token_still_caches_briefly(monkeypatch):
    # An expiry closer than the renew margin would otherwise produce a cache
    # window in the past, i.e. a fetch on every single connection.
    monkeypatch.setenv("IDENTITY_ENDPOINT", "http://127.0.0.1/identity")
    monkeypatch.setenv("IDENTITY_HEADER", "h")

    class _ShortLived(_FakeClient):
        async def get(self, url, params=None, headers=None):
            _FakeClient.calls += 1
            return _FakeResponse(
                {"access_token": "t", "expires_on": str(int(time.time()) + 10)}
            )

    _FakeClient.calls = 0
    monkeypatch.setattr(pg_auth.httpx, "AsyncClient", _ShortLived)

    await pg_auth.fetch_token()

    assert pg_auth._cached_until > time.time()


async def test_a_missing_expiry_does_not_crash(monkeypatch):
    monkeypatch.setenv("IDENTITY_ENDPOINT", "http://127.0.0.1/identity")
    monkeypatch.setenv("IDENTITY_HEADER", "h")

    class _NoExpiry(_FakeClient):
        async def get(self, url, params=None, headers=None):
            return _FakeResponse({"access_token": "t"})

    monkeypatch.setattr(pg_auth.httpx, "AsyncClient", _NoExpiry)

    assert await pg_auth.fetch_token() == "t"


# ── connecting ───────────────────────────────────────────────────────────────

async def test_no_password_is_supplied_off_platform(monkeypatch):
    seen = {}

    async def fake_connect(dsn, **kwargs):
        seen.update(dsn=dsn, kwargs=kwargs)
        return "connection"

    import asyncpg

    monkeypatch.setattr(asyncpg, "connect", fake_connect)

    assert await pg_auth.connect("postgresql:///local") == "connection"
    assert seen["kwargs"] == {}


async def test_the_token_is_used_as_the_password(platform, monkeypatch):
    seen = {}

    async def fake_connect(dsn, **kwargs):
        seen.update(kwargs)
        return "connection"

    import asyncpg

    monkeypatch.setattr(asyncpg, "connect", fake_connect)
    await pg_auth.connect("postgresql://pg-cloudledger/cloudledger")

    assert seen["password"] == "token-abc"


async def test_a_rejected_token_is_retried_once(platform, monkeypatch):
    import asyncpg

    attempts = []

    async def fake_connect(dsn, **kwargs):
        attempts.append(kwargs.get("password"))
        if len(attempts) == 1:
            raise asyncpg.InvalidPasswordError("expired")
        return "connection"

    monkeypatch.setattr(asyncpg, "connect", fake_connect)

    assert await pg_auth.connect("postgresql://host/db") == "connection"
    assert len(attempts) == 2


async def test_a_genuinely_wrong_identity_is_not_retried_forever(platform, monkeypatch):
    # A permissions problem must surface as an error, not as a retry loop that
    # looks like the database is slow.
    import asyncpg

    attempts = []

    async def always_rejects(dsn, **kwargs):
        attempts.append(1)
        raise asyncpg.InvalidPasswordError("no")

    monkeypatch.setattr(asyncpg, "connect", always_rejects)

    with pytest.raises(asyncpg.InvalidPasswordError):
        await pg_auth.connect("postgresql://host/db")
    assert len(attempts) == 2
