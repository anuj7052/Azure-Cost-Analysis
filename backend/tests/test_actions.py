"""The action framework: the guards, not the plumbing.

Everything here is about what must be true before this application is allowed
to change somebody's Azure estate, and what must be recorded afterwards. The
Azure call itself is scripted, because these tests are not about whether a tag
lands -- they are about whether an unconfirmed request, a viewer, a double
click or a disabled capability can reach Azure at all.
"""
import json

import aiosqlite
import httpx
import pytest
import pytest_asyncio
from fastapi import HTTPException

import core.db as db_module
from core.config import settings
from services import actions, tagging, user_service

RESOURCE = (
    "/subscriptions/sub-1/resourceGroups/rg-1/providers"
    "/Microsoft.Compute/virtualMachines/vm-1"
)


@pytest_asyncio.fixture
async def api_db(tmp_path, monkeypatch):
    path = str(tmp_path / "actions.db")
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


def identity(user: dict, *, can_administer: bool = True) -> dict:
    return {
        "user_id": f"oid-{user['id']}", "name": user["name"],
        "email": user["email"], "preferred_username": user["email"],
        "tenant_id": "tenant-1",
        "account_id": user["id"], "actor_id": user["id"],
        "is_owner": True, "owner_id": user["id"],
        "workspace_role": "admin" if can_administer else "user",
        "can_administer": can_administer,
        "role": user["role"], "status": user["status"],
        "created_at": user["created_at"],
    }


TAG_SPEC = actions.get_spec("resource.tag")


# ── The guards ─────────────────────────────────────────────────────────────


def test_a_disabled_action_cannot_be_run(users):
    owner, _ = users
    spec = actions.get_spec("vm.deallocate")
    assert spec.enabled is False

    with pytest.raises(actions.ActionError) as exc:
        actions.authorize(spec, identity(owner), confirmed=True)
    assert exc.value.status_code == 403


def test_an_irreversible_action_is_refused_even_if_enabled(users):
    """Switching `enabled` on must not be enough to ship a delete.

    This is the second lock on the same door, and it is deliberate: a delete
    that cannot be undone should take more than one dictionary edit to reach a
    customer's estate.
    """
    owner, _ = users
    delete = actions.get_spec("disk.delete")
    forced = type(delete)(**{**delete.__dict__, "enabled": True})

    with pytest.raises(actions.ActionError) as exc:
        actions.authorize(forced, identity(owner), confirmed=True)
    assert exc.value.status_code == 403
    assert "cannot be undone" in exc.value.message


def test_a_viewer_cannot_change_azure(users):
    owner, _ = users
    with pytest.raises(actions.ActionError) as exc:
        actions.authorize(TAG_SPEC, identity(owner, can_administer=False), confirmed=True)
    assert exc.value.status_code == 403


def test_an_unconfirmed_change_is_refused(users):
    owner, _ = users
    with pytest.raises(actions.ActionError) as exc:
        actions.authorize(TAG_SPEC, identity(owner), confirmed=False)
    assert exc.value.status_code == 400


def test_an_unknown_action_key_is_a_bad_request_not_a_missing_page():
    with pytest.raises(actions.ActionError) as exc:
        actions.get_spec("vm.selfDestruct")
    assert exc.value.status_code == 400


# ── The record ─────────────────────────────────────────────────────────────


async def test_a_successful_action_is_recorded_with_both_states(api_db, users):
    owner, _ = users

    async def run():
        return {"tags": {"owner": "platform"}}

    row = await actions.execute(
        api_db, spec=TAG_SPEC, user=identity(owner), tenant_id="tenant-1",
        run=run, confirmed=True, resource_id=RESOURCE,
        request={"tags": {"owner": "platform"}},
        previous_state={"tags": {}},
    )

    assert row["state"] == actions.SUCCEEDED
    assert json.loads(row["previous_state"]) == {"tags": {}}
    assert json.loads(row["new_state"]) == {"tags": {"owner": "platform"}}
    assert row["actor_id"] == owner["id"]
    assert row["completed_at"] is not None


async def test_a_failed_action_is_recorded_and_the_error_is_re_raised(api_db, users):
    """A refused change is the more interesting audit record of the two."""
    owner, _ = users

    async def run():
        raise HTTPException(status_code=502, detail="Azure said no.")

    with pytest.raises(HTTPException):
        await actions.execute(
            api_db, spec=TAG_SPEC, user=identity(owner), tenant_id="tenant-1",
            run=run, confirmed=True, resource_id=RESOURCE,
        )

    rows = await actions.history(api_db, owner["id"], "tenant-1")
    assert len(rows) == 1
    assert rows[0]["state"] == actions.FAILED
    assert "Azure said no." in rows[0]["failure_reason"]


async def test_the_row_is_written_before_azure_is_called(api_db, users):
    """A process that dies mid-flight must still leave evidence of the attempt."""
    owner, _ = users
    seen = {}

    async def run():
        rows = await actions.history(api_db, owner["id"], "tenant-1")
        seen["state_during_call"] = rows[0]["state"] if rows else None
        return {}

    await actions.execute(
        api_db, spec=TAG_SPEC, user=identity(owner), tenant_id="tenant-1",
        run=run, confirmed=True, resource_id=RESOURCE,
    )
    assert seen["state_during_call"] == actions.PENDING


# ── Retries and collisions ─────────────────────────────────────────────────


async def test_the_same_idempotency_key_does_not_change_azure_twice(api_db, users):
    owner, _ = users
    calls = []

    async def run():
        calls.append(1)
        return {"tags": {"owner": "platform"}}

    first = await actions.execute(
        api_db, spec=TAG_SPEC, user=identity(owner), tenant_id="tenant-1",
        run=run, confirmed=True, resource_id=RESOURCE, idempotency_key="key-1",
    )
    second = await actions.execute(
        api_db, spec=TAG_SPEC, user=identity(owner), tenant_id="tenant-1",
        run=run, confirmed=True, resource_id=RESOURCE, idempotency_key="key-1",
    )

    assert len(calls) == 1
    assert second["action_id"] == first["action_id"]


async def test_two_workspaces_may_use_the_same_idempotency_key(api_db, users):
    """Keys are unique per workspace. A collision between customers is a
    coincidence, and treating it as a duplicate would hide a real change."""
    owner, other = users

    async def run():
        return {}

    a = await actions.execute(
        api_db, spec=TAG_SPEC, user=identity(owner), tenant_id="tenant-1",
        run=run, confirmed=True, resource_id=RESOURCE + "-a", idempotency_key="same",
    )
    b = await actions.execute(
        api_db, spec=TAG_SPEC, user=identity(other), tenant_id="tenant-1",
        run=run, confirmed=True, resource_id=RESOURCE + "-b", idempotency_key="same",
    )
    assert a["action_id"] != b["action_id"]


async def test_a_second_change_to_the_same_resource_is_rejected(api_db, users):
    """Deliberately not scoped to the caller: two administrators acting on the
    same VM at once is worse than one person clicking twice."""
    owner, other = users
    await actions.begin(
        api_db, spec=TAG_SPEC, user=identity(owner), tenant_id="tenant-1",
        resource_id=RESOURCE,
    )

    async def run():
        return {}

    with pytest.raises(actions.ActionError) as exc:
        await actions.execute(
            api_db, spec=TAG_SPEC, user=identity(other), tenant_id="tenant-1",
            run=run, confirmed=True, resource_id=RESOURCE,
        )
    assert exc.value.status_code == 409


async def test_a_finished_action_does_not_block_the_next_one(api_db, users):
    owner, _ = users

    async def run():
        return {}

    await actions.execute(
        api_db, spec=TAG_SPEC, user=identity(owner), tenant_id="tenant-1",
        run=run, confirmed=True, resource_id=RESOURCE,
    )
    second = await actions.execute(
        api_db, spec=TAG_SPEC, user=identity(owner), tenant_id="tenant-1",
        run=run, confirmed=True, resource_id=RESOURCE,
    )
    assert second["state"] == actions.SUCCEEDED


# ── Isolation ──────────────────────────────────────────────────────────────


async def test_knowing_an_action_id_is_not_enough_to_read_it(api_db, users):
    owner, other = users

    async def run():
        return {}

    row = await actions.execute(
        api_db, spec=TAG_SPEC, user=identity(owner), tenant_id="tenant-1",
        run=run, confirmed=True, resource_id=RESOURCE,
    )

    assert await actions.get(api_db, row["action_id"], owner["id"]) is not None
    assert await actions.get(api_db, row["action_id"], other["id"]) is None


async def test_history_does_not_cross_workspaces_or_tenants(api_db, users):
    owner, other = users

    async def run():
        return {}

    await actions.execute(
        api_db, spec=TAG_SPEC, user=identity(owner), tenant_id="tenant-1",
        run=run, confirmed=True, resource_id=RESOURCE,
    )

    assert len(await actions.history(api_db, owner["id"], "tenant-1")) == 1
    assert await actions.history(api_db, other["id"], "tenant-1") == []
    assert await actions.history(api_db, owner["id"], "tenant-2") == []


# ── The catalogue ──────────────────────────────────────────────────────────


def test_the_catalogue_lists_disabled_actions_rather_than_hiding_them():
    keys = {item["key"]: item for item in actions.catalogue()}
    assert keys["disk.delete"]["enabled"] is False
    assert keys["disk.delete"]["reversible"] is False
    assert keys["resource.tag"]["enabled"] is True


def test_every_catalogue_entry_names_the_azure_permission_it_needs():
    """So a 403 from Azure can be explained rather than shown raw."""
    for item in actions.catalogue():
        assert item["azure_permission"], f"{item['key']} does not say what it needs"


def test_no_irreversible_action_is_shipped_enabled():
    """The guard in `authorize` is the enforcement; this is the alarm.

    If someone enables a delete, this fails and says so before it reaches a
    customer's estate.
    """
    for spec in actions.REGISTRY.values():
        assert not (spec.enabled and not spec.reversible), (
            f"{spec.key} is enabled but cannot be undone"
        )


# ── Tag validation ─────────────────────────────────────────────────────────


@pytest.mark.parametrize("tags, expected", [
    ({}, "No tags"),
    ({"": "x"}, "cannot be empty"),
    ({"a<b": "x"}, "does not allow"),
    ({"k": "v" * 300}, "longer than"),
    ({f"k{i}": "v" for i in range(51)}, "at most"),
])
def test_bad_tags_are_refused_with_a_reason(tags, expected):
    message = tagging.validate_tags(tags)
    assert expected in message


def test_reasonable_tags_are_accepted():
    assert tagging.validate_tags({"owner": "platform", "env": "prod"}) == ""


async def test_tags_are_merged_not_replaced():
    """Azure's PUT replaces the whole tag set, which would delete tags this
    application never knew about. The request must say Merge."""
    sent = {}

    def handler(request: httpx.Request) -> httpx.Response:
        sent["method"] = request.method
        sent["body"] = json.loads(request.content)
        return httpx.Response(200, json={"properties": {"tags": {"a": "1", "b": "2"}}})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        ok, error, applied = await tagging.apply_tags(client, "tok", RESOURCE, {"b": "2"})

    assert ok and not error
    assert sent["method"] == "PATCH"
    assert sent["body"]["operation"] == "Merge"
    assert applied == {"a": "1", "b": "2"}


async def test_an_untagged_resource_reads_as_empty_not_as_a_failure():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, json={"error": {"message": "not found"}})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        tags, error = await tagging.read_tags(client, "tok", RESOURCE)

    assert tags == {}
    assert error == ""


async def test_azures_own_explanation_is_kept():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(403, json={"error": {
            "message": "The client does not have authorization to perform action "
                       "'Microsoft.Resources/tags/write'."
        }})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        ok, error, _ = await tagging.apply_tags(client, "tok", RESOURCE, {"a": "1"})

    assert ok is False
    assert "Microsoft.Resources/tags/write" in error


# ── The endpoints ──────────────────────────────────────────────────────────


@pytest.fixture
def client(api_db, monkeypatch):
    monkeypatch.setattr(settings, "RATE_LIMIT_ENABLED", False)

    from auth.dependencies import get_current_user, require_workspace_admin
    from core.db import get_db
    from fastapi.testclient import TestClient
    import main
    import routers.actions as actions_router

    current = {"user": None}

    async def override_user():
        if current["user"] is None:
            raise HTTPException(status_code=401, detail="Not authenticated")
        return current["user"]

    async def override_admin():
        user = await override_user()
        if not user.get("can_administer"):
            raise HTTPException(status_code=403, detail="View access only.")
        return user

    async def override_db():
        yield api_db

    async def fake_token(tenant_id, user, db):
        return "arm-token"

    async def fake_authorize(token, tenant_id, subscription_ids):
        return list(subscription_ids)

    monkeypatch.setattr(actions_router, "resolve_tenant_token", fake_token)
    monkeypatch.setattr(actions_router, "authorize_subscriptions", fake_authorize)

    main.app.dependency_overrides[get_current_user] = override_user
    main.app.dependency_overrides[require_workspace_admin] = override_admin
    main.app.dependency_overrides[get_db] = override_db

    with TestClient(main.app) as test_client:
        test_client.act_as = lambda user: current.__setitem__("user", user)
        yield test_client

    main.app.dependency_overrides.clear()


@pytest.fixture
def azure(monkeypatch):
    """A scripted ARM that records every request it received."""
    seen = []
    original = httpx.AsyncClient

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.method == "GET":
            return httpx.Response(200, json={"properties": {"tags": {"env": "dev"}}})
        return httpx.Response(200, json={"properties": {
            "tags": {"env": "dev", "owner": "platform"}
        }})

    class Patched(original):
        def __init__(self, *args, **kwargs):
            kwargs["transport"] = httpx.MockTransport(handler)
            super().__init__(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", Patched)
    return seen


def tag_body(**over):
    body = {"tenant_id": "tenant-1", "resource_id": RESOURCE,
            "tags": {"owner": "platform"}, "confirmation": True}
    body.update(over)
    return body


def test_the_catalogue_tells_a_viewer_they_cannot_run_anything(client, users):
    owner, _ = users
    client.act_as(identity(owner, can_administer=False))

    response = client.get("/api/v1/actions")

    assert response.status_code == 200
    payload = response.json()
    assert payload["can_run"] is False
    assert any(a["key"] == "resource.tag" for a in payload["actions"])


def test_tagging_requires_confirmation(client, users, azure):
    owner, _ = users
    client.act_as(identity(owner))

    response = client.post("/api/v1/actions/tag", json=tag_body(confirmation=False))

    assert response.status_code == 400
    assert azure == [], "Azure was called for an unconfirmed change"


def test_a_viewer_cannot_tag(client, users, azure):
    owner, _ = users
    client.act_as(identity(owner, can_administer=False))

    response = client.post("/api/v1/actions/tag", json=tag_body())

    assert response.status_code == 403
    assert azure == []


def test_a_resource_id_that_is_not_an_arm_id_is_refused(client, users, azure):
    """The value is interpolated into a management.azure.com URL."""
    owner, _ = users
    client.act_as(identity(owner))

    for bad in ("../../evil", "https://evil.test/x", "/subscriptions/a/../../b"):
        response = client.post("/api/v1/actions/tag", json=tag_body(resource_id=bad))
        assert response.status_code == 422, bad
    assert azure == []


def test_a_confirmed_tag_change_is_applied_and_recorded(client, users, azure):
    owner, _ = users
    client.act_as(identity(owner))

    response = client.post("/api/v1/actions/tag", json=tag_body())

    assert response.status_code == 200
    record = response.json()
    assert record["state"] == "SUCCEEDED"
    assert record["previous_state"]["tags"] == {"env": "dev"}
    assert record["new_state"]["tags"] == {"env": "dev", "owner": "platform"}
    assert [r.method for r in azure] == ["GET", "PATCH"]


def test_a_retried_request_does_not_tag_twice(client, users, azure):
    owner, _ = users
    client.act_as(identity(owner))
    headers = {"Idempotency-Key": "retry-1"}

    first = client.post("/api/v1/actions/tag", json=tag_body(), headers=headers)
    second = client.post("/api/v1/actions/tag", json=tag_body(), headers=headers)

    assert first.json()["action_id"] == second.json()["action_id"]
    assert [r.method for r in azure].count("PATCH") == 1


def test_history_and_lookup_are_scoped_to_the_workspace(client, users, azure):
    owner, other = users
    client.act_as(identity(owner))
    created = client.post("/api/v1/actions/tag", json=tag_body()).json()

    client.act_as(identity(other))
    assert client.get(f"/api/v1/actions/{created['action_id']}").status_code == 404
    assert client.get("/api/v1/actions/history?tenant_id=tenant-1").json()["items"] == []


def test_an_azure_refusal_is_reported_and_recorded(client, users, monkeypatch):
    owner, _ = users
    client.act_as(identity(owner))

    original = httpx.AsyncClient

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return httpx.Response(200, json={"properties": {"tags": {}}})
        return httpx.Response(403, json={"error": {"message": "No tags/write."}})

    class Patched(original):
        def __init__(self, *args, **kwargs):
            kwargs["transport"] = httpx.MockTransport(handler)
            super().__init__(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", Patched)

    response = client.post("/api/v1/actions/tag", json=tag_body())
    assert response.status_code == 502

    history = client.get("/api/v1/actions/history?tenant_id=tenant-1").json()["items"]
    assert history[0]["state"] == "FAILED"
    assert "No tags/write." in history[0]["failure_reason"]
