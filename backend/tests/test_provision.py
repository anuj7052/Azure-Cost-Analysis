"""
What the build assistant must never get wrong.

Two properties are worth more than the rest and are tested hardest: an endpoint
cannot be registered without a daily limit, and the assistant cannot deploy.
Everything else is a detail; those two are the difference between a helpful
tool and an unbounded bill.
"""

import aiosqlite
import pytest

from services import integration_service as isvc
from services import provision_service as psvc


# ── rate limits ─────────────────────────────────────────────────────────────

def test_registering_without_a_limit_is_refused():
    with pytest.raises(ValueError) as exc:
        isvc.validate_rate_limit(None)
    assert "daily request limit" in str(exc.value).lower()


def test_a_blank_limit_is_refused_rather_than_treated_as_unlimited():
    with pytest.raises(ValueError):
        isvc.validate_rate_limit("")


@pytest.mark.parametrize("bad", [0, -1, isvc.MAX_RATE_LIMIT + 1])
def test_limits_outside_the_allowed_range_are_refused(bad):
    with pytest.raises(ValueError):
        isvc.validate_rate_limit(bad)


def test_a_non_numeric_limit_is_refused():
    with pytest.raises(ValueError):
        isvc.validate_rate_limit("lots")


def test_a_sensible_limit_is_accepted_from_a_string():
    assert isvc.validate_rate_limit("250") == 250


async def _integration(db, limit):
    return await isvc.create_integration(
        db, 1,
        {"label": f"ep-{limit}", "kind": "openai", "api_key": "sk-test-abcd1234",
         "rate_limit_per_day": limit},
    )


@pytest.fixture
async def db(tmp_path, monkeypatch):
    from core import db as db_module
    monkeypatch.setattr(db_module, "DB_PATH", str(tmp_path / "t.db"))
    await db_module.init_db()
    async with aiosqlite.connect(str(tmp_path / "t.db")) as conn:
        conn.row_factory = aiosqlite.Row
        await conn.execute(
            "INSERT INTO users (id, azure_oid, email) VALUES (1, 'oid-1', 'a@b.com')"
        )
        await conn.commit()
        yield conn


async def test_the_limit_is_enforced_and_the_next_call_is_refused(db):
    created = await _integration(db, 2)
    await isvc.consume(db, created["id"], created["label"])
    await isvc.consume(db, created["id"], created["label"])
    with pytest.raises(isvc.RateLimitExceeded):
        await isvc.consume(db, created["id"], created["label"])


async def test_the_refusal_names_the_endpoint_and_the_number(db):
    created = await _integration(db, 3)
    for _ in range(3):
        await isvc.consume(db, created["id"], created["label"])
    with pytest.raises(isvc.RateLimitExceeded) as exc:
        await isvc.consume(db, created["id"], created["label"])
    assert created["label"] in str(exc.value)
    assert "3" in str(exc.value)


async def test_usage_is_reported_back_so_the_ui_never_computes_it(db):
    created = await _integration(db, 10)
    await isvc.consume(db, created["id"], created["label"])
    listed = await isvc.list_integrations(db, 1)
    row = next(r for r in listed if r["id"] == created["id"])
    assert row["used_today"] == 1
    assert row["remaining_today"] == 9


async def test_the_key_is_never_returned_only_a_hint(db):
    created = await _integration(db, 5)
    assert "sk-test" not in str(created)
    assert created["key_hint"].endswith("1234")
    assert created["has_key"] is True


async def test_the_platform_key_is_not_governed_by_this_table(db):
    # A None integration id means the deployment-wide key, whose budget is the
    # operator's problem. It must not raise or write a usage row.
    await isvc.consume(db, None, "platform")


async def test_llm_config_carries_the_id_so_usage_lands_on_the_right_row(db):
    created = await _integration(db, 7)
    config = await isvc.llm_config(db, 1)
    assert config["integration_id"] == created["id"]
    assert config["rate_limit_per_day"] == 7


# ── drafting ────────────────────────────────────────────────────────────────

def test_a_vm_without_a_name_reports_the_name_as_missing():
    draft = psvc.draft("linux_vm", {})
    assert draft["ready"] is False
    assert [m["name"] for m in draft["missing"]] == ["name"]


def test_a_suggested_size_is_reported_as_assumed_not_silently_applied():
    draft = psvc.draft("linux_vm", {"name": "web01"})
    assert draft["ready"] is True
    assert draft["fields"]["size"] == "Standard_B2s"
    assumed = {a["name"] for a in draft["assumed"]}
    assert "size" in assumed and "admin_username" in assumed


def test_a_value_the_user_gave_is_never_overridden_by_a_suggestion():
    draft = psvc.draft("linux_vm", {"name": "web01", "size": "Standard_D4s_v5"})
    assert draft["fields"]["size"] == "Standard_D4s_v5"
    assert "size" not in {a["name"] for a in draft["assumed"]}


def test_an_unknown_resource_kind_is_refused_with_the_list_of_real_ones():
    with pytest.raises(psvc.ProvisionError) as exc:
        psvc.draft("quantum_computer", {"name": "q1"})
    assert "linux_vm" in exc.value.message


@pytest.mark.parametrize("name", ["-bad", "a" * 40, "web_01"])
def test_invalid_vm_names_are_refused(name):
    with pytest.raises(psvc.ProvisionError):
        psvc.draft("linux_vm", {"name": name})


def test_an_empty_name_is_reported_as_missing_rather_than_invalid():
    # "You did not tell me the name" and "that name is not allowed" are
    # different problems and deserve different answers.
    draft = psvc.draft("linux_vm", {"name": ""})
    assert draft["ready"] is False
    assert [m["name"] for m in draft["missing"]] == ["name"]


@pytest.mark.parametrize("name", ["UPPER", "ab", "a" * 30, "has-hyphen"])
def test_invalid_storage_account_names_are_refused(name):
    with pytest.raises(psvc.ProvisionError):
        psvc.draft("storage_account", {"name": name})


def test_azures_reserved_admin_usernames_are_refused_before_azure_sees_them():
    with pytest.raises(psvc.ProvisionError) as exc:
        psvc.draft("linux_vm", {"name": "web01", "admin_username": "root"})
    assert "root" in exc.value.message


def test_an_ssh_source_that_is_not_a_cidr_is_refused():
    with pytest.raises(psvc.ProvisionError):
        psvc.draft("linux_vm", {"name": "web01", "allow_ssh_from": "anywhere"})


def test_an_absurd_disk_size_is_refused():
    with pytest.raises(psvc.ProvisionError):
        psvc.draft("linux_vm", {"name": "web01", "os_disk_gib": 9999})


# ── template ────────────────────────────────────────────────────────────────

SSH = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIexampleexampleexample user@host"


def _vm_template(**overrides):
    fields = {"name": "web01", **overrides}
    return psvc.build_template([psvc.draft("linux_vm", fields)], "centralindia", SSH)


def test_a_vm_is_built_with_everything_it_needs_to_exist():
    types = [r["type"] for r in _vm_template()["resources"]]
    assert types == [
        "Microsoft.Network/networkSecurityGroups",
        "Microsoft.Network/virtualNetworks",
        "Microsoft.Network/publicIPAddresses",
        "Microsoft.Network/networkInterfaces",
        "Microsoft.Compute/virtualMachines",
    ]


def test_a_vm_is_not_exposed_to_the_internet_unless_a_range_was_given():
    nsg = _vm_template()["resources"][0]
    assert nsg["properties"]["securityRules"] == []


def test_naming_a_range_opens_ssh_to_exactly_that_range():
    nsg = _vm_template(allow_ssh_from="203.0.113.4/32")["resources"][0]
    rule = nsg["properties"]["securityRules"][0]["properties"]
    assert rule["sourceAddressPrefix"] == "203.0.113.4/32"
    assert rule["destinationPortRange"] == "22"


def test_password_login_is_disabled_and_the_key_is_the_one_supplied():
    vm = _vm_template()["resources"][-1]
    linux = vm["properties"]["osProfile"]["linuxConfiguration"]
    assert linux["disablePasswordAuthentication"] is True
    assert linux["ssh"]["publicKeys"][0]["keyData"] == SSH


def test_a_vm_without_an_ssh_key_is_refused_rather_than_built_unreachable():
    with pytest.raises(psvc.ProvisionError) as exc:
        psvc.build_template([psvc.draft("linux_vm", {"name": "web01"})], "centralindia", "")
    assert "public key" in exc.value.message


def test_something_that_is_not_an_ssh_key_is_refused():
    with pytest.raises(psvc.ProvisionError):
        psvc.build_template(
            [psvc.draft("linux_vm", {"name": "web01"})], "centralindia", "hunter2"
        )


def test_a_storage_account_is_never_created_with_public_blob_access():
    template = psvc.build_template(
        [psvc.draft("storage_account", {"name": "acct12345"})], "centralindia"
    )
    props = template["resources"][0]["properties"]
    assert props["allowBlobPublicAccess"] is False
    assert props["supportsHttpsTrafficOnly"] is True
    assert props["minimumTlsVersion"] == "TLS1_2"


def test_a_web_app_gets_a_plan_and_enforces_https():
    template = psvc.build_template(
        [psvc.draft("web_app", {"name": "my-app"})], "centralindia"
    )
    types = [r["type"] for r in template["resources"]]
    assert types == ["Microsoft.Web/serverfarms", "Microsoft.Web/sites"]
    assert template["resources"][1]["properties"]["httpsOnly"] is True


def test_a_bogus_region_is_refused_before_anything_reaches_azure():
    with pytest.raises(psvc.ProvisionError):
        psvc.build_template(
            [psvc.draft("storage_account", {"name": "acct12345"})], "../../subscriptions"
        )


# ── the assistant cannot deploy ─────────────────────────────────────────────

def test_the_chat_tool_surface_contains_no_way_to_create_anything():
    """
    The load-bearing test in this file.

    If a future change adds a deploy tool here, a sentence becomes a spend.
    The assistant is allowed to read the catalogue, draft and price; nothing
    else.
    """
    from services.provision_chat_service import ProvisionChatService

    names = {t["function"]["name"] for t in ProvisionChatService._tool_schema()}
    assert names == {"list_supported_resources", "draft_resource", "price_draft"}

    service = ProvisionChatService()
    assert set(service._tools) == names
    for attribute in dir(service):
        assert "deploy" not in attribute.lower()
        assert "create" not in attribute.lower()


def test_the_system_prompt_forbids_claiming_a_deployment():
    from services.provision_chat_service import SYSTEM_PROMPT

    assert "cannot deploy" in SYSTEM_PROMPT
    assert "Never ask for a password" in SYSTEM_PROMPT


async def test_a_ready_draft_is_captured_for_the_create_button(monkeypatch):
    from services.provision_chat_service import ProvisionChatService

    async def no_price(*_args, **_kwargs):
        return {"monthly": None, "currency": "INR", "basis": "Not available"}

    monkeypatch.setattr(psvc, "estimate_monthly", no_price)
    service = ProvisionChatService()
    result = await service._draft_resource(kind="linux_vm", name="web01")
    assert result["ready"] is True
    assert len(service.drafts) == 1
    assert service.drafts[0]["fields"]["name"] == "web01"


async def test_an_incomplete_draft_never_reaches_the_create_button(monkeypatch):
    from services.provision_chat_service import ProvisionChatService

    service = ProvisionChatService()
    result = await service._draft_resource(kind="linux_vm")
    assert result["ready"] is False
    assert service.drafts == []


async def test_correcting_a_draft_replaces_it_rather_than_stacking_two(monkeypatch):
    from services.provision_chat_service import ProvisionChatService

    async def no_price(*_args, **_kwargs):
        return {"monthly": None, "currency": "INR", "basis": "Not available"}

    monkeypatch.setattr(psvc, "estimate_monthly", no_price)
    service = ProvisionChatService()
    await service._draft_resource(kind="linux_vm", name="web01")
    await service._draft_resource(kind="linux_vm", name="web02")
    assert len(service.drafts) == 1
    assert service.drafts[0]["fields"]["name"] == "web02"


async def test_a_refused_draft_is_returned_as_an_error_not_raised(monkeypatch):
    from services.provision_chat_service import ProvisionChatService

    service = ProvisionChatService()
    result = await service._draft_resource(kind="linux_vm", name="not a valid name!")
    assert "error" in result
    assert service.drafts == []


# ── pricing honesty ─────────────────────────────────────────────────────────

async def test_an_unpriceable_resource_reads_not_available_rather_than_zero(monkeypatch):
    async def empty(*_args, **_kwargs):
        return []

    monkeypatch.setattr(psvc, "fetch_prices", empty)
    price = await psvc.estimate_monthly(
        psvc.draft("linux_vm", {"name": "web01"}), "centralindia", "INR"
    )
    assert price["monthly"] is None
    assert price["basis"] == "Not available"


async def test_a_pricing_failure_never_blocks_a_draft(monkeypatch):
    async def boom(*_args, **_kwargs):
        raise RuntimeError("price list down")

    monkeypatch.setattr(psvc, "fetch_prices", boom)
    price = await psvc.estimate_monthly(
        psvc.draft("linux_vm", {"name": "web01"}), "centralindia", "INR"
    )
    assert price["monthly"] is None


async def test_an_empty_storage_account_is_not_quoted_as_free(monkeypatch):
    price = await psvc.estimate_monthly(
        psvc.draft("storage_account", {"name": "acct12345"}), "centralindia", "INR"
    )
    assert price["monthly"] is None
    assert "usage" in price["note"].lower()


async def test_a_vm_price_is_hours_times_the_retail_rate(monkeypatch):
    async def one_rate(*_args, **_kwargs):
        return [{"retail_price": 2.0, "product_name": "Virtual Machines Bs Series",
                 "meter_name": "B2s", "sku_name": "B2s"}]

    monkeypatch.setattr(psvc, "fetch_prices", one_rate)
    price = await psvc.estimate_monthly(
        psvc.draft("linux_vm", {"name": "web01"}), "centralindia", "INR"
    )
    assert price["monthly"] == 2.0 * psvc.HOURS_PER_MONTH


async def test_windows_and_spot_rates_are_excluded_from_a_linux_vm_price(monkeypatch):
    async def rates(*_args, **_kwargs):
        return [
            {"retail_price": 0.5, "product_name": "VM Bs Series Windows", "meter_name": "B2s"},
            {"retail_price": 0.1, "product_name": "VM Bs Series", "meter_name": "B2s Spot"},
            {"retail_price": 2.0, "product_name": "VM Bs Series", "meter_name": "B2s"},
        ]

    monkeypatch.setattr(psvc, "fetch_prices", rates)
    price = await psvc.estimate_monthly(
        psvc.draft("linux_vm", {"name": "web01"}), "centralindia", "INR"
    )
    assert price["monthly"] == 2.0 * psvc.HOURS_PER_MONTH
