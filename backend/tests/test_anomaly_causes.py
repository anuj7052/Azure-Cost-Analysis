"""
Correlating an anomaly with what changed around it.

The thing under test is restraint. It is easy to write something that always
finds an explanation; the value is in what it refuses to claim -- a deletion is
never offered as the reason a bill went up, and nothing is ever described as
having caused anything.
"""
from models.schemas import FieldChange
from services import anomaly_causes as causes


def _resource(name, rtype="Microsoft.Compute/virtualMachines", rg="rg-prod",
              sub="s1", changes=None):
    return {
        "resource_id": f"/subscriptions/{sub}/resourceGroups/{rg}/providers/{rtype}/{name}",
        "name": name,
        "type": rtype,
        "resource_group": rg,
        "subscription_id": sub,
        "changes": changes or [],
    }


def _diff(added=None, removed=None, modified=None):
    return {
        "added": added or [],
        "removed": removed or [],
        "modified": modified or [],
    }


SCOPE = {"subscription_id": "s1", "resource_group": "rg-prod", "service": "Virtual Machines"}


# ── The seam between the diff and this module ──────────────────────────

class TestFieldChangeContract:
    """
    These two agreeing is the whole feature, and when they disagree nothing
    raises: every value reads as empty, so no resize is recognised as growth
    and every headline degrades to "changed from - to -". A green suite proved
    only that the fixtures matched the code, because both had invented the same
    key names. The fixture is built from the real schema here so that renaming
    the field breaks this test instead of quietly emptying the feature.
    """

    def test_the_diff_emits_the_keys_this_module_reads(self):
        emitted = FieldChange(
            field="sku", label="SKU", **{"from": "Standard_D2s_v3"}, to="Standard_D4s_v3"
        ).model_dump(by_alias=True)

        assert causes._pair(emitted) == ("Standard_D2s_v3", "Standard_D4s_v3")

    def test_a_resize_read_through_the_real_schema_is_recognised_as_growth(self):
        emitted = FieldChange(
            field="sku", label="SKU", **{"from": "Standard_D2s_v3"}, to="Standard_D4s_v3"
        ).model_dump(by_alias=True)
        vm = _resource("vm1", changes=[emitted])

        evidence = causes.explain(_diff(modified=[vm]), SCOPE, "increase")

        assert evidence[0]["relevance"] == causes.STRONG
        assert "(larger)" in evidence[0]["headline"]


# ── Matching a resource type to a billed service ───────────────────────────

class TestServiceMatching:
    def test_a_camel_case_type_matches_its_spaced_service_name(self):
        """
        `virtualMachines` and `Virtual Machines` are the same thing written two
        ways, and they only match once the camel hump is treated as a space.
        """
        assert causes.type_matches_service(
            "Microsoft.Compute/virtualMachines", "Virtual Machines"
        )

    def test_the_publisher_prefix_alone_is_not_a_match(self):
        """
        Every Azure type contains "Microsoft". Matching on it would make every
        resource relevant to every service.
        """
        assert not causes.type_matches_service(
            "Microsoft.Storage/storageAccounts", "Virtual Machines"
        )

    def test_missing_values_do_not_match(self):
        assert not causes.type_matches_service("", "Virtual Machines")
        assert not causes.type_matches_service("Microsoft.Compute/disks", "")


# ── Reading growth out of a SKU name ───────────────────────────────────────

class TestSkuDirection:
    def test_a_doubled_vm_size_reads_as_larger(self):
        assert causes.sku_direction("Standard_D2s_v3", "Standard_D4s_v3") == "larger"

    def test_a_halved_vm_size_reads_as_smaller(self):
        assert causes.sku_direction("Standard_D8s_v3", "Standard_D4s_v3") == "smaller"

    def test_a_hardware_generation_bump_is_not_growth(self):
        """
        `_v3` to `_v5` is a newer generation at the same size. Reading it as
        growth turns every modernisation into a phantom cost rise.
        """
        assert causes.sku_direction("Standard_D4s_v3", "Standard_D4s_v5") is None

    def test_a_name_without_numbers_yields_no_direction(self):
        assert causes.sku_direction("Standard_LRS", "Premium_LRS") is None


# ── Scope ──────────────────────────────────────────────────────────────────

class TestScope:
    def test_another_resource_group_is_excluded(self):
        assert not causes.in_scope(_resource("vm1", rg="rg-dev"), SCOPE)

    def test_another_subscription_is_excluded(self):
        assert not causes.in_scope(_resource("vm1", sub="s2"), SCOPE)

    def test_a_different_service_in_the_same_group_is_still_included(self):
        """
        A disk resized inside the group bills under Storage while the anomaly
        was raised against Virtual Machines. Filtering on service removed
        exactly the change somebody needed to see, so service ranks and never
        excludes.
        """
        disk = _resource("disk1", rtype="Microsoft.Compute/disks")
        assert causes.in_scope(disk, SCOPE)

    def test_an_anomaly_with_no_resource_group_matches_the_whole_subscription(self):
        scope = {"subscription_id": "s1", "resource_group": "", "service": ""}
        assert causes.in_scope(_resource("vm1", rg="anything"), scope)


# ── Ranking evidence ───────────────────────────────────────────────────────

class TestExplain:
    def test_a_new_resource_is_strong_evidence_for_a_rise(self):
        evidence = causes.explain(_diff(added=[_resource("vm1")]), SCOPE, "increase")
        assert evidence[0]["relevance"] == causes.STRONG
        assert evidence[0]["headline"] == "vm1 was created"

    def test_a_deletion_is_not_offered_as_the_reason_a_bill_rose(self):
        """
        Something vanishing cannot make a cost go up. Listing it as strong
        evidence is how a reader stops trusting the list.
        """
        evidence = causes.explain(_diff(removed=[_resource("vm1")]), SCOPE, "increase")
        assert evidence[0]["relevance"] == causes.POSSIBLE
        assert "would not move the bill this way" in evidence[0]["why_relevant"]

    def test_a_deletion_is_strong_evidence_for_a_fall(self):
        evidence = causes.explain(_diff(removed=[_resource("vm1")]), SCOPE, "decrease")
        assert evidence[0]["relevance"] == causes.STRONG

    def test_a_resize_upward_explains_a_rise_and_says_what_changed(self):
        vm = _resource("vm1", changes=[
            {"field": "sku", "from": "Standard_D2s_v3", "to": "Standard_D4s_v3"},
        ])
        evidence = causes.explain(_diff(modified=[vm]), SCOPE, "increase")
        assert evidence[0]["relevance"] == causes.STRONG
        assert evidence[0]["headline"] == (
            "vm1 changed from Standard_D2s_v3 to Standard_D4s_v3 (larger)"
        )

    def test_a_resize_downward_does_not_explain_a_rise(self):
        vm = _resource("vm1", changes=[
            {"field": "sku", "from": "Standard_D8s_v3", "to": "Standard_D2s_v3"},
        ])
        evidence = causes.explain(_diff(modified=[vm]), SCOPE, "increase")
        assert evidence[0]["relevance"] == causes.POSSIBLE

    def test_a_tag_edit_is_kept_but_never_promoted(self):
        """
        Retained rather than dropped: a reader who sees only weak findings has
        learned that we looked, which a short list cannot tell them.
        """
        vm = _resource("vm1", changes=[
            {"field": "tags", "from": "{}", "to": '{"owner":"ops"}'},
        ])
        evidence = causes.explain(_diff(modified=[vm]), SCOPE, "increase")
        assert len(evidence) == 1
        assert evidence[0]["relevance"] == causes.POSSIBLE

    def test_strong_evidence_is_listed_before_weak(self):
        evidence = causes.explain(
            _diff(added=[_resource("vm-new")], removed=[_resource("vm-old")]),
            SCOPE,
            "increase",
        )
        assert evidence[0]["name"] == "vm-new"
        assert evidence[1]["name"] == "vm-old"

    def test_out_of_scope_changes_never_appear(self):
        evidence = causes.explain(
            _diff(added=[_resource("vm1", rg="rg-dev")]), SCOPE, "increase",
        )
        assert evidence == []

    def test_the_list_is_capped(self):
        many = [_resource(f"vm{i}") for i in range(60)]
        assert len(causes.explain(_diff(added=many), SCOPE, "increase")) == 25


# ── The sentence above the list ────────────────────────────────────────────

class TestSummarise:
    def test_finding_nothing_says_where_else_to_look(self):
        """
        An empty list that just says "no changes" leaves the reader stuck. The
        cost still moved, and usage, price and discounts are the remaining
        explanations our snapshots cannot see.
        """
        text = causes.summarise([], "increase")
        assert "price change" in text
        assert "discount" in text

    def test_weak_findings_only_are_reported_as_such(self):
        evidence = [{"relevance": causes.POSSIBLE, "headline": "x"}]
        text = causes.summarise(evidence, "increase")
        assert "none of them would produce this increase" in text

    def test_a_single_strong_finding_is_named_and_still_hedged(self):
        evidence = [{"relevance": causes.STRONG, "headline": "vm1 was created"}]
        text = causes.summarise(evidence, "increase")
        assert "vm1 was created" in text
        assert "evidence rather than proof" in text

    def test_nothing_is_ever_described_as_having_caused_the_cost(self):
        """
        The whole point of the module. If the word "caused" ever appears, the
        distinction it exists to preserve has been lost.
        """
        for direction in ("increase", "decrease", "new", "removed"):
            for evidence in (
                [],
                [{"relevance": causes.POSSIBLE, "headline": "x"}],
                [{"relevance": causes.STRONG, "headline": "x"}],
                [{"relevance": causes.STRONG, "headline": "x"},
                 {"relevance": causes.STRONG, "headline": "y"}],
            ):
                assert "caused" not in causes.summarise(evidence, direction).lower()
