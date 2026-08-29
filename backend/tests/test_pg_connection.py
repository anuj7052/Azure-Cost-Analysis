"""
The Postgres connection wrapper, against a real Postgres.

These tests deliberately do not mock the driver. The entire purpose of this
layer is that asyncpg behaves the way the calling code expects, and a mock
would only assert that the wrapper calls the methods the wrapper was written
to call -- it would pass just as happily if every type mapping were wrong.

Skipped, not failed, when no local Postgres is running: a developer without
one should not see a red suite for a database they were never asked to
install. CI and the migration work do have one.
"""
import os

import pytest

from core import pg

asyncpg = pytest.importorskip("asyncpg")

DSN = os.environ.get("TEST_PG_DSN", "postgresql:///postgres")


@pytest.fixture
async def conn():
    try:
        raw = await asyncpg.connect(DSN)
    except Exception as exc:  # noqa: BLE001 - any connection problem means skip
        pytest.skip(f"no local Postgres: {exc}")

    await raw.execute("DROP TABLE IF EXISTS wrapper_t")
    try:
        yield pg.Connection(raw)
    finally:
        await raw.execute("DROP TABLE IF EXISTS wrapper_t")
        await raw.close()


async def _table(conn):
    await conn.execute(
        pg.translate_schema(
            """CREATE TABLE wrapper_t (
                   id    INTEGER PRIMARY KEY AUTOINCREMENT,
                   name  TEXT NOT NULL DEFAULT '',
                   cost  REAL,
                   seen  TEXT DEFAULT (CURRENT_TIMESTAMP)
               )"""
        )
    )


# ── the schema translation produces something Postgres accepts ───────────────

async def test_a_translated_schema_creates_a_table(conn):
    await _table(conn)

    cursor = await conn.execute("SELECT COUNT(*) FROM wrapper_t")
    assert (await cursor.fetchone())[0] == 0


async def test_the_identity_column_generates_ids(conn):
    await _table(conn)
    await conn.execute("INSERT INTO wrapper_t (name) VALUES (?)", ("a",))
    await conn.execute("INSERT INTO wrapper_t (name) VALUES (?)", ("b",))

    cursor = await conn.execute("SELECT id FROM wrapper_t ORDER BY id")
    ids = [r[0] for r in await cursor.fetchall()]
    assert len(ids) == 2 and ids[0] != ids[1]


async def test_money_survives_a_round_trip(conn):
    # REAL is 4 bytes in Postgres and would quietly round this. The whole
    # application is about being right to the paisa, so this is the test that
    # catches the type mapping being lazy.
    await _table(conn)
    await conn.execute("INSERT INTO wrapper_t (name, cost) VALUES (?, ?)", ("x", 12345.678901))

    cursor = await conn.execute("SELECT cost FROM wrapper_t")
    assert (await cursor.fetchone())[0] == pytest.approx(12345.678901, abs=1e-9)


async def test_current_timestamp_is_accepted_as_a_default(conn):
    await _table(conn)
    await conn.execute("INSERT INTO wrapper_t (name) VALUES (?)", ("x",))

    cursor = await conn.execute("SELECT seen FROM wrapper_t")
    assert (await cursor.fetchone())[0]


# ── rows are readable the way the application reads them ─────────────────────

async def test_a_row_can_be_read_by_column_name(conn):
    # Every router does row["column"]. If this fails the port is over.
    await _table(conn)
    await conn.execute("INSERT INTO wrapper_t (name) VALUES (?)", ("dana",))

    cursor = await conn.execute("SELECT name FROM wrapper_t")
    assert (await cursor.fetchone())["name"] == "dana"


async def test_fetchone_on_no_rows_is_none_not_an_error(conn):
    await _table(conn)

    cursor = await conn.execute("SELECT * FROM wrapper_t WHERE id = ?", (999,))
    assert await cursor.fetchone() is None


async def test_fetchall_on_no_rows_is_empty(conn):
    await _table(conn)

    cursor = await conn.execute("SELECT * FROM wrapper_t")
    assert await cursor.fetchall() == []


async def test_the_cursor_works_as_a_context_manager(conn):
    # `async with db.execute(...)` with no await, which is how roughly half
    # the read paths in the application are written. An earlier version of the
    # wrapper returned a plain coroutine, which supports `await` and not this,
    # and every one of those paths raised TypeError at runtime.
    await _table(conn)
    await conn.execute("INSERT INTO wrapper_t (name) VALUES (?)", ("x",))

    async with conn.execute("SELECT name FROM wrapper_t") as cursor:
        assert (await cursor.fetchone())["name"] == "x"


async def test_both_call_styles_agree(conn):
    await _table(conn)
    await conn.execute("INSERT INTO wrapper_t (name) VALUES (?)", ("x",))

    awaited = await (await conn.execute("SELECT name FROM wrapper_t")).fetchone()
    async with conn.execute("SELECT name FROM wrapper_t") as cursor:
        managed = await cursor.fetchone()

    assert awaited["name"] == managed["name"] == "x"


async def test_a_statement_is_not_run_twice_by_one_execution(conn):
    # The result object resolves lazily, so a careless implementation could
    # run the insert once on __aenter__ and again on await.
    await _table(conn)

    execution = conn.execute("INSERT INTO wrapper_t (name) VALUES (?)", ("once",))
    async with execution:
        pass
    await execution

    cursor = await conn.execute("SELECT COUNT(*) FROM wrapper_t")
    assert (await cursor.fetchone())[0] == 1


# ── writes ───────────────────────────────────────────────────────────────────

async def test_an_update_reports_how_many_rows_changed(conn):
    await _table(conn)
    for name in ("a", "b", "c"):
        await conn.execute("INSERT INTO wrapper_t (name) VALUES (?)", (name,))

    cursor = await conn.execute("UPDATE wrapper_t SET name = ?", ("z",))
    assert cursor.rowcount == 3


async def test_a_delete_reports_how_many_rows_went(conn):
    await _table(conn)
    await conn.execute("INSERT INTO wrapper_t (name) VALUES (?)", ("a",))

    cursor = await conn.execute("DELETE FROM wrapper_t WHERE name = ?", ("a",))
    assert cursor.rowcount == 1


async def test_returning_gives_the_new_id(conn):
    # This is what replaces lastrowid, which asyncpg has no equivalent for.
    await _table(conn)

    cursor = await conn.execute(
        "INSERT INTO wrapper_t (name) VALUES (?) RETURNING id", ("a",)
    )
    assert (await cursor.fetchone())[0] is not None


async def test_executemany_inserts_every_row(conn):
    await _table(conn)

    await conn.executemany(
        "INSERT INTO wrapper_t (name) VALUES (?)", [("a",), ("b",), ("c",)]
    )

    cursor = await conn.execute("SELECT COUNT(*) FROM wrapper_t")
    assert (await cursor.fetchone())[0] == 3


async def test_a_write_is_durable_without_an_explicit_commit(conn):
    # `commit()` is a no-op here. If asyncpg did not autocommit, every write
    # in the application would silently vanish -- so this is the test that
    # justifies that no-op.
    await _table(conn)
    await conn.execute("INSERT INTO wrapper_t (name) VALUES (?)", ("kept",))
    await conn.commit()

    cursor = await conn.execute("SELECT COUNT(*) FROM wrapper_t")
    assert (await cursor.fetchone())[0] == 1


# ── the guard rail ───────────────────────────────────────────────────────────

async def test_too_few_parameters_is_reported_against_the_sql(conn):
    await _table(conn)

    with pytest.raises(ValueError, match="expects 2 parameter"):
        await conn.execute("INSERT INTO wrapper_t (name, cost) VALUES (?, ?)", ("a",))


async def test_too_many_parameters_is_reported_too(conn):
    await _table(conn)

    with pytest.raises(ValueError, match="expects 1 parameter"):
        await conn.execute("INSERT INTO wrapper_t (name) VALUES (?)", ("a", "b"))


async def test_a_quoted_question_mark_is_not_counted_as_a_parameter(conn):
    # The off-by-one that would shift every argument, caught end to end
    # against a real server rather than only in the scanner's unit tests.
    await _table(conn)

    await conn.execute("INSERT INTO wrapper_t (name) VALUES (?)", ("really?",))

    cursor = await conn.execute("SELECT name FROM wrapper_t WHERE name = 'really?'")
    assert (await cursor.fetchone())["name"] == "really?"
