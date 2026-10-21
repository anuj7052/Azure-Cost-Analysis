"""Read-only CRM dashboard with explicit daily allocation of monthly records."""
import calendar
from datetime import date
from decimal import Decimal, ROUND_HALF_UP

FIELDS = ('customer_amount', 'distributor_amount', 'usage_amount')
ZERO = Decimal(0)


def money(value):
    return str(value.quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)) if value is not None else None


def overlap(period, start, end):
    year, month = map(int, period.split('-'))
    days = calendar.monthrange(year, month)[1]
    first, last = date(year, month, 1), date(year, month, days)
    left, right = max(first, start), min(last, end)
    count = max(0, (right - left).days + 1)
    return count, days


def aggregate(customers, workloads, records, start, end, currency, source, extras=()):
    """Totals are summed from the same unrounded rows as the customer table.

    Date endpoints are inclusive. We know monthly totals, not daily usage.
    One-time or unspecified frequency cannot be allocated to partial months.
    Invoice documents have no frequency field and remain unallocated for partial
    months instead of turning an upfront purchase into recurring revenue.
    """
    currencies = sorted({r['currency'] for r in [*records, *extras] if r.get('currency')})
    selected = currency or (currencies[0] if len(currencies) == 1 else '')
    names = {c['id']: c['name'] for c in customers}
    rows = {c['id']: {'customer_id': c['id'], 'name': c['name'],
                     **{f: None for f in FIELDS}, 'record_count': 0, 'review_count': 0,
                     'unallocated_count': 0, 'missing_count': 0, 'prorated_count': 0,
                     'workload_count': sum(w['customer_id'] == c['id'] for w in workloads),
                     'extra_amount': None, '_net': True, '_paired': True} for c in customers}
    monthly = {}
    relevant = []
    by_distributor = {}
    for record in records:
        if record['customer_id'] not in names or (selected and record.get('currency') and record['currency'] != selected):
            continue
        days, month_days = overlap(record['period'], start, end)
        if not days:
            continue
        relevant.append(record)
        row = rows[record['customer_id']]
        row['record_count'] += 1
        if record.get('status') not in ('recorded', 'confirmed'):
            row['review_count'] += 1
            continue
        partial = days != month_days
        recurring = str(record.get('frequency') or '').strip().casefold() == 'monthly'
        if partial and not recurring:
            if any(record.get(f) is not None for f in FIELDS):
                row['unallocated_count'] += 1
            continue
        factor = Decimal(days) / Decimal(month_days) if partial else Decimal(1)
        if partial and any(record.get(f) is not None for f in FIELDS):
            row['prorated_count'] += 1
        bucket = monthly.setdefault(record['period'], {'period': record['period'], 'selected_days': days, 'calendar_days': month_days, **{f: None for f in FIELDS}})
        has_value = any(record.get(f) is not None for f in FIELDS)
        if has_value and record.get('amount_basis') != 'net':
            row['_net'] = False
        if (record.get('customer_amount') is None) != (record.get('distributor_amount') is None):
            # Imported rows can be paired at workload-month granularity. Invoice
            # documents are separate types and are paired by customer/month below.
            if source == 'ledger':
                row['_paired'] = False
        if any(record.get(f) is None for f in FIELDS):
            row['missing_count'] += 1
        for field in FIELDS:
            if record.get(field) is not None:
                value = Decimal(record[field]) * factor
                row[field] = (row[field] or ZERO) + value
                bucket[field] = (bucket[field] or ZERO) + value
        if record.get('distributor_amount') is not None:
            name = str(record.get('distributor') or '').strip() or 'Not set'
            by_distributor[name] = by_distributor.get(name, ZERO) + Decimal(record['distributor_amount']) * factor
    for extra in extras:
        # One-off charges (implementation, migration...) are billed income with
        # no distributor cost. They are counted only when the whole month is selected.
        if extra['customer_id'] not in names or (selected and extra['currency'] != selected):
            continue
        days, month_days = overlap(extra['period'], start, end)
        if not days:
            continue
        row = rows[extra['customer_id']]
        row['record_count'] += 1
        if days != month_days:
            row['unallocated_count'] += 1
            continue
        value = Decimal(extra['amount'])
        if extra.get('amount_basis') != 'net':
            row['_net'] = False
        row['extra_amount'] = (row['extra_amount'] or ZERO) + value
        row['customer_amount'] = (row['customer_amount'] or ZERO) + value
        cost = Decimal(extra['distributor_amount']) if extra.get('distributor_amount') not in (None, '') else ZERO
        row['distributor_amount'] = (row['distributor_amount'] or ZERO) + cost
        bucket = monthly.setdefault(extra['period'], {'period': extra['period'], 'selected_days': days, 'calendar_days': month_days, **{f: None for f in FIELDS}})
        bucket['customer_amount'] = (bucket['customer_amount'] or ZERO) + value
        if cost:
            bucket['distributor_amount'] = (bucket['distributor_amount'] or ZERO) + cost
            name = str(extra.get('distributor') or '').strip() or 'Not set'
            by_distributor[name] = by_distributor.get(name, ZERO) + cost
    if source == 'invoices':
        for row in rows.values():
            periods = {r['period'] for r in relevant if r['customer_id'] == row['customer_id'] and (r.get('customer_amount') is not None or r.get('distributor_amount') is not None)}
            row['_paired'] = all(
                any(r['customer_id'] == row['customer_id'] and r['period'] == p and r.get('customer_amount') is not None and r['status'] == 'confirmed' for r in relevant)
                and any(r['customer_id'] == row['customer_id'] and r['period'] == p and r.get('distributor_amount') is not None and r['status'] == 'confirmed' for r in relevant)
                for p in periods)
    values = list(rows.values())
    totals = {'extra_amount': sum((r['extra_amount'] for r in values if r['extra_amount'] is not None), ZERO) if any(r['extra_amount'] is not None for r in values) else None}
    totals.update({f: sum((r[f] for r in values if r[f] is not None), ZERO) if any(r[f] is not None for r in values) else None for f in FIELDS})
    for row in values:
        row['profit'] = row['customer_amount'] - row['distributor_amount'] if row['_net'] and row['_paired'] and not row['review_count'] and not row['unallocated_count'] and row['customer_amount'] is not None and row['distributor_amount'] is not None else None
    # Do not sum only profitable/complete customers into a misleading overall P/L.
    contributors = [r for r in values if r['customer_amount'] is not None or r['distributor_amount'] is not None or r['review_count'] or r['unallocated_count']]
    totals['profit'] = sum((r['profit'] for r in contributors), ZERO) if contributors and all(r['profit'] is not None for r in contributors) else None
    mixed = not selected and len(currencies) > 1
    def public(row):
        return {k: None if mixed and k in (*FIELDS, 'profit', 'extra_amount') else money(v) if isinstance(v, Decimal) else v for k, v in row.items() if not k.startswith('_')}
    return {
        'from_date': start.isoformat(), 'to_date': end.isoformat(), 'days': (end - start).days + 1,
        'source': source, 'currency': selected or None, 'currencies': currencies,
        'currency_required': mixed, 'customer_count': len(customers),
        'customers_with_records': sum(r['record_count'] > 0 for r in values),
        'workload_count': len(workloads),
        'workloads_with_records': len({r['workload_id'] for r in relevant if r.get('workload_id')}),
        'review_count': sum(r['review_count'] for r in values),
        'unallocated_count': sum(r['unallocated_count'] for r in values),
        'prorated_count': sum(r['prorated_count'] for r in values),
        'totals': public(totals), 'customers': [public(r) for r in values],
        'months': [public(monthly[p]) for p in sorted(monthly)],
        'distributors': [] if mixed else [{'name': k, 'amount': money(v)} for k, v in sorted(by_distributor.items(), key=lambda item: -item[1])],
        'basis': 'Recurring monthly ledger amounts are allocated by selected calendar days. Partial-month invoices and one-time/unknown-frequency amounts are unallocated. This is not measured daily Azure usage.',
    }


async def load(db, owner, start, end, currency='', source='ledger', customer_id=''):
    async with db.execute("SELECT c.id,c.name FROM billing_customers c WHERE c.owner_id=? AND NOT EXISTS (SELECT 1 FROM billing_archives a WHERE a.owner_id=c.owner_id AND a.entity_type='customer' AND a.entity_id=c.id) ORDER BY c.name", (owner,)) as cursor:
        customers = [dict(r) for r in await cursor.fetchall()]
    if customer_id:
        customers = [c for c in customers if c['id'] == customer_id]
    async with db.execute("SELECT w.id,w.customer_id,w.frequency FROM billing_workloads w WHERE w.owner_id=? AND NOT EXISTS (SELECT 1 FROM billing_archives a WHERE a.owner_id=w.owner_id AND a.entity_type='workload' AND a.entity_id=w.id)", (owner,)) as cursor:
        allowed = {c['id'] for c in customers}
        workloads = [dict(r) for r in await cursor.fetchall() if r['customer_id'] in allowed]
    first, last = start.strftime('%Y-%m'), end.strftime('%Y-%m')
    if source == 'ledger':
        async with db.execute("SELECT l.* FROM billing_ledger l WHERE l.owner_id=? AND l.period>=? AND l.period<=? AND NOT EXISTS (SELECT 1 FROM billing_archives a WHERE a.owner_id=l.owner_id AND a.entity_type='entry' AND a.entity_id=l.id)", (owner, first, last)) as cursor:
            by_id = {w['id']: w for w in workloads}
            records = [{**dict(r), 'frequency': by_id[r['workload_id']]['frequency']} for r in await cursor.fetchall() if r['workload_id'] in by_id]
    else:
        async with db.execute("SELECT * FROM billing_documents WHERE owner_id=? AND period>=? AND period<=? AND status<>'void'", (owner, first, last)) as cursor:
            records = []
            mapping = {'customer': FIELDS[0], 'distributor': FIELDS[1], 'azure_usage': FIELDS[2]}
            for r in await cursor.fetchall():
                if r['customer_id'] not in allowed:
                    continue
                records.append({**dict(r), **{f: r['net_amount'] if f == mapping[r['kind']] else None for f in FIELDS}, 'amount_basis': 'net', 'frequency': ''})
    extras = []
    if source == 'ledger':
        async with db.execute("SELECT customer_id,period,amount,currency,amount_basis,distributor,distributor_amount FROM billing_extra_charges WHERE owner_id=? AND period>=? AND period<=?", (owner, first, last)) as cursor:
            extras = [dict(r) for r in await cursor.fetchall() if r['customer_id'] in {c['id'] for c in customers}]
    return aggregate(customers, workloads, records, start, end, currency, source, extras)
