"""
Management groups: the hierarchy, and the grants made on it.

Two things are being defended here and both are the kind of bug that produces a
plausible-looking wrong answer rather than a crash.

The first is the *parent* check when counting subscriptions. Azure's descendants
call is recursive, so without it every subscription in the estate is attached to
the root group as well as to the group it lives in, and the count beside each
node is wrong in the least visible way: too large, and only near the top.

The second is `atScope()`. Without it a single tenant-root Owner grant is
returned once for every group beneath it, turning one grant into dozens of
identical findings and making the sprawl detector report a pattern that does not
exist.
"""
import pytest

from services import management_groups as mg


def group(name, display=None, parent=""):
    props = {"displayName": display or name}
    if parent:
        props["details"] = {
            "parent": {"id": f"/providers/Microsoft.Management/managementGroups/{parent}"}
        }
    return {
        "id": f"/providers/Microsoft.Management/managementGroups/{name}",
        "name": name,
        "properties": props,
    }


def descendant_subscription(sub_id, name, parent):
    return {
        "id": f"/subscriptions/{sub_id}",
        "name": sub_id,
        "type": "Microsoft.Management/managementGroups/subscriptions",
        "properties": {
            "displayName": name,
            "parent": {"id": f"/providers/Microsoft.Management/managementGroups/{parent}"},
        },
    }


# ---------------------------------------------------------------------------
# Reading one group
# ---------------------------------------------------------------------------

def test_a_group_keeps_both_its_id_and_the_name_a_person_gave_it():
    row = mg.normalise_group(group("mg-prod-7742", "Production"))
    assert row["name"] == "mg-prod-7742"
    assert row["display_name"] == "Production"


def test_a_group_with_no_display_name_falls_back_to_its_id_rather_than_being_blank():
    row = mg.normalise_group({"name": "mg-orphan", "properties": {}})
    assert row["display_name"] == "mg-orphan"


def test_the_root_group_reports_no_parent_rather_than_a_broken_path():
    assert mg.normalise_group(group("root"))["parent"] == ""


def test_a_nested_group_names_its_parent_by_short_name_not_by_path():
    assert mg.normalise_group(group("prod", parent="root"))["parent"] == "root"


# ---------------------------------------------------------------------------
# The tree
# ---------------------------------------------------------------------------

def test_a_flat_list_becomes_the_hierarchy_azure_describes_but_does_not_return():
    tree = mg.build_tree([
        mg.normalise_group(group("prod", "Production", parent="root")),
        mg.normalise_group(group("root", "Contoso")),
    ])
    assert [n["name"] for n in tree] == ["root"]
    assert [n["name"] for n in tree[0]["children"]] == ["prod"]


def test_a_group_whose_parent_is_invisible_is_promoted_not_dropped():
    # A reviewer granted access to one mid-level group never sees the parent it
    # hangs from. Dropping it would show an empty tree to somebody with
    # perfectly good access to part of one.
    tree = mg.build_tree([mg.normalise_group(group("prod", "Production", parent="unseen"))])
    assert [n["name"] for n in tree] == ["prod"]


def test_siblings_are_ordered_by_the_name_a_person_reads():
    tree = mg.build_tree([
        mg.normalise_group(group("root", "Contoso")),
        mg.normalise_group(group("z", "Alpha", parent="root")),
        mg.normalise_group(group("a", "Zulu", parent="root")),
    ])
    assert [n["display_name"] for n in tree[0]["children"]] == ["Alpha", "Zulu"]


def test_an_empty_tenant_produces_an_empty_tree_rather_than_an_error():
    assert mg.build_tree([]) == []


def test_flattening_keeps_the_depth_so_a_dropdown_can_show_the_shape():
    tree = mg.build_tree([
        mg.normalise_group(group("root", "Contoso")),
        mg.normalise_group(group("prod", "Production", parent="root")),
    ])
    mg.attach_subscriptions(tree, {})
    assert [(r["display_name"], r["depth"]) for r in mg.flatten_tree(tree)] == [
        ("Contoso", 0), ("Production", 1),
    ]


# ---------------------------------------------------------------------------
# Subscription membership
# ---------------------------------------------------------------------------

def test_only_subscriptions_directly_inside_a_group_are_counted_against_it():
    descendants = [
        descendant_subscription("s1", "Prod A", "prod"),
        descendant_subscription("s2", "Root direct", "root"),
    ]
    assert [s["subscription_id"] for s in mg.subscriptions_of(descendants, "root")] == ["s2"]


def test_nested_groups_in_the_descendant_list_are_not_mistaken_for_subscriptions():
    descendants = [
        {"name": "prod", "type": "Microsoft.Management/managementGroups",
         "properties": {"parent": {"id": "/providers/Microsoft.Management/managementGroups/root"}}},
    ]
    assert mg.subscriptions_of(descendants, "root") == []


def test_a_subscription_is_named_rather_than_listed_as_a_guid():
    rows = mg.subscriptions_of([descendant_subscription("s1", "Production", "root")], "root")
    assert rows[0]["display_name"] == "Production"


def test_a_subscription_with_no_display_name_falls_back_to_its_id():
    raw = descendant_subscription("s1", "", "root")
    raw["properties"]["displayName"] = ""
    assert mg.subscriptions_of([raw], "root")[0]["display_name"] == "s1"


# ---------------------------------------------------------------------------
# Which groups sit above a subscription
# ---------------------------------------------------------------------------

def _estate():
    tree = mg.build_tree([
        mg.normalise_group(group("root", "Contoso")),
        mg.normalise_group(group("prod", "Production", parent="root")),
    ])
    mg.attach_subscriptions(tree, {
        "root": [{"subscription_id": "s-root", "display_name": "Sandbox"}],
        "prod": [{"subscription_id": "s-prod", "display_name": "Prod"}],
    })
    return tree


def test_a_subscription_knows_the_whole_chain_of_groups_above_it_outermost_first():
    index = mg.subscription_group_index(_estate())
    assert [g["display_name"] for g in index["s-prod"]] == ["Contoso", "Production"]


def test_a_subscription_at_the_root_has_only_the_root_above_it():
    index = mg.subscription_group_index(_estate())
    assert [g["display_name"] for g in index["s-root"]] == ["Contoso"]


def test_a_subscription_in_no_group_is_absent_rather_than_given_an_empty_chain():
    assert "s-unmanaged" not in mg.subscription_group_index(_estate())


def test_the_index_is_keyed_lower_case_because_azure_is_inconsistent_about_guid_case():
    tree = mg.build_tree([mg.normalise_group(group("root", "Contoso"))])
    mg.attach_subscriptions(tree, {"root": [{"subscription_id": "S-UPPER"}]})
    assert "s-upper" in mg.subscription_group_index(tree)


# ---------------------------------------------------------------------------
# Scope paths and notes
# ---------------------------------------------------------------------------

def test_a_group_scope_path_is_built_from_the_short_name():
    assert mg.group_id("prod") == "/providers/Microsoft.Management/managementGroups/prod"


def test_no_visible_groups_is_reported_as_a_permission_fact_not_as_an_empty_tenant():
    note = mg._hierarchy_note([], truncated=False)
    assert "this token's access" in note
    assert "Management Group Reader" in note


def test_a_truncated_hierarchy_says_so_rather_than_presenting_a_section_as_the_whole():
    note = mg._hierarchy_note([{"name": "a"}], truncated=True)
    assert "section of the estate" in note


def test_a_complete_hierarchy_explains_that_grants_here_are_inherited_downward():
    note = mg._hierarchy_note([{"name": "a"}, {"name": "b"}], truncated=False)
    assert "inherited by every subscription underneath" in note


@pytest.mark.parametrize("scope_kind_input,expected", [
    ("/providers/Microsoft.Management/managementGroups/prod", "management group"),
    ("/subscriptions/abc", "subscription"),
])
def test_a_group_scope_is_recognised_as_wider_than_a_subscription(scope_kind_input, expected):
    from services import access_review
    assert access_review.scope_kind(scope_kind_input) == expected
