"""HTTP client for the embedded WhatsApp listener.

The listener is a small TypeScript package under backend/wa/. It owns the
Baileys protocol and posts inbound Signals to our FastAPI webhook. This module
only sends acknowledgements back to it. No external binary is invoked.
"""

from __future__ import annotations

import os
from typing import Any

import httpx


def _base_url() -> str:
    return os.environ.get("STOCKLINE_WA_URL", "http://localhost:3001")


async def send_ack(jid: str, text: str) -> dict[str, Any]:
    """Send an acknowledgement through the embedded WhatsApp listener."""
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(
            f"{_base_url()}/send",
            json={"jid": jid, "text": text},
        )
        response.raise_for_status()
        return dict(response.json())


async def health() -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=5.0) as client:
        response = await client.get(f"{_base_url()}/health")
        response.raise_for_status()
        return dict(response.json())
