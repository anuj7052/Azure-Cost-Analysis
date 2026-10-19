"""Workspace-scoped customer billing records. Original documents live in SharePoint."""
SCHEMAS = {
    "billing_archives": """CREATE TABLE IF NOT EXISTS billing_archives (
        owner_id INTEGER NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
        archived_by TEXT NOT NULL, archived_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        PRIMARY KEY(owner_id,entity_type,entity_id)
    )""",
    "billing_connections": """CREATE TABLE IF NOT EXISTS billing_connections (
        owner_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        site_url TEXT NOT NULL, drive_id TEXT NOT NULL, folder_id TEXT NOT NULL,
        folder_url TEXT NOT NULL, connected_by TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
    )""",
    "billing_customers": """CREATE TABLE IF NOT EXISTS billing_customers (
        id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL, contact_email TEXT NOT NULL DEFAULT '',
        company TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
    )""",
    "billing_documents": """CREATE TABLE IF NOT EXISTS billing_documents (
        id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        customer_id TEXT NOT NULL REFERENCES billing_customers(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, period TEXT NOT NULL, filename TEXT NOT NULL, sha256 TEXT NOT NULL,
        drive_id TEXT NOT NULL, item_id TEXT NOT NULL, web_url TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'needs_review', extraction TEXT NOT NULL DEFAULT '{}',
        extraction_message TEXT NOT NULL DEFAULT '', invoice_number TEXT NOT NULL DEFAULT '',
        currency TEXT NOT NULL DEFAULT '', net_amount TEXT, tax_amount TEXT,
        uploaded_by TEXT NOT NULL, reviewed_by TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP), reviewed_at TEXT,
        UNIQUE(owner_id, customer_id, kind, sha256)
    )""",
    "billing_imports": """CREATE TABLE IF NOT EXISTS billing_imports (
        id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES users(id),
        source_hash TEXT NOT NULL, billing_year INTEGER NOT NULL, filename TEXT NOT NULL,
        blob_path TEXT NOT NULL, created_by TEXT NOT NULL, summary TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        UNIQUE(owner_id,source_hash,billing_year)
    )""",
    "billing_workloads": """CREATE TABLE IF NOT EXISTS billing_workloads (
        id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES users(id),
        customer_id TEXT NOT NULL REFERENCES billing_customers(id),
        name TEXT NOT NULL, po_id TEXT NOT NULL DEFAULT '', po_date TEXT NOT NULL DEFAULT '',
        period_start TEXT NOT NULL DEFAULT '', period_end TEXT NOT NULL DEFAULT '',
        frequency TEXT NOT NULL DEFAULT '', plan_name TEXT NOT NULL DEFAULT '',
        requirement_id TEXT NOT NULL DEFAULT '', distributor TEXT NOT NULL DEFAULT '',
        owner TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
    )""",
    "billing_ledger": """CREATE TABLE IF NOT EXISTS billing_ledger (
        id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES users(id),
        customer_id TEXT NOT NULL REFERENCES billing_customers(id),
        workload_id TEXT NOT NULL REFERENCES billing_workloads(id),
        period TEXT NOT NULL, currency TEXT NOT NULL, invoice_number TEXT NOT NULL DEFAULT '',
        customer_amount TEXT, distributor_amount TEXT, usage_amount TEXT,
        payment_status TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
        distributor TEXT NOT NULL DEFAULT '',
        amount_basis TEXT NOT NULL DEFAULT 'unspecified', status TEXT NOT NULL DEFAULT 'recorded',
        source_import_id TEXT, source_row INTEGER, raw_cells TEXT NOT NULL DEFAULT '{}',
        revision INTEGER NOT NULL DEFAULT 1, updated_by TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP), updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        UNIQUE(owner_id,workload_id,period)
    )""",
    "billing_changes": """CREATE TABLE IF NOT EXISTS billing_changes (
        id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES users(id), entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL, action TEXT NOT NULL, before_json TEXT NOT NULL, after_json TEXT NOT NULL,
        actor TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
    )""",
}

INDEXES = [
    "CREATE INDEX IF NOT EXISTS idx_billing_workloads_owner ON billing_workloads(owner_id,customer_id)",
    "CREATE INDEX IF NOT EXISTS idx_billing_ledger_owner ON billing_ledger(owner_id,customer_id,period)",
    "CREATE INDEX IF NOT EXISTS idx_billing_customer_owner ON billing_customers(owner_id)",
    "CREATE INDEX IF NOT EXISTS idx_billing_documents_customer ON billing_documents(owner_id,customer_id)",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_invoice_number ON billing_documents(owner_id,customer_id,kind,invoice_number) WHERE status='confirmed' AND invoice_number<>''",
]

# Columns added after the first release, applied to databases that already exist.
MIGRATIONS = {
    "billing_ledger": {"distributor": "TEXT NOT NULL DEFAULT ''"},
    "billing_workloads": {"owner": "TEXT NOT NULL DEFAULT ''"},
}

# Distributors offered by default; any other name typed in is remembered.
DEFAULT_DISTRIBUTORS = ("Savex", "Redington", "Tata", "Ingram")
