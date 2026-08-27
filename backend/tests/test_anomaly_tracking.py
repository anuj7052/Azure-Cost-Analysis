"""
Anomaly triage: status, history and the tenant boundary around them.

A note reading "expected, production release" is a statement about somebody's
commercial position. It must never be visible to another tenant, and it must
never be visible to another user's account within this app's model, so the
scope is part of the primary key rather than a filter applied afterwards --
these tests exist to prove that stays true.
"""
from __future__ import annotations

import aiosqlite
import pytest
import pytest_asyncio

import core.db as db_module
from services import anomaly_tracking as tracking

ALICE = {"account_id": 1, "name": "Alice", "email": "alice@a.com"}
BOB = {"account_id": 2, "name": "Bob", "email": "bob@b.com"}

TENANT_A = "tenant-a"
TENANT_B = "tenant-b"


@pytest_asyncio.fixture
async def db(tmp_path, monkeypatch):
    path = str(tmp_path / "anomaly.db")
    monkeypatch.setattr(db_module, "DB_PATH", path)
    await db_module.init_db()

    conn = await aiosqlite.connect(path)
    conn.row_factory = aiosqlite.Row
    await conn.execute(
        "INSERT INTO users (id, azure_oid, email, name, azure_tenant_id) VALUES "
        "(1, 'oid-a', 'alice@a.com', 'Alice', ?), (2, 'oid-b', 'bob@b.com', 'Bob', ?)",
        (TENANT_A, TENANT_B),
    )
    await conn.commit()
    yield conn
    await conn.close()


class TestKey:
    def test_the_same_change_yields_the_same_key(self):
        a = tracking.anomaly_key(TENANT_A, "sub-1", "Postgres", "pg-prod", "2026-08")
        b = tracking.anomaly_key(TENANT_A, "sub-1", "Postgres", "pg-prod", "2026-08")

        assert a == b

    def test_a_different_tenant_yields_a_different_key(self):
        a = tracking.anomaly_key(TENANT_A, "sub-1", "Postgres", "pg-prod", "2026-08")
        b = tracking.anomaly_key(TENANT_B, "sub-1", "Postgres", "pg-prod", "2026-08")

        assert a != b

    def test_names_containing_separators_do_not_collide(self):
        # A delimiter-joined key breaks the moment a resource name contains the
        # delimiter, and two unrelated anomalies start sharing a status.
        a = tracking.anomaly_key(TENANT_A, "sub", "svc", "a|b", "p")
        b = tracking.anomaly_key(TENANT_A, "sub", "svc", "a", "b|p")

        assert a != b


class TestStatus:
    @pytest.mark.asyncio
    async def test_a_status_is_recorded_and_read_back(self, db):
        key = tracking.anomaly_key(TENANT_A, "sub-1", "Postgres", "pg-prod", "2026-08")

        await tracking.set_status(
            db, user=ALICE, tenant_id=TENANT_A, key=key, status=tracking.STATUS_INVESTIGATING
        )

        statuses = await tracking.statuses_for(db, 1, TENANT_A)
        assert statuses[key]["status"] == "investigating"

    @pytest.mark.asyncio
    async def test_updating_replaces_rather_than_duplicates(self, db):
        key = tracking.anomaly_key(TENANT_A, "sub-1", "Postgres", "pg-prod", "2026-08")

        await tracking.set_status(db, user=ALICE, tenant_id=TENANT_A, key=key, status="investigating")
        await tracking.set_status(db, user=ALICE, tenant_id=TENANT_A, key=key, status="resolved")

        statuses = await tracking.statuses_for(db, 1, TENANT_A)
        assert len(statuses) == 1
        assert statuses[key]["status"] == "resolved"

    @pytest.mark.asyncio
    async def test_an_unknown_status_is_refused(self, db):
        with pytest.raises(ValueError):
            await tracking.set_status(
                db, user=ALICE, tenant_id=TENANT_A, key="k", status="probably-fine"
            )

    @pytest.mark.asyncio
    async def test_a_comment_is_truncated_rather_than_rejected(self, db):
        await tracking.set_status(
            db, user=ALICE, tenant_id=TENANT_A, key="k",
            status="acknowledged", comment="x" * 5000,
        )

        history = await tracking.history_for(db, 1, TENANT_A, "k")
        assert len(history[0]["comment"]) == tracking.MAX_COMMENT


class TestAuditTrail:
    @pytest.mark.asyncio
    async def test_the_trail_records_who_and_from_what(self, db):
        await tracking.set_status(db, user=ALICE, tenant_id=TENANT_A, key="k", status="investigating")
        await tracking.set_status(
            db, user=ALICE, tenant_id=TENANT_A, key="k", status="resolved",
            comment="Checked deployment.",
        )

        history = await tracking.history_for(db, 1, TENANT_A, "k")

        assert len(history) == 2
        # Newest first, and each entry says what it moved from -- "resolved"
        # alone is a list, "investigating to resolved" is a trail.
        assert history[0]["new_status"] == "resolved"
        assert history[0]["previous_status"] == "investigating"
        assert history[0]["actor_name"] == "Alice"
        assert history[0]["comment"] == "Checked deployment."
        assert history[1]["previous_status"] == "new"


class TestIsolation:
    @pytest.mark.asyncio
    async def test_one_tenant_cannot_see_anothers_status(self, db):
        key = tracking.anomaly_key(TENANT_A, "sub-1", "Postgres", "pg-prod", "2026-08")
        await tracking.set_status(db, user=ALICE, tenant_id=TENANT_A, key=key, status="resolved")

        assert await tracking.statuses_for(db, 2, TENANT_B) == {}

    @pytest.mark.asyncio
    async def test_one_tenant_cannot_read_anothers_notes(self, db):
        await tracking.set_status(
            db, user=ALICE, tenant_id=TENANT_A, key="k",
            status="acknowledged", comment="Commercially sensitive.",
        )

        assert await tracking.history_for(db, 2, TENANT_B, "k") == []

    @pytest.mark.asyncio
    async def test_the_same_key_in_two_tenants_stays_separate(self, db):
        # Two tenants can legitimately produce the same fingerprint input.
        # Storing them against one row would leak a status across the boundary.
        await tracking.set_status(db, user=ALICE, tenant_id=TENANT_A, key="k", status="resolved")
        await tracking.set_status(db, user=BOB, tenant_id=TENANT_B, key="k", status="ignored")

        a = await tracking.statuses_for(db, 1, TENANT_A)
        b = await tracking.statuses_for(db, 2, TENANT_B)

        assert a["k"]["status"] == "resolved"
        assert b["k"]["status"] == "ignored"


class TestApplyStatuses:
    def test_an_untracked_anomaly_reports_new_rather_than_nothing(self):
        changes = [{"subscription_id": "s", "service": "Postgres", "resource_name": "pg"}]

        out = tracking.apply_statuses(changes, {}, TENANT_A, "2026-08")

        # "Nobody has touched this" is a real state the filter bar selects on.
        assert out[0]["status"] == "new"
        assert out[0]["anomaly_key"]

    def test_a_tracked_anomaly_keeps_its_status(self):
        changes = [{"subscription_id": "s", "service": "Postgres", "resource_name": "pg"}]
        key = tracking.anomaly_key(TENANT_A, "s", "Postgres", "pg", "2026-08")

        out = tracking.apply_statuses(
            changes, {key: {"status": "resolved", "updated_at": "2026-08-27"}}, TENANT_A, "2026-08"
        )

        assert out[0]["status"] == "resolved"
