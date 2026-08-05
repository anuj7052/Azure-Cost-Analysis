from __future__ import annotations

from enum import StrEnum


class Role(StrEnum):
    ADMIN = "Admin"
    ENGINEER = "Engineer"
    VIEWER = "Viewer"


# Higher number => more privilege. Used for "at least this role" checks.
_RANK: dict[Role, int] = {Role.VIEWER: 1, Role.ENGINEER: 2, Role.ADMIN: 3}


class Permission(StrEnum):
    READ = "read"
    TRIGGER_SYNC = "sync:trigger"
    MANAGE_RECOMMENDATIONS = "recommendations:manage"
    MANAGE_ALERT_RULES = "alerts:manage"
    RUN_REPORTS = "reports:run"
    MANAGE_CONNECTIONS = "connections:manage"
    MANAGE_USERS = "users:manage"
    VIEW_AUDIT_LOG = "audit:read"


ROLE_PERMISSIONS: dict[Role, set[Permission]] = {
    Role.VIEWER: {Permission.READ},
    Role.ENGINEER: {
        Permission.READ,
        Permission.TRIGGER_SYNC,
        Permission.MANAGE_RECOMMENDATIONS,
        Permission.MANAGE_ALERT_RULES,
        Permission.RUN_REPORTS,
    },
    Role.ADMIN: set(Permission),
}


def rank(role: Role) -> int:
    return _RANK[role]


def has_permission(role: Role, permission: Permission) -> bool:
    return permission in ROLE_PERMISSIONS[role]


def role_from_claims(claims: dict) -> Role:
    """Map Entra ID app roles / groups onto our internal roles.

    Falls back to the least-privileged role so a misconfigured app registration
    can never accidentally grant elevated access.
    """
    granted = {str(r).lower() for r in claims.get("roles", [])}
    for role in (Role.ADMIN, Role.ENGINEER, Role.VIEWER):
        if role.lower() in granted:
            return role
    return Role.VIEWER
