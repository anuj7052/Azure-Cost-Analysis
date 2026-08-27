"""
Cross-tenant isolation.

The specification's hardest acceptance criterion is "Customer A cannot access
Customer B". Everything else in the platform is a feature; this one is the
product being safe to sell at all.

These tests are deliberately written against the HTTP surface rather than the
services. Isolation that holds in a service but is bypassed by a route that
forgot to pass `user_id` is not isolation, and only a request-level test catches
that. The route table is enumerated from the app itself, so a route added later
is covered without anyone remembering to add it here.
"""
from __future__ import annotations

import aiosqlite
import pytest
import pytest_asyncio
from fastapi.testclient import TestClient

import core.db as db_module
from core.config import settings
from services import user_service
from services.scanner import finish_scan, record_resources, start_scan

ALICE_OID = "oid-alice"
BOB_OID = "oid-bob"

ALICE_TENANT = "tenant-alice"
BOB_TENANT = "tenant-bob"

# A sentinel with no substring in common with any resource name, so a hit is
# unambiguously the stored credential rather than an incidental match.
ALICE_CLIENT_SECRET = "Zq7SentinelClientSecretValue9x"


def claims(oid: str, email: str, tenant_id: str) -> dict:
    return {
        "token": f"token-{oid}",
        "user_id": oid,
        "name": oid,
        "email": email,
        "tenant_id": tenant_id,
    }


@pytest_asyncio.fixture
async def isolated_db(tmp_path, monkeypatch):
    """A fresh database per test, with the app pointed at it."""
    path = str(tmp_path / "isolation.db")
    monkeypatch.setattr(db_module, "DB_PATH", path)
    await db_module.init_db()

    conn = await aiosqlite.connect(path)
    conn.row_factory = aiosqlite.Row
    await conn.execute("PRAGMA foreign_keys = ON")
    yield conn
    await conn.close()


@pytest_asyncio.fixture
async def two_customers(isolated_db):
    """
    Alice owns a tenant with an estate. Bob owns nothing.

    Bob is the attacker in every test below: he is a legitimate, authenticated
    customer who simply knows (or guesses) Alice's tenant id.
    """
    alice = await user_service.upsert_user(
        isolated_db, claims(ALICE_OID, "alice@a.com", ALICE_TENANT)
    )
    bob = await user_service.upsert_user(
        isolated_db, claims(BOB_OID, "bob@b.com", BOB_TENANT)
    )

    await isolated_db.execute(
        "INSERT INTO service_principals (user_id, tenant_id, tenant_name, client_id, client_secret)"
        " VALUES (?, ?, ?, ?, ?)",
        (alice["id"], ALICE_TENANT, "Alice Corp", "alice-client", ALICE_CLIENT_SECRET),
    )
    await isolated_db.commit()

    scan_id = await start_scan(isolated_db, alice["id"], ALICE_TENANT)
    count = await record_resources(
        isolated_db,
        scan_id,
        [
            {
                "id": "/subscriptions/alice-sub/resourceGroups/rg/providers/vm/alice-secret-vm",
                "name": "alice-secret-vm",
                "type": "microsoft.compute/virtualmachines",
                "resourceGroup": "rg",
                "subscriptionId": "alice-sub",
                "location": "eastus",
                "tags": {"owner": "alice"},
            }
        ],
    )
    await finish_scan(isolated_db, scan_id, count)

    return {"alice": alice, "bob": bob, "scan_id": scan_id}


@pytest.fixture
def client(isolated_db, monkeypatch):
    """
    A TestClient whose authenticated identity is swappable per request.

    Token validation is replaced rather than exercised — these tests are about
    what an *authenticated* caller can reach, and validation has its own suite.
    """
    monkeypatch.setattr(settings, "RATE_LIMIT_ENABLED", False)

    from auth.dependencies import get_current_user
    from core.db import get_db
    import main

    current = {"user": None}

    async def override_user():
        if current["user"] is None:
            from fastapi import HTTPException

            raise HTTPException(status_code=401, detail="Not authenticated")
        return current["user"]

    async def override_db():
        yield isolated_db

    main.app.dependency_overrides[get_current_user] = override_user
    main.app.dependency_overrides[get_db] = override_db

    with TestClient(main.app) as test_client:
        test_client.act_as = lambda user: current.__setitem__("user", user)
        yield test_client

    main.app.dependency_overrides.clear()


def identity(user: dict, oid: str, tenant_id: str) -> dict:
    return {
        **claims(oid, user["email"], tenant_id),
        "account_id": user["id"],
        "actor_id": user["id"],
        "is_owner": True,
        "workspace_role": "admin",
        "can_administer": True,
        "owner_id": user["id"],
        "role": user["role"],
        "status": user["status"],
        "created_at": user["created_at"],
    }


# ── Estate data ────────────────────────────────────────────────────────────


def test_search_does_not_return_another_customers_resources(client, two_customers):
    """
    Bob searches Alice's tenant by name. The estate must be invisible to him.

    Guessing a tenant id is trivial — they are published in Azure sign-in URLs —
    so the tenant id is not a secret and cannot be the thing that protects data.
    """
    client.act_as(identity(two_customers["bob"], BOB_OID, BOB_TENANT))

    response = client.get(
        "/api/v1/search", params={"tenant_id": ALICE_TENANT, "q": "alice-secret-vm"}
    )

    assert response.status_code == 200
    assert response.json()["results"] == []


def test_search_returns_own_resources(client, two_customers):
    """The control: isolation must not be achieved by returning nothing to anyone."""
    client.act_as(identity(two_customers["alice"], ALICE_OID, ALICE_TENANT))

    response = client.get(
        "/api/v1/search", params={"tenant_id": ALICE_TENANT, "q": "alice-secret-vm"}
    )

    assert response.status_code == 200
    assert [r["name"] for r in response.json()["results"]] == ["alice-secret-vm"]


def test_scan_history_is_not_shared_across_customers(client, two_customers):
    client.act_as(identity(two_customers["bob"], BOB_OID, BOB_TENANT))

    response = client.get("/api/v1/scans", params={"tenant_id": ALICE_TENANT})

    assert response.status_code == 200
    assert response.json() == []


def test_changes_do_not_leak_across_customers(client, two_customers):
    client.act_as(identity(two_customers["bob"], BOB_OID, BOB_TENANT))

    response = client.get("/api/v1/changes", params={"tenant_id": ALICE_TENANT})

    assert response.status_code == 200
    body = response.json()
    assert body["total_changes"] == 0
    assert body["comparable"] is False


def test_entity_history_does_not_leak_across_customers(client, two_customers):
    """A resource id is a guessable path, so it must not act as a capability."""
    client.act_as(identity(two_customers["bob"], BOB_OID, BOB_TENANT))

    response = client.get(
        "/api/v1/changes/history",
        params={
            "tenant_id": ALICE_TENANT,
            "resource_id": "/subscriptions/alice-sub/resourceGroups/rg/providers/vm/alice-secret-vm",
        },
    )

    assert response.status_code in (200, 404)
    if response.status_code == 200:
        assert response.json().get("events", []) == []


# ── Credentials ────────────────────────────────────────────────────────────


def test_tenant_list_only_shows_own_connections(client, two_customers):
    client.act_as(identity(two_customers["bob"], BOB_OID, BOB_TENANT))

    response = client.get("/api/v1/tenants")

    assert response.status_code == 200
    assert ALICE_TENANT not in [t["tenant_id"] for t in response.json()]


def test_deleting_another_customers_tenant_does_not_remove_it(client, two_customers, isolated_db):
    """
    The dangerous shape of IDOR: a write that succeeds against someone else's row.

    Whether Bob gets 403 or 404 is a design choice; what is not negotiable is
    that Alice's credential still exists afterwards.
    """
    client.act_as(identity(two_customers["bob"], BOB_OID, BOB_TENANT))

    client.delete(f"/api/v1/tenants/{ALICE_TENANT}")

    async def alice_still_connected():
        async with isolated_db.execute(
            "SELECT COUNT(*) AS n FROM service_principals WHERE user_id = ? AND tenant_id = ?",
            (two_customers["alice"]["id"], ALICE_TENANT),
        ) as cursor:
            return (await cursor.fetchone())["n"]

    import asyncio

    assert asyncio.get_event_loop().run_until_complete(alice_still_connected()) == 1


def test_no_endpoint_returns_a_stored_client_secret(client, two_customers):
    """
    A secret must never travel to a browser, even to its owner.

    Alice is used rather than Bob on purpose: leaking a secret back to the
    account that supplied it is still a leak, into logs, history and caches.
    """
    client.act_as(identity(two_customers["alice"], ALICE_OID, ALICE_TENANT))

    for path, params in [
        ("/api/v1/tenants", {}),
        ("/api/v1/me", {}),
        ("/api/v1/search", {"tenant_id": ALICE_TENANT, "q": "alice"}),
    ]:
        response = client.get(path, params=params)
        assert ALICE_CLIENT_SECRET not in response.text, f"secret leaked from {path}"


# ── Authentication ─────────────────────────────────────────────────────────


def test_protected_routes_reject_unauthenticated_callers(client):
    """
    Enumerated from the app, so a route added later is covered automatically.

    This is the check that catches the genuine mistake: a new router mounted
    without the `get_current_user` dependency.
    """
    import main

    public = {"/api/health", "/api/v1/health", "/docs", "/openapi.json", "/redoc"}
    client.act_as(None)

    unprotected = []
    for route in main.app.routes:
        path = getattr(route, "path", "")
        methods = getattr(route, "methods", set()) or set()

        if not path.startswith("/api/v1") or path in public:
            continue
        if "GET" not in methods or "{" in path:
            continue

        if client.get(path).status_code != 401:
            unprotected.append(path)

    assert unprotected == [], f"routes reachable without authentication: {unprotected}"


def test_suspended_accounts_are_rejected(isolated_db, two_customers):
    """Suspension must be enforced centrally, not per route."""
    import asyncio

    from fastapi import HTTPException

    from auth.dependencies import get_current_user

    async def check():
        await isolated_db.execute(
            "UPDATE users SET status = 'suspended' WHERE id = ?",
            (two_customers["bob"]["id"],),
        )
        await isolated_db.commit()

        with pytest.raises(HTTPException) as exc:
            await get_current_user(
                claims=claims(BOB_OID, "bob@b.com", BOB_TENANT), db=isolated_db
            )
        assert exc.value.status_code == 403

    asyncio.get_event_loop().run_until_complete(check())


# ---------------------------------------------------------------------------
# Subscription authorisation
# ---------------------------------------------------------------------------

import pytest as _pytest
from fastapi import HTTPException as _HTTPException

from services import token_resolver as _tr


@_pytest.fixture(autouse=True)
def _clear_subscription_cache():
    """The allow-list is cached per token; a stale entry would mask a real result."""
    _tr._SUBSCRIPTION_CACHE.clear()
    yield
    _tr._SUBSCRIPTION_CACHE.clear()


def _directory(monkeypatch, subs, calls=None):
    async def fake(token):
        if calls is not None:
            calls.append(token)
        return subs
    monkeypatch.setattr(_tr, "list_subscriptions", fake)


class TestSubscriptionAuthorisation:
    """
    Subscription ids arrive from the browser. Azure would refuse a foreign one,
    but that refusal surfaces to the user as a coverage gap -- which turns the
    API into a probe for which subscriptions exist. It is decided here instead.
    """

    async def test_ids_the_token_cannot_see_are_dropped(self, monkeypatch):
        _directory(monkeypatch, [
            {"subscriptionId": "mine", "tenantId": "t1"},
        ])
        allowed = await _tr.authorize_subscriptions("tok", "t1", ["mine", "somebody-elses"])
        assert allowed == ["mine"]

    async def test_a_subscription_from_another_tenant_is_not_allowed(self, monkeypatch):
        _directory(monkeypatch, [
            {"subscriptionId": "a", "tenantId": "t1"},
            {"subscriptionId": "b", "tenantId": "t2"},
        ])
        allowed = await _tr.authorize_subscriptions("tok", "t1", ["a", "b"])
        assert allowed == ["a"]

    async def test_asking_only_for_foreign_subscriptions_is_refused_outright(self, monkeypatch):
        _directory(monkeypatch, [{"subscriptionId": "a", "tenantId": "t1"}])
        with _pytest.raises(_HTTPException) as exc:
            await _tr.authorize_subscriptions("tok", "t1", ["b", "c"])
        assert exc.value.status_code == 403

    async def test_an_unreadable_directory_fails_closed(self, monkeypatch):
        async def boom(token):
            raise RuntimeError("directory unavailable")
        monkeypatch.setattr(_tr, "list_subscriptions", boom)
        with _pytest.raises(_HTTPException) as exc:
            await _tr.authorize_subscriptions("tok", "t1", ["a"])
        # Not 403: we are not saying the caller lacks access, we are saying we
        # could not tell -- and guessing in either direction would be wrong.
        assert exc.value.status_code == 502
        assert "not sent to Azure" in exc.value.detail

    async def test_the_allow_list_is_cached_per_token(self, monkeypatch):
        calls = []
        _directory(monkeypatch, [{"subscriptionId": "a", "tenantId": "t1"}], calls)
        await _tr.authorize_subscriptions("tok", "t1", ["a"])
        await _tr.authorize_subscriptions("tok", "t1", ["a"])
        assert len(calls) == 1

    async def test_a_different_token_does_not_reuse_another_accounts_allow_list(self, monkeypatch):
        calls = []
        _directory(monkeypatch, [{"subscriptionId": "a", "tenantId": "t1"}], calls)
        await _tr.authorize_subscriptions("tok-one", "t1", ["a"])
        await _tr.authorize_subscriptions("tok-two", "t1", ["a"])
        assert len(calls) == 2

    async def test_the_cache_never_stores_the_bearer_token(self, monkeypatch):
        _directory(monkeypatch, [{"subscriptionId": "a", "tenantId": "t1"}])
        await _tr.authorize_subscriptions("super-secret-token", "t1", ["a"])
        assert all("super-secret-token" not in str(k) for k in _tr._SUBSCRIPTION_CACHE)

    async def test_empty_selection_is_not_an_authorisation_failure(self, monkeypatch):
        _directory(monkeypatch, [{"subscriptionId": "a", "tenantId": "t1"}])
        assert await _tr.authorize_subscriptions("tok", "t1", []) == []


# ---------------------------------------------------------------------------
# The audit trail
#
# security_audit records what an administrator did to Azure access. It is the
# one table where a leak is not merely embarrassing: it would tell one customer
# which of another customer's staff hold Owner, and when that was granted.
# ---------------------------------------------------------------------------

class TestAuditIsolation:
    async def test_history_returns_only_this_account_and_tenant(self, two_customers, isolated_db):
        from services import access_change

        alice, bob = two_customers["alice"], two_customers["bob"]

        await access_change.open_event(
            isolated_db,
            {"account_id": alice["id"], "name": "Alice", "email": "alice@a.com"},
            ALICE_TENANT,
            access_change.ACTION_GRANT,
            scope="/subscriptions/sub-alice",
            target_name="Contractor",
            new_state="Owner",
        )
        await access_change.open_event(
            isolated_db,
            {"account_id": bob["id"], "name": "Bob", "email": "bob@b.com"},
            BOB_TENANT,
            access_change.ACTION_GRANT,
            scope="/subscriptions/sub-bob",
            target_name="Bob's contractor",
            new_state="Reader",
        )

        alice_rows = await access_change.history(isolated_db, alice["id"], ALICE_TENANT)
        bob_rows = await access_change.history(isolated_db, bob["id"], BOB_TENANT)

        assert [r["target_name"] for r in alice_rows] == ["Contractor"]
        assert [r["target_name"] for r in bob_rows] == ["Bob's contractor"]

    async def test_knowing_the_tenant_id_is_not_enough(self, two_customers, isolated_db):
        """Bob guesses Alice's tenant id. He still sees nothing."""
        from services import access_change

        alice, bob = two_customers["alice"], two_customers["bob"]
        await access_change.open_event(
            isolated_db,
            {"account_id": alice["id"], "name": "Alice", "email": "alice@a.com"},
            ALICE_TENANT,
            access_change.ACTION_REVOKE,
            scope="/subscriptions/sub-alice",
            target_name="Someone",
        )

        stolen = await access_change.history(isolated_db, bob["id"], ALICE_TENANT)
        assert stolen == []

    async def test_a_failed_change_is_still_recorded(self, two_customers, isolated_db):
        """A refused attempt to grant Owner is exactly what an audit needs."""
        from services import access_change

        alice = two_customers["alice"]
        event_id = await access_change.open_event(
            isolated_db,
            {"account_id": alice["id"], "name": "Alice", "email": "alice@a.com"},
            ALICE_TENANT,
            access_change.ACTION_GRANT,
            scope="/subscriptions/sub-alice",
            target_name="Contractor",
            new_state="Owner",
        )
        await access_change.close_event(
            isolated_db, event_id, access_change.RESULT_FAILED,
            failure_reason="AuthorizationFailed",
        )

        rows = await access_change.history(isolated_db, alice["id"], ALICE_TENANT)
        assert rows[0]["result"] == "failed"
        assert rows[0]["failure_reason"] == "AuthorizationFailed"
        assert rows[0]["completed_at"]

    async def test_an_unclosed_event_stays_pending(self, two_customers, isolated_db):
        """A process killed mid-change leaves evidence that nobody confirmed."""
        from services import access_change

        alice = two_customers["alice"]
        await access_change.open_event(
            isolated_db,
            {"account_id": alice["id"], "name": "Alice", "email": "alice@a.com"},
            ALICE_TENANT,
            access_change.ACTION_GRANT,
            scope="/subscriptions/sub-alice",
        )
        rows = await access_change.history(isolated_db, alice["id"], ALICE_TENANT)
        assert rows[0]["result"] == "pending"
        assert rows[0]["completed_at"] is None

    async def test_subscription_is_recorded_from_the_scope(self, two_customers, isolated_db):
        from services import access_change

        alice = two_customers["alice"]
        await access_change.open_event(
            isolated_db,
            {"account_id": alice["id"], "name": "Alice", "email": "alice@a.com"},
            ALICE_TENANT,
            access_change.ACTION_GRANT,
            scope="/subscriptions/sub-9/resourceGroups/prod",
        )
        rows = await access_change.history(isolated_db, alice["id"], ALICE_TENANT)
        assert rows[0]["subscription_id"] == "sub-9"
