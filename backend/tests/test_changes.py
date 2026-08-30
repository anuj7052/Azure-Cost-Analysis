"""
Change tracking and entity history.

The failure that matters here is a phantom change: reporting that something
moved when it did not. A tool that cries wolf on every scan gets ignored, and
then the one real change is missed too. Casing, unchanged fields and tag
handling are pinned for that reason.
"""
from __future__ import annotations

import aiosqlite
import pytest
import pytest_asyncio

import core.db as db_module
from services import user_service
from services.changes import compare_resource, diff_scans, entity_history
from services.scanner import finish_scan, record_resources, start_scan


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


def vm(name="vm-api-01", *, rid=None, location="eastus", sku="D2s v3", tags=None,
       resource_group="rg-prod"):
    return {
        "id": rid or f"/subscriptions/s1/resourceGroups/{resource_group}/providers/"
                     f"Microsoft.Compute/virtualMachines/{name}",
        "name": name,
        "type": "microsoft.compute/virtualmachines",
        "resourceGroup": resource_group,
        "subscriptionId": "s1",
        "location": location,
        "skuName": sku,
        "tags": tags or {},
    }


async def scan(db, user_id, resources, tenant="t1"):
    scan_id = await start_scan(db, user_id, tenant)
    count = await record_resources(db, scan_id, resources)
    await finish_scan(db, scan_id, count)
    return scan_id


@pytest.mark.asyncio
async def test_a_new_resource_is_reported_as_added(db):
    user = await user_service.upsert_user(db, claims("oid-a"))
    await scan(db, user["id"], [vm("vm-api-01")])
    await scan(db, user["id"], [vm("vm-api-01"), vm("vm-api-02")])

    result = await diff_scans(db, user["id"], "t1")

    assert [r["name"] for r in result["added"]] == ["vm-api-02"]
    assert result["removed_count"] == 0


@pytest.mark.asyncio
async def test_a_missing_resource_is_reported_as_removed(db):
    user = await user_service.upsert_user(db, claims("oid-a"))
    await scan(db, user["id"], [vm("vm-api-01"), vm("vm-old")])
    await scan(db, user["id"], [vm("vm-api-01")])

    result = await diff_scans(db, user["id"], "t1")

    assert [r["name"] for r in result["removed"]] == ["vm-old"]


@pytest.mark.asyncio
async def test_an_unchanged_estate_reports_nothing(db):
    """
    The most important case.

    A tool that reports changes when nothing moved gets ignored, and then the
    one real change is missed too.
    """
    user = await user_service.upsert_user(db, claims("oid-a"))
    await scan(db, user["id"], [vm("vm-api-01"), vm("vm-db-01")])
    await scan(db, user["id"], [vm("vm-api-01"), vm("vm-db-01")])

    result = await diff_scans(db, user["id"], "t1")

    assert result["total_changes"] == 0


@pytest.mark.asyncio
async def test_resource_ids_are_matched_regardless_of_casing(db):
    """
    Azure varies id casing between APIs. Matching the raw string would report
    the same resource as both removed and added on every scan.
    """
    user = await user_service.upsert_user(db, claims("oid-a"))
    resource = vm("vm-api-01")
    await scan(db, user["id"], [resource])
    await scan(db, user["id"], [{**resource, "id": resource["id"].upper()}])

    result = await diff_scans(db, user["id"], "t1")

    assert result["added_count"] == 0
    assert result["removed_count"] == 0


@pytest.mark.asyncio
async def test_a_resized_vm_reports_the_field_that_moved(db):
    user = await user_service.upsert_user(db, claims("oid-a"))
    await scan(db, user["id"], [vm("vm-api-01", sku="D2s v3")])
    await scan(db, user["id"], [vm("vm-api-01", sku="D4s v3")])

    result = await diff_scans(db, user["id"], "t1")
    change = result["modified"][0]["changes"][0]

    assert change["field"] == "sku"
    assert change["from"] == "D2s v3"
    assert change["to"] == "D4s v3"


@pytest.mark.asyncio
async def test_a_moved_region_is_tracked(db):
    user = await user_service.upsert_user(db, claims("oid-a"))
    await scan(db, user["id"], [vm("vm-api-01", location="eastus")])
    await scan(db, user["id"], [vm("vm-api-01", location="westeurope")])

    result = await diff_scans(db, user["id"], "t1")
    fields = [c["field"] for c in result["modified"][0]["changes"]]

    assert "location" in fields


def test_tags_are_compared_key_by_key():
    """
    A whole-blob before/after is accurate and unreadable: nobody can spot which
    of fifteen tags moved, and governance work is almost entirely per-tag.
    """
    before = {
        "name": "vm", "type": "t", "resource_group": "rg", "subscription_id": "s",
        "location": "eastus", "sku": "D2s v3",
        "tags": '{"env":"dev","owner":"anna","cost":"x"}',
    }
    after = {
        **before,
        "tags": '{"env":"prod","team":"platform","cost":"x"}',
    }

    changes = compare_resource(before, after)
    tags = changes[0]["tags"]

    assert tags["changed"]["env"] == {"from": "dev", "to": "prod"}
    assert tags["added"] == {"team": "platform"}
    assert tags["removed"] == {"owner": "anna"}
    # An untouched tag must not appear anywhere.
    assert "cost" not in tags["changed"]


def test_identical_tags_are_not_a_change():
    """Key order differs between captures; the content is what matters."""
    before = {
        "name": "vm", "type": "t", "resource_group": "rg", "subscription_id": "s",
        "location": "eastus", "sku": "D2s v3",
        "tags": '{"env":"prod","owner":"anna"}',
    }
    after = {**before, "tags": '{"owner":"anna","env":"prod"}'}

    assert compare_resource(before, after) == []


@pytest.mark.asyncio
async def test_a_single_scan_is_reported_as_not_comparable(db):
    """
    A new user has nothing to compare yet. That is a state to explain, not an
    error, and not "zero changes" — which would imply a stable estate.
    """
    user = await user_service.upsert_user(db, claims("oid-a"))
    await scan(db, user["id"], [vm("vm-api-01")])

    result = await diff_scans(db, user["id"], "t1")

    assert result["comparable"] is False
    assert result["total_changes"] == 0


@pytest.mark.asyncio
async def test_one_customer_cannot_diff_anothers_scans(db):
    """A scan id is a small integer, so ownership is enforced in SQL."""
    owner = await user_service.upsert_user(db, claims("oid-a", "a@x.com"))
    intruder = await user_service.upsert_user(db, claims("oid-b", "b@x.com"))

    first = await scan(db, owner["id"], [vm("secret-vm")])
    second = await scan(db, owner["id"], [vm("secret-vm", sku="D4s v3")])

    result = await diff_scans(db, intruder["id"], "t1", before_id=first, after_id=second)

    assert result["comparable"] is False
    assert result["total_changes"] == 0


@pytest.mark.asyncio
async def test_entity_history_records_every_change_to_one_resource(db):
    """
    The view a diff cannot give: not "it was resized" but "it has been resized
    repeatedly", which is a different conversation.
    """
    user = await user_service.upsert_user(db, claims("oid-a"))
    resource = vm("vm-api-01")

    await scan(db, user["id"], [resource])
    await scan(db, user["id"], [vm("vm-api-01", sku="D4s v3")])
    await scan(db, user["id"], [vm("vm-api-01", sku="D8s v3")])

    history = await entity_history(db, user["id"], "t1", resource["id"])
    kinds = [e["kind"] for e in history["events"]]

    # Newest first: the last thing that happened is the question being asked.
    assert kinds == ["modified", "modified", "first_seen"]
    assert history["events"][0]["changes"][0]["to"] == "D8s v3"
    assert history["scan_count"] == 3


@pytest.mark.asyncio
async def test_history_omits_scans_where_nothing_happened(db):
    """
    Listing every scan would bury four real events under two hundred identical
    ones, which is how a history stops being read.
    """
    user = await user_service.upsert_user(db, claims("oid-a"))
    resource = vm("vm-api-01")

    for _ in range(5):
        await scan(db, user["id"], [resource])
    await scan(db, user["id"], [vm("vm-api-01", sku="D4s v3")])

    history = await entity_history(db, user["id"], "t1", resource["id"])

    assert [e["kind"] for e in history["events"]] == ["modified", "first_seen"]


@pytest.mark.asyncio
async def test_history_records_the_resource_disappearing(db):
    """Deletion is the most important event in a resource's history."""
    user = await user_service.upsert_user(db, claims("oid-a"))
    resource = vm("vm-api-01")

    await scan(db, user["id"], [resource])
    await scan(db, user["id"], [vm("vm-other")])

    history = await entity_history(db, user["id"], "t1", resource["id"])

    assert history["events"][0]["kind"] == "removed"


@pytest.mark.asyncio
async def test_history_of_an_unknown_resource_is_empty_not_an_error(db):
    user = await user_service.upsert_user(db, claims("oid-a"))
    await scan(db, user["id"], [vm("vm-api-01")])

    history = await entity_history(db, user["id"], "t1", "/subscriptions/s1/nope")

    assert history["resource"] is None
    assert history["events"] == []


@pytest.mark.asyncio
async def test_one_customer_cannot_read_anothers_entity_history(db):
    owner = await user_service.upsert_user(db, claims("oid-a", "a@x.com"))
    intruder = await user_service.upsert_user(db, claims("oid-b", "b@x.com"))
    resource = vm("secret-vm")

    await scan(db, owner["id"], [resource])

    history = await entity_history(db, intruder["id"], "t1", resource["id"])

    assert history["resource"] is None


# ── Comparing by date ──────────────────────────────────────────────────────

from services.changes import diff_by_date


async def scan_at(db, user_id, resources, started_at, tenant="t1"):
    """A completed scan with a controlled timestamp, for date-range tests."""
    scan_id = await scan(db, user_id, resources, tenant)
    await db.execute("UPDATE scans SET started_at = ? WHERE id = ?", (started_at, scan_id))
    await db.commit()
    return scan_id


@pytest.mark.asyncio
async def test_a_date_resolves_to_the_estate_as_it_stood_that_day(db):
    """
    Scans happen at moments; questions are asked about days. The last scan on
    or before the date is the most recent state known at that point.
    """
    user = await user_service.upsert_user(db, claims("oid-a"))
    await scan_at(db, user["id"], [vm("vm-api-01")], "2026-08-01 09:00:00")
    await scan_at(db, user["id"], [vm("vm-api-01"), vm("vm-new")], "2026-08-05 09:00:00")

    result = await diff_by_date(db, user["id"], "t1", "2026-08-01", "2026-08-05")

    assert result["comparable"] is True
    assert [r["name"] for r in result["added"]] == ["vm-new"]


@pytest.mark.asyncio
async def test_a_scan_later_the_same_day_still_counts_as_that_day(db):
    """A scan at 23:00 belongs to the day the user picked, not the next one."""
    user = await user_service.upsert_user(db, claims("oid-a"))
    await scan_at(db, user["id"], [vm("vm-api-01")], "2026-08-01 23:30:00")
    await scan_at(db, user["id"], [vm("vm-api-01"), vm("vm-new")], "2026-08-09 10:00:00")

    result = await diff_by_date(db, user["id"], "t1", "2026-08-01", "2026-08-09")

    assert result["comparable"] is True
    assert result["added_count"] == 1


@pytest.mark.asyncio
async def test_both_dates_landing_on_one_scan_is_explained_not_reported_as_stable(db):
    """
    "0 changes" would imply a stable estate when the real answer is that
    scanning was too infrequent to say anything at all.
    """
    user = await user_service.upsert_user(db, claims("oid-a"))
    await scan_at(db, user["id"], [vm("vm-api-01")], "2026-08-01 09:00:00")

    result = await diff_by_date(db, user["id"], "t1", "2026-08-02", "2026-08-03")

    assert result["comparable"] is False
    assert "same scan" in result["note"]


@pytest.mark.asyncio
async def test_a_start_date_before_every_scan_uses_the_earliest_capture(db):
    """
    Reporting "no data" would be technically right and unhelpful when captures
    exist just after the requested date.
    """
    user = await user_service.upsert_user(db, claims("oid-a"))
    await scan_at(db, user["id"], [vm("vm-api-01")], "2026-08-01 09:00:00")
    await scan_at(db, user["id"], [vm("vm-api-01"), vm("vm-new")], "2026-08-10 09:00:00")

    result = await diff_by_date(db, user["id"], "t1", "2026-01-01", "2026-08-10")

    assert result["comparable"] is True
    assert result["added_count"] == 1


@pytest.mark.asyncio
async def test_the_response_names_the_scans_actually_compared(db):
    """
    A range that silently resolved to something else could not be trusted, so
    the answer always states what it used.
    """
    user = await user_service.upsert_user(db, claims("oid-a"))
    first = await scan_at(db, user["id"], [vm("vm-api-01")], "2026-08-01 09:00:00")
    second = await scan_at(db, user["id"], [vm("vm-other")], "2026-08-05 09:00:00")

    result = await diff_by_date(db, user["id"], "t1", "2026-08-03", "2026-08-06")

    assert result["before"]["id"] == first
    assert result["after"]["id"] == second


@pytest.mark.asyncio
async def test_a_range_with_no_scans_at_all_says_so(db):
    user = await user_service.upsert_user(db, claims("oid-a"))

    result = await diff_by_date(db, user["id"], "t1", "2026-08-01", "2026-08-05")

    assert result["comparable"] is False
    assert "No completed scan" in result["note"]


@pytest.mark.asyncio
async def test_one_customer_cannot_compare_anothers_estate_by_date(db):
    owner = await user_service.upsert_user(db, claims("oid-a", "a@x.com"))
    intruder = await user_service.upsert_user(db, claims("oid-b", "b@x.com"))

    await scan_at(db, owner["id"], [vm("secret-vm")], "2026-08-01 09:00:00")
    await scan_at(db, owner["id"], [vm("secret-vm-2")], "2026-08-05 09:00:00")

    result = await diff_by_date(db, intruder["id"], "t1", "2026-08-01", "2026-08-05")

    assert result["comparable"] is False


# ── ignoring expected changes, end to end ───────────────────────────────────
#
# These go through the database rather than the pure functions, because the
# thing worth pinning is that one customer's suppression cannot silence
# another's audit trail.


@pytest.mark.asyncio
async def test_an_ignore_survives_being_set_twice(db):
    """Ignoring is a state, not an event. Asking for it twice is not an error."""
    from services import changes as svc

    user = await user_service.upsert_user(db, claims("oid-i1"))
    await svc.add_ignore(db, user["id"], "t1", "/sub/a", note="expected")
    await svc.add_ignore(db, user["id"], "t1", "/sub/a", note="still expected")

    rules = await svc.list_ignores(db, user["id"], "t1")
    assert len(rules) == 1
    assert rules[0]["note"] == "still expected"


@pytest.mark.asyncio
async def test_one_account_cannot_see_or_lift_anothers_ignores(db):
    from services import changes as svc

    mine = await user_service.upsert_user(db, claims("oid-i2", "me@x.com"))
    theirs = await user_service.upsert_user(db, claims("oid-i3", "them@x.com"))

    await svc.add_ignore(db, mine["id"], "t1", "/sub/a")

    assert await svc.list_ignores(db, theirs["id"], "t1") == []
    assert await svc.remove_ignore(db, theirs["id"], "t1", "/sub/a") == 0
    assert len(await svc.list_ignores(db, mine["id"], "t1")) == 1


@pytest.mark.asyncio
async def test_an_ignore_is_scoped_to_one_tenant(db):
    """The same resource id can exist in two connected tenants."""
    from services import changes as svc

    user = await user_service.upsert_user(db, claims("oid-i4"))
    await svc.add_ignore(db, user["id"], "t1", "/sub/a")

    assert await svc.list_ignores(db, user["id"], "t2") == []


@pytest.mark.asyncio
async def test_lifting_an_ignore_that_was_never_set_is_not_an_error(db):
    from services import changes as svc

    user = await user_service.upsert_user(db, claims("oid-i5"))
    assert await svc.remove_ignore(db, user["id"], "t1", "/sub/nothing") == 0


@pytest.mark.asyncio
async def test_a_lifted_ignore_stops_hiding_the_change(db):
    from services import changes as svc

    user = await user_service.upsert_user(db, claims("oid-i6"))
    await scan(db, user["id"], [vm("vm-1")])
    await scan(db, user["id"], [vm("vm-1"), vm("vm-2")])

    rid = vm("vm-2")["id"]
    await svc.add_ignore(db, user["id"], "t1", rid)

    diff = await diff_scans(db, user["id"], "t1")
    hidden = svc.apply_ignores(diff, await svc.list_ignores(db, user["id"], "t1"))
    assert hidden["added_count"] == 0

    await svc.remove_ignore(db, user["id"], "t1", rid)
    diff = await diff_scans(db, user["id"], "t1")
    shown = svc.apply_ignores(diff, await svc.list_ignores(db, user["id"], "t1"))
    assert shown["added_count"] == 1


@pytest.mark.asyncio
async def test_the_configuration_bag_is_captured_and_diffed_through_a_real_scan(db):
    """The whole path: Resource Graph shape in, property difference out."""
    from services import changes as svc

    user = await user_service.upsert_user(db, claims("oid-i7"))

    before = vm("vm-net")
    before["properties"] = {"publicNetworkAccess": "Disabled"}
    after = vm("vm-net")
    after["properties"] = {"publicNetworkAccess": "Enabled"}

    await scan(db, user["id"], [before])
    await scan(db, user["id"], [after])

    result = await diff_scans(db, user["id"], "t1")
    fields = [c["field"] for c in result["modified"][0]["changes"]]
    assert fields == ["publicNetworkAccess"]
    assert result["modified"][0]["properties"] == {"publicNetworkAccess": "Enabled"}
