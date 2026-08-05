from __future__ import annotations

import pytest

from app.auth.rbac import Permission, Role, has_permission, role_from_claims


@pytest.mark.parametrize(
    ("role", "permission", "expected"),
    [
        (Role.VIEWER, Permission.READ, True),
        (Role.VIEWER, Permission.TRIGGER_SYNC, False),
        (Role.VIEWER, Permission.MANAGE_CONNECTIONS, False),
        (Role.ENGINEER, Permission.TRIGGER_SYNC, True),
        (Role.ENGINEER, Permission.MANAGE_CONNECTIONS, False),
        (Role.ENGINEER, Permission.MANAGE_USERS, False),
        (Role.ADMIN, Permission.MANAGE_CONNECTIONS, True),
        (Role.ADMIN, Permission.VIEW_AUDIT_LOG, True),
    ],
)
def test_permission_matrix(role, permission, expected):
    assert has_permission(role, permission) is expected


def test_unknown_claims_fall_back_to_viewer():
    assert role_from_claims({}) is Role.VIEWER
    assert role_from_claims({"roles": ["SomethingElse"]}) is Role.VIEWER


def test_highest_role_wins():
    assert role_from_claims({"roles": ["Viewer", "Admin"]}) is Role.ADMIN
    assert role_from_claims({"roles": ["viewer", "engineer"]}) is Role.ENGINEER


def test_principal_require_raises_for_missing_permission():
    from app.auth.dependencies import Principal
    from app.core.errors import ForbiddenError

    principal = Principal(
        tenant_id="t", object_id="o", email="e", name="n", role=Role.VIEWER
    )
    principal.require(Permission.READ)
    with pytest.raises(ForbiddenError):
        principal.require(Permission.MANAGE_CONNECTIONS)
