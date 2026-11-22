"""FastAPI application: webhooks, commands, approvals, SSE and live call."""

from __future__ import annotations

import asyncio
import base64
import subprocess
import uuid
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from sse_starlette.sse import EventSourceResponse

from ..config import CONFIG
from . import admin, db
from .auth import check_credentials, create_token, verify_token
from .events import BUS
from .pipeline import handle_signal, set_event_bus
from .schemas import (
    ApproveRequest,
    Command,
    CommandDetail,
    LoginRequest,
    OrderLine,
    Product,
    Signal,
    TokenResponse,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await db.connect()
    set_event_bus(BUS)
    yield
    await db.close()


app = FastAPI(title="Stockline API", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(admin.router)


def run() -> None:
    import uvicorn

    uvicorn.run("stockline_ai.api.main:app", host="0.0.0.0", port=8000)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/auth/login", response_model=TokenResponse)
async def login(payload: LoginRequest) -> TokenResponse:
    if not check_credentials(payload.username, payload.password):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    return TokenResponse(token=create_token(payload.username))


@app.get("/api/auth/me")
async def me(username: str = Depends(verify_token)) -> dict[str, str]:
    return {"username": username}


@app.post("/webhooks/whatsapp")
async def whatsapp_webhook(payload: dict[str, Any]) -> dict[str, str]:
    """Receive a Signal from whats-proxy. Answer fast, process in background."""
    capture_le = payload.get("capture_le")
    if not isinstance(capture_le, datetime):
        capture_le = datetime.now(UTC)
    signal = Signal(
        evenement_id=payload.get("evenement_id", f"evt_{uuid.uuid4().hex[:8]}"),
        capture_le=capture_le,
        canal=payload.get("canal", "texte_whatsapp"),
        actor_ref=str(payload.get("cNumber", payload.get("actor_ref", ""))),
        modality=payload.get("modality", "text"),
        texte=payload.get("texte", ""),
    )
    asyncio.create_task(handle_signal(signal))
    return {"status": "accepted"}


@app.get("/api/commands")
async def commands(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    _: str = Depends(verify_token),
) -> dict[str, Any]:
    rows = await db.fetch_commands(limit, offset)
    return {"items": [Command(**r).model_dump(mode="json") for r in rows], "total": len(rows)}


@app.get("/api/commands/{command_id}", response_model=CommandDetail)
async def command_detail(command_id: str, _: str = Depends(verify_token)) -> CommandDetail:
    row = await db.fetch_command(command_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Command not found")
    lines = await db.fetch_recent_commands(row["client_id"], 10)
    return CommandDetail(
        command=Command(**row),
        order_lines=[
            OrderLine(
                command_id=line["command_id"],
                product_id=line["product_id"],
                client_id=line["client_id"],
                recorded_at=line["recorded_at"],
                delivery_date=line["delivery_date"],
                price=float(line["price"]),
                quantity=float(line["quantity"]),
            )
            for line in lines
            if line["command_id"] == command_id
        ],
    )


@app.post("/api/commands/{command_id}/approve")
async def approve_command(
    command_id: str, payload: ApproveRequest, _: str = Depends(verify_token)
) -> dict[str, Any]:
    status_value = "processed" if payload.approve else "rejected"
    updated = await db.set_command_status(command_id, status_value)
    if not updated:
        raise HTTPException(status_code=404, detail="Command not found")
    await BUS.publish({"type": "command.decided", "command_id": command_id, "status": status_value})
    return {"command_id": command_id, "status": status_value}


@app.get("/api/commands/stream")
async def command_stream(_: str = Depends(verify_token)) -> EventSourceResponse:
    return EventSourceResponse(BUS.stream())


@app.get("/api/clients/{client_id}/stats")
async def client_stats(client_id: str, _: str = Depends(verify_token)) -> dict[str, Any]:
    return await db.fetch_client_stats(client_id)


@app.get("/api/products", response_model=list[Product])
async def products(_: str = Depends(verify_token)) -> list[Product]:
    return [Product(**row) for row in await db.fetch_products()]


@app.get("/api/clients")
async def clients(_: str = Depends(verify_token)) -> dict[str, Any]:
    rows = await db.pool().fetch(
        "SELECT client_id, phone_number, client_name FROM client ORDER BY client_id"
    )
    return {"items": [dict(r) for r in rows]}


@app.get("/api/purchases")
async def purchases(_: str = Depends(verify_token)) -> dict[str, Any]:
    return {"items": []}


@app.post("/api/purchases/{purchase_id}/approve")
async def approve_purchase(
    purchase_id: str, payload: ApproveRequest, _: str = Depends(verify_token)
) -> dict[str, Any]:
    return {"purchase_id": purchase_id, "approved": payload.approve}


@app.post("/api/calls")
async def start_call(_: str = Depends(verify_token)) -> dict[str, str]:
    call_id = uuid.uuid4().hex[:12]
    await BUS.publish({"type": "call.started", "call_id": call_id})
    return {"call_id": call_id}


@app.websocket("/ws/call/{call_id}")
async def call_socket(websocket: WebSocket, call_id: str) -> None:
    await websocket.accept()
    transcript: list[str] = []
    try:
        while True:
            message = await websocket.receive_json()
            if message.get("type") == "audio":
                raw = base64.b64decode(message.get("data", ""))
                tmp = Path("/tmp") / f"call_{call_id}_{len(transcript)}.wav"
                tmp.write_bytes(raw)
                try:
                    text = subprocess.run(
                        [
                            CONFIG.bin_for("stt") or "whisper-cli",
                            "-m",
                            str(CONFIG.stt_models_dir / CONFIG.model_for("stt")),
                            "-f",
                            str(tmp),
                            "-nt",
                        ],
                        capture_output=True,
                        text=True,
                        timeout=30,
                    ).stdout.strip()
                except (OSError, subprocess.SubprocessError):
                    text = ""
                transcript.append(text)
                await websocket.send_json({"type": "transcript", "text": text, "call_id": call_id})
    except WebSocketDisconnect:
        return
