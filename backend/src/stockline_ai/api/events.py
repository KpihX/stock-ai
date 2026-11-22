"""In-memory event bus for SSE. One API process, bounded queue per subscriber."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator


class EventBus:
    def __init__(self, maxsize: int = 100) -> None:
        self._subscribers: set[asyncio.Queue[str]] = set()

    async def publish(self, event: dict) -> None:
        payload = json.dumps(event, ensure_ascii=False, default=str)
        for queue in tuple(self._subscribers):
            if queue.full():
                queue.get_nowait()
            queue.put_nowait(payload)

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
