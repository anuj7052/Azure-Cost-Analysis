"""
Lifecycle dating and per-resource cost.

The behaviour worth protecting here is not "does it return a date" but "does it
say how much that date can be trusted". Every test below is really asking
whether an approximate answer is still labelled approximate.
"""
from datetime import datetime, timedelta, timezone

from services import lifecycle
from services import resource_cost as rc


def _iso(days_ago: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days_ago)).isoformat()


def _write(at: str, caller: str = "someone@example.com", succeeded: bool = True):
    return {
        "at": at,
        "caller": caller,
        "operation": "Microsoft.Compute/virtualMachines/write",
        "summary": "Created or updated virtual machines",
        "succeeded": succeeded,
    }


def _delete(at: str, caller: str = "someone@example.com"):
    return {
        "at": at,
        "caller": caller,
        "operation": "Microsoft.Compute/virtualMachines/delete",
        "summary": "Deleted virtual machines",
        "succeeded": True,
    }


# ── Creation dates ─────────────────────────────────────────────────────────

class TestCreationDate:
    def test_azures_own_stamp_is_preferred_and_marked_exact(self):
        """
        A provider that records its own creation time is the best source there
        is: exact, and still true long after the Activity Log has expired.
        """
        life = lifecycle.build_lifecycle(
            first_seen="2026-01-05T00:00:00",
            last_seen="2026-03-05T00:00:00",
            properties={"timeCreated": "2024-06-01T09:15:00Z"},
        )
        assert life["created"]["at"] == "2024-06-01T09:15:00Z"
        assert life["created"]["source"] == lifecycle.SOURCE_AZURE
        assert life["created"]["exact"] is True

    def test_a_nested_stamp_is_found(self):
        """Disks and several other types bury the stamp a level down."""
        found = lifecycle.created_timestamp(
            {"creationData": {"createOption": "Empty"}, "diskState": "Attached",
             "timeCreated": "2025-02-02T00:00:00Z"}
        )
        assert found == "2025-02-02T00:00:00Z"

    def test_a_schedule_is_not_mistaken_for_a_creation_time(self):
        """
        `startTime` on a maintenance window holds a clock time, not an instant.
        Reporting "02:00" as a creation date would be nonsense presented as
        fact, so anything that does not parse as a timestamp is rejected.
        """
        assert lifecycle.created_timestamp({"startTime": "02:00"}) is None

    def test_the_activity_log_dates_a_resource_created_inside_retention(self):
        life = lifecycle.build_lifecycle(
            first_seen=_iso(10),
            last_seen=_iso(1),
            properties={},
            activity=[_write(_iso(12), caller="dev@example.com")],
            activity_covers_from=_iso(90),
        )
        assert life["created"]["source"] == lifecycle.SOURCE_ACTIVITY
        assert life["created"]["by"] == "dev@example.com"
        assert life["created"]["exact"] is True

    def test_an_edit_on_an_old_resource_is_not_read_as_its_creation(self):
        """
        The log only reaches back ninety days. A two year old VM that was
        re-tagged last week shows exactly one write, and calling that its
        creation would date the resource to the tag edit.
        """
        life = lifecycle.build_lifecycle(
            first_seen=_iso(400),
            last_seen=_iso(1),
            properties={},
            activity=[_write(_iso(7))],
            activity_covers_from=_iso(90),
        )
        assert life["created"]["source"] == lifecycle.SOURCE_SNAPSHOT
        assert life["created"]["exact"] is False

    def test_a_snapshot_date_is_never_presented_as_exact(self):
        """
        With no Azure stamp and no log, all we honestly know is that the
        resource already existed when a scan ran.
        """
        life = lifecycle.build_lifecycle(
            first_seen="2026-01-05T00:00:00",
            last_seen="2026-03-05T00:00:00",
            properties=None,
        )
        assert life["created"]["at"] == "2026-01-05T00:00:00"
        assert life["created"]["exact"] is False
        assert "at or before" in life["created"]["detail"]

    def test_a_resource_we_never_captured_has_no_creation_date(self):
        life = lifecycle.build_lifecycle(
            first_seen=None, last_seen=None, properties=None,
        )
        assert life["created"] is None


# ── Deletion dates ─────────────────────────────────────────────────────────

class TestDeletionDate:
    def test_a_logged_deletion_names_the_person(self):
        life = lifecycle.build_lifecycle(
            first_seen=_iso(60),
            last_seen=_iso(3),
            properties={},
            removed_at=_iso(2),
            activity=[_delete(_iso(4), caller="ops@example.com")],
            activity_covers_from=_iso(90),
        )
        assert life["deleted"]["source"] == lifecycle.SOURCE_ACTIVITY
        assert life["deleted"]["by"] == "ops@example.com"
        assert life["still_present"] is False

    def test_without_a_log_the_deletion_is_bounded_by_the_scan(self):
        life = lifecycle.build_lifecycle(
            first_seen="2026-01-01T00:00:00",
            last_seen="2026-02-01T00:00:00",
            properties={},
            removed_at="2026-02-08T00:00:00",
        )
        assert life["deleted"]["at"] == "2026-02-08T00:00:00"
        assert life["deleted"]["exact"] is False
        assert life["deleted"]["source"] == lifecycle.SOURCE_SNAPSHOT

    def test_a_live_resource_reports_no_deletion(self):
        life = lifecycle.build_lifecycle(
            first_seen="2026-01-01T00:00:00",
            last_seen="2026-02-01T00:00:00",
            properties={},
        )
        assert life["deleted"] is None
        assert life["still_present"] is True

    def test_a_failed_delete_attempt_does_not_kill_the_resource(self):
        """
        Somebody tried and was refused. The resource is still there, and a
        timeline claiming otherwise would send people looking for a restore.
        """
        life = lifecycle.build_lifecycle(
            first_seen=_iso(60),
            last_seen=_iso(1),
            properties={},
            activity=[{**_delete(_iso(5)), "succeeded": False}],
            activity_covers_from=_iso(90),
        )
        assert life["deleted"] is None


# ── Last changed ───────────────────────────────────────────────────────────

class TestLastChanged:
    def test_the_creation_write_is_not_also_reported_as_an_edit(self):
        life = lifecycle.build_lifecycle(
            first_seen=_iso(10),
            last_seen=_iso(1),
            properties={},
            activity=[_write(_iso(12))],
            activity_covers_from=_iso(90),
        )
        assert life["last_changed"] is None

    def test_the_most_recent_edit_wins(self):
        life = lifecycle.build_lifecycle(
            first_seen=_iso(30),
            last_seen=_iso(1),
            properties={"timeCreated": _iso(40)},
            activity=[
                _write(_iso(20), caller="old@example.com"),
                _write(_iso(4), caller="recent@example.com"),
            ],
            activity_covers_from=_iso(90),
        )
        assert life["last_changed"]["by"] == "recent@example.com"


# ── Attributing a snapshot change to a person ──────────────────────────────

class TestAttachActivity:
    def test_a_lone_write_in_the_window_is_named(self):
        """
        One scan says the VM was a D2, the next says D4, and exactly one write
        happened in between. That is as close to certain as this gets.
        """
        events = [
            {"at": "2026-02-08T00:00:00", "kind": "modified", "changes": []},
            {"at": "2026-02-01T00:00:00", "kind": "first_seen", "changes": []},
        ]
        enriched = lifecycle.attach_activity(
            events, [_write("2026-02-05T10:00:00Z", caller="alice@example.com")]
        )
        assert enriched[0]["by"] == "alice@example.com"
        assert len(enriched[0]["activity"]) == 1

    def test_several_writes_in_the_window_are_all_offered_and_none_asserted(self):
        """
        Two people touched the resource between scans. Naming one of them as
        the cause is a coin flip presented as an audit trail, so the field is
        left blank and both are listed as candidates.
        """
        events = [
            {"at": "2026-02-08T00:00:00", "kind": "modified", "changes": []},
            {"at": "2026-02-01T00:00:00", "kind": "first_seen", "changes": []},
        ]
        enriched = lifecycle.attach_activity(events, [
            _write("2026-02-03T10:00:00Z", caller="alice@example.com"),
            _write("2026-02-06T10:00:00Z", caller="bob@example.com"),
        ])
        assert enriched[0]["by"] == ""
        assert len(enriched[0]["activity"]) == 2

    def test_a_write_outside_the_window_is_not_attached(self):
        events = [
            {"at": "2026-02-08T00:00:00", "kind": "modified", "changes": []},
            {"at": "2026-02-01T00:00:00", "kind": "first_seen", "changes": []},
        ]
        enriched = lifecycle.attach_activity(
            events, [_write("2026-01-20T10:00:00Z")]
        )
        assert enriched[0]["activity"] == []

    def test_the_window_is_reported_alongside_the_candidates(self):
        events = [
            {"at": "2026-02-08T00:00:00", "kind": "modified", "changes": []},
            {"at": "2026-02-01T00:00:00", "kind": "first_seen", "changes": []},
        ]
        enriched = lifecycle.attach_activity(events, [])
        assert enriched[0]["window_from"] == "2026-02-01T00:00:00"
        assert enriched[0]["window_to"] == "2026-02-08T00:00:00"


# ── Cost series ────────────────────────────────────────────────────────────

RESOURCE = "/subscriptions/s1/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm1"


def _usage(resource_id: str, date: str, cost: float):
    return {"ResourceId": resource_id, "UsageDate": date, "PreTaxCost": cost}


class TestCostSeries:
    def test_rows_are_bucketed_by_month_and_sorted_oldest_first(self):
        series = rc.cost_series([
            _usage(RESOURCE, "20260301", 30.0),
            _usage(RESOURCE, "20260101", 10.0),
            _usage(RESOURCE, "20260201", 20.0),
        ], RESOURCE)
        assert [row["period"] for row in series] == ["2026-01", "2026-02", "2026-03"]

    def test_casing_differences_between_azure_apis_do_not_lose_the_cost(self):
        """
        Resource Graph says `resourceGroups`, Cost Management says
        `resourcegroups`. An exact match returns nothing, which reads on screen
        as a resource that costs nothing.
        """
        series = rc.cost_series([_usage(RESOURCE.upper(), "20260101", 12.0)], RESOURCE)
        assert series == [{"period": "2026-01", "cost": 12.0}]

    def test_other_resources_are_excluded(self):
        series = rc.cost_series([
            _usage(RESOURCE, "20260101", 10.0),
            _usage("/subscriptions/s1/…/vm2", "20260101", 99.0),
        ], RESOURCE)
        assert series == [{"period": "2026-01", "cost": 10.0}]

    def test_daily_granularity_keeps_the_day(self):
        series = rc.cost_series(
            [_usage(RESOURCE, "20260114", 3.0)], RESOURCE, rc.DAILY,
        )
        assert series[0]["period"] == "2026-01-14"

    def test_iso_dates_are_accepted_as_well_as_integers(self):
        series = rc.cost_series(
            [_usage(RESOURCE, "2026-01-14T00:00:00", 3.0)], RESOURCE, rc.DAILY,
        )
        assert series[0]["period"] == "2026-01-14"

    def test_the_subscription_is_read_out_of_the_resource_id(self):
        assert rc.subscription_of(RESOURCE) == "s1"
        assert rc.subscription_of("not-an-id") is None


class TestAttachCost:
    def test_a_resize_is_measured_from_the_month_before_to_the_month_after(self):
        """
        The change lands mid-February, so February is billed half at each size.
        Comparing January against March is the only figure that shows the real
        effect of the resize.
        """
        events = [{"at": "2026-02-14T00:00:00", "kind": "modified", "changes": []}]
        series = [
            {"period": "2026-01", "cost": 100.0},
            {"period": "2026-02", "cost": 150.0},
            {"period": "2026-03", "cost": 200.0},
        ]
        [event] = rc.attach_cost(events, series)
        assert event["cost_before"] == 100.0
        assert event["cost_after"] == 200.0
        assert event["cost_delta"] == 100.0
        assert event["cost_delta_pct"] == 100.0
        assert event["cost_after_partial"] is False

    def test_a_change_in_the_current_period_is_marked_partial(self):
        """
        There is no complete month after this one yet. The comparison is still
        worth showing, but a month in progress against a finished month is not
        like for like and must not be read as one.
        """
        events = [{"at": "2026-03-10T00:00:00", "kind": "modified", "changes": []}]
        series = [
            {"period": "2026-02", "cost": 100.0},
            {"period": "2026-03", "cost": 40.0},
        ]
        [event] = rc.attach_cost(events, series)
        assert event["cost_after_partial"] is True
        assert event["cost_after"] == 40.0

    def test_a_percentage_is_withheld_when_the_baseline_was_zero(self):
        """
        Going from nothing to something is an infinite percentage. Every chart
        that tries to draw it produces a bar off the top of the screen.
        """
        events = [{"at": "2026-02-14T00:00:00", "kind": "modified", "changes": []}]
        series = [
            {"period": "2026-01", "cost": 0.0},
            {"period": "2026-02", "cost": 5.0},
            {"period": "2026-03", "cost": 50.0},
        ]
        [event] = rc.attach_cost(events, series)
        assert event["cost_delta"] == 50.0
        assert event["cost_delta_pct"] is None

    def test_events_survive_with_no_cost_data_at_all(self):
        """
        Cost Management being throttled must not empty the change history,
        which came from our own database and was never at risk.
        """
        events = [{"at": "2026-02-14T00:00:00", "kind": "modified", "changes": []}]
        assert rc.attach_cost(events, []) == events

    def test_an_event_outside_the_billed_range_gets_no_figures(self):
        events = [{"at": "2020-02-14T00:00:00", "kind": "first_seen", "changes": []}]
        [event] = rc.attach_cost(events, [{"period": "2026-01", "cost": 10.0}])
        assert event["cost_before"] is None
        assert event["cost_delta"] is None


class TestSummarise:
    def test_an_empty_series_reports_zero_rather_than_failing(self):
        assert rc.summarise([])["total"] == 0.0

    def test_totals_and_the_latest_period_are_reported(self):
        summary = rc.summarise([
            {"period": "2026-01", "cost": 10.0},
            {"period": "2026-02", "cost": 30.0},
        ])
        assert summary["total"] == 40.0
        assert summary["latest"] == 30.0
        assert summary["latest_period"] == "2026-02"
        assert summary["average"] == 20.0
