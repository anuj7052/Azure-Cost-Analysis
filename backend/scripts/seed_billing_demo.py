"""Add or remove demo Azure Billing data in the LOCAL database.

    python scripts/seed_billing_demo.py --owner 1          # add
    python scripts/seed_billing_demo.py --owner 1 --remove # remove

Every demo customer's name starts with "Demo · " so it is easy to spot and to
remove. Never run this against production.
"""
import argparse
import asyncio
import random
import sys
import uuid
from pathlib import Path

import aiosqlite

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from core.db import DB_PATH, init_db  # noqa: E402

PREFIX = 'Demo · '
DISTRIBUTORS = ['Savex', 'Redington', 'Tata', 'Ingram']
OWNERS = ['Ravi Kumar', 'Meera Shah', 'Anil Verma']
CUSTOMERS = {
    'Acme Retail': ['Acme Production', 'Acme Dev/Test'],
    'Blue River Pharma': ['BRP SAP Prod', 'BRP DR'],
    'Crest Logistics': ['Crest Main'],
    'Delta Finserv': ['Delta Core Banking', 'Delta Analytics', 'Delta Backup'],
    'Evergreen Schools': ['Evergreen LMS'],
}
MONTHS = ['2026-07', '2026-08', '2026-09', '2026-10']


async def remove(db, owner):
    async with db.execute('SELECT id FROM billing_customers WHERE owner_id=? AND name LIKE ?', (owner, PREFIX + '%')) as cursor:
        ids = [row[0] for row in await cursor.fetchall()]
    for cid in ids:
        await db.execute('DELETE FROM billing_ledger WHERE customer_id=? AND owner_id=?', (cid, owner))
        await db.execute('DELETE FROM billing_workloads WHERE customer_id=? AND owner_id=?', (cid, owner))
        await db.execute('DELETE FROM billing_customers WHERE id=? AND owner_id=?', (cid, owner))
    await db.commit()
    return len(ids)


async def add(db, owner):
    rng = random.Random(42)
    entries = 0
    for name, subs in CUSTOMERS.items():
        cid = str(uuid.uuid4())
        await db.execute('INSERT INTO billing_customers(id,owner_id,name) VALUES(?,?,?)', (cid, owner, PREFIX + name))
        for sub in subs:
            wid = str(uuid.uuid4())
            await db.execute('INSERT INTO billing_workloads(id,owner_id,customer_id,name,owner) VALUES(?,?,?,?,?)', (wid, owner, cid, sub, rng.choice(OWNERS)))
            distributor = rng.choice(DISTRIBUTORS)
            base = rng.randrange(40_000, 400_000, 500)
            for i, month in enumerate(MONTHS):
                cost = round(base * (1 + rng.uniform(-0.08, 0.12)), 2)
                billed = round(cost * rng.uniform(1.06, 1.22), 2)
                await db.execute(
                    'INSERT INTO billing_ledger(id,owner_id,customer_id,workload_id,period,currency,invoice_number,customer_amount,distributor_amount,distributor,amount_basis,status,updated_by) '
                    'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
                    (str(uuid.uuid4()), owner, cid, wid, month, 'INR', f'DEMO-{month.replace("-", "")}-{entries + 1:03d}',
                     f'{billed:.2f}', f'{cost:.2f}', distributor, 'net', 'recorded', 'demo-seed'))
                entries += 1
    await db.commit()
    return entries


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--owner', type=int, required=True, help='workspace (owner) user id')
    parser.add_argument('--remove', action='store_true')
    args = parser.parse_args()
    await init_db()
    async with aiosqlite.connect(DB_PATH) as db:
        removed = await remove(db, args.owner)
        if args.remove:
            print(f'Removed {removed} demo customers.')
            return
        print(f'Replaced {removed} old demo customers; added {len(CUSTOMERS)} customers and {await add(db, args.owner)} monthly entries.')


if __name__ == '__main__':
    asyncio.run(main())
