"""FastAPI application: webhooks, commands, approvals, SSE and live call."""

from __future__ import annotations

import asyncio
import base64
import uuid
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated, Any

from fastapi import Depends, FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from sse_starlette.sse import EventSourceResponse

from ..config import validate_startup
from . import admin, calls, db, stt, whats
from .auth import check_credentials, create_token, get_claims, verify_token
from .events import BUS
from .pipeline import handle_signal, publish, set_event_bus
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
    validate_startup()
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
app.include_router(calls.router)


def run() -> None:
    import uvicorn

    uvicorn.run("stockline_ai.api.main:app", host="0.0.0.0", port=8000)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/auth/login", response_model=TokenResponse)
async def login(payload: LoginRequest) -> TokenResponse:
    role = await check_credentials(payload.username, payload.password)
    if not role:
        raise HTTPException(status_code=401, detail="Invalid credentials")
    return TokenResponse(token=create_token(payload.username, role), role=role)


@app.get("/api/auth/me")
async def me(claims: Annotated[dict[str, str], Depends(get_claims)]) -> dict[str, str]:
    return {"username": claims["username"], "role": claims["role"]}


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
        cNumber=str(payload.get("cNumber", "")),
        message_id=str(payload.get("message_id", "")),
        media_path=str(payload.get("media_path", "")),
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


@app.get("/api/commands/stream")
async def command_stream(_: str = Depends(verify_token)) -> EventSourceResponse:
    return EventSourceResponse(BUS.stream())


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
    command_id: str, payload: ApproveRequest, actor: str = Depends(verify_token)
) -> dict[str, Any]:
    row = await db.fetch_command(command_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Command not found")
    status_value = "processed" if payload.approve else "rejected"
    comment = payload.comment.strip()
    prev_status = str(row.get("status") or "")
    if prev_status == status_value:
        return {
            "command_id": command_id,
            "status": status_value,
            "comment": str(row.get("decision_comment") or comment),
            "decided_by": str(row.get("decided_by") or actor),
            "wa_sent": False,
            "wa_error": "",
        }
    updated = await db.set_command_status(command_id, status_value, comment=comment, actor=actor)
    if not updated:
        raise HTTPException(status_code=404, detail="Command not found")

    product_id = str(row.get("product_id") or "")
    qty = float(row.get("quantity") or 0)
    new_stock: float | None = None
    if product_id and qty > 0:
        if payload.approve and prev_status != "processed":
            new_stock = await db.adjust_stock(product_id, -qty)
        elif not payload.approve and prev_status == "processed":
            new_stock = await db.adjust_stock(product_id, qty)

    phone = str(row.get("client_phone") or "")
    client_name = str(row.get("client_name") or row.get("client_id") or "")
    product_label = str(row.get("product_name") or row.get("product_id") or "")
    action_label = "approuvée" if payload.approve else "rejetée"
    wa_text = (
        f"Stockline · Votre commande {command_id} ({qty:g} × {product_label}) a été {action_label}."
    )
    if comment:
        wa_text = f"{wa_text}\nCommentaire : {comment}"

    wa_sent = False
    wa_error = ""
    if phone:
        try:
            await whats.send_ack(phone, wa_text)
            wa_sent = True
        except Exception as exc:
            wa_error = str(exc)

    await publish(
        {
            "type": "command.decided",
            "node": "decision.hitl",
            "command_id": command_id,
            "client_id": str(row.get("client_id") or ""),
            "phone_number": phone,
            "actor": actor,
            "status": status_value,
            "comment": comment,
            "wa_sent": wa_sent,
            "wa_error": wa_error,
            "new_stock": new_stock,
            "message": (
                f"{command_id} ({client_name}) {status_value} by {actor}"
                + (f' — "{comment}"' if comment else "")
                + (f" · stock={new_stock:g}" if new_stock is not None else "")
                + (f" · WhatsApp sent to {phone}" if wa_sent else "")
            ),
        }
    )
    return {
        "command_id": command_id,
        "status": status_value,
        "comment": comment,
        "decided_by": actor,
        "wa_sent": wa_sent,
        "wa_error": wa_error,
        "new_stock": new_stock,
    }


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
    caller_phone = ""
    try:
        while True:
            frame = await websocket.receive()
            if frame.get("type") == "websocket.disconnect":
                raise WebSocketDisconnect(code=int(frame.get("code") or 1000))
            raw_bytes: bytes | None = frame.get("bytes")
            message: dict[str, Any] = {}
            if raw_bytes is not None:
                message = {"type": "audio_bytes"}
            elif frame.get("text"):
                import json

                try:
                    parsed = json.loads(str(frame["text"]))
                    if isinstance(parsed, dict):
                        message = parsed
                except ValueError:
                    continue
            if message.get("phone"):
                caller_phone = str(message.get("phone") or "")
            if raw_bytes is not None or message.get("type") == "audio":
                raw = (
                    raw_bytes
                    if raw_bytes is not None
                    else base64.b64decode(message.get("data", ""))
                )
                tmp = Path("/tmp") / f"call_{call_id}_{len(transcript)}.webm"
                tmp.write_bytes(raw)
                res = await stt.transcribe_media(str(tmp), [])
                text = str(res.get("text") or "").strip()
                if text:
                    transcript.append(text)
                await websocket.send_json({"type": "transcript", "text": text, "call_id": call_id})
            elif message.get("type") == "commit" and transcript:
                full_text = " ".join(transcript).strip()
                phone = caller_phone or "33745717350"
                sig = Signal(
                    evenement_id=f"call_{call_id}",
                    capture_le=datetime.now(UTC),
                    canal="call",
                    actor_ref=phone,
                    cNumber=phone,
                    modality="audio",
                    texte=full_text,
                )
                asyncio.create_task(handle_signal(sig))
    except WebSocketDisconnect:
        if transcript:
            full_text = " ".join(transcript).strip()
            phone = caller_phone or "33745717350"
            sig = Signal(
                evenement_id=f"call_{call_id}",
                capture_le=datetime.now(UTC),
                canal="call",
                actor_ref=phone,
                cNumber=phone,
                modality="audio",
                texte=full_text,
            )
            asyncio.create_task(handle_signal(sig))
        return
