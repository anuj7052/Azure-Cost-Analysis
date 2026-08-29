"""
The database backup.

These tests exist because a backup fails silently in both directions: one that
never runs looks exactly like one that does, and one that produces a corrupt
file looks fine until the day somebody needs it. Neither is visible from the
outside, so both have to fail loudly in here.
"""
import asyncio

import aiosqlite
import pytest

from services import backup


@pytest.fixture
def db_path(tmp_path):
    return str(tmp_path / "data" / "app.db")


async def _seed(path, rows=3):
    import os
    os.makedirs(os.path.dirname(path), exist_ok=True)
    async with aiosqlite.connect(path) as db:
        await db.execute("CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)")
        for i in range(rows):
            await db.execute("INSERT INTO t (v) VALUES (?)", (f"row-{i}",))
        await db.commit()


async def test_a_backup_is_written(db_path):
    await _seed(db_path)

    target = await backup.make_backup(db_path)

    assert target is not None
    assert target.exists()


async def test_the_backup_actually_contains_the_data(db_path):
    # A file of the right name and the wrong contents is the failure this
    # whole module exists to prevent, and it passes every other test here.
    await _seed(db_path, rows=5)

    target = await backup.make_backup(db_path)

    async with aiosqlite.connect(str(target)) as db:
        async with db.execute("SELECT COUNT(*) FROM t") as cur:
            assert (await cur.fetchone())[0] == 5


async def test_the_backup_is_a_valid_database(db_path):
    await _seed(db_path)

    target = await backup.make_backup(db_path)

    async with aiosqlite.connect(str(target)) as db:
        async with db.execute("PRAGMA integrity_check") as cur:
            assert (await cur.fetchone())[0] == "ok"


async def test_backing_up_before_there_is_a_database_says_so(db_path):
    # Reporting success when there was nothing to copy would be the most
    # dangerous kind of green tick.
    assert await backup.make_backup(db_path) is None


async def test_a_backup_does_not_disturb_the_original(db_path):
    await _seed(db_path, rows=4)

    await backup.make_backup(db_path)

    async with aiosqlite.connect(db_path) as db:
        async with db.execute("SELECT COUNT(*) FROM t") as cur:
            assert (await cur.fetchone())[0] == 4


async def test_old_copies_are_pruned(db_path):
    await _seed(db_path)
    folder = backup.backup_dir(db_path)
    folder.mkdir(parents=True, exist_ok=True)
    for i in range(backup.KEEP + 4):
        (folder / f"app-2024010{i % 10}-00000{i}.db").write_bytes(b"x")

    backup.prune(db_path)

    assert len(list(folder.glob("app-*.db"))) == backup.KEEP


async def test_pruning_keeps_the_newest_not_the_oldest(db_path):
    # Getting this backwards would delete every good copy and keep the stale
    # ones, while still leaving exactly KEEP files on disk.
    await _seed(db_path)
    folder = backup.backup_dir(db_path)
    folder.mkdir(parents=True, exist_ok=True)
    for day in range(1, backup.KEEP + 3):
        (folder / f"app-202401{day:02d}-000000.db").write_bytes(b"x")

    backup.prune(db_path)

    names = sorted(p.name for p in folder.glob("app-*.db"))
    assert names[-1] == f"app-202401{backup.KEEP + 2:02d}-000000.db"


async def test_more_than_one_copy_is_kept(db_path):
    # One rolling backup would overwrite the last good copy with the corrupt
    # one the very next night, which is the same as having none.
    assert backup.KEEP > 1


async def test_backups_live_beside_the_database_on_the_persisted_share(db_path):
    # Anywhere outside /home on App Service is scratch, so a backup written
    # there would vanish at exactly the moment it was needed.
    assert backup.backup_dir(db_path).parent == __import__("pathlib").Path(db_path).parent


async def test_the_listing_reports_what_exists(db_path):
    await _seed(db_path)
    await backup.make_backup(db_path)

    listed = backup.list_backups(db_path)

    assert len(listed) == 1
    assert listed[0]["bytes"] > 0


async def test_listing_before_any_backup_is_empty_not_an_error(db_path):
    assert backup.list_backups(db_path) == []


async def test_a_failing_backup_does_not_stop_the_loop():
    # The application must not be taken down by its own bookkeeping.
    calls = []

    async def boom(_):
        calls.append(1)
        raise OSError("disk full")

    original_make, original_interval = backup.make_backup, backup.INTERVAL_SECONDS
    backup.make_backup, backup.INTERVAL_SECONDS = boom, 0.01
    task = None
    try:
        task = asyncio.create_task(backup.run_forever("ignored"))
        await asyncio.sleep(0.05)
        assert not task.done()
        assert len(calls) >= 1
    finally:
        backup.make_backup, backup.INTERVAL_SECONDS = original_make, original_interval
        if task is not None:
            # Awaited, not merely cancelled. A task left mid-cancellation
            # outlives the test's event loop and surfaces later as a warning
            # on some unrelated test, which is how a suite becomes flaky.
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task


async def test_the_schedule_is_bounded():
    # A default that never fires would pass every other test in this file.
    assert 0 < backup.INTERVAL_SECONDS <= 24 * 60 * 60
