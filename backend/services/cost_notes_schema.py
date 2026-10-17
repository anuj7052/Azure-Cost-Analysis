"""Workspace-scoped dated notes on cost activity ("sticky notes")."""
SCHEMAS = {
    "cost_notes": """CREATE TABLE IF NOT EXISTS cost_notes (
        id TEXT PRIMARY KEY,
        owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        tenant_id TEXT NOT NULL,
        subscription_id TEXT NOT NULL DEFAULT '',
        note_date TEXT NOT NULL,
        body TEXT NOT NULL,
        color TEXT NOT NULL DEFAULT 'yellow',
        author_id INTEGER NOT NULL,
        author_name TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
    )""",
}

INDEXES = [
    "CREATE INDEX IF NOT EXISTS idx_cost_notes_lookup ON cost_notes(owner_id,tenant_id,note_date)",
]
