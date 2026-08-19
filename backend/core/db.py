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
    # A point-in-time capture of one tenant's estate. Every visibility feature
    # that answers "what did this look like then" or "what changed" reads from
    # here rather than from Azure, because Azure only ever reports *now*.
    "scans": """
        CREATE TABLE IF NOT EXISTS scans (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            tenant_id      TEXT    NOT NULL,
            status         TEXT    NOT NULL DEFAULT 'running',
            started_at     TEXT    DEFAULT (datetime('now')),
            finished_at    TEXT,
            resource_count INTEGER NOT NULL DEFAULT 0,
            error          TEXT
        )
    """,
    # Resources as they existed in one scan.
    #
    # Rows are never updated. A resource that changes produces a new row in the
    # next scan and the old one stays exactly as captured — that immutability is
    # what makes point-in-time browsing and change tracking possible at all.
    "scan_resources": """
        CREATE TABLE IF NOT EXISTS scan_resources (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            scan_id         INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
            resource_id     TEXT    NOT NULL,
            name            TEXT    NOT NULL DEFAULT '',
            name_lower      TEXT    NOT NULL DEFAULT '',
            type            TEXT    NOT NULL DEFAULT '',
            resource_group  TEXT    NOT NULL DEFAULT '',
            subscription_id TEXT    NOT NULL DEFAULT '',
            location        TEXT    NOT NULL DEFAULT '',
            sku             TEXT    NOT NULL DEFAULT '',
            tags            TEXT    NOT NULL DEFAULT '{}'
        )
    """,
}

# Search runs against name_lower across every scan the user owns, so without
# these it degrades to a full table scan once a few scans have accumulated.
_INDEXES = [
    "CREATE INDEX IF NOT EXISTS idx_scans_owner ON scans (user_id, tenant_id, id DESC)",
    "CREATE INDEX IF NOT EXISTS idx_scan_resources_scan ON scan_resources (scan_id)",
    "CREATE INDEX IF NOT EXISTS idx_scan_resources_name ON scan_resources (name_lower)",
    "CREATE INDEX IF NOT EXISTS idx_scan_resources_rid ON scan_resources (resource_id)",
]


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
        await db.execute(_SCHEMAS["scans"])
        await db.execute(_SCHEMAS["scan_resources"])
        for statement in _INDEXES:
            await db.execute(statement)
        await db.commit()


async def get_db():
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        await db.execute("PRAGMA foreign_keys = ON")
        yield db
