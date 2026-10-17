"""Deleting a flagged resource, and deciding who may.

The delete is the only irreversible thing this platform does, so these tests
are mostly about the ways it must refuse.
"""
from __future__ import annotations

import httpx
import pytest

from services import rbac_permissions, resource_delete

SUB = "00000000-0000-0000-0000-000000000000"
DISK_ID = f"/subscriptions/{SUB}/resourceGroups/rg-1/providers/Microsoft.Compute/disks/disk-1"
IP_ID = f"/subscriptions/{SUB}/resourceGroups/rg-1/providers/Microsoft.Network/publicIPAddresses/ip-1"
VM_ID = f"/subscriptions/{SUB}/resourceGroups/rg-1/providers/Microsoft.Compute/virtualMachines/vm-1"


def transport(handler):
    """An httpx client whose responses a test decides."""
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


# ── Permission matching ────────────────────────────────────────────────────


class TestPermissionMatching:
    """Azure's wildcards, matched the way Azure means them."""

    def test_an_exact_permission_matches(self):
        assert rbac_permissions.matches(
            "Microsoft.Compute/disks/delete", "Microsoft.Compute/disks/delete"
        )

    def test_matching_ignores_case(self):
        # Azure is inconsistent about casing in role definitions, and a case
        # mismatch refusing a legitimate Owner would be a silent bug.
        assert rbac_permissions.matches(
            "microsoft.compute/disks/DELETE", "Microsoft.Compute/disks/delete"
        )

    def test_owner_holds_everything(self):
        assert rbac_permissions.matches("*", "Microsoft.Compute/disks/delete")

    def test_a_provider_wildcard_matches_inside_it(self):
        assert rbac_permissions.matches(
            "Microsoft.Compute/*", "Microsoft.Compute/disks/delete"
        )
        assert not rbac_permissions.matches(
            "Microsoft.Compute/*", "Microsoft.Network/publicIPAddresses/delete"
        )

    def test_a_wildcard_in_the_middle_matches_in_order(self):
        assert rbac_permissions.matches(
            "Microsoft.Compute/*/delete", "Microsoft.Compute/disks/delete"
        )
        # Same literals, wrong order: must not match.
        assert not rbac_permissions.matches(
            "Microsoft.Compute/*/delete", "Microsoft.Compute/disks/read"
        )

    def test_a_read_role_does_not_grant_delete(self):
        assert not rbac_permissions.matches("*/read", "Microsoft.Compute/disks/delete")


class TestWhatARoleAddsUpTo:
    def test_contributor_may_delete(self):
        # Contributor is `*` minus the authorization actions.
        blocks = [{
            "actions": ["*"],
            "notActions": [
                "Microsoft.Authorization/*/Delete",
                "Microsoft.Authorization/*/Write",
            ],
        }]
        assert rbac_permissions.allows(blocks, "Microsoft.Compute/disks/delete")

    def test_a_notaction_takes_the_permission_back(self):
        """A role granting `*` can still be refused this one thing.

        This is the case a role-name check gets wrong, and the reason this
        module asks Azure what the assignments add up to instead.
        """
        blocks = [{"actions": ["*"], "notActions": ["Microsoft.Compute/disks/delete"]}]
        assert not rbac_permissions.allows(blocks, "Microsoft.Compute/disks/delete")

    def test_a_custom_role_granting_only_the_delete_is_enough(self):
        blocks = [{"actions": ["Microsoft.Compute/disks/delete"], "notActions": []}]
        assert rbac_permissions.allows(blocks, "Microsoft.Compute/disks/delete")

    def test_a_reader_is_refused(self):
        blocks = [{"actions": ["*/read"], "notActions": []}]
        assert not rbac_permissions.allows(blocks, "Microsoft.Compute/disks/delete")

    def test_one_assignment_granting_it_is_enough(self):
        """Roles combine. Reader on one and Contributor on another means yes."""
        blocks = [
            {"actions": ["*/read"], "notActions": []},
            {"actions": ["Microsoft.Compute/*"], "notActions": []},
        ]
        assert rbac_permissions.allows(blocks, "Microsoft.Compute/disks/delete")


@pytest.mark.asyncio
class TestAskingAzure:
    async def test_an_unreadable_permission_list_is_not_permission(self):
        """The honest failure direction.

        Guessing permissively here would put a live delete button in front of
        somebody Azure is about to refuse.
        """
        async with transport(lambda r: httpx.Response(500, json={})) as client:
            allowed, reason = await rbac_permissions.can_perform(
                client, "token", DISK_ID, "Microsoft.Compute/disks/delete"
            )
        assert allowed is False
        assert reason

    async def test_being_refused_names_the_permission_that_is_missing(self):
        async with transport(
            lambda r: httpx.Response(200, json={"value": [{"actions": ["*/read"]}]})
        ) as client:
            allowed, reason = await rbac_permissions.can_perform(
                client, "token", DISK_ID, "Microsoft.Compute/disks/delete"
            )
        assert allowed is False
        assert "Microsoft.Compute/disks/delete" in reason
        assert "Owner or Contributor" in reason


# ── What may be deleted at all ─────────────────────────────────────────────


class TestTheAllowlist:
    def test_a_flagged_disk_is_deletable(self):
        spec, parts, problem = resource_delete.classify(DISK_ID)
        assert problem == ""
        assert spec.permission == "Microsoft.Compute/disks/delete"
        assert parts["name"] == "disk-1"

    def test_a_virtual_machine_is_not(self):
        spec, _parts, problem = resource_delete.classify(VM_ID)
        assert spec is None
        assert "not a resource type this page can remove" in problem

    def test_a_resource_group_is_not(self):
        """The id shape itself is refused, not just the type.

        A resource group id in the resource field is the mistake with the
        largest blast radius available here.
        """
        spec, _parts, problem = resource_delete.classify(
            f"/subscriptions/{SUB}/resourceGroups/rg-1"
        )
        assert spec is None
        assert "individual resources" in problem

    def test_a_subscription_is_not(self):
        spec, _parts, problem = resource_delete.classify(f"/subscriptions/{SUB}")
        assert spec is None

    def test_the_id_sent_to_azure_is_rebuilt_from_checked_parts(self):
        """Casing comes from the allowlist, not from the caller's string."""
        spec, parts, _ = resource_delete.classify(
            f"/subscriptions/{SUB}/resourceGroups/rg-1"
            "/providers/microsoft.compute/DISKS/disk-1"
        )
        assert spec is not None
        assert resource_delete.canonical_id(spec, parts) == DISK_ID


class TestLocks:
    def test_a_cannotdelete_lock_blocks(self):
        lock = resource_delete.blocking_lock([
            {"name": "keep", "properties": {"level": "CanNotDelete", "notes": "audit"}}
        ])
        assert lock["name"] == "keep"
        assert lock["notes"] == "audit"

    def test_a_readonly_lock_blocks_too(self):
        assert resource_delete.blocking_lock(
            [{"name": "frozen", "properties": {"level": "ReadOnly"}}]
        )

    def test_no_locks_means_no_blocker(self):
        assert resource_delete.blocking_lock([]) == {}


@pytest.mark.asyncio
class TestTheDeleteItself:
    async def test_a_202_is_reported_as_still_deleting(self):
        """Azure accepted it and is still working.

        Saying "Deleted" here would be a guess, and the difference matters to
        anyone watching the bill for the saving.
        """
        spec, _, _ = resource_delete.classify(DISK_ID)
        async with transport(lambda r: httpx.Response(202)) as client:
            ok, error, outcome = await resource_delete.delete_resource(
                client, "token", spec=spec, resource_id=DISK_ID
            )
        assert ok and not error
        assert outcome["state"] == "Deleting"

    async def test_a_204_means_it_was_already_gone(self):
        """The caller wanted it gone and it is gone.

        Failing a cleanup because somebody else finished it first would be
        unhelpfully literal.
        """
        spec, _, _ = resource_delete.classify(IP_ID)
        async with transport(lambda r: httpx.Response(204)) as client:
            ok, _error, outcome = await resource_delete.delete_resource(
                client, "token", spec=spec, resource_id=IP_ID
            )
        assert ok
        assert outcome["already_absent"] is True
        assert outcome["state"] == "Deleted"

    async def test_the_api_version_matches_the_resource_type(self):
        seen = {}

        def handler(request):
            seen["version"] = request.url.params.get("api-version")
            seen["method"] = request.method
            return httpx.Response(200)

        spec, _, _ = resource_delete.classify(IP_ID)
        async with transport(handler) as client:
            await resource_delete.delete_resource(
                client, "token", spec=spec, resource_id=IP_ID
            )
        assert seen["method"] == "DELETE"
        assert seen["version"] == spec.api_version

    async def test_azures_own_explanation_is_kept(self):
        """Azure knows why it refused; this module only knows that it did."""
        spec, _, _ = resource_delete.classify(DISK_ID)
        message = "Disk is attached to VM vm-7."
        async with transport(
            lambda r: httpx.Response(409, json={"error": {"message": message}})
        ) as client:
            ok, error, _ = await resource_delete.delete_resource(
                client, "token", spec=spec, resource_id=DISK_ID
            )
        assert not ok
        assert error == message

    async def test_a_403_names_the_permission_needed(self):
        spec, _, _ = resource_delete.classify(DISK_ID)
        async with transport(lambda r: httpx.Response(403, json={})) as client:
            ok, error, _ = await resource_delete.delete_resource(
                client, "token", spec=spec, resource_id=DISK_ID
            )
        assert not ok
        assert "Microsoft.Compute/disks/delete" in error

    async def test_an_unreachable_azure_is_not_a_deletion(self):
        spec, _, _ = resource_delete.classify(DISK_ID)

        def boom(request):
            raise httpx.ConnectError("no route")

        async with transport(boom) as client:
            ok, error, outcome = await resource_delete.delete_resource(
                client, "token", spec=spec, resource_id=DISK_ID
            )
        assert not ok
        assert outcome == {}
        assert "could not be reached" in error
