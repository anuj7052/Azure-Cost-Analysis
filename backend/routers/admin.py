"""
Admin center.

Every route here requires an administrator, enforced once by the router-level
dependency rather than repeated per handler. Credentials are never returned:
an admin can see *that* a customer connected a tenant and can revoke it, but
not read their client secret or access token.
"""
import aiosqlite
from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, Depends, HTTPException, Query

from auth.dependencies import require_admin
from core.db import get_db
from models.schemas import (
    UpdateUserRequest, UserConnection, UserDetail, UserSummary,
)
from services.user_service import ROLE_ADMIN, STATUS_SUSPENDED, tenant_counts

router = APIRouter(
    prefix="/api/admin",
    tags=["admin"],
    dependencies=[Depends(require_admin)],
)


def _summary(
    row: aiosqlite.Row,
    tenant_count: int = 0,
    owner_email: str = "",
    team_size: int = 0,
) -> UserSummary:
    return UserSummary(
        id=row["id"],
        email=row["email"],
        name=row["name"],
        role=row["role"],
        status=row["status"],
        azure_tenant_id=row["azure_tenant_id"],
        created_at=row["created_at"],
        last_login_at=row["last_login_at"],
        tenant_count=tenant_count,
        phone=row["phone"] or "",
        login_count=row["login_count"] or 0,
        days_since_registered=_days_since(row["created_at"]),
        access_level="Administrator" if row["role"] == ROLE_ADMIN else "Standard",
        is_owner=row["owner_id"] is None,
        owner_email=owner_email,
        team_size=team_size,
    )


def _days_since(created_at: str | None) -> int | None:
    """
    Whole days between registration and now.

    Returns None rather than 0 when the timestamp is missing or unparseable,
    because "registered today" and "we do not know" are different answers and
    the admin centre shows them differently.
    """
    if not created_at:
        return None
    try:
        started = datetime.fromisoformat(str(created_at).replace("Z", "+00:00"))
    except ValueError:
        return None
    if started.tzinfo is None:
        started = started.replace(tzinfo=timezone.utc)
    return max(0, (datetime.now(timezone.utc) - started).days)


async def _owner_emails(db: aiosqlite.Connection) -> dict[int, str]:
    async with db.execute("SELECT id, email FROM users") as cursor:
        return {row["id"]: row["email"] or "" for row in await cursor.fetchall()}


async def _team_sizes(db: aiosqlite.Connection) -> dict[int, int]:
    async with db.execute(
        "SELECT owner_id, COUNT(*) AS n FROM users "
        "WHERE owner_id IS NOT NULL GROUP BY owner_id"
    ) as cursor:
        return {row["owner_id"]: row["n"] for row in await cursor.fetchall()}


async def _get_user(db: aiosqlite.Connection, user_id: int) -> aiosqlite.Row:
    async with db.execute("SELECT * FROM users WHERE id = ?", (user_id,)) as cursor:
        row = await cursor.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="No such user.")
    return row


async def _count_admins(db: aiosqlite.Connection, exclude_id: int) -> int:
    async with db.execute(
        "SELECT COUNT(*) FROM users WHERE role = ? AND status = 'active' AND id != ?",
        (ROLE_ADMIN, exclude_id),
    ) as cursor:
        return (await cursor.fetchone())[0]


async def _guard_last_admin(db: aiosqlite.Connection, user: aiosqlite.Row, action: str):
    """
    Refuse to leave the platform with no administrator.

    Without this, an admin can lock everyone out of the admin center with a
    single click and the only way back in is editing the database by hand.
    """
    if user["role"] != ROLE_ADMIN:
        return
    if await _count_admins(db, user["id"]) == 0:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Cannot {action} the last administrator. "
                "Promote another user to admin first."
            ),
        )


@router.get("/users", response_model=list[UserSummary])
async def list_users(
    q: str = Query("", description="Filter by name or email"),
    status_filter: str = Query("", alias="status"),
    db: aiosqlite.Connection = Depends(get_db),
):
    sql = "SELECT * FROM users"
    clauses, params = [], []
    if q:
        clauses.append("(LOWER(email) LIKE ? OR LOWER(name) LIKE ?)")
        needle = f"%{q.lower()}%"
        params += [needle, needle]
    if status_filter:
        clauses.append("status = ?")
        params.append(status_filter)
    if clauses:
        sql += " WHERE " + " AND ".join(clauses)
    sql += " ORDER BY datetime(created_at) DESC"

    async with db.execute(sql, params) as cursor:
        rows = await cursor.fetchall()

    counts = await tenant_counts(db)
    emails = await _owner_emails(db)
    sizes = await _team_sizes(db)
    return [
        _summary(
            r,
            counts.get(r["id"], 0),
            emails.get(r["owner_id"], "") if r["owner_id"] else "",
            sizes.get(r["id"], 0),
        )
        for r in rows
    ]


@router.get("/stats")
async def stats(db: aiosqlite.Connection = Depends(get_db)):
    async def scalar(sql: str, params=()):
        async with db.execute(sql, params) as cursor:
            return (await cursor.fetchone())[0]

    # Computed here rather than written as a SQL interval, because that is
    # spelled differently by SQLite and Postgres while a parameter is not.
    thirty_days_ago = (datetime.now(timezone.utc) - timedelta(days=30)).strftime(
        "%Y-%m-%d %H:%M:%S"
    )

    return {
        "total_users": await scalar("SELECT COUNT(*) FROM users"),
        "active_users": await scalar(
            "SELECT COUNT(*) FROM users WHERE status = 'active'"),
        "suspended_users": await scalar(
            "SELECT COUNT(*) FROM users WHERE status = 'suspended'"),
        "admins": await scalar(
            "SELECT COUNT(*) FROM users WHERE role = 'admin'"),
        "connected_tenants": (
            await scalar("SELECT COUNT(*) FROM service_principals")
            + await scalar("SELECT COUNT(*) FROM session_tokens")
        ),
        "new_users_30d": await scalar(
            "SELECT COUNT(*) FROM users WHERE created_at >= ?", (thirty_days_ago,)
        ),
        # Someone who has signed in at least once in the last 30 days. This is
        # the closest thing to "actively using it" the app can prove, because
        # only the most recent sign-in is recorded, not a per-day history.
        "active_last_30d": await scalar(
            "SELECT COUNT(*) FROM users WHERE last_login_at IS NOT NULL "
            "AND last_login_at >= ?", (thirty_days_ago,)
        ),
        "never_signed_in": await scalar(
            "SELECT COUNT(*) FROM users WHERE last_login_at IS NULL"
        ),
        "workspace_owners": await scalar(
            "SELECT COUNT(*) FROM users WHERE owner_id IS NULL"
        ),
        "team_members": await scalar(
            "SELECT COUNT(*) FROM users WHERE owner_id IS NOT NULL"
        ),
        "pending_invitations": await scalar(
            "SELECT COUNT(*) FROM team_invitations WHERE status = 'pending'"
        ),
        # Compliance reads on this one: an account with no contact number
        # cannot be reached outside the app.
        "missing_phone": await scalar(
            "SELECT COUNT(*) FROM users WHERE phone IS NULL OR phone = ''"
        ),
    }


@router.get("/users/{user_id}", response_model=UserDetail)
async def get_user(user_id: int, db: aiosqlite.Connection = Depends(get_db)):
    row = await _get_user(db, user_id)
    counts = await tenant_counts(db)
    emails = await _owner_emails(db)
    sizes = await _team_sizes(db)

    connections: list[UserConnection] = []
    async with db.execute(
        "SELECT tenant_id, tenant_name, created_at FROM service_principals WHERE user_id = ?",
        (user_id,),
    ) as cursor:
        for r in await cursor.fetchall():
            connections.append(UserConnection(
                tenant_id=r["tenant_id"],
                tenant_name=r["tenant_name"],
                source="service_principal",
                created_at=r["created_at"],
            ))

    async with db.execute(
        "SELECT tenant_id, tenant_name, created_at, expires_at, account "
        "FROM session_tokens WHERE user_id = ?",
        (user_id,),
    ) as cursor:
        for r in await cursor.fetchall():
            connections.append(UserConnection(
                tenant_id=r["tenant_id"],
                tenant_name=r["tenant_name"],
                source="session_token",
                created_at=r["created_at"],
                expires_at=r["expires_at"],
                account=r["account"],
            ))

    return UserDetail(
        **_summary(
            row,
            counts.get(user_id, 0),
            emails.get(row["owner_id"], "") if row["owner_id"] else "",
            sizes.get(user_id, 0),
        ).model_dump(),
        connections=connections,
    )


@router.patch("/users/{user_id}", response_model=UserSummary)
async def update_user(
    user_id: int,
    body: UpdateUserRequest,
    db: aiosqlite.Connection = Depends(get_db),
    admin: dict = Depends(require_admin),
):
    """Change a user's role or suspend/reinstate them."""
    row = await _get_user(db, user_id)

    if body.role is None and body.status is None:
        raise HTTPException(status_code=400, detail="Nothing to update.")

    if user_id == admin["actor_id"]:
        if body.role and body.role != ROLE_ADMIN:
            raise HTTPException(
                status_code=409,
                detail="You cannot remove your own administrator rights.",
            )
        if body.status == STATUS_SUSPENDED:
            raise HTTPException(
                status_code=409, detail="You cannot suspend your own account.",
            )

    if body.role and body.role != ROLE_ADMIN:
        await _guard_last_admin(db, row, "demote")
    if body.status == STATUS_SUSPENDED:
        await _guard_last_admin(db, row, "suspend")

    if body.role:
        await db.execute("UPDATE users SET role = ? WHERE id = ?", (body.role, user_id))
    if body.status:
        await db.execute("UPDATE users SET status = ? WHERE id = ?", (body.status, user_id))
    await db.commit()

    updated = await _get_user(db, user_id)
    counts = await tenant_counts(db)
    return _summary(updated, counts.get(user_id, 0))


@router.delete("/users/{user_id}", status_code=204)
async def delete_user(
    user_id: int,
    db: aiosqlite.Connection = Depends(get_db),
    admin: dict = Depends(require_admin),
):
    """
    Permanently remove a user and every credential they stored.

    Irreversible, and deliberately separate from suspending. The cascade on
    user_id means their service principals and session tokens go with them, so
    deleting an account cannot leave live Azure credentials behind.
    """
    row = await _get_user(db, user_id)

    if user_id == admin["actor_id"]:
        raise HTTPException(status_code=409, detail="You cannot delete your own account.")
    await _guard_last_admin(db, row, "delete")

    await db.execute("DELETE FROM service_principals WHERE user_id = ?", (user_id,))
    await db.execute("DELETE FROM session_tokens WHERE user_id = ?", (user_id,))
    await db.execute("DELETE FROM users WHERE id = ?", (user_id,))
    await db.commit()
