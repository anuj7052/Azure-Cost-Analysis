"""
The migration, run for real: SQLite in, Postgres out, counts checked.

A migration test that mocks the database proves the script calls the
functions it calls. The only question worth answering is whether the rows
arrive, keep their ids, and survive being run twice -- and that needs both
engines actually present.

Skipped rather than failed when no local Postgres is running.
"""
import os

import aiosqlite
import pytest

asyncpg = pytest.importorskip("asyncpg")

from scripts import migrate_to_postgres as mig  # noqa: E402

DSN = os.environ.get("TEST_PG_DSN", "postgresql:///cloudledger_migtest")
ADMIN_DSN = os.environ.get("TEST_PG_ADMIN_DSN", "postgresql:///postgres")


@pytest.fixture
async def source(tmp_path):
    """A SQLite file with the real schema and a few rows in it."""
    from core.config import settings
    import core.db as core_db

    path = str(tmp_path / "source.db")
    original = core_db.DB_PATH
    core_db.DB_PATH = path
    settings_backend = settings.DB_BACKEND
    settings.DB_BACKEND = "sqlite"
    try:
        await core_db.init_db()
    finally:
        core_db.DB_PATH = original
        settings.DB_BACKEND = settings_backend

    async with aiosqlite.connect(path) as db:
        for i in (1, 2, 3):
            await db.execute(
                "INSERT INTO users (id, azure_oid, email, name) VALUES (?, ?, ?, ?)",
                (i * 10, f"oid-{i}", f"u{i}@example.com", f"User {i}"),
            )
        await db.execute(
            "INSERT INTO user_sessions (user_id, user_agent) VALUES (?, ?)", (10, "Chrome")
        )
        await db.commit()

    return path


@pytest.fixture
async def target(monkeypatch):
    """An empty Postgres database with the real schema."""
    from core.config import settings
    import core.db as core_db

    try:
        admin = await asyncpg.connect(ADMIN_DSN)
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"no local Postgres: {exc}")

    await admin.execute("DROP DATABASE IF EXISTS cloudledger_migtest WITH (FORCE)")
    await admin.execute("CREATE DATABASE cloudledger_migtest")
    await admin.close()

    monkeypatch.setattr(settings, "DB_BACKEND", "postgres")
    monkeypatch.setattr(settings, "DATABASE_URL", DSN)
    await core_db.init_db()
    return DSN


async def _query(dsn, sql, *args):
    conn = await asyncpg.connect(dsn)
    try:
        return await conn.fetchval(sql, *args)
    finally:
        await conn.close()


async def test_the_rows_arrive(source, target):
    assert await mig.migrate(source, target) == 0

    assert await _query(target, "SELECT COUNT(*) FROM users") == 3


async def test_the_original_ids_are_preserved(source, target):
    # Ids are referenced by other tables and appear in nothing that could
    # renumber them, so renumbering here would silently repoint relationships.
    await mig.migrate(source, target)

    emails = await _query(target, "SELECT email FROM users WHERE id = $1", 20)
    assert emails == "u2@example.com"


async def test_child_rows_arrive_too(source, target):
    await mig.migrate(source, target)

    assert await _query(target, "SELECT COUNT(*) FROM user_sessions") == 1


async def test_running_it_twice_does_not_duplicate(source, target):
    await mig.migrate(source, target)
    assert await mig.migrate(source, target) == 0

    assert await _query(target, "SELECT COUNT(*) FROM users") == 3


async def test_the_next_insert_does_not_collide(source, target):
    # The sequence starts at 1 and the copied rows occupy 10, 20 and 30. If
    # the sequence is not advanced, the app's very first new sign-up fails.
    await mig.migrate(source, target)

    conn = await asyncpg.connect(target)
    try:
        new_id = await conn.fetchval(
            "INSERT INTO users (azure_oid, email, name) VALUES ($1, $2, $3) RETURNING id",
            "oid-new", "new@example.com", "New",
        )
    finally:
        await conn.close()

    assert new_id > 30


async def test_an_empty_table_is_reported_not_skipped(source, target, capsys):
    await mig.migrate(source, target)

    assert "scans: read 0, wrote 0" in capsys.readouterr().out


async def test_it_reports_the_total(source, target, capsys):
    await mig.migrate(source, target)

    assert "Counts match." in capsys.readouterr().out


async def test_the_source_file_is_left_alone(source, target):
    await mig.migrate(source, target)

    async with aiosqlite.connect(source) as db:
        async with db.execute("SELECT COUNT(*) FROM users") as cursor:
            assert (await cursor.fetchone())[0] == 3


async def test_a_count_mismatch_is_a_failure(source, target, monkeypatch, capsys):
    # The whole value of the script is this check, so it is worth proving it
    # actually fails rather than trusting that it would.
    async def lying_copy(sqlite_db, pg_conn, table):
        return (5, 3) if table == "users" else (0, 0)

    monkeypatch.setattr(mig, "copy_table", lying_copy)

    assert await mig.migrate(source, target) == 1
    assert "MISMATCH users" in capsys.readouterr().out
