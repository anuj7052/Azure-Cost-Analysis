"""
Tests for graceful degradation and snapshot storage.

The requirement being guarded: an absent permission must degrade the page and
name itself, never break the page and never fall silent. An empty security
screen reads as "nothing is wrong", which is the most dangerous thing this app
could imply.
"""
import asyncio

import httpx
import pytest

from services import security_fetch as sf
from services import security_posture as posture

SUB_A = "sub-a"
SUB_B = "sub-b"


def http_error(status: int) -> httpx.HTTPStatusError:
    request = httpx.Request("GET", "https://management.azure.com/x")
    response = httpx.Response(status, request=request)
    return httpx.HTTPStatusError("boom", request=request, response=response)


class TestFailureDescription:
    def test_forbidden_is_a_permission_gap_and_names_the_role(self):
        entry = sf.describe_failure(http_error(403), posture.DEFENDER, SUB_A)
        assert entry["kind"] == "permission"
        assert "Security Reader" in entry["permission"]

    def test_permission_gap_refuses_to_imply_the_subscription_is_clean(self):
        entry = sf.describe_failure(http_error(403), posture.ADVISOR, SUB_A)
        assert "not a statement that it is clean" in entry["message"]

    def test_unregistered_provider_is_not_reported_as_denied(self):
        """404 means there is nothing to give, not that something is withheld."""
        entry = sf.describe_failure(http_error(404), posture.POLICY, SUB_A)
        assert entry["kind"] == "unavailable"

    def test_server_error_is_retryable_not_a_permission_problem(self):
        entry = sf.describe_failure(http_error(500), posture.POLICY, SUB_A)
        assert entry["kind"] == "error"
        assert entry["permission"] == ""

    def test_timeout_says_the_rest_of_the_page_is_complete(self):
        entry = sf.describe_failure(asyncio.TimeoutError(), posture.RBAC, SUB_A)
        assert "only this subscription is missing" in entry["message"]


class TestCoverageNote:
    def test_full_success_says_so_plainly(self):
        note = sf.coverage_note([SUB_A, SUB_B], [], posture.ADVISOR)
        assert note == "All 2 subscription(s) read successfully."

    def test_partial_coverage_reports_the_fraction(self):
        errors = [sf.describe_failure(http_error(403), posture.ADVISOR, SUB_B)]
        note = sf.coverage_note([SUB_A, SUB_B], errors, posture.ADVISOR)
        assert "1 of 2 subscription(s) read" in note
        assert "not the same as being clean" in note

    def test_denied_and_failed_are_counted_separately(self):
        """One is fixed with a role assignment, the other by trying again."""
        errors = [
            sf.describe_failure(http_error(403), posture.POLICY, SUB_A),
            sf.describe_failure(http_error(500), posture.POLICY, SUB_B),
        ]
        note = sf.coverage_note([SUB_A, SUB_B], errors, posture.POLICY)
        assert "denied access" in note
        assert "can be retried" in note


class TestFanOut:
    @pytest.mark.asyncio
    async def test_one_failure_never_loses_the_other_subscriptions(self):
        async def fetch(sub):
            if sub == SUB_B:
                raise http_error(403)
            return ["ok"]

        results, errors = await sf.across_subscriptions([SUB_A, SUB_B], fetch, posture.ADVISOR)
        assert results == {SUB_A: ["ok"]}
        assert len(errors) == 1

    @pytest.mark.asyncio
    async def test_subscriptions_are_read_concurrently(self):
        """Serial reads stack latency end to end and are what times the page out."""
        import time
        started = []

        async def fetch(sub):
            started.append(time.monotonic())
            await asyncio.sleep(0.05)
            return []

        subs = [f"sub-{i}" for i in range(4)]
        begin = time.monotonic()
        await sf.across_subscriptions(subs, fetch, posture.ADVISOR)
        assert time.monotonic() - begin < 0.15

    @pytest.mark.asyncio
    async def test_total_failure_returns_empty_rather_than_raising(self):
        async def fetch(sub):
            raise http_error(403)

        results, errors = await sf.across_subscriptions([SUB_A], fetch, posture.RBAC)
        assert results == {}
        assert errors[0]["kind"] == "permission"


class TestSecureScore:
    def test_score_is_read_from_the_points_not_the_percentage(self):
        raw = [{"name": "ascScore", "properties": {
            "score": {"current": 28.0, "max": 40.0, "percentage": 0.7}, "weight": 10,
        }}]
        score = sf._secure_score(raw, SUB_A)
        assert score["current"] == 28.0 and score["max"] == 40.0
        assert score["percentage"] == 70.0

    def test_score_without_a_maximum_is_not_invented(self):
        raw = [{"name": "ascScore", "properties": {"score": {"current": 0, "max": 0}}}]
        assert sf._secure_score(raw, SUB_A) is None

    def test_no_score_returns_none(self):
        assert sf._secure_score([], SUB_A) is None


async def open_db():
    """
    A throwaway database with the real schema.

    Built from ``core.db._SCHEMAS`` rather than a hand-written CREATE so that a
    column added to the real table but forgotten here cannot let these tests
    keep passing against a shape that no longer exists.
    """
    import aiosqlite
    from core import db as core_db

    connection = await aiosqlite.connect(":memory:")
    await connection.execute("PRAGMA foreign_keys = ON")
    for schema in core_db._SCHEMAS.values():
        await connection.execute(schema)
    await connection.execute(
        "INSERT INTO users (id, azure_oid) VALUES (1, 'oid-1')"
    )
    await connection.commit()
    return connection


class TestSnapshots:
    @pytest.mark.asyncio
    async def test_a_snapshot_can_be_read_back(self):
        db = await open_db()
        findings = [{"key": "a", "severity": "high", "title": "x"}]
        snapshot_id = await sf.save_snapshot(db, 1, "t1", posture.ADVISOR, findings, ["s1"])
        loaded = await sf.load_snapshot(db, 1, "t1", snapshot_id)
        assert loaded["findings"] == findings
        await db.close()

    @pytest.mark.asyncio
    async def test_another_account_cannot_read_it(self):
        """Snapshot ids are sequential and therefore guessable."""
        db = await open_db()
        snapshot_id = await sf.save_snapshot(db, 1, "t1", posture.ADVISOR, [], ["s1"])
        assert await sf.load_snapshot(db, 2, "t1", snapshot_id) is None
        await db.close()

    @pytest.mark.asyncio
    async def test_another_tenant_cannot_read_it(self):
        db = await open_db()
        snapshot_id = await sf.save_snapshot(db, 1, "t1", posture.ADVISOR, [], ["s1"])
        assert await sf.load_snapshot(db, 1, "t2", snapshot_id) is None
        await db.close()

    @pytest.mark.asyncio
    async def test_previous_snapshot_is_the_one_before(self):
        db = await open_db()
        first = await sf.save_snapshot(db, 1, "t1", posture.ADVISOR, [{"key": "a"}], ["s1"])
        second = await sf.save_snapshot(db, 1, "t1", posture.ADVISOR, [{"key": "b"}], ["s1"])
        previous = await sf.previous_snapshot(db, 1, "t1", posture.ADVISOR, before_id=second)
        assert previous["id"] == first
        await db.close()

    @pytest.mark.asyncio
    async def test_kinds_do_not_diff_against_each_other(self):
        db = await open_db()
        await sf.save_snapshot(db, 1, "t1", posture.ADVISOR, [{"key": "a"}], ["s1"])
        assert await sf.previous_snapshot(db, 1, "t1", posture.DEFENDER) is None
        await db.close()

    @pytest.mark.asyncio
    async def test_first_ever_snapshot_has_no_baseline(self):
        db = await open_db()
        assert await sf.previous_snapshot(db, 1, "t1", posture.POLICY) is None
        await db.close()

    @pytest.mark.asyncio
    async def test_errors_are_stored_so_a_partial_reading_can_be_flagged(self):
        """Otherwise the next diff reports unreadable subscriptions as resolved."""
        db = await open_db()
        errors = [{"subscription_id": "s2", "kind": "permission"}]
        snapshot_id = await sf.save_snapshot(
            db, 1, "t1", posture.DEFENDER, [], ["s1", "s2"], errors
        )
        loaded = await sf.load_snapshot(db, 1, "t1", snapshot_id)
        assert loaded["errors"] == errors
        await db.close()

    @pytest.mark.asyncio
    async def test_history_is_newest_first_and_carries_counts(self):
        db = await open_db()
        await sf.save_snapshot(db, 1, "t1", posture.ADVISOR, [{"key": "a", "severity": "high"}], ["s1"])
        await sf.save_snapshot(db, 1, "t1", posture.ADVISOR, [], ["s1"])
        history = await sf.recent_snapshots(db, 1, "t1", posture.ADVISOR)
        assert [h["finding_count"] for h in history] == [0, 1]
        assert history[1]["high_count"] == 1
        await db.close()
