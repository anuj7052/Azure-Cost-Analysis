"""
Accepting a finding, and the measured evidence a card shows.

Two rules are load-bearing here and neither is obvious from the code.

The first is that hiding is per *finding*, not per assignment. The same grant
can produce "this service principal is dormant" and "and it holds Owner it never
uses"; accepting the first must not silence the second, because they are two
different decisions and only one of them was made.

The second is that zero and unknown are different claims. `activity_count: 0`
means the Activity Log was read and held nothing. `activity_count: None` means
it was never read. Collapsing them lets a page with usage disabled recommend
revoking everybody's access on the strength of evidence it never gathered.
"""
import aiosqlite
import pytest_asyncio

import core.db as db_module
from services import access_accept as accept
from services import access_review


@pytest_asyncio.fixture
async def db(tmp_path, monkeypatch):
    path = str(tmp_path / "test.db")
    monkeypatch.setattr(db_module, "DB_PATH", path)
    await db_module.init_db()
    conn = await aiosqlite.connect(path)
    conn.row_factory = aiosqlite.Row
    await conn.execute("PRAGMA foreign_keys = ON")
    yield conn
    await conn.close()


async def account(db, email="owner@example.com"):
    cursor = await db.execute(
        "INSERT INTO users (azure_oid, azure_tenant_id, email) VALUES (?, ?, ?)",
        (email, "t1", email),
    )
    await db.commit()
    return cursor.lastrowid


def finding(**over):
    base = {
        "kind": "unused",
        "severity": "high",
        "principal_id": "P-1",
        "principal_name": "Amber Chen",
        "assignment_id": "/subscriptions/s1/providers/Microsoft.Authorization/roleAssignments/a1",
        "role_name": "Contributor",
        "scope": "/subscriptions/s1",
        "resolved": True,
    }
    base.update(over)
    return base


# ---------------------------------------------------------------------------
# Identifying a finding
# ---------------------------------------------------------------------------

def test_two_findings_about_the_same_grant_have_different_keys():
    unused = accept.finding_key(finding(kind="unused"))
    over = accept.finding_key(finding(kind="over-privileged"))
    assert unused != over


def test_the_same_finding_produces_the_same_key_every_time():
    assert accept.finding_key(finding()) == accept.finding_key(finding())


def test_a_key_is_case_insensitive_because_azure_is_inconsistent_about_ids():
    upper = accept.finding_key(finding(assignment_id="/SUBSCRIPTIONS/S1/A1"))
    lower = accept.finding_key(finding(assignment_id="/subscriptions/s1/a1"))
    assert upper == lower


def test_a_sprawl_finding_with_no_single_assignment_still_gets_a_key():
    key = accept.finding_key(finding(kind="sprawl", assignment_id="", scope=""))
    assert key == "sprawl:contributor"


# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------

async def test_an_acceptance_is_stored_and_read_back(db):
    user = await account(db)
    await accept.accept(db, user, "t1", "P-1", "unused:a1", note="Break-glass account")
    rules = await accept.list_rules(db, user, "t1")
    assert len(rules) == 1
    assert rules[0]["note"] == "Break-glass account"


async def test_accepting_twice_updates_the_reason_rather_than_failing(db):
    user = await account(db)
    await accept.accept(db, user, "t1", "P-1", "unused:a1", note="first")
    await accept.accept(db, user, "t1", "P-1", "unused:a1", note="second")
    rules = await accept.list_rules(db, user, "t1")
    assert [r["note"] for r in rules] == ["second"]


async def test_one_workspace_cannot_see_or_lift_anothers_acceptances(db):
    mine = await account(db, "a@example.com")
    theirs = await account(db, "b@example.com")
    await accept.accept(db, mine, "t1", "P-1")
    assert await accept.list_rules(db, theirs, "t1") == []
    assert await accept.restore(db, theirs, "t1", "P-1") == 0
    assert len(await accept.list_rules(db, mine, "t1")) == 1


async def test_an_acceptance_is_scoped_to_one_tenant(db):
    user = await account(db)
    await accept.accept(db, user, "t1", "P-1")
    assert await accept.list_rules(db, user, "t2") == []


async def test_lifting_an_acceptance_that_was_never_made_is_not_an_error(db):
    user = await account(db)
    assert await accept.restore(db, user, "t1", "nobody") == 0


async def test_a_lifted_acceptance_stops_hiding_the_finding(db):
    user = await account(db)
    key = accept.finding_key(finding())
    await accept.accept(db, user, "t1", "P-1", key)
    await accept.restore(db, user, "t1", "P-1", key)
    result = accept.apply_rules([finding()], await accept.list_rules(db, user, "t1"))
    assert result["hidden_count"] == 0
    assert len(result["findings"]) == 1


async def test_a_reason_longer_than_the_column_is_truncated_not_rejected(db):
    user = await account(db)
    await accept.accept(db, user, "t1", "P-1", note="x" * 900)
    rules = await accept.list_rules(db, user, "t1")
    assert len(rules[0]["note"]) == accept.MAX_NOTE


async def test_who_accepted_it_is_recorded_because_an_audit_needs_to_know(db):
    user = await account(db)
    await accept.accept(db, user, "t1", "P-1", created_by="reviewer@example.com")
    assert (await accept.list_rules(db, user, "t1"))[0]["created_by"] == "reviewer@example.com"


# ---------------------------------------------------------------------------
# Applying acceptances
# ---------------------------------------------------------------------------

def rule(principal="p-1", key="", note=""):
    return {"principal_id": principal, "finding_key": key, "note": note}


def test_with_no_rules_nothing_is_hidden():
    result = accept.apply_rules([finding()], [])
    assert result["hidden_count"] == 0
    assert result["findings"][0]["hidden"] is False


def test_an_accepted_finding_leaves_the_list_but_is_still_counted():
    key = accept.finding_key(finding())
    result = accept.apply_rules([finding()], [rule(key=key)])
    assert result["findings"] == []
    assert result["hidden_count"] == 1


def test_show_hidden_marks_the_finding_without_pretending_it_was_never_accepted():
    key = accept.finding_key(finding())
    result = accept.apply_rules([finding()], [rule(key=key)], show_hidden=True)
    assert result["findings"][0]["hidden"] is True
    assert result["hidden_count"] == 1


def test_accepting_one_finding_does_not_silence_another_about_the_same_grant():
    key = accept.finding_key(finding(kind="unused"))
    result = accept.apply_rules(
        [finding(kind="unused"), finding(kind="over-privileged")], [rule(key=key)]
    )
    assert [f["kind"] for f in result["findings"]] == ["over-privileged"]


def test_hiding_a_whole_principal_hides_every_finding_about_them():
    result = accept.apply_rules(
        [finding(kind="unused"), finding(kind="redundant")], [rule()]
    )
    assert result["findings"] == []
    assert result["hidden_count"] == 2


def test_a_principal_rule_does_not_touch_anybody_else():
    result = accept.apply_rules(
        [finding(), finding(principal_id="P-2", principal_name="Ava")], [rule()]
    )
    assert [f["principal_name"] for f in result["findings"]] == ["Ava"]


def test_a_rule_matches_regardless_of_the_case_azure_returned_the_id_in():
    result = accept.apply_rules([finding(principal_id="p-1")], [rule(principal="P-1")])
    assert result["hidden_count"] == 1


def test_accepted_with_no_reason_stays_distinguishable_from_not_accepted():
    index = accept.index_rules([rule()])
    assert accept.accepted_note(finding(), index) == ""
    assert accept.accepted_note(finding(principal_id="P-9"), index) is None


def test_every_finding_is_given_its_key_so_the_page_can_act_on_it():
    result = accept.apply_rules([finding()], [])
    assert result["findings"][0]["finding_key"] == accept.finding_key(finding())


# ---------------------------------------------------------------------------
# The principal column
# ---------------------------------------------------------------------------

def test_principals_are_counted_once_with_their_findings_beside_them():
    rows = accept.principal_rows([finding(), finding(kind="redundant", severity="low")])
    assert len(rows) == 1
    assert rows[0]["finding_count"] == 2
    assert rows[0]["severities"] == {"high": 1, "low": 1}


def test_the_principal_with_the_most_high_severity_findings_is_read_first():
    rows = accept.principal_rows([
        finding(principal_id="P-2", principal_name="Ava", severity="low"),
        finding(principal_id="P-2", principal_name="Ava", severity="low", kind="redundant"),
        finding(),
    ])
    assert rows[0]["principal_name"] == "Amber Chen"


def test_accepted_findings_are_counted_separately_from_the_total():
    rows = accept.principal_rows([
        {**finding(), "hidden": True}, finding(kind="redundant"),
    ])
    assert rows[0]["finding_count"] == 2
    assert rows[0]["hidden_count"] == 1


def test_a_name_resolved_on_any_one_finding_is_used_for_the_row():
    rows = accept.principal_rows([
        {**finding(), "resolved": False}, finding(kind="redundant"),
    ])
    assert rows[0]["resolved"] is True


# ---------------------------------------------------------------------------
# Measured usage
# ---------------------------------------------------------------------------

def event(caller, operation, at, is_write=False):
    return {
        "caller": caller, "operation": operation, "at": at,
        "is_write": is_write, "resource_id": "/subscriptions/s1/x",
    }


def test_operations_are_counted_by_verb_not_lumped_into_one_number():
    index = access_review.index_activity([
        event("amber", "Microsoft.Compute/virtualMachines/write", "2026-01-02"),
        event("amber", "Microsoft.Compute/virtualMachines/write", "2026-01-03"),
        event("amber", "Microsoft.Storage/storageAccounts/delete", "2026-01-04"),
    ])
    assert index["amber"]["operations"]["write"] == 2
    assert index["amber"]["operations"]["delete"] == 1
    assert index["amber"]["operations"]["create"] == 0


def test_a_resource_type_containing_a_verb_is_not_counted_as_that_verb():
    # "networkWatchers" contains "write" nowhere, but "Microsoft.Network/
    # networkWatchers/read" must not be a write and neither must a type whose
    # name happens to carry a verb. Matching is on the last segment only.
    index = access_review.index_activity([
        event("amber", "Microsoft.Network/networkWatchers/read", "2026-01-02"),
    ])
    assert index["amber"]["operations"]["write"] == 0


def test_touching_rbac_is_counted_and_dated_separately():
    index = access_review.index_activity([
        event("amber", "Microsoft.Authorization/roleAssignments/write", "2026-01-05"),
        event("amber", "Microsoft.Compute/virtualMachines/write", "2026-02-01"),
    ])
    assert index["amber"]["rbac_count"] == 1
    assert index["amber"]["rbac_last_at"] == "2026-01-05"
    assert index["amber"]["last_at"] == "2026-02-01"


def test_never_reading_the_log_is_reported_as_unknown_not_as_zero():
    fields = access_review.usage_fields(None, window_days=30)
    assert fields["activity_count"] is None
    assert fields["rbac_inactive"] is None
    assert fields["operations"] == {}


def test_reading_the_log_and_finding_nothing_is_reported_as_zero():
    index = access_review.index_activity([event("amber", "x/read", "2026-01-01")])
    fields = access_review.usage_fields(index["amber"], window_days=30)
    assert fields["activity_count"] == 1
    assert fields["rbac_count"] == 0
    assert fields["rbac_inactive"] is True


def test_rbac_appears_in_the_operation_breakdown_alongside_the_four_verbs():
    index = access_review.index_activity([
        event("amber", "Microsoft.Authorization/roleAssignments/write", "2026-01-05"),
    ])
    fields = access_review.usage_fields(index["amber"], window_days=30)
    assert set(fields["operations"]) == {"create", "write", "delete", "action", "rbac"}


def test_days_inactive_is_absent_when_there_is_no_reference_point():
    index = access_review.index_activity([event("amber", "x/write", "2026-01-01")])
    assert access_review.usage_fields(index["amber"], 30, now_iso="")["days_inactive"] is None


# ---------------------------------------------------------------------------
# Findings carry their evidence
# ---------------------------------------------------------------------------

def assignment(**over):
    base = {
        "id": "/subscriptions/s1/providers/Microsoft.Authorization/roleAssignments/a1",
        "principal_id": "P-1",
        "principal_name": "Amber Chen",
        "principal_upn": "amber@example.com",
        "principal_type": "User",
        "resolved": True,
        "role_name": "Owner",
        "privilege": "critical",
        "scope": "/subscriptions/s1",
        "scope_kind": "subscription",
        "subscription_id": "s1",
        "created_at": "2024-06-15T00:00:00Z",
        "created_by": "admin@example.com",
        "is_custom": False,
    }
    base.update(over)
    return base


def _review():
    return access_review.review_access(
        [assignment()],
        events=[event("amber@example.com", "Microsoft.Compute/vm/write", "2026-01-01")],
        window_days=30,
        now_iso="2026-03-01T00:00:00Z",
    )


def test_a_finding_says_when_the_grant_was_made_not_only_that_it_is_unused():
    findings = _review()["findings"]
    assert findings
    assert all(f["assigned_at"] == "2024-06-15T00:00:00Z" for f in findings)


def test_a_finding_says_who_made_the_grant():
    assert _review()["findings"][0]["assigned_by"] == "admin@example.com"


def test_every_finding_carries_its_measured_usage():
    finding_row = _review()["findings"][0]
    assert finding_row["usage"]["activity_count"] == 1
    assert finding_row["usage"]["days_inactive"] is not None


def test_every_finding_carries_a_right_sizing_verdict():
    finding_row = _review()["findings"][0]
    assert finding_row["recommendation"]["action"] in {"keep", "downgrade", "review", "remove"}
    assert finding_row["recommendation"]["reason"]


def test_without_evidence_usage_stays_unknown_rather_than_becoming_zero():
    review = access_review.review_access([assignment()], events=[], window_days=30)
    for row in review["findings"]:
        assert row["usage"]["activity_count"] is None


def test_a_management_group_grant_is_carried_onto_the_finding_by_name():
    review = access_review.review_access(
        [assignment(management_group_name="Production", scope_kind="management group")],
        events=[event("amber@example.com", "x/write", "2026-01-01")],
        window_days=30,
        now_iso="2026-03-01T00:00:00Z",
    )
    assert any(f["management_group"] == "Production" for f in review["findings"])
