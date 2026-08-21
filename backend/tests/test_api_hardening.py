"""
The cross-cutting protections: config guards, headers, correlation, redaction,
rate limiting.

These are the checks that are easy to add and easy to silently lose. A header
middleware that stops being registered breaks nothing visible, and a redaction
filter that stops matching leaks credentials without any symptom at all — so
both are asserted rather than assumed.
"""
from __future__ import annotations

import logging

import pytest
from fastapi.testclient import TestClient

from core.config import INSECURE_SECRET_KEY, Settings, production_config_errors
from core.logging_config import RedactingFilter, scrub
from core.middleware import SecurityHeadersMiddleware


# ── Production configuration guard ─────────────────────────────────────────


def production(**overrides) -> Settings:
    base = {
        "ENVIRONMENT": "production",
        "APP_SECRET_KEY": "x" * 48,
        "AZURE_CLIENT_ID": "a-real-client-id",
        "CORS_ORIGINS": "https://app.example.com",
    }
    return Settings(**{**base, **overrides})


def test_a_correctly_configured_production_deployment_has_no_complaints():
    assert production_config_errors(production()) == []


def test_the_shipped_default_secret_is_refused_in_production():
    """
    The default is published in this repository. Treating it as a real key means
    every deployment that forgot to set one shares a signing secret with the
    public internet.
    """
    problems = production_config_errors(production(APP_SECRET_KEY=INSECURE_SECRET_KEY))

    assert any("APP_SECRET_KEY" in p for p in problems)


def test_a_short_secret_is_refused_in_production():
    problems = production_config_errors(production(APP_SECRET_KEY="tooshort"))
    assert any("32 characters" in p for p in problems)


def test_a_missing_client_id_is_refused_in_production():
    """
    Without a client id there is no audience to validate against, and the token
    validator would have nothing to fail closed on.
    """
    problems = production_config_errors(production(AZURE_CLIENT_ID=""))
    assert any("AZURE_CLIENT_ID" in p for p in problems)


def test_plaintext_origins_are_refused_in_production():
    problems = production_config_errors(
        production(CORS_ORIGINS="http://app.example.com,https://ok.example.com")
    )
    assert any("https" in p and "http://app.example.com" in p for p in problems)


def test_development_defaults_are_not_production_errors():
    """Local work must stay frictionless; the guard only applies to production."""
    dev = Settings(ENVIRONMENT="development", APP_SECRET_KEY=INSECURE_SECRET_KEY)

    assert dev.is_production is False


# ── Token audience ─────────────────────────────────────────────────────────


def test_production_does_not_accept_arm_scoped_tokens(monkeypatch):
    """
    Accepting ARM tokens lets a token minted for any consented Azure application
    be replayed against this API. Convenient in development, an authentication
    bypass in production.
    """
    import auth.token_validator as validator
    from core.config import settings

    monkeypatch.setattr(settings, "ENVIRONMENT", "production")
    monkeypatch.setattr(settings, "AZURE_CLIENT_ID", "my-client-id")

    audiences = validator.allowed_audiences()

    assert audiences == {"my-client-id", "api://my-client-id"}
    assert "https://management.azure.com/" not in audiences


def test_development_still_accepts_arm_scoped_tokens(monkeypatch):
    import auth.token_validator as validator
    from core.config import settings

    monkeypatch.setattr(settings, "ENVIRONMENT", "development")
    monkeypatch.setattr(settings, "AZURE_CLIENT_ID", "my-client-id")

    assert "https://management.azure.com/" in validator.allowed_audiences()


def test_an_unconfigured_production_api_fails_closed(monkeypatch):
    """
    An empty allow-list used to mean 'accept every audience'. That is the exact
    opposite of what an unconfigured deployment should do.
    """
    import auth.token_validator as validator
    from core.config import settings

    monkeypatch.setattr(settings, "ENVIRONMENT", "production")
    monkeypatch.setattr(settings, "AZURE_CLIENT_ID", "")

    assert validator.allowed_audiences() == set()


# ── Secret redaction in logs ───────────────────────────────────────────────


JWT = (
    "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9"
    ".eyJvaWQiOiIxMjMiLCJ0aWQiOiJhYmMifQ"
    ".c2lnbmF0dXJldmFsdWVoZXJl"
)


@pytest.mark.parametrize(
    "sensitive",
    [
        JWT,
        f"Authorization: Bearer {JWT}",
        "client_secret=sUp3r-s3cret-value",
        'api_key: "sk-abcdef0123456789abcdef"',
        "sk-abcdef0123456789abcdefXYZ",
        "AccountKey=abc123def456==;EndpointSuffix=core.windows.net",
        "password = hunter2hunter2",
    ],
)
def test_credentials_are_scrubbed_from_log_text(sensitive):
    """
    Broad patterns on purpose. A false positive costs a redacted log line;
    a false negative costs a credential that outlives the incident.
    """
    cleaned = scrub(sensitive)

    assert "sUp3r-s3cret-value" not in cleaned
    assert "hunter2hunter2" not in cleaned
    assert "abcdef0123456789" not in cleaned
    assert JWT not in cleaned
    assert "REDACTED" in cleaned


def test_ordinary_text_survives_scrubbing():
    """Redaction must not mangle the messages that make logs useful."""
    message = "scan 1841 captured 12,904 resources in subscription sub-prod-01"

    assert scrub(message) == message


def test_the_filter_does_not_break_percent_formatting():
    """
    A regression guard. Coercing every log argument to a string turned an int
    into "42" and broke the `%d` in httpx's own log line — which took down every
    request-level test until it was fixed.
    """
    record = logging.LogRecord(
        name="t", level=logging.INFO, pathname="", lineno=0,
        msg='HTTP Request: %s "%s %d %s"',
        args=("GET", "HTTP/1.1", 200, "OK"),
        exc_info=None,
    )

    assert RedactingFilter().filter(record) is True
    assert record.getMessage() == 'HTTP Request: GET "HTTP/1.1 200 OK"'


def test_a_token_in_a_log_argument_is_redacted():
    record = logging.LogRecord(
        name="t", level=logging.INFO, pathname="", lineno=0,
        msg="calling azure with %s", args=(f"Bearer {JWT}",), exc_info=None,
    )

    RedactingFilter().filter(record)

    assert JWT not in record.getMessage()


# ── Response middleware ────────────────────────────────────────────────────


@pytest.fixture
def app_client(monkeypatch):
    from core.config import settings
    import main

    monkeypatch.setattr(settings, "RATE_LIMIT_ENABLED", False)
    with TestClient(main.app) as client:
        yield client


def test_security_headers_are_present_on_every_response(app_client):
    response = app_client.get("/api/v1/health")

    for header in SecurityHeadersMiddleware.BASE_HEADERS:
        assert header in response.headers, f"missing {header}"

    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert response.headers["X-Frame-Options"] == "DENY"
    # Financial data has no business in a shared cache.
    assert response.headers["Cache-Control"] == "no-store"


def test_hsts_is_opt_in(app_client, monkeypatch):
    """Local development runs on plain HTTP; HSTS there would be unrecoverable."""
    from core.config import settings

    monkeypatch.setattr(settings, "SECURITY_HEADERS_HSTS", False)
    assert "Strict-Transport-Security" not in app_client.get("/api/v1/health").headers

    monkeypatch.setattr(settings, "SECURITY_HEADERS_HSTS", True)
    assert "Strict-Transport-Security" in app_client.get("/api/v1/health").headers


def test_every_response_carries_a_request_id(app_client):
    response = app_client.get("/api/v1/health")

    assert response.headers.get("X-Request-ID")


def test_a_client_supplied_request_id_is_echoed_for_tracing(app_client):
    response = app_client.get("/api/v1/health", headers={"X-Request-ID": "trace-abc-123"})

    assert response.headers["X-Request-ID"] == "trace-abc-123"


def test_an_oversized_client_request_id_is_truncated(app_client):
    """It is attacker-controlled text that ends up in log lines."""
    response = app_client.get("/api/v1/health", headers={"X-Request-ID": "z" * 500})

    assert len(response.headers["X-Request-ID"]) == 64


# ── Versioned and legacy surfaces ──────────────────────────────────────────


def test_the_versioned_and_legacy_health_routes_both_answer(app_client):
    """The existing frontend calls /api; the spec requires /api/v1. Both must work."""
    assert app_client.get("/api/health").status_code == 200
    assert app_client.get("/api/v1/health").status_code == 200


def test_every_legacy_route_has_a_versioned_twin():
    """
    Guards the alias mechanism itself. A router registered the old way would
    appear only under /api and quietly never reach the versioned surface.
    """
    import main

    paths = {r.path for r in main.app.routes if getattr(r, "path", "").startswith("/api")}
    versioned = {p for p in paths if p.startswith("/api/v1")}
    legacy = paths - versioned

    missing = {p for p in legacy if "/api/v1" + p[len("/api"):] not in versioned}

    assert missing == set(), f"legacy routes with no /api/v1 equivalent: {missing}"


def test_legacy_routes_announce_their_deprecation(app_client):
    response = app_client.get("/api/health")

    assert response.headers.get("Deprecation") == "true"
    assert "Sunset" in response.headers
    assert "/api/v1/health" in response.headers.get("Link", "")


def test_versioned_routes_are_not_marked_deprecated(app_client):
    assert "Deprecation" not in app_client.get("/api/v1/health").headers


# ── Rate limiting ──────────────────────────────────────────────────────────


def test_excessive_requests_are_rejected_with_a_retry_hint(monkeypatch):
    """
    The limit protects Azure as much as us: a client loop against a cost route
    burns the tenant's Cost Management quota, and the resulting throttle lands
    on every other user of that tenant.
    """
    from core.config import settings
    import main

    monkeypatch.setattr(settings, "RATE_LIMIT_ENABLED", True)
    monkeypatch.setattr(settings, "RATE_LIMIT_REQUESTS", 3)
    monkeypatch.setattr(settings, "RATE_LIMIT_WINDOW_SECONDS", 60)

    with TestClient(main.app) as client:
        headers = {"Authorization": "Bearer limited-caller-token"}
        # /api/v1/me needs auth, but the limiter runs before authentication —
        # which is the point: an unauthenticated flood must be stopped too.
        codes = [client.get("/api/v1/me", headers=headers).status_code for _ in range(5)]

    assert codes[-1] == 429, f"expected the 5th request to be limited, got {codes}"


def test_a_rate_limited_response_uses_the_standard_error_envelope(monkeypatch):
    from core.config import settings
    import main

    monkeypatch.setattr(settings, "RATE_LIMIT_ENABLED", True)
    monkeypatch.setattr(settings, "RATE_LIMIT_REQUESTS", 1)
    monkeypatch.setattr(settings, "RATE_LIMIT_WINDOW_SECONDS", 60)

    with TestClient(main.app) as client:
        headers = {"Authorization": "Bearer envelope-caller-token"}
        client.get("/api/v1/me", headers=headers)
        response = client.get("/api/v1/me", headers=headers)

    assert response.status_code == 429
    body = response.json()
    assert body["error"]["code"] == "rate_limited"
    assert body["error"]["detail"]["retry_after_seconds"] >= 1
    assert response.headers["Retry-After"]
    # Even a rejection must be traceable and defended.
    assert response.headers["X-Request-ID"]
    assert response.headers["X-Content-Type-Options"] == "nosniff"


def test_health_checks_are_exempt_from_rate_limiting(monkeypatch):
    """A liveness probe must not be able to lock the platform out of itself."""
    from core.config import settings
    import main

    monkeypatch.setattr(settings, "RATE_LIMIT_ENABLED", True)
    monkeypatch.setattr(settings, "RATE_LIMIT_REQUESTS", 2)

    with TestClient(main.app) as client:
        codes = [client.get("/api/v1/health").status_code for _ in range(6)]

    assert codes == [200] * 6


def test_separate_callers_do_not_share_a_budget(monkeypatch):
    """One noisy user must not lock out everyone behind the same office NAT."""
    from core.config import settings
    import main

    monkeypatch.setattr(settings, "RATE_LIMIT_ENABLED", True)
    monkeypatch.setattr(settings, "RATE_LIMIT_REQUESTS", 2)
    monkeypatch.setattr(settings, "RATE_LIMIT_WINDOW_SECONDS", 60)

    with TestClient(main.app) as client:
        noisy = {"Authorization": "Bearer noisy-user-token"}
        for _ in range(4):
            client.get("/api/v1/me", headers=noisy)

        quiet = client.get(
            "/api/v1/me", headers={"Authorization": "Bearer quiet-user-token"}
        )

    assert quiet.status_code != 429
