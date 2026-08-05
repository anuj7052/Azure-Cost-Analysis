from __future__ import annotations

from fastapi import HTTPException, status


class AppError(HTTPException):
    """Base application error carrying a stable machine-readable code."""

    status_code = status.HTTP_500_INTERNAL_SERVER_ERROR
    code = "internal_error"
    message = "An unexpected error occurred."

    def __init__(self, message: str | None = None, **extra: object) -> None:
        super().__init__(
            status_code=self.status_code,
            detail={
                "code": self.code,
                "message": message or self.message,
                **({"context": extra} if extra else {}),
            },
        )


class NotFoundError(AppError):
    status_code = status.HTTP_404_NOT_FOUND
    code = "not_found"
    message = "Resource not found."


class ForbiddenError(AppError):
    status_code = status.HTTP_403_FORBIDDEN
    code = "forbidden"
    message = "You do not have permission to perform this action."


class UnauthorizedError(AppError):
    status_code = status.HTTP_401_UNAUTHORIZED
    code = "unauthorized"
    message = "Authentication required."


class ValidationError(AppError):
    status_code = status.HTTP_422_UNPROCESSABLE_ENTITY
    code = "validation_error"
    message = "Request payload is invalid."


class ConflictError(AppError):
    status_code = status.HTTP_409_CONFLICT
    code = "conflict"
    message = "Resource already exists."


class AzureIntegrationError(AppError):
    status_code = status.HTTP_502_BAD_GATEWAY
    code = "azure_integration_error"
    message = "Azure API call failed."


class RateLimitedError(AppError):
    status_code = status.HTTP_429_TOO_MANY_REQUESTS
    code = "rate_limited"
    message = "Too many requests."
