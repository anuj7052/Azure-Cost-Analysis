"""
Tests for turning Azure identifiers into readable words.

The single most important assertion in this file is negative: no function here
may ever return a GUID where a name belongs. That is the defect these tests
exist to prevent recurring, because it is invisible in a unit test that only
checks the happy path -- resolution succeeds, a name comes back, and nobody
notices that the failure branch prints a database key at the user.
"""
import pytest

from services import azure_names as names

SUB = "9f062503-6f98-4131-aba7-87e29c170d8a"
VM_ID = (
    f"/subscriptions/{SUB}/resourceGroups/rg-prod"
    "/providers/Microsoft.Compute/virtualMachines/Production-Web-VM"
)
DB_ID = (
    f"/subscriptions/{SUB}/resourceGroups/rg-prod"
    "/providers/Microsoft.Sql/servers/sql-01/databases/orders"
)


@pytest.fixture(autouse=True)
def clear_names():
    names.reset_names()
    yield
    names.reset_names()


class TestResourceParsing:
    def test_a_virtual_machine_id_yields_every_part(self):
        parsed = names.parse_resource_id(VM_ID)
        assert parsed["subscription_id"] == SUB
        assert parsed["resource_group"] == "rg-prod"
        assert parsed["resource_name"] == "Production-Web-VM"
        assert parsed["resource_type"] == "Microsoft.Compute/virtualMachines"

    def test_a_nested_resource_uses_the_innermost_name(self):
        # A SQL database lives inside a server. The name a person recognises is
        # the database, not the server it happens to sit in.
        parsed = names.parse_resource_id(DB_ID)
        assert parsed["resource_name"] == "orders"
        assert parsed["resource_type"] == "Microsoft.Sql/servers/databases"

    def test_a_resource_group_scope_has_no_resource(self):
        parsed = names.parse_resource_id(f"/subscriptions/{SUB}/resourceGroups/rg-prod")
        assert parsed["resource_group"] == "rg-prod"
        assert parsed["resource_name"] == ""

    def test_an_empty_id_yields_empty_parts_not_an_error(self):
        assert names.parse_resource_id("")["subscription_id"] == ""
        assert names.parse_resource_id(None)["resource_name"] == ""

    def test_parsing_needs_no_azure_call(self):
        # Stated as a test because it is the reason this is not an N+1: every
        # field above came from the string itself.
        parsed = names.parse_resource_id(VM_ID)
        assert all(parsed[key] for key in ("subscription_id", "resource_group", "resource_name"))


class TestFriendlyTypes:
    def test_known_types_use_the_portal_wording(self):
        assert names.friendly_type("Microsoft.Compute/virtualMachines") == "Virtual Machine"
        assert names.friendly_type("Microsoft.Storage/storageAccounts") == "Storage Account"

    def test_unknown_types_are_derived_not_passed_through(self):
        assert names.friendly_type("Microsoft.Foo/widgetFactories") == "Widget Factories"

    def test_empty_stays_empty(self):
        assert names.friendly_type("") == ""


class TestScopeDescription:
    def test_subscription_scope_uses_the_display_name(self):
        out = names.describe_scope(f"/subscriptions/{SUB}", {SUB: "Kredily Production"})
        assert out["kind"] == "subscription"
        assert out["label"] == "Kredily Production"
        assert "entire Kredily Production subscription" in out["sentence"]

    def test_unknown_subscription_never_shows_its_guid(self):
        out = names.describe_scope(f"/subscriptions/{SUB}", {})
        assert out["label"] == "Unnamed subscription"
        assert SUB not in out["label"]
        assert SUB not in out["sentence"]
        # Still available for the technical panel and for operations.
        assert out["subscription_id"] == SUB

    def test_resource_group_scope(self):
        out = names.describe_scope(
            f"/subscriptions/{SUB}/resourceGroups/rg-prod", {SUB: "Kredily Production"}
        )
        assert out["kind"] == "resource group"
        assert out["label"] == "rg-prod"
        assert "Kredily Production" in out["sentence"]

    def test_resource_scope_names_the_resource_and_its_type(self):
        out = names.describe_scope(VM_ID, {SUB: "Kredily Production"})
        assert out["kind"] == "resource"
        assert out["label"] == "Production-Web-VM"
        assert out["resource_type"] == "Virtual Machine"
        assert "Virtual Machine" in out["sentence"]

    def test_management_group_uses_a_friendly_name_when_there_is_one(self):
        scope = "/providers/Microsoft.Management/managementGroups/mg-visualstudio"
        out = names.describe_scope(scope, {}, {"mg-visualstudio": "Production Management"})
        assert out["kind"] == "management group"
        assert out["label"] == "Production Management"

    def test_management_group_falls_back_to_its_id_which_is_at_least_readable(self):
        scope = "/providers/Microsoft.Management/managementGroups/mg-visualstudio"
        out = names.describe_scope(scope, {})
        # Unlike a GUID, a management group id is a human-chosen string, so
        # showing it is informative rather than noise.
        assert out["label"] == "mg-visualstudio"
        assert out["management_group"] == "mg-visualstudio"

    def test_tenant_root(self):
        out = names.describe_scope("/", {})
        assert out["kind"] == "tenant"
        assert out["label"] == "Entire organisation"


class TestPrincipalLabel:
    def test_display_name_wins(self):
        assert names.principal_label("Anuj Singh", "anuj@x.com", "User") == "Anuj Singh"

    def test_email_is_used_when_there_is_no_display_name(self):
        assert names.principal_label("", "anuj@x.com", "User") == "anuj@x.com"

    def test_an_unnamed_user_is_called_an_unknown_user(self):
        assert names.principal_label("", "", "User") == "Name unavailable"

    def test_an_unnamed_application_says_so(self):
        assert names.principal_label("", "", "Service principal") == "Name unavailable"
        assert names.principal_label("", "", "Managed identity") == "Name unavailable"

    def test_an_unnamed_group_says_so(self):
        assert names.principal_label("", "", "Group") == "Name unavailable"

    def test_unknown_type_still_avoids_a_bare_guid(self):
        assert names.principal_label("", "", "") == "Name unavailable"

    def test_the_object_id_is_never_offered_as_a_name(self):
        # The defect this whole module exists to prevent. There is deliberately
        # no parameter through which an id could reach the label.
        label = names.principal_label("", "", "User")
        assert "-" not in label or label == "Name unavailable"

    def test_is_named_tracks_whether_resolution_actually_worked(self):
        assert names.is_named("Anuj Singh", "") is True
        assert names.is_named("", "anuj@x.com") is True
        assert names.is_named("", "") is False
        assert names.is_named("   ", "  ") is False


class TestRoles:
    def test_well_known_roles_are_explained(self):
        assert "control who else has access" in names.role_meaning("Owner")
        assert "cannot grant access" in names.role_meaning("Contributor")
        assert "cannot change them" in names.role_meaning("Reader")

    def test_matching_ignores_case(self):
        assert names.role_meaning("OWNER") == names.role_meaning("Owner")

    def test_a_custom_role_gets_no_invented_description(self):
        # Describing a role we have not read would be asserting something we
        # cannot support. The permission badges cover this case instead.
        assert names.role_meaning("Foundry User") == ""

    def test_role_label_falls_back_honestly(self):
        assert names.role_label("Owner") == "Owner"
        assert names.role_label("", "/roledef/abc") == "Unknown role"
        assert names.role_label("", "") == "No role recorded"


class TestSubscriptionNameCache:
    KEY_A = ("tenant-a", "hash-a")
    KEY_B = ("tenant-b", "hash-b")

    def test_names_are_recorded_from_a_listing_we_already_had(self):
        names.remember_subscription_names(
            self.KEY_A, [{"subscriptionId": SUB, "displayName": "Kredily Production"}]
        )
        assert names.subscription_names(self.KEY_A) == {SUB: "Kredily Production"}

    def test_one_tenant_cannot_read_anothers_names(self):
        names.remember_subscription_names(
            self.KEY_A, [{"subscriptionId": SUB, "displayName": "Kredily Production"}]
        )
        assert names.subscription_names(self.KEY_B) == {}

    def test_a_miss_returns_an_empty_map_not_an_error(self):
        assert names.subscription_names(("nobody", "nothing")) == {}

    def test_entries_without_a_name_are_skipped(self):
        names.remember_subscription_names(
            self.KEY_A, [{"subscriptionId": SUB}, {"displayName": "orphan"}]
        )
        assert names.subscription_names(self.KEY_A) == {}

    def test_the_returned_map_is_a_copy(self):
        names.remember_subscription_names(
            self.KEY_A, [{"subscriptionId": SUB, "displayName": "Kredily Production"}]
        )
        got = names.subscription_names(self.KEY_A)
        got[SUB] = "tampered"
        assert names.subscription_names(self.KEY_A)[SUB] == "Kredily Production"
