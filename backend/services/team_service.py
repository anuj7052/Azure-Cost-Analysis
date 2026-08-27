"""
Team membership inside one customer's workspace.

The person who registers owns a workspace: the Azure tenants they connected and
everything derived from them. They can invite colleagues from their own Entra
directory to read that workspace, so a finance team does not have to share one
login or connect the same tenant five times.

Two rules do the real work here:

* An invitation is issued to an email address, but it is *redeemed* against a
  validated token. Acceptance re-checks the Entra tenant id from that token
  against the tenant the invitation was issued from. An email address is a
  claim; the tenant id is proof. Without that check, forwarding an invite to a
  personal account would be enough to reach another company's cost data.

* Members read, they do not administer. They cannot connect or disconnect
  tenants, change stored credentials, resize a VM or alter access in Azure.
  That boundary is enforced by a dependency on the routes that do those things,
  not by hiding buttons.
"""
import aiosqlite

MAX_TEAM_MEMBERS = 5

STATUS_PENDING = "pending"
STATUS_ACCEPTED = "accepted"
STATUS_REVOKED = "revoked"

# What a person may do inside the workspace they were added to.
#
# `admin` is administrator *of this workspace*: connect and disconnect tenants,
# edit stored credentials, create resources. It is not the platform Admin
# Centre, which sees every account on the server and stays behind the separate
# `users.role` flag. Someone granting "admin" here is sharing their own
# workspace, not the whole installation.
ROLE_ADMIN = "admin"
ROLE_USER = "user"
ROLES = (ROLE_ADMIN, ROLE_USER)

ROLE_LABEL = {
    ROLE_ADMIN: "Administrator",
    ROLE_USER: "User",
}


def normalise_role(role: str | None) -> str:
    """
    An unrecognised role becomes the read-only one.

    Failing towards less access is the only safe direction here: a typo that
    granted administration would be discovered after the damage, and a typo
    that granted reading is discovered immediately by the person it affects.
    """
    value = (role or "").strip().lower()
    return value if value in ROLES else ROLE_USER


def normalise_email(email: str) -> str:
    return (email or "").strip().lower()


def workspace_id(user: aiosqlite.Row) -> int:
    """
    The account whose data this person sees.

    An owner sees their own; a member sees the owner who invited them. Every
    ownership-scoped query in the app keys off this, which is why sharing a
    workspace needed no change to those queries.
    """
    return user["owner_id"] or user["id"]


async def seat_usage(db: aiosqlite.Connection, owner_id: int) -> dict:
    """
    Seats taken and seats left, counting both directions.

    A pending invitation holds a seat. If it did not, an owner could invite
    fifty people, have five accept, and the limit would only be discovered by
    the sixth person on their first sign-in -- after they had been told they
    were welcome.
    """
    async with db.execute(
        "SELECT COUNT(*) FROM users WHERE owner_id = ?", (owner_id,)
    ) as cursor:
        accepted = (await cursor.fetchone())[0]

    async with db.execute(
        "SELECT COUNT(*) FROM team_invitations WHERE owner_id = ? AND status = ?",
        (owner_id, STATUS_PENDING),
    ) as cursor:
        pending = (await cursor.fetchone())[0]

    used = accepted + pending
    return {
        "limit": MAX_TEAM_MEMBERS,
        "accepted": accepted,
        "pending": pending,
        "used": used,
        "remaining": max(0, MAX_TEAM_MEMBERS - used),
    }


async def list_team(db: aiosqlite.Connection, owner_id: int) -> list[dict]:
    """Everyone in the workspace: accepted members first, then open invites."""
    members: list[dict] = []

    async with db.execute(
        "SELECT id, email, name, status, phone, created_at, last_login_at, login_count, "
        "workspace_role FROM users WHERE owner_id = ? ORDER BY datetime(created_at)",
        (owner_id,),
    ) as cursor:
        for row in await cursor.fetchall():
            role = normalise_role(row["workspace_role"])
            members.append({
                "id": row["id"],
                "email": row["email"],
                "name": row["name"] or "",
                "phone": row["phone"] or "",
                "state": STATUS_ACCEPTED,
                "account_status": row["status"],
                "role": role,
                "role_label": ROLE_LABEL[role],
                "joined_at": row["created_at"],
                "last_login_at": row["last_login_at"],
                "login_count": row["login_count"] or 0,
                "invitation_id": None,
            })

    async with db.execute(
        "SELECT id, email, created_at, role FROM team_invitations "
        "WHERE owner_id = ? AND status = ? ORDER BY datetime(created_at)",
        (owner_id, STATUS_PENDING),
    ) as cursor:
        for row in await cursor.fetchall():
            role = normalise_role(row["role"])
            members.append({
                "id": None,
                "email": row["email"],
                "name": "",
                "phone": "",
                "state": STATUS_PENDING,
                "account_status": "",
                "role": role,
                "role_label": ROLE_LABEL[role],
                "joined_at": None,
                "last_login_at": None,
                "login_count": 0,
                "invitation_id": row["id"],
            })

    return members


class TeamError(Exception):
    """A rejection the person who asked can act on, with an HTTP status."""

    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.message = message


async def invite(
    db: aiosqlite.Connection, owner: aiosqlite.Row, email: str,
    role: str = ROLE_USER,
) -> dict:
    """Give someone access at a chosen role, or explain why it cannot be done."""
    email = normalise_email(email)
    role = normalise_role(role)
    if not email or "@" not in email:
        raise TeamError(400, "Pick a person from your directory, or type their work email address.")

    if email == normalise_email(owner["email"]):
        raise TeamError(400, "You are already in this workspace.")

    async with db.execute(
        "SELECT id, owner_id FROM users WHERE LOWER(email) = ?", (email,)
    ) as cursor:
        account = await cursor.fetchone()

    if account is not None:
        if account["owner_id"] == owner["id"]:
            raise TeamError(409, "That person is already on your team.")
        if account["owner_id"] is not None:
            raise TeamError(409, "That person already belongs to another workspace.")
        if account["id"] == owner["id"]:
            raise TeamError(400, "You are already in this workspace.")
        # An existing account that owns its own workspace is left alone.
        # Absorbing it would silently hand its connected tenants to someone
        # else, so the two people have to sort that out between them.
        raise TeamError(
            409,
            "That person already has their own workspace. They would need to "
            "remove their connected tenants and sign up again to join yours.",
        )

    async with db.execute(
        "SELECT id, status FROM team_invitations WHERE owner_id = ? AND email = ?",
        (owner["id"], email),
    ) as cursor:
        existing = await cursor.fetchone()

    if existing is not None and existing["status"] == STATUS_PENDING:
        raise TeamError(409, "That person has already been invited.")

    usage = await seat_usage(db, owner["id"])
    if usage["remaining"] <= 0:
        raise TeamError(
            409,
            f"This workspace is limited to {MAX_TEAM_MEMBERS} team members and "
            f"all {MAX_TEAM_MEMBERS} seats are taken. Remove someone first.",
        )

    if existing is not None:
        await db.execute(
            "UPDATE team_invitations SET status = ?, created_at = datetime('now'), "
            "azure_tenant_id = ?, role = ?, accepted_at = NULL, accepted_user_id = NULL "
            "WHERE id = ?",
            (STATUS_PENDING, owner["azure_tenant_id"] or "", role, existing["id"]),
        )
        invitation_id = existing["id"]
    else:
        cursor = await db.execute(
            "INSERT INTO team_invitations (owner_id, email, azure_tenant_id, role, status) "
            "VALUES (?, ?, ?, ?, ?)",
            (owner["id"], email, owner["azure_tenant_id"] or "", role, STATUS_PENDING),
        )
        invitation_id = cursor.lastrowid

    await db.commit()
    return {"invitation_id": invitation_id, "email": email, "role": role}


async def set_member_role(
    db: aiosqlite.Connection, owner_id: int, member_id: int, role: str,
) -> str:
    """Change what an existing member may do. The owner's own role is not a
    thing that can be changed: they are the workspace."""
    role = normalise_role(role)
    async with db.execute(
        "SELECT id FROM users WHERE id = ? AND owner_id = ?", (member_id, owner_id)
    ) as cursor:
        if await cursor.fetchone() is None:
            raise TeamError(404, "That person is not on your team.")

    await db.execute(
        "UPDATE users SET workspace_role = ? WHERE id = ?", (role, member_id)
    )
    await db.commit()
    return role


async def set_invitation_role(
    db: aiosqlite.Connection, owner_id: int, invitation_id: int, role: str,
) -> str:
    """Change the role on an invitation that has not been taken up yet."""
    role = normalise_role(role)
    async with db.execute(
        "SELECT id FROM team_invitations WHERE id = ? AND owner_id = ? AND status = ?",
        (invitation_id, owner_id, STATUS_PENDING),
    ) as cursor:
        if await cursor.fetchone() is None:
            raise TeamError(404, "No such pending invitation.")

    await db.execute(
        "UPDATE team_invitations SET role = ? WHERE id = ?", (role, invitation_id)
    )
    await db.commit()
    return role


async def revoke_invitation(db: aiosqlite.Connection, owner_id: int, invitation_id: int):
    async with db.execute(
        "SELECT id FROM team_invitations WHERE id = ? AND owner_id = ? AND status = ?",
        (invitation_id, owner_id, STATUS_PENDING),
    ) as cursor:
        if await cursor.fetchone() is None:
            raise TeamError(404, "No such pending invitation.")

    await db.execute(
        "UPDATE team_invitations SET status = ? WHERE id = ?",
        (STATUS_REVOKED, invitation_id),
    )
    await db.commit()


async def remove_member(db: aiosqlite.Connection, owner_id: int, member_id: int):
    """
    Detach a member from the workspace.

    The account is not deleted. Deleting it would cascade away work that person
    did, and this operation is about revoking access, not erasing a person. They
    are left owning an empty workspace of their own, which is what they would
    have had if they had never been invited.
    """
    async with db.execute(
        "SELECT id, email FROM users WHERE id = ? AND owner_id = ?",
        (member_id, owner_id),
    ) as cursor:
        member = await cursor.fetchone()
    if member is None:
        raise TeamError(404, "That person is not on your team.")

    # The role is cleared with the membership, so re-adding them later starts
    # from read-only rather than silently restoring administration.
    await db.execute(
        "UPDATE users SET owner_id = NULL, workspace_role = ? WHERE id = ?",
        (ROLE_USER, member_id),
    )
    await db.execute(
        "UPDATE team_invitations SET status = ? WHERE owner_id = ? AND LOWER(email) = ?",
        (STATUS_REVOKED, owner_id, normalise_email(member["email"])),
    )
    await db.commit()


async def accept_pending_invitation(
    db: aiosqlite.Connection, user_id: int, email: str, azure_tenant_id: str,
) -> int | None:
    """
    Redeem an invitation on sign-in, if one is waiting and genuinely theirs.

    Returns the owner id when a workspace was joined, otherwise None. Called
    from the sign-in path, so a silent no-op is the normal case and must stay
    cheap.
    """
    email = normalise_email(email)
    if not email:
        return None

    async with db.execute(
        "SELECT i.id, i.owner_id, i.azure_tenant_id, i.role, "
        "u.azure_tenant_id AS owner_tenant "
        "FROM team_invitations i JOIN users u ON u.id = i.owner_id "
        "WHERE i.email = ? AND i.status = ? ORDER BY i.id LIMIT 1",
        (email, STATUS_PENDING),
    ) as cursor:
        invitation = await cursor.fetchone()

    if invitation is None:
        return None

    # The tenant recorded on the invitation is the one to match. Falling back to
    # the owner's current tenant covers rows written before the owner's own
    # tenant was known.
    expected = invitation["azure_tenant_id"] or invitation["owner_tenant"] or ""
    if not expected or expected != (azure_tenant_id or ""):
        # Left pending on purpose. The right person may still sign in later,
        # and turning this into an error would leak that the invite exists.
        return None

    if invitation["owner_id"] == user_id:
        return None

    # An account that has already connected a tenant of its own is not absorbed.
    # Joining would replace everything they can see with the owner's workspace,
    # which from their side looks like their data disappearing.
    for table in ("service_principals", "session_tokens"):
        async with db.execute(
            f"SELECT 1 FROM {table} WHERE user_id = ? LIMIT 1", (user_id,)
        ) as cursor:
            if await cursor.fetchone() is not None:
                return None

    usage = await seat_usage(db, invitation["owner_id"])
    if usage["accepted"] >= MAX_TEAM_MEMBERS:
        return None

    await db.execute(
        "UPDATE team_invitations SET status = ?, accepted_at = datetime('now'), "
        "accepted_user_id = ? WHERE id = ?",
        (STATUS_ACCEPTED, user_id, invitation["id"]),
    )
    await db.execute(
        "UPDATE users SET owner_id = ?, workspace_role = ? WHERE id = ?",
        (invitation["owner_id"], normalise_role(invitation["role"]), user_id),
    )
    await db.commit()
    return invitation["owner_id"]
