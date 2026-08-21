"""
Failures must never be reported as zero.

This is the specification's most important correctness rule (§46, §77) and the
one with the worst failure mode. Every other bug shows the user something wrong;
this one shows them something *plausible*. A cost page that renders ₹0 because
Azure returned 429 does not look broken — it looks like spending stopped, and
somebody makes a decision on it.

The rule, stated precisely:

    throttled            is not 0
    permission required  is not 0
    unavailable          is not 0
    unpriced (null)      is not 0
    removed              is not deleted

Each is pinned below.
"""
from __future__ import annotations

import pytest

from core.errors import (
    ApiError,
    AzurePermissionRequired,
    AzureThrottled,
    AzureUnavailable,
    DataState,
    ErrorCode,
    INCONCLUSIVE_STATES,
    error_body,
    is_inconclusive,
)


# ── The states that carry no value ─────────────────────────────────────────


@pytest.mark.parametrize(
    "state",
    [
        DataState.UNAVAILABLE,
        DataState.PERMISSION_REQUIRED,
        DataState.THROTTLED,
        DataState.UNKNOWN,
    ],
)
def test_failure_states_are_inconclusive(state):
    """These four mean 'we do not know'. Rendering a number for them is a bug."""
    assert is_inconclusive(state)
    assert state in INCONCLUSIVE_STATES


@pytest.mark.parametrize(
    "state",
    [DataState.CONFIRMED, DataState.ESTIMATED, DataState.STALE, DataState.HISTORICAL],
)
def test_value_bearing_states_are_conclusive(state):
    """
    The counterpart. `stale` and `historical` do carry a real number — they say
    *when* it was true, not that it is unknown.
    """
    assert not is_inconclusive(state)


def test_zero_is_not_a_data_state():
    """
    A guard against the shortcut this whole module exists to prevent: reaching
    for 0 as a stand-in for 'no data'.
    """
    with pytest.raises(ValueError):
        DataState(0)


# ── Azure failures ─────────────────────────────────────────────────────────


def test_throttling_is_reported_as_throttled_not_zero():
    """HTTP 429 from Cost Management must surface as a throttle, with a retry."""
    error = AzureThrottled(retry_after_seconds=14)

    assert error.status_code == 429
    assert error.code is ErrorCode.AZURE_THROTTLED
    assert error.error_detail["data_state"] == DataState.THROTTLED.value
    assert error.error_detail["retry_after_seconds"] == 14
    assert error.headers["Retry-After"] == "14"
    # The message must not imply an amount.
    assert "0" not in error.message.replace("account", "")


def test_missing_permission_is_reported_as_permission_required_not_empty():
    """
    403 must not become 'no resources found'.

    Telling a user their estate is clean when we were simply refused the read is
    the security-relevant version of this bug.
    """
    error = AzurePermissionRequired(required_role="Cost Management Reader", scope="/subscriptions/s1")

    assert error.status_code == 403
    assert error.code is ErrorCode.AZURE_PERMISSION_REQUIRED
    assert error.error_detail["data_state"] == DataState.PERMISSION_REQUIRED.value
    assert error.error_detail["required_role"] == "Cost Management Reader"
    assert "no conclusion" in error.message.lower()


def test_azure_outage_is_reported_as_unavailable_not_zero():
    error = AzureUnavailable(reason="connect timeout")

    assert error.status_code == 502
    assert error.code is ErrorCode.AZURE_UNAVAILABLE
    assert error.error_detail["data_state"] == DataState.UNAVAILABLE.value
    assert "unknown" in error.message.lower()


@pytest.mark.parametrize(
    "error",
    [
        AzureThrottled(retry_after_seconds=5),
        AzurePermissionRequired(required_role="Reader"),
        AzureUnavailable(reason="boom"),
    ],
)
def test_no_azure_failure_carries_a_numeric_value(error):
    """None of the failure payloads may contain a cost-shaped field."""
    forbidden = {"cost", "amount", "total", "value", "spend"}
    assert not (forbidden & set(error.error_detail)), (
        "a failure payload must not carry a value field, since any value there "
        "would be rendered as an amount"
    )


# ── The error envelope ─────────────────────────────────────────────────────


def test_every_error_uses_the_same_envelope():
    body = error_body(ErrorCode.AZURE_THROTTLED, "Slow down.", "req-1", {"retry_after_seconds": 3})

    assert set(body) == {"error"}
    assert set(body["error"]) == {"code", "message", "detail", "request_id"}
    assert body["error"]["code"] == "azure_throttled"
    assert body["error"]["request_id"] == "req-1"


def test_error_codes_are_stable_strings():
    """
    The frontend switches on these. Renaming one silently changes behaviour in
    a component nobody edited, so the wire values are pinned here.
    """
    assert ErrorCode.UNAUTHENTICATED.value == "unauthenticated"
    assert ErrorCode.FORBIDDEN.value == "forbidden"
    assert ErrorCode.NOT_FOUND.value == "not_found"
    assert ErrorCode.VALIDATION_FAILED.value == "validation_failed"
    assert ErrorCode.RATE_LIMITED.value == "rate_limited"
    assert ErrorCode.AZURE_THROTTLED.value == "azure_throttled"
    assert ErrorCode.AZURE_PERMISSION_REQUIRED.value == "azure_permission_required"
    assert ErrorCode.AZURE_UNAVAILABLE.value == "azure_unavailable"
    assert ErrorCode.PLAN_LIMIT_REACHED.value == "plan_limit_reached"
    assert ErrorCode.INTERNAL_ERROR.value == "internal_error"


def test_data_states_are_stable_strings():
    assert DataState.CONFIRMED.value == "confirmed"
    assert DataState.ESTIMATED.value == "estimated"
    assert DataState.STALE.value == "stale"
    assert DataState.HISTORICAL.value == "historical"
    assert DataState.UNAVAILABLE.value == "unavailable"
    assert DataState.PERMISSION_REQUIRED.value == "permission_required"
    assert DataState.THROTTLED.value == "throttled"
    assert DataState.UNKNOWN.value == "unknown"


def test_api_error_remains_an_http_exception():
    """
    Existing routers raise plain HTTPException. ApiError has to stay compatible
    with that so the two can coexist while call sites migrate one at a time.
    """
    from fastapi import HTTPException

    error = ApiError(418, ErrorCode.INTERNAL_ERROR, "teapot")
    assert isinstance(error, HTTPException)
    assert error.detail == "teapot"


# ── The existing rate-limit path ───────────────────────────────────────────


def test_cost_client_raises_rather_than_returning_zero():
    """
    The pre-existing throttle guard is the reference behaviour this module
    generalises. It raises; it does not return an empty result set that would
    total to zero.
    """
    from services.cost_client import RateLimited

    error = RateLimited(retry_in=8)

    assert error.retry_in == 8
    assert isinstance(error, RuntimeError)
    assert "rate limiting" in str(error).lower()
