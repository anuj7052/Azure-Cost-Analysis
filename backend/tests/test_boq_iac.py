from __future__ import annotations

import pytest

from core.config import settings
from services.boq_chat_service import BoqChatService
from services.boq_parser import _to_amount, parse_boq_file
from services.iac_service import build_plan, to_bicep, to_terraform

ESTIMATE_CSV = """Microsoft Azure Estimate,,,,,,
SAP Landing Zone,,,,,,
,,,,,,
Service category,Service type,Custom name,Region,Description,,
Storage,Managed Disks,mmshdb01_datadisk_0,Central India,"Premium SSD Managed Disks, LRS Redundancy, P40 Disk Type, 1 Disks","24,450.00",
Storage,Managed Disks,,Central India,"Standard SSD Managed Disks, LRS Redundancy, E20 Disk Type, 3 Disks","1,980.00",
Compute,Virtual Machines,sapapp01,Central India,"1 instances, Linux, E16s v5, Pay as you go","41,668.64",
Networking,Public IP,,Central India,"1 IP address, Standard","250.50",
Support,Support,,,Standard Support,"8,000.00",
,,,,Infrastructure subtotal,"68,349.14",
,,,,Total Monthly Cost,"76,349.14",
Disclaimer,,,,All prices shown are in Indian Rupee (INR),,
"""


@pytest.fixture
def boq() -> dict:
    return parse_boq_file(ESTIMATE_CSV.encode("utf-8"), "estimate.csv")


def test_amounts_survive_locale_formatting():
    assert _to_amount("? 41,668.64") == 41668.64
    assert _to_amount("1 234,50") == 1234.50
    assert _to_amount("") is None


def test_parser_reads_items_totals_and_currency(boq):
    assert boq["name"] == "SAP Landing Zone"
    assert boq["currency"] == "INR"
    assert len(boq["items"]) == 5
    assert boq["total_monthly"] == 76349.14
    assert boq["infrastructure_subtotal"] == 68349.14


def test_parser_rejects_a_file_that_is_not_an_estimate():
    with pytest.raises(ValueError, match="Service category"):
        parse_boq_file(b"a,b,c\n1,2,3\n", "random.csv")


def test_disk_lines_recover_sku_size_and_quantity(boq):
    disks = [r for r in build_plan(boq)["resources"] if r["kind"] == "managed_disk"]
    assert len(disks) == 2

    premium = disks[0]
    assert premium["sku"] == "Premium_LRS"
    assert premium["size_gib"] == 2048  # P40
    assert premium["count"] == 1  # "P40 ... 1 Disks", not 40

    standard = disks[1]
    assert standard["sku"] == "StandardSSD_LRS"
    assert standard["size_gib"] == 512  # E20
    assert standard["count"] == 3


def test_vm_line_recovers_size_and_os(boq):
    vm = next(r for r in build_plan(boq)["resources"] if r["kind"] == "virtual_machine")
    assert vm["sku"] == "Standard_E16s_v5"
    assert vm["properties"]["os"] == "Linux"


def test_support_is_flagged_for_review_not_deployed(boq):
    plan = build_plan(boq)
    assert not any(r["kind"] == "support" for r in plan["resources"])
    assert any("Support" in r["service_type"] for r in plan["needs_review"])


def test_region_is_normalised(boq):
    assert build_plan(boq)["location"] == "centralindia"


def test_duplicate_names_are_disambiguated():
    boq = {
        "items": [
            {
                "service_category": "Storage",
                "service_type": "Managed Disks",
                "custom_name": "",
                "region": "Central India",
                "description": "Premium SSD, LRS Redundancy, P30 Disk Type, 1 Disks",
                "monthly_cost": 100.0,
            }
        ]
        * 2
    }
    names = [r["name"] for r in build_plan(boq)["resources"]]
    assert len(set(names)) == 2


def test_bicep_output_is_scoped_and_covers_every_resource(boq):
    template = to_bicep(build_plan(boq, resource_group="rg-sap"))
    assert "targetScope = 'resourceGroup'" in template
    assert "Microsoft.Compute/disks@" in template
    assert "diskSizeGB: 2048" in template
    assert "range(0, 3)" in template  # the three E20 disks
    assert "NEEDS REVIEW" in template


def test_terraform_output_declares_provider_and_resource_group(boq):
    template = to_terraform(build_plan(boq, resource_group="rg-sap"))
    assert 'source  = "hashicorp/azurerm"' in template
    assert 'default = "rg-sap"' in template
    assert 'storage_account_type = "Premium_LRS"' in template
    assert "count               = 3" in template


def test_generated_storage_accounts_are_not_publicly_readable():
    boq = {
        "items": [
            {
                "service_category": "Storage",
                "service_type": "Storage Accounts",
                "custom_name": "saplogs",
                "region": "Central India",
                "description": "Block Blob Storage, GRS Redundancy",
                "monthly_cost": 500.0,
            }
        ]
    }
    plan = build_plan(boq)
    assert "allowBlobPublicAccess: false" in to_bicep(plan)
    assert "public_network_access_enabled = false" in to_terraform(plan)


# --- chat tool surface (no network) -----------------------------------


@pytest.mark.asyncio
async def test_chat_tools_report_when_no_boq_is_attached():
    service = BoqChatService(None)
    assert await service._summarise_boq() == {"uploaded": False}
    assert await service._plan_resources() == {"uploaded": False}
    assert await service._generate_iac(format="bicep") == {"uploaded": False}


@pytest.mark.asyncio
async def test_generate_iac_tool_attaches_the_template_out_of_band(boq):
    service = BoqChatService(boq, resource_group="rg-sap")
    result = await service._generate_iac(format="terraform")

    assert result["filename"] == "main.tf"
    # The model sees only the shape, never the template body.
    assert "content" not in result
    assert len(service.artifacts) == 1
    assert 'default = "rg-sap"' in service.artifacts[0]["content"]


@pytest.mark.asyncio
async def test_generate_iac_tool_rejects_an_unknown_format(boq):
    result = await BoqChatService(boq)._generate_iac(format="cloudformation")
    assert result["format"] == "bicep"


@pytest.mark.asyncio
async def test_regenerating_the_same_format_replaces_the_artifact(boq):
    service = BoqChatService(boq)
    await service._generate_iac(format="bicep")
    await service._generate_iac(format="terraform")
    await service._generate_iac(format="bicep")
    assert sorted(a["format"] for a in service.artifacts) == ["bicep", "terraform"]


@pytest.mark.asyncio
async def test_chat_refuses_to_run_without_an_api_key(boq, monkeypatch):
    from fastapi import HTTPException

    monkeypatch.setattr(settings, "OPENAI_API_KEY", "")
    with pytest.raises(HTTPException) as excinfo:
        await BoqChatService(boq).chat("build it")
    assert excinfo.value.status_code == 503
