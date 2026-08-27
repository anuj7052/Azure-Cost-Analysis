"""
Customer-supplied endpoints.

These carry the customer's own API key, so the tests focus on the two things
that would matter commercially: one account cannot see or touch another's
integration, and the key is never handed back over the API.
"""
from __future__ import annotations

import aiosqlite
import pytest
import pytest_asyncio

import core.db as db_module
from core.config import settings
from services import integration_service, user_service


@pytest_asyncio.fixture
async def db(tmp_path, monkeypatch):
    path = str(tmp_path / "test.db")
    monkeypatch.setattr(db_module, "DB_PATH", path)
    await db_module.init_db()
    conn = await aiosqlite.connect(path)
    conn.row_factory = aiosqlite.Row
    yield conn
    await conn.close()


async def make_user(db, oid, email):
    user = await user_service.upsert_user(
        db, {"user_id": oid, "email": email, "name": email, "tenant_id": "t"}
    )
    return user["id"]


@pytest.mark.asyncio
async def test_created_integration_never_returns_the_key(db):
    user_id = await make_user(db, "oid-1", "a@example.com")
    created = await integration_service.create_integration(db, user_id, {
        "label": "My OpenAI", "kind": "openai", "base_url": "",
        "model": "gpt-4o", "api_key": "sk-supersecretvalue", "rate_limit_per_day": 100})
    assert "api_key" not in created
    assert created["has_key"] is True
    assert "supersecret" not in created["key_hint"]
    assert created["key_hint"].endswith("alue")


@pytest.mark.asyncio
async def test_one_user_cannot_see_anothers_integration(db):
    owner = await make_user(db, "oid-1", "a@example.com")
    other = await make_user(db, "oid-2", "b@example.com")
    await integration_service.create_integration(db, owner, {
        "label": "Mine", "kind": "openai", "api_key": "sk-owner", "rate_limit_per_day": 100})

    assert await integration_service.list_integrations(db, other) == []


@pytest.mark.asyncio
async def test_one_user_cannot_edit_or_delete_anothers_integration(db):
    owner = await make_user(db, "oid-1", "a@example.com")
    other = await make_user(db, "oid-2", "b@example.com")
    mine = await integration_service.create_integration(db, owner, {
        "label": "Mine", "kind": "openai", "api_key": "sk-owner", "rate_limit_per_day": 100})

    assert await integration_service.update_integration(
        db, other, mine["id"], {"label": "Stolen"}
    ) is None
    assert await integration_service.delete_integration(db, other, mine["id"]) is False
    assert (await integration_service.list_integrations(db, owner))[0]["label"] == "Mine"


@pytest.mark.asyncio
async def test_two_users_may_reuse_the_same_label(db):
    a = await make_user(db, "oid-1", "a@example.com")
    b = await make_user(db, "oid-2", "b@example.com")
    await integration_service.create_integration(db, a, {"label": "Default", "kind": "openai", "rate_limit_per_day": 100})
    await integration_service.create_integration(db, b, {"label": "Default", "kind": "openai", "rate_limit_per_day": 100})

    assert len(await integration_service.list_integrations(db, a)) == 1
    assert len(await integration_service.list_integrations(db, b)) == 1


@pytest.mark.asyncio
async def test_duplicate_label_for_one_user_is_rejected(db):
    a = await make_user(db, "oid-1", "a@example.com")
    await integration_service.create_integration(db, a, {"label": "Default", "kind": "openai", "rate_limit_per_day": 100})
    with pytest.raises(aiosqlite.IntegrityError):
        await integration_service.create_integration(db, a, {"label": "Default", "kind": "openai", "rate_limit_per_day": 100})


@pytest.mark.asyncio
async def test_editing_without_a_key_keeps_the_stored_one(db):
    user_id = await make_user(db, "oid-1", "a@example.com")
    created = await integration_service.create_integration(db, user_id, {
        "label": "Mine", "kind": "openai", "api_key": "sk-original", "rate_limit_per_day": 100})
    await integration_service.update_integration(db, user_id, created["id"], {"label": "Renamed"})

    config = await integration_service.llm_config(db, user_id)
    assert config["api_key"] == "sk-original"
    assert config["source"] == "Renamed"


@pytest.mark.asyncio
async def test_llm_config_falls_back_to_platform_settings(db, monkeypatch):
    monkeypatch.setattr(settings, "OPENAI_API_KEY", "sk-platform")
    user_id = await make_user(db, "oid-1", "a@example.com")

    config = await integration_service.llm_config(db, user_id)
    assert config["api_key"] == "sk-platform"
    assert config["source"] == "platform"


@pytest.mark.asyncio
async def test_disabled_and_keyless_integrations_are_not_used(db, monkeypatch):
    monkeypatch.setattr(settings, "OPENAI_API_KEY", "sk-platform")
    user_id = await make_user(db, "oid-1", "a@example.com")
    disabled = await integration_service.create_integration(db, user_id, {
        "label": "Off", "kind": "openai", "api_key": "sk-mine", "rate_limit_per_day": 100})
    await integration_service.update_integration(db, user_id, disabled["id"], {"enabled": False})
    await integration_service.create_integration(db, user_id, {
        "label": "No key", "kind": "openai", "api_key": "", "rate_limit_per_day": 100})

    assert (await integration_service.llm_config(db, user_id))["source"] == "platform"


@pytest.mark.asyncio
async def test_a_webhook_is_never_used_as_a_model(db, monkeypatch):
    monkeypatch.setattr(settings, "OPENAI_API_KEY", "sk-platform")
    user_id = await make_user(db, "oid-1", "a@example.com")
    await integration_service.create_integration(db, user_id, {
        "label": "Hook", "kind": "webhook", "api_key": "secret", "rate_limit_per_day": 100})

    assert (await integration_service.llm_config(db, user_id))["source"] == "platform"


@pytest.mark.asyncio
async def test_deleting_a_user_removes_their_integrations(db):
    user_id = await make_user(db, "oid-1", "a@example.com")
    await integration_service.create_integration(db, user_id, {
        "label": "Mine", "kind": "openai", "api_key": "sk-mine", "rate_limit_per_day": 100})

    await db.execute("PRAGMA foreign_keys = ON")
    await db.execute("DELETE FROM users WHERE id = ?", (user_id,))
    await db.commit()

    async with db.execute("SELECT COUNT(*) FROM user_integrations") as cursor:
        assert (await cursor.fetchone())[0] == 0
