"""
Account ownership and the admin center.

These tests exist because the failure mode here is not a wrong number on a
chart — it is one customer reading another customer's Azure credentials. The
ownership scoping and the migration that introduced it are pinned down.
"""
from __future__ import annotations

import aiosqlite
import pytest
import pytest_asyncio

import core.db as db_module
from services import user_service
from services.token_resolver import resolve_tenant_token
from fastapi import HTTPException


@pytest_asyncio.fixture
async def db(tmp_path, monkeypatch):
    path = str(tmp_path / "test.db")
    monkeypatch.setattr(db_module, "DB_PATH", path)
    await db_module.init_db()
    conn = await aiosqlite.connect(path)
    conn.row_factory = aiosqlite.Row
    yield conn
    await conn.close()


def claims(oid, email="user@example.com", name="A User", tid="tenant-a"):
    return {"user_id": oid, "email": email, "name": name, "tenant_id": tid}


# ── Account creation ───────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_first_sign_in_creates_an_active_user(db):
    user = await user_service.upsert_user(db, claims("oid-1"))
    assert user["email"] == "user@example.com"
    assert user["status"] == user_service.STATUS_ACTIVE
    assert user["role"] == user_service.ROLE_USER


@pytest.mark.asyncio
async def test_signing_in_again_updates_profile_without_duplicating(db):
    await user_service.upsert_user(db, claims("oid-1", name="Old Name"))
    await user_service.upsert_user(db, claims("oid-1", name="New Name"))

    async with db.execute("SELECT COUNT(*) FROM users") as cur:
        assert (await cur.fetchone())[0] == 1
    async with db.execute("SELECT name FROM users WHERE azure_oid='oid-1'") as cur:
        assert (await cur.fetchone())["name"] == "New Name"


@pytest.mark.asyncio
async def test_token_without_an_object_id_is_rejected(db):
    with pytest.raises(ValueError):
        await user_service.upsert_user(db, claims(None))


# ── Admin allowlist ────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_allowlisted_email_becomes_admin(db, monkeypatch):
    monkeypatch.setattr(
        user_service.settings, "ADMIN_EMAILS", "Boss@Example.com , other@x.com"
    )
    user = await user_service.upsert_user(db, claims("oid-1", email="boss@example.com"))
    assert user["role"] == user_service.ROLE_ADMIN


@pytest.mark.asyncio
async def test_non_allowlisted_email_stays_a_standard_user(db, monkeypatch):
    monkeypatch.setattr(user_service.settings, "ADMIN_EMAILS", "boss@example.com")
    user = await user_service.upsert_user(db, claims("oid-2", email="someone@else.com"))
    assert user["role"] == user_service.ROLE_USER


@pytest.mark.asyncio
async def test_admin_granted_in_the_ui_survives_the_next_sign_in(db, monkeypatch):
    """The allowlist promotes but must not silently demote a UI-granted admin."""
    monkeypatch.setattr(user_service.settings, "ADMIN_EMAILS", "")
    user = await user_service.upsert_user(db, claims("oid-1"))
    await db.execute("UPDATE users SET role='admin' WHERE id=?", (user["id"],))
    await db.commit()

    again = await user_service.upsert_user(db, claims("oid-1"))
    assert again["role"] == user_service.ROLE_ADMIN


# ── Ownership ──────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_two_users_can_connect_the_same_azure_tenant(db):
    """
    The original schema had UNIQUE(tenant_id) globally, so the second customer
    to add a tenant would overwrite the first one's credentials.
    """
    a = await user_service.upsert_user(db, claims("oid-a", email="a@x.com"))
    b = await user_service.upsert_user(db, claims("oid-b", email="b@x.com"))

    for user, secret in ((a, "secret-a"), (b, "secret-b")):
        await db.execute(
            "INSERT INTO service_principals (user_id, tenant_id, tenant_name, "
            "client_id, client_secret) VALUES (?, 'shared-tenant', 'Shared', 'cid', ?)",
            (user["id"], secret),
        )
    await db.commit()

    async with db.execute(
        "SELECT client_secret FROM service_principals WHERE user_id=?", (a["id"],)
    ) as cur:
        assert (await cur.fetchone())["client_secret"] == "secret-a"


@pytest.mark.asyncio
async def test_one_user_cannot_use_another_users_service_principal(db):
    owner = await user_service.upsert_user(db, claims("oid-a", email="a@x.com"))
    intruder = await user_service.upsert_user(db, claims("oid-b", email="b@x.com"))

    await db.execute(
        "INSERT INTO service_principals (user_id, tenant_id, tenant_name, "
        "client_id, client_secret) VALUES (?, 'victim-tenant', 'Victim', 'cid', 'shh')",
        (owner["id"],),
    )
    await db.commit()

    caller = {
        "account_id": intruder["id"],
        "tenant_id": "tenant-b",
        "token": "intruder-own-token",
    }
    # Falls back to the intruder's own delegated token instead of minting one
    # from the owner's stored secret.
    assert await resolve_tenant_token("victim-tenant", caller, db) == "intruder-own-token"


@pytest.mark.asyncio
async def test_one_user_cannot_use_another_users_session_token(db):
    owner = await user_service.upsert_user(db, claims("oid-a", email="a@x.com"))
    intruder = await user_service.upsert_user(db, claims("oid-b", email="b@x.com"))

    await db.execute(
        "INSERT INTO session_tokens (user_id, tenant_id, tenant_name, access_token, "
        "expires_at) VALUES (?, 'victim-tenant', 'Victim', 'secret-azure-token', '2099-01-01T00:00:00Z')",
        (owner["id"],),
    )
    await db.commit()

    caller = {"account_id": intruder["id"], "tenant_id": "tenant-b", "token": "own"}
    assert await resolve_tenant_token("victim-tenant", caller, db) == "own"


@pytest.mark.asyncio
async def test_owner_does_get_their_own_session_token(db):
    owner = await user_service.upsert_user(db, claims("oid-a", email="a@x.com"))
    await db.execute(
        "INSERT INTO session_tokens (user_id, tenant_id, tenant_name, access_token, "
        "expires_at) VALUES (?, 't1', 'T', 'the-token', '2099-01-01T00:00:00Z')",
        (owner["id"],),
    )
    await db.commit()

    caller = {"account_id": owner["id"], "tenant_id": "tenant-a", "token": "own"}
    assert await resolve_tenant_token("t1", caller, db) == "the-token"


@pytest.mark.asyncio
async def test_expired_session_token_asks_for_a_fresh_one(db):
    owner = await user_service.upsert_user(db, claims("oid-a", email="a@x.com"))
    await db.execute(
        "INSERT INTO session_tokens (user_id, tenant_id, tenant_name, access_token, "
        "expires_at) VALUES (?, 't1', 'T', 'stale', '2000-01-01T00:00:00Z')",
        (owner["id"],),
    )
    await db.commit()

    caller = {"account_id": owner["id"], "tenant_id": "tenant-a", "token": "own"}
    with pytest.raises(HTTPException) as exc:
        await resolve_tenant_token("t1", caller, db)
    assert exc.value.status_code == 401


# ── Migration of an existing single-user install ───────────────────────────

@pytest.mark.asyncio
async def test_legacy_rows_are_adopted_by_the_first_user_only(db):
    """An in-place upgrade must not lose tenants, nor hand them to a stranger."""
    await db.execute(
        "INSERT INTO service_principals (user_id, tenant_id, tenant_name, client_id, "
        "client_secret) VALUES (NULL, 'legacy', 'Legacy', 'cid', 'sec')"
    )
    await db.commit()

    first = await user_service.upsert_user(db, claims("oid-a", email="a@x.com"))
    async with db.execute("SELECT user_id FROM service_principals") as cur:
        assert (await cur.fetchone())["user_id"] == first["id"]

    second = await user_service.upsert_user(db, claims("oid-b", email="b@x.com"))
    async with db.execute(
        "SELECT COUNT(*) FROM service_principals WHERE user_id=?", (second["id"],)
    ) as cur:
        assert (await cur.fetchone())[0] == 0


@pytest.mark.asyncio
async def test_migration_rebuilds_an_old_table_and_keeps_its_rows(tmp_path, monkeypatch):
    path = str(tmp_path / "old.db")
    async with aiosqlite.connect(path) as old:
        await old.execute(
            "CREATE TABLE service_principals ("
            "id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL UNIQUE, "
            "tenant_name TEXT NOT NULL, client_id TEXT NOT NULL, "
            "client_secret TEXT NOT NULL, created_at TEXT)"
        )
        await old.execute(
            "INSERT INTO service_principals (tenant_id, tenant_name, client_id, "
            "client_secret) VALUES ('t-old', 'Old Tenant', 'cid', 'sec')"
        )
        await old.commit()

    monkeypatch.setattr(db_module, "DB_PATH", path)
    await db_module.init_db()

    async with aiosqlite.connect(path) as conn:
        conn.row_factory = aiosqlite.Row
        async with conn.execute("PRAGMA table_info(service_principals)") as cur:
            cols = {r[1] for r in await cur.fetchall()}
        assert "user_id" in cols
        async with conn.execute("SELECT * FROM service_principals") as cur:
            rows = await cur.fetchall()
    assert len(rows) == 1
    assert rows[0]["tenant_name"] == "Old Tenant"
    assert rows[0]["user_id"] is None


@pytest.mark.asyncio
async def test_migration_is_safe_to_run_twice(tmp_path, monkeypatch):
    path = str(tmp_path / "twice.db")
    monkeypatch.setattr(db_module, "DB_PATH", path)
    await db_module.init_db()
    await db_module.init_db()

    async with aiosqlite.connect(path) as conn:
        async with conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ) as cur:
            names = {r[0] for r in await cur.fetchall()}
    assert "service_principals_old" not in names
    assert {"users", "service_principals", "session_tokens"} <= names
