"""
Activity Log: who changed what.

This is the only source in the app that names an actor, so the damaging failure
is attributing a change to the wrong person — or presenting a read as a change,
which buries the writes that actually matter under thousands of list calls.
"""
from services.activity import (
    MAX_RETENTION_DAYS,
    caller_of,
    clamp_window,
    describe_operation,
    is_write,
    normalise,
    summarise_activity,
)


def entry(**overrides):
    base = {
        "eventDataId": "evt-1",
        "eventTimestamp": "2026-08-18T14:02:00Z",
        "caller": "anna@contoso.com",
        "operationName": {"localizedValue": "Microsoft.Compute/virtualMachines/write"},
        "status": {"localizedValue": "Succeeded"},
        "resourceId": "/subscriptions/s1/resourceGroups/rg-prod/providers/"
                      "Microsoft.Compute/virtualMachines/vm-api-01",
        "resourceGroupName": "rg-prod",
        "subscriptionId": "s1",
        "level": "Informational",
    }
    base.update(overrides)
    return base


class TestCaller:
    def test_a_person_is_named(self):
        assert caller_of(entry()) == "anna@contoso.com"

    def test_a_service_principal_keeps_its_id(self):
        """
        "An application did this" is a materially different answer to "we do
        not know", and the id is what identifies which application.
        """
        row = entry(caller="", claims={"appid": "8f14e45f-ceea-467a-9f6e-000000000000"})
        assert caller_of(row) == "8f14e45f-ceea-467a-9f6e-000000000000"

    def test_an_unattributable_change_says_unknown(self):
        # Guessing an actor here would be worse than admitting ignorance.
        assert caller_of(entry(caller="", claims={})) == "Unknown"


class TestWriteDetection:
    def test_a_write_is_a_change(self):
        assert is_write("Microsoft.Compute/virtualMachines/write") is True
        assert is_write("Microsoft.Compute/virtualMachines/delete") is True

    def test_a_read_is_not_a_change(self):
        """
        Reads outnumber writes by orders of magnitude. Counting them as changes
        buries the handful of entries anybody cares about.
        """
        assert is_write("Microsoft.Compute/virtualMachines/read") is False
        assert is_write("Microsoft.Resources/subscriptions/resourceGroups/read") is False

    def test_the_resource_type_does_not_decide_it(self):
        # "…/virtualMachines/read" contains the same type as the write; only
        # the final segment distinguishes them.
        assert is_write("Microsoft.Insights/eventtypes/values/read") is False


class TestOperationDescription:
    def test_an_operation_id_becomes_a_sentence(self):
        assert describe_operation("Microsoft.Compute/virtualMachines/write") == (
            "Created or updated virtual machine"
        )
        assert describe_operation("Microsoft.Compute/virtualMachines/delete") == (
            "Deleted virtual machine"
        )

    def test_plurals_are_not_mangled(self):
        # "addresse" and "policie" read as typos and undermine the sentence.
        assert "address" in describe_operation("Microsoft.Network/publicIPAddresses/write")
        assert "policy" in describe_operation("Microsoft.Authorization/policies/write")

    def test_an_empty_operation_is_labelled_not_blank(self):
        assert describe_operation("") == "Unknown operation"


class TestNormalise:
    def test_a_failed_attempt_is_marked_as_such(self):
        """
        A refused operation is not a change, but it is often the more
        interesting entry: somebody tried and was denied.
        """
        row = normalise(entry(status={"localizedValue": "Failed"}))
        assert row["succeeded"] is False
        assert row["status"] == "Failed"

    def test_the_resource_and_group_survive(self):
        row = normalise(entry())
        assert row["resource_group"] == "rg-prod"
        assert row["resource_id"].endswith("vm-api-01")


class TestSummary:
    def test_reads_are_excluded_by_default(self):
        events = [
            entry(),
            entry(operationName={"localizedValue": "Microsoft.Compute/virtualMachines/read"}),
        ]
        result = summarise_activity(events)

        assert result["total"] == 1
        assert result["events"][0]["is_write"] is True

    def test_reads_can_be_included_when_asked_for(self):
        events = [
            entry(),
            entry(operationName={"localizedValue": "Microsoft.Compute/virtualMachines/read"}),
        ]
        assert summarise_activity(events, writes_only=False)["total"] == 2

    def test_newest_first(self):
        events = [
            entry(eventDataId="old", eventTimestamp="2026-08-01T10:00:00Z"),
            entry(eventDataId="new", eventTimestamp="2026-08-18T10:00:00Z"),
        ]
        result = summarise_activity(events)
        assert [e["id"] for e in result["events"]] == ["new", "old"]

    def test_callers_are_ranked_by_how_much_they_changed(self):
        events = [
            entry(caller="anna@contoso.com"),
            entry(caller="anna@contoso.com"),
            entry(caller="bob@contoso.com"),
        ]
        result = summarise_activity(events)

        assert result["callers"][0] == {"caller": "anna@contoso.com", "count": 2}

    def test_failures_are_counted_separately(self):
        events = [entry(), entry(status={"localizedValue": "Failed"})]
        assert summarise_activity(events)["failed"] == 1

    def test_retention_is_reported_so_an_empty_window_can_be_explained(self):
        # Without this the UI cannot tell "nothing happened" apart from
        # "Azure no longer has the answer".
        assert summarise_activity([])["retention_days"] == MAX_RETENTION_DAYS


class TestWindow:
    def test_a_request_beyond_retention_is_clamped(self):
        """
        Asking Azure for 365 days returns an empty window rather than an error,
        which reads as "nothing happened" — so the ceiling is enforced here.
        """
        assert clamp_window(365) == MAX_RETENTION_DAYS

    def test_a_nonsense_window_falls_back_to_something_usable(self):
        # Zero and None both mean "not specified", so they take the default
        # rather than producing an empty window nobody asked for.
        assert clamp_window(0) == 7
        assert clamp_window(None) == 7
        # A negative window cannot be honoured, so it collapses to the smallest
        # real one instead of inverting the date range.
        assert clamp_window(-5) == 1
