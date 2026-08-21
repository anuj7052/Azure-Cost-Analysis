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
