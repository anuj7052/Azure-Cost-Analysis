"""
Which client gets built for which endpoint.

The bug these cover was silent and expensive: an Azure OpenAI resource driven
through the plain OpenAI client returns ``404 Resource not found``, which the
error mapper honestly reports as "could not find that model" -- sending the
customer to check a model name that was correct all along. So the tests here
are mostly about shapes of URLs, because that is where the customer's truth
actually lives.
"""

import pytest
from fastapi import HTTPException
from openai import AsyncAzureOpenAI, AsyncOpenAI

from services import llm_client, llm_errors

RESOURCE = "https://my-resource.openai.azure.com"


def cfg(**over):
    base = {"api_key": "k-123", "base_url": "", "model": "gpt-4o", "kind": "openai"}
    base.update(over)
    return base


# --- recognising Azure ------------------------------------------------


def test_a_declared_azure_endpoint_is_treated_as_azure():
    assert llm_client.is_azure("azure_openai", RESOURCE) is True


def test_an_azure_resource_pasted_under_the_wrong_kind_is_still_recognised():
    # Choosing the wrong item in a dropdown is a slip, not a decision. We can
    # see what they meant from the hostname.
    assert llm_client.is_azure("openai", RESOURCE) is True
    assert llm_client.is_azure("custom", f"{RESOURCE}/openai") is True


def test_the_openai_compatible_azure_surface_is_left_to_the_plain_client():
    # /openai/v1 genuinely speaks OpenAI. Forcing it down the Azure path would
    # break a configuration that was correct.
    assert llm_client.is_azure("azure_openai", f"{RESOURCE}/openai/v1") is False
    assert llm_client.is_azure("azure_openai", f"{RESOURCE}/openai/v1/") is False


def test_ordinary_endpoints_are_not_azure():
    assert llm_client.is_azure("openai", "") is False
    assert llm_client.is_azure("custom", "https://llm.mycompany.com/v1") is False


def test_a_lookalike_hostname_is_not_azure():
    # Suffix matching must be on the host, not on the string.
    assert llm_client.is_azure("openai", "https://notmy.openai.azure.com.evil.io/v1") is False


# --- normalising what people paste ------------------------------------


@pytest.mark.parametrize(
    "pasted",
    [
        RESOURCE,
        f"{RESOURCE}/",
        f"{RESOURCE}/openai",
        f"{RESOURCE}/openai/deployments/my-gpt4o",
        f"{RESOURCE}/openai/deployments/my-gpt4o/chat/completions",
    ],
)
def test_every_shape_the_portal_shows_reduces_to_the_resource(pasted):
    assert llm_client.azure_endpoint(pasted) == RESOURCE


def test_the_deployment_is_read_out_of_the_path_when_the_model_box_is_empty():
    llm = cfg(kind="azure_openai", base_url=f"{RESOURCE}/openai/deployments/my-gpt4o", model="")
    assert llm_client.model_for(llm) == "my-gpt4o"


def test_an_explicit_model_wins_over_the_path():
    # If they filled both boxes, the box they filled on purpose is the answer.
    llm = cfg(kind="azure_openai", base_url=f"{RESOURCE}/openai/deployments/old", model="new")
    assert llm_client.model_for(llm) == "new"


# --- building the client ----------------------------------------------


def test_an_azure_endpoint_builds_an_azure_client():
    client = llm_client.build_client(cfg(kind="azure_openai", base_url=RESOURCE))
    assert isinstance(client, AsyncAzureOpenAI)


def test_an_azure_client_carries_an_api_version():
    # Without this the classic Azure API refuses the call outright.
    client = llm_client.build_client(cfg(kind="azure_openai", base_url=RESOURCE))
    assert "api-version" in str(client._custom_query or {}) or client._api_version


def test_an_explicit_api_version_is_honoured():
    client = llm_client.build_client(
        cfg(kind="azure_openai", base_url=RESOURCE, api_version="2099-01-01")
    )
    assert client._api_version == "2099-01-01"


def test_an_ordinary_endpoint_builds_a_plain_client():
    client = llm_client.build_client(cfg(base_url="https://llm.mycompany.com/v1"))
    assert isinstance(client, AsyncOpenAI)
    assert not isinstance(client, AsyncAzureOpenAI)


def test_a_blank_base_url_means_the_public_openai_api():
    client = llm_client.build_client(cfg(base_url=""))
    assert "api.openai.com" in str(client.base_url)


def test_a_missing_key_is_a_setup_problem_not_a_request_failure():
    with pytest.raises(HTTPException) as caught:
        llm_client.build_client(cfg(api_key=""))
    assert caught.value.status_code == 503
    assert "Settings" in caught.value.detail


def test_a_whitespace_only_key_counts_as_missing():
    with pytest.raises(HTTPException) as caught:
        llm_client.build_client(cfg(api_key="   "))
    assert caught.value.status_code == 503


# --- how the endpoint is named back to the customer -------------------


def test_the_customers_own_label_is_quoted_so_the_sentence_reads():
    # "Test could not find that model" reads as a broken string; the quotes
    # make it clear this is the name they gave the endpoint.
    assert llm_errors.label_for("Test") == "The endpoint you named \u201cTest\u201d"


def test_a_model_name_typed_into_the_name_box_is_still_named_as_their_label():
    # Someone called their endpoint "gpt-5.4-pro". Without "you named", the
    # message opens with a model name and reads as a complaint about the
    # model, sending them to fix the wrong box.
    assert "you named" in llm_errors.label_for("gpt-5.4-pro")


def test_the_shared_platform_endpoint_is_not_named_after_an_internal_word():
    assert llm_errors.label_for("platform") == "The model endpoint"
    assert llm_errors.label_for("") == "The model endpoint"
    assert llm_errors.label_for(None) == "The model endpoint"


def test_the_not_found_message_points_at_the_deployment_name_and_the_url():
    error = llm_errors.as_http_error(
        _not_found("Resource not found"), llm_errors.label_for("Test")
    )
    assert error.status_code == 400
    assert "deployment name" in error.detail
    assert "openai.azure.com" in error.detail
    assert "Resource not found" in error.detail
    assert error.detail.startswith("The endpoint you named \u201cTest\u201d")


def _not_found(message: str) -> Exception:
    exc = type("NotFoundError", (Exception,), {})(message)
    exc.status_code = 404
    exc.body = {"error": {"message": message}}
    return exc
