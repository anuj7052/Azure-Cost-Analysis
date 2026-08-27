"""
The resize path — the only code here that changes a customer's infrastructure.

These tests are written against the question a reviewer would actually ask
before letting this ship: *can it resize the wrong machine, resize on stale
information, claim a success it did not verify, or invent a number it was not
given?*

Nothing here talks to Azure. Every Azure response is a `MockTransport` the test
controls, so a failure means the logic is wrong rather than that a token
expired.
"""
import json

import aiosqlite
import httpx
import pytest
import pytest_asyncio

import core.db as db_module
from core.config import settings
from services import user_service, vm_resize as r
from services import retail_prices
from services.retail_prices import price_cache


RESOURCE = (
    "/subscriptions/sub-1/resourceGroups/rg-1"
    "/providers/Microsoft.Compute/virtualMachines/abhinav-vm"
)


# ── fixtures ────────────────────────────────────────────────────────────────


@pytest_asyncio.fixture
async def db(tmp_path, monkeypatch):
    path = str(tmp_path / "resize.db")
    monkeypatch.setattr(db_module, "DB_PATH", path)
    await db_module.init_db()
    conn = await aiosqlite.connect(path)
    conn.row_factory = aiosqlite.Row
    await conn.execute("PRAGMA foreign_keys = ON")
    yield conn
    await conn.close()


@pytest_asyncio.fixture
async def account(db):
    user = await user_service.upsert_user(
        db,
        {"user_id": "oid-1", "name": "Anuj", "email": "anuj@example.com",
         "tenant_id": "tenant-1"},
    )
    return {"account_id": user["id"], "tenant_id": "tenant-1"}


def vm_payload(sku="Standard_D8as_v5", power="running", data_disks=0):
    return {
        "name": "abhinav-vm",
        "location": "centralindia",
        "properties": {
            "hardwareProfile": {"vmSize": sku},
            "provisioningState": "Succeeded",
            "storageProfile": {
                "osDisk": {"osType": "Linux"},
                "dataDisks": [{} for _ in range(data_disks)],
            },
            "instanceView": {
                "statuses": [
                    {"code": "ProvisioningState/succeeded"},
                    {"code": f"PowerState/{power}"},
                ]
            },
        },
    }


def sku_payload(name, family, vcpu, memory, arch="x64", max_disks=16,
                restrictions=None):
    return {
        "name": name,
        "resourceType": "virtualMachines",
        "family": family,
        "capabilities": [
            {"name": "vCPUs", "value": str(vcpu)},
            {"name": "MemoryGB", "value": str(memory)},
            {"name": "CpuArchitectureType", "value": arch},
            {"name": "MaxDataDiskCount", "value": str(max_disks)},
            {"name": "HyperVGenerations", "value": "V1,V2"},
            {"name": "MaxResourceVolumeMB", "value": "16384"},
        ],
        "restrictions": restrictions or [],
    }


DEFAULT_SKUS = [
    sku_payload("Standard_D8as_v5", "standardDASv5Family", 8, 32),
    sku_payload("Standard_D4as_v5", "standardDASv5Family", 4, 16),
    sku_payload("Standard_D2as_v5", "standardDASv5Family", 2, 8),
]

DEFAULT_USAGES = [
    {"name": {"value": "standardDASv5Family", "localizedValue": "Standard DASv5 Family"},
     "currentValue": 24, "limit": 50},
]

WRITE_PERMISSION = {
    "value": [{"actions": ["Microsoft.Compute/virtualMachines/write"], "notActions": []}]
}

READ_ONLY_PERMISSION = {
    "value": [{"actions": ["Microsoft.Compute/virtualMachines/read"], "notActions": []}]
}

PRICES = [
    {"armSkuName": "Standard_D8as_v5", "retailPrice": 0.40, "productName": "D Series",
     "meterName": "D8as v5", "type": "Consumption", "currencyCode": "USD",
     "armRegionName": "centralindia", "serviceName": "Virtual Machines"},
    {"armSkuName": "Standard_D4as_v5", "retailPrice": 0.20, "productName": "D Series",
     "meterName": "D4as v5", "type": "Consumption", "currencyCode": "USD",
     "armRegionName": "centralindia", "serviceName": "Virtual Machines"},
    {"armSkuName": "Standard_D2as_v5", "retailPrice": 0.10, "productName": "D Series",
     "meterName": "D2as v5", "type": "Consumption", "currencyCode": "USD",
     "armRegionName": "centralindia", "serviceName": "Virtual Machines"},
]


# What `GET .../vmSizes` returns: the sizes Azure will accept for *this*
# machine on the cluster it currently sits on.
DEFAULT_VM_SIZES = [
    {"name": "Standard_D8as_v5", "numberOfCores": 8, "memoryInMB": 32768,
     "maxDataDiskCount": 16},
    {"name": "Standard_D4as_v5", "numberOfCores": 4, "memoryInMB": 16384,
     "maxDataDiskCount": 8},
    {"name": "Standard_D2as_v5", "numberOfCores": 2, "memoryInMB": 8192,
     "maxDataDiskCount": 4},
]


class Azure:
    """A scriptable stand-in for the Azure control plane."""
    def __init__(self, vm=None, skus=None, usages=None, permission=None,
                 sku_status=200, usage_status=200, permission_status=200,
                 vm_sizes=None, vm_sizes_status=200):
        self.vm = vm if vm is not None else vm_payload()
        self.skus = DEFAULT_SKUS if skus is None else skus
        self.usages = DEFAULT_USAGES if usages is None else usages
        self.permission = permission if permission is not None else WRITE_PERMISSION
        self.sku_status = sku_status
        self.usage_status = usage_status
        self.permission_status = permission_status
        self.vm_sizes = DEFAULT_VM_SIZES if vm_sizes is None else vm_sizes
        self.vm_sizes_status = vm_sizes_status
        self.calls = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        self.calls.append((request.method, path))
        if path.endswith("/providers/Microsoft.Authorization/permissions"):
            if self.permission_status != 200:
                return httpx.Response(self.permission_status, json={})
            return httpx.Response(200, json=self.permission)
        if path.endswith("/providers/Microsoft.Compute/skus"):
            if self.sku_status != 200:
                return httpx.Response(self.sku_status, json={})
            return httpx.Response(200, json={"value": self.skus})
        if path.endswith("/usages"):
            if self.usage_status != 200:
                return httpx.Response(self.usage_status, json={})
            return httpx.Response(200, json={"value": self.usages})
        if path.endswith("/vmSizes"):
            if self.vm_sizes_status != 200:
                return httpx.Response(self.vm_sizes_status, json={})
            return httpx.Response(200, json={"value": self.vm_sizes})
        if path == RESOURCE:
            return httpx.Response(200, json=self.vm)
        return httpx.Response(404, json={"error": {"message": f"unhandled {path}"}})


@pytest.fixture
def azure(monkeypatch):
    """Route every httpx client in the module through a scripted Azure."""
    state = {"azure": Azure()}
    original = httpx.AsyncClient

    class Patched(original):
        def __init__(self, *args, **kwargs):
            kwargs["transport"] = httpx.MockTransport(state["azure"].handler)
            super().__init__(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", Patched)

    async def fake_prices(odata, currency="USD", **kwargs):
        from services.retail_prices import normalise
        return [normalise(p) for p in state["prices"]]

    state["prices"] = PRICES
    monkeypatch.setattr(r, "fetch_prices", fake_prices)
    # The size picker asks for a whole region at once, and that lookup lives in
    # the pricing service rather than here, so it has to be scripted too.
    monkeypatch.setattr(retail_prices, "fetch_prices", fake_prices)
    # The published-price cache is process-wide and outlives a test, so a
    # scripted rate from one case would silently answer the next.
    price_cache.clear()
    return state


# ── resource identity ───────────────────────────────────────────────────────


class TestOnlyAVirtualMachineCanBeResized:
    def test_a_vm_id_is_recognised(self):
        assert r.is_virtual_machine(RESOURCE)

    def test_a_storage_account_is_not(self):
        assert not r.is_virtual_machine(
            "/subscriptions/s/resourceGroups/g/providers/Microsoft.Storage/storageAccounts/x"
        )

    def test_a_malformed_id_is_not(self):
        assert not r.is_virtual_machine("abhinav-vm")

    def test_the_parts_are_read_by_position_not_by_guess(self):
        parts = r.split_resource_id(RESOURCE)
        assert parts["subscription_id"] == "sub-1"
        assert parts["resource_group"] == "rg-1"
        assert parts["name"] == "abhinav-vm"
        assert parts["provider"] == "Microsoft.Compute/virtualMachines"


# ── preview ─────────────────────────────────────────────────────────────────


class TestThePreviewChangesNothing:
    @pytest.mark.asyncio
    async def test_it_issues_no_write_requests(self, azure):
        await r.preview("t", RESOURCE, "Standard_D4as_v5", "USD")
        assert all(method == "GET" for method, _ in azure["azure"].calls)

    @pytest.mark.asyncio
    async def test_a_valid_downsize_is_allowed(self, azure):
        plan = await r.preview("t", RESOURCE, "Standard_D4as_v5", "USD")
        assert plan["can_resize"] is True
        assert plan["blockers"] == []
        assert plan["state"] == r.AWAITING_CONFIRMATION

    @pytest.mark.asyncio
    async def test_both_sizes_are_described_from_azure(self, azure):
        plan = await r.preview("t", RESOURCE, "Standard_D4as_v5", "USD")
        assert plan["current"]["vcpu"] == 8
        assert plan["current"]["memory_gb"] == 32
        assert plan["target"]["vcpu"] == 4
        assert plan["target"]["memory_gb"] == 16

    @pytest.mark.asyncio
    async def test_downtime_is_always_declared(self, azure):
        plan = await r.preview("t", RESOURCE, "Standard_D4as_v5", "USD")
        assert plan["downtime"]["required"] is True
        assert "stopped" in plan["downtime"]["detail"].lower()

    @pytest.mark.asyncio
    async def test_no_exact_downtime_duration_is_promised(self, azure):
        plan = await r.preview("t", RESOURCE, "Standard_D4as_v5", "USD")
        assert "minute" not in plan["downtime"]["duration"].lower()

    @pytest.mark.asyncio
    async def test_savings_are_scoped_to_compute(self, azure):
        plan = await r.preview("t", RESOURCE, "Standard_D4as_v5", "USD")
        note = plan["cost_scope_note"].lower()
        assert "disk" in note and "compute" in note

    @pytest.mark.asyncio
    async def test_resizing_to_the_current_size_is_refused(self, azure):
        plan = await r.preview("t", RESOURCE, "Standard_D8as_v5", "USD")
        assert plan["can_resize"] is False
        assert any("already running" in b for b in plan["blockers"])


class TestQuota:
    @pytest.mark.asyncio
    async def test_available_quota_is_reported_with_azures_own_figures(self, azure):
        plan = await r.preview("t", RESOURCE, "Standard_D4as_v5", "USD")
        quota = plan["quota"]
        assert quota["status"] == "available"
        assert quota["current_usage"] == 24
        assert quota["limit"] == 50
        assert quota["required"] == 4

    @pytest.mark.asyncio
    async def test_cores_released_by_this_vm_count_towards_the_target(self, azure):
        # 8 in use of a 10 limit; a 4-core target only fits because this VM's
        # own 8 cores come back on the way through.
        azure["azure"].usages = [
            {"name": {"value": "standardDASv5Family"}, "currentValue": 8, "limit": 10},
        ]
        plan = await r.preview("t", RESOURCE, "Standard_D4as_v5", "USD")
        assert plan["quota"]["status"] == "available"
        assert plan["quota"]["available"] == 10

    @pytest.mark.asyncio
    async def test_insufficient_quota_blocks_the_resize(self, azure):
        azure["azure"].usages = [
            {"name": {"value": "standardDASv5Family"}, "currentValue": 50, "limit": 50},
        ]
        azure["azure"].skus = [
            sku_payload("Standard_D8as_v5", "otherFamily", 8, 32),
            sku_payload("Standard_D4as_v5", "standardDASv5Family", 4, 16),
        ]
        plan = await r.preview("t", RESOURCE, "Standard_D4as_v5", "USD")
        assert plan["quota"]["status"] == "insufficient"
        assert plan["can_resize"] is False

    @pytest.mark.asyncio
    async def test_quota_azure_will_not_report_is_never_assumed_fine(self, azure):
        azure["azure"].usage_status = 403
        plan = await r.preview("t", RESOURCE, "Standard_D4as_v5", "USD")
        assert plan["quota"]["status"] == "unverified"
        assert plan["quota"]["current_usage"] is None
        assert plan["can_resize"] is False

    @pytest.mark.asyncio
    async def test_a_missing_family_is_unverified_not_zero(self, azure):
        azure["azure"].usages = [
            {"name": {"value": "somethingElseFamily"}, "currentValue": 1, "limit": 2},
        ]
        plan = await r.preview("t", RESOURCE, "Standard_D4as_v5", "USD")
        assert plan["quota"]["status"] == "unverified"
        assert plan["quota"]["limit"] is None

    def test_quota_is_checked_even_when_shrinking(self):
        assessment = r.assess_quota(
            DEFAULT_USAGES,
            {"family": "standardDASv5Family", "vcpu": 8},
            {"family": "standardDASv5Family", "vcpu": 4},
            "centralindia",
        )
        assert assessment["required"] == 4
        assert assessment["limit"] == 50


class TestSkuAvailability:
    @pytest.mark.asyncio
    async def test_a_size_azure_does_not_offer_is_unavailable(self, azure):
        azure["azure"].skus = [sku_payload("Standard_D8as_v5", "standardDASv5Family", 8, 32)]
        plan = await r.preview("t", RESOURCE, "Standard_D4as_v5", "USD")
        assert plan["availability"]["status"] == "unavailable"
        assert plan["can_resize"] is False

    @pytest.mark.asyncio
    async def test_a_restricted_size_is_blocked_with_azures_reason(self, azure):
        azure["azure"].skus = [
            sku_payload("Standard_D8as_v5", "standardDASv5Family", 8, 32),
            sku_payload(
                "Standard_D4as_v5", "standardDASv5Family", 4, 16,
                restrictions=[{"type": "Location", "values": ["centralindia"],
                               "reasonCode": "NotAvailableForSubscription"}],
            ),
        ]
        plan = await r.preview("t", RESOURCE, "Standard_D4as_v5", "USD")
        assert plan["availability"]["status"] == "restricted"
        assert "NotAvailableForSubscription" in plan["availability"]["note"]
        assert plan["can_resize"] is False

    @pytest.mark.asyncio
    async def test_an_unreadable_catalogue_is_unverified_not_available(self, azure):
        azure["azure"].sku_status = 500
        plan = await r.preview("t", RESOURCE, "Standard_D4as_v5", "USD")
        assert plan["availability"]["status"] == "unverified"
        assert plan["can_resize"] is False


class TestCompatibility:
    @pytest.mark.asyncio
    async def test_an_architecture_change_is_refused(self, azure):
        azure["azure"].skus = [
            sku_payload("Standard_D8as_v5", "standardDASv5Family", 8, 32, arch="x64"),
            sku_payload("Standard_D4ps_v5", "standardDPSv5Family", 4, 16, arch="Arm64"),
        ]
        azure["azure"].usages = [
            {"name": {"value": "standardDPSv5Family"}, "currentValue": 0, "limit": 50},
        ]
        plan = await r.preview("t", RESOURCE, "Standard_D4ps_v5", "USD")
        assert plan["compatibility"]["status"] == "incompatible"
        assert plan["can_resize"] is False

    @pytest.mark.asyncio
    async def test_a_size_with_too_few_disk_slots_is_refused(self, azure):
        azure["azure"].vm = vm_payload(data_disks=8)
        azure["azure"].skus = [
            sku_payload("Standard_D8as_v5", "standardDASv5Family", 8, 32, max_disks=16),
            sku_payload("Standard_D4as_v5", "standardDASv5Family", 4, 16, max_disks=4),
        ]
        plan = await r.preview("t", RESOURCE, "Standard_D4as_v5", "USD")
        assert plan["compatibility"]["status"] == "incompatible"
        assert "data disks" in " ".join(plan["compatibility"]["issues"])

    @pytest.mark.asyncio
    async def test_capabilities_azure_omits_are_unverified_not_passed(self, azure):
        bare = {"name": "Standard_D4as_v5", "resourceType": "virtualMachines",
                "family": "standardDASv5Family",
                "capabilities": [{"name": "vCPUs", "value": "4"}], "restrictions": []}
        azure["azure"].skus = [DEFAULT_SKUS[0], bare]
        plan = await r.preview("t", RESOURCE, "Standard_D4as_v5", "USD")
        assert plan["compatibility"]["status"] == "unverified"
        assert plan["compatibility"]["unverified"]


class TestPermissions:
    @pytest.mark.asyncio
    async def test_a_reader_is_told_why_not_offered_a_button(self, azure):
        azure["azure"].permission = READ_ONLY_PERMISSION
        plan = await r.preview("t", RESOURCE, "Standard_D4as_v5", "USD")
        assert plan["permission"]["allowed"] is False
        assert "do not have permission to modify" in plan["permission"]["note"]
        assert plan["can_resize"] is False

    @pytest.mark.asyncio
    async def test_a_wildcard_owner_role_is_recognised(self, azure):
        azure["azure"].permission = {"value": [{"actions": ["*"], "notActions": []}]}
        plan = await r.preview("t", RESOURCE, "Standard_D4as_v5", "USD")
        assert plan["permission"]["allowed"] is True

    @pytest.mark.asyncio
    async def test_a_denied_action_overrides_a_wildcard_grant(self, azure):
        azure["azure"].permission = {"value": [{
            "actions": ["Microsoft.Compute/*"],
            "notActions": ["Microsoft.Compute/virtualMachines/write"],
        }]}
        plan = await r.preview("t", RESOURCE, "Standard_D4as_v5", "USD")
        assert plan["permission"]["allowed"] is False

    @pytest.mark.asyncio
    async def test_unreadable_permissions_are_not_treated_as_a_grant(self, azure):
        azure["azure"].permission_status = 500
        plan = await r.preview("t", RESOURCE, "Standard_D4as_v5", "USD")
        assert plan["permission"]["status"] == "unverified"
        assert plan["permission"]["allowed"] is False


class TestPricing:
    @pytest.mark.asyncio
    async def test_both_rates_and_the_saving_come_from_azure(self, azure):
        plan = await r.preview("t", RESOURCE, "Standard_D4as_v5", "USD")
        pricing = plan["pricing"]
        assert pricing["current_monthly"] == round(0.40 * 730, 2)
        assert pricing["target_monthly"] == round(0.20 * 730, 2)
        assert pricing["monthly_saving"] == round(0.20 * 730, 2)
        assert pricing["annual_saving"] == round(0.20 * 730 * 12, 2)
        assert pricing["basis"] == "retail_prices"

    @pytest.mark.asyncio
    async def test_an_unresolvable_price_is_none_not_zero(self, azure):
        azure["prices"] = []
        plan = await r.preview("t", RESOURCE, "Standard_D4as_v5", "USD")
        pricing = plan["pricing"]
        assert pricing["current_monthly"] is None
        assert pricing["target_monthly"] is None
        assert pricing["monthly_saving"] is None
        assert pricing["basis"] == "price_unavailable"

    @pytest.mark.asyncio
    async def test_one_known_rate_yields_no_saving(self, azure):
        azure["prices"] = [PRICES[0]]
        plan = await r.preview("t", RESOURCE, "Standard_D4as_v5", "USD")
        assert plan["pricing"]["monthly_saving"] is None
        assert plan["pricing"]["basis"] == "partial_prices"

    @pytest.mark.asyncio
    async def test_a_missing_price_does_not_block_the_resize(self, azure):
        """A price is information, not a safety control."""
        azure["prices"] = []
        plan = await r.preview("t", RESOURCE, "Standard_D4as_v5", "USD")
        assert plan["can_resize"] is True

    @pytest.mark.asyncio
    async def test_a_windows_vm_is_quoted_windows_meters(self, azure):
        vm = vm_payload()
        vm["properties"]["storageProfile"]["osDisk"]["osType"] = "Windows"
        azure["azure"].vm = vm
        azure["prices"] = [
            {**PRICES[0], "productName": "Virtual Machines Das v5 Windows"},
            {**PRICES[1], "productName": "Virtual Machines Das v5 Windows"},
        ]
        plan = await r.preview("t", RESOURCE, "Standard_D4as_v5", "USD")
        assert plan["pricing"]["basis"] == "retail_prices"

    @pytest.mark.asyncio
    async def test_a_linux_vm_ignores_windows_meters(self, azure):
        azure["prices"] = [
            {**PRICES[0], "productName": "Virtual Machines Das v5 Windows"},
            {**PRICES[1], "productName": "Virtual Machines Das v5 Windows"},
        ]
        plan = await r.preview("t", RESOURCE, "Standard_D4as_v5", "USD")
        assert plan["pricing"]["current_monthly"] is None

    @pytest.mark.asyncio
    async def test_spot_meters_are_never_quoted(self, azure):
        azure["prices"] = [
            {**PRICES[0], "meterName": "D8as v5 Spot"},
            {**PRICES[1], "meterName": "D4as v5 Spot"},
        ]
        plan = await r.preview("t", RESOURCE, "Standard_D4as_v5", "USD")
        assert plan["pricing"]["basis"] == "price_unavailable"


# ── audit records ───────────────────────────────────────────────────────────


class TestTheAuditRecord:
    @pytest.mark.asyncio
    async def test_a_record_is_opened_before_anything_is_touched(self, db, account, azure):
        plan = await r.preview("t", RESOURCE, "Standard_D4as_v5", "USD")
        operation_id = await r.create_operation(
            db, {"account_id": account["account_id"]}, "tenant-1", RESOURCE, plan
        )
        record = await r.read_operation(db, operation_id, account["account_id"])
        assert record["state"] == r.VALIDATING
        assert record["old_sku"] == "Standard_D8as_v5"
        assert record["new_sku"] == "Standard_D4as_v5"
        assert record["vm_name"] == "abhinav-vm"
        assert record["region"] == "centralindia"

    @pytest.mark.asyncio
    async def test_prices_are_stored_for_the_record(self, db, account, azure):
        plan = await r.preview("t", RESOURCE, "Standard_D4as_v5", "USD")
        operation_id = await r.create_operation(
            db, {"account_id": account["account_id"]}, "tenant-1", RESOURCE, plan
        )
        record = await r.read_operation(db, operation_id, account["account_id"])
        assert record["old_monthly_price"] == round(0.40 * 730, 2)
        assert record["estimated_monthly_saving"] == round(0.20 * 730, 2)

    @pytest.mark.asyncio
    async def test_an_unpriced_resize_stores_null_not_zero(self, db, account, azure):
        azure["prices"] = []
        plan = await r.preview("t", RESOURCE, "Standard_D4as_v5", "USD")
        operation_id = await r.create_operation(
            db, {"account_id": account["account_id"]}, "tenant-1", RESOURCE, plan
        )
        record = await r.read_operation(db, operation_id, account["account_id"])
        assert record["old_monthly_price"] is None
        assert record["estimated_monthly_saving"] is None

    @pytest.mark.asyncio
    async def test_another_account_cannot_read_the_record(self, db, account, azure):
        plan = await r.preview("t", RESOURCE, "Standard_D4as_v5", "USD")
        operation_id = await r.create_operation(
            db, {"account_id": account["account_id"]}, "tenant-1", RESOURCE, plan
        )
        assert await r.read_operation(db, operation_id, account["account_id"] + 999) is None

    @pytest.mark.asyncio
    async def test_a_running_operation_is_found_whoever_started_it(self, db, account, azure):
        plan = await r.preview("t", RESOURCE, "Standard_D4as_v5", "USD")
        await r.create_operation(
            db, {"account_id": account["account_id"]}, "tenant-1", RESOURCE, plan
        )
        assert await r.active_operation_for(db, RESOURCE) is not None

    @pytest.mark.asyncio
    async def test_a_finished_operation_no_longer_blocks_a_new_one(self, db, account, azure):
        plan = await r.preview("t", RESOURCE, "Standard_D4as_v5", "USD")
        operation_id = await r.create_operation(
            db, {"account_id": account["account_id"]}, "tenant-1", RESOURCE, plan
        )
        await r.update_operation(db, operation_id, state=r.SUCCESS)
        assert await r.active_operation_for(db, RESOURCE) is None

    @pytest.mark.asyncio
    async def test_history_is_scoped_to_account_and_tenant(self, db, account, azure):
        plan = await r.preview("t", RESOURCE, "Standard_D4as_v5", "USD")
        await r.create_operation(
            db, {"account_id": account["account_id"]}, "tenant-1", RESOURCE, plan
        )
        mine = await r.history_for(db, account["account_id"], "tenant-1")
        other_tenant = await r.history_for(db, account["account_id"], "tenant-2")
        assert len(mine) == 1
        assert other_tenant == []


# ── execution ───────────────────────────────────────────────────────────────


class ResizeAzure(Azure):
    """
    Azure for the write path: records the destructive calls and can be told to
    fail any one of them.
    """

    def __init__(self, fail_on="", final_sku=None, final_power="running", **kwargs):
        super().__init__(**kwargs)
        self.fail_on = fail_on
        self.final_sku = final_sku
        self.final_power = final_power
        self.actions = []
        self.patched = False

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if request.method == "POST" and path.endswith("/deallocate"):
            self.actions.append("deallocate")
            if self.fail_on == "stop":
                return httpx.Response(409, json={"error": {"message": "cannot stop"}})
            return httpx.Response(200, json={})
        if request.method == "POST" and path.endswith("/start"):
            self.actions.append("start")
            if self.fail_on == "start":
                return httpx.Response(409, json={"error": {"message": "cannot start"}})
            return httpx.Response(200, json={})
        if request.method == "PATCH" and path == RESOURCE:
            self.actions.append("resize")
            if self.fail_on == "resize":
                return httpx.Response(409, json={"error": {"message": "no capacity"}})
            self.patched = True
            body = json.loads(request.content)
            self.new_sku = body["properties"]["hardwareProfile"]["vmSize"]
            return httpx.Response(200, json={})
        if request.method == "GET" and path == RESOURCE and self.patched:
            sku = self.final_sku or self.new_sku
            return httpx.Response(200, json=vm_payload(sku=sku, power=self.final_power))
        return super().handler(request)


@pytest_asyncio.fixture
async def resize_env(tmp_path, monkeypatch, db, account):
    """A database on disk plus a scripted Azure, ready for `run_resize`."""
    state = {"azure": ResizeAzure(), "path": db_module.DB_PATH}
    original = httpx.AsyncClient

    class Patched(original):
        def __init__(self, *args, **kwargs):
            kwargs["transport"] = httpx.MockTransport(
                lambda request: state["azure"].handler(request)
            )
            super().__init__(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", Patched)
    monkeypatch.setattr(r, "POLL_INTERVAL_SECONDS", 0)

    async def fake_prices(odata, currency="USD", **kwargs):
        from services.retail_prices import normalise
        return [normalise(p) for p in PRICES]

    monkeypatch.setattr(r, "fetch_prices", fake_prices)
    # The size picker asks for a whole region at once, and that lookup lives in
    # the pricing service rather than here, so it has to be scripted too.
    monkeypatch.setattr(retail_prices, "fetch_prices", fake_prices)
    # The published-price cache is process-wide and outlives a test, so a
    # scripted rate from one case would silently answer the next.
    price_cache.clear()

    async def start(expected="Standard_D8as_v5", target="Standard_D4as_v5"):
        plan = await r.preview("t", RESOURCE, target, "USD")
        operation_id = await r.create_operation(
            db, {"account_id": account["account_id"]}, "tenant-1", RESOURCE, plan
        )
        await r.run_resize(state["path"], operation_id, "t", RESOURCE, target, expected)
        return await r.read_operation(db, operation_id, account["account_id"])

    state["start"] = start
    return state


class TestASuccessfulResize:
    @pytest.mark.asyncio
    async def test_the_machine_is_stopped_resized_then_started_in_that_order(self, resize_env):
        await resize_env["start"]()
        assert resize_env["azure"].actions == ["deallocate", "resize", "start"]

    @pytest.mark.asyncio
    async def test_success_is_recorded_with_the_verified_size(self, resize_env):
        record = await resize_env["start"]()
        assert record["state"] == r.SUCCESS
        assert record["new_sku"] == "Standard_D4as_v5"
        assert record["final_power_state"] == "running"
        assert record["failure_reason"] == ""
        assert record["completed_at"]

    @pytest.mark.asyncio
    async def test_every_step_is_marked_done(self, resize_env):
        record = await resize_env["start"]()
        assert {step["status"] for step in record["steps"]} == {r.STEP_DONE}


class TestStaleInformationStopsTheResize:
    @pytest.mark.asyncio
    async def test_a_size_that_changed_since_the_review_aborts(self, resize_env):
        record = await resize_env["start"](expected="Standard_D16as_v5")
        assert record["state"] == r.FAILED
        assert "changed since this review" in record["failure_reason"]

    @pytest.mark.asyncio
    async def test_nothing_destructive_was_attempted(self, resize_env):
        await resize_env["start"](expected="Standard_D16as_v5")
        assert resize_env["azure"].actions == []

    @pytest.mark.asyncio
    async def test_a_vm_already_at_the_target_size_is_not_resized_again(self, resize_env):
        record = await resize_env["start"](
            expected="Standard_D8as_v5", target="Standard_D8as_v5"
        )
        assert record["state"] == r.FAILED
        assert resize_env["azure"].actions == []


class TestFailuresAreExplicit:
    @pytest.mark.asyncio
    async def test_a_vm_that_will_not_stop_is_named_as_such(self, resize_env):
        resize_env["azure"].fail_on = "stop"
        record = await resize_env["start"]()
        assert record["state"] == r.FAILED
        assert "could not be stopped" in record["failure_reason"]
        assert resize_env["azure"].actions == ["deallocate"]

    @pytest.mark.asyncio
    async def test_a_failed_resize_says_the_vm_is_currently_stopped(self, resize_env):
        resize_env["azure"].fail_on = "resize"
        record = await resize_env["start"]()
        assert record["state"] == r.FAILED
        assert "currently stopped" in record["failure_reason"]
        assert record["final_power_state"] == "deallocated"

    @pytest.mark.asyncio
    async def test_resized_but_not_started_is_its_own_situation(self, resize_env):
        resize_env["azure"].fail_on = "start"
        record = await resize_env["start"]()
        assert record["state"] == r.FAILED
        assert "Resize completed, but the VM could not be started" in record["failure_reason"]
        # The size did change, and the record must say so rather than implying
        # nothing happened.
        assert record["new_sku"] == "Standard_D4as_v5"

    @pytest.mark.asyncio
    async def test_success_is_never_claimed_without_verification(self, resize_env):
        # Azure accepts every call but the machine is still the old size.
        resize_env["azure"].final_sku = "Standard_D8as_v5"
        record = await resize_env["start"]()
        assert record["state"] == r.FAILED
        assert "did not take effect" in record["failure_reason"]

    @pytest.mark.asyncio
    async def test_a_permission_lost_since_the_review_aborts(self, resize_env):
        resize_env["azure"].permission = READ_ONLY_PERMISSION
        record = await resize_env["start"]()
        assert record["state"] == r.FAILED
        assert resize_env["azure"].actions == []

    @pytest.mark.asyncio
    async def test_quota_exhausted_since_the_review_aborts(self, resize_env):
        resize_env["azure"].usages = [
            {"name": {"value": "standardDASv5Family"}, "currentValue": 50, "limit": 50},
        ]
        resize_env["azure"].skus = [
            sku_payload("Standard_D8as_v5", "otherFamily", 8, 32),
            sku_payload("Standard_D4as_v5", "standardDASv5Family", 4, 16),
        ]
        record = await resize_env["start"]()
        assert record["state"] == r.FAILED
        assert resize_env["azure"].actions == []

    @pytest.mark.asyncio
    async def test_a_sku_withdrawn_since_the_review_aborts(self, resize_env):
        resize_env["azure"].skus = [
            sku_payload("Standard_D8as_v5", "standardDASv5Family", 8, 32),
        ]
        record = await resize_env["start"]()
        assert record["state"] == r.FAILED
        assert resize_env["azure"].actions == []


class TestLongRunningOperations:
    @pytest.mark.asyncio
    async def test_a_202_is_followed_until_azure_says_succeeded(self, monkeypatch):
        monkeypatch.setattr(r, "POLL_INTERVAL_SECONDS", 0)
        polls = {"n": 0}

        def handler(request):
            if request.url.path.endswith("/deallocate"):
                return httpx.Response(
                    202, json={},
                    headers={"azure-asyncoperation": "https://management.azure.com/op/1"},
                )
            polls["n"] += 1
            status = "InProgress" if polls["n"] < 3 else "Succeeded"
            return httpx.Response(200, json={"status": status})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            ok, error = await r._post_action(client, "t", RESOURCE, "deallocate")

        assert ok and error == ""
        assert polls["n"] == 3, "a 202 must not be read as a completed operation"

    @pytest.mark.asyncio
    async def test_a_failed_async_operation_is_reported_with_azures_message(self, monkeypatch):
        monkeypatch.setattr(r, "POLL_INTERVAL_SECONDS", 0)

        def handler(request):
            if request.url.path.endswith("/deallocate"):
                return httpx.Response(
                    202, json={},
                    headers={"azure-asyncoperation": "https://management.azure.com/op/1"},
                )
            return httpx.Response(200, json={
                "status": "Failed", "error": {"message": "allocation failed"}})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            ok, error = await r._post_action(client, "t", RESOURCE, "deallocate")

        assert ok is False
        assert "allocation failed" in error

    @pytest.mark.asyncio
    async def test_an_operation_that_never_settles_times_out(self, monkeypatch):
        monkeypatch.setattr(r, "POLL_INTERVAL_SECONDS", 0)
        monkeypatch.setattr(r, "POLL_TIMEOUT_SECONDS", 0.0)

        def handler(request):
            if request.url.path.endswith("/deallocate"):
                return httpx.Response(
                    202, json={},
                    headers={"azure-asyncoperation": "https://management.azure.com/op/1"},
                )
            return httpx.Response(200, json={"status": "InProgress"})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            ok, error = await r._post_action(client, "t", RESOURCE, "deallocate")

        assert ok is False
        assert "did not finish" in error

    @pytest.mark.asyncio
    async def test_throttling_is_surfaced_not_swallowed(self, monkeypatch):
        def handler(request):
            return httpx.Response(429, json={"error": {"message": "too many requests"}})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            ok, error = await r._post_action(client, "t", RESOURCE, "deallocate")

        assert ok is False
        assert "429" in error


class TestStateVocabulary:
    def test_every_state_has_a_human_label(self):
        for state in [r.VALIDATING, r.QUOTA_CHECK, r.SKU_CHECK, r.AWAITING_CONFIRMATION,
                      r.STOPPING, r.RESIZING, r.STARTING, r.VERIFYING,
                      r.SUCCESS, r.FAILED, r.CANCELLED]:
            assert r.STATE_LABEL[state]
            assert r.STATE_LABEL[state] != state

    def test_no_state_is_a_bare_loading(self):
        assert "loading" not in " ".join(r.STATE_LABEL.values()).lower()

    def test_the_step_list_matches_what_the_backend_actually_does(self):
        keys = [key for key, _ in r.STEP_SEQUENCE]
        assert keys == ["validate", "quota", "sku", "stop", "resize", "start", "verify"]

    def test_only_finished_states_are_terminal(self):
        assert r.TERMINAL_STATES == {r.SUCCESS, r.FAILED, r.CANCELLED}
        assert r.STOPPING not in r.TERMINAL_STATES


class TestASavingNeverExceedsTheBillItComesOff:
    """
    List prices are what Azure publishes; they are not what this tenant pays.
    A reservation, a Hybrid Benefit licence or a machine that ran for half the
    month all put the two far apart. Quoting the published difference as the
    saving is how the page came to promise 20,598 off a VM whose whole bill was
    6,497 -- a number no finance team would ever trust again.
    """

    @pytest.mark.asyncio
    async def test_the_published_difference_is_used_only_as_a_ratio(self, azure):
        # 0.40 -> 0.20 is a 50% cut, whatever the absolute prices are.
        pricing = await r.price_pair(
            "Standard_D8as_v5", "Standard_D4as_v5", "centralindia", "Linux",
            "INR", billed_monthly=6497.20,
        )
        assert pricing["monthly_saving"] == pytest.approx(3248.60)
        assert pricing["basis"] == "actual_cost_and_retail_ratio"

    @pytest.mark.asyncio
    async def test_the_saving_can_never_be_larger_than_the_bill(self, azure):
        billed = 6497.20
        pricing = await r.price_pair(
            "Standard_D8as_v5", "Standard_D4as_v5", "centralindia", "Linux",
            "INR", billed_monthly=billed,
        )
        assert pricing["monthly_saving"] <= billed

    @pytest.mark.asyncio
    async def test_the_real_bill_is_carried_through_for_the_review_to_show(self, azure):
        pricing = await r.price_pair(
            "Standard_D8as_v5", "Standard_D4as_v5", "centralindia", "Linux",
            "INR", billed_monthly=6497.20,
        )
        assert pricing["billed_monthly"] == 6497.20

    @pytest.mark.asyncio
    async def test_without_a_bill_it_falls_back_to_list_price_and_admits_it(self, azure):
        pricing = await r.price_pair(
            "Standard_D8as_v5", "Standard_D4as_v5", "centralindia", "Linux", "USD",
        )
        assert pricing["basis"] == "retail_prices"
        assert "list-price" in pricing["note"]
        assert pricing["billed_monthly"] is None

    @pytest.mark.asyncio
    async def test_a_zero_bill_is_not_treated_as_a_known_bill(self, azure):
        # A VM billed at zero has no cost to take a percentage of; falling back
        # to list price is honest, reporting a zero saving would not be.
        pricing = await r.price_pair(
            "Standard_D8as_v5", "Standard_D4as_v5", "centralindia", "Linux",
            "USD", billed_monthly=0.0,
        )
        assert pricing["basis"] == "retail_prices"

    @pytest.mark.asyncio
    async def test_an_unpriced_pair_still_yields_no_saving_even_with_a_bill(self, azure):
        pricing = await r.price_pair(
            "Standard_D8as_v5", "Standard_NOT_REAL", "centralindia", "Linux",
            "INR", billed_monthly=6497.20,
        )
        assert pricing["monthly_saving"] is None
        assert pricing["annual_saving"] is None

    @pytest.mark.asyncio
    async def test_the_review_quotes_the_bill_the_fleet_page_sent_it(self, azure):
        plan = await r.preview(
            "t", RESOURCE, "Standard_D4as_v5", "INR", billed_monthly=6497.20,
        )
        assert plan["pricing"]["basis"] == "actual_cost_and_retail_ratio"
        assert plan["pricing"]["monthly_saving"] == pytest.approx(3248.60)


class TestChoosingASizeYourself:
    """
    The catalogue a user picks from. Everything in it is read from the caller's
    own subscription at request time -- sizes from the VM, capabilities and
    restrictions from the subscription's catalogue, quota from its usage,
    prices from Azure's published rates. Nothing is hardcoded, because the same
    code serves every tenant that buys this product.
    """

    @pytest.mark.asyncio
    async def test_the_sizes_come_from_this_vm_not_from_a_hardcoded_list(self, azure):
        azure["azure"].vm_sizes = [
            {"name": "Standard_D2as_v5", "numberOfCores": 2, "memoryInMB": 8192},
        ]
        result = await r.resize_options("t", RESOURCE, "USD")
        assert [o["name"] for o in result["options"]] == [
            "Standard_D2as_v5", "Standard_D8as_v5",
        ]
        assert result["source"] == "azure_vm_sizes"

    @pytest.mark.asyncio
    async def test_the_size_it_already_runs_is_always_offered_for_comparison(self, azure):
        azure["azure"].vm_sizes = [
            {"name": "Standard_D2as_v5", "numberOfCores": 2, "memoryInMB": 8192},
        ]
        result = await r.resize_options("t", RESOURCE, "USD")
        current = [o for o in result["options"] if o["is_current"]]
        assert len(current) == 1
        assert current[0]["name"] == "Standard_D8as_v5"

    @pytest.mark.asyncio
    async def test_the_current_size_cannot_be_chosen_again(self, azure):
        result = await r.resize_options("t", RESOURCE, "USD")
        current = next(o for o in result["options"] if o["is_current"])
        assert current["selectable"] is False
        assert "already running this size" in " ".join(current["blockers"])

    @pytest.mark.asyncio
    async def test_a_bigger_size_is_offered_too_because_undersized_costs_money(self, azure):
        result = await r.resize_options("t", RESOURCE, "USD")
        smaller = [o["name"] for o in result["options"] if o["change"] == "smaller"]
        assert "Standard_D4as_v5" in smaller
        assert "Standard_D2as_v5" in smaller

    @pytest.mark.asyncio
    async def test_each_size_carries_its_own_quota_verdict(self, azure):
        result = await r.resize_options("t", RESOURCE, "USD")
        assert all(o["quota"]["status"] in {"available", "unverified", "exceeded"}
                   for o in result["options"])

    @pytest.mark.asyncio
    async def test_each_size_carries_its_own_price(self, azure):
        result = await r.resize_options("t", RESOURCE, "USD")
        priced = {o["name"]: o["monthly_list_price"] for o in result["options"]}
        assert priced["Standard_D8as_v5"] == pytest.approx(0.40 * 730, rel=1e-6)
        assert priced["Standard_D4as_v5"] == pytest.approx(0.20 * 730, rel=1e-6)

    @pytest.mark.asyncio
    async def test_a_size_azure_would_not_price_is_none_not_zero(self, azure):
        # A size shown at zero is a size somebody resizes to by accident.
        azure["azure"].vm_sizes = DEFAULT_VM_SIZES + [
            {"name": "Standard_ZZ99", "numberOfCores": 2, "memoryInMB": 8192},
        ]
        result = await r.resize_options("t", RESOURCE, "USD")
        unpriced = next(o for o in result["options"] if o["name"] == "Standard_ZZ99")
        assert unpriced["monthly_list_price"] is None
        assert unpriced["estimated_monthly_delta"] is None

    @pytest.mark.asyncio
    async def test_savings_are_measured_against_the_real_bill_when_it_is_known(self, azure):
        # 0.40 -> 0.20 halves the published rate, so half of the real bill.
        result = await r.resize_options("t", RESOURCE, "INR", billed_monthly=6497.20)
        target = next(o for o in result["options"] if o["name"] == "Standard_D4as_v5")
        assert target["estimated_monthly_delta"] == pytest.approx(3248.60)
        assert result["price_basis"] == "actual_cost_and_retail_ratio"

    @pytest.mark.asyncio
    async def test_no_saving_can_exceed_the_bill_it_comes_off(self, azure):
        billed = 6497.20
        result = await r.resize_options("t", RESOURCE, "INR", billed_monthly=billed)
        for option in result["options"]:
            delta = option["estimated_monthly_delta"]
            if delta is not None:
                assert delta <= billed

    @pytest.mark.asyncio
    async def test_a_larger_size_reports_a_negative_delta_rather_than_a_saving(self, azure):
        azure["azure"].vm = vm_payload(sku="Standard_D2as_v5")
        result = await r.resize_options("t", RESOURCE, "USD")
        bigger = next(o for o in result["options"] if o["name"] == "Standard_D8as_v5")
        assert bigger["estimated_monthly_delta"] < 0

    @pytest.mark.asyncio
    async def test_without_a_bill_the_basis_says_so(self, azure):
        result = await r.resize_options("t", RESOURCE, "USD")
        assert result["price_basis"] == "retail_prices"
        assert result["billed_monthly"] is None

    @pytest.mark.asyncio
    async def test_the_recommendation_is_marked_but_not_forced(self, azure):
        result = await r.resize_options(
            "t", RESOURCE, "USD", recommended_sku="Standard_D4as_v5",
        )
        marked = [o["name"] for o in result["options"] if o["is_recommended"]]
        assert marked == ["Standard_D4as_v5"]
        # Everything else Azure allows is still on offer, so the suggestion is
        # a starting point rather than the only door.
        selectable = {o["name"] for o in result["options"] if o["selectable"]}
        assert selectable == {"Standard_D4as_v5", "Standard_D2as_v5"}

    @pytest.mark.asyncio
    async def test_the_current_size_is_never_marked_as_the_recommendation(self, azure):
        result = await r.resize_options(
            "t", RESOURCE, "USD", recommended_sku="Standard_D8as_v5",
        )
        assert not any(o["is_recommended"] for o in result["options"])

    @pytest.mark.asyncio
    async def test_losing_quota_does_not_hide_the_sizes(self, azure):
        azure["azure"].usage_status = 500
        result = await r.resize_options("t", RESOURCE, "USD")
        assert result["options"]
        assert any("Quota could not be read" in n for n in result["notes"])
        assert all(o["quota"]["status"] == "unverified" for o in result["options"])

    @pytest.mark.asyncio
    async def test_a_size_with_unverified_quota_cannot_be_chosen(self, azure):
        azure["azure"].usage_status = 500
        result = await r.resize_options("t", RESOURCE, "USD")
        assert not any(o["selectable"] for o in result["options"])

    @pytest.mark.asyncio
    async def test_losing_vm_sizes_falls_back_to_the_catalogue_and_says_which(self, azure):
        azure["azure"].vm_sizes_status = 500
        result = await r.resize_options("t", RESOURCE, "USD")
        assert result["source"] == "subscription_sku_catalogue"
        assert any("sizes this VM can move to" in n for n in result["notes"])

    @pytest.mark.asyncio
    async def test_a_restricted_size_is_shown_with_its_reason_not_hidden(self, azure):
        azure["azure"].skus = [
            {**sku, "restrictions": [
                {"type": "Location", "values": ["centralindia"],
                 "reasonCode": "NotAvailableForSubscription"},
            ]} if sku["name"] == "Standard_D4as_v5" else sku
            for sku in DEFAULT_SKUS
        ]
        result = await r.resize_options("t", RESOURCE, "USD")
        blocked = next(o for o in result["options"] if o["name"] == "Standard_D4as_v5")
        assert blocked["selectable"] is False
        assert blocked["availability"]["status"] == "unavailable"
        assert "centralindia" in blocked["availability"]["note"]

    @pytest.mark.asyncio
    async def test_cores_missing_from_the_catalogue_are_filled_from_the_vm_sizes_call(self, azure):
        azure["azure"].skus = []
        result = await r.resize_options("t", RESOURCE, "USD")
        d4 = next(o for o in result["options"] if o["name"] == "Standard_D4as_v5")
        assert d4["vcpu"] == 4
        assert d4["memory_gb"] == 16.0

    @pytest.mark.asyncio
    async def test_it_reports_which_subscription_and_region_it_read(self, azure):
        result = await r.resize_options("t", RESOURCE, "USD")
        assert result["vm"]["subscription_id"] == "sub-1"
        assert result["vm"]["region"] == "centralindia"
        assert result["resource_id"] == RESOURCE


class TestAMachineThatIsAlreadyStopped:
    """
    Resizing a deallocated VM needs no stop and, crucially, no start.

    Starting it afterwards would put a machine its owner had deliberately
    switched off back onto the compute bill -- the exact opposite of what a
    cost tool is for. And a machine that is already off has no downtime to
    warn anybody about.
    """

    @pytest.mark.asyncio
    async def test_a_stopped_vm_is_not_stopped_again(self, resize_env):
        resize_env["azure"].vm = vm_payload(power="deallocated")
        resize_env["azure"].final_power = "deallocated"
        await resize_env["start"]()
        assert "deallocate" not in resize_env["azure"].actions

    @pytest.mark.asyncio
    async def test_a_stopped_vm_is_never_started_for_us(self, resize_env):
        resize_env["azure"].vm = vm_payload(power="deallocated")
        resize_env["azure"].final_power = "deallocated"
        await resize_env["start"]()
        assert "start" not in resize_env["azure"].actions

    @pytest.mark.asyncio
    async def test_it_is_still_actually_resized(self, resize_env):
        resize_env["azure"].vm = vm_payload(power="deallocated")
        resize_env["azure"].final_power = "deallocated"
        record = await resize_env["start"]()
        assert resize_env["azure"].actions == ["resize"]
        assert record["new_sku"] == "Standard_D4as_v5"

    @pytest.mark.asyncio
    async def test_leaving_it_stopped_is_a_success_not_a_failure(self, resize_env):
        resize_env["azure"].vm = vm_payload(power="deallocated")
        resize_env["azure"].final_power = "deallocated"
        record = await resize_env["start"]()
        assert record["state"] == "SUCCESS"
        assert record["final_power_state"] == "deallocated"

    @pytest.mark.asyncio
    async def test_a_running_vm_is_still_stopped_and_started(self, resize_env):
        await resize_env["start"]()
        assert resize_env["azure"].actions == ["deallocate", "resize", "start"]
