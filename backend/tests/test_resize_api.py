"""
The resize endpoints, exercised through the real FastAPI app.

The service tests cover whether the logic is right. These cover whether the
*door* is right: that a resize cannot be triggered without confirmation, that
one account cannot see or start another's operation, and that a second click
does not start a second resize.
"""
import aiosqlite
import httpx
import pytest
import pytest_asyncio

import core.db as db_module
from core.config import settings
from services import user_service, vm_resize as r
from services.retail_prices import price_cache

from tests.test_vm_resize import (  # reuse the scripted Azure
    Azure,
    PRICES,
    RESOURCE,
    READ_ONLY_PERMISSION,
)


@pytest_asyncio.fixture
async def api_db(tmp_path, monkeypatch):
    path = str(tmp_path / "resize_api.db")
    monkeypatch.setattr(db_module, "DB_PATH", path)
    await db_module.init_db()
    conn = await aiosqlite.connect(path)
    conn.row_factory = aiosqlite.Row
    await conn.execute("PRAGMA foreign_keys = ON")
    yield conn
    await conn.close()


@pytest_asyncio.fixture
async def users(api_db):
    first = await user_service.upsert_user(
        api_db, {"user_id": "oid-1", "name": "Anuj", "email": "a@example.com",
                 "tenant_id": "tenant-1"},
    )
    second = await user_service.upsert_user(
        api_db, {"user_id": "oid-2", "name": "Bea", "email": "b@example.com",
                 "tenant_id": "tenant-1"},
    )
    return first, second


def identity(user: dict, oid: str, tenant_id: str = "tenant-1") -> dict:
    return {
        "token": f"token-{oid}", "user_id": oid, "name": oid,
        "email": user["email"], "tenant_id": tenant_id,
        "account_id": user["id"], "role": user["role"],
        "status": user["status"], "created_at": user["created_at"],
    }


@pytest.fixture
def client(api_db, monkeypatch):
    monkeypatch.setattr(settings, "RATE_LIMIT_ENABLED", False)

    from auth.dependencies import get_current_user
    from core.db import get_db
    from fastapi import HTTPException
    from fastapi.testclient import TestClient
    import main

    current = {"user": None}

    async def override_user():
        if current["user"] is None:
            raise HTTPException(status_code=401, detail="Not authenticated")
        return current["user"]

    async def override_db():
        yield api_db

    main.app.dependency_overrides[get_current_user] = override_user
    main.app.dependency_overrides[get_db] = override_db

    with TestClient(main.app) as test_client:
        test_client.act_as = lambda user: current.__setitem__("user", user)
        yield test_client

    main.app.dependency_overrides.clear()


@pytest.fixture
def azure(monkeypatch):
    """Scripted Azure plus a token resolver that does not need a real tenant."""
    state = {"azure": Azure(), "started": []}
    original = httpx.AsyncClient

    class Patched(original):
        def __init__(self, *args, **kwargs):
            kwargs["transport"] = httpx.MockTransport(
                lambda request: state["azure"].handler(request)
            )
            super().__init__(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", Patched)

    async def fake_prices(odata, currency="USD", **kwargs):
        from services.retail_prices import normalise
        return [normalise(p) for p in PRICES]

    monkeypatch.setattr(r, "fetch_prices", fake_prices)
    # The published-price cache is process-wide and outlives a test, so a
    # scripted rate from one case would silently answer the next.
    price_cache.clear()

    # The resize itself is started as a background task; the endpoint's job is
    # to decide whether to start one, which is what these tests are about.
    async def fake_run(*args, **kwargs):
        state["started"].append(args)

    monkeypatch.setattr(r, "run_resize", fake_run)
    return state


def preview_body(**over):
    body = {"tenant_id": "tenant-1", "resource_id": RESOURCE,
            "target_sku": "Standard_D4as_v5", "currency": "USD"}
    body.update(over)
    return body


class TestAuthenticationIsRequired:
    def test_preview_rejects_an_anonymous_caller(self, client, azure):
        assert client.post("/api/v1/compute/resize/preview",
                           json=preview_body()).status_code == 401

    def test_resize_rejects_an_anonymous_caller(self, client, azure):
        assert client.post("/api/v1/compute/resize",
                           json=preview_body(confirmation=True)).status_code == 401


class TestThePreviewEndpoint:
    def test_it_returns_a_reviewable_plan(self, client, users, azure):
        client.act_as(identity(users[0], "oid-1"))
        resp = client.post("/api/v1/compute/resize/preview", json=preview_body())
        assert resp.status_code == 200
        plan = resp.json()
        assert plan["can_resize"] is True
        assert plan["current"]["vcpu"] == 8
        assert plan["target"]["vcpu"] == 4
        assert plan["quota"]["status"] == "available"

    def test_it_never_issues_a_write(self, client, users, azure):
        client.act_as(identity(users[0], "oid-1"))
        client.post("/api/v1/compute/resize/preview", json=preview_body())
        assert all(method == "GET" for method, _ in azure["azure"].calls)

    def test_a_non_vm_resource_is_refused(self, client, users, azure):
        client.act_as(identity(users[0], "oid-1"))
        resp = client.post(
            "/api/v1/compute/resize/preview",
            json=preview_body(
                resource_id="/subscriptions/s/resourceGroups/g/providers"
                            "/Microsoft.Storage/storageAccounts/x"
            ),
        )
        assert resp.status_code == 400

    def test_a_reader_gets_a_plan_that_cannot_be_confirmed(self, client, users, azure):
        azure["azure"].permission = READ_ONLY_PERMISSION
        client.act_as(identity(users[0], "oid-1"))
        plan = client.post("/api/v1/compute/resize/preview", json=preview_body()).json()
        assert plan["can_resize"] is False
        assert plan["permission"]["allowed"] is False


class TestConfirmationIsMandatory:
    def test_an_unconfirmed_resize_is_refused(self, client, users, azure):
        client.act_as(identity(users[0], "oid-1"))
        resp = client.post("/api/v1/compute/resize", json=preview_body())
        assert resp.status_code == 400
        assert azure["started"] == []

    def test_confirmation_false_is_refused(self, client, users, azure):
        client.act_as(identity(users[0], "oid-1"))
        resp = client.post("/api/v1/compute/resize",
                           json=preview_body(confirmation=False))
        assert resp.status_code == 400
        assert azure["started"] == []

    def test_a_confirmed_resize_starts_exactly_one_operation(self, client, users, azure):
        client.act_as(identity(users[0], "oid-1"))
        resp = client.post("/api/v1/compute/resize",
                           json=preview_body(confirmation=True))
        assert resp.status_code == 200
        assert resp.json()["state"] == r.VALIDATING
        assert len(azure["started"]) == 1


class TestTheBackendDoesNotTrustTheFrontend:
    def test_a_blocked_plan_cannot_be_forced_through(self, client, users, azure):
        azure["azure"].permission = READ_ONLY_PERMISSION
        client.act_as(identity(users[0], "oid-1"))
        resp = client.post("/api/v1/compute/resize",
                           json=preview_body(confirmation=True))
        assert resp.status_code == 409
        assert azure["started"] == []

    def test_the_target_size_is_re_read_from_azure_not_the_request(self, client, users, azure):
        client.act_as(identity(users[0], "oid-1"))
        client.post("/api/v1/compute/resize", json=preview_body(confirmation=True))
        # run_resize is handed the size Azure's own catalogue confirmed, and the
        # size Azure says the VM is now — never the caller's opinion of either.
        _, _, _, _, target, expected = azure["started"][0]
        assert target == "Standard_D4as_v5"
        assert expected == "Standard_D8as_v5"

    def test_an_unavailable_target_is_refused(self, client, users, azure):
        azure["azure"].skus = [s for s in azure["azure"].skus
                               if s["name"] != "Standard_D4as_v5"]
        client.act_as(identity(users[0], "oid-1"))
        resp = client.post("/api/v1/compute/resize",
                           json=preview_body(confirmation=True))
        assert resp.status_code == 409
        assert azure["started"] == []


class TestDuplicateClickProtection:
    def test_a_second_resize_on_the_same_vm_is_rejected(self, client, users, azure):
        client.act_as(identity(users[0], "oid-1"))
        first = client.post("/api/v1/compute/resize",
                            json=preview_body(confirmation=True))
        second = client.post("/api/v1/compute/resize",
                             json=preview_body(confirmation=True))
        assert first.status_code == 200
        assert second.status_code == 409
        assert len(azure["started"]) == 1

    def test_a_different_user_cannot_start_a_competing_resize(self, client, users, azure):
        client.act_as(identity(users[0], "oid-1"))
        client.post("/api/v1/compute/resize", json=preview_body(confirmation=True))
        client.act_as(identity(users[1], "oid-2"))
        resp = client.post("/api/v1/compute/resize",
                           json=preview_body(confirmation=True))
        assert resp.status_code == 409

    def test_the_preview_reports_the_operation_already_running(self, client, users, azure):
        client.act_as(identity(users[0], "oid-1"))
        client.post("/api/v1/compute/resize", json=preview_body(confirmation=True))
        plan = client.post("/api/v1/compute/resize/preview",
                           json=preview_body()).json()
        assert plan["can_resize"] is False
        assert plan["active_operation_id"]


class TestOperationVisibility:
    def test_progress_survives_a_page_refresh(self, client, users, azure):
        client.act_as(identity(users[0], "oid-1"))
        operation_id = client.post(
            "/api/v1/compute/resize", json=preview_body(confirmation=True)
        ).json()["operation_id"]
        # A brand new request, as a reloaded browser would make.
        resp = client.get(f"/api/v1/compute/resize/operations/{operation_id}")
        assert resp.status_code == 200
        assert resp.json()["operation_id"] == operation_id
        assert resp.json()["steps"]

    def test_another_account_cannot_read_the_operation(self, client, users, azure):
        client.act_as(identity(users[0], "oid-1"))
        operation_id = client.post(
            "/api/v1/compute/resize", json=preview_body(confirmation=True)
        ).json()["operation_id"]
        client.act_as(identity(users[1], "oid-2"))
        assert client.get(
            f"/api/v1/compute/resize/operations/{operation_id}"
        ).status_code == 404

    def test_an_unknown_operation_is_a_404_not_an_empty_success(self, client, users, azure):
        client.act_as(identity(users[0], "oid-1"))
        assert client.get(
            "/api/v1/compute/resize/operations/does-not-exist"
        ).status_code == 404


class TestHistory:
    def test_a_resize_appears_in_the_owners_history(self, client, users, azure):
        client.act_as(identity(users[0], "oid-1"))
        client.post("/api/v1/compute/resize", json=preview_body(confirmation=True))
        resp = client.get("/api/v1/compute/resize/history?tenant_id=tenant-1")
        assert resp.status_code == 200
        assert resp.json()["count"] == 1
        assert resp.json()["operations"][0]["old_sku"] == "Standard_D8as_v5"

    def test_it_does_not_appear_in_another_accounts_history(self, client, users, azure):
        client.act_as(identity(users[0], "oid-1"))
        client.post("/api/v1/compute/resize", json=preview_body(confirmation=True))
        client.act_as(identity(users[1], "oid-2"))
        resp = client.get("/api/v1/compute/resize/history?tenant_id=tenant-1")
        assert resp.json()["count"] == 0

    def test_it_does_not_leak_across_tenants(self, client, users, azure):
        client.act_as(identity(users[0], "oid-1"))
        client.post("/api/v1/compute/resize", json=preview_body(confirmation=True))
        resp = client.get("/api/v1/compute/resize/history?tenant_id=tenant-2")
        assert resp.json()["count"] == 0
