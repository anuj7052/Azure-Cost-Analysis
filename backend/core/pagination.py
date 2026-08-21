"""
One pagination contract for every list the API returns.

Unbounded lists are a correctness problem before they are a performance one:
an estate with 100,000 resources returns a payload no browser will render, and
the user sees a spinner rather than an answer. Every list therefore states its
own limit and whether more exists, so "showing 200 of 4,318" can be said out
loud instead of silently truncating.
"""
from __future__ import annotations

from typing import Generic, List, Optional, Sequence, TypeVar

from fastapi import Query
from pydantic import BaseModel, Field

T = TypeVar("T")

DEFAULT_LIMIT = 50
MAX_LIMIT = 500


class PageInfo(BaseModel):
    """Where this window sits in the full result set."""

    limit: int = DEFAULT_LIMIT
    offset: int = 0
    #: Total matching rows when it is cheap to know; None when counting the
    #: whole set would cost a second full scan. None means "unknown", never 0.
    total: Optional[int] = None
    has_more: bool = False
    next_offset: Optional[int] = None


class PageParams(BaseModel):
    """Validated paging inputs, resolved from query parameters."""

    limit: int = Field(DEFAULT_LIMIT, ge=1, le=MAX_LIMIT)
    offset: int = Field(0, ge=0)


def page_params(
    limit: int = Query(DEFAULT_LIMIT, ge=1, le=MAX_LIMIT, description="Rows per page"),
    offset: int = Query(0, ge=0, description="Rows to skip"),
) -> PageParams:
    """FastAPI dependency so paging is declared identically on every route."""
    return PageParams(limit=limit, offset=offset)


class Page(BaseModel, Generic[T]):
    """The standard list envelope for new endpoints."""

    items: List[T] = []
    page: PageInfo = PageInfo()


def build_page_info(
    rows: Sequence,
    params: PageParams,
    total: Optional[int] = None,
) -> tuple[list, PageInfo]:
    """
    Trim an over-fetched window and describe it.

    `rows` is expected to hold up to `limit + 1` items: fetching one extra row
    is how `has_more` is known without a second COUNT query over the same
    predicate, which on a snapshot table is the expensive half of the request.
    """
    has_more = len(rows) > params.limit
    window = list(rows[: params.limit])

    return window, PageInfo(
        limit=params.limit,
        offset=params.offset,
        total=total,
        has_more=has_more,
        next_offset=(params.offset + params.limit) if has_more else None,
    )
