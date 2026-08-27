"""
Coverage reporting.

This exists to stop a partial total being read as a complete one. The failure
it prevents is quiet and expensive: somebody reconciles a figure against an
invoice, finds a shortfall, and either stops trusting the tool or reports the
wrong number.
"""
from services.coverage import build_coverage, describe, empty_coverage


def failure(sub_id: str, reason: str = "Azure rate limit reached") -> dict:
    return {"subscription_id": sub_id, "error": reason}


class TestBuildCoverage:
    def test_a_clean_read_is_not_partial(self):
        coverage = build_coverage(["s1", "s2", "s3"], [])

        assert coverage["partial"] is False
        assert coverage["succeeded_subscriptions"] == 3
        assert coverage["failed_subscriptions"] == []

    def test_one_failure_makes_the_whole_result_partial(self):
        """
        Two of three subscriptions is still a number, and it still looks like
        an answer. It is only the answer for the two that responded.
        """
        coverage = build_coverage(["s1", "s2", "s3"], [failure("s2")])

        assert coverage["partial"] is True
        assert coverage["succeeded_subscriptions"] == 2
        assert coverage["failed_subscriptions"] == ["s2"]

    def test_the_reason_survives_for_inspection(self):
        # Throttling and a missing role need completely different responses,
        # so the specific reason has to reach the user.
        coverage = build_coverage(["s1"], [failure("s1", "Cost Management Reader missing")])

        assert coverage["errors"][0]["error"] == "Cost Management Reader missing"

    def test_every_subscription_failing_is_still_reported_as_partial(self):
        coverage = build_coverage(["s1", "s2"], [failure("s1"), failure("s2")])

        assert coverage["partial"] is True
        assert coverage["succeeded_subscriptions"] == 0

    def test_the_timestamp_carries_a_zone(self):
        """
        A naive timestamp is read as local time by the browser, putting
        "updated at" hours out without anything looking wrong.
        """
        fetched = build_coverage(["s1"], [])["fetched_at"]

        assert fetched.endswith("+00:00") or fetched.endswith("Z")

    def test_the_source_is_named_so_a_figure_can_be_traced(self):
        coverage = build_coverage(["s1"], [], source="Azure Resource Graph")
        assert coverage["source"] == "Azure Resource Graph"

    def test_a_failure_without_a_subscription_id_does_not_invent_one(self):
        # Counting an unattributable error against a named subscription would
        # send someone to check the wrong one.
        coverage = build_coverage(["s1"], [{"error": "unknown failure"}])

        assert coverage["failed_subscriptions"] == []
        assert coverage["errors"][0]["error"] == "unknown failure"


class TestDescribe:
    def test_a_complete_read_says_so_plainly(self):
        assert describe(build_coverage(["s1", "s2"], [])) == "Complete — 2 of 2 subscriptions."

    def test_a_partial_read_leads_with_the_word_partial(self):
        text = describe(build_coverage(["s1", "s2", "s3"], [failure("s3")]))

        assert text.startswith("Partial data")
        assert "1 of 3" in text

    def test_the_plural_matches_the_count(self):
        text = describe(build_coverage(["s1", "s2", "s3"], [failure("s2"), failure("s3")]))
        assert "2 of 3 subscriptions" in text

    def test_missing_coverage_produces_no_claim(self):
        # An absent coverage is unknown, and a confident sentence about an
        # unknown state is exactly the lie this module prevents.
        assert describe(None) == ""


class TestEmptyCoverage:
    def test_a_non_azure_source_is_complete_for_what_it_is(self):
        """
        An uploaded file is a complete answer for that file. Reporting it as
        unknown would be as misleading as reporting a partial read as whole.
        """
        coverage = empty_coverage(source="Imported file")

        assert coverage["partial"] is False
        assert coverage["source"] == "Imported file"
