"""
Account records for the people who sign in.

The app authenticates against Entra ID, so identity itself is never stored here
— no passwords, no password resets. This module only keeps the local record
that lets the product answer "who are my customers, what have they connected,
and should they still have access".
"""
import aiosqlite

from core.config import settings
from services.team_service import accept_pending_invitation

ROLE_ADMIN = "admin"
ROLE_USER = "user"
STATUS_ACTIVE = "active"
STATUS_SUSPENDED = "suspended"


def is_allowlisted_admin(email: str) -> bool:
    return bool(email) and email.strip().lower() in settings.admin_emails_list


async def _claim_orphaned_rows(db: aiosqlite.Connection, user_id: int):
    """
    Adopt credentials stored before ownership existed.

    Only the very first account can inherit them, so a single-user install keeps
    its tenants across the upgrade without those credentials ever leaking to the
    second person who signs up.
    """
    async with db.execute("SELECT COUNT(*) FROM users") as cursor:
        row = await cursor.fetchone()
    if row[0] != 1:
        return

    for table in ("service_principals", "session_tokens"):
        await db.execute(
            f"UPDATE {table} SET user_id = ? WHERE user_id IS NULL", (user_id,)
        )


async def upsert_user(db: aiosqlite.Connection, claims: dict) -> aiosqlite.Row:
    """
    Find or create the account for a validated token, and refresh its profile.

    Called on every authenticated request, so it must stay cheap and must never
    downgrade an admin that the allowlist still names.
    """
    oid = claims.get("user_id")
    if not oid:
        raise ValueError("Token carries no object id (oid/sub) to identify the user.")

    email = claims.get("email", "") or ""
    name = claims.get("name", "") or ""
    azure_tenant_id = claims.get("tenant_id", "") or ""
    role = ROLE_ADMIN if is_allowlisted_admin(email) else None

    async with db.execute("SELECT * FROM users WHERE azure_oid = ?", (oid,)) as cursor:
        existing = await cursor.fetchone()

    if existing is None:
        await db.execute(
            """
            INSERT INTO users (azure_oid, email, name, azure_tenant_id, role,
                               status, login_count, last_login_at)
            VALUES (?, ?, ?, ?, ?, ?, 1, datetime('now'))
            """,
            (oid, email, name, azure_tenant_id, role or ROLE_USER, STATUS_ACTIVE),
        )
        await db.commit()

        async with db.execute("SELECT * FROM users WHERE azure_oid = ?", (oid,)) as cursor:
            created = await cursor.fetchone()

        # Order matters. A person who was invited must not adopt the orphaned
        # credentials of a single-user install: they are joining someone
        # else's workspace, not inheriting one.
        joined = await accept_pending_invitation(db, created["id"], email, azure_tenant_id)
        if joined is None:
            await _claim_orphaned_rows(db, created["id"])
            await db.commit()

        async with db.execute("SELECT * FROM users WHERE id = ?", (created["id"],)) as cursor:
            return await cursor.fetchone()

    # The allowlist can promote, but never demotes here: an admin promoted by
    # another admin in the UI would otherwise be reset on their next request.
    # Demotion is an explicit action in the admin center.
    new_role = ROLE_ADMIN if role else existing["role"]

    await db.execute(
        """
        UPDATE users
           SET email = ?, name = ?, azure_tenant_id = ?, role = ?,
               login_count = COALESCE(login_count, 0) + 1,
               last_login_at = datetime('now')
         WHERE id = ?
        """,
        (email, name, azure_tenant_id, new_role, existing["id"]),
    )
    await db.commit()

    # An invitation sent after this person had already signed in is redeemed on
    # their next visit rather than being left stranded.
    if existing["owner_id"] is None:
        await accept_pending_invitation(db, existing["id"], email, azure_tenant_id)

    async with db.execute("SELECT * FROM users WHERE id = ?", (existing["id"],)) as cursor:
        return await cursor.fetchone()


async def tenant_counts(db: aiosqlite.Connection) -> dict[int, int]:
    """Connected-tenant count per user id, for the admin list."""
    counts: dict[int, int] = {}
    for table in ("service_principals", "session_tokens"):
        async with db.execute(
            f"SELECT user_id, COUNT(*) AS n FROM {table} "
            "WHERE user_id IS NOT NULL GROUP BY user_id"
        ) as cursor:
            for row in await cursor.fetchall():
                counts[row["user_id"]] = counts.get(row["user_id"], 0) + row["n"]
    return counts
