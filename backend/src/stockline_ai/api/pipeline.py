"""CommandHandler and the ingestion pipeline from Signal to NormalizedInput."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from . import db
from .llm import normalize
from .schemas import ClientStats, EnrichedData, Signal

_event_bus: Any = None


def set_event_bus(bus: Any) -> None:
    global _event_bus
    _event_bus = bus


async def publish(event: dict[str, Any]) -> None:
    if _event_bus is not None:
        await _event_bus.publish(event)


async def run_tool(name: str, args: dict[str, Any]) -> dict[str, Any]:
    """Only read-only operations are exposed to the model."""
    client_id = str(args.get("client_id", ""))
    if name == "lookup_client_stats":
        return await db.fetch_client_stats(client_id)
    if name == "lookup_commands":
        return {"commands": await db.fetch_recent_commands(client_id, int(args.get("limit", 5)))}
    raise ValueError(f"Unknown tool: {name}")


async def handle_signal(signal: Signal) -> dict[str, Any]:
    """The CommandHandler: enrich the Data with client id and client stats."""
    client = await db.fetch_client_by_phone(signal.actor_ref)
    if client is None:
        await publish(
            {"type": "command.rejected", "reason": "unknown_client", "signal": signal.model_dump()}
        )
        return {"status": "rejected", "reason": "unknown_client"}

    stats = await db.fetch_client_stats(client["client_id"])
    enriched = EnrichedData(
        client_id=client["client_id"],
        cNumber=signal.actor_ref,
        client_stats=ClientStats(
            client_id=client["client_id"],
            client_name=client["client_name"],
            phone_number=client["phone_number"],
            order_count=int(stats["order_count"]),
            usual_lines=[],
        ),
        signal=signal,
    )
    await publish({"type": "command.enriched", "data": enriched.model_dump(mode="json")})

    normalized = await normalize(
        enriched.model_dump(mode="json"),
        run_tool,
    )
    await publish({"type": "command.normalized", "data": normalized})

    lines = normalized.get("order_lines", [])
    recorded_at = datetime.now(UTC).isoformat()
    command_id = f"C-{uuid.uuid4().hex[:8]}"
    for index, line in enumerate(lines):
        await db.insert_command(
            {
                "command_id": f"{command_id}-{index + 1}" if len(lines) > 1 else command_id,
                "client_id": client["client_id"],
                "recorded_at": line.get("recorded_at") or recorded_at,
                "delivery_date": line.get("delivery_date") or recorded_at[:10],
                "product_id": line.get("product_id", ""),
                "price": float(line.get("price", 0)),
                "quantity": float(line.get("quantity", 0)),
                "status": "new",
                "summary": normalized.get("summary", ""),
            }
        )
    await publish({"type": "command.created", "command_id": command_id, "lines": len(lines)})
    return {"status": "ok", "command_id": command_id, "normalized_input": normalized}
