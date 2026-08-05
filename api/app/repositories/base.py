from __future__ import annotations

from typing import Any, Generic, Iterable, Sequence, TypeVar

from sqlalchemy import Select, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import NotFoundError
from app.models.base import BaseEntity

ModelT = TypeVar("ModelT", bound=BaseEntity)


class TenantRepository(Generic[ModelT]):
    """Base repository. Every query is bound to a single tenant.

    Callers cannot construct a cross-tenant query through this class: the
    tenant filter is applied inside `_base_select` and on every write path.

    An optional `subscription_id` narrows reads further. It is applied only to
    models that actually carry the column, so the same scope object can be
    handed to every repository without the caller checking first.
    """

    model: type[ModelT]

    def __init__(
        self,
        session: AsyncSession,
        tenant_id: str,
        *,
        subscription_id: str | None = None,
    ) -> None:
        if not tenant_id:
            raise ValueError("tenant_id is required for tenant-scoped repositories")
        self.session = session
        self.tenant_id = tenant_id
        self.subscription_id = subscription_id or None

    # --- reads -------------------------------------------------------
    def _scope(self) -> list[Any]:
        """Mandatory tenant filter plus the optional subscription filter."""
        filters: list[Any] = [self.model.tenant_id == self.tenant_id]
        column = getattr(self.model, "subscription_id", None)
        if self.subscription_id and column is not None:
            filters.append(column == self.subscription_id)
        return filters

    def _base_select(self) -> Select:
        return select(self.model).where(*self._scope())

    async def list(
        self,
        *,
        limit: int = 50,
        offset: int = 0,
        order_by: Any | None = None,
        filters: Iterable[Any] = (),
    ) -> Sequence[ModelT]:
        stmt = self._base_select()
        for f in filters:
            stmt = stmt.where(f)
        if order_by is not None:
            stmt = stmt.order_by(order_by)
        stmt = stmt.limit(min(limit, 500)).offset(max(offset, 0))
        return (await self.session.execute(stmt)).scalars().all()

    async def count(self, filters: Iterable[Any] = ()) -> int:
        stmt = select(func.count()).select_from(self.model).where(*self._scope())
        for f in filters:
            stmt = stmt.where(f)
        return int((await self.session.execute(stmt)).scalar_one())

    async def get(self, entity_id) -> ModelT | None:
        stmt = self._base_select().where(self.model.id == entity_id)
        return (await self.session.execute(stmt)).scalar_one_or_none()

    async def get_or_404(self, entity_id) -> ModelT:
        entity = await self.get(entity_id)
        if entity is None:
            raise NotFoundError(f"{self.model.__name__} not found.")
        return entity

    async def find_one(self, *filters: Any) -> ModelT | None:
        stmt = self._base_select()
        for f in filters:
            stmt = stmt.where(f)
        return (await self.session.execute(stmt.limit(1))).scalar_one_or_none()

    # --- writes ------------------------------------------------------
    async def add(self, **values: Any) -> ModelT:
        entity = self.model(tenant_id=self.tenant_id, **values)
        self.session.add(entity)
        await self.session.flush()
        return entity

    async def upsert_many(
        self, rows: list[dict[str, Any]], *, conflict_columns: list[str]
    ) -> int:
        """Idempotent bulk upsert used by every sync job."""
        if not rows:
            return 0
        payload = [{**row, "tenant_id": self.tenant_id} for row in rows]
        # Postgres raises CardinalityViolation if a single ON CONFLICT statement
        # touches the same key twice, and Azure APIs do return repeated grains
        # (e.g. the same meter split across billing periods). Keep the last one.
        deduped: dict[tuple, dict[str, Any]] = {}
        for row in payload:
            deduped[tuple(row.get(c) for c in conflict_columns)] = row
        payload = list(deduped.values())
        update_cols = {
            c.name: c
            for c in self.model.__table__.columns
            if c.name not in {*conflict_columns, "id", "created_at", "tenant_id"}
        }
        stmt = pg_insert(self.model).values(payload)
        stmt = stmt.on_conflict_do_update(
            index_elements=conflict_columns,
            set_={k: getattr(stmt.excluded, k) for k in update_cols},
        )
        await self.session.execute(stmt)
        return len(payload)

    async def delete(self, entity: ModelT) -> None:
        if entity.tenant_id != self.tenant_id:
            raise NotFoundError("Entity does not belong to this tenant.")
        await self.session.delete(entity)
