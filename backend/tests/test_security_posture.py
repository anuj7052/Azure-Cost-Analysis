"""
Tests for Advisor / Defender / Policy normalisation and change tracking.

The load-bearing guard in this module is snapshot key stability. An unstable key
reports the entire estate as resolved and immediately recreated on every scan —
a perfect score and a total regression on the same screen — which is strictly
worse than showing no history at all.
"""
from services import security_posture as sp

SUB = "11111111-1111-1111-1111-111111111111"
VM = f"/subscriptions/{SUB}/resourceGroups/rg-web/providers/Microsoft.Compute/virtualMachines/web01"


def advisor_raw(rec_type="right-size", resource=VM, impact="High", category="Cost", saving=None):
    props = {
        "category": category,
        "impact": impact,
        "recommendationTypeId": rec_type,
        "shortDescription": {"problem": "Right-size this VM", "solution": "Resize to D2s_v5"},
        "resourceMetadata": {"resourceId": resource},
        "lastUpdated": "2026-08-14T00:00:00Z",
    }
    if saving is not None:
        props["extendedProperties"] = {"annualSavingsAmount": saving, "savingsCurrency": "INR"}
    # Azure reissues this id on every re-evaluation; nothing may depend on it.
    return {"id": f"/x/{rec_type}/{id(props)}", "name": "rec", "properties": props}


def assessment_raw(name="mfa", resource=VM, status="Unhealthy", severity="High"):
    return {
        "id": f"{resource}/providers/Microsoft.Security/assessments/{name}",
        "name": name,
        "properties": {
            "displayName": "Enable MFA",
            "status": {"code": status, "cause": "", "description": "MFA is off"},
            "resourceDetails": {"Id": resource},
            "metadata": {
                "severity": severity,
                "categories": ["IdentityAndAccess"],
                "remediationDescription": "Turn on MFA",
            },
        },
    }


def policy_state_raw(definition="require-tags", resource=VM, compliant=False):
    return {
        "policyDefinitionName": definition,
        "policyDefinitionId": f"/providers/Microsoft.Authorization/policyDefinitions/{definition}",
        "policyAssignmentName": "baseline",
        "policyAssignmentId": "/subscriptions/x/providers/Microsoft.Authorization/policyAssignments/baseline",
        "resourceId": resource,
        "resourceType": "Microsoft.Compute/virtualMachines",
        "subscriptionId": SUB,
        "complianceState": "Compliant" if compliant else "NonCompliant",
        "timestamp": "2026-08-14T00:00:00Z",
    }


class TestAdvisor:
    def test_impact_becomes_severity(self):
        assert sp.normalise_advisor(advisor_raw(impact="High"))["severity"] == "high"
        assert sp.normalise_advisor(advisor_raw(impact="Low"))["severity"] == "low"

    def test_key_ignores_the_reissued_record_id(self):
        """The identity is what the advice is about, not the record Azure minted."""
        first = sp.normalise_advisor(advisor_raw())
        second = sp.normalise_advisor(advisor_raw())
        assert first["id"] != second["id"]
        assert first["key"] == second["key"]

    def test_different_resources_are_different_findings(self):
        other = VM.replace("web01", "web02")
        assert sp.normalise_advisor(advisor_raw())["key"] != \
            sp.normalise_advisor(advisor_raw(resource=other))["key"]

    def test_subscription_is_read_from_the_resource_id(self):
        assert sp.normalise_advisor(advisor_raw())["subscription_id"] == SUB

    def test_saving_is_none_when_advisor_did_not_supply_one(self):
        """A zero here would make the estate total look like a measured figure."""
        assert sp.normalise_advisor(advisor_raw())["annual_saving"] is None

    def test_saving_is_carried_when_present(self):
        item = sp.normalise_advisor(advisor_raw(saving=1234.567))
        assert item["annual_saving"] == 1234.57
        assert item["currency"] == "INR"


class TestDefender:
    def test_assessment_key_pairs_the_check_with_the_resource(self):
        first = sp.normalise_assessment(assessment_raw())
        second = sp.normalise_assessment(assessment_raw(resource=VM.replace("web01", "web02")))
        assert first["key"] != second["key"]

    def test_assessment_key_is_stable_across_readings(self):
        assert sp.normalise_assessment(assessment_raw())["key"] == \
            sp.normalise_assessment(assessment_raw())["key"]

    def test_severity_comes_from_metadata(self):
        assert sp.normalise_assessment(assessment_raw(severity="Medium"))["severity"] == "medium"

    def test_remediation_is_kept(self):
        assert sp.normalise_assessment(assessment_raw())["solution"] == "Turn on MFA"

    def test_alerts_and_assessments_are_different_kinds(self):
        alert = sp.normalise_alert({
            "id": f"/subscriptions/{SUB}/providers/Microsoft.Security/alerts/a1",
            "name": "a1",
            "properties": {
                "alertDisplayName": "Suspicious sign-in",
                "severity": "High",
                "status": "Active",
                "systemAlertId": "a1",
                "compromisedEntity": VM,
            },
        })
        assert alert["kind"] == "alert"
        assert sp.normalise_assessment(assessment_raw())["kind"] == "assessment"


class TestPolicy:
    def test_state_key_is_the_policy_and_the_resource_together(self):
        """Neither alone identifies a finding."""
        a = sp.normalise_policy_state(policy_state_raw(definition="require-tags"))
        b = sp.normalise_policy_state(policy_state_raw(definition="require-encryption"))
        c = sp.normalise_policy_state(policy_state_raw(resource=VM.replace("web01", "web02")))
        assert len({a["key"], b["key"], c["key"]}) == 3

    def test_compliant_state_is_marked(self):
        assert sp.normalise_policy_state(policy_state_raw(compliant=True))["is_compliant"] is True
        assert sp.normalise_policy_state(policy_state_raw())["is_compliant"] is False

    def test_do_not_enforce_assignment_is_reported_as_unenforced(self):
        """A policy that reports and blocks nothing looks like governance and is not."""
        raw = {"id": "/a", "name": "a", "properties": {"enforcementMode": "DoNotEnforce"}}
        assert sp.normalise_policy_assignment(raw)["enforced"] is False

    def test_default_enforcement_is_enforced(self):
        raw = {"id": "/a", "name": "a", "properties": {}}
        assert sp.normalise_policy_assignment(raw)["enforced"] is True

    def test_exemption_days_remaining_is_computed(self):
        raw = {"id": "/e", "name": "e", "properties": {"expiresOn": "2026-09-01T00:00:00Z"}}
        item = sp.normalise_exemption(raw, now_iso="2026-08-14T00:00:00Z")
        assert item["days_remaining"] == 18

    def test_expired_exemption_has_negative_days(self):
        raw = {"id": "/e", "name": "e", "properties": {"expiresOn": "2026-08-01T00:00:00Z"}}
        assert sp.normalise_exemption(raw, now_iso="2026-08-14T00:00:00Z")["days_remaining"] < 0

    def test_exemption_without_expiry_has_no_number(self):
        raw = {"id": "/e", "name": "e", "properties": {}}
        assert sp.normalise_exemption(raw, now_iso="2026-08-14T00:00:00Z")["days_remaining"] is None

    def test_already_expired_exemptions_are_included_in_expiring_soon(self):
        """One that lapsed last week is not history — nobody was told."""
        items = [
            {"days_remaining": -5, "name": "gone"},
            {"days_remaining": 10, "name": "soon"},
            {"days_remaining": 200, "name": "later"},
            {"days_remaining": None, "name": "never"},
        ]
        soon = sp.expiring_soon(items, within_days=30)
        assert [i["name"] for i in soon] == ["gone", "soon"]


class TestDiff:
    def test_new_and_resolved_are_separated(self):
        before = [{"key": "a", "title": "a"}, {"key": "b", "title": "b"}]
        after = [{"key": "b", "title": "b"}, {"key": "c", "title": "c"}]
        diff = sp.diff_findings(before, after)
        assert [f["key"] for f in diff["new"]] == ["c"]
        assert [f["key"] for f in diff["resolved"]] == ["a"]
        assert [f["key"] for f in diff["persisting"]] == ["b"]

    def test_identical_snapshots_report_no_change(self):
        items = [{"key": "a", "title": "a"}]
        diff = sp.diff_findings(items, items)
        assert diff["new_count"] == 0 and diff["resolved_count"] == 0
        assert "Nothing changed" in diff["verdict"]

    def test_findings_without_a_key_are_ignored_not_counted(self):
        diff = sp.diff_findings([], [{"title": "no key"}])
        assert diff["new_count"] == 0

    def test_first_snapshot_makes_everything_new(self):
        diff = sp.diff_findings([], [{"key": "a"}, {"key": "b"}])
        assert diff["new_count"] == 2

    def test_a_reduction_is_not_congratulated(self):
        """A count falling also happens when read access is lost."""
        diff = sp.diff_findings([{"key": "a"}, {"key": "b"}], [{"key": "a"}])
        assert "no longer visible" in diff["verdict"]

    def test_growth_offers_the_benign_explanation(self):
        diff = sp.diff_findings([{"key": "a"}], [{"key": "a"}, {"key": "b"}])
        assert "New resources arrive non-compliant" in diff["verdict"]

    def test_equal_churn_is_described_as_keeping_pace(self):
        diff = sp.diff_findings([{"key": "a"}], [{"key": "b"}])
        assert "keeping pace" in diff["verdict"]

    def test_change_marker_is_attached_to_every_finding(self):
        diff = sp.diff_findings([{"key": "a"}], [{"key": "a"}, {"key": "b"}])
        assert diff["persisting"][0]["change"] == sp.PERSISTING
        assert diff["new"][0]["change"] == sp.NEW

    def test_resolved_findings_come_from_the_earlier_snapshot(self):
        """They no longer exist in the later one, so there is nowhere else."""
        diff = sp.diff_findings([{"key": "a", "title": "old wording"}], [])
        assert diff["resolved"][0]["title"] == "old wording"


class TestSummaryAndRoundTrip:
    def test_counts_group_by_severity_category_and_subscription(self):
        findings = [
            {"severity": "high", "category": "Cost", "subscription_id": SUB},
            {"severity": "low", "category": "Cost", "subscription_id": SUB},
            {"severity": "high", "category": "Security", "subscription_id": "other"},
        ]
        summary = sp.summarise(findings)
        assert summary["total"] == 3
        assert summary["high_count"] == 2
        assert summary["by_category"]["Cost"] == 2
        assert summary["by_subscription"]["other"] == 1

    def test_savings_only_total_what_was_actually_reported(self):
        summary = sp.summarise([{"annual_saving": 10.0}, {"annual_saving": None}])
        assert summary["annual_saving"] == 10.0

    def test_sort_puts_high_severity_first(self):
        rows = sp.sort_findings([
            {"severity": "low", "title": "a"},
            {"severity": "high", "title": "z"},
        ])
        assert rows[0]["title"] == "z"

    def test_pack_and_unpack_round_trip(self):
        findings = [{"key": "a", "title": "x"}]
        assert sp.unpack(sp.pack(findings)) == findings

    def test_corrupt_snapshot_costs_the_comparison_not_the_page(self):
        assert sp.unpack("{not json") == []
        assert sp.unpack(None) == []
        assert sp.unpack('{"a": 1}') == []
