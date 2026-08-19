"""
Estate snapshots and search over them.

The claim this feature makes is "this resource no longer exists", and a wrong
one sends somebody hunting for a VM that is running fine — or worse, reassures
them that something was cleaned up when it was not. The definition of deleted,
and the partial-scan case that would corrupt it, are pinned here.
"""
from __future__ import annotations

import aiosqlite
import pytest
import pytest_asyncio

import core.db as db_module
from services import scanner, user_service
from services.scanner import (
    STATUS_COMPLETE, STATUS_FAILED, finish_scan, latest_scan_id,
    record_resources, start_scan,
)
from services.search import search_resources


def claims(oid: str, email: str = "a@x.com") -> dict:
    return {"user_id": oid, "email": email, "name": "T", "tenant_id": "t1"}


@pytest_asyncio.fixture
async def db(tmp_path, monkeypatch):
    path = str(tmp_path / "test.db")
    monkeypatch.setattr(db_module, "DB_PATH", path)
    await db_module.init_db()
    conn = await aiosqlite.connect(path)
    conn.row_factory = aiosqlite.Row
    await conn.execute("PRAGMA foreign_keys = ON")
    yield conn
    await conn.close()


def resource(name: str, rid: str | None = None) -> dict:
    return {
        "id": rid or f"/subscriptions/s1/resources/{name}",
        "name": name,
        "type": "microsoft.compute/virtualmachines",
        "resourceGroup": "rg1",
        "subscriptionId": "s1",
        "location": "eastus",
        "tags": {"env": "prod"},
    }


async def completed_scan(db, user_id: int, resources: list[dict], tenant="t1") -> int:
    scan_id = await start_scan(db, user_id, tenant)
    count = await record_resources(db, scan_id, resources)
    await finish_scan(db, scan_id, count)
    return scan_id


@pytest.mark.asyncio
async def test_a_resource_in_the_latest_scan_is_live(db):
    user = await user_service.upsert_user(db, claims("oid-a"))
    await completed_scan(db, user["id"], [resource("api-prod-03")])

    found = await search_resources(db, user["id"], "t1", "api-prod")

    assert [r["name"] for r in found["results"]] == ["api-prod-03"]
    assert found["results"][0]["live"] is True


@pytest.mark.asyncio
async def test_a_resource_missing_from_the_latest_scan_reads_as_deleted(db):
    """The question the portal cannot answer: where did api-prod-03 go?"""
    user = await user_service.upsert_user(db, claims("oid-a"))
    await completed_scan(db, user["id"], [resource("api-prod-03"), resource("db-01")])
    await completed_scan(db, user["id"], [resource("db-01")])

    found = await search_resources(db, user["id"], "t1", "api-prod")

    assert found["results"][0]["name"] == "api-prod-03"
    assert found["results"][0]["live"] is False


@pytest.mark.asyncio
async def test_a_partial_scan_does_not_delete_the_whole_estate(db):
    """
    A failed scan holds an incomplete estate.

    Treating it as current would mark every resource it never reached as
    deleted — the single most damaging way this feature could be wrong.
    """
    user = await user_service.upsert_user(db, claims("oid-a"))
    await completed_scan(db, user["id"], [resource("api-prod-03"), resource("db-01")])

    failed = await start_scan(db, user["id"], "t1")
    await record_resources(db, failed, [resource("db-01")])
    await finish_scan(db, failed, 1, error="AuthorizationFailed")

    found = await search_resources(db, user["id"], "t1", "api-prod")

    assert found["results"][0]["live"] is True


@pytest.mark.asyncio
async def test_an_unfinished_scan_is_never_treated_as_current(db):
    user = await user_service.upsert_user(db, claims("oid-a"))
    complete = await completed_scan(db, user["id"], [resource("api-prod-03")])

    running = await start_scan(db, user["id"], "t1")
    await record_resources(db, running, [])

    assert await latest_scan_id(db, user["id"], "t1") == complete
    found = await search_resources(db, user["id"], "t1", "api-prod")
    assert found["results"][0]["live"] is True


@pytest.mark.asyncio
async def test_one_customer_cannot_search_anothers_estate(db):
    """Scoping is in the SQL, so guessing a tenant id reaches nothing."""
    owner = await user_service.upsert_user(db, claims("oid-a", "a@x.com"))
    intruder = await user_service.upsert_user(db, claims("oid-b", "b@x.com"))

    await completed_scan(db, owner["id"], [resource("secret-vm")])

    found = await search_resources(db, intruder["id"], "t1", "secret")

    assert found["results"] == []
    assert found["latest_scan_id"] is None


@pytest.mark.asyncio
async def test_no_scan_yet_is_distinct_from_no_match(db):
    """
    These need different prompts: one asks for a first scan, the other says
    nothing matched. Collapsing them leaves a new user staring at "no results".
    """
    user = await user_service.upsert_user(db, claims("oid-a"))

    never_scanned = await search_resources(db, user["id"], "t1", "anything")
    assert never_scanned["latest_scan_id"] is None

    await completed_scan(db, user["id"], [resource("db-01")])
    no_match = await search_resources(db, user["id"], "t1", "nothing-like-this")
    assert no_match["latest_scan_id"] is not None
    assert no_match["results"] == []


@pytest.mark.asyncio
async def test_a_resource_surviving_many_scans_appears_once(db):
    """The estate has one db-01, not one per scan it survived."""
    user = await user_service.upsert_user(db, claims("oid-a"))
    for _ in range(3):
        await completed_scan(db, user["id"], [resource("db-01")])

    found = await search_resources(db, user["id"], "t1", "db-01")

    assert found["total"] == 1
    assert found["results"][0]["first_seen"] is not None
    assert found["results"][0]["last_seen"] is not None


@pytest.mark.asyncio
async def test_deleted_resources_are_listed_before_live_ones(db):
    """A live resource is findable in the portal; a deleted one is not."""
    user = await user_service.upsert_user(db, claims("oid-a"))
    await completed_scan(db, user["id"], [resource("web-old"), resource("web-new")])
    await completed_scan(db, user["id"], [resource("web-new")])

    found = await search_resources(db, user["id"], "t1", "web")

    assert [r["name"] for r in found["results"]] == ["web-old", "web-new"]


@pytest.mark.asyncio
async def test_deleted_results_can_be_excluded(db):
    user = await user_service.upsert_user(db, claims("oid-a"))
    await completed_scan(db, user["id"], [resource("web-old"), resource("web-new")])
    await completed_scan(db, user["id"], [resource("web-new")])

    found = await search_resources(db, user["id"], "t1", "web", include_deleted=False)

    assert [r["name"] for r in found["results"]] == ["web-new"]


@pytest.mark.asyncio
async def test_search_is_case_insensitive(db):
    user = await user_service.upsert_user(db, claims("oid-a"))
    await completed_scan(db, user["id"], [resource("API-Prod-03")])

    found = await search_resources(db, user["id"], "t1", "api-prod")

    assert found["total"] == 1


@pytest.mark.asyncio
async def test_an_empty_query_returns_nothing_rather_than_everything(db):
    user = await user_service.upsert_user(db, claims("oid-a"))
    await completed_scan(db, user["id"], [resource("db-01")])

    assert (await search_resources(db, user["id"], "t1", ""))["results"] == []
    assert (await search_resources(db, user["id"], "t1", "   "))["results"] == []


@pytest.mark.asyncio
async def test_resources_without_an_id_are_not_stored(db):
    """
    An id-less row can never be matched against another scan, so it could not
    take part in change tracking while still inflating the resource count.
    """
    user = await user_service.upsert_user(db, claims("oid-a"))
    scan_id = await start_scan(db, user["id"], "t1")

    stored = await record_resources(db, scan_id, [
        resource("good"),
        {"name": "orphan-row", "type": "x"},
    ])

    assert stored == 1


@pytest.mark.asyncio
async def test_a_failed_azure_call_is_recorded_not_swallowed(db, monkeypatch):
    """
    A tenant that loses read access must show a failed scan with the reason,
    not simply have no history for that day.
    """
    user = await user_service.upsert_user(db, claims("oid-a"))

    async def boom(token, subs):
        raise RuntimeError("AuthorizationFailed")

    monkeypatch.setattr(scanner, "query_active_resources", boom)

    result = await scanner.run_scan(db, user["id"], "t1", "tok", ["s1"])

    assert result["status"] == STATUS_FAILED
    assert "AuthorizationFailed" in result["error"]

    async with db.execute("SELECT status, error FROM scans WHERE id = ?",
                          (result["scan_id"],)) as cur:
        row = await cur.fetchone()
    assert row["status"] == STATUS_FAILED


@pytest.mark.asyncio
async def test_a_successful_scan_stores_every_resource(db, monkeypatch):
    user = await user_service.upsert_user(db, claims("oid-a"))

    async def two(token, subs):
        return [resource("a"), resource("b")]

    monkeypatch.setattr(scanner, "query_active_resources", two)

    result = await scanner.run_scan(db, user["id"], "t1", "tok", ["s1"])

    assert result["status"] == STATUS_COMPLETE
    assert result["resource_count"] == 2
