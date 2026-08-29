"""
Consent, session history and the rights that go with holding personal data.

These tests exist because the failures they catch are all silent. Data kept
without consent still works. Retention that never runs still works. An export
that quietly omits a table still returns 200. Nothing here is visible from the
outside, which is exactly why it needs to fail loudly in here.
"""
import aiosqlite
import pytest

from services import user_sessions


@pytest.fixture
async def db(tmp_path, monkeypatch):
    path = tmp_path / "consent.db"
    import core.db as core_db

    monkeypatch.setattr(core_db, "DB_PATH", str(path))
    await core_db.init_db()
    conn = await aiosqlite.connect(str(path))
    conn.row_factory = aiosqlite.Row
    await conn.execute(
        "INSERT INTO users (id, azure_oid, email, name) VALUES (1, 'oid-1', 'a@example.com', 'A')"
    )
    await conn.commit()
    try:
        yield conn
    finally:
        await conn.close()


async def _consent(db):
    await db.execute("UPDATE users SET profile_consent_at = CURRENT_TIMESTAMP WHERE id = 1")
    await db.commit()


# ── consent gates the collection, not just the display ───────────────────────

async def test_nothing_is_recorded_before_consent(db):
    assert await user_sessions.record_activity(db, 1, ip="1.2.3.4") is None

    async with db.execute("SELECT COUNT(*) c FROM user_sessions") as cur:
        assert (await cur.fetchone())["c"] == 0


async def test_a_session_is_recorded_once_consent_exists(db):
    await _consent(db)
    assert await user_sessions.record_activity(db, 1, ip="1.2.3.4") is not None

    async with db.execute("SELECT COUNT(*) c FROM user_sessions") as cur:
        assert (await cur.fetchone())["c"] == 1


async def test_withdrawing_consent_erases_what_it_covered(db):
    await _consent(db)
    await db.execute("UPDATE users SET phone = '999', company = 'Acme' WHERE id = 1")
    await db.commit()
    await user_sessions.record_activity(db, 1)

    await user_sessions.forget_optional_data(db, 1)

    async with db.execute(
        "SELECT phone, company, profile_consent_at FROM users WHERE id = 1"
    ) as cur:
        row = await cur.fetchone()
    assert row["phone"] == ""
    assert row["company"] == ""
    assert row["profile_consent_at"] is None

    async with db.execute("SELECT COUNT(*) c FROM user_sessions") as cur:
        assert (await cur.fetchone())["c"] == 0


async def test_withdrawing_consent_keeps_the_account(db):
    # The account is what signs the person in; it is not held under consent.
    await _consent(db)
    await user_sessions.forget_optional_data(db, 1)

    async with db.execute("SELECT email FROM users WHERE id = 1") as cur:
        assert (await cur.fetchone())["email"] == "a@example.com"


# ── the address is never stored in the clear ─────────────────────────────────

async def test_the_address_is_not_stored_as_written(db):
    await _consent(db)
    await user_sessions.record_activity(db, 1, ip="203.0.113.7")

    async with db.execute("SELECT ip_hash FROM user_sessions") as cur:
        stored = (await cur.fetchone())["ip_hash"]

    assert stored
    assert "203.0.113.7" not in stored


async def test_the_same_address_is_still_recognisable(db):
    assert user_sessions.hash_ip("203.0.113.7") == user_sessions.hash_ip("203.0.113.7")
    assert user_sessions.hash_ip("203.0.113.7") != user_sessions.hash_ip("203.0.113.8")


async def test_no_address_hashes_to_nothing(db):
    assert user_sessions.hash_ip("") == ""


# ── sessions read the way a person would describe them ───────────────────────

async def test_a_return_visit_continues_the_same_session(db):
    await _consent(db)
    first = await user_sessions.record_activity(db, 1)
    second = await user_sessions.record_activity(db, 1)
    assert first == second


async def test_a_session_after_a_gap_is_a_new_one(db):
    await _consent(db)
    first = await user_sessions.record_activity(db, 1)
    await db.execute(
        "UPDATE user_sessions SET last_seen_at = datetime('now', '-3 hours') WHERE id = ?",
        (first,),
    )
    await db.commit()

    assert await user_sessions.record_activity(db, 1) != first


async def test_signing_out_closes_every_open_session(db):
    await _consent(db)
    await user_sessions.record_activity(db, 1)
    await db.execute("UPDATE user_sessions SET last_seen_at = datetime('now', '-3 hours')")
    await db.commit()
    await user_sessions.record_activity(db, 1)

    await user_sessions.end_session(db, 1)

    async with db.execute(
        "SELECT COUNT(*) c FROM user_sessions WHERE ended_at IS NULL"
    ) as cur:
        assert (await cur.fetchone())["c"] == 0


async def test_an_unclosed_session_is_reported_as_open_not_guessed(db):
    # A browser that was simply shut never sends a sign-out. Inventing an end
    # time would be printing a guess as a fact.
    await _consent(db)
    await user_sessions.record_activity(db, 1)

    session = (await user_sessions.list_sessions(db, 1))[0]
    assert session["ended_at"] is None
    assert session["active"] is True


async def test_an_unknown_device_says_so_rather_than_blank(db):
    await _consent(db)
    await user_sessions.record_activity(db, 1, user_agent="")

    assert (await user_sessions.list_sessions(db, 1))[0]["device"] == "Not available"


async def test_the_user_agent_is_truncated(db):
    await _consent(db)
    await user_sessions.record_activity(db, 1, user_agent="x" * 500)

    async with db.execute("SELECT user_agent FROM user_sessions") as cur:
        assert len((await cur.fetchone())["user_agent"]) <= 120


async def test_one_person_never_sees_anothers_sessions(db):
    await db.execute(
        "INSERT INTO users (id, azure_oid, email, profile_consent_at) "
        "VALUES (2, 'oid-2', 'b@example.com', CURRENT_TIMESTAMP)"
    )
    await _consent(db)
    await user_sessions.record_activity(db, 1)
    await user_sessions.record_activity(db, 2)

    assert len(await user_sessions.list_sessions(db, 1)) == 1


# ── retention actually happens ───────────────────────────────────────────────

async def test_records_past_the_retention_period_are_deleted(db):
    await _consent(db)
    await user_sessions.record_activity(db, 1)
    await db.execute(
        "UPDATE user_sessions SET started_at = datetime('now', '-200 days')"
    )
    await db.commit()

    assert await user_sessions.purge_expired(db) == 1

    async with db.execute("SELECT COUNT(*) c FROM user_sessions") as cur:
        assert (await cur.fetchone())["c"] == 0


async def test_recent_records_survive_the_sweep(db):
    await _consent(db)
    await user_sessions.record_activity(db, 1)

    await user_sessions.purge_expired(db)

    async with db.execute("SELECT COUNT(*) c FROM user_sessions") as cur:
        assert (await cur.fetchone())["c"] == 1


async def test_the_retention_period_is_bounded():
    # An unbounded default would be the failure this whole module exists to
    # prevent, and would still pass every other test here.
    assert 0 < user_sessions.RETENTION_DAYS <= 365


# ── the rights people have over what we hold ─────────────────────────────────

async def test_the_export_contains_the_account_and_the_sessions(db):
    await _consent(db)
    await user_sessions.record_activity(db, 1)

    data = await user_sessions.export_for(db, 1)

    assert data["account"]["email"] == "a@example.com"
    assert len(data["sessions"]) == 1
    assert str(user_sessions.RETENTION_DAYS) in data["notes"]["retention"]


async def test_the_export_never_prints_the_address_digest(db):
    await _consent(db)
    await user_sessions.record_activity(db, 1, ip="203.0.113.7")

    data = await user_sessions.export_for(db, 1)

    assert "ip_hash" not in str(data)
    assert data["notes"]["ip_addresses"]


async def test_details_never_supplied_are_named_not_left_blank(db):
    data = await user_sessions.export_for(db, 1)

    assert data["account"]["phone"] == "Not provided"
    assert data["account"]["company"] == "Not provided"
    assert data["account"]["consent_given_at"] == "Not given"


async def test_exporting_an_account_that_is_gone_returns_nothing(db):
    assert await user_sessions.export_for(db, 999) == {}


async def test_deleting_the_account_takes_the_sessions_with_it(db):
    await _consent(db)
    await user_sessions.record_activity(db, 1)
    await db.execute("PRAGMA foreign_keys = ON")
    await db.execute("DELETE FROM users WHERE id = 1")
    await db.commit()

    async with db.execute("SELECT COUNT(*) c FROM user_sessions") as cur:
        assert (await cur.fetchone())["c"] == 0
