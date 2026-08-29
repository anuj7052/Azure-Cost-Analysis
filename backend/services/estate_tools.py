"""
Read-only answers about the customer's own Azure estate, for the assistant.

The build assistant could previously only describe what it was able to create.
That made it useless for the question people actually ask first, which is some
variation of "what have I already got, and what is it costing me". These are
the tools that let it answer that.

Everything here is read-only and everything here is real. There is no path
through this module that invents a subscription, a resource or a figure: when
Azure refuses or is unreachable the tool returns the refusal, and the system
prompt requires the assistant to repeat it rather than fill the gap. A
confidently wrong cost is worse than no cost, because somebody will act on it.

Scope is not taken from the model. The subscriptions a tool may look at are the
ones the signed-in user's token actually holds, checked by the same
`authorize_subscriptions` every other route uses, so a model that asks about a
subscription id it saw somewhere gets a refusal rather than an answer.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from services import cost_client
from services.azure_mgmt import list_subscriptions
from services.token_resolver import authorize_subscriptions

log = logging.getLogger(__name__)

UNAVAILABLE = "Not available"

# A tool result is fed straight back into the model's context, so it has to be
# small. These caps are about the context window, not about the UI.
MAX_RESOURCES = 60
MAX_SERVICES = 25


def _reason(exc: Exception) -> str:
    """Azure's own words where we have them, so the reader can act on them."""
    try:
        return cost_client.friendly_error(exc)
    except Exception:  # noqa: BLE001
        return str(exc)


class EstateTools:
    """
    The estate an assistant is allowed to read, bound to one signed-in user.

    Built once per request with a token that has already been resolved for the
    selected tenant. Holding the token here rather than passing it through the
    model's arguments is the point: there is no tool parameter that could be
    talked into using somebody else's credentials.
    """

    def __init__(self, token: str, tenant_id: str, currency: str = "USD"):
        self.token = token
        self.tenant_id = tenant_id
        self.currency = currency
        self._subscriptions: Optional[List[Dict[str, Any]]] = None

    # --- helpers ------------------------------------------------------

    async def _all_subscriptions(self) -> List[Dict[str, Any]]:
        if self._subscriptions is None:
            raw = await list_subscriptions(self.token)
            self._subscriptions = [
                {
                    "id": str(s.get("subscriptionId") or ""),
                    "name": s.get("displayName") or "",
                    "state": s.get("state") or "",
                }
                for s in raw
                if not self.tenant_id
                or not s.get("tenantId")
                or str(s.get("tenantId")) == str(self.tenant_id)
            ]
        return self._subscriptions

    async def _resolve(self, wanted: str) -> Dict[str, Any]:
        """
        Turn whatever the user called a subscription into a real one.

        People say "anuj" or "the individual one", not a GUID, so a name
        fragment is matched too. An ambiguous fragment is reported as
        ambiguous rather than resolved to the first hit, because silently
        picking one and then quoting its costs would be indistinguishable
        from a correct answer.
        """
        subs = await self._all_subscriptions()
        term = (wanted or "").strip().lower()
        if not term:
            return {"error": "Name or id of the subscription is required."}

        exact = [s for s in subs if s["id"].lower() == term]
        if exact:
            return {"subscription": exact[0]}

        named = [s for s in subs if term == s["name"].lower()]
        if len(named) == 1:
            return {"subscription": named[0]}

        partial = [s for s in subs if term in s["name"].lower()]
        if len(partial) == 1:
            return {"subscription": partial[0]}
        if len(partial) > 1:
            return {
                "error": "More than one subscription matches that.",
                "candidates": [s["name"] for s in partial],
            }

        return {
            "error": f"No subscription called '{wanted}' is readable by this account.",
            "available": [s["name"] for s in subs][:20],
        }

    # --- tools --------------------------------------------------------

    async def list_subscriptions(self, **_: Any) -> Dict[str, Any]:
        """Every subscription this account can actually read, with its state."""
        try:
            subs = await self._all_subscriptions()
        except Exception as exc:  # noqa: BLE001
            return {"error": UNAVAILABLE, "reason": _reason(exc)}
        return {"count": len(subs), "subscriptions": subs}

    async def describe_subscription(
        self, subscription: str = "", **_: Any
    ) -> Dict[str, Any]:
        """
        One subscription: its id, state, what it cost last month, and the
        services that cost the most.
        """
        found = await self._resolve(subscription)
        if "error" in found:
            return found
        sub = found["subscription"]

        try:
            allowed = await authorize_subscriptions(
                self.token, self.tenant_id, [sub["id"]]
            )
        except Exception as exc:  # noqa: BLE001
            return {"subscription": sub, "cost": UNAVAILABLE, "reason": _reason(exc)}
        if not allowed:
            return {
                "subscription": sub,
                "cost": UNAVAILABLE,
                "reason": "This account cannot read that subscription.",
            }

        try:
            rows = await cost_client.query_costs(
                self.token, sub["id"], months=1, group_by=["ServiceName"]
            )
        except Exception as exc:  # noqa: BLE001
            return {"subscription": sub, "cost": UNAVAILABLE, "reason": _reason(exc)}

        return {
            "subscription": sub,
            "currency": self.currency,
            **_summarise_cost(rows, self.currency),
        }

    async def subscription_costs(
        self, subscription: str = "", months: int = 3, group_by: str = "ServiceName", **_: Any
    ) -> Dict[str, Any]:
        """What a subscription cost, broken down by service or by resource group."""
        found = await self._resolve(subscription)
        if "error" in found:
            return found
        sub = found["subscription"]

        dimension = "ResourceGroupName" if "group" in (group_by or "").lower() else "ServiceName"
        months = max(1, min(int(months or 3), 12))

        try:
            allowed = await authorize_subscriptions(
                self.token, self.tenant_id, [sub["id"]]
            )
            if not allowed:
                raise PermissionError("This account cannot read that subscription.")
            rows = await cost_client.query_costs(
                self.token, sub["id"], months=months, group_by=[dimension]
            )
        except Exception as exc:  # noqa: BLE001
            return {"subscription": sub, "cost": UNAVAILABLE, "reason": _reason(exc)}

        return {
            "subscription": sub,
            "months": months,
            "grouped_by": dimension,
            "currency": self.currency,
            **_summarise_cost(rows, self.currency, key=dimension),
        }

    async def list_resources(
        self, subscription: str = "", kind: str = "", **_: Any
    ) -> Dict[str, Any]:
        """What is actually running in a subscription, optionally filtered."""
        found = await self._resolve(subscription)
        if "error" in found:
            return found
        sub = found["subscription"]

        try:
            allowed = await authorize_subscriptions(
                self.token, self.tenant_id, [sub["id"]]
            )
            if not allowed:
                raise PermissionError("This account cannot read that subscription.")
            rows = await cost_client.query_active_resources(self.token, [sub["id"]])
        except Exception as exc:  # noqa: BLE001
            return {"subscription": sub, "resources": UNAVAILABLE, "reason": _reason(exc)}

        term = (kind or "").strip().lower()
        items = []
        for row in rows:
            rtype = str(row.get("type") or "")
            name = str(row.get("name") or "")
            if term and term not in rtype.lower() and term not in name.lower():
                continue
            items.append({
                "name": name,
                "type": rtype,
                "location": row.get("location") or "",
                "resource_group": row.get("resourceGroup") or "",
            })

        return {
            "subscription": sub,
            "total": len(items),
            "showing": min(len(items), MAX_RESOURCES),
            "resources": items[:MAX_RESOURCES],
        }


def _summarise_cost(
    rows: List[Dict[str, Any]], currency: str, key: str = "ServiceName"
) -> Dict[str, Any]:
    """
    Fold Cost Management rows into a total and a ranked breakdown.

    An empty result is reported as zero with a note rather than as a failure:
    a brand new subscription really has spent nothing, and calling that
    "unavailable" would be its own kind of wrong answer.
    """
    if not rows:
        return {
            "total": 0.0,
            "breakdown": [],
            "note": "Azure returned no cost records for this period.",
        }

    totals: Dict[str, float] = {}
    grand = 0.0
    for row in rows:
        amount = row.get("PreTaxCost") or row.get("totalCost") or row.get("Cost") or 0
        try:
            amount = float(amount)
        except (TypeError, ValueError):
            continue
        label = str(row.get(key) or row.get("ServiceName") or "Unattributed")
        totals[label] = totals.get(label, 0.0) + amount
        grand += amount

    ranked = sorted(totals.items(), key=lambda kv: kv[1], reverse=True)
    return {
        "total": round(grand, 2),
        "currency": currency,
        "breakdown": [
            {"name": name, "cost": round(value, 2)} for name, value in ranked[:MAX_SERVICES]
        ],
    }
