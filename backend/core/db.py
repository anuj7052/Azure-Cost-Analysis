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
    # Every published price this app has ever read from Microsoft, kept verbatim.
    #
    # The Retail Prices API only ever reports *today's* price. It has no history
    # endpoint, so the question "did Microsoft put this meter up?" is
    # unanswerable unless we wrote down what it said last time. Once the reading
    # is lost it cannot be recovered from Microsoft at any later date, which is
    # why the whole response body is retained rather than the fields we happen to
    # display today.
    #
    # Not scoped to a user: a list price is public and identical for everyone, so
    # partitioning it per account would multiply identical rows and, worse, leave
    # each account with a history that only starts when they first looked.
    "price_snapshots": """
        CREATE TABLE IF NOT EXISTS price_snapshots (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            meter_id        TEXT    NOT NULL DEFAULT '',
            sku_id          TEXT    NOT NULL DEFAULT '',
            product_id      TEXT    NOT NULL DEFAULT '',
            service_name    TEXT    NOT NULL DEFAULT '',
            product_name    TEXT    NOT NULL DEFAULT '',
            sku_name        TEXT    NOT NULL DEFAULT '',
            arm_sku_name    TEXT    NOT NULL DEFAULT '',
            meter_name      TEXT    NOT NULL DEFAULT '',
            arm_region      TEXT    NOT NULL DEFAULT '',
            currency        TEXT    NOT NULL DEFAULT 'USD',
            price_type      TEXT    NOT NULL DEFAULT '',
            unit_of_measure TEXT    NOT NULL DEFAULT '',
            retail_price    REAL,
            unit_price      REAL,
            effective_from  TEXT    NOT NULL DEFAULT '',
            observed_at     TEXT    NOT NULL DEFAULT (datetime('now')),
            raw             TEXT    NOT NULL DEFAULT '{}'
        )
    """,
    # A price that moved, and by how much.
    #
    # Derivable from price_snapshots, but only by scanning every reading of a
    # meter and diffing them. Changes are rare and reads are frequent, so the
    # rare event is materialised once at write time instead of recomputed on
    # every view.
    "price_changes": """
        CREATE TABLE IF NOT EXISTS price_changes (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            meter_id       TEXT    NOT NULL DEFAULT '',
            currency       TEXT    NOT NULL DEFAULT 'USD',
            price_type     TEXT    NOT NULL DEFAULT '',
            service_name   TEXT    NOT NULL DEFAULT '',
            meter_name     TEXT    NOT NULL DEFAULT '',
            arm_region     TEXT    NOT NULL DEFAULT '',
            old_price      REAL,
            new_price      REAL,
            direction      TEXT    NOT NULL DEFAULT 'flat',
            percent        REAL,
            previous_at    TEXT    NOT NULL DEFAULT '',
            changed_at     TEXT    NOT NULL DEFAULT (datetime('now')),
            effective_from TEXT    NOT NULL DEFAULT ''
        )
    """,
    # Daily exchange rates.
    #
    # Microsoft publishes every Azure price in USD and converts for display only.
    # So when a rupee unit rate moves and the dollar rate did not, the exchange
    # rate is the explanation — and proving that needs the rate on the specific
    # days either side, not a monthly average, because a bill is converted at
    # rates that move daily.
    "fx_rates": """
        CREATE TABLE IF NOT EXISTS fx_rates (
            id       INTEGER PRIMARY KEY AUTOINCREMENT,
            base     TEXT NOT NULL DEFAULT 'USD',
            quote    TEXT NOT NULL,
            rate_day TEXT NOT NULL,
            rate     REAL NOT NULL,
            source   TEXT NOT NULL DEFAULT '',
            fetched_at TEXT DEFAULT (datetime('now')),
            UNIQUE (base, quote, rate_day)
        )
    """,
    # A point-in-time capture of one posture source: Advisor recommendations,
    # Defender findings, policy compliance, or role assignments.
    #
    # None of those APIs has a history endpoint. Ask Defender what changed last
    # month and there is no answer to give, because Azure does not keep one. The
    # only way to ever answer "are we improving" is to have written down what it
    # said the previous time, and a reading not taken cannot be recovered later.
    #
    # The findings are stored as one JSON document rather than a row per finding
    # because they are only ever read whole, to be diffed against another whole
    # snapshot. A normalised table would buy query flexibility nothing here uses
    # and cost a five-figure insert on every scan of a large estate.
    "posture_snapshots": """
        CREATE TABLE IF NOT EXISTS posture_snapshots (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            tenant_id     TEXT    NOT NULL,
            kind          TEXT    NOT NULL,
            captured_at   TEXT    NOT NULL DEFAULT (datetime('now')),
            subscriptions TEXT    NOT NULL DEFAULT '[]',
            finding_count INTEGER NOT NULL DEFAULT 0,
            high_count    INTEGER NOT NULL DEFAULT 0,
            summary       TEXT    NOT NULL DEFAULT '{}',
            findings      TEXT    NOT NULL DEFAULT '[]',
            errors        TEXT    NOT NULL DEFAULT '[]'
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
    # Price lookups are always "this meter, this currency, most recent first":
    # either the latest reading to diff against, or the series to chart.
    "CREATE INDEX IF NOT EXISTS idx_price_snapshots_meter "
    "ON price_snapshots (meter_id, currency, price_type, observed_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_price_snapshots_sku "
    "ON price_snapshots (arm_sku_name, arm_region, currency)",
    "CREATE INDEX IF NOT EXISTS idx_price_changes_meter "
    "ON price_changes (meter_id, currency, changed_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_price_changes_recent ON price_changes (changed_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_fx_rates_day ON fx_rates (base, quote, rate_day)",
    # Posture reads are always "the latest two snapshots of this kind, for this
    # tenant, that I own" — the pair a diff needs.
    "CREATE INDEX IF NOT EXISTS idx_posture_owner "
    "ON posture_snapshots (user_id, tenant_id, kind, id DESC)",
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
        await db.execute(_SCHEMAS["price_snapshots"])
        await db.execute(_SCHEMAS["price_changes"])
        await db.execute(_SCHEMAS["fx_rates"])
        await db.execute(_SCHEMAS["posture_snapshots"])
        for statement in _INDEXES:
            await db.execute(statement)
        await db.commit()


async def get_db():
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        await db.execute("PRAGMA foreign_keys = ON")
        yield db
