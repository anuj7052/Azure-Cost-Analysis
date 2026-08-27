"""
Picking a person out of the directory, and choosing what they may do.

Two things are worth failing loudly about. The first is the picker: it is a
free-text box on a path to Microsoft Graph, and it must not turn a stray
apostrophe or a directory that refuses consent into an error page. The second
is the role: "administrator of my workspace" must never quietly become
"administrator of the whole installation", and an administrator must not be
able to appoint more administrators.
"""
from __future__ import annotations

import aiosqlite
import pytest
import pytest_asyncio

import core.db as db_module
from services import graph_directory, team_service, user_service

TENANT = "tenant-a"


@pytest_asyncio.fixture
async def db(tmp_path, monkeypatch):
    path = str(tmp_path / "test.db")
    monkeypatch.setattr(db_module, "DB_PATH", path)
    await db_module.init_db()
    conn = await aiosqlite.connect(path)
    conn.row_factory = aiosqlite.Row
    yield conn
    await conn.close()


def claims(oid, email, tid=TENANT, name="A User"):
    return {"user_id": oid, "email": email, "name": name, "tenant_id": tid}


async def make_owner(db, email="owner@corp.com"):
    return await user_service.upsert_user(db, claims("oid-owner", email))


async def row(db, user_id):
    async with db.execute("SELECT * FROM users WHERE id = ?", (user_id,)) as cur:
        return await cur.fetchone()


class FakeResponse:
    def __init__(self, status_code=200, payload=None):
        self.status_code = status_code
        self._payload = payload if payload is not None else {"value": []}

    def json(self):
        return self._payload


class FakeClient:
    """Stands in for httpx, and remembers what was actually sent to Graph."""

    def __init__(self, response, recorder):
        self._response = response
        self._recorder = recorder

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def get(self, url, headers=None, params=None):
        self._recorder.append({"url": url, "headers": headers, "params": params})
        if isinstance(self._response, Exception):
            raise self._response
        return self._response


def patch_graph(monkeypatch, response):
    sent: list[dict] = []
    monkeypatch.setattr(
        graph_directory.httpx,
        "AsyncClient",
        lambda **kw: FakeClient(response, sent),
    )
    return sent


# ── The picker ─────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_typing_a_name_returns_matching_people(monkeypatch):
    patch_graph(monkeypatch, FakeResponse(200, {"value": [
        {
            "id": "obj-1",
            "displayName": "Priya Sharma",
            "mail": "priya@corp.com",
            "jobTitle": "Finance Lead",
        },
    ]}))

    result = await graph_directory.search_people("token", "pri")

    assert result["reason"] is None
    assert result["people"] == [{
        "id": "obj-1",
        "name": "Priya Sharma",
        "email": "priya@corp.com",
        "job_title": "Finance Lead",
        "department": "",
    }]


@pytest.mark.asyncio
async def test_the_search_asks_graph_for_the_callers_own_directory(monkeypatch):
    """
    There is no tenant parameter, so there is nothing to point at somebody
    else's organisation. Graph resolves /users against the token's own tenant.
    """
    sent = patch_graph(monkeypatch, FakeResponse())
    await graph_directory.search_people("token", "pri")

    assert sent[0]["url"] == "https://graph.microsoft.com/v1.0/users"
    assert sent[0]["headers"]["Authorization"] == "Bearer token"
    joined = " ".join(f"{k}={v}" for k, v in sent[0]["params"].items())
    assert "tenant" not in joined.lower()


@pytest.mark.asyncio
async def test_a_surname_with_an_apostrophe_does_not_break_the_query(monkeypatch):
    sent = patch_graph(monkeypatch, FakeResponse())
    await graph_directory.search_people("token", "O'Neill")

    # Doubled, which is how OData escapes a quote inside a string literal. Left
    # as a single quote it would close the literal early and change the filter.
    assert "'O''Neill'" in sent[0]["params"]["$filter"]


@pytest.mark.asyncio
async def test_odd_characters_are_stripped_before_they_reach_graph(monkeypatch):
    sent = patch_graph(monkeypatch, FakeResponse())
    await graph_directory.search_people("token", "pri) or startswith(id,'a")

    # Whatever ends up inside the quotes is the only part the caller controls,
    # so that is what must be harmless: no brackets and no commas, and the one
    # quote they typed doubled rather than left to terminate the literal.
    literal = graph_directory.clean_query("pri) or startswith(id,'a")
    assert "(" not in literal and ")" not in literal and "," not in literal
    assert literal == "pri or startswith(id'a".replace("(", "")
    assert f"startswith(displayName,'{literal.replace(chr(39), chr(39) * 2)}')" \
        in sent[0]["params"]["$filter"]


@pytest.mark.asyncio
async def test_one_character_is_not_sent_to_graph(monkeypatch):
    sent = patch_graph(monkeypatch, FakeResponse())
    result = await graph_directory.search_people("token", "p")

    assert sent == []
    assert result["people"] == []
    assert "two characters" in result["note"]


@pytest.mark.asyncio
async def test_a_refused_directory_says_so_rather_than_failing(monkeypatch):
    """
    Directory read is admin-consented in most tenants and may simply not be
    granted. That has to read as a missing permission, not as a broken page.
    """
    patch_graph(monkeypatch, FakeResponse(403))
    result = await graph_directory.search_people("token", "pri")

    assert result["people"] == []
    assert result["reason"] == graph_directory.REASON_FORBIDDEN
    assert "email address" in result["note"]


@pytest.mark.asyncio
async def test_no_graph_token_says_so_rather_than_failing(monkeypatch):
    result = await graph_directory.search_people(None, "pri")

    assert result["reason"] == graph_directory.REASON_NO_TOKEN
    assert "email address" in result["note"]


@pytest.mark.asyncio
async def test_graph_being_unreachable_is_reported_not_raised(monkeypatch):
    patch_graph(monkeypatch, RuntimeError("connection reset"))
    result = await graph_directory.search_people("token", "pri")

    assert result["reason"] == graph_directory.REASON_UPSTREAM
    assert result["people"] == []


@pytest.mark.asyncio
async def test_a_person_with_no_address_is_not_offered(monkeypatch):
    """Offering them would produce an invitation that can never be redeemed."""
    patch_graph(monkeypatch, FakeResponse(200, {"value": [
        {"id": "obj-1", "displayName": "Service Account"},
        {"id": "obj-2", "displayName": "Real Person", "mail": "real@corp.com"},
    ]}))

    result = await graph_directory.search_people("token", "re")
    assert [p["email"] for p in result["people"]] == ["real@corp.com"]


@pytest.mark.asyncio
async def test_a_person_without_a_mailbox_falls_back_to_their_sign_in_name(monkeypatch):
    patch_graph(monkeypatch, FakeResponse(200, {"value": [
        {"id": "obj-1", "displayName": "Ravi", "userPrincipalName": "ravi@corp.com"},
    ]}))

    result = await graph_directory.search_people("token", "ra")
    assert result["people"][0]["email"] == "ravi@corp.com"


# ── The role ───────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_a_person_added_as_administrator_joins_as_one(db):
    owner = await make_owner(db)
    await team_service.invite(db, owner, "priya@corp.com", "admin")

    member = await user_service.upsert_user(db, claims("oid-p", "priya@corp.com"))

    assert member["owner_id"] == owner["id"]
    assert member["workspace_role"] == "admin"


@pytest.mark.asyncio
async def test_a_person_added_as_user_joins_read_only(db):
    owner = await make_owner(db)
    await team_service.invite(db, owner, "sam@corp.com", "user")

    member = await user_service.upsert_user(db, claims("oid-s", "sam@corp.com"))
    assert member["workspace_role"] == "user"


@pytest.mark.asyncio
async def test_the_default_role_is_read_only(db):
    owner = await make_owner(db)
    await team_service.invite(db, owner, "sam@corp.com")

    member = await user_service.upsert_user(db, claims("oid-s", "sam@corp.com"))
    assert member["workspace_role"] == "user"


@pytest.mark.asyncio
async def test_an_unrecognised_role_becomes_read_only(db):
    """
    Failing towards less access is the only safe direction. A typo that grants
    administration is found out after the damage; one that grants reading is
    found out immediately, by the person it affects.
    """
    owner = await make_owner(db)
    await team_service.invite(db, owner, "sam@corp.com", "superuser")

    member = await user_service.upsert_user(db, claims("oid-s", "sam@corp.com"))
    assert member["workspace_role"] == "user"


@pytest.mark.asyncio
async def test_workspace_admin_is_not_platform_admin(db):
    """
    The whole point of keeping two columns. `role` opens the Admin Centre over
    every account on the server; sharing one workspace must never touch it.
    """
    owner = await make_owner(db)
    await team_service.invite(db, owner, "priya@corp.com", "admin")

    member = await user_service.upsert_user(db, claims("oid-p", "priya@corp.com"))
    assert member["workspace_role"] == "admin"
    assert member["role"] == "user"


@pytest.mark.asyncio
async def test_the_role_can_be_changed_after_someone_has_joined(db):
    owner = await make_owner(db)
    await team_service.invite(db, owner, "sam@corp.com", "user")
    member = await user_service.upsert_user(db, claims("oid-s", "sam@corp.com"))

    await team_service.set_member_role(db, owner["id"], member["id"], "admin")
    assert (await row(db, member["id"]))["workspace_role"] == "admin"

    await team_service.set_member_role(db, owner["id"], member["id"], "user")
    assert (await row(db, member["id"]))["workspace_role"] == "user"


@pytest.mark.asyncio
async def test_one_owner_cannot_change_a_role_in_another_workspace(db):
    owner = await make_owner(db)
    other = await user_service.upsert_user(db, claims("oid-other", "other@corp.com"))
    await team_service.invite(db, owner, "sam@corp.com", "user")
    member = await user_service.upsert_user(db, claims("oid-s", "sam@corp.com"))

    with pytest.raises(team_service.TeamError) as exc:
        await team_service.set_member_role(db, other["id"], member["id"], "admin")
    assert exc.value.status_code == 404
    assert (await row(db, member["id"]))["workspace_role"] == "user"


@pytest.mark.asyncio
async def test_removing_someone_takes_their_role_away_too(db):
    """
    So that re-adding them later starts from read-only, rather than silently
    restoring administration nobody re-considered.
    """
    owner = await make_owner(db)
    await team_service.invite(db, owner, "priya@corp.com", "admin")
    member = await user_service.upsert_user(db, claims("oid-p", "priya@corp.com"))

    await team_service.remove_member(db, owner["id"], member["id"])

    after = await row(db, member["id"])
    assert after["owner_id"] is None
    assert after["workspace_role"] == "user"


@pytest.mark.asyncio
async def test_the_role_on_a_pending_invitation_can_be_corrected(db):
    owner = await make_owner(db)
    result = await team_service.invite(db, owner, "sam@corp.com", "admin")

    await team_service.set_invitation_role(db, owner["id"], result["invitation_id"], "user")

    member = await user_service.upsert_user(db, claims("oid-s", "sam@corp.com"))
    assert member["workspace_role"] == "user"


@pytest.mark.asyncio
async def test_the_team_list_reports_the_role_of_everyone(db):
    owner = await make_owner(db)
    await team_service.invite(db, owner, "priya@corp.com", "admin")
    await user_service.upsert_user(db, claims("oid-p", "priya@corp.com"))
    await team_service.invite(db, owner, "waiting@corp.com", "user")

    listed = {m["email"]: m for m in await team_service.list_team(db, owner["id"])}

    assert listed["priya@corp.com"]["role"] == "admin"
    assert listed["priya@corp.com"]["role_label"] == "Administrator"
    assert listed["waiting@corp.com"]["role"] == "user"
    assert listed["waiting@corp.com"]["role_label"] == "User"


@pytest.mark.asyncio
async def test_a_role_is_still_refused_across_directories(db):
    """
    The role does not weaken the tenant check. Someone from another directory
    who is somehow offered an Administrator seat still cannot take it.
    """
    owner = await make_owner(db)
    await team_service.invite(db, owner, "outsider@corp.com", "admin")

    outsider = await user_service.upsert_user(
        db, claims("oid-out", "outsider@corp.com", tid="tenant-b")
    )
    assert outsider["owner_id"] is None
    assert outsider["workspace_role"] == "user"
