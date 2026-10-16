"""Editable, source-preserving monthly ledger; distinct from confirmed invoices."""
import csv
import hashlib
import io
import json
import re
import uuid
from decimal import Decimal

from fastapi import HTTPException

MONTHS = {name: index for index, name in enumerate(
    ('january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'), 1)}
WORKLOAD_FIELDS = ('name', 'po_id', 'po_date', 'period_start', 'period_end', 'frequency', 'plan_name', 'requirement_id', 'distributor', 'notes')
ENTRY_FIELDS = ('period', 'currency', 'invoice_number', 'customer_amount', 'distributor_amount', 'usage_amount', 'payment_status', 'notes', 'amount_basis', 'status')


def money(text):
    value = str(text or '').strip()
    if not value:
        return None
    value = re.sub(r'^(?:₹|INR)\s*', '', value, flags=re.I).strip()
    # Accept Indian and western grouping, but not embedded prose or malformed
    # punctuation. Currency defaults are explicitly chosen during preview.
    if not re.fullmatch(r'-?(?:\d+|\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})*,\d{3})(?:\.\d{1,4})?', value):
        raise ValueError('Not an unambiguous amount')
    amount = Decimal(value.replace(',', ''))
    if abs(amount) >= Decimal('100000000000000'):
        raise ValueError('Amount out of range')
    return str(amount)


def parse_csv(content, year, currency='INR'):
    if not 2000 <= year <= 2100:
        raise HTTPException(422, 'Choose the billing year between 2000 and 2100.')
    try:
        rows = list(csv.reader(io.StringIO(content.decode('utf-8-sig'))))
    except (UnicodeError, csv.Error):
        raise HTTPException(422, 'Upload a UTF-8 billing CSV.') from None
    if len(rows) < 3 or rows[0][0].strip().casefold() != 'company name':
        raise HTTPException(422, 'Expected Company Name and a second row of monthly invoice headings.')
    columns = [(i, MONTHS[cell.strip().casefold()]) for i, cell in enumerate(rows[0]) if cell.strip().casefold() in MONTHS]
    if not columns or len({month for _, month in columns}) != len(columns):
        raise HTTPException(422, 'The CSV needs distinct month headings.')
    for start, _ in columns:
        header = [v.strip().casefold() for v in rows[1][start:start + 4]]
        if header != ['invoice id', 'amount', 'redingtone bill', 'payment status']:
            raise HTTPException(422, 'Monthly columns must be Invoice ID, Amount, Redingtone Bill, Payment Status.')
    companies = {}
    current = None
    warnings = []
    width = len(rows[1])
    for number, original in enumerate(rows[2:], 3):
        if not any(cell.strip() for cell in original):
            continue
        row = original + [''] * max(0, width - len(original))
        if row[0].strip():
            name = row[0].strip()
            key = ' '.join(name.split()).casefold()
            current = companies.setdefault(key, {'name': name, 'workloads': [], 'warnings': []})
            if '₹' in name or re.search(r'\bprovide customer\b', name, re.I):
                current['warnings'].append('Company name contains a billing note. Preserved as written; edit the profile name after review.')
        if current is None:
            raise HTTPException(422, f'Row {number} has no preceding company for its blank company cell.')
        fields = dict(zip(WORKLOAD_FIELDS[:-1], [cell.strip() for cell in row[1:10]]))
        fields['name'] = fields['name'] or 'Unspecified workload'
        fields['notes'] = ''
        workload = {**fields, 'source_row': number, 'entries': [], 'raw_row': original}
        current['workloads'].append(workload)
        for start, month in columns:
            values = row[start:start + 4]
            entry = dict(period=f'{year}-{month:02}', currency=currency, invoice_number=values[0].strip(),
                         customer_amount=None, distributor_amount=None, usage_amount=None,
                         payment_status=values[3].strip(), notes='', amount_basis='unspecified', status='recorded',
                         raw_cells=dict(zip(('invoice_id', 'amount', 'distributor', 'payment_status'), values)))
            issues = []
            for offset, field in ((1, 'customer_amount'), (2, 'distributor_amount')):
                try:
                    entry[field] = money(values[offset])
                except ValueError:
                    issues.append(f'{field.replace("_", " ")}: contains text or an ambiguous number')
            # A number in Payment Status or an RI/Azure marker in the amount
            # column is a shifted block. Retain ALL cells, count no money from it.
            try:
                if money(values[3]) is not None:
                    issues.append('Payment status contains a number; columns may be shifted')
            except ValueError:
                pass
            marker = values[0].strip().casefold()
            if marker in ('ri', 'azure', 'one time ri'):
                issues.append('Invoice column is a cost marker, not an invoice number')
            if values[0].strip():
                try:
                    if money(values[0]) is not None:
                        issues.append('Invoice column contains an amount')
                except ValueError:
                    pass
            if issues:
                entry.update(customer_amount=None, distributor_amount=None, status='needs_review', notes='; '.join(issues))
                warnings.append({'row': number, 'company': current['name'], 'period': entry['period'], 'reason': entry['notes']})
            workload['entries'].append(entry)
        if len(original) > width and any(cell.strip() for cell in original[width:]):
            raise HTTPException(422, f'Row {number} has non-empty columns beyond the declared months. Correct the CSV before importing.')
    if not companies or sum(len(c['workloads']) for c in companies.values()) > 2000:
        raise HTTPException(422, 'Import between 1 and 2000 workload rows.')
    return {'companies': list(companies.values()), 'year': year, 'currency': currency,
            'company_count': len(companies), 'workload_count': sum(len(c['workloads']) for c in companies.values()),
            'entry_count': sum(len(w['entries']) for c in companies.values() for w in c['workloads']),
            'warnings': warnings, 'source_hash': hashlib.sha256(content).hexdigest()}


async def one(db, sql, params):
    async with db.execute(sql, params) as cursor:
        row = await cursor.fetchone()
    return dict(row) if row else None


async def audit(db, owner, actor, kind, key, action, before, after):
    await db.execute('INSERT INTO billing_changes(id,owner_id,entity_type,entity_id,action,before_json,after_json,actor) VALUES(?,?,?,?,?,?,?,?)',
                     (str(uuid.uuid4()), owner, kind, key, action, json.dumps(before), json.dumps(after), actor))


async def get_entity(db, owner, kind, key):
    table = {'customer': 'billing_customers', 'workload': 'billing_workloads', 'entry': 'billing_ledger'}[kind]
    row = await one(db, f'SELECT * FROM {table} WHERE id=? AND owner_id=?', (key, owner))
    if not row:
        raise HTTPException(404, f'{kind.title()} not found.')
    return row


async def is_archived(db, owner, kind, key):
    return bool(await one(db, 'SELECT entity_id FROM billing_archives WHERE owner_id=? AND entity_type=? AND entity_id=?', (owner, kind, key)))


async def commit_import(db, owner, actor, preview, filename, path):
    key = str(uuid.uuid5(uuid.NAMESPACE_URL, f'billing-ledger:{owner}:{preview["source_hash"]}:{preview["year"]}'))
    prior = await one(db, 'SELECT * FROM billing_imports WHERE id=? AND owner_id=?', (key, owner))
    if prior:
        return {**json.loads(prior['summary']), 'duplicate': True, 'import_id': key}
    summary = {k: preview[k] for k in ('company_count', 'workload_count', 'entry_count', 'warnings', 'year', 'currency')}
    summary['customer_ids'] = []
    async with db.execute('SELECT id,name FROM billing_customers WHERE owner_id=?', (owner,)) as cursor:
        existing = {}
        for row in await cursor.fetchall():
            existing.setdefault(' '.join(row['name'].split()).casefold(), []).append(row['id'])
    try:
        await db.execute('BEGIN')
        # Claim this import in the database before creating its rows. A second
        # concurrent request collides here rather than duplicating customers.
        await db.execute('INSERT INTO billing_imports(id,owner_id,source_hash,billing_year,filename,blob_path,created_by,summary) VALUES(?,?,?,?,?,?,?,?)',
                         (key, owner, preview['source_hash'], preview['year'], filename, path, actor, '{}'))
        for company in preview['companies']:
            matches = existing.get(' '.join(company['name'].split()).casefold(), [])
            if len(matches) > 1:
                raise HTTPException(409, 'Multiple existing customers have the same name. Resolve duplicate profiles before importing.')
            customer = matches[0] if matches else str(uuid.uuid4())
            if matches and await is_archived(db, owner, 'customer', customer):
                raise HTTPException(409, 'An imported company matches a deleted customer. Restore that customer before importing.')
            if not matches:
                await db.execute('INSERT INTO billing_customers(id,owner_id,name,company,notes) VALUES(?,?,?,?,?)', (customer, owner, company['name'], company['name'], '\n'.join(company['warnings'])))
            summary['customer_ids'].append(customer)
            for work in company['workloads']:
                # Reuse workloads for new months/years, but never overwrite
                # metadata or existing month entries during another import.
                found = await one(db, 'SELECT id FROM billing_workloads WHERE owner_id=? AND customer_id=? AND name=?', (owner, customer, work['name']))
                workload = found['id'] if found else str(uuid.uuid4())
                if found and await is_archived(db, owner, 'workload', workload):
                    raise HTTPException(409, 'Restore the existing workload before importing new months.')
                if not found:
                    await db.execute(f'INSERT INTO billing_workloads(id,owner_id,customer_id,{",".join(WORKLOAD_FIELDS)}) VALUES({",".join("?" for _ in range(13))})',
                                     (workload, owner, customer, *[work[field] for field in WORKLOAD_FIELDS]))
                for entry in work['entries']:
                    if await one(db, 'SELECT id FROM billing_ledger WHERE owner_id=? AND workload_id=? AND period=?', (owner, workload, entry['period'])):
                        raise HTTPException(409, 'One or more months already exist for this workload. Edit those entries instead of overwriting them by import.')
                    await db.execute(f'INSERT INTO billing_ledger(id,owner_id,customer_id,workload_id,{",".join(ENTRY_FIELDS)},source_import_id,source_row,raw_cells,updated_by) VALUES({",".join("?" for _ in range(18))})',
                                     (str(uuid.uuid4()), owner, customer, workload, *[entry[field] for field in ENTRY_FIELDS], key, work['source_row'], json.dumps({'month': entry['raw_cells'], 'source_row': work['raw_row']}), actor))
        await db.execute('UPDATE billing_imports SET summary=? WHERE id=? AND owner_id=?', (json.dumps(summary), key, owner))
        await audit(db, owner, actor, 'import', key, 'create', {}, summary)
        await db.execute('COMMIT')
    except Exception:
        await db.execute('ROLLBACK')
        raise
    return {**summary, 'duplicate': False, 'import_id': key}


def month_totals(entries):
    groups = {}
    for row in entries:
        if row.get('archived') or row.get('workload_archived'):
            continue
        key = (row['period'], row['currency'])
        group = groups.setdefault(key, {'period': key[0], 'currency': key[1], 'customer_amount': None, 'distributor_amount': None, 'usage_amount': None, 'review_count': 0, 'record_count': 0, 'basis': set()})
        group['record_count'] += 1
        if row['status'] == 'needs_review':
            group['review_count'] += 1
            continue
        group['basis'].add(row['amount_basis'])
        for field in ('customer_amount', 'distributor_amount', 'usage_amount'):
            if row[field] is not None:
                group[field] = (group[field] or Decimal(0)) + Decimal(row[field])
    result = []
    for group in groups.values():
        revenue, cost = group['customer_amount'], group['distributor_amount']
        complete = all(row['distributor_amount'] is not None for row in entries
                       if (row['period'], row['currency']) == (group['period'], group['currency'])
                       and not row.get('archived') and not row.get('workload_archived')
                       and row['customer_amount'] is not None)
        profit = revenue - cost if revenue is not None and cost is not None and complete and group['review_count'] == 0 and group['basis'] == {'net'} else None
        group.pop('basis')
        result.append({**{key: str(value) if isinstance(value, Decimal) else value for key, value in group.items()}, 'profit': str(profit) if profit is not None else None})
    return sorted(result, key=lambda item: (item['period'], item['currency']))


async def customer_ledger(db, owner, customer):
    async with db.execute("SELECT w.*, a.entity_id IS NOT NULL AS archived FROM billing_workloads w LEFT JOIN billing_archives a ON a.owner_id=w.owner_id AND a.entity_type='workload' AND a.entity_id=w.id WHERE w.owner_id=? AND w.customer_id=? ORDER BY w.created_at,w.name", (owner, customer)) as cursor:
        workloads = [dict(row) for row in await cursor.fetchall()]
    async with db.execute("SELECT l.*, w.name AS workload, a.entity_id IS NOT NULL AS archived, wa.entity_id IS NOT NULL AS workload_archived FROM billing_ledger l JOIN billing_workloads w ON w.id=l.workload_id LEFT JOIN billing_archives a ON a.owner_id=l.owner_id AND a.entity_type='entry' AND a.entity_id=l.id LEFT JOIN billing_archives wa ON wa.owner_id=l.owner_id AND wa.entity_type='workload' AND wa.entity_id=l.workload_id WHERE l.owner_id=? AND l.customer_id=? ORDER BY l.period,w.name", (owner, customer)) as cursor:
        entries = [dict(row) for row in await cursor.fetchall()]
    for row in entries:
        row['raw_cells'] = json.loads(row['raw_cells'])
    return {'workloads': workloads, 'entries': entries, 'months': month_totals(entries)}
