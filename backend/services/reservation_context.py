"""Reservation evidence from billing dimensions, never from service names."""
def reservation_context(records):
    services = {}
    for row in records:
        if str(row.get('PricingModel') or '').lower() != 'reservation':
            continue
        service = row.get('ServiceName') or row.get('MeterCategory') or 'Unknown'
        entry = services.setdefault(service, {'cost': 0.0, 'purchase_cost': 0.0, 'refund_cost': 0.0, 'charge_types': []})
        cost = next((float(row[key]) for key in ('PreTaxCost', 'Cost', 'totalCost') if row.get(key) is not None), 0.0)
        charge = str(row.get('ChargeType') or 'Unknown')
        entry['cost'] += cost
        if charge.lower() == 'purchase':
            entry['purchase_cost'] += cost
        if charge.lower() == 'refund':
            entry['refund_cost'] += cost
        if charge not in entry['charge_types']:
            entry['charge_types'].append(charge)
    return services
