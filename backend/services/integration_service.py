"""
Endpoints and models a customer brings themselves.

Everything here is scoped to the signed-in account. A user may register their
own OpenAI or Azure OpenAI deployment, an API gateway in front of one, or a
plain webhook, and the assistant then runs on their key and their quota rather
than the shared server key.

Keys are write-only over the API: they can be set and replaced, never read
back. Callers get a masked hint instead, which is enough to recognise a key
without being enough to use it.

Every endpoint carries a daily request ceiling, and registering one without
saying what that ceiling should be is refused. The key is the customer's and
so is the invoice; an endpoint with no ceiling turns a mistake in a loop into
a charge they find out about at the end of the month.
"""

from datetime import date
from typing import Any, Dict, List, Optional

import aiosqlite

from core.config import settings

KINDS = ("openai", "azure_openai", "webhook", "custom")

# Kinds the BOQ assistant can actually talk to. A webhook is stored for the
# customer's own use but is not an OpenAI-compatible chat endpoint.
LLM_KINDS = ("openai", "azure_openai", "custom")

# A floor and a ceiling on the ceiling. One request a day is a usable way to
# park an endpoint; the upper bound is not a policy, it is a typo guard, so
# that a stray keypress cannot turn 50 into 50000000.
MIN_RATE_LIMIT = 1
MAX_RATE_LIMIT = 100000


def mask(key: str) -> str:
    """Show just enough of a key to recognise it, never enough to use it."""
    if not key:
        return ""
    tail = key[-4:] if len(key) >= 8 else ""
    return f"••••{tail}" if tail else "••••"


def to_public(row: aiosqlite.Row, used_today: int = 0) -> Dict[str, Any]:
    limit = row["rate_limit_per_day"] or 0
    return {
        "id": row["id"],
        "label": row["label"],
        "kind": row["kind"],
        "base_url": row["base_url"],
        "model": row["model"],
        "enabled": bool(row["enabled"]),
        "has_key": bool(row["api_key"]),
        "key_hint": mask(row["api_key"]),
        "rate_limit_per_day": limit,
        "used_today": used_today,
        # Reported rather than derived in the UI so that the number the
        # customer reads and the number the server enforces cannot drift.
        "remaining_today": max(0, limit - used_today) if limit else 0,
        "created_at": row["created_at"],
    }


def _today() -> str:
    return date.today().isoformat()


async def usage_today(db: aiosqlite.Connection, integration_id: int) -> int:
    async with db.execute(
        "SELECT calls FROM integration_usage WHERE integration_id = ? AND day = ?",
        (integration_id, _today()),
    ) as cursor:
        row = await cursor.fetchone()
    return int(row["calls"]) if row else 0


async def _usage_map(db: aiosqlite.Connection, user_id: int) -> Dict[int, int]:
    async with db.execute(
        """SELECT u.integration_id AS id, u.calls AS calls
             FROM integration_usage u
             JOIN user_integrations i ON i.id = u.integration_id
            WHERE i.user_id = ? AND u.day = ?""",
        (user_id, _today()),
    ) as cursor:
        return {row["id"]: int(row["calls"]) for row in await cursor.fetchall()}


def validate_rate_limit(value: Any) -> int:
    """
    Turn whatever arrived on the wire into a usable daily ceiling, or refuse.

    Refusing is deliberate. Defaulting a missing limit to "unlimited" would
    quietly remove the protection, and defaulting it to some number the
    customer never chose would be us deciding how much of their money to
    spend. Neither is ours to decide, so the answer is required.
    """
    if value is None or value == "":
        raise ValueError(
            "Set a daily request limit for this endpoint. It caps how many "
            "requests the assistant may send against your key in one day."
        )
    try:
        limit = int(value)
    except (TypeError, ValueError):
        raise ValueError("The daily request limit must be a whole number.") from None
    if limit < MIN_RATE_LIMIT or limit > MAX_RATE_LIMIT:
        raise ValueError(
            f"The daily request limit must be between {MIN_RATE_LIMIT} "
            f"and {MAX_RATE_LIMIT:,} requests."
        )
    return limit


class RateLimitExceeded(Exception):
    """The customer's own ceiling was reached — not an upstream error."""

    def __init__(self, label: str, limit: int) -> None:
        self.label = label
        self.limit = limit
        super().__init__(
            f"'{label}' has used its limit of {limit:,} requests for today. "
            f"The limit resets at midnight UTC, or you can raise it under "
            f"Settings → Integrations."
        )


async def consume(db: aiosqlite.Connection, integration_id: Optional[int], label: str) -> None:
    """
    Spend one request against an endpoint's daily allowance.

    The increment happens before the upstream call, not after. A request that
    fails at the provider may still have been billed, so counting it is the
    honest direction to be wrong in.
    """
    if integration_id is None:
        # The deployment-wide key. Its budget is the operator's problem and is
        # governed outside this table.
        return

    async with db.execute(
        "SELECT rate_limit_per_day FROM user_integrations WHERE id = ?",
        (integration_id,),
    ) as cursor:
        row = await cursor.fetchone()
    limit = int(row["rate_limit_per_day"]) if row and row["rate_limit_per_day"] else 0
    if not limit:
        return

    day = _today()
    await db.execute(
        """INSERT INTO integration_usage (integration_id, day, calls) VALUES (?, ?, 1)
           ON CONFLICT (integration_id, day) DO UPDATE SET calls = calls + 1""",
        (integration_id, day),
    )
    await db.commit()

    if await usage_today(db, integration_id) > limit:
        raise RateLimitExceeded(label, limit)


async def list_integrations(db: aiosqlite.Connection, user_id: int) -> List[Dict[str, Any]]:
    usage = await _usage_map(db, user_id)
    async with db.execute(
        "SELECT * FROM user_integrations WHERE user_id = ? ORDER BY created_at DESC",
        (user_id,),
    ) as cursor:
        return [to_public(row, usage.get(row["id"], 0)) for row in await cursor.fetchall()]


async def get_integration(
    db: aiosqlite.Connection, user_id: int, integration_id: int
) -> Optional[aiosqlite.Row]:
    async with db.execute(
        "SELECT * FROM user_integrations WHERE id = ? AND user_id = ?",
        (integration_id, user_id),
    ) as cursor:
        return await cursor.fetchone()


async def create_integration(
    db: aiosqlite.Connection, user_id: int, data: Dict[str, Any]
) -> Dict[str, Any]:
    cursor = await db.execute(
        """INSERT INTO user_integrations
               (user_id, label, kind, base_url, model, api_key, enabled, rate_limit_per_day)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id""",
        (
            user_id,
            data["label"],
            data["kind"],
            data.get("base_url") or "",
            data.get("model") or "",
            data.get("api_key") or "",
            1 if data.get("enabled", True) else 0,
            validate_rate_limit(data.get("rate_limit_per_day")),
        ),
    )
    new_id = (await cursor.fetchone())[0]
    await db.commit()
    row = await get_integration(db, user_id, new_id)
    return to_public(row)


async def update_integration(
    db: aiosqlite.Connection, user_id: int, integration_id: int, data: Dict[str, Any]
) -> Optional[Dict[str, Any]]:
    row = await get_integration(db, user_id, integration_id)
    if row is None:
        return None

    fields, values = [], []
    for column in ("label", "kind", "base_url", "model"):
        if data.get(column) is not None:
            fields.append(f"{column} = ?")
            values.append(data[column])
    if data.get("enabled") is not None:
        fields.append("enabled = ?")
        values.append(1 if data["enabled"] else 0)
    if data.get("rate_limit_per_day") is not None:
        fields.append("rate_limit_per_day = ?")
        values.append(validate_rate_limit(data["rate_limit_per_day"]))
    # An omitted key means "leave it alone", so editing a label never wipes
    # the credential that makes the integration work.
    if data.get("api_key"):
        fields.append("api_key = ?")
        values.append(data["api_key"])

    if fields:
        values.extend([integration_id, user_id])
        await db.execute(
            f"UPDATE user_integrations SET {', '.join(fields)} WHERE id = ? AND user_id = ?",
            values,
        )
        await db.commit()

    row = await get_integration(db, user_id, integration_id)
    return to_public(row, await usage_today(db, integration_id))


async def delete_integration(
    db: aiosqlite.Connection, user_id: int, integration_id: int
) -> bool:
    cursor = await db.execute(
        "DELETE FROM user_integrations WHERE id = ? AND user_id = ?",
        (integration_id, user_id),
    )
    await db.commit()
    return cursor.rowcount > 0


async def llm_config(db: aiosqlite.Connection, user_id: Optional[int]) -> Dict[str, Any]:
    """
    Resolve which model the assistant should use for this account.

    The customer's own enabled endpoint wins; otherwise the deployment-wide
    settings apply. Returning a dict rather than a client keeps this testable
    without a network call.
    """
    row = None
    if user_id is not None:
        placeholders = ", ".join("?" for _ in LLM_KINDS)
        async with db.execute(
            f"""SELECT * FROM user_integrations
                WHERE user_id = ? AND enabled = 1 AND api_key != ''
                  AND kind IN ({placeholders})
                ORDER BY created_at DESC LIMIT 1""",
            (user_id, *LLM_KINDS),
        ) as cursor:
            row = await cursor.fetchone()

    if row is None:
        return {
            "api_key": settings.OPENAI_API_KEY,
            "base_url": settings.OPENAI_BASE_URL or "",
            "model": settings.OPENAI_MODEL,
            "kind": "",
            "source": "platform",
            "integration_id": None,
        }

    return {
        "api_key": row["api_key"],
        "base_url": row["base_url"] or "",
        "model": row["model"] or settings.OPENAI_MODEL,
        # Carried because Azure OpenAI needs a different client, and getting
        # that wrong surfaces as a misleading "model not found".
        "kind": row["kind"],
        "source": row["label"],
        # Carried so the caller can spend one unit of this endpoint's daily
        # allowance against the same row that supplied the key.
        "integration_id": row["id"],
        "rate_limit_per_day": row["rate_limit_per_day"] or 0,
    }
