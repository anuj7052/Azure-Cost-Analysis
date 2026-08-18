"""
Endpoints and models a customer brings themselves.

Everything here is scoped to the signed-in account. A user may register their
own OpenAI or Azure OpenAI deployment, an API gateway in front of one, or a
plain webhook, and the assistant then runs on their key and their quota rather
than the shared server key.

Keys are write-only over the API: they can be set and replaced, never read
back. Callers get a masked hint instead, which is enough to recognise a key
without being enough to use it.
"""

from typing import Any, Dict, List, Optional

import aiosqlite

from core.config import settings

KINDS = ("openai", "azure_openai", "webhook", "custom")

# Kinds the BOQ assistant can actually talk to. A webhook is stored for the
# customer's own use but is not an OpenAI-compatible chat endpoint.
LLM_KINDS = ("openai", "azure_openai", "custom")


def mask(key: str) -> str:
    """Show just enough of a key to recognise it, never enough to use it."""
    if not key:
        return ""
    tail = key[-4:] if len(key) >= 8 else ""
    return f"••••{tail}" if tail else "••••"


def to_public(row: aiosqlite.Row) -> Dict[str, Any]:
    return {
        "id": row["id"],
        "label": row["label"],
        "kind": row["kind"],
        "base_url": row["base_url"],
        "model": row["model"],
        "enabled": bool(row["enabled"]),
        "has_key": bool(row["api_key"]),
        "key_hint": mask(row["api_key"]),
        "created_at": row["created_at"],
    }


async def list_integrations(db: aiosqlite.Connection, user_id: int) -> List[Dict[str, Any]]:
    async with db.execute(
        "SELECT * FROM user_integrations WHERE user_id = ? ORDER BY created_at DESC",
        (user_id,),
    ) as cursor:
        return [to_public(row) for row in await cursor.fetchall()]


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
        """INSERT INTO user_integrations (user_id, label, kind, base_url, model, api_key, enabled)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (
            user_id,
            data["label"],
            data["kind"],
            data.get("base_url") or "",
            data.get("model") or "",
            data.get("api_key") or "",
            1 if data.get("enabled", True) else 0,
        ),
    )
    await db.commit()
    row = await get_integration(db, user_id, cursor.lastrowid)
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

    return to_public(await get_integration(db, user_id, integration_id))


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
            "source": "platform",
        }

    return {
        "api_key": row["api_key"],
        "base_url": row["base_url"] or "",
        "model": row["model"] or settings.OPENAI_MODEL,
        "source": row["label"],
    }
