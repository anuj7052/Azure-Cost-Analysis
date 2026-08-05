from __future__ import annotations

import pytest

from app.integrations.azure.cost import (
    _parse_resource_id,
    _parse_additional_info,
    is_bandwidth_meter,
)
from app.services.cost_service import _to_gb


@pytest.mark.parametrize(
    "category,meter",
    [
        ("Bandwidth", "Data Transfer Out - Inter Region"),
        ("Storage", "Geo-Replication Data transfer"),
        ("Virtual Network", "Peering Egress"),
        ("Content Delivery Network", "Zone 1 Data Transfer"),
        ("Azure Front Door Service", "Egress - North America"),
    ],
)
def test_data_transfer_meters_are_detected(category: str, meter: str):
    assert is_bandwidth_meter(category, meter) is True


@pytest.mark.parametrize(
    "category,meter",
    [
        ("Virtual Machines", "D2s v3"),
        ("Storage", "Hot LRS Data Stored"),
        ("Azure Kubernetes Service", "Standard Uptime SLA"),
    ],
)
def test_non_transfer_meters_are_not_flagged(category: str, meter: str):
    assert is_bandwidth_meter(category, meter) is False


@pytest.mark.parametrize(
    "quantity,unit,expected",
    [
        (5.0, "1 GB", 5.0),
        (2.0, "10 GB", 20.0),
        (3.0, "1 TB", 3072.0),
        (512.0, "1 MB", 0.5),
        (7.0, "", 7.0),
    ],
)
def test_billed_quantity_normalises_to_gb(quantity: float, unit: str, expected: float):
    assert _to_gb(quantity, unit) == pytest.approx(expected)


def test_resource_id_is_decomposed():
    parsed = _parse_resource_id(
        "/subscriptions/abc/resourceGroups/rg-prod/providers/"
        "Microsoft.Compute/virtualMachines/vm-web-01"
    )
    assert parsed == {
        "group": "rg-prod",
        "type": "Microsoft.Compute/virtualMachines",
        "name": "vm-web-01",
    }


def test_resource_id_parser_tolerates_garbage():
    assert _parse_resource_id("") == {"group": "", "type": "", "name": ""}


def test_additional_info_json_string_is_parsed():
    assert _parse_additional_info('{"VMName":"vm-1"}') == {"VMName": "vm-1"}


def test_additional_info_invalid_json_is_kept_raw():
    assert _parse_additional_info("not json") == {"raw": "not json"}
