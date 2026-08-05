import aiosqlite
import os
from core.config import settings

DB_PATH = settings.DB_PATH


async def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS service_principals (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                tenant_id   TEXT    NOT NULL UNIQUE,
                tenant_name TEXT    NOT NULL,
                client_id   TEXT    NOT NULL,
                client_secret TEXT  NOT NULL,
                created_at  TEXT    DEFAULT (datetime('now'))
            )
        """)
        await db.commit()


async def get_db():
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        yield db
