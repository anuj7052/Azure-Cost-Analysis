"""
Translating Azure failures into something actionable.

The failure this prevents is a user staring at "502" with no idea whether the
problem is their token, their permissions, or Azure being busy — three
situations with three completely different next steps.
"""
import httpx
import pytest

from services.azure_errors import azure_error


def http_error(status: int, headers: dict | None = None) -> httpx.HTTPStatusError:
    request = httpx.Request("POST", "https://management.azure.com/x")
    response = httpx.Response(status, headers=headers or {}, request=request)
    return httpx.HTTPStatusError("upstream failed", request=request, response=response)


class TestExpiredToken:
    def test_a_401_is_reported_as_authentication_not_a_gateway_failure(self):
        """
        Reporting 502 meant the frontend never cleared its cached token, so
        every following request replayed the same dead credential.
        """
        exc = azure_error(http_error(401))
        assert exc.status_code == 401

    def test_it_names_expiry_rather_than_just_saying_unauthorized(self):
        # "Unauthorized" sends people to check role assignments that were never
        # the problem; after an hour the token has simply expired.
        assert "expired" in azure_error(http_error(401)).detail.lower()


class TestPermissions:
    def test_a_403_names_the_role_that_is_missing(self):
        detail = azure_error(http_error(403)).detail
        assert "Reader" in detail

    def test_a_403_is_not_confused_with_an_expired_token(self):
        # These need opposite actions: one is sign in again, the other is ask
        # an administrator for access.
        assert azure_error(http_error(403)).status_code == 403


class TestThrottling:
    def test_a_429_keeps_its_status_so_the_retry_notice_fires(self):
        assert azure_error(http_error(429)).status_code == 429

    def test_the_retry_delay_is_passed_on_when_azure_supplies_it(self):
        # Guessing the wait re-triggers the limit; Azure states the real number.
        detail = azure_error(http_error(429, {"retry-after": "47"})).detail
        assert "47" in detail

    def test_a_missing_retry_header_still_produces_a_usable_message(self):
        assert "rate limiting" in azure_error(http_error(429)).detail


class TestNetwork:
    def test_a_timeout_is_a_gateway_timeout_not_a_bad_gateway(self):
        request = httpx.Request("POST", "https://management.azure.com/x")
        exc = azure_error(httpx.ReadTimeout("timed out", request=request))
        assert exc.status_code == 504


class TestUnexpected:
    def test_an_unknown_failure_keeps_its_reason(self):
        # The first line of an unexpected error is usually the clue.
        detail = azure_error(RuntimeError("something specific broke")).detail
        assert "something specific broke" in detail

    def test_a_long_reason_is_truncated_rather_than_flooding_a_toast(self):
        detail = azure_error(RuntimeError("x" * 500)).detail
        assert len(detail) < 300

    def test_the_subject_of_the_failure_is_named(self):
        detail = azure_error(RuntimeError("boom"), "your resources").detail
        assert "your resources" in detail
