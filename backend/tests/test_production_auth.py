"""
The two tokens, and why production could not be switched on without them.

This app calls Azure on the caller's behalf, so the browser holds an ARM
access token. For a long time it sent that same token as the `Authorization`
bearer, and the API authenticated people with it. That is convenient and it is
an authentication bypass: an ARM-audience token is issued for Azure, not for
us, and Microsoft mints one for every application a user has ever consented
to. Any of those could have been replayed against this API.

The audience check that closes the hole already existed -- it just could not
be enabled, because enabling it broke every Azure read. So the tokens are now
separated: `Authorization` proves identity and must be issued for this app,
`X-Azure-Token` is relayed to Azure and is never trusted as identity.

These tests exist so nobody quietly merges them back together, and so the
production audience rules keep failing closed rather than open.
"""
from __future__ import annotations

import pytest

from auth import dependencies, token_validator
from core.config import Settings, production_config_errors
from services import token_resolver


CLIENT_ID = "11111111-2222-3333-4444-555555555555"
ARM = "https://management.azure.com/"


class _Creds:
    def __init__(self, token):
        self.credentials = token


@pytest.fixture
def signed_in(monkeypatch):
    """Any bearer validates; these tests are about routing, not signatures."""
    monkeypatch.setattr(
        dependencies, "validate_azure_token",
        lambda token: {"oid": "user-1", "name": "Dana", "tid": "t1"},
    )


# --- the two tokens stay apart ---------------------------------------------

def test_the_azure_token_is_taken_from_its_own_header(signed_in):
    claims = dependencies._token_claims(_Creds("sign-in-token"), x_azure_token="arm-token")
    assert claims["token"] == "sign-in-token"
    assert claims["azure_token"] == "arm-token"


def test_without_the_header_the_bearer_is_reused(signed_in):
    """Development sends one token for everything, and must keep working."""
    claims = dependencies._token_claims(_Creds("only-token"), x_azure_token=None)
    assert claims["token"] == claims["azure_token"] == "only-token"


def test_the_header_is_never_validated_as_proof_of_identity(monkeypatch):
    """
    An ARM token cannot be checked by us -- only Azure can. If this header were
    ever fed to the validator, a caller could authenticate with a token minted
    for somebody else's application, which is the whole bug.
    """
    seen = []

    def record(token):
        seen.append(token)
        return {"oid": "user-1", "tid": "t1"}

    monkeypatch.setattr(dependencies, "validate_azure_token", record)
    dependencies._token_claims(_Creds("sign-in-token"), x_azure_token="arm-token")
    assert seen == ["sign-in-token"]


async def test_azure_calls_use_the_relayed_token_not_the_sign_in_one():
    user = {
        "account_id": "acct-1", "tenant_id": "t1",
        "token": "sign-in-token", "azure_token": "arm-token",
    }

    class _NoRows:
        async def __aenter__(self): return self
        async def __aexit__(self, *_): return False
        async def fetchone(self): return None

    class _Db:
        def execute(self, *_a, **_k): return _NoRows()

    assert await token_resolver.resolve_tenant_token("t1", user, _Db()) == "arm-token"


async def test_an_older_caller_without_the_header_still_resolves():
    """`azure_token` absent entirely, as in any code path built before this."""
    user = {"account_id": "acct-1", "tenant_id": "t1", "token": "sign-in-token"}

    class _NoRows:
        async def __aenter__(self): return self
        async def __aexit__(self, *_): return False
        async def fetchone(self): return None

    class _Db:
        def execute(self, *_a, **_k): return _NoRows()

    assert await token_resolver.resolve_tenant_token("t1", user, _Db()) == "sign-in-token"


# --- production audience rules fail closed ---------------------------------

def test_production_refuses_arm_audience_tokens(monkeypatch):
    monkeypatch.setattr(token_validator.settings, "ENVIRONMENT", "production")
    monkeypatch.setattr(token_validator.settings, "AZURE_CLIENT_ID", CLIENT_ID)
    allowed = token_validator.allowed_audiences()
    assert ARM not in allowed
    assert allowed == {CLIENT_ID, f"api://{CLIENT_ID}"}


def test_development_still_accepts_them(monkeypatch):
    monkeypatch.setattr(token_validator.settings, "ENVIRONMENT", "development")
    monkeypatch.setattr(token_validator.settings, "AZURE_CLIENT_ID", CLIENT_ID)
    assert ARM in token_validator.allowed_audiences()


def test_an_unconfigured_production_server_accepts_nothing(monkeypatch):
    """
    An empty allow-list must mean "trust no token", never "trust every token".
    Failing open here would be invisible: the app would appear to work.
    """
    monkeypatch.setattr(token_validator.settings, "ENVIRONMENT", "production")
    monkeypatch.setattr(token_validator.settings, "AZURE_CLIENT_ID", "")
    assert token_validator.allowed_audiences() == set()


# --- the startup checks that stop an insecure production boot --------------

def _prod(**over):
    base = dict(
        ENVIRONMENT="production",
        AZURE_CLIENT_ID=CLIENT_ID,
        APP_SECRET_KEY="x" * 48,
        CORS_ORIGINS="https://app.example.com",
    )
    base.update(over)
    return Settings(**base)


def test_a_correct_production_config_reports_no_problems():
    assert production_config_errors(_prod()) == []


@pytest.mark.parametrize("over, expect", [
    ({"APP_SECRET_KEY": "change-this-secret"}, "APP_SECRET_KEY"),
    ({"APP_SECRET_KEY": "short"}, "APP_SECRET_KEY"),
    ({"AZURE_CLIENT_ID": ""}, "AZURE_CLIENT_ID"),
    ({"CORS_ORIGINS": "http://app.example.com"}, "CORS_ORIGINS"),
])
def test_each_insecure_setting_is_named_not_merely_counted(over, expect):
    """
    The message has to say which setting, because whoever reads it is looking
    at a deployment that refused to start and has no other clue.
    """
    problems = production_config_errors(_prod(**over))
    assert any(expect in p for p in problems), problems
