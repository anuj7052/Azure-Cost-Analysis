"""The single most important guarantee: no tenant can read another's data."""
from __future__ import annotations

import pytest

from app.repositories import ResourceRepo


async def _seed(session, tenant_id: str, name: str):
    repo = ResourceRepo(session, tenant_id)
    await repo.add(
        azure_resource_id=f"/subscriptions/sub/{name}",
        name=name,
        resource_type="virtual_machine",
        subscription_id="sub",
    )
    await session.flush()
    return repo


async def test_list_never_returns_other_tenants_rows(session, tenant_a, tenant_b):
    repo_a = await _seed(session, tenant_a, "vm-a")
    repo_b = await _seed(session, tenant_b, "vm-b")

    names_a = {r.name for r in await repo_a.list()}
    names_b = {r.name for r in await repo_b.list()}

    assert names_a == {"vm-a"}
    assert names_b == {"vm-b"}


async def test_get_by_id_across_tenants_returns_none(session, tenant_a, tenant_b):
    repo_a = await _seed(session, tenant_a, "vm-a")
    repo_b = ResourceRepo(session, tenant_b)

    only = (await repo_a.list())[0]
    assert await repo_b.get(only.id) is None


async def test_count_is_tenant_scoped(session, tenant_a, tenant_b):
    repo_a = await _seed(session, tenant_a, "vm-a")
    await _seed(session, tenant_b, "vm-b1")
    await _seed(session, tenant_b, "vm-b2")

    assert await repo_a.count() == 1
    assert await ResourceRepo(session, tenant_b).count() == 2


async def test_delete_rejects_foreign_entity(session, tenant_a, tenant_b):
    repo_a = await _seed(session, tenant_a, "vm-a")
    entity = (await repo_a.list())[0]

    from app.core.errors import NotFoundError

    with pytest.raises(NotFoundError):
        await ResourceRepo(session, tenant_b).delete(entity)


async def test_repository_requires_tenant_id(session):
    with pytest.raises(ValueError):
        ResourceRepo(session, "")
