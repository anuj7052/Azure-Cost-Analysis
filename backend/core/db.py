import aiosqlite
import os
from core.config import settings

DB_PATH = settings.DB_PATH

_SCHEMAS = {
    "users": """
        CREATE TABLE IF NOT EXISTS users (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            azure_oid       TEXT    NOT NULL UNIQUE,
            email           TEXT    NOT NULL DEFAULT '',
            name            TEXT    NOT NULL DEFAULT '',
            azure_tenant_id TEXT    NOT NULL DEFAULT '',
            role            TEXT    NOT NULL DEFAULT 'user',
            status          TEXT    NOT NULL DEFAULT 'active',
            created_at      TEXT    DEFAULT (datetime('now')),
            last_login_at   TEXT
        )
    """,
    "service_principals": """
        CREATE TABLE IF NOT EXISTS service_principals (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
            tenant_id     TEXT    NOT NULL,
            tenant_name   TEXT    NOT NULL,
            client_id     TEXT    NOT NULL,
            client_secret TEXT    NOT NULL,
            created_at    TEXT    DEFAULT (datetime('now')),
            UNIQUE (user_id, tenant_id)
        )
    """,
    "session_tokens": """
        CREATE TABLE IF NOT EXISTS session_tokens (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
            tenant_id    TEXT    NOT NULL,
            tenant_name  TEXT    NOT NULL,
            access_token TEXT    NOT NULL,
            expires_at   TEXT,
            account      TEXT,
            created_at   TEXT    DEFAULT (datetime('now')),
            UNIQUE (user_id, tenant_id)
        )
    """,
    # Endpoints and models a customer brings themselves: their own OpenAI or
    # Azure OpenAI deployment, a gateway, or a webhook. Scoped to the owner so
    # one customer's key is never reachable by another.
    "user_integrations": """
        CREATE TABLE IF NOT EXISTS user_integrations (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            label      TEXT    NOT NULL,
            kind       TEXT    NOT NULL DEFAULT 'openai',
            base_url   TEXT    NOT NULL DEFAULT '',
            model      TEXT    NOT NULL DEFAULT '',
            api_key    TEXT    NOT NULL DEFAULT '',
            enabled    INTEGER NOT NULL DEFAULT 1,
            created_at TEXT    DEFAULT (datetime('now')),
            UNIQUE (user_id, label)
        )
    """,
}


async def _columns(db: aiosqlite.Connection, table: str) -> set[str]:
    async with db.execute(f"PRAGMA table_info({table})") as cursor:
        return {row[1] for row in await cursor.fetchall()}


async def _table_exists(db: aiosqlite.Connection, table: str) -> bool:
    async with db.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
    ) as cursor:
        return await cursor.fetchone() is not None


async def _add_owner_column(db: aiosqlite.Connection, table: str, carried: list[str]):
    """
    Give a credential table a user_id owner and scope its uniqueness to that owner.

    The original schema had UNIQUE(tenant_id), which is wrong the moment more
    than one person uses the app: two customers could not both connect the same
    Azure tenant, and one would silently overwrite the other's credentials.
    SQLite cannot alter a constraint in place, so the table is rebuilt.

    Rows that predate this migration have no owner. They stay NULL and are
    adopted by the first account to sign in, so a single-user installation keeps
    working after the upgrade instead of losing its connected tenants.
    """
    if not await _table_exists(db, table):
        return
    if "user_id" in await _columns(db, table):
        return

    cols = ", ".join(carried)
    await db.execute(f"ALTER TABLE {table} RENAME TO {table}_old")
    await db.execute(_SCHEMAS[table])
    await db.execute(f"INSERT INTO {table} ({cols}) SELECT {cols} FROM {table}_old")
    await db.execute(f"DROP TABLE {table}_old")


async def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(_SCHEMAS["users"])

        await _add_owner_column(
            db,
            "service_principals",
            ["id", "tenant_id", "tenant_name", "client_id", "client_secret", "created_at"],
        )
        await _add_owner_column(
            db,
            "session_tokens",
            ["id", "tenant_id", "tenant_name", "access_token",
             "expires_at", "account", "created_at"],
        )

        await db.execute(_SCHEMAS["service_principals"])
        await db.execute(_SCHEMAS["session_tokens"])
        await db.execute(_SCHEMAS["user_integrations"])
        await db.commit()


async def get_db():
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        await db.execute("PRAGMA foreign_keys = ON")
        yield db
