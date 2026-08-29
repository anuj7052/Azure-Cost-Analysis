"""
Copy the live SQLite database into Postgres.

Run it, check the counts it prints, run it again if you like -- it truncates
each table before loading it, so a second run produces the same result as the
first rather than doubling every row. That matters more than speed here,
because the realistic way a migration goes wrong is not failing, it is
half-finishing and being run again by someone hoping it will finish.

It reports row counts read and written per table and refuses to declare
success if they differ. A migration that says "done" without counting is
saying "no exception was raised", which is not the same claim.

    python -m scripts.migrate_to_postgres \
        --sqlite /home/data/azure_cost.db \
        --postgres "postgresql://...

Nothing is deleted from SQLite. The old file remains the fallback.
"""
import argparse
import asyncio
import sys

import aiosqlite

# Parents before children, so foreign keys are satisfiable as we go. Postgres
# enforces them on every insert; SQLite only does when asked, which is why the
# existing file can contain orders that SQLite never had to care about.
TABLE_ORDER = [
    "users",
    "user_sessions",
    "team_invitations",
    "service_principals",
    "session_tokens",
    "user_integrations",
    "integration_usage",
    "provision_deployments",
    "scans",
    "scan_resources",
    "price_snapshots",
    "price_changes",
    "fx_rates",
    "posture_snapshots",
    "vm_resize_operations",
    "security_audit",
    "anomaly_tracking",
    "anomaly_events",
]

# Written in batches rather than one statement per row. Large enough to keep
# the round trips down, small enough that a failure reports a useful position.
BATCH = 500


async def _sqlite_columns(db, table: str) -> list[str]:
    async with db.execute(f"PRAGMA table_info({table})") as cursor:
        return [row[1] for row in await cursor.fetchall()]


async def _pg_columns(conn, table: str) -> set[str]:
    rows = await conn.fetch(
        "SELECT column_name FROM information_schema.columns WHERE table_name = $1",
        table,
    )
    return {row["column_name"] for row in rows}


async def copy_table(sqlite_db, pg_conn, table: str) -> tuple[int, int]:
    """
    Copy one table. Returns (rows read, rows present afterwards).

    Columns are matched by name and intersected, so a column that exists in
    only one of the two schemas is skipped rather than crashing the run. That
    is deliberate: the alternative is a migration that stops dead on the first
    table because of a column nobody reads.
    """
    source_columns = await _sqlite_columns(sqlite_db, table)
    if not source_columns:
        return (0, 0)

    target_columns = await _pg_columns(pg_conn, table)
    columns = [c for c in source_columns if c in target_columns]
    skipped = [c for c in source_columns if c not in target_columns]
    if skipped:
        print(f"  {table}: skipping columns absent in Postgres: {', '.join(skipped)}")
    if not columns:
        return (0, 0)

    quoted = ", ".join(f'"{c}"' for c in columns)
    async with sqlite_db.execute(f"SELECT {quoted} FROM {table}") as cursor:
        rows = [tuple(row) for row in await cursor.fetchall()]

    await pg_conn.execute(f'TRUNCATE TABLE "{table}" CASCADE')
    if rows:
        await pg_conn.copy_records_to_table(table, records=rows, columns=columns)

    written = await pg_conn.fetchval(f'SELECT COUNT(*) FROM "{table}"')
    return (len(rows), written)


async def resync_identities(pg_conn) -> None:
    """
    Move each identity sequence past the ids we just inserted.

    Rows arrive with their original ids, which the sequence knows nothing
    about. Without this the next insert claims id 1, collides, and the app
    looks broken in a way that has nothing to do with the data.

    Not every table has an `id`: the usage counters are keyed by what they
    count. Asking Postgres for the sequence of a column that does not exist
    is an error, not an empty answer, so the columns are checked first.
    """
    for table in TABLE_ORDER:
        if "id" not in await _pg_columns(pg_conn, table):
            continue
        sequence = await pg_conn.fetchval(
            "SELECT pg_get_serial_sequence($1, 'id')", table
        )
        if not sequence:
            continue
        highest = await pg_conn.fetchval(f'SELECT COALESCE(MAX(id), 0) FROM "{table}"')
        await pg_conn.execute(
            "SELECT setval($1, $2, true)", sequence, max(int(highest), 1)
        )


async def migrate(sqlite_path: str, postgres_dsn: str) -> int:
    import asyncpg

    results: list[tuple[str, int, int]] = []

    pg_conn = await asyncpg.connect(postgres_dsn)
    try:
        async with aiosqlite.connect(sqlite_path) as sqlite_db:
            # One transaction for the whole copy. A migration that leaves half
            # the tables loaded is harder to recover from than one that fails.
            async with pg_conn.transaction():
                for table in TABLE_ORDER:
                    read, written = await copy_table(sqlite_db, pg_conn, table)
                    results.append((table, read, written))
                    print(f"  {table}: read {read}, wrote {written}")
                await resync_identities(pg_conn)
    finally:
        await pg_conn.close()

    mismatched = [(t, r, w) for t, r, w in results if r != w]
    total = sum(r for _, r, _ in results)

    print()
    if mismatched:
        for table, read, written in mismatched:
            print(f"MISMATCH {table}: read {read} but Postgres holds {written}")
        print("Migration did NOT complete cleanly. SQLite is untouched.")
        return 1

    print(f"Copied {total} rows across {len(results)} tables. Counts match.")
    print("SQLite is untouched; it remains the fallback until you switch over.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sqlite", required=True, help="path to the SQLite file")
    parser.add_argument("--postgres", required=True, help="Postgres DSN")
    args = parser.parse_args()
    return asyncio.run(migrate(args.sqlite, args.postgres))


if __name__ == "__main__":
    sys.exit(main())
