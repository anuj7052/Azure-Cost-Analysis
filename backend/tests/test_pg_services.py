"""
The application's own service code, running on Postgres.

The wrapper tests prove that `pg.Connection` behaves like aiosqlite. That is
not the same as proving the application works, because the application does
things a wrapper test would never think to do: it reads columns by name off
rows it inserted three calls earlier, it relies on foreign keys cascading, and
it compares timestamps that one engine writes and the other has to sort.

So this exercises real service functions, unmodified, against a real Postgres
with the real schema. If the port is wrong, it is wrong here.

Skipped rather than failed when no local Postgres is running.
"""
import pytest

from services import user_sessions

asyncpg = pytest.importorskip("asyncpg")

import os

DSN = os.environ.get("TEST_PG_DSN", "postgresql:///cloudledger_pgtest")
ADMIN_DSN = os.environ.get("TEST_PG_ADMIN_DSN", "postgresql:///postgres")


@pytest.fixture
async def db(monkeypatch):
    from core import pg
    from core.config import settings
    import core.db as core_db

    try:
        admin = await asyncpg.connect(ADMIN_DSN)
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"no local Postgres: {exc}")

    await admin.execute("DROP DATABASE IF EXISTS cloudledger_pgtest WITH (FORCE)")
    await admin.execute("CREATE DATABASE cloudledger_pgtest")
    await admin.close()

    monkeypatch.setattr(settings, "DB_BACKEND", "postgres")
    monkeypatch.setattr(settings, "DATABASE_URL", DSN)
    await core_db.init_db()

    raw = await asyncpg.connect(DSN)
    try:
        yield pg.Connection(raw)
    finally:
        await raw.close()


async def _person(db, user_id=1, consented=True):
    await db.execute(
        "INSERT INTO users (id, azure_oid, email, name) VALUES (?, ?, ?, ?)",
        (user_id, f"oid-{user_id}", f"p{user_id}@example.com", "Dana"),
    )
    if consented:
        await db.execute(
            "UPDATE users SET profile_consent_at = CURRENT_TIMESTAMP WHERE id = ?",
            (user_id,),
        )


# ── the schema is genuinely usable ───────────────────────────────────────────

async def test_the_users_table_accepts_a_person(db):
    await _person(db)

    cursor = await db.execute("SELECT email FROM users WHERE id = ?", (1,))
    assert (await cursor.fetchone())["email"] == "p1@example.com"


async def test_consent_is_read_back_correctly(db):
    await _person(db, consented=False)
    assert await user_sessions.has_consented(db, 1) is False

    await db.execute(
        "UPDATE users SET profile_consent_at = CURRENT_TIMESTAMP WHERE id = ?", (1,)
    )
    assert await user_sessions.has_consented(db, 1) is True


# ── the service functions, unmodified ────────────────────────────────────────

async def test_nothing_is_recorded_without_consent(db):
    await _person(db, consented=False)

    assert await user_sessions.record_activity(db, 1, ip="203.0.113.7") is None


async def test_a_session_is_recorded_and_returned(db):
    await _person(db)

    session_id = await user_sessions.record_activity(db, 1, user_agent="Chrome")

    # This is the RETURNING id path that replaced lastrowid. On the wrong
    # engine it silently returns None and every caller stores a null id.
    assert isinstance(session_id, int)


async def test_a_return_visit_continues_the_same_session(db):
    # Relies on comparing a stored timestamp against a computed cutoff string,
    # which is exactly the comparison the interval rewrite changed.
    await _person(db)

    first = await user_sessions.record_activity(db, 1)
    assert await user_sessions.record_activity(db, 1) == first


async def test_the_history_reads_back_by_column_name(db):
    await _person(db)
    await user_sessions.record_activity(db, 1, user_agent="Firefox")

    sessions = await user_sessions.list_sessions(db, 1)

    assert len(sessions) == 1
    assert sessions[0]["device"] == "Firefox"
    assert sessions[0]["active"] is True


async def test_signing_out_closes_the_session(db):
    await _person(db)
    await user_sessions.record_activity(db, 1)

    await user_sessions.end_session(db, 1)

    assert (await user_sessions.list_sessions(db, 1))[0]["active"] is False


async def test_one_person_never_sees_anothers_sessions(db):
    await _person(db, user_id=1)
    await _person(db, user_id=2)
    await user_sessions.record_activity(db, 1)
    await user_sessions.record_activity(db, 2)

    assert len(await user_sessions.list_sessions(db, 1)) == 1


async def test_retention_deletes_old_records(db):
    await _person(db)
    await user_sessions.record_activity(db, 1)
    await db.execute("UPDATE user_sessions SET started_at = ?", ("2020-01-01 00:00:00",))

    assert await user_sessions.purge_expired(db) == 1


async def test_retention_spares_recent_records(db):
    await _person(db)
    await user_sessions.record_activity(db, 1)

    await user_sessions.purge_expired(db)

    assert len(await user_sessions.list_sessions(db, 1)) == 1


async def test_the_export_assembles_on_postgres(db):
    await _person(db)
    await user_sessions.record_activity(db, 1)

    data = await user_sessions.export_for(db, 1)

    assert data["account"]["email"] == "p1@example.com"
    assert len(data["sessions"]) == 1


async def test_withdrawing_consent_erases_everything_it_covered(db):
    await _person(db)
    await db.execute("UPDATE users SET phone = ?, company = ? WHERE id = ?", ("9", "Acme", 1))
    await user_sessions.record_activity(db, 1)

    await user_sessions.forget_optional_data(db, 1)

    cursor = await db.execute("SELECT phone, company FROM users WHERE id = ?", (1,))
    row = await cursor.fetchone()
    assert row["phone"] == "" and row["company"] == ""
    assert await user_sessions.list_sessions(db, 1) == []


async def test_deleting_a_person_cascades_to_their_sessions(db):
    # Postgres enforces foreign keys always; SQLite only with a PRAGMA. If the
    # schema translation dropped the REFERENCES clause this would leave
    # orphaned session rows behind.
    await _person(db)
    await user_sessions.record_activity(db, 1)

    await db.execute("DELETE FROM users WHERE id = ?", (1,))

    cursor = await db.execute("SELECT COUNT(*) FROM user_sessions")
    assert (await cursor.fetchone())[0] == 0
