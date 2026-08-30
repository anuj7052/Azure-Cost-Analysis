"""
The single, honest answer to "what access does this app need?".

Every other place that answers that question - the onboarding screen, the
add-tenant dialog, the PDF - reads from here. That matters more than it looks.
The guide used to say "read-only: nothing in this setup can create, change or
delete resources" while the code held PUT calls against tags, deployments and
role assignments. A customer who followed that guide got silent 403s on half
the product, and a customer who read it as a security promise was misled. One
list, generated from one place, is the only way that stays true.

Two separate permission systems are involved and they are constantly confused
with each other:

  * **Azure RBAC roles** control resources and billing. They are granted per
    subscription (or management group) in Access control (IAM).
  * **Entra API permissions** control the directory - turning the GUID in a
    role assignment into "Priya Sharma". They are granted once on the app
    registration and need a tenant administrator's consent.

Having one does not give you the other. That is the single most common reason
onboarding stalls.

Nothing here is specific to whoever happens to be running this instance. The
tenant id is always supplied by the caller, so this module is safe to render
to any customer.
"""
from __future__ import annotations

from typing import Dict, List, Optional
from urllib.parse import quote

# Grant tiers. A customer picks how far down this list they want to go, and
# the product degrades honestly rather than breaking.
CORE = "core"           # without these, the app has nothing to show
FULL_READ = "full-read"  # unlocks the remaining read-only pages
WRITE = "write"          # lets the app change things in Azure

TIER_ORDER = (CORE, FULL_READ, WRITE)

TIER_LABEL = {
    CORE: "Essential",
    FULL_READ: "Full visibility",
    WRITE: "Make changes",
}

TIER_SUMMARY = {
    CORE: (
        "The minimum for the app to be useful. Costs, resources and the "
        "estate view all work. Everything is read-only."
    ),
    FULL_READ: (
        "Still read-only, but turns on the security, activity, metrics and "
        "governance pages. Most customers grant this."
    ),
    WRITE: (
        "Only needed if you want the app to act, not just report - applying "
        "tags, resizing a VM, deploying from a BOQ, or removing a role "
        "assignment. Grant these last, and only if you want those features."
    ),
}

READ = "read"
CHANGE = "change"

# Scope strings, kept as constants because the difference between them is
# where most of the confusion lives.
SUBSCRIPTION = "subscription"
MANAGEMENT_GROUP = "management-group"
BILLING = "billing"
DIRECTORY = "directory"

SCOPE_LABEL = {
    SUBSCRIPTION: "Each subscription you want to track",
    MANAGEMENT_GROUP: "Management group (root, or the one you care about)",
    BILLING: "Billing / reservation order",
    DIRECTORY: "Entra tenant (app registration)",
}


def _role(
    name: str,
    role_id: str,
    tier: str,
    access: str,
    scope: str,
    why: str,
    unlocks: List[str],
    assignable: bool = True,
    caveat: str = "",
) -> Dict:
    """One Azure RBAC role, described in terms of what the customer gets."""
    return {
        "kind": "azure-role",
        "name": name,
        "role_id": role_id,
        "tier": tier,
        "access": access,
        "scope": scope,
        "scope_label": SCOPE_LABEL[scope],
        "why": why,
        "unlocks": unlocks,
        "assignable": assignable,
        "caveat": caveat,
    }


# Role definition ids verified against `az role definition list`. They are the
# same in every Azure tenant, so they can be published safely.
AZURE_ROLES: List[Dict] = [
    _role(
        "Reader",
        "acdd72a7-3385-48ef-bd42-f606fba81ae7",
        CORE, READ, SUBSCRIPTION,
        "Lists subscriptions, resource groups and every resource, so a charge "
        "can be traced back to the thing that caused it.",
        ["Estate", "Dashboard", "Orphaned resources", "Network"],
    ),
    _role(
        "Cost Management Reader",
        "72fafb9e-0641-4937-9268-a91bfd8191a3",
        CORE, READ, SUBSCRIPTION,
        "Reads the billing and usage data behind every figure the app shows.",
        ["Cost Trends", "Compare", "Anomalies", "Commitments"],
    ),
    _role(
        "Monitoring Reader",
        "43d0d8ad-25c7-4714-9337-8ba259a9fe05",
        FULL_READ, READ, SUBSCRIPTION,
        "Reads platform metrics and the activity log - CPU and memory for "
        "rightsizing, and who changed what.",
        ["Compute Intelligence", "Activity Explorer", "Changes"],
        caveat=(
            "Without this, rightsizing advice has no utilisation data behind "
            "it and the app will say so rather than guess."
        ),
    ),
    _role(
        "Security Reader",
        "39bc4728-0917-49c7-9d2c-d95423bc2eb4",
        FULL_READ, READ, SUBSCRIPTION,
        "Reads Defender for Cloud assessments, alerts, secure score and "
        "policy compliance.",
        ["Security", "Access Optimization", "Posture"],
        caveat=(
            "Plain Reader is not enough here - the Defender pricing and "
            "secure-score endpoints need this role specifically."
        ),
    ),
    _role(
        "Management Group Reader",
        "ac63b705-f282-497d-ac71-919bf39d939d",
        FULL_READ, READ, MANAGEMENT_GROUP,
        "Reads the management group tree and the policy and role assignments "
        "that are inherited down it.",
        ["Management Groups", "Access & Identity"],
        caveat=(
            "This is assigned at management group scope, not on a "
            "subscription. Subscription Reader does not inherit upwards."
        ),
    ),
    _role(
        "Reservation Reader",
        "",
        FULL_READ, READ, BILLING,
        "Reads reservation and savings plan orders and their utilisation.",
        ["Commitments"],
        assignable=False,
        caveat=(
            "This is not a subscription RBAC role and cannot be granted with "
            "a normal role assignment. A billing administrator grants it from "
            "the Reservations blade's own Access control, or enables "
            "tenant-wide reservation visibility. Without it the Commitments "
            "page will look empty, which is not the same as owning no "
            "reservations - the page says which of the two it is."
        ),
    ),
    _role(
        "Tag Contributor",
        "4a9ae827-6dc8-4573-8ac7-8239d42aa03f",
        WRITE, CHANGE, SUBSCRIPTION,
        "Lets the app write tags onto resources so ownership and cost centre "
        "can be corrected in place.",
        ["Actions: apply tags"],
        caveat="Tags only. This role cannot touch the resources themselves.",
    ),
    _role(
        "Virtual Machine Contributor",
        "9980e02c-c2be-4d73-94e8-173b1dc7cf3c",
        WRITE, CHANGE, SUBSCRIPTION,
        "Lets the app change a VM's size when rightsizing is accepted.",
        ["Compute Intelligence: resize"],
        caveat="A resize restarts the machine. The app confirms before acting.",
    ),
    _role(
        "Contributor",
        "b24988ac-6180-42a0-ab88-20f7382dd24c",
        WRITE, CHANGE, SUBSCRIPTION,
        "Lets the app create the resources described by a BOQ or a "
        "provisioning request.",
        ["Provision", "Deploy from BOQ"],
        caveat=(
            "This is broad. Scope it to a single resource group rather than "
            "the whole subscription unless you deploy estate-wide."
        ),
    ),
    _role(
        "Role Based Access Administrator",
        "f58310d9-a9f6-439a-9e8d-f62e7b41a168",
        WRITE, CHANGE, SUBSCRIPTION,
        "Lets the app remove or downgrade a role assignment that access "
        "review flagged as excessive.",
        ["Access Optimization: revoke and downgrade"],
        caveat=(
            "The most sensitive role on this list - it can grant access, not "
            "just remove it. Prefer to leave this ungranted and let the app "
            "produce the change for a human to apply."
        ),
    ),
]


def _graph(
    name: str,
    permission_id: str,
    tier: str,
    why: str,
    unlocks: List[str],
    admin_consent: bool,
    caveat: str = "",
) -> Dict:
    return {
        "kind": "graph-permission",
        "name": name,
        "permission_id": permission_id,
        "permission_type": "Delegated",
        "tier": tier,
        "access": READ,
        "scope": DIRECTORY,
        "scope_label": SCOPE_LABEL[DIRECTORY],
        "why": why,
        "unlocks": unlocks,
        "admin_consent": admin_consent,
        "caveat": caveat,
    }


# Microsoft Graph, resource app id 00000003-0000-0000-c000-000000000000.
# Every one of these is Delegated - the app acts as the signed-in user and can
# never see more than that person can. Application permissions are deliberately
# not used: they would require this app to hold a secret with standing access
# to a customer's directory, which is exactly what a shared SaaS should avoid.
GRAPH_RESOURCE_ID = "00000003-0000-0000-c000-000000000000"

GRAPH_PERMISSIONS: List[Dict] = [
    _graph(
        "User.Read",
        "e1fe6dd8-ba31-4d61-89e7-88639da4683d",
        CORE,
        "Confirms who is signed in and reads their name and email.",
        ["Sign-in"],
        admin_consent=False,
        caveat="Granted by each user on first sign-in. No administrator needed.",
    ),
    _graph(
        "Directory.Read.All",
        "06da0dbc-49e2-44d2-8312-53f166ab848a",
        FULL_READ,
        "Turns the GUIDs in role assignments into people, groups and managed "
        "identities, and powers the person picker when granting access.",
        ["Access & Identity", "Access Optimization", "Role assignments"],
        admin_consent=True,
        caveat=(
            "Be clear-eyed about this one: it reads the whole directory, not "
            "only the accounts this app displays. It is Delegated, so it can "
            "never exceed what the signed-in user could already see in the "
            "portal - but it does need a tenant administrator to consent. "
            "Skip it and every account shows as a raw GUID; nothing else "
            "breaks."
        ),
    ),
]

AZURE_SERVICE_MANAGEMENT_RESOURCE_ID = "797f4846-ba00-4fd7-ba43-dac1f8f63013"

AZURE_SERVICE_MANAGEMENT: Dict = {
    "kind": "graph-permission",
    "name": "Azure Service Management / user_impersonation",
    "permission_id": "41094075-9dad-400e-a0bd-54e686782033",
    "permission_type": "Delegated",
    "tier": CORE,
    "access": READ,
    "scope": DIRECTORY,
    "scope_label": SCOPE_LABEL[DIRECTORY],
    "why": (
        "Lets the app call Azure Resource Manager as the signed-in user. This "
        "is what makes the RBAC roles above actually take effect."
    ),
    "unlocks": ["Everything that reads Azure"],
    "admin_consent": False,
    "caveat": (
        "Grants nothing on its own. The user still only sees what their own "
        "role assignments allow."
    ),
}


def roles_in_tier(tier: str) -> List[Dict]:
    """Azure roles for one tier, in the order they should be granted."""
    return [r for r in AZURE_ROLES if r["tier"] == tier]


def graph_in_tier(tier: str) -> List[Dict]:
    items = [g for g in GRAPH_PERMISSIONS if g["tier"] == tier]
    if AZURE_SERVICE_MANAGEMENT["tier"] == tier:
        items.append(AZURE_SERVICE_MANAGEMENT)
    return items


def cumulative_roles(tier: str) -> List[Dict]:
    """
    Everything needed to reach a tier, including the tiers beneath it.

    Tiers are cumulative on purpose. Somebody granting "Full visibility"
    without Reader would get a broken product, so the list they are shown has
    to include the earlier tiers rather than assuming they read the page in
    order.
    """
    if tier not in TIER_ORDER:
        return []
    upto = TIER_ORDER[: TIER_ORDER.index(tier) + 1]
    return [r for r in AZURE_ROLES if r["tier"] in upto]


def assignable_roles(roles: List[Dict]) -> List[Dict]:
    """Only the roles a normal `az role assignment create` can actually grant."""
    return [r for r in roles if r.get("assignable")]


def write_roles() -> List[Dict]:
    """Every role that lets the app change something. Used to keep copy honest."""
    return [r for r in AZURE_ROLES if r["access"] == CHANGE]


def read_only(tier: str) -> bool:
    """True when nothing in this tier, or below it, can change Azure."""
    return all(r["access"] == READ for r in cumulative_roles(tier))


def role_assignment_command(
    role: Dict,
    subscription_id: str = "<subscription-id>",
    assignee: str = "<user-or-app-id>",
) -> Optional[str]:
    """
    The az command that grants one role, or None when there isn't one.

    Returning None rather than a plausible-looking command matters. Reservation
    Reader cannot be granted this way, and handing somebody a command that
    fails with a confusing error is worse than telling them it does not exist.
    """
    if not role.get("assignable"):
        return None
    if role["scope"] == MANAGEMENT_GROUP:
        scope = "/providers/Microsoft.Management/managementGroups/<management-group-id>"
    else:
        scope = f"/subscriptions/{subscription_id}"
    return (
        f"az role assignment create --assignee {assignee} "
        f"--role \"{role['name']}\" --scope {scope}"
    )


def consent_url(
    tenant_id: str,
    client_id: str,
    redirect_uri: str,
) -> Optional[str]:
    """
    The admin-consent link a new customer's administrator opens once.

    This is the whole point of the SaaS model: the customer's administrator
    consents to *this* application inside *their* tenant, which creates a
    service principal there. No secret, key or credential moves between the
    two organisations in either direction.

    All three arguments are required. Guessing a tenant would send the
    administrator to the wrong directory, where the consent would either fail
    or - worse - succeed against the wrong organisation.
    """
    if not tenant_id or not client_id or not redirect_uri:
        return None
    return (
        f"https://login.microsoftonline.com/{quote(tenant_id, safe='')}"
        f"/adminconsent?client_id={quote(client_id, safe='')}"
        f"&redirect_uri={quote(redirect_uri, safe='')}"
    )


def summarise() -> Dict:
    """Counts for the header, so the page can say how much is being asked for."""
    everything = AZURE_ROLES + GRAPH_PERMISSIONS + [AZURE_SERVICE_MANAGEMENT]
    return {
        "total": len(everything),
        "azure_roles": len(AZURE_ROLES),
        "graph_permissions": len(GRAPH_PERMISSIONS) + 1,
        "read": len([r for r in everything if r["access"] == READ]),
        "change": len([r for r in everything if r["access"] == CHANGE]),
        "needs_admin_consent": len(
            [g for g in GRAPH_PERMISSIONS if g.get("admin_consent")]
        ),
    }


def note() -> str:
    """One paragraph that has to survive being the only thing somebody reads."""
    writes = len(write_roles())
    return (
        "Grant these in order and stop wherever you are comfortable. "
        "The Essential tier alone gives you working cost and estate reporting, "
        f"and everything in it is read-only. Only the last {writes} roles let "
        "this app change anything in Azure, they are never granted by "
        "default, and every feature that needs one says so before it acts."
    )


def manifest(
    tenant_id: str = "",
    client_id: str = "",
    redirect_uri: str = "",
) -> Dict:
    """The whole thing, shaped for the API and the PDF alike."""
    return {
        "tiers": [
            {
                "key": tier,
                "label": TIER_LABEL[tier],
                "summary": TIER_SUMMARY[tier],
                "read_only": read_only(tier),
                "azure_roles": roles_in_tier(tier),
                "graph_permissions": graph_in_tier(tier),
            }
            for tier in TIER_ORDER
        ],
        "summary": summarise(),
        "note": note(),
        "consent_url": consent_url(tenant_id, client_id, redirect_uri),
        "graph_resource_id": GRAPH_RESOURCE_ID,
        "arm_resource_id": AZURE_SERVICE_MANAGEMENT_RESOURCE_ID,
    }
