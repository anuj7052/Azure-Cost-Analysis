"""
One shape for every failure, and one vocabulary for describing incomplete data.

Two rules drive this module, both from the specification:

  - An error must never become a number. If Azure throttles us, refuses us, or
    falls over, the answer is "throttled" / "permission required" /
    "unavailable" — never zero. A zero is a *claim about money*, and a wrong one
    sends somebody chasing a cost drop that never happened.

  - Every failure looks the same to the caller, so the frontend can render one
    error component instead of guessing at a dozen ad-hoc payload shapes.
"""
from __future__ import annotations

from enum import Enum
from typing import Any, Dict, Optional

from fastapi import HTTPException, Request, status
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse


class ErrorCode(str, Enum):
    """Stable, machine-readable causes. The frontend switches on these."""

    UNAUTHENTICATED = "unauthenticated"
    FORBIDDEN = "forbidden"
    NOT_FOUND = "not_found"
    VALIDATION_FAILED = "validation_failed"
    RATE_LIMITED = "rate_limited"
    AZURE_THROTTLED = "azure_throttled"
    AZURE_PERMISSION_REQUIRED = "azure_permission_required"
    AZURE_UNAVAILABLE = "azure_unavailable"
    PLAN_LIMIT_REACHED = "plan_limit_reached"
    INTERNAL_ERROR = "internal_error"


class DataState(str, Enum):
    """
    How much a returned value can be trusted.

    Attached to every figure the platform reports. The three failure states are
    the point of the whole enum: they exist so a missing answer can be said out
    loud instead of being rounded down to zero.
    """

    CONFIRMED = "confirmed"            # read from the source, complete
    ESTIMATED = "estimated"            # derived or modelled, clearly not billed fact
    STALE = "stale"                    # last known good, source unreachable now
    HISTORICAL = "historical"          # from a snapshot, not from Azure now
    UNAVAILABLE = "unavailable"        # source failed; value unknown
    PERMISSION_REQUIRED = "permission_required"  # we were refused; value unknown
    THROTTLED = "throttled"            # source rate limited us; value unknown
    UNKNOWN = "unknown"                # state could not be determined


#: States where no value exists. Serialising any of these as a number is a bug.
INCONCLUSIVE_STATES = frozenset({
    DataState.UNAVAILABLE,
    DataState.PERMISSION_REQUIRED,
    DataState.THROTTLED,
    DataState.UNKNOWN,
})


def is_inconclusive(state: DataState | str) -> bool:
    try:
        return DataState(state) in INCONCLUSIVE_STATES
    except ValueError:
        return False


class ApiError(HTTPException):
    """
    An application failure with a stable code attached.

    Subclasses HTTPException so existing `raise HTTPException(...)` call sites
    keep working untouched and can be migrated one at a time.
    """

    def __init__(
        self,
        status_code: int,
        code: ErrorCode,
        message: str,
        detail: Optional[Dict[str, Any]] = None,
        headers: Optional[Dict[str, str]] = None,
    ):
        self.code = code
        self.message = message
        self.error_detail = detail or {}
        super().__init__(status_code=status_code, detail=message, headers=headers)


class AzureThrottled(ApiError):
    """Azure is rate limiting this tenant. Explicitly not a zero-cost answer."""

    def __init__(self, retry_after_seconds: int, source: str = "azure"):
        super().__init__(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            code=ErrorCode.AZURE_THROTTLED,
            message=(
                "Azure is rate limiting this account, so the value could not be "
                "read. This is not a zero — retry shortly."
            ),
            detail={
                "retry_after_seconds": retry_after_seconds,
                "source": source,
                "data_state": DataState.THROTTLED.value,
            },
            headers={"Retry-After": str(retry_after_seconds)},
        )


class AzurePermissionRequired(ApiError):
    """
    A read was refused. The caller must be told the difference between
    "you cannot see this" and "there is nothing here".
    """

    def __init__(self, required_role: str, scope: str = "", source: str = "azure"):
        super().__init__(
            status_code=status.HTTP_403_FORBIDDEN,
            code=ErrorCode.AZURE_PERMISSION_REQUIRED,
            message=(
                f"Azure refused this read. It needs the '{required_role}' role. "
                "No conclusion can be drawn about the data until access is granted."
            ),
            detail={
                "required_role": required_role,
                "scope": scope,
                "source": source,
                "data_state": DataState.PERMISSION_REQUIRED.value,
            },
        )


class AzureUnavailable(ApiError):
    """Azure failed or timed out. The value is unknown, not zero."""

    def __init__(self, reason: str = "", source: str = "azure"):
        super().__init__(
            status_code=status.HTTP_502_BAD_GATEWAY,
            code=ErrorCode.AZURE_UNAVAILABLE,
            message="Azure could not be reached, so the value is unknown.",
            detail={
                "reason": reason,
                "source": source,
                "data_state": DataState.UNAVAILABLE.value,
            },
        )


def error_body(
    code: ErrorCode | str,
    message: str,
    request_id: str = "",
    detail: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """The single error envelope. Every failure response uses this shape."""
    return {
        "error": {
            "code": code.value if isinstance(code, ErrorCode) else str(code),
            "message": message,
            "detail": detail or {},
            "request_id": request_id,
        }
    }


_STATUS_TO_CODE = {
    400: ErrorCode.VALIDATION_FAILED,
    401: ErrorCode.UNAUTHENTICATED,
    403: ErrorCode.FORBIDDEN,
    404: ErrorCode.NOT_FOUND,
    422: ErrorCode.VALIDATION_FAILED,
    429: ErrorCode.RATE_LIMITED,
    502: ErrorCode.AZURE_UNAVAILABLE,
}


def _request_id(request: Request) -> str:
    return getattr(request.state, "request_id", "")


async def api_error_handler(request: Request, exc: ApiError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content=error_body(exc.code, exc.message, _request_id(request), exc.error_detail),
        headers=exc.headers or {},
    )


async def http_exception_handler(request: Request, exc: HTTPException) -> JSONResponse:
    """
    Wraps the plain HTTPExceptions raised throughout the existing routers.

    The original `detail` is preserved verbatim as the message so no current
    behaviour or wording changes — only the surrounding envelope is added.
    """
    code = _STATUS_TO_CODE.get(exc.status_code, ErrorCode.INTERNAL_ERROR)
    message = exc.detail if isinstance(exc.detail, str) else "Request failed."
    detail = {} if isinstance(exc.detail, str) else {"detail": jsonable_encoder(exc.detail)}

    return JSONResponse(
        status_code=exc.status_code,
        content=error_body(code, message, _request_id(request), detail),
        headers=exc.headers or {},
    )


async def validation_exception_handler(
    request: Request, exc: RequestValidationError
) -> JSONResponse:
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content=error_body(
            ErrorCode.VALIDATION_FAILED,
            "The request could not be validated.",
            _request_id(request),
            {"errors": jsonable_encoder(exc.errors())},
        ),
    )


async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """
    Last resort.

    The exception text is deliberately withheld: it is the most common way for
    connection strings, file paths and query fragments to reach a browser. The
    request id is the bridge to the log line that does have the detail.
    """
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content=error_body(
            ErrorCode.INTERNAL_ERROR,
            "Something went wrong handling this request.",
            _request_id(request),
        ),
    )
