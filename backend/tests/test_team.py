"""
Team seats: sharing a workspace without sharing the keys to it.

The interesting failures here are not "the button was greyed out". They are:
a forwarded invitation redeemed by an outsider, a sixth person slipping past a
five-seat limit, and a member being able to disconnect the owner's tenant. Each
of those has a test below.
"""
from __future__ import annotations

import aiosqlite
import pytest
import pytest_asyncio

import core.db as db_module
from services import team_service, user_service

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


# ── Joining ────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_an_invited_colleague_joins_the_owners_workspace(db):
    owner = await make_owner(db)
    await team_service.invite(db, owner, "colleague@corp.com")

    member = await user_service.upsert_user(
        db, claims("oid-member", "colleague@corp.com")
    )

    assert member["owner_id"] == owner["id"]
    assert team_service.workspace_id(member) == owner["id"]


@pytest.mark.asyncio
async def test_the_member_reads_the_owners_connected_tenants(db):
    """
    The whole point of a seat. Ownership scoping keys off the workspace id, so
    this is what makes the owner's tenants visible without copying anything.
    """
    owner = await make_owner(db)
    await db.execute(
        "INSERT INTO service_principals (user_id, tenant_id, tenant_name, "
        "client_id, client_secret) VALUES (?, 'shared', 'Shared', 'cid', 'shh')",
        (owner["id"],),
    )
    await db.commit()
    await team_service.invite(db, owner, "colleague@corp.com")
    member = await user_service.upsert_user(
        db, claims("oid-member", "colleague@corp.com")
    )

    async with db.execute(
        "SELECT tenant_id FROM service_principals WHERE user_id = ?",
        (team_service.workspace_id(member),),
    ) as cur:
        assert [r["tenant_id"] for r in await cur.fetchall()] == ["shared"]


@pytest.mark.asyncio
async def test_the_invitation_is_case_insensitive_on_email(db):
    owner = await make_owner(db)
    await team_service.invite(db, owner, "  Colleague@Corp.com ")
    member = await user_service.upsert_user(
        db, claims("oid-member", "colleague@corp.com")
    )
    assert member["owner_id"] == owner["id"]


# ── The tenant check ───────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_a_forwarded_invitation_cannot_be_redeemed_from_another_directory(db):
    """
    An email address is a claim; the tenant id in the token is proof. Without
    this check, forwarding the invite to a personal account would be enough to
    reach another company's cost data.
    """
    owner = await make_owner(db)
    await team_service.invite(db, owner, "colleague@corp.com")

    outsider = await user_service.upsert_user(
        db, claims("oid-outsider", "colleague@corp.com", tid="some-other-tenant")
    )

    assert outsider["owner_id"] is None


@pytest.mark.asyncio
async def test_a_rejected_redemption_leaves_the_invitation_open(db):
    """The right person must still be able to sign in afterwards."""
    owner = await make_owner(db)
    await team_service.invite(db, owner, "colleague@corp.com")
    await user_service.upsert_user(
        db, claims("oid-outsider", "colleague@corp.com", tid="elsewhere")
    )

    async with db.execute(
        "SELECT status FROM team_invitations WHERE email = 'colleague@corp.com'"
    ) as cur:
        assert (await cur.fetchone())["status"] == team_service.STATUS_PENDING


# ── The seat limit ─────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_five_people_can_be_invited_and_a_sixth_cannot(db):
    owner = await make_owner(db)
    for i in range(team_service.MAX_TEAM_MEMBERS):
        await team_service.invite(db, owner, f"person{i}@corp.com")

    with pytest.raises(team_service.TeamError) as exc:
        await team_service.invite(db, owner, "one-too-many@corp.com")

    assert exc.value.status_code == 409
    assert "5" in exc.value.message


@pytest.mark.asyncio
async def test_a_pending_invitation_holds_a_seat(db):
    """
    Otherwise an owner could invite fifty people and the limit would only be
    discovered by the sixth person on their first sign-in.
    """
    owner = await make_owner(db)
    await team_service.invite(db, owner, "pending@corp.com")

    usage = await team_service.seat_usage(db, owner["id"])
    assert usage["pending"] == 1
    assert usage["remaining"] == team_service.MAX_TEAM_MEMBERS - 1


@pytest.mark.asyncio
async def test_revoking_an_invitation_frees_the_seat(db):
    owner = await make_owner(db)
    result = await team_service.invite(db, owner, "pending@corp.com")
    await team_service.revoke_invitation(db, owner["id"], result["invitation_id"])

    usage = await team_service.seat_usage(db, owner["id"])
    assert usage["used"] == 0
    assert usage["remaining"] == team_service.MAX_TEAM_MEMBERS


@pytest.mark.asyncio
async def test_a_sixth_person_cannot_slip_in_past_an_accepted_five(db):
    owner = await make_owner(db)
    for i in range(team_service.MAX_TEAM_MEMBERS):
        await team_service.invite(db, owner, f"person{i}@corp.com")
        await user_service.upsert_user(db, claims(f"oid-{i}", f"person{i}@corp.com"))

    # Force a sixth invitation past the API guard, the way a race or a stale
    # tab could, and check acceptance refuses it too.
    await db.execute(
        "INSERT INTO team_invitations (owner_id, email, azure_tenant_id, status) "
        "VALUES (?, 'sneak@corp.com', ?, 'pending')",
        (owner["id"], TENANT),
    )
    await db.commit()

    sneak = await user_service.upsert_user(db, claims("oid-sneak", "sneak@corp.com"))
    assert sneak["owner_id"] is None


# ── Refusals that protect existing data ────────────────────────────────────

@pytest.mark.asyncio
async def test_someone_who_already_owns_a_workspace_is_not_absorbed(db):
    owner = await make_owner(db)
    await user_service.upsert_user(db, claims("oid-other", "other@corp.com"))

    with pytest.raises(team_service.TeamError) as exc:
        await team_service.invite(db, owner, "other@corp.com")
    assert exc.value.status_code == 409


@pytest.mark.asyncio
async def test_an_account_with_its_own_tenant_does_not_join_on_a_later_invite(db):
    """
    The invite is written before that account exists, so acceptance has to
    re-check. Joining would replace everything they can see with the owner's
    workspace, which from their side looks like their data vanishing.
    """
    owner = await make_owner(db)
    late = await user_service.upsert_user(db, claims("oid-late", "late@corp.com"))
    await db.execute(
        "INSERT INTO service_principals (user_id, tenant_id, tenant_name, "
        "client_id, client_secret) VALUES (?, 'theirs', 'Theirs', 'cid', 'shh')",
        (late["id"],),
    )
    await db.execute(
        "INSERT INTO team_invitations (owner_id, email, azure_tenant_id, status) "
        "VALUES (?, 'late@corp.com', ?, 'pending')",
        (owner["id"], TENANT),
    )
    await db.commit()

    again = await user_service.upsert_user(db, claims("oid-late", "late@corp.com"))
    assert again["owner_id"] is None


@pytest.mark.asyncio
async def test_inviting_yourself_is_refused(db):
    owner = await make_owner(db)
    with pytest.raises(team_service.TeamError):
        await team_service.invite(db, owner, "owner@corp.com")


@pytest.mark.asyncio
async def test_inviting_the_same_person_twice_is_refused(db):
    owner = await make_owner(db)
    await team_service.invite(db, owner, "colleague@corp.com")
    with pytest.raises(team_service.TeamError) as exc:
        await team_service.invite(db, owner, "colleague@corp.com")
    assert exc.value.status_code == 409


@pytest.mark.asyncio
async def test_an_invalid_email_is_refused(db):
    owner = await make_owner(db)
    with pytest.raises(team_service.TeamError):
        await team_service.invite(db, owner, "not-an-email")


# ── Removal ────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_removing_a_member_revokes_access_without_deleting_them(db):
    owner = await make_owner(db)
    await team_service.invite(db, owner, "colleague@corp.com")
    member = await user_service.upsert_user(
        db, claims("oid-member", "colleague@corp.com")
    )

    await team_service.remove_member(db, owner["id"], member["id"])

    after = await row(db, member["id"])
    assert after is not None, "the account must survive; this revokes access"
    assert after["owner_id"] is None


@pytest.mark.asyncio
async def test_a_removed_member_does_not_silently_rejoin_on_next_sign_in(db):
    owner = await make_owner(db)
    await team_service.invite(db, owner, "colleague@corp.com")
    member = await user_service.upsert_user(
        db, claims("oid-member", "colleague@corp.com")
    )
    await team_service.remove_member(db, owner["id"], member["id"])

    again = await user_service.upsert_user(db, claims("oid-member", "colleague@corp.com"))
    assert again["owner_id"] is None


@pytest.mark.asyncio
async def test_removing_a_member_frees_the_seat(db):
    owner = await make_owner(db)
    await team_service.invite(db, owner, "colleague@corp.com")
    member = await user_service.upsert_user(
        db, claims("oid-member", "colleague@corp.com")
    )
    await team_service.remove_member(db, owner["id"], member["id"])

    usage = await team_service.seat_usage(db, owner["id"])
    assert usage["remaining"] == team_service.MAX_TEAM_MEMBERS


@pytest.mark.asyncio
async def test_you_cannot_remove_someone_from_another_workspace(db):
    owner = await make_owner(db)
    other = await user_service.upsert_user(db, claims("oid-other", "other@corp.com"))
    await team_service.invite(db, other, "theirs@corp.com")
    theirs = await user_service.upsert_user(db, claims("oid-theirs", "theirs@corp.com"))

    with pytest.raises(team_service.TeamError) as exc:
        await team_service.remove_member(db, owner["id"], theirs["id"])
    assert exc.value.status_code == 404


# ── Tracking for the admin centre ──────────────────────────────────────────

@pytest.mark.asyncio
async def test_sign_ins_are_counted(db):
    user = await user_service.upsert_user(db, claims("oid-1", "a@corp.com"))
    assert user["login_count"] == 1

    for _ in range(3):
        user = await user_service.upsert_user(db, claims("oid-1", "a@corp.com"))
    assert user["login_count"] == 4


@pytest.mark.asyncio
async def test_a_new_account_has_no_phone_number_recorded(db):
    """
    Entra sign-in tokens carry no phone number, so it starts empty and the
    admin centre must say so rather than invent one.
    """
    user = await user_service.upsert_user(db, claims("oid-1", "a@corp.com"))
    assert user["phone"] == ""


# ── Members read, they do not administer ───────────────────────────────────

@pytest.mark.asyncio
async def test_a_member_is_refused_by_the_owner_only_gate():
    """
    This gate gets attached to disconnecting a tenant, editing stored
    credentials, resizing a VM and changing access in Azure. A seat shares a
    view; it does not hand out the owner's keys.
    """
    from fastapi import HTTPException
    from auth.dependencies import require_workspace_owner

    with pytest.raises(HTTPException) as exc:
        await require_workspace_owner({"is_owner": False})
    assert exc.value.status_code == 403
    assert "owner" in exc.value.detail.lower()


@pytest.mark.asyncio
async def test_the_owner_passes_the_owner_only_gate():
    from auth.dependencies import require_workspace_owner

    caller = {"is_owner": True}
    assert await require_workspace_owner(caller) is caller


@pytest.mark.asyncio
async def test_every_state_changing_route_that_touches_azure_is_gated():
    """
    Pins the list. A new route that connects a tenant or changes Azure has to
    be added here deliberately, rather than shipping open to team members
    because nobody remembered the dependency.
    """
    import main
    from auth.dependencies import require_workspace_admin, require_workspace_owner

    # Both gates count as "not open to a plain member". They differ in how far
    # they open: an administrator of the workspace can change Azure, only the
    # owner can change who is in the workspace. Which routes sit behind which
    # is pinned separately below.
    gates = {require_workspace_admin, require_workspace_owner}

    expected = {
        ("POST", "/api/v1/tenants"),
        ("POST", "/api/v1/tenants/token"),
        ("DELETE", "/api/v1/tenants/{tenant_id}"),
        ("POST", "/api/v1/integrations"),
        ("PATCH", "/api/v1/integrations/{integration_id}"),
        ("DELETE", "/api/v1/integrations/{integration_id}"),
        ("POST", "/api/v1/compute/resize"),
        ("POST", "/api/v1/security/access/grant"),
        ("POST", "/api/v1/security/access/revoke"),
        ("POST", "/api/v1/team/invitations"),
        ("DELETE", "/api/v1/team/invitations/{invitation_id}"),
        ("DELETE", "/api/v1/team/members/{member_id}"),
        ("PATCH", "/api/v1/team/members/{member_id}/role"),
        ("PATCH", "/api/v1/team/invitations/{invitation_id}/role"),
        ("GET", "/api/v1/team/directory"),
        # Creates resources and starts a recurring charge — the single most
        # consequential write in the product.
        ("POST", "/api/v1/provision/deploy"),
    }

    gated = set()
    owner_only = set()
    for route in main.app.routes:
        dependencies = getattr(route, "dependant", None)
        if dependencies is None:
            continue
        calls = {d.call for d in route.dependant.dependencies}
        if calls & gates:
            for method in route.methods - {"HEAD", "OPTIONS"}:
                gated.add((method, route.path))
        if require_workspace_owner in calls:
            for method in route.methods - {"HEAD", "OPTIONS"}:
                owner_only.add((method, route.path))

    assert expected <= gated, f"no longer gated: {expected - gated}"

    # Handing someone the Administrator role must not let them hand it on, or
    # remove the person who gave it to them. Seat management stays with the
    # owner.
    seats = {
        ("POST", "/api/v1/team/invitations"),
        ("DELETE", "/api/v1/team/invitations/{invitation_id}"),
        ("DELETE", "/api/v1/team/members/{member_id}"),
        ("PATCH", "/api/v1/team/members/{member_id}/role"),
        ("PATCH", "/api/v1/team/invitations/{invitation_id}/role"),
    }
    assert seats <= owner_only, f"seat management leaked: {seats - owner_only}"

