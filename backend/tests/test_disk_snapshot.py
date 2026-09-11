"""Snapshotting a disk before anything irreversible is done to it."""
import json
from datetime import datetime, timezone

import httpx
import pytest

from services import actions, disk_ops

DISK_ID = (
    "/subscriptions/11111111-2222-3333-4444-555555555555"
    "/resourceGroups/rg-prod/providers/Microsoft.Compute/disks/vm01_OsDisk"
)


class TestParsingADiskId:
    def test_a_managed_disk_is_split_into_its_parts(self):
        parts = disk_ops.parse_disk_id(DISK_ID)
        assert parts["sub"] == "11111111-2222-3333-4444-555555555555"
        assert parts["rg"] == "rg-prod"
        assert parts["name"] == "vm01_OsDisk"

    @pytest.mark.parametrize(
        "resource_id",
        [
            # A VM, not a disk. The snapshot call would be nonsense, and the
            # useful moment to say so is before a token is spent on it.
            "/subscriptions/11111111-2222-3333-4444-555555555555/resourceGroups"
            "/rg/providers/Microsoft.Compute/virtualMachines/vm01",
            # A snapshot of a snapshot is a different operation entirely.
            "/subscriptions/11111111-2222-3333-4444-555555555555/resourceGroups"
            "/rg/providers/Microsoft.Compute/snapshots/snap01",
            # Trailing segments would land the PUT somewhere else.
            DISK_ID + "/providers/Microsoft.Authorization/roleAssignments",
            "",
            "not-a-resource-id",
        ],
    )
    def test_anything_that_is_not_a_disk_is_refused(self, resource_id):
        assert disk_ops.parse_disk_id(resource_id) == {}


class TestNamingTheSnapshot:
    def test_it_says_what_it_came_from_and_when(self):
        when = datetime(2026, 9, 11, 14, 30, tzinfo=timezone.utc)
        assert disk_ops.snapshot_name("vm01_OsDisk", now=when) == (
            "vm01_OsDisk-snap-202609111430"
        )

    def test_two_snapshots_of_one_disk_do_not_collide(self):
        first = datetime(2026, 9, 11, 14, 30, tzinfo=timezone.utc)
        second = datetime(2026, 9, 11, 14, 31, tzinfo=timezone.utc)
        assert disk_ops.snapshot_name("d", now=first) != disk_ops.snapshot_name(
            "d", now=second
        )

    def test_a_long_name_is_shortened_rather_than_refused(self):
        name = disk_ops.snapshot_name("x" * 200)
        assert len(name) <= disk_ops.MAX_NAME

    def test_truncation_never_leaves_a_trailing_hyphen(self):
        # Azure rejects a name ending in a hyphen or a dot, and truncation is
        # exactly how one appears: the last character is wherever the limit
        # fell, not a character anyone chose.
        name = disk_ops.snapshot_name("a" * 60 + "-" * 10)
        assert not name.split("-snap-")[0].endswith(("-", "."))

    def test_characters_azure_rejects_are_replaced(self):
        assert "/" not in disk_ops.snapshot_name("a/b")
        assert " " not in disk_ops.snapshot_name("a b")

    def test_a_name_made_entirely_of_bad_characters_still_produces_one(self):
        # Stripping could leave nothing at all, and an empty name would make a
        # URL that points at the snapshots collection rather than at a snapshot.
        assert disk_ops.snapshot_name("///").startswith("disk-snap-")


class TestDescribingTheDisk:
    def test_it_keeps_the_facts_that_make_a_deletion_reviewable(self):
        described = disk_ops.describe(
            {
                "name": "vm01_OsDisk",
                "location": "centralindia",
                "sku": {"name": "Premium_LRS"},
                "properties": {"diskSizeGB": 1024, "diskState": "Unattached"},
            }
        )
        assert described["sku"] == "Premium_LRS"
        assert described["size_gb"] == 1024
        assert described["disk_state"] == "Unattached"

    def test_a_missing_size_is_absent_rather_than_zero(self):
        # A zero here would read as a disk of no size, which is a measurement.
        # None reads as "Azure did not say", which is the truth.
        assert disk_ops.describe({"properties": {}})["size_gb"] is None


def _client(handler):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


class TestCreatingTheSnapshot:
    @pytest.mark.asyncio
    async def test_it_asks_for_a_cheap_copy_in_the_disk_s_own_region(self):
        seen = {}

        def handler(request):
            seen["url"] = str(request.url)
            seen["body"] = json.loads(request.read().decode())
            return httpx.Response(202, json={})

        async with _client(handler) as client:
            ok, message, snapshot = await disk_ops.create_snapshot(
                client,
                "token",
                disk={"location": "centralindia"},
                disk_id=DISK_ID,
                name="snap01",
            )

        assert ok, message
        body = seen["body"]
        # Incremental and Standard_LRS are the whole cost argument. A premium
        # full snapshot costs about as much as the disk it replaces, and a cost
        # product that recommends that will not be believed about anything
        # else. Read as parsed JSON rather than matched as a string, because
        # the serialiser's spacing is not a fact about the request.
        assert body["properties"]["incremental"] is True
        assert body["sku"]["name"] == "Standard_LRS"
        assert body["location"] == "centralindia"
        assert body["properties"]["creationData"]["sourceResourceId"] == DISK_ID
        assert (
            "/resourceGroups/rg-prod/providers/Microsoft.Compute/snapshots/snap01"
            in seen["url"]
        )

    @pytest.mark.asyncio
    async def test_an_accepted_request_is_reported_as_still_creating(self):
        # 202 means Azure took the job, not that there is a recovery point yet.
        # Someone about to delete a disk on the strength of this needs the
        # difference.
        async with _client(lambda r: httpx.Response(202, json={})) as client:
            _, _, snapshot = await disk_ops.create_snapshot(
                client, "t", disk={"location": "eastus"}, disk_id=DISK_ID, name="s"
            )
        assert snapshot["state"] == "Creating"

    @pytest.mark.asyncio
    async def test_a_completed_request_says_so(self):
        async with _client(lambda r: httpx.Response(200, json={})) as client:
            _, _, snapshot = await disk_ops.create_snapshot(
                client, "t", disk={"location": "eastus"}, disk_id=DISK_ID, name="s"
            )
        assert snapshot["state"] == "Succeeded"

    @pytest.mark.asyncio
    async def test_a_disk_with_no_region_is_refused_rather_than_guessed(self):
        # A guessed region either fails confusingly or succeeds somewhere that
        # quietly bills for cross-region traffic.
        async with _client(lambda r: httpx.Response(200, json={})) as client:
            ok, message, _ = await disk_ops.create_snapshot(
                client, "t", disk={}, disk_id=DISK_ID, name="s"
            )
        assert not ok
        assert "region" in message.lower()

    @pytest.mark.asyncio
    async def test_azure_s_own_refusal_is_passed_through(self):
        def handler(request):
            return httpx.Response(
                403,
                json={"error": {"message": "Quota exceeded for snapshots in this region."}},
            )

        async with _client(handler) as client:
            ok, message, _ = await disk_ops.create_snapshot(
                client, "t", disk={"location": "eastus"}, disk_id=DISK_ID, name="s"
            )
        assert not ok
        # Azure knows why it refused; this module only knows that it did.
        assert message == "Quota exceeded for snapshots in this region."


class TestTheRegistryEntry:
    def test_snapshotting_is_shipped_and_not_destructive(self):
        spec = actions.get_spec("disk.snapshot")
        assert spec.enabled
        assert not spec.destructive
        assert spec.reversible

    def test_it_does_not_sit_behind_a_confirmation(self):
        # A safety net behind a dialog is a safety net people skip, and the
        # cost of running this by accident is a few pence a month.
        assert not actions.get_spec("disk.snapshot").requires_confirmation

    def test_deleting_a_disk_still_admits_it_cannot_be_undone(self):
        # The registry describes the capability, not one run of it. Whether a
        # snapshot was taken first is a fact about a particular deletion, and
        # claiming reversibility on the strength of a step somebody might have
        # skipped is worse than admitting there is no undo.
        spec = actions.get_spec("disk.delete")
        assert not spec.reversible
        assert not spec.enabled
        assert any("snapshot" in c.lower() for c in spec.caveats)

    def test_the_catalogue_offers_the_snapshot_before_the_deletion(self):
        keys = [entry["key"] for entry in actions.catalogue()]
        assert keys.index("disk.snapshot") < keys.index("disk.delete")
