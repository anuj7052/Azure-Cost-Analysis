"""
Tests for the only code in this application that changes Azure.

The cases below are weighted towards refusal rather than success. A grant that
fails when it should have worked is an annoyance; a grant that succeeds when it
should have been refused is an incident, so the checks that say no are the ones
worth pinning down.
"""
import httpx
import pytest
from fastapi import HTTPException

from routers.security import _assignment_scope, _require_scope
from services import access_change


SUB = "/subscriptions/0befd724-7980-4cff-9fa4-2c1905abeb29"
RG = f"{SUB}/resourceGroups/production"
ASSIGNMENT = f"{RG}/providers/Microsoft.Authorization/roleAssignments/abc-123"


def permissions_response(actions, not_actions=None):
    return httpx.Response(
        200,
        json={"value": [{"actions": actions, "notActions": not_actions or []}]},
        request=httpx.Request("GET", "https://management.azure.com"),
    )


class FakeClient:
    """A stand-in for httpx.AsyncClient that returns queued responses."""

    def __init__(self, get=None, put=None, delete=None):
        self._get = get
        self._put = put
        self._delete = delete
        self.calls = []

    async def get(self, url, **kwargs):
        self.calls.append(("GET", url))
        if isinstance(self._get, Exception):
            raise self._get
        return self._get

    async def put(self, url, **kwargs):
        self.calls.append(("PUT", url, kwargs.get("json")))
        if isinstance(self._put, Exception):
            raise self._put
        return self._put

    async def delete(self, url, **kwargs):
        self.calls.append(("DELETE", url))
        if isinstance(self._delete, Exception):
            raise self._delete
        return self._delete


class TestActionMatching:
    """Wildcards decide whether an Owner is recognised as an Owner."""

    def test_star_covers_everything(self):
        assert access_change._action_matches("*", access_change.WRITE_ACTION)

    def test_prefix_wildcard_covers_the_family(self):
        assert access_change._action_matches(
            "Microsoft.Authorization/*", access_change.WRITE_ACTION
        )

    def test_unrelated_prefix_does_not_match(self):
        assert not access_change._action_matches(
            "Microsoft.Compute/*", access_change.WRITE_ACTION
        )

    def test_exact_match_is_case_insensitive(self):
        assert access_change._action_matches(
            "MICROSOFT.AUTHORIZATION/ROLEASSIGNMENTS/WRITE",
            access_change.WRITE_ACTION,
        )

    def test_empty_pattern_matches_nothing(self):
        assert not access_change._action_matches("", access_change.WRITE_ACTION)


class TestScopeParsing:
    def test_subscription_is_read_from_a_resource_group_scope(self):
        assert access_change.subscription_of(RG) == "0befd724-7980-4cff-9fa4-2c1905abeb29"

    def test_scope_without_a_subscription_yields_nothing(self):
        assert access_change.subscription_of("/providers/Microsoft.Management/x") == ""

    def test_scope_kinds(self):
        assert access_change.scope_kind(SUB) == "subscription"
        assert access_change.scope_kind(RG) == "resource group"
        assert access_change.scope_kind(
            f"{RG}/providers/Microsoft.Compute/virtualMachines/vm1"
        ) == "resource"
        assert access_change.scope_kind(
            "/providers/Microsoft.Management/managementGroups/mg1"
        ) == "management group"


class TestScopeGuard:
    def test_subscription_scope_is_accepted(self):
        assert _require_scope(RG) == RG

    def test_tenant_root_is_refused(self):
        with pytest.raises(HTTPException) as err:
            _require_scope("/")
        assert err.value.status_code == 400

    def test_management_group_is_refused(self):
        # Refused deliberately: a change here affects every subscription
        # beneath it and this application cannot enumerate those.
        with pytest.raises(HTTPException):
            _require_scope("/providers/Microsoft.Management/managementGroups/mg1")


class TestAssignmentScope:
    def test_scope_is_derived_from_the_assignment_id(self):
        assert _assignment_scope(ASSIGNMENT) == RG

    def test_derivation_is_case_insensitive(self):
        weird = ASSIGNMENT.replace("Microsoft.Authorization", "MICROSOFT.AUTHORIZATION")
        assert _assignment_scope(weird) == RG

    def test_a_non_assignment_id_is_refused(self):
        with pytest.raises(HTTPException):
            _assignment_scope(f"{RG}/providers/Microsoft.Compute/virtualMachines/vm1")

    def test_empty_id_is_refused(self):
        with pytest.raises(HTTPException):
            _assignment_scope("")


class TestCallerPermissions:
    async def test_owner_may_write_and_delete(self):
        client = FakeClient(get=permissions_response(["*"]))
        result = await access_change.caller_permissions(client, "tok", RG)
        assert result["status"] == "allowed"
        assert result["can_write"] and result["can_delete"]

    async def test_reader_may_do_neither(self):
        client = FakeClient(get=permissions_response(["Microsoft.Resources/*/read"]))
        result = await access_change.caller_permissions(client, "tok", RG)
        assert result["status"] == "denied"
        assert not result["can_write"]
        assert "Owner or User Access Administrator" in result["note"]

    async def test_not_actions_removes_a_granted_action(self):
        # This is the case a naive implementation gets wrong: the action is
        # present in `actions` but explicitly subtracted in `notActions`.
        client = FakeClient(
            get=permissions_response(["*"], ["Microsoft.Authorization/roleAssignments/write"])
        )
        result = await access_change.caller_permissions(client, "tok", RG)
        assert result["can_write"] is False

    async def test_unreachable_azure_is_unverified_not_permitted(self):
        client = FakeClient(get=httpx.ConnectError("down"))
        result = await access_change.caller_permissions(client, "tok", RG)
        assert result["status"] == "unverified"
        assert result["can_write"] is False
        assert result["can_delete"] is False


class TestCreateAssignment:
    async def test_success_returns_the_new_id(self):
        response = httpx.Response(
            201,
            json={"id": ASSIGNMENT},
            request=httpx.Request("PUT", "https://management.azure.com"),
        )
        client = FakeClient(put=response)
        ok, message, created = await access_change.create_assignment(
            client, "tok", RG, "/roledef/reader", "principal-1", "User"
        )
        assert ok and not message
        assert created == ASSIGNMENT

    async def test_principal_type_is_sent_when_known(self):
        response = httpx.Response(
            201, json={"id": ASSIGNMENT},
            request=httpx.Request("PUT", "https://management.azure.com"),
        )
        client = FakeClient(put=response)
        await access_change.create_assignment(
            client, "tok", RG, "/roledef/reader", "p1", "ServicePrincipal"
        )
        body = client.calls[0][2]
        assert body["properties"]["principalType"] == "ServicePrincipal"

    async def test_azure_error_message_is_surfaced(self):
        response = httpx.Response(
            403,
            json={"error": {"code": "AuthorizationFailed", "message": "You do not have permission."}},
            request=httpx.Request("PUT", "https://management.azure.com"),
        )
        client = FakeClient(put=response)
        ok, message, created = await access_change.create_assignment(
            client, "tok", RG, "/roledef/owner", "p1"
        )
        assert ok is False
        assert "You do not have permission." in message
        assert "AuthorizationFailed" in message
        assert created == ""

    async def test_network_failure_is_a_value_not_an_exception(self):
        client = FakeClient(put=httpx.ConnectError("down"))
        ok, message, _ = await access_change.create_assignment(
            client, "tok", RG, "/roledef/reader", "p1"
        )
        assert ok is False
        assert "could not be reached" in message


class TestDeleteAssignment:
    async def test_success(self):
        response = httpx.Response(
            200, json={}, request=httpx.Request("DELETE", "https://management.azure.com")
        )
        ok, message = await access_change.delete_assignment(
            FakeClient(delete=response), "tok", ASSIGNMENT
        )
        assert ok and not message

    async def test_already_gone_counts_as_removed(self):
        # The caller asked for this access not to exist. It does not exist.
        response = httpx.Response(
            404, request=httpx.Request("DELETE", "https://management.azure.com")
        )
        ok, message = await access_change.delete_assignment(
            FakeClient(delete=response), "tok", ASSIGNMENT
        )
        assert ok is True
        assert message == ""

    async def test_denied_is_a_failure(self):
        response = httpx.Response(
            403,
            json={"error": {"code": "AuthorizationFailed", "message": "Nope."}},
            request=httpx.Request("DELETE", "https://management.azure.com"),
        )
        ok, message = await access_change.delete_assignment(
            FakeClient(delete=response), "tok", ASSIGNMENT
        )
        assert ok is False
        assert "Nope." in message


class TestPlainLanguage:
    def test_owner_effect_mentions_granting_access(self):
        sentence = access_change.effect_sentence("Owner", RG)
        assert "giving other people access" in sentence
        assert "resource group" in sentence

    def test_reader_effect_says_it_cannot_change(self):
        assert "not change anything" in access_change.effect_sentence("Reader", SUB)

    def test_unknown_role_is_described_without_inventing_powers(self):
        sentence = access_change.effect_sentence("Foundry User", RG)
        assert "Foundry User" in sentence
        assert "defined by the role itself" in sentence

    def test_loss_sentence_for_owner(self):
        assert "full control" in access_change.loss_sentence("Owner", SUB)

    def test_dangerous_roles_are_recognised_case_insensitively(self):
        assert "owner" in access_change.DANGEROUS_ROLES
        assert "User Access Administrator".lower() in access_change.DANGEROUS_ROLES
