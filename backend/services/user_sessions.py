"""
When people were signed in, and for how long.

The purpose is narrow and stated on purpose, because "we might want it later"
is not a purpose and is the thing data-protection law actually prohibits. Two
uses, both declared to the person before anything is written:

  * To contact them about the product and ask what they think of it.
  * To see how the app is used -- which parts get opened, how often -- so the
    next thing built is the thing people reach for.

That is why there is no page-by-page trail here. "How often is this app used"
is answered by sessions; "what did this person look at on Tuesday" is a
different and much larger claim on somebody's privacy, and nothing we are
building needs it.

Three rules hold this together:

  * Consent gates the collection, not the display. Name and email arrive
    inside the Entra token and are what makes an account work at all. A phone
    number, an employer and a session history do not, and the first is being
    kept in order to contact somebody -- which is precisely the case where an
    opt-in is not optional. Nothing is stored until they agree, and
    withdrawing erases what agreeing allowed.

  * The address is hashed, never stored in the clear. That is
    pseudonymisation, not anonymisation -- it is still personal data and is
    still deleted on request -- but a copy of this table is then not a list of
    where our customers work from.

  * Rows expire. Ninety days is long enough to see a usage pattern and short
    enough that the app is not quietly accumulating a permanent movement
    history. Retention that is written down but never runs is worse than no
    retention, so the sweep runs on startup and is tested.
"""
from __future__ import annotations

import hashlib
from typing import Any

import aiosqlite

from core.config import settings

# How long a session record is kept. See the module docstring for why this is
# a number and not "indefinitely".
RETENTION_DAYS = 90

# Long enough to say "Chrome on Windows", short enough not to be a
# fingerprint. The full string is a well-known tracking surface and we have no
# use for the parts past this.
_UA_MAX = 120

# A new request from the same person within this many minutes is treated as
# the same visit. Without it, every page load would open a session and the
# history would be noise rather than a record anyone could read.
CONTINUATION_MINUTES = 30


def hash_ip(ip: str) -> str:
    """
    A keyed digest of an address.

    Keyed with the application secret rather than a bare SHA-256, because the
    entire IPv4 space can be hashed on a laptop in minutes -- an unkeyed digest
    of an address is reversible by anyone who bothers, and would be storing it
    in the clear while looking as though it were not.
    """
    if not ip:
        return ""
    return hashlib.sha256(
        f"{settings.APP_SECRET_KEY}:{ip}".encode("utf-8")
    ).hexdigest()[:32]


async def has_consented(db: aiosqlite.Connection, user_id: int) -> bool:
    async with db.execute(
        "SELECT profile_consent_at FROM users WHERE id = ?", (user_id,)
    ) as cursor:
        row = await cursor.fetchone()
    return bool(row and row["profile_consent_at"])


async def record_activity(
    db: aiosqlite.Connection,
    user_id: int,
    *,
    ip: str = "",
    user_agent: str = "",
) -> int | None:
    """
    Note that this person is active, continuing their current session or
    opening a new one.

    Returns None, and writes nothing at all, when consent has not been given.
    A silent no-op is deliberate: the caller should not have to remember to
    ask, because the one time it is forgotten is the time we keep data we were
    not allowed to keep.
    """
    if not await has_consented(db, user_id):
        return None

    async with db.execute(
        "SELECT id FROM user_sessions "
        "WHERE user_id = ? AND ended_at IS NULL "
        f"AND last_seen_at > datetime('now', '-{CONTINUATION_MINUTES} minutes') "
        "ORDER BY id DESC LIMIT 1",
        (user_id,),
    ) as cursor:
        row = await cursor.fetchone()

    if row:
        await db.execute(
            "UPDATE user_sessions SET last_seen_at = datetime('now') WHERE id = ?",
            (row["id"],),
        )
        await db.commit()
        return row["id"]

    cursor = await db.execute(
        "INSERT INTO user_sessions (user_id, user_agent, ip_hash) VALUES (?, ?, ?)",
        (user_id, (user_agent or "")[:_UA_MAX], hash_ip(ip)),
    )
    await db.commit()
    return cursor.lastrowid


async def end_session(db: aiosqlite.Connection, user_id: int) -> None:
    """
    Close whatever this person had open.

    Closes every open row rather than the newest, because a session left open
    on another device is exactly what someone signing out is trying to end.
    """
    await db.execute(
        "UPDATE user_sessions SET ended_at = datetime('now'), "
        "last_seen_at = datetime('now') "
        "WHERE user_id = ? AND ended_at IS NULL",
        (user_id,),
    )
    await db.commit()


async def list_sessions(
    db: aiosqlite.Connection, user_id: int, limit: int = 50
) -> list[dict[str, Any]]:
    """This person's own history, newest first."""
    async with db.execute(
        "SELECT id, started_at, last_seen_at, ended_at, user_agent "
        "FROM user_sessions WHERE user_id = ? ORDER BY id DESC LIMIT ?",
        (user_id, max(1, min(limit, 200))),
    ) as cursor:
        rows = await cursor.fetchall()

    return [
        {
            "id": r["id"],
            "started_at": r["started_at"],
            "last_seen_at": r["last_seen_at"],
            "ended_at": r["ended_at"],
            "active": r["ended_at"] is None,
            "device": r["user_agent"] or "Not available",
        }
        for r in rows
    ]


async def purge_expired(db: aiosqlite.Connection) -> int:
    """
    Delete session rows past the retention period. Returns how many went.

    Called on startup rather than from a scheduler because this deployment has
    no scheduler, and a retention policy that depends on infrastructure which
    does not exist is a policy that has not been implemented.
    """
    cursor = await db.execute(
        f"DELETE FROM user_sessions WHERE started_at < datetime('now', '-{RETENTION_DAYS} days')"
    )
    await db.commit()
    return cursor.rowcount or 0


async def forget_optional_data(db: aiosqlite.Connection, user_id: int) -> None:
    """
    Withdraw consent: erase everything that consent was covering.

    The account itself survives, because it is what signs the person in and is
    not held under consent. Leaving the phone number and the session history
    behind while flipping a flag would be keeping data the person just told us
    to stop keeping.
    """
    await db.execute("DELETE FROM user_sessions WHERE user_id = ?", (user_id,))
    await db.execute(
        "UPDATE users SET phone = '', company = '', profile_consent_at = NULL "
        "WHERE id = ?",
        (user_id,),
    )
    await db.commit()


async def export_for(db: aiosqlite.Connection, user_id: int) -> dict[str, Any]:
    """
    Everything held about one person, in a form they can read.

    A subject access request answered with a database dump is not an answer,
    so the field names here are the ones used in the interface, and the
    hashed address is described rather than printed -- a digest tells the
    person nothing about themselves and would only look like a secret.
    """
    async with db.execute(
        "SELECT id, email, name, phone, company, role, status, created_at, "
        "login_count, last_login_at, profile_consent_at, azure_tenant_id "
        "FROM users WHERE id = ?",
        (user_id,),
    ) as cursor:
        user = await cursor.fetchone()

    if not user:
        return {}

    return {
        "account": {
            "id": user["id"],
            "name": user["name"],
            "email": user["email"],
            "phone": user["phone"] or "Not provided",
            "company": user["company"] or "Not provided",
            "azure_tenant_id": user["azure_tenant_id"],
            "role": user["role"],
            "status": user["status"],
            "created_at": user["created_at"],
            "sign_in_count": user["login_count"],
            "last_sign_in": user["last_login_at"] or "Not available",
            "consent_given_at": user["profile_consent_at"] or "Not given",
        },
        "sessions": await list_sessions(db, user_id, limit=200),
        "notes": {
            "why_we_hold_this": (
                "To contact you about the product and ask for your feedback, "
                "and to understand how the app is used. Nothing else."
            ),
            "retention": f"Session records are deleted after {RETENTION_DAYS} days.",
            "ip_addresses": (
                "Stored only as a keyed one-way hash, never as an address, "
                "and deleted with the session record."
            ),
            "azure_data": (
                "Your Azure cost and resource data is read from Azure each "
                "time you ask and is not stored by this application."
            ),
        },
    }
