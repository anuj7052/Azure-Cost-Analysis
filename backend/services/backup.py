"""
Keeping a copy of the database, so that losing the disk is not losing the
customer.

Today the whole application state -- accounts, connected tenants, service
principal secrets, BOQs, scan history -- is one SQLite file on one App Service
instance. Azure will not lose that disk often, but "not often" is not a backup
strategy, and the failure mode is total: there is no second copy anywhere.

Two details matter more than they look:

  * `VACUUM INTO` rather than copying the file. A plain copy of a live SQLite
    database can catch a write half-finished and produce a backup that only
    fails when you try to restore it -- which is the worst possible time to
    find out. `VACUUM INTO` takes a read lock and writes a consistent, already
    compacted database.

  * `/home` is the persisted share on App Service, and survives restarts and
    redeploys. Anywhere else on the filesystem is scratch, so a backup written
    there would disappear at exactly the moment it was needed.

This is deliberately a local copy, not off-site. It answers "the app corrupted
its database" and "a bad migration ate a table". It does not answer "the whole
storage account is gone" -- that needs Postgres with its own point-in-time
restore, which is the real fix and is a much larger change. This exists so the
gap until then is not open.
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from pathlib import Path

import aiosqlite

log = logging.getLogger(__name__)

# How long between copies. Daily is the honest trade: the most anybody can lose
# is a day of edits, and the file is small enough that this costs nothing.
INTERVAL_SECONDS = 24 * 60 * 60

# How many to keep. Enough that a problem introduced on Monday and noticed on
# Friday still has a clean copy behind it -- one backup would simply overwrite
# the good data with the corrupted data on the next run.
KEEP = 7


def backup_dir(db_path: str) -> Path:
    return Path(db_path).parent / "backups"


async def make_backup(db_path: str) -> Path | None:
    """
    Write one consistent copy. Returns the path, or None if there is nothing
    to copy yet.
    """
    if not os.path.exists(db_path):
        # A brand-new deployment has no database until the first request.
        # Backing up nothing and reporting success would be worse than saying
        # so plainly.
        return None

    target_dir = backup_dir(db_path)
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / f"{Path(db_path).stem}-{time.strftime('%Y%m%d-%H%M%S')}.db"

    async with aiosqlite.connect(db_path) as db:
        # The path is interpolated because SQLite does not accept a parameter
        # here. It is built from a timestamp and the configured database path,
        # never from anything a request can influence.
        await db.execute(f"VACUUM INTO '{target}'")

    prune(db_path)
    return target


def prune(db_path: str) -> int:
    """Delete all but the newest `KEEP` copies. Returns how many went."""
    target_dir = backup_dir(db_path)
    if not target_dir.exists():
        return 0

    copies = sorted(
        target_dir.glob(f"{Path(db_path).stem}-*.db"),
        key=lambda p: p.name,
        reverse=True,
    )
    removed = 0
    for stale in copies[KEEP:]:
        try:
            stale.unlink()
            removed += 1
        except OSError:
            # A copy we cannot delete is a tidiness problem, not a data
            # problem. Never let it stop the backup that just succeeded.
            log.warning("could not remove old backup", extra={"path": str(stale)})
    return removed


def list_backups(db_path: str) -> list[dict]:
    """What copies exist, newest first, so somebody can check without SSH."""
    target_dir = backup_dir(db_path)
    if not target_dir.exists():
        return []
    return [
        {
            "name": p.name,
            "bytes": p.stat().st_size,
            "created_at": time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(p.stat().st_mtime)),
        }
        for p in sorted(target_dir.glob("*.db"), key=lambda p: p.name, reverse=True)
    ]


async def run_forever(db_path: str) -> None:
    """
    Back up on startup, then once a day.

    On startup as well as on a timer because App Service instances are
    recycled and redeployed, and a schedule that only ever fires after 24
    hours of uptime would, on a busy release week, never fire at all.
    """
    while True:
        try:
            path = await make_backup(db_path)
            if path:
                log.info("database backed up", extra={"path": path.name})
        except Exception:
            # A failed backup must never take the application down with it.
            # It is logged loudly so that it can be noticed, rather than
            # swallowed so that it cannot.
            log.exception("database backup failed")
        await asyncio.sleep(INTERVAL_SECONDS)
