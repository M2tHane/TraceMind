"""Async PostgreSQL session ownership and monotonic snowflake IDs."""
import secrets
import threading
import time
from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.config import settings

engine = create_async_engine(settings.database_url, pool_pre_ping=True, pool_size=8, max_overflow=4)
Session = async_sessionmaker(engine, expire_on_commit=False)
_lock = threading.Lock()
_node = secrets.randbelow(1024)
_last_ms = 0
_sequence = 0


def generate_id() -> int:
    global _last_ms, _sequence
    with _lock:
        now = max(int(time.time() * 1000), _last_ms)
        _sequence = (_sequence + 1) if now == _last_ms else 0
        if _sequence >= 4096:
            now += 1
            _sequence = 0
        _last_ms = now
        return ((now - 1704067200000) << 22) | (_node << 12) | _sequence


async def get_db() -> AsyncIterator[AsyncSession]:
    async with Session() as db:
        try:
            yield db
            await db.commit()
        except Exception:
            await db.rollback()
            raise
