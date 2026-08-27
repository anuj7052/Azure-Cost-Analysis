"""
Tests for RBAC auditing and access optimisation.

The guard that matters most here is not correctness of counting — it is that
this feature never asserts something is unused when it merely has no evidence.
Every finding recommends revoking somebody's access, and a false positive
acted on is somebody's job stopping.
"""
from services import access_review as ar

SUB_A = "11111111-1111-1111-1111-111111111111"
SUB_B = "22222222-2222-2222-2222-222222222222"


def assignment(
    principal="alice@contoso.com",
    principal_id="p-alice",
    role="Reader",
    scope=None,
    principal_type="User",
):
    """One raw assignment as the ARM API returns it."""
    return {
        "id": f"{scope or f'/subscriptions/{SUB_A}'}/providers/Microsoft.Authorization/roleAssignments/x",
        "properties": {
            "principalId": principal_id,
            "principalName": principal,
            "principalType": principal_type,
            "roleDefinitionName": role,
            "roleDefinitionId": f"/providers/Microsoft.Authorization/roleDefinitions/{role.lower()}",
            "scope": scope or f"/subscriptions/{SUB_A}",
        },
    }


def norm(**kwargs):
    return ar.normalise_assignment(assignment(**kwargs))


def event(caller="alice@contoso.com", operation="Microsoft.Compute/virtualMachines/read",
          at="2026-08-14T10:00:00Z", subscription_id=SUB_A, is_write=False):
    return {
        "caller": caller,
        "operation": operation,
        "at": at,
        "subscription_id": subscription_id,
        "resource_id": f"/subscriptions/{subscription_id}/resourceGroups/rg/providers/x/y",
        "is_write": is_write,
    }


class TestScopeAndRole:
    def test_scope_kind_distinguishes_every_level(self):
        """Breadth is the most important property of a grant and is not a field."""
        assert ar.scope_kind("/") == "tenant root"
        assert ar.scope_kind(
            "/providers/Microsoft.Management/managementGroups/root"
        ) == "management group"
        assert ar.scope_kind(f"/subscriptions/{SUB_A}") == "subscription"
        assert ar.scope_kind(f"/subscriptions/{SUB_A}/resourceGroups/rg") == "resource group"
        assert ar.scope_kind(
            f"/subscriptions/{SUB_A}/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm1"
        ) == "resource"

    def test_owner_and_uaa_are_critical(self):
        assert ar.classify_role("Owner") == ar.CRITICAL
        assert ar.classify_role("User Access Administrator") == ar.CRITICAL

    def test_reader_is_read(self):
        assert ar.classify_role("Reader") == ar.READ
        assert ar.classify_role("Storage Blob Data Reader") == ar.READ

    def test_scoped_contributor_is_management_not_critical(self):
        """Only bare Contributor is estate-wide; a scoped one cannot grant access."""
        assert ar.classify_role("Log Analytics Contributor") == ar.MANAGEMENT
        assert ar.classify_role("Network Contributor") == ar.MANAGEMENT
        assert ar.classify_role("Contributor") == ar.CRITICAL

    def test_unknown_role_defaults_to_management_not_read(self):
        """Guessing 'read' for an unrecognised custom role understates risk."""
        assert ar.classify_role("Bespoke Widget Role") == ar.MANAGEMENT

    def test_principal_type_is_normalised(self):
        assert ar.principal_kind("ServicePrincipal") == "Service principal"
        assert ar.principal_kind("Group") == "Group"
        assert ar.principal_kind("User") == "User"

    def test_subscription_extracted_case_insensitively(self):
        assert ar.subscription_of(f"/SUBSCRIPTIONS/{SUB_A}/resourceGroups/rg") == SUB_A

    def test_management_group_scope_has_no_subscription(self):
        item = norm(scope="/providers/Microsoft.Management/managementGroups/root")
        assert item["subscription_id"] == ""


class TestNormalisation:
    def test_role_name_resolved_from_definition_lookup(self):
        """Assignments carry a GUID; a review showing GUIDs is never completed."""
        raw = {
            "id": "/x",
            "properties": {
                "principalId": "p1",
                "roleDefinitionId": "/providers/Microsoft.Authorization/roleDefinitions/ABC",
                "scope": f"/subscriptions/{SUB_A}",
            },
        }
        item = ar.normalise_assignment(raw, role_names={"abc": "Owner"})
        assert item["role_name"] == "Owner"
        assert item["privilege"] == ar.CRITICAL

    def test_unresolved_principal_is_flagged_not_faked(self):
        raw = {"id": "/x", "properties": {"principalId": "p1", "scope": f"/subscriptions/{SUB_A}"}}
        item = ar.normalise_assignment(raw)
        assert item["resolved"] is False
        # The object id is kept, but it is not offered as a name. Using it as
        # one produced headlines like "265b1023-... has not used Owner", which
        # reads as though the GUID were a colleague.
        assert item["principal_name"] == "Name unavailable"
        assert item["principal_id"] == "p1"

    def test_unresolved_principal_is_named_by_its_type_where_known(self):
        raw = {
            "id": "/x",
            "properties": {
                "principalId": "p1",
                "principalType": "ServicePrincipal",
                "scope": f"/subscriptions/{SUB_A}",
            },
        }
        item = ar.normalise_assignment(raw)
        assert item["principal_name"] == "Name unavailable"

    def test_subscription_name_is_used_where_it_is_known(self):
        raw = {"id": "/x", "properties": {"principalId": "p1", "scope": f"/subscriptions/{SUB_A}"}}
        item = ar.normalise_assignment(
            raw, subscription_names={SUB_A: "Kredily Production"}
        )
        assert item["subscription_name"] == "Kredily Production"
        assert item["scope_label"] == "Kredily Production"
        # The id survives alongside the name, because operations act on it.
        assert item["subscription_id"] == SUB_A

    def test_unknown_subscription_is_not_shown_as_a_guid(self):
        raw = {"id": "/x", "properties": {"principalId": "p1", "scope": f"/subscriptions/{SUB_A}"}}
        item = ar.normalise_assignment(raw)
        assert item["scope_label"] == "Unnamed subscription"
        assert SUB_A not in item["scope_label"]


class TestPrincipalView:
    def test_assignments_are_regrouped_by_principal(self):
        items = [
            norm(role="Reader"),
            norm(role="Contributor", scope=f"/subscriptions/{SUB_B}"),
            norm(principal="bob@contoso.com", principal_id="p-bob"),
        ]
        view = ar.build_principal_view(items)
        assert view["totals"]["principal_count"] == 2
        alice = next(p for p in view["principals"] if p["principal_id"] == "p-alice")
        assert alice["assignment_count"] == 2
        assert alice["subscription_count"] == 2

    def test_top_privilege_is_the_widest_grant_not_the_average(self):
        """One Owner and forty Readers is an Owner."""
        items = [norm(role="Reader") for _ in range(40)] + [norm(role="Owner")]
        view = ar.build_principal_view(items)
        assert view["principals"][0]["top_privilege"] == ar.CRITICAL

    def test_widest_scope_is_reported(self):
        items = [
            norm(scope=f"/subscriptions/{SUB_A}/resourceGroups/rg"),
            norm(scope=f"/subscriptions/{SUB_A}"),
        ]
        view = ar.build_principal_view(items)
        assert view["principals"][0]["widest_scope"] == "subscription"

    def test_empty_input_is_safe(self):
        view = ar.build_principal_view([])
        assert view["principals"] == []
        assert view["totals"]["principal_count"] == 0


class TestUsageEvidence:
    def test_activity_is_indexed_by_caller(self):
        index = ar.index_activity([event(), event(operation="x/write", is_write=True)])
        entry = index["alice@contoso.com"]
        assert entry["count"] == 2
        assert entry["write_count"] == 1

    def test_rbac_operations_are_counted_separately(self):
        index = ar.index_activity([
            event(operation="Microsoft.Authorization/roleAssignments/write", is_write=True),
        ])
        assert index["alice@contoso.com"]["rbac_count"] == 1

    def test_caller_matching_is_case_insensitive(self):
        """A case mismatch would report an active user as unused."""
        index = ar.index_activity([event(caller="ALICE@Contoso.com")])
        assert "alice@contoso.com" in index

    def test_latest_timestamp_wins(self):
        index = ar.index_activity([
            event(at="2026-08-01T00:00:00Z"),
            event(at="2026-08-20T00:00:00Z"),
        ])
        assert index["alice@contoso.com"]["last_at"].startswith("2026-08-20")


class TestReview:
    def test_nothing_is_called_unused_without_evidence(self):
        """The single most important guard in this module."""
        review = ar.review_access([norm(role="Owner")], events=[])
        kinds = {f["kind"] for f in review["findings"]}
        assert ar.UNUSED not in kinds
        assert ar.STALE not in kinds
        assert review["evidence"]["available"] is False
        assert "not based on usage" in review["evidence"]["note"] or \
               "nothing here is based on usage" in review["evidence"]["note"]

    def test_unused_requires_zero_activity(self):
        review = ar.review_access(
            [norm(role="Reader"), norm(principal="bob@contoso.com", principal_id="p-bob")],
            events=[event(caller="alice@contoso.com")],
        )
        unused = [f for f in review["findings"] if f["kind"] == ar.UNUSED]
        assert len(unused) == 1
        assert unused[0]["principal_id"] == "p-bob"

    def test_unused_critical_role_is_high_severity(self):
        review = ar.review_access(
            [norm(role="Owner", principal_id="p-ghost", principal="ghost")],
            events=[event()],
        )
        unused = [f for f in review["findings"] if f["kind"] == ar.UNUSED]
        assert unused[0]["severity"] == "high"

    def test_unused_finding_states_its_own_false_positive_mode(self):
        review = ar.review_access(
            [norm(principal_id="p-ghost", principal="ghost")], events=[event()]
        )
        unused = [f for f in review["findings"] if f["kind"] == ar.UNUSED][0]
        assert "confirm the requirement before removing it" in unused["detail"]

    def test_stale_uses_the_configured_threshold(self):
        review = ar.review_access(
            [norm()],
            events=[event(at="2026-06-01T00:00:00Z")],
            stale_days=14,
            now_iso="2026-08-14T00:00:00Z",
        )
        stale = [f for f in review["findings"] if f["kind"] == ar.STALE]
        assert stale and stale[0]["headline"].endswith("days ago")

    def test_recent_activity_is_not_stale(self):
        review = ar.review_access(
            [norm()],
            events=[event(at="2026-08-13T00:00:00Z")],
            stale_days=14,
            now_iso="2026-08-14T00:00:00Z",
        )
        assert not [f for f in review["findings"] if f["kind"] == ar.STALE]

    def test_owner_who_never_grants_access_is_over_privileged(self):
        review = ar.review_access([norm(role="Owner")], events=[event()])
        over = [f for f in review["findings"] if f["kind"] == ar.OVER_PRIVILEGED]
        assert over and over[0]["severity"] == "high"

    def test_owner_who_does_grant_access_is_not_flagged(self):
        review = ar.review_access(
            [norm(role="Owner")],
            events=[event(operation="Microsoft.Authorization/roleAssignments/write", is_write=True)],
        )
        assert not [f for f in review["findings"] if f["kind"] == ar.OVER_PRIVILEGED]

    def test_reader_is_never_over_privileged(self):
        """Over-privilege here means holding the power to grant and not using it."""
        review = ar.review_access([norm(role="Reader")], events=[event()])
        assert not [f for f in review["findings"] if f["kind"] == ar.OVER_PRIVILEGED]

    def test_activity_only_elsewhere_is_over_scoped(self):
        review = ar.review_access(
            [norm(scope=f"/subscriptions/{SUB_A}")],
            events=[event(subscription_id=SUB_B)],
        )
        scoped = [f for f in review["findings"] if f["kind"] == ar.OVER_SCOPED]
        assert scoped

    def test_activity_in_the_assigned_subscription_is_not_over_scoped(self):
        review = ar.review_access(
            [norm(scope=f"/subscriptions/{SUB_A}")],
            events=[event(subscription_id=SUB_A)],
        )
        assert not [f for f in review["findings"] if f["kind"] == ar.OVER_SCOPED]

    def test_window_is_carried_into_every_finding(self):
        """Unused over 7 days and unused over 90 are different claims."""
        review = ar.review_access(
            [norm(principal_id="p-ghost", principal="ghost")], events=[event()], window_days=7
        )
        usage = [f for f in review["findings"] if f["kind"] == ar.UNUSED]
        assert usage[0]["window_days"] == 7

    def test_evidence_note_names_the_ninety_day_ceiling(self):
        review = ar.review_access([norm()], events=[event()], window_days=90)
        assert "90 days" in review["evidence"]["note"]


class TestSprawl:
    def test_same_role_across_three_subscriptions_is_sprawl(self):
        items = [
            norm(scope=f"/subscriptions/sub-{i}") for i in range(3)
        ]
        review = ar.review_access(items)
        sprawl = [f for f in review["findings"] if f["kind"] == ar.SPRAWL]
        assert sprawl and sprawl[0]["evidence"] == "3 subscriptions"

    def test_two_subscriptions_is_not_yet_sprawl(self):
        items = [norm(scope=f"/subscriptions/sub-{i}") for i in range(2)]
        review = ar.review_access(items)
        assert not [f for f in review["findings"] if f["kind"] == ar.SPRAWL]

    def test_different_roles_do_not_aggregate_into_sprawl(self):
        items = [
            norm(role=r, scope=f"/subscriptions/sub-{i}")
            for i, r in enumerate(["Reader", "Contributor", "Owner"])
        ]
        review = ar.review_access(items)
        assert not [f for f in review["findings"] if f["kind"] == ar.SPRAWL]

    def test_critical_sprawl_is_high_severity(self):
        items = [norm(role="Owner", scope=f"/subscriptions/sub-{i}") for i in range(4)]
        review = ar.review_access(items)
        sprawl = [f for f in review["findings"] if f["kind"] == ar.SPRAWL][0]
        assert sprawl["severity"] == "high"


class TestRedundancy:
    def test_narrower_duplicate_of_the_same_role_is_redundant(self):
        items = [
            norm(scope=f"/subscriptions/{SUB_A}"),
            norm(scope=f"/subscriptions/{SUB_A}/resourceGroups/rg"),
        ]
        review = ar.review_access(items)
        redundant = [f for f in review["findings"] if f["kind"] == ar.REDUNDANT]
        assert len(redundant) == 1
        assert redundant[0]["scope_kind"] == "resource group"

    def test_broader_assignment_is_not_itself_flagged(self):
        items = [
            norm(scope=f"/subscriptions/{SUB_A}"),
            norm(scope=f"/subscriptions/{SUB_A}/resourceGroups/rg"),
        ]
        review = ar.review_access(items)
        redundant = [f for f in review["findings"] if f["kind"] == ar.REDUNDANT]
        assert redundant[0]["scope"].endswith("/rg")

    def test_inheritance_does_not_cross_subscriptions(self):
        """Two subscriptions are unrelated however broad either grant is."""
        items = [
            norm(scope=f"/subscriptions/{SUB_A}"),
            norm(scope=f"/subscriptions/{SUB_B}/resourceGroups/rg"),
        ]
        review = ar.review_access(items)
        assert not [f for f in review["findings"] if f["kind"] == ar.REDUNDANT]

    def test_different_roles_at_different_scopes_are_not_redundant(self):
        items = [
            norm(role="Reader", scope=f"/subscriptions/{SUB_A}"),
            norm(role="Contributor", scope=f"/subscriptions/{SUB_A}/resourceGroups/rg"),
        ]
        review = ar.review_access(items)
        assert not [f for f in review["findings"] if f["kind"] == ar.REDUNDANT]

    def test_redundant_finding_says_removing_it_changes_nothing(self):
        items = [
            norm(scope=f"/subscriptions/{SUB_A}"),
            norm(scope=f"/subscriptions/{SUB_A}/resourceGroups/rg"),
        ]
        review = ar.review_access(items)
        redundant = [f for f in review["findings"] if f["kind"] == ar.REDUNDANT][0]
        assert "changes no one's effective access" in redundant["detail"]


class TestOrdering:
    def test_high_severity_findings_come_first(self):
        items = [
            norm(scope=f"/subscriptions/{SUB_A}"),
            norm(scope=f"/subscriptions/{SUB_A}/resourceGroups/rg"),
            norm(role="Owner", principal_id="p-ghost", principal="ghost"),
        ]
        review = ar.review_access(items, events=[event()])
        assert review["findings"][0]["severity"] == "high"

    def test_totals_count_every_kind(self):
        review = ar.review_access([norm(role="Owner")], events=[event()])
        assert review["totals"]["finding_count"] == len(review["findings"])
        assert sum(review["totals"]["by_kind"].values()) == len(review["findings"])


class TestRightSizing:
    """
    The "why does a reader hold Owner?" question.

    The safety property under test is asymmetry: the module may confidently
    recommend a *smaller* role when it has seen the work, but must never turn
    silence into a removal instruction.
    """

    def test_granted_tier_maps_classification_to_ladder(self):
        assert ar.granted_tier(ar.CRITICAL) == ar.TIER_GRANT
        assert ar.granted_tier(ar.MANAGEMENT) == ar.TIER_WRITE
        assert ar.granted_tier(ar.READ) == ar.TIER_READ

    def test_observed_tier_takes_the_highest_rung_seen(self):
        assert ar.observed_tier(None) == ar.TIER_NONE
        assert ar.observed_tier({"count": 0}) == ar.TIER_NONE
        assert ar.observed_tier({"count": 5}) == ar.TIER_READ
        assert ar.observed_tier({"count": 5, "write_count": 2}) == ar.TIER_WRITE
        assert ar.observed_tier({"count": 5, "write_count": 2, "rbac_count": 1}) == ar.TIER_GRANT

    def test_owner_who_only_reads_is_told_to_use_reader(self):
        item = norm(role="Owner")
        usage = {"count": 40, "write_count": 0, "rbac_count": 0}
        rec = ar.recommend_role(item, usage)
        assert rec["action"] == ar.DOWNGRADE
        assert rec["recommended_role"] == "Reader"
        assert "Owner" in rec["reason"]

    def test_owner_who_writes_but_never_grants_is_told_to_use_contributor(self):
        item = norm(role="Owner")
        usage = {"count": 40, "write_count": 12, "rbac_count": 0}
        rec = ar.recommend_role(item, usage)
        assert rec["action"] == ar.DOWNGRADE
        assert rec["recommended_role"] == "Contributor"
        assert rec["confidence"] == "high"

    def test_owner_who_grants_access_keeps_the_role(self):
        item = norm(role="Owner")
        usage = {"count": 40, "write_count": 12, "rbac_count": 3}
        rec = ar.recommend_role(item, usage)
        assert rec["action"] == ar.KEEP

    def test_reader_who_only_reads_keeps_the_role(self):
        """Right-sizing must confirm correct grants, not only flag bad ones."""
        item = norm(role="Reader")
        rec = ar.recommend_role(item, {"count": 9, "write_count": 0, "rbac_count": 0})
        assert rec["action"] == ar.KEEP

    def test_silence_is_review_never_remove(self):
        """No recorded operations is a question. Reads are not reliably logged."""
        rec = ar.recommend_role(norm(role="Owner"), None)
        assert rec["action"] == ar.REVIEW
        assert rec["action"] != ar.REMOVE
        assert rec["confidence"] == "low"
        assert "not proof" in rec["reason"]

    def test_no_activity_log_at_all_yields_no_confidence(self):
        rec = ar.recommend_role(norm(role="Owner"), None, has_evidence=False)
        assert rec["action"] == ar.REVIEW
        assert rec["confidence"] == "none"
        assert rec["recommended_role"] == ""

    def test_custom_roles_are_never_right_sized(self):
        """A custom role's tier came from its name, which proves nothing."""
        item = norm(role="Reader")
        item["is_custom"] = True
        rec = ar.recommend_role(item, {"count": 5, "write_count": 0, "rbac_count": 0})
        assert rec["action"] == ar.REVIEW
        assert rec["recommended_role"] == ""
        assert "custom role" in rec["reason"]

    def test_review_access_exposes_recommendations_for_every_assignment(self):
        items = [norm(role="Owner"), norm(role="Reader", principal="bob@contoso.com")]
        result = ar.review_access(items, [event(is_write=True)])
        sizing = result["right_sizing"]
        assert len(sizing["recommendations"]) == len(items)
        assert sizing["totals"]["total"] == 2

    def test_downgrades_are_listed_before_healthy_grants(self):
        items = [norm(role="Reader"), norm(role="Owner")]
        result = ar.review_access(items, [event()])
        actions = [r["action"] for r in result["right_sizing"]["recommendations"]]
        assert actions[0] == ar.DOWNGRADE

    def test_excess_grant_power_counts_only_downgraded_critical_roles(self):
        items = [norm(role="Owner"), norm(role="Reader", principal="bob@contoso.com")]
        result = ar.review_access(items, [event()])
        assert result["right_sizing"]["totals"]["excess_grant_power"] == 1

    def test_right_sizing_note_states_the_activity_log_blind_spot(self):
        result = ar.review_access([norm()], [event()])
        note = result["right_sizing"]["note"]
        assert "data-plane" in note


class TestFriendlyFieldsOnEveryFinding:
    """
    Every finding kind must carry the readable fields, not just the usage ones.

    This is a regression test for a defect found against live Azure: the
    redundancy and sprawl cards rendered "Where: Not available" while the unused
    and stale cards named the subscription correctly, because each builder
    assembled its own subset of fields by hand.
    """

    def _review(self):
        # Three subscriptions, because sprawl is only reported past a
        # threshold of three -- two would test the wrong branch.
        sub_c = "33333333-3333-3333-3333-333333333333"
        sub_names = {
            SUB_A: "Kredily Production",
            SUB_B: "Tally Group",
            sub_c: "Millienium Semiconductors",
        }
        assignments = []
        # Two subscription-level Owner grants plus a redundant one beneath,
        # which between them trigger sprawl and redundancy.
        for sub in (SUB_A, SUB_B, sub_c):
            assignments.append(ar.normalise_assignment(
                {
                    "id": f"/a-{sub}",
                    "properties": {
                        "principalId": "p1",
                        "principalType": "User",
                        "principalName": "Anuj Singh",
                        "roleDefinitionName": "Owner",
                        "scope": f"/subscriptions/{sub}",
                    },
                },
                subscription_names=sub_names,
            ))
        assignments.append(ar.normalise_assignment(
            {
                "id": "/a-nested",
                "properties": {
                    "principalId": "p1",
                    "principalType": "User",
                    "principalName": "Anuj Singh",
                    "roleDefinitionName": "Owner",
                    "scope": f"/subscriptions/{SUB_A}/resourceGroups/rg-prod",
                },
            },
            subscription_names=sub_names,
        ))
        return ar.review_access(assignments, events=[event()])

    def test_redundant_findings_say_where_they_apply(self):
        findings = [f for f in self._review()["findings"] if f["kind"] == ar.REDUNDANT]
        assert findings, "expected a redundant finding"
        for finding in findings:
            assert finding["scope_label"], "a redundant finding printed no location"
            assert finding["subscription_name"] == "Kredily Production"

    def test_sprawl_findings_say_where_they_apply(self):
        findings = [f for f in self._review()["findings"] if f["kind"] == ar.SPRAWL]
        assert findings, "expected a sprawl finding"
        for finding in findings:
            # Sprawl spans subscriptions, so it names the pattern rather than
            # one place -- but it must never be blank.
            assert finding["scope_label"] == "3 subscriptions"
            assert finding["scope_sentence"]

    def test_no_finding_prints_a_subscription_guid_as_its_location(self):
        for finding in self._review()["findings"]:
            assert SUB_A not in finding.get("scope_label", "")
            assert SUB_B not in finding.get("scope_label", "")

    def test_every_finding_carries_the_identifiers_operations_need(self):
        # Names are for reading; ids are for acting. Losing the id would make
        # the "Remove access" button on the card impossible to wire up.
        for finding in self._review()["findings"]:
            assert "principal_id" in finding
            assert "role_definition_id" in finding
            assert "assignment_id" in finding
