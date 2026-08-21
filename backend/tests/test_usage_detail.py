"""
Tests for the daily usage breakdown.

The point of this feature is that a monthly total hides its own shape, so the
tests are about shape: a month that ran flat out must not look like a month with
a weekend off, and a day with nothing billed must survive into the output rather
than being dropped because Cost Management returned no row for it.
"""
import pytest

from services import usage_detail


def _records(month, values, unit_field="UsageQuantity"):
    """Cost Management style records: one per day, days with 0 omitted entirely."""
    out = []
    for index, value in enumerate(values, start=1):
        if value is None:
            continue
        out.append({
            "UsageDate": int(f"{month.replace('-', '')}{index:02d}"),
            "PreTaxCost": value * 2.0,
            unit_field: value,
            "Currency": "INR",
        })
    return out


def test_month_days_covers_the_whole_month():
    assert usage_detail.month_days("2026-02")[-1] == "2026-02-28"
    assert len(usage_detail.month_days("2026-01")) == 31
    assert usage_detail.month_range("2026-01") == ("2026-01-01", "2026-01-31")


def test_missing_days_are_still_returned():
    # Cost Management returns nothing for a day with no usage. Dropping those
    # days would draw a flat line straight across a shutdown.
    records = _records("2026-01", [24.0] * 10)
    rows = usage_detail.daily_rows(records, "2026-01")

    assert len(rows) == 31
    assert rows[10]["quantity"] == 0.0
    assert rows[10]["billed"] is False
    assert rows[0]["billed"] is True


def test_days_outside_the_month_are_ignored():
    records = _records("2026-01", [24.0] * 5)
    records.append({"UsageDate": 20260201, "PreTaxCost": 99.0, "UsageQuantity": 24.0})

    rows = usage_detail.daily_rows(records, "2026-01")
    assert sum(r["quantity"] for r in rows) == pytest.approx(120.0)


def test_iso_timestamps_are_accepted_as_days():
    rows = usage_detail.daily_rows(
        [{"UsageDate": "2026-01-03T00:00:00", "PreTaxCost": 10.0, "UsageQuantity": 24.0}],
        "2026-01",
    )
    assert rows[2]["quantity"] == 24.0


def test_unit_hours_reads_the_multiplier():
    # "10 Hours" is one unit per ten hours. Missing the multiplier makes every
    # uptime figure wrong by 10x, silently.
    assert usage_detail.unit_hours("1 Hour") == 1.0
    assert usage_detail.unit_hours("10 Hours") == 10.0
    assert usage_detail.unit_hours("1 Day") == 24.0
    assert usage_detail.unit_hours("1 GB/Month") == 0.0
    assert usage_detail.unit_hours("") == 0.0


def test_is_time_unit():
    assert usage_detail.is_time_unit("1 Hour")
    assert not usage_detail.is_time_unit("1 GB")


def test_a_flat_month_reports_no_gaps():
    rows = usage_detail.daily_rows(_records("2026-01", [24.0] * 31), "2026-01")
    summary = usage_detail.summarise(rows, "1 Hour", {})

    assert summary["days_billed"] == 31
    assert summary["days_off"] == 0
    assert summary["days_partial"] == 0
    assert summary["full_day_quantity"] == 24.0
    assert summary["total_hours"] == pytest.approx(744.0)
    assert summary["instances"] == 1
    assert summary["avoided_cost"] in (None, 0.0)
    assert all(r["state"] == "full" for r in rows)


def test_a_month_with_a_weekend_off_is_distinguishable():
    values = [24.0] * 31
    values[12] = None   # nothing billed
    values[13] = None
    values[20] = 9.0    # shut down mid afternoon
    rows = usage_detail.daily_rows(_records("2026-01", values), "2026-01")
    summary = usage_detail.summarise(rows, "1 Hour", {})

    assert summary["days_off"] == 2
    assert summary["days_partial"] == 1
    assert rows[12]["state"] == "off"
    assert rows[20]["state"] == "partial"
    assert rows[20]["hours"] == pytest.approx(9.0)

    # 15 hours short on the part day plus two whole days off.
    assert summary["unbilled_hours"] == pytest.approx(63.0)
    # Priced at this line's own effective rate (cost was 2x quantity).
    assert summary["avoided_cost"] == pytest.approx(126.0)


def test_baseline_is_not_moved_by_one_busy_day():
    # A single day with a second instance must not redefine "normal" and make
    # every ordinary day look like a partial one.
    values = [24.0] * 31
    values[5] = 48.0
    rows = usage_detail.daily_rows(_records("2026-01", values), "2026-01")
    summary = usage_detail.summarise(rows, "1 Hour", {})

    assert summary["full_day_quantity"] == 24.0
    assert summary["days_partial"] == 0
    assert summary["days_above_normal"] == 1
    assert rows[5]["state"] == "high"


def test_two_instances_are_counted():
    rows = usage_detail.daily_rows(_records("2026-01", [48.0] * 31), "2026-01")
    summary = usage_detail.summarise(rows, "1 Hour", {})
    assert summary["instances"] == 2
    assert summary["full_day_hours"] == pytest.approx(48.0)


def test_non_duration_units_claim_no_hours():
    # Gigabytes are not uptime. Claiming otherwise would be a fabricated fact.
    rows = usage_detail.daily_rows(_records("2026-01", [100.0] * 31), "2026-01")
    summary = usage_detail.summarise(rows, "1 GB/Month", {})

    assert summary["is_duration"] is False
    assert summary["total_hours"] is None
    assert summary["full_day_hours"] is None
    assert summary["instances"] is None
    assert rows[0]["hours"] is None


def test_an_empty_month_does_not_explode():
    rows = usage_detail.daily_rows([], "2026-01")
    summary = usage_detail.summarise(rows, "1 Hour", {})

    assert summary["days_billed"] == 0
    assert summary["full_day_quantity"] == 0.0
    assert summary["effective_rate"] is None
    assert summary["avoided_cost"] is None


def test_power_event_recognises_the_verbs():
    assert usage_detail.power_event(
        "Microsoft.Compute/virtualMachines/deallocate/action") == ("deallocated", "off")
    assert usage_detail.power_event(
        "Microsoft.Compute/virtualMachines/start/action") == ("started", "on")
    assert usage_detail.power_event(
        "Microsoft.Compute/virtualMachines/powerOff/action") == ("powered off", "off")
    assert usage_detail.power_event(
        "Microsoft.Compute/virtualMachines/delete") == ("deleted", "off")
    # A tag edit and a role assignment are writes, not power changes. A list
    # that claims otherwise is worse than no list.
    assert usage_detail.power_event("Microsoft.Resources/tags/write") is None
    assert usage_detail.power_event("Microsoft.Authorization/roleAssignments/write") is None
    assert usage_detail.power_event("Microsoft.Authorization/policies/audit/action") is None
    assert usage_detail.power_event("") is None


def test_power_events_are_bucketed_by_day_and_sorted():
    entries = [
        {"operation": "Microsoft.Compute/virtualMachines/start/action",
         "at": "2026-01-14T08:12:00Z", "caller": "anna@example.com",
         "resource_id": "/subscriptions/x/resourceGroups/rg/providers/vm-a", "succeeded": True},
        {"operation": "Microsoft.Compute/virtualMachines/deallocate/action",
         "at": "2026-01-14T17:04:00Z", "caller": "anna@example.com",
         "resource_id": "/subscriptions/x/resourceGroups/rg/providers/vm-a", "succeeded": True},
        # Not a power operation, and must not appear.
        {"operation": "Microsoft.Authorization/roleAssignments/write",
         "at": "2026-01-14T09:00:00Z", "caller": "bob@example.com", "resource_id": "", "succeeded": True},
        # Different month.
        {"operation": "Microsoft.Compute/virtualMachines/start/action",
         "at": "2026-02-01T08:00:00Z", "caller": "anna@example.com", "resource_id": "", "succeeded": True},
    ]
    by_day = usage_detail.power_events(entries, "2026-01")

    assert list(by_day) == ["2026-01-14"]
    day = by_day["2026-01-14"]
    assert len(day) == 2
    assert day[0]["time"] == "08:12"
    assert day[0]["action"] == "started"
    assert day[-1]["time"] == "17:04"
    assert day[-1]["state"] == "off"
    assert day[-1]["caller"] == "anna@example.com"


def test_summarise_attaches_events_to_their_day():
    rows = usage_detail.daily_rows(_records("2026-01", [24.0] * 31), "2026-01")
    events = {"2026-01-14": [{"at": "2026-01-14 08:12:00", "action": "started"}]}
    usage_detail.summarise(rows, "1 Hour", events)

    assert rows[13]["events"] == events["2026-01-14"]
    assert rows[0]["events"] == []


def test_activity_window_says_when_the_log_is_gone():
    # A month older than retention returns no events, which looks exactly like a
    # month in which nobody touched anything. The difference has to be stated.
    old = usage_detail.activity_window("2020-01")
    assert old["covered"] is False
    assert "older than that" in old["note"]

    from datetime import date
    current = usage_detail.activity_window(date.today().strftime("%Y-%m"))
    assert current["covered"] is True
    assert current["partial"] is False
    assert current["note"] == ""
