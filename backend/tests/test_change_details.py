"""
Deep property diffs, and the rules for silencing expected changes.

Two properties are load-bearing here and both are ways of lying rather than
crashing: a change reported that did not happen, and a change hidden without
being counted. Everything else in this file is detail.
"""
import json

import pytest

from services import changes as svc
from services import scanner


class Row(dict):
    """A snapshot row. Real rows are sqlite3.Row, which raises on unknown keys."""

    def __getitem__(self, key):
        if key not in self:
            raise IndexError(key)
        return super().__getitem__(key)


def row(resource_id="/subscriptions/s/rg/a", *, properties=None, omit_properties=False, **over):
    base = {
        "resource_id": resource_id,
        "name": "thing",
        "type": "microsoft.compute/virtualmachines",
        "resource_group": "rg-a",
        "subscription_id": "sub-1",
        "location": "eastus",
        "sku": "Standard_B2s",
        "tags": "{}",
        "properties": "" if properties is None else json.dumps(properties),
    }
    base.update(over)
    if omit_properties:
        base.pop("properties")
    return Row(base)


class Rule(dict):
    def __getitem__(self, key):
        return super().__getitem__(key)


def rule(resource_id, field=""):
    return Rule({"resource_id": resource_id, "field": field})


# ── deep property comparison ────────────────────────────────────────────────

def test_a_nested_setting_change_is_found_with_its_path():
    changes = svc.compare_properties(
        json.dumps({"networkAcls": {"defaultAction": "Deny"}}),
        json.dumps({"networkAcls": {"defaultAction": "Allow"}}),
    )
    assert changes == [{
        "field": "networkAcls.defaultAction",
        "label": "networkAcls.defaultAction",
        "from": "Deny",
        "to": "Allow",
    }]


def test_an_identical_bag_reports_nothing():
    bag = json.dumps({"a": {"b": 1}, "c": [1, 2]})
    assert svc.compare_properties(bag, bag) == []


def test_a_missing_bag_on_either_side_reports_nothing():
    """A snapshot taken before configuration was captured has no bag. Reading
    that absence as deletion would report every property of every resource as
    removed on the first scan after the upgrade."""
    bag = json.dumps({"publicNetworkAccess": "Enabled"})
    assert svc.compare_properties("", bag) == []
    assert svc.compare_properties(bag, "") == []
    assert svc.compare_properties(None, None) == []


def test_unparseable_stored_json_reports_nothing_rather_than_raising():
    assert svc.compare_properties("{not json", json.dumps({"a": 1})) == []


def test_a_property_that_appears_is_reported_with_an_empty_old_value():
    changes = svc.compare_properties(json.dumps({}), json.dumps({"tls": "1.2"}))
    assert changes == [{"field": "tls", "label": "tls", "from": "", "to": "1.2"}]


def test_booleans_render_as_words_not_python_capitals():
    """`False` in a table cell is a Python detail leaking into somebody's audit."""
    changes = svc.compare_properties(
        json.dumps({"disableLocalAuth": True}), json.dumps({"disableLocalAuth": False})
    )
    assert changes[0]["from"] == "true"
    assert changes[0]["to"] == "false"


@pytest.mark.parametrize("noisy", [
    "etag", "provisioningState", "timeCreated", "leaseStatus", "resourceGuid",
])
def test_fields_azure_rewrites_by_itself_are_not_reported(noisy):
    """These move without anybody touching the resource. Reporting them makes
    every scan look like an incident and trains people to stop reading."""
    assert svc.compare_properties(
        json.dumps({noisy: "one"}), json.dumps({noisy: "two"})
    ) == []


def test_noise_is_suppressed_at_any_depth():
    assert svc.compare_properties(
        json.dumps({"storageProfile": {"osDisk": {"etag": "a"}}}),
        json.dumps({"storageProfile": {"osDisk": {"etag": "b"}}}),
    ) == []


def test_a_real_change_beside_a_noisy_one_still_surfaces():
    changes = svc.compare_properties(
        json.dumps({"etag": "a", "publicNetworkAccess": "Disabled"}),
        json.dumps({"etag": "b", "publicNetworkAccess": "Enabled"}),
    )
    assert [c["field"] for c in changes] == ["publicNetworkAccess"]


def test_a_list_is_compared_whole_rather_than_by_position():
    """Azure reorders lists freely. Positional matching would invent changes."""
    changes = svc.compare_properties(
        json.dumps({"rules": ["a", "b"]}), json.dumps({"rules": ["b", "a"]})
    )
    assert len(changes) == 1
    assert changes[0]["field"] == "rules"


def test_one_pathological_resource_cannot_flood_the_response():
    old = {f"k{i}": i for i in range(500)}
    new = {f"k{i}": i + 1 for i in range(500)}
    changes = svc.compare_properties(json.dumps(old), json.dumps(new))
    assert len(changes) <= svc.MAX_PROPERTY_CHANGES


def test_property_changes_are_listed_after_the_named_columns():
    """People scan for "Region" and "SKU / size" — words they can name. The
    dotted paths are the detail underneath, not the headline."""
    changes = svc.compare_resource(
        row(location="eastus", properties={"tls": "1.0"}),
        row(location="westus", properties={"tls": "1.2"}),
    )
    assert changes[0]["field"] == "location"
    assert changes[-1]["field"] == "tls"


def test_a_row_without_the_properties_column_is_still_comparable():
    """Databases upgraded in place have rows that predate the column."""
    changes = svc.compare_resource(
        row(location="eastus", omit_properties=True),
        row(location="westus", omit_properties=True),
    )
    assert [c["field"] for c in changes] == ["location"]


def test_a_configuration_only_change_still_counts_as_modified():
    diff = svc.diff_rows(
        [row(properties={"publicNetworkAccess": "Disabled"})],
        [row(properties={"publicNetworkAccess": "Enabled"})],
    )
    assert diff["modified_count"] == 1
    assert diff["modified"][0]["changes"][0]["field"] == "publicNetworkAccess"


# ── capture ─────────────────────────────────────────────────────────────────

def test_a_configuration_bag_is_stored_as_sorted_json():
    text = scanner._properties_of({"properties": {"b": 1, "a": 2}})
    assert text == '{"a": 2, "b": 1}'


def test_a_resource_without_a_configuration_bag_stores_nothing():
    assert scanner._properties_of({"properties": None}) == ""
    assert scanner._properties_of({}) == ""


def test_an_oversized_bag_is_dropped_rather_than_truncated():
    """Truncated JSON does not parse, and half a bag would diff against the next
    scan's whole one and report changes that did not happen."""
    huge = {"k": "x" * (scanner.MAX_PROPERTIES_CHARS + 100)}
    assert scanner._properties_of({"properties": huge}) == ""


# ── ignoring ────────────────────────────────────────────────────────────────

def base_diff():
    return svc.diff_rows(
        [row("/sub/a", name="a"), row("/sub/b", name="b", location="eastus")],
        [row("/sub/b", name="b", location="westus"), row("/sub/c", name="c")],
    )


def test_nothing_is_hidden_when_there_are_no_rules():
    result = svc.apply_ignores(base_diff(), [])
    assert result["total_changes"] == 3
    assert result["ignored_count"] == 0
    assert all(not e["ignored"] for e in result["modified"])


def test_an_ignored_resource_is_removed_from_the_list_and_the_counts():
    result = svc.apply_ignores(base_diff(), [rule("/sub/c")])
    assert [e["name"] for e in result["added"]] == []
    assert result["added_count"] == 0
    assert result["total_changes"] == 2


def test_an_ignored_change_is_still_counted_so_the_page_can_say_so():
    """A page that quietly shows less than it found is worse than one that shows
    too much, because nobody can tell it is happening."""
    result = svc.apply_ignores(base_diff(), [rule("/sub/c")])
    assert result["ignored_count"] == 1


def test_show_ignored_keeps_the_row_but_marks_it():
    result = svc.apply_ignores(base_diff(), [rule("/sub/c")], show_ignored=True)
    assert [e["name"] for e in result["added"]] == ["c"]
    assert result["added"][0]["ignored"] is True
    # Marked, but still not counted as a live change.
    assert result["added_count"] == 0


def test_matching_is_case_insensitive_because_azure_ids_are():
    result = svc.apply_ignores(base_diff(), [rule("/SUB/C")])
    assert result["added_count"] == 0


def test_ignoring_one_field_does_not_ignore_the_resource():
    """A pipeline that rewrites a tag nightly should not also hide the day the
    resource is deleted."""
    diff = svc.diff_rows(
        [row("/sub/b", location="eastus", sku="B1")],
        [row("/sub/b", location="westus", sku="B2")],
    )
    result = svc.apply_ignores(diff, [rule("/sub/b", "location")])
    entry = result["modified"][0]
    assert [c["field"] for c in entry["changes"]] == ["sku"]
    assert entry["ignored"] is False
    assert result["modified_count"] == 1


def test_a_resource_whose_every_change_is_ignored_becomes_ignored():
    diff = svc.diff_rows([row("/sub/b", location="eastus")],
                         [row("/sub/b", location="westus")])
    result = svc.apply_ignores(diff, [rule("/sub/b", "location")])
    assert result["modified"] == []
    assert result["ignored_count"] == 1


def test_a_field_rule_does_not_silence_a_deletion():
    diff = svc.diff_rows([row("/sub/b")], [])
    result = svc.apply_ignores(diff, [rule("/sub/b", "location")])
    assert result["removed_count"] == 1


# ── grouping ────────────────────────────────────────────────────────────────

def grouped_diff():
    return svc.diff_rows(
        [row("/sub/x", name="x", subscription_id="sub-1")],
        [
            row("/sub/y", name="y", subscription_id="sub-1"),
            row("/sub/z", name="z", subscription_id="sub-2"),
        ],
    )


def test_counts_are_reported_per_group():
    rows = svc.group_counts(grouped_diff(), "subscription")
    by_key = {r["key"]: r for r in rows}
    assert by_key["sub-1"]["added"] == 1
    assert by_key["sub-1"]["removed"] == 1
    assert by_key["sub-2"]["added"] == 1


def test_the_busiest_group_is_listed_first():
    rows = svc.group_counts(grouped_diff(), "subscription")
    assert rows[0]["key"] == "sub-1"


def test_an_ignored_change_is_not_counted_in_its_group():
    """Otherwise a subscription reads as having changes above a list of none."""
    diff = svc.apply_ignores(grouped_diff(), [rule("/sub/z")], show_ignored=True)
    rows = svc.group_counts(diff, "subscription")
    assert all(r["key"] != "sub-2" for r in rows)


def test_a_resource_with_no_value_for_the_grouping_is_named_not_dropped():
    diff = svc.diff_rows([], [row("/sub/q", name="q", resource_group="")])
    rows = svc.group_counts(diff, "resource_group")
    assert rows[0]["key"] == "Unassigned"


def test_an_unknown_grouping_returns_nothing_rather_than_guessing():
    assert svc.group_counts(grouped_diff(), "colour") == []


@pytest.mark.parametrize("key", ["subscription", "resource_group", "type", "location"])
def test_every_offered_grouping_works(key):
    assert isinstance(svc.group_counts(grouped_diff(), key), list)
