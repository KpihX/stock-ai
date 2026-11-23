"""In-memory event bus for SSE. One API process, bounded queue per subscriber."""

from __future__ import annotations

import asyncio
import json
from collections import deque
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import Any


class EventBus:
    def __init__(self, maxsize: int = 100) -> None:
        self._subscribers: set[asyncio.Queue[str]] = set()
        self._history: deque[dict[str, Any]] = deque(maxlen=200)

    async def publish(self, event: dict[str, Any]) -> None:
        enriched = {"ts": datetime.now(UTC).isoformat(), **event}
        self._history.appendleft(enriched)
        payload = json.dumps(enriched, ensure_ascii=False, default=str)
        for queue in tuple(self._subscribers):
            if queue.full():
                queue.get_nowait()
            queue.put_nowait(payload)

    def history(self, limit: int = 100) -> list[dict[str, Any]]:
        return list(self._history)[:limit]

    def subscribe(self) -> asyncio.Queue[str]:
        queue: asyncio.Queue[str] = asyncio.Queue(maxsize=100)
        self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue[str]) -> None:
        self._subscribers.discard(queue)

    async def stream(self) -> AsyncIterator[str]:
        queue = self.subscribe()
        try:
            while True:
                payload = await queue.get()
                yield f"event: message\ndata: {payload}\n\n"
        finally:
            self.unsubscribe(queue)


BUS = EventBus()
