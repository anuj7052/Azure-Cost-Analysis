"""
The assistant answering questions about the account, and failing out loud.

Two failures drove this file. The first: every provider error — wrong key,
wrong deployment name, unreachable endpoint — arrived on screen as "Something
went wrong handling this request", which tells the person who configured the
endpoint nothing at all. The second: the assistant could describe what it was
able to build but could not answer "what have I already got", which is the
question people ask first.

The rule these tests exist to defend is that reading the account never invents
anything. A refusal from Azure has to survive all the way to the answer as a
refusal.
"""
from __future__ import annotations

import pytest
from fastapi import HTTPException

from services import estate_tools, llm_errors
from services.estate_tools import EstateTools


# ── Provider failures say what went wrong ──────────────────────────────────

class FakeProviderError(Exception):
    def __init__(self, name, message, status=None, body=None):
        super().__init__(message)
        type(self).__name__ = name
        self.message = message
        if status is not None:
            self.status_code = status
        if body is not None:
            self.body = body


def error_named(name, message="boom", status=None, body=None):
    cls = type(name, (Exception,), {})
    exc = cls(message)
    exc.message = message
    if status is not None:
        exc.status_code = status
    if body is not None:
        exc.body = body
    return exc


def test_a_rejected_key_names_the_key_and_where_to_fix_it():
    err = llm_errors.as_http_error(
        error_named("AuthenticationError", "Incorrect API key provided"),
        "My endpoint",
    )
    assert err.status_code == 400
    assert "rejected the API key" in err.detail
    assert "Settings" in err.detail
    assert "Incorrect API key provided" in err.detail


def test_a_missing_model_mentions_azure_deployment_names():
    """
    The single most common misconfiguration: Azure OpenAI wants the deployment
    name, not the model name, and the resulting 404 is otherwise unreadable.
    """
    err = llm_errors.as_http_error(
        error_named("NotFoundError", "The model does not exist", status=404),
        "My endpoint",
    )
    assert err.status_code == 400
    assert "deployment name" in err.detail


def test_an_unreachable_endpoint_is_a_bad_gateway_not_a_bad_request():
    """The status has to distinguish 'retrying may help' from 'fix your config'."""
    err = llm_errors.as_http_error(
        error_named("APIConnectionError", "Connection refused"), "My endpoint"
    )
    assert err.status_code == 502
    assert "base URL" in err.detail


def test_provider_rate_limiting_is_reported_as_rate_limiting():
    err = llm_errors.as_http_error(
        error_named("RateLimitError", "quota exceeded", status=429), "My endpoint"
    )
    assert err.status_code == 429
    assert "quota exceeded" in err.detail


def test_an_unknown_failure_still_carries_its_reason():
    err = llm_errors.as_http_error(error_named("WeirdError", "something odd"))
    assert err.status_code == 502
    assert "something odd" in err.detail
    assert "WeirdError" in err.detail


def test_the_structured_body_is_preferred_over_the_exception_text():
    err = llm_errors.as_http_error(
        error_named(
            "BadRequestError", "unhelpful", status=400,
            body={"error": {"message": "tools are not supported by this model"}},
        ),
        "My endpoint",
    )
    assert "tools are not supported by this model" in err.detail


def test_an_api_key_echoed_back_by_the_provider_is_not_shown():
    """
    Some providers quote the key back in the error body. An error message is
    one of the easiest things in a web app to end up in a log or a screenshot.
    """
    leaked = "sk-abcdef0123456789abcdef0123456789"
    err = llm_errors.as_http_error(
        error_named("AuthenticationError", f"Invalid key {leaked}"), "My endpoint"
    )
    assert leaked not in err.detail
    assert "[redacted]" in err.detail


def test_a_bare_long_token_is_also_redacted():
    leaked = "A" * 40
    assert leaked not in llm_errors.redact(f"key was {leaked}")


# ── Reading the account ────────────────────────────────────────────────────

SUBS = [
    {"subscriptionId": "sub-1", "displayName": "vs-anuj-individual",
     "state": "Enabled", "tenantId": "t1"},
    {"subscriptionId": "sub-2", "displayName": "Tally - Foetron",
     "state": "Enabled", "tenantId": "t1"},
    {"subscriptionId": "sub-3", "displayName": "Other directory",
     "state": "Enabled", "tenantId": "t2"},
]


@pytest.fixture
def tools(monkeypatch):
    async def fake_list(_token):
        return SUBS
    monkeypatch.setattr(estate_tools, "list_subscriptions", fake_list)

    async def allow(_token, _tenant, ids):
        return list(ids)
    monkeypatch.setattr(estate_tools, "authorize_subscriptions", allow)

    return EstateTools("token", "t1", currency="INR")


async def test_only_the_selected_directorys_subscriptions_are_listed(tools):
    result = await tools.list_subscriptions()
    assert [s["name"] for s in result["subscriptions"]] == [
        "vs-anuj-individual", "Tally - Foetron",
    ]


async def test_a_subscription_can_be_named_the_way_a_person_would_say_it(tools, monkeypatch):
    """People say "anuj", not a GUID."""
    async def costs(*_a, **_k):
        return [{"ServiceName": "Virtual Machines", "PreTaxCost": "12.5"}]
    monkeypatch.setattr(estate_tools.cost_client, "query_costs", costs)

    result = await tools.describe_subscription(subscription="anuj")
    assert result["subscription"]["id"] == "sub-1"
    assert result["total"] == 12.5


async def test_an_ambiguous_name_is_reported_rather_than_guessed(tools):
    """
    Picking the first match and then quoting its costs would be
    indistinguishable from a correct answer.
    """
    result = await tools.describe_subscription(subscription="a")
    assert "error" in result
    assert len(result["candidates"]) == 2


async def test_a_subscription_in_another_directory_is_not_found(tools):
    result = await tools.describe_subscription(subscription="Other directory")
    assert "error" in result
    assert "sub-3" not in str(result)


async def test_an_unknown_name_lists_what_is_actually_available(tools):
    result = await tools.describe_subscription(subscription="nonexistent")
    assert "error" in result
    assert "vs-anuj-individual" in result["available"]


async def test_azure_refusing_costs_reports_not_available_not_zero(tools, monkeypatch):
    """The rule this module exists to enforce. Zero would look like an answer."""
    async def refuse(*_a, **_k):
        raise HTTPException(status_code=403, detail="Cost access denied")
    monkeypatch.setattr(estate_tools.cost_client, "query_costs", refuse)

    result = await tools.describe_subscription(subscription="anuj")
    assert result["cost"] == estate_tools.UNAVAILABLE
    assert "total" not in result
    assert result["reason"]


async def test_a_subscription_this_account_cannot_read_is_refused(tools, monkeypatch):
    async def deny(_token, _tenant, _ids):
        return []
    monkeypatch.setattr(estate_tools, "authorize_subscriptions", deny)

    result = await tools.describe_subscription(subscription="anuj")
    assert result["cost"] == estate_tools.UNAVAILABLE
    assert "cannot read" in result["reason"]


async def test_an_empty_cost_result_is_zero_with_a_note_not_a_failure(tools, monkeypatch):
    """A brand new subscription really has spent nothing."""
    async def none(*_a, **_k):
        return []
    monkeypatch.setattr(estate_tools.cost_client, "query_costs", none)

    result = await tools.describe_subscription(subscription="anuj")
    assert result["total"] == 0.0
    assert "no cost records" in result["note"]


async def test_costs_are_ranked_and_summed_per_service(tools, monkeypatch):
    async def costs(*_a, **_k):
        return [
            {"ServiceName": "Storage", "PreTaxCost": "5"},
            {"ServiceName": "Virtual Machines", "PreTaxCost": "10"},
            {"ServiceName": "Storage", "PreTaxCost": "2.5"},
        ]
    monkeypatch.setattr(estate_tools.cost_client, "query_costs", costs)

    result = await tools.subscription_costs(subscription="anuj", months=3)
    assert result["total"] == 17.5
    assert result["breakdown"][0] == {"name": "Virtual Machines", "cost": 10.0}
    assert result["breakdown"][1] == {"name": "Storage", "cost": 7.5}


async def test_a_silly_month_count_is_clamped_not_rejected(tools, monkeypatch):
    seen = {}

    async def costs(_token, _sub, months=3, **_k):
        seen["months"] = months
        return []
    monkeypatch.setattr(estate_tools.cost_client, "query_costs", costs)

    await tools.subscription_costs(subscription="anuj", months=999)
    assert seen["months"] == 12


async def test_resources_can_be_filtered_by_type(tools, monkeypatch):
    async def resources(*_a, **_k):
        return [
            {"name": "vm-1", "type": "microsoft.compute/virtualMachines",
             "location": "centralindia", "resourceGroup": "rg-a"},
            {"name": "sa1", "type": "microsoft.storage/storageAccounts",
             "location": "centralindia", "resourceGroup": "rg-a"},
        ]
    monkeypatch.setattr(estate_tools.cost_client, "query_active_resources", resources)

    result = await tools.list_resources(subscription="anuj", kind="virtualMachines")
    assert result["total"] == 1
    assert result["resources"][0]["name"] == "vm-1"


async def test_a_resource_read_that_fails_says_so(tools, monkeypatch):
    async def refuse(*_a, **_k):
        raise HTTPException(status_code=403, detail="Reader role required")
    monkeypatch.setattr(estate_tools.cost_client, "query_active_resources", refuse)

    result = await tools.list_resources(subscription="anuj")
    assert result["resources"] == estate_tools.UNAVAILABLE
    assert result["reason"]


async def test_a_huge_estate_is_capped_but_reports_the_real_total(tools, monkeypatch):
    """The cap is about the model's context window, not about hiding anything."""
    async def many(*_a, **_k):
        return [
            {"name": f"r{i}", "type": "microsoft.compute/virtualMachines"}
            for i in range(200)
        ]
    monkeypatch.setattr(estate_tools.cost_client, "query_active_resources", many)

    result = await tools.list_resources(subscription="anuj")
    assert result["total"] == 200
    assert result["showing"] == estate_tools.MAX_RESOURCES
    assert len(result["resources"]) == estate_tools.MAX_RESOURCES


async def test_no_tool_takes_a_credential(tools):
    """
    The token is held by the object, not passed as an argument, so there is no
    parameter a model could be talked into pointing at another account.
    """
    import inspect

    for name in ("list_subscriptions", "describe_subscription",
                 "subscription_costs", "list_resources"):
        params = inspect.signature(getattr(tools, name)).parameters
        for bad in ("token", "credential", "key", "secret", "tenant"):
            assert bad not in params, f"{name} accepts {bad}"


# ── The prompt still forbids inventing ─────────────────────────────────────

def test_the_prompt_requires_repeating_a_refusal_rather_than_guessing():
    from services.provision_chat_service import SYSTEM_PROMPT

    assert "Not available" in SYSTEM_PROMPT
    assert "cannot deploy" in SYSTEM_PROMPT
    assert "never name a subscription or resource a" in SYSTEM_PROMPT
