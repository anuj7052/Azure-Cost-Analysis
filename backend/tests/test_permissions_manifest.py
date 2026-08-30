"""
The permission list is the one document a customer's security team reads
before they let this app anywhere near their tenant. These tests exist to stop
it drifting away from what the code actually does.
"""
import pytest

from services import permissions_manifest as pm


class TestTiers:
    def test_every_role_sits_in_a_known_tier(self):
        for role in pm.AZURE_ROLES:
            assert role["tier"] in pm.TIER_ORDER

    def test_every_tier_has_a_label_and_a_summary(self):
        for tier in pm.TIER_ORDER:
            assert pm.TIER_LABEL[tier]
            assert pm.TIER_SUMMARY[tier]

    def test_the_essential_tier_can_change_nothing(self):
        assert pm.read_only(pm.CORE) is True

    def test_full_visibility_can_still_change_nothing(self):
        # The whole promise of this tier is that it is safe to grant.
        assert pm.read_only(pm.FULL_READ) is True

    def test_the_write_tier_admits_that_it_writes(self):
        assert pm.read_only(pm.WRITE) is False

    def test_an_unknown_tier_is_read_only_vacuously_but_lists_nothing(self):
        assert pm.cumulative_roles("nonsense") == []


class TestCumulative:
    def test_essential_is_just_itself(self):
        assert pm.cumulative_roles(pm.CORE) == pm.roles_in_tier(pm.CORE)

    def test_full_read_includes_essential(self):
        names = {r["name"] for r in pm.cumulative_roles(pm.FULL_READ)}
        assert "Reader" in names
        assert "Cost Management Reader" in names
        assert "Security Reader" in names

    def test_write_includes_everything(self):
        assert len(pm.cumulative_roles(pm.WRITE)) == len(pm.AZURE_ROLES)


class TestReadVersusChange:
    def test_only_the_write_tier_contains_change_roles(self):
        for role in pm.write_roles():
            assert role["tier"] == pm.WRITE

    def test_the_features_we_know_write_are_all_covered(self):
        # Each of these corresponds to a PUT or DELETE that exists in the
        # codebase. If a new one is added without a role here, the guide
        # becomes a lie and this test should be the thing that notices.
        unlocked = " ".join(
            u for role in pm.write_roles() for u in role["unlocks"]
        ).lower()
        assert "tag" in unlocked
        assert "resize" in unlocked
        assert "provision" in unlocked
        assert "revoke" in unlocked

    def test_every_change_role_carries_a_caveat(self):
        for role in pm.write_roles():
            assert role["caveat"], role["name"]


class TestRoleIdentifiers:
    def test_assignable_roles_have_a_role_definition_id(self):
        for role in pm.assignable_roles(pm.AZURE_ROLES):
            assert len(role["role_id"]) == 36, role["name"]

    def test_reservation_reader_is_not_pretended_to_be_assignable(self):
        # There is no subscription-scope RBAC role by this name. Claiming
        # otherwise sends people to a command that fails.
        reservation = next(
            r for r in pm.AZURE_ROLES if r["name"] == "Reservation Reader"
        )
        assert reservation["assignable"] is False
        assert reservation["role_id"] == ""

    def test_role_ids_are_unique(self):
        ids = [r["role_id"] for r in pm.assignable_roles(pm.AZURE_ROLES)]
        assert len(ids) == len(set(ids))


class TestCommands:
    def test_a_subscription_role_produces_a_subscription_scope(self):
        reader = next(r for r in pm.AZURE_ROLES if r["name"] == "Reader")
        cmd = pm.role_assignment_command(reader, "sub-1", "someone")
        assert "--scope /subscriptions/sub-1" in cmd
        assert '--role "Reader"' in cmd
        assert "--assignee someone" in cmd

    def test_a_management_group_role_does_not_get_a_subscription_scope(self):
        mg = next(
            r for r in pm.AZURE_ROLES if r["scope"] == pm.MANAGEMENT_GROUP
        )
        cmd = pm.role_assignment_command(mg, "sub-1", "someone")
        assert "/providers/Microsoft.Management/managementGroups/" in cmd
        assert "/subscriptions/sub-1" not in cmd

    def test_an_unassignable_role_returns_nothing_rather_than_a_broken_command(self):
        reservation = next(
            r for r in pm.AZURE_ROLES if r["name"] == "Reservation Reader"
        )
        assert pm.role_assignment_command(reservation) is None

    def test_placeholders_are_obvious_when_nothing_is_supplied(self):
        reader = next(r for r in pm.AZURE_ROLES if r["name"] == "Reader")
        cmd = pm.role_assignment_command(reader)
        assert "<subscription-id>" in cmd
        assert "<user-or-app-id>" in cmd


class TestGraphPermissions:
    def test_nothing_is_an_application_permission(self):
        # Application permissions would mean this app holding standing access
        # to a customer's directory with no user involved. That is precisely
        # what a shared SaaS must not do.
        for perm in pm.GRAPH_PERMISSIONS + [pm.AZURE_SERVICE_MANAGEMENT]:
            assert perm["permission_type"] == "Delegated"

    def test_directory_read_is_flagged_as_needing_an_admin(self):
        directory = next(
            g for g in pm.GRAPH_PERMISSIONS if g["name"] == "Directory.Read.All"
        )
        assert directory["admin_consent"] is True

    def test_user_read_does_not_need_an_admin(self):
        user = next(
            g for g in pm.GRAPH_PERMISSIONS if g["name"] == "User.Read"
        )
        assert user["admin_consent"] is False

    def test_the_directory_caveat_admits_the_real_blast_radius(self):
        directory = next(
            g for g in pm.GRAPH_PERMISSIONS if g["name"] == "Directory.Read.All"
        )
        assert "whole directory" in directory["caveat"]

    def test_permission_ids_are_guids(self):
        for perm in pm.GRAPH_PERMISSIONS + [pm.AZURE_SERVICE_MANAGEMENT]:
            assert len(perm["permission_id"]) == 36, perm["name"]

    def test_arm_impersonation_is_in_the_essential_tier(self):
        # Without it every RBAC role in the world grants nothing.
        assert pm.AZURE_SERVICE_MANAGEMENT["tier"] == pm.CORE

    def test_graph_in_tier_includes_arm_only_once(self):
        core = pm.graph_in_tier(pm.CORE)
        names = [g["name"] for g in core]
        assert len(names) == len(set(names))
        assert any("user_impersonation" in n for n in names)


class TestConsentUrl:
    def test_it_points_at_the_customers_own_tenant(self):
        url = pm.consent_url("tenant-abc", "client-xyz", "https://app.example")
        assert url.startswith("https://login.microsoftonline.com/tenant-abc/adminconsent")
        assert "client_id=client-xyz" in url

    def test_the_redirect_is_encoded(self):
        url = pm.consent_url("t", "c", "https://app.example/done")
        assert "https%3A%2F%2Fapp.example%2Fdone" in url

    @pytest.mark.parametrize(
        "tenant,client,redirect",
        [
            ("", "c", "https://a"),
            ("t", "", "https://a"),
            ("t", "c", ""),
        ],
    )
    def test_a_missing_piece_yields_nothing_rather_than_a_wrong_link(
        self, tenant, client, redirect
    ):
        # A consent link aimed at the wrong directory is worse than no link.
        assert pm.consent_url(tenant, client, redirect) is None


class TestSummary:
    def test_counts_add_up(self):
        s = pm.summarise()
        assert s["total"] == s["read"] + s["change"]
        assert s["azure_roles"] == len(pm.AZURE_ROLES)

    def test_change_count_matches_the_write_roles(self):
        assert pm.summarise()["change"] == len(pm.write_roles())

    def test_exactly_one_thing_needs_admin_consent(self):
        assert pm.summarise()["needs_admin_consent"] == 1


class TestNote:
    def test_it_names_how_many_roles_can_change_things(self):
        assert str(len(pm.write_roles())) in pm.note()

    def test_it_does_not_claim_the_whole_app_is_read_only(self):
        # The old guide said exactly that, and it was not true.
        assert "nothing in this setup can create" not in pm.note()


class TestManifest:
    def test_it_returns_every_tier_in_order(self):
        m = pm.manifest("t", "c", "https://a")
        assert [t["key"] for t in m["tiers"]] == list(pm.TIER_ORDER)

    def test_it_carries_a_consent_url_when_it_can_build_one(self):
        assert pm.manifest("t", "c", "https://a")["consent_url"]

    def test_it_carries_no_consent_url_when_it_cannot(self):
        assert pm.manifest("", "", "")["consent_url"] is None

    def test_every_entry_explains_why_it_is_needed(self):
        m = pm.manifest()
        for tier in m["tiers"]:
            for entry in tier["azure_roles"] + tier["graph_permissions"]:
                assert entry["why"], entry["name"]
                assert entry["unlocks"], entry["name"]

    def test_every_entry_says_where_it_is_granted(self):
        m = pm.manifest()
        for tier in m["tiers"]:
            for entry in tier["azure_roles"] + tier["graph_permissions"]:
                assert entry["scope_label"], entry["name"]

    def test_no_tier_is_empty(self):
        for tier in pm.manifest()["tiers"]:
            assert tier["azure_roles"] or tier["graph_permissions"]

    def test_it_is_not_specific_to_any_one_organisation(self):
        # This is rendered to every customer. Nothing about whoever happens to
        # host the instance may appear in it.
        text = str(pm.manifest())
        assert "foetron" not in text.lower()
        assert "99602a89" not in text
