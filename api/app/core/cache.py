from __future__ import annotations

import logging

from redis.asyncio import Redis

from app.core.config import settings

log = logging.getLogger(__name__)


class RateLimiter:
    """Fixed-window per-key limiter backed by Redis."""

    def __init__(self, redis: Redis, limit: int, window_seconds: int = 3600) -> None:
        self.redis = redis
        self.limit = limit
        self.window = window_seconds

    async def allow(self, key: str) -> bool:
        try:
            count = await self.redis.incr(key)
            if count == 1:
                await self.redis.expire(key, self.window)
            return count <= self.limit
        except Exception:  # noqa: BLE001 - never fail closed on cache outage
            log.warning("rate limiter unavailable, allowing request")
            return True


def create_redis() -> Redis:
    return Redis.from_url(settings.REDIS_URL, decode_responses=True)
