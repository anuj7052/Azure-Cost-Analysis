from unittest.mock import AsyncMock
import pytest
from services import commitments as c

def pages(rows):
    columns = list(rows[0])
    return [{'properties': {'columns': [{'name': key} for key in columns], 'rows': [[row.get(key) for key in columns] for row in rows]}}]


@pytest.mark.asyncio
async def test_falls_back_when_benefit_dimensions_are_blank(monkeypatch):
    read = AsyncMock(side_effect=[
        pages([{'BenefitId': '', 'BenefitName': '', 'PreTaxCost': 500}]),
        pages([{'ReservationId': 'ri-id', 'ReservationName': 'RI', 'PreTaxCost': 100, 'ChargeType': 'Usage', 'Currency': 'INR'},
         {'ReservationId': 'ri-id', 'ReservationName': 'RI', 'PreTaxCost': 20, 'ChargeType': 'UnusedReservation', 'Currency': 'INR'}]),
    ])
    monkeypatch.setattr(c, '_run_paged_query', read)
    costs, currency, errors = await c.fetch_amortised_costs('token', ['sub'], '2026-08-01', '2026-08-30')
    assert read.await_count == 2
    assert costs['ri-id'] == {'cost': 120, 'unused': 20}
    assert currency == 'INR'
    assert errors == []


@pytest.mark.asyncio
async def test_zero_cost_is_kept_and_aliases_are_not_double_counted(monkeypatch):
    read = AsyncMock(return_value=pages([{'BenefitId': 'same', 'BenefitName': 'same', 'PreTaxCost': 0, 'ChargeType': 'Usage'}]))
    monkeypatch.setattr(c, '_run_paged_query', read)
    costs, _, _ = await c.fetch_amortised_costs('token', ['sub'], '2026-08-01', '2026-08-30')
    assert costs['same'] == {'cost': 0, 'unused': 0}


def test_full_benefit_path_matches_reservation_leaf():
    items = [{'id': '/providers/Microsoft.Capacity/reservationOrders/order/reservations/ri', 'name': 'renamed'}]
    c.attach_costs(items, {'/different/prefix/ri': {'cost': 90, 'unused': 20}}, 'INR')
    assert items[0]['monthly_cost'] == 90
    assert items[0]['measured_wastage'] == 20


@pytest.mark.asyncio
async def test_missing_charge_type_does_not_claim_zero_measured_waste(monkeypatch):
    monkeypatch.setattr(c, '_run_paged_query', AsyncMock(return_value=pages([{'BenefitId': 'ri', 'PreTaxCost': 50}])))
    costs, _, _ = await c.fetch_amortised_costs('token', ['sub'], '2026-08-01', '2026-08-30')
    assert costs['ri']['unused'] is None
