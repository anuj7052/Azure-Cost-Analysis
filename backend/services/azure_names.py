"""
Turning Azure identifiers into words a person can read.

Azure identifies everything by GUID or by a hundred-character resource path,
and a security review written in those terms is a review nobody finishes. The
job of this module is to put a name in front of every identifier the access
pages show, and -- just as importantly -- to say "Unknown user" rather than a
GUID when no name can be found.

Three things follow from that second point.

A GUID is never a name. `265b1023-8610-487b-8eac-76245f735289 has not used
Owner` is not a sentence about a person; it is a sentence about a failed
lookup, and it should read like one. The identifier is kept, but it moves to
technical details where an administrator can still use it.

Most resolution needs no network call at all. A resource id already contains
the subscription, the resource group, the provider, the type and the name --
parsing it is free, exact, and cannot be throttled. Only display names for
subscriptions and directory objects genuinely require Azure, and both are
fetched once per request and reused from a map.

Names are for reading, ids are for acting. Nothing here overwrites an
identifier. Every function adds fields alongside the originals, because the
moment a user presses "Remove access" it is the id, not the name, that has to
be correct.
"""

from __future__ import annotations

import time
from typing import Any, Dict, List, Optional

# ---------------------------------------------------------------------------
# Resource identifiers
# ---------------------------------------------------------------------------

# Azure's own type strings, in the words the portal uses. This covers what the
# access pages actually surface; anything absent falls back to a readable form
# derived from the type itself rather than to the raw string.
_TYPE_NAMES = {
    "microsoft.compute/virtualmachines": "Virtual Machine",
    "microsoft.compute/disks": "Managed Disk",
    "microsoft.compute/virtualmachinescalesets": "Scale Set",
    "microsoft.storage/storageaccounts": "Storage Account",
    "microsoft.network/virtualnetworks": "Virtual Network",
    "microsoft.network/networkinterfaces": "Network Interface",
    "microsoft.network/publicipaddresses": "Public IP Address",
    "microsoft.network/networksecuritygroups": "Network Security Group",
    "microsoft.network/loadbalancers": "Load Balancer",
    "microsoft.network/applicationgateways": "Application Gateway",
    "microsoft.keyvault/vaults": "Key Vault",
    "microsoft.sql/servers": "SQL Server",
    "microsoft.sql/servers/databases": "SQL Database",
    "microsoft.dbformysql/flexibleservers": "MySQL Server",
    "microsoft.dbforpostgresql/flexibleservers": "PostgreSQL Server",
    "microsoft.web/sites": "App Service",
    "microsoft.web/serverfarms": "App Service Plan",
    "microsoft.containerservice/managedclusters": "Kubernetes Cluster",
    "microsoft.containerregistry/registries": "Container Registry",
    "microsoft.documentdb/databaseaccounts": "Cosmos DB Account",
    "microsoft.insights/components": "Application Insights",
    "microsoft.operationalinsights/workspaces": "Log Analytics Workspace",
    "microsoft.recoveryservices/vaults": "Recovery Services Vault",
    "microsoft.managedidentity/userassignedidentities": "Managed Identity",
    "microsoft.cognitiveservices/accounts": "AI Service",
}


def _spaced(text: str) -> str:
    """`virtualMachines` -> `Virtual Machines`, for types we do not know."""
    out = []
    for index, char in enumerate(text):
        if char.isupper() and index and not text[index - 1].isupper():
            out.append(" ")
        out.append(char)
    return "".join(out).strip()


def friendly_type(resource_type: str) -> str:
    """
    A readable name for an Azure resource type.

    Unknown types are derived rather than passed through: an administrator
    reading "Virtual Machines" instead of "Microsoft.Compute/virtualMachines"
    has lost nothing, and the exact string is still in technical details.
    """
    key = (resource_type or "").strip().lower()
    if not key:
        return ""
    if key in _TYPE_NAMES:
        return _TYPE_NAMES[key]
    tail = (resource_type or "").split("/")[-1]
    spaced = _spaced(tail)
    return spaced[:1].upper() + spaced[1:] if spaced else resource_type


def parse_resource_id(resource_id: str) -> Dict[str, str]:
    """
    Break an Azure resource id into its parts.

    Everything the finding cards need -- subscription, resource group, type and
    name -- is already inside the string. Parsing it costs nothing and cannot
    fail because of a permission or a throttle, which makes it strictly better
    than asking Azure for information Azure already told us.
    """
    empty = {
        "subscription_id": "",
        "resource_group": "",
        "provider": "",
        "resource_type": "",
        "resource_name": "",
    }
    text = (resource_id or "").strip()
    if not text:
        return empty

    parts = [p for p in text.split("/") if p]
    lowered = [p.lower() for p in parts]
    out = dict(empty)

    if "subscriptions" in lowered:
        index = lowered.index("subscriptions")
        if index + 1 < len(parts):
            out["subscription_id"] = parts[index + 1]

    if "resourcegroups" in lowered:
        index = lowered.index("resourcegroups")
        if index + 1 < len(parts):
            out["resource_group"] = parts[index + 1]

    if "providers" in lowered:
        index = lowered.index("providers")
        tail = parts[index + 1:]
        if tail:
            out["provider"] = tail[0]
            # After the provider the path alternates type/name, possibly
            # several times for nested resources such as a SQL database inside
            # a server. The type is every odd segment joined; the name is the
            # last segment, which is what a person recognises.
            segments = tail[1:]
            types = [segments[i] for i in range(0, len(segments), 2)]
            names = [segments[i] for i in range(1, len(segments), 2)]
            if types:
                out["resource_type"] = f"{tail[0]}/{'/'.join(types)}"
            if names:
                out["resource_name"] = names[-1]

    return out


def management_group_of(scope: str) -> str:
    parts = [p for p in (scope or "").split("/") if p]
    lowered = [p.lower() for p in parts]
    if "managementgroups" in lowered:
        index = lowered.index("managementgroups")
        if index + 1 < len(parts):
            return parts[index + 1]
    return ""


# ---------------------------------------------------------------------------
# Scopes
# ---------------------------------------------------------------------------

def describe_scope(
    scope: str,
    subscription_names: Optional[Dict[str, str]] = None,
    management_group_names: Optional[Dict[str, str]] = None,
) -> Dict[str, str]:
    """
    Everything worth saying about where an access permission applies.

    Returns both a short `label` for tables and a `sentence` for cards. The
    label answers "where", the sentence answers "how much does that cover",
    which are different questions -- "Kredily Production" does not by itself
    tell a reader that the access reaches every resource inside it.
    """
    names = subscription_names or {}
    mg_names = management_group_names or {}
    text = (scope or "").strip()

    parsed = parse_resource_id(text)
    subscription_id = parsed["subscription_id"]
    subscription_name = names.get(subscription_id, "")

    out = {
        "kind": "unknown",
        "label": "",
        "sentence": "",
        "subscription_id": subscription_id,
        "subscription_name": subscription_name,
        "resource_group": parsed["resource_group"],
        "resource_name": parsed["resource_name"],
        "resource_type": friendly_type(parsed["resource_type"]),
        "management_group": "",
    }

    if not text or text == "/":
        out["kind"] = "tenant"
        out["label"] = "Entire organisation"
        out["sentence"] = "Access applies to everything in this Azure tenant."
        return out

    group_id = management_group_of(text)
    if group_id:
        out["kind"] = "management group"
        out["management_group"] = group_id
        friendly = mg_names.get(group_id, "")
        out["label"] = friendly or group_id
        out["sentence"] = (
            f"Access applies to the management group {out['label']}, and so to "
            "every subscription inside it."
        )
        return out

    # A subscription whose name could not be read is named as such rather than
    # by its GUID. The GUID is still returned in `subscription_id` for the
    # technical panel.
    sub_label = subscription_name or "Unnamed subscription"

    if parsed["resource_name"]:
        out["kind"] = "resource"
        out["label"] = parsed["resource_name"]
        out["sentence"] = (
            f"Access applies to one {out['resource_type'] or 'resource'}, "
            f"{parsed['resource_name']}, in {sub_label}."
        )
        return out

    if parsed["resource_group"]:
        out["kind"] = "resource group"
        out["label"] = parsed["resource_group"]
        out["sentence"] = (
            f"Access applies to everything in the resource group "
            f"{parsed['resource_group']}, in {sub_label}."
        )
        return out

    if subscription_id:
        out["kind"] = "subscription"
        out["label"] = sub_label
        out["sentence"] = (
            f"Access applies to the entire {sub_label} subscription, including "
            "every resource in it."
        )
        return out

    out["label"] = text.rsplit("/", 1)[-1]
    out["sentence"] = "Where this access applies could not be determined."
    return out


# ---------------------------------------------------------------------------
# Principals
# ---------------------------------------------------------------------------

# What to print where a name belongs and no name was found.
#
# Not "Unknown user". "Unknown" reads as a claim about the account -- as though
# Azure knows of someone and cannot say who they are, or worse, as though the
# account is itself suspicious. The truth is duller and more actionable: the
# name was never returned to us, because reading names needs a directory
# permission that is granted separately from the one that reads subscriptions.
# The principal type is shown beside this label as its own field, so nothing is
# lost by keeping the label itself plain.
UNRESOLVED_LABEL = "Name unavailable"

# The explanation that has to travel with that label. A placeholder without a
# reason beside it is the thing users file bugs about.
UNRESOLVED_NOTE = (
    "Azure did not provide a display name for this account. Resolving names "
    "requires the Directory.Read.All permission, which is approved separately "
    "from the permission that reads your subscriptions."
)


def principal_label(
    display_name: str = "",
    upn: str = "",
    principal_type: str = "",
) -> str:
    """
    What to print where a person's name belongs.

    The identifier is deliberately not part of the fallback chain. Showing a
    GUID here is what produced "265b1023-8610-487b-8eac-76245f735289 has not
    used Owner" -- a sentence that reads as though the GUID is a colleague.

    `principal_type` is accepted and unused: callers already have it and pass
    it, and the signature keeps the door open for a type-specific phrasing
    without a change at every call site. It must never reach the label, for the
    same reason the id must not.
    """
    name = (display_name or "").strip()
    if name:
        return name
    mail = (upn or "").strip()
    if mail:
        return mail
    return UNRESOLVED_LABEL


def is_named(display_name: str = "", upn: str = "") -> bool:
    return bool((display_name or "").strip() or (upn or "").strip())


# ---------------------------------------------------------------------------
# Roles
# ---------------------------------------------------------------------------

# One sentence per role, in the terms a business owner would use. Only roles
# whose meaning is genuinely well known are listed; inventing a description for
# a custom role would be asserting something we have not read.
ROLE_MEANING = {
    "owner": "Can manage resources and control who else has access.",
    "contributor": "Can manage resources but cannot grant access to others.",
    "reader": "Can view resources but cannot change them.",
    "user access administrator": "Can grant and remove other people's access.",
    "security admin": "Can manage security settings and policies.",
    "security reader": "Can view security findings but cannot change them.",
    "billing reader": "Can view billing information only.",
    "storage blob data reader": "Can read the contents of storage, but not change it.",
    "storage blob data contributor": "Can read and change the contents of storage.",
    "key vault secrets user": "Can read secrets held in Key Vault.",
}


def role_meaning(role_name: str) -> str:
    return ROLE_MEANING.get((role_name or "").strip().lower(), "")


def role_label(role_name: str, role_definition_id: str = "") -> str:
    """A role's name, or an honest statement that it could not be read."""
    name = (role_name or "").strip()
    if name and name.lower() != "unknown role":
        return name
    return "Unknown role" if role_definition_id else "No role recorded"


# ---------------------------------------------------------------------------
# Subscription names
#
# Cached alongside the authorisation cache in token_resolver, which already
# reads /subscriptions for every request. Reusing that read is the difference
# between one Azure call and one per finding.
# ---------------------------------------------------------------------------

_SUBSCRIPTION_NAMES: Dict[tuple, tuple] = {}
_NAME_TTL = 300.0


def remember_subscription_names(key: tuple, raw: List[Dict[str, Any]]) -> None:
    """Record display names from a subscription listing we already fetched."""
    names = {}
    for item in raw or []:
        sub_id = str(item.get("subscriptionId") or "")
        name = str(item.get("displayName") or "")
        if sub_id and name:
            names[sub_id] = name
    if names:
        _SUBSCRIPTION_NAMES[key] = (time.monotonic(), names)


def subscription_names(key: tuple) -> Dict[str, str]:
    """
    Known subscription display names for one tenant and token.

    Keyed exactly as the authorisation cache is, so one customer's subscription
    names can never be served to another. An expired or missing entry returns
    an empty map, and every caller falls back to "Unnamed subscription" rather
    than to a GUID.
    """
    entry = _SUBSCRIPTION_NAMES.get(key)
    if not entry:
        return {}
    stamped, names = entry
    if time.monotonic() - stamped > _NAME_TTL:
        _SUBSCRIPTION_NAMES.pop(key, None)
        return {}
    return dict(names)


def reset_names() -> None:
    _SUBSCRIPTION_NAMES.clear()
