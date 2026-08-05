from __future__ import annotations

import os

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
os.environ.setdefault("AZURE_CLIENT_ID", "test-client")
os.environ.setdefault("API_AUDIENCE", "api://test-client")

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.db import Base
from app import models  # noqa: F401  (registers tables)

TENANT_A = "11111111-1111-1111-1111-111111111111"
TENANT_B = "22222222-2222-2222-2222-222222222222"


@pytest_asyncio.fixture
async def session() -> AsyncSession:
    """In-memory database per test.

    JSONB/Numeric columns degrade gracefully on SQLite for the pure-logic tests;
    Postgres-specific behaviour is covered by the integration suite.
    """
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with maker() as db:
        yield db
    await engine.dispose()


@pytest.fixture
def tenant_a() -> str:
    return TENANT_A


@pytest.fixture
def tenant_b() -> str:
    return TENANT_B
