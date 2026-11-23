"""Live inbound WhatsApp VoIP -> Browser WebRTC Opus signaling & AI audio tap."""

from __future__ import annotations

import asyncio
import base64
import tempfile
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import edge_tts
import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..config import CONFIG
from . import db, stt
from .auth import verify_token
from .pipeline import handle_signal, publish
from .schemas import Signal
from .whats import _base_url

router = APIRouter(tags=["calls"])

_calls: dict[str, dict[str, Any]] = {}
_stt_semaphore = asyncio.Semaphore(4)

_SILENCE_MARKERS = {"[BLANK_AUDIO]", "(silence)", "[silence]", "(musique)", "[Music]"}


class AcceptCallRequest(BaseModel):
    sdp_offer: str


class RejectCallRequest(BaseModel):
    reason: str = "declined"


class HangupCallRequest(BaseModel):
    reason: str = "completed"


class MuteCallRequest(BaseModel):
    muted: bool = True


class SimulateCallRequest(BaseModel):
    phone: str = "33745746025"
    text: str = ""
    wav_base64: str = ""


class InjectTextRequest(BaseModel):
    text: str


def _digits(value: str) -> str:
    head = value.split("@", 1)[0].split(":", 1)[0]
    return "".join(ch for ch in head if ch.isdigit())


def _wa_calls_url(path: str) -> str:
    base = str(CONFIG.calls_settings.get("wa_url") or _base_url()).rstrip("/")
    if "localhost" in base and _base_url() != "http://localhost:3001":
        base = _base_url().rstrip("/")
    return f"{base}{path}"


async def _synthesize_wav_16k(text: str) -> bytes:
    """Synthesize French customer speech into 16 kHz mono 16-bit PCM WAV bytes."""
    voice = CONFIG.model_for("tts") or "fr-FR-DeniseNeural"
    with tempfile.TemporaryDirectory(prefix="stockline_tts_") as tmpdir:
        mp3_path = Path(tmpdir) / "speech.mp3"
        wav_path = Path(tmpdir) / "speech.wav"
        communicate = edge_tts.Communicate(text, voice)
        await communicate.save(str(mp3_path))
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg",
            "-y",
            "-i",
            str(mp3_path),
            "-ar",
            "16000",
            "-ac",
            "1",
            "-acodec",
            "pcm_s16le",
            str(wav_path),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, err = await proc.communicate()
        if proc.returncode != 0 or not wav_path.is_file():
            raise RuntimeError(f"ffmpeg tts conversion failed: {err.decode(errors='ignore')[:200]}")
        return wav_path.read_bytes()


async def _commit_call_order(call_id: str) -> dict[str, Any] | None:
    record = _calls.get(call_id)
    if not record or record.get("committed"):
        return None
    full_text = " ".join(
        str(t.get("text", "")).strip() for t in record.get("transcripts", []) if t.get("text")
    ).strip()
    if not full_text:
        return None
    record["committed"] = True
    phone = str(record.get("phone_number") or "")
    sig = Signal(
        evenement_id=f"wacall_{call_id}",
        capture_le=datetime.now(UTC),
        canal="call",
        actor_ref=phone,
        cNumber=phone,
        modality="audio",
        texte=full_text,
    )
    return await handle_signal(sig)


async def _safe_commit_call_order(call_id: str) -> None:
    try:
        await _commit_call_order(call_id)
    except Exception as exc:
        print(f"[calls] _commit_call_order failed for {call_id}: {exc}", flush=True)
        await publish(
            {
                "type": "call.commit_error",
                "node": "cmd.handler",
                "call_id": call_id,
                "status": "error",
                "message": f"Order extraction failed for call {call_id}: {exc}",
            }
        )


@router.post("/webhooks/call")
async def call_webhook(payload: dict[str, Any]) -> dict[str, Any]:
    """Receive call lifecycle events and VAD audio utterances from the WA VoIP listener."""
    event = str(payload.get("event", "")).strip()
    call_id = str(payload.get("call_id", "")).strip()
    phone = _digits(str(payload.get("from", "")))
    if not call_id:
        raise HTTPException(status_code=400, detail="call_id required")

    if event == "call.incoming":
        client = await db.fetch_client_by_phone(phone) if phone else None
        client_id = str(client["client_id"]) if client else ""
        client_name = str(client["client_name"]) if client else (phone or "Unknown caller")
        record = {
            "call_id": call_id,
            "phone_number": phone,
            "client_id": client_id,
            "client_name": client_name,
            "known_client": client is not None,
            "status": "ringing",
            "mode": str(payload.get("mode", CONFIG.provider("calls"))),
            "is_video": bool(payload.get("is_video", False)),
            "is_waiting": bool(payload.get("is_waiting", False)),
            "started_at": datetime.now(UTC).isoformat(),
            "muted": False,
            "committed": False,
            "utterance_seq": 0,
            "in_flight": 0,
            "transcripts": [],
            "stats": {},
        }
        _calls[call_id] = record
        await publish(
            {
                "type": "call.incoming",
                "node": "intake.call",
                "call_id": call_id,
                "phone_number": phone,
                "client_id": client_id,
                "client_name": client_name,
                "known_client": client is not None,
                "mode": record["mode"],
                "status": "ringing",
                "message": f"Incoming WhatsApp call from {client_name} ({phone})",
            }
        )
        return {"status": "ok", "call_id": call_id}

    record = _calls.setdefault(
        call_id,
        {
            "call_id": call_id,
            "phone_number": phone,
            "client_id": "",
            "client_name": phone or "Caller",
            "known_client": False,
            "status": "active",
            "mode": str(payload.get("mode", CONFIG.provider("calls"))),
            "started_at": datetime.now(UTC).isoformat(),
            "muted": False,
            "committed": False,
            "utterance_seq": 0,
            "in_flight": 0,
            "transcripts": [],
            "stats": {},
        },
    )

    if event == "call.state":
        status = str(payload.get("status", "active"))
        record["status"] = status
        await publish(
            {
                "type": "call.state",
                "node": "intake.call",
                "call_id": call_id,
                "phone_number": record["phone_number"],
                "client_id": record["client_id"],
                "client_name": record["client_name"],
                "status": status,
                "message": f"Call {call_id} state -> {status}",
            }
        )
        return {"status": "ok"}

    if event == "call.utterance":
        wav_b64 = str(payload.get("wav_base64", ""))
        duration_ms = int(payload.get("duration_ms", 0) or 0)
        if not wav_b64:
            return {"status": "ignored", "reason": "empty audio"}
        raw_wav = base64.b64decode(wav_b64)
        utt_seq = int(record.get("utterance_seq", 0)) + 1
        record["utterance_seq"] = utt_seq
        record["in_flight"] = int(record.get("in_flight", 0)) + 1
        wav_path = Path(tempfile.gettempdir()) / f"stockline_call_{call_id}_{utt_seq}.wav"
        wav_path.write_bytes(raw_wav)

        text = ""
        try:
            products = await db.fetch_products()
            product_names = [str(p["product_name"]) for p in products if p.get("product_name")]
            async with _stt_semaphore:
                stt_res = await stt.transcribe_wav(wav_path, product_names)
            text = str(stt_res.get("text", "")).strip()
            if text and text not in _SILENCE_MARKERS:
                entry = {
                    "id": f"{call_id}_{utt_seq}",
                    "seq": utt_seq,
                    "speaker": "client",
                    "text": text,
                    "duration_ms": duration_ms,
                    "ts": datetime.now(UTC).isoformat(),
                }
                record["transcripts"].append(entry)
                record["transcripts"].sort(key=lambda t: int(t.get("seq", 0)))
                full_transcript = " ".join(t["text"] for t in record["transcripts"]).strip()
                await publish(
                    {
                        "type": "call.transcript",
                        "node": "stt.whisper",
                        "call_id": call_id,
                        "phone_number": record["phone_number"],
                        "client_id": record["client_id"],
                        "client_name": record["client_name"],
                        "status": "transcribed",
                        "text": text,
                        "full_transcript": full_transcript,
                        "duration_ms": duration_ms,
                        "message": f'[{record["client_name"]}] "{text}"',
                    }
                )
        finally:
            record["in_flight"] = max(0, int(record.get("in_flight", 1)) - 1)
            if (
                record.get("status") in {"ended", "completed"}
                and record["in_flight"] == 0
                and record["transcripts"]
                and not record.get("committed")
            ):
                asyncio.create_task(_safe_commit_call_order(call_id))

        if not text or text in _SILENCE_MARKERS:
            return {"status": "silence", "text": ""}
        return {"status": "ok", "text": text}

    if event == "call.ended":
        record["status"] = str(payload.get("status", "ended"))
        record["ended_at"] = datetime.now(UTC).isoformat()
        record["reason"] = str(payload.get("reason", "ended"))
        record["stats"] = dict(payload.get("stats") or {})
        await publish(
            {
                "type": "call.ended",
                "node": "intake.call",
                "call_id": call_id,
                "phone_number": record["phone_number"],
                "client_id": record["client_id"],
                "client_name": record["client_name"],
                "status": record["status"],
                "reason": record["reason"],
                "stats": record["stats"],
                "message": f"Call {call_id} ended ({record['reason']})",
            }
        )
        if (
            int(record.get("in_flight", 0)) == 0
            and record["transcripts"]
            and not record.get("committed")
        ):
            asyncio.create_task(_safe_commit_call_order(call_id))
        return {"status": "ok"}

    return {"status": "ignored"}


@router.get("/api/calls/config")
async def get_call_config(_: str = Depends(verify_token)) -> dict[str, Any]:
    cfg = CONFIG.calls_settings
    ice_urls = [str(u) for u in (cfg.get("ice_servers") or ["stun:stun.l.google.com:19302"])]
    return {
        "provider": CONFIG.provider("calls"),
        "sample_rate": int(cfg.get("sample_rate", 16000)),
        "webrtc_rate": int(cfg.get("webrtc_rate", 48000)),
        "ice_servers": [{"urls": u} for u in ice_urls],
    }


@router.get("/api/calls/active")
async def get_active_calls(_: str = Depends(verify_token)) -> dict[str, Any]:
    active = [c for c in _calls.values() if c.get("status") in {"ringing", "active"}]
    recent = sorted(_calls.values(), key=lambda c: str(c.get("started_at", "")), reverse=True)[:5]
    return {"items": active, "recent": recent}


@router.post("/api/calls/{call_id}/accept")
async def accept_call(
    call_id: str, payload: AcceptCallRequest, _: str = Depends(verify_token)
) -> dict[str, Any]:
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                _wa_calls_url("/call/accept"),
                json={"call_id": call_id, "sdp_offer": payload.sdp_offer},
            )
            resp.raise_for_status()
            data = dict(resp.json())
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Call accept failed: {exc}") from exc

    if call_id in _calls:
        _calls[call_id]["status"] = "active"
    return data


@router.post("/api/calls/{call_id}/reject")
async def reject_call(
    call_id: str, payload: RejectCallRequest | None = None, _: str = Depends(verify_token)
) -> dict[str, Any]:
    reason = payload.reason if payload else "declined"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                _wa_calls_url("/call/reject"),
                json={"call_id": call_id, "reason": reason},
            )
            resp.raise_for_status()
            data = dict(resp.json())
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Call reject failed: {exc}") from exc
    if call_id in _calls:
        _calls[call_id]["status"] = "rejected"
    return data


@router.post("/api/calls/{call_id}/hangup")
async def hangup_call(
    call_id: str, payload: HangupCallRequest | None = None, _: str = Depends(verify_token)
) -> dict[str, Any]:
    reason = payload.reason if payload else "completed"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                _wa_calls_url("/call/hangup"),
                json={"call_id": call_id, "reason": reason},
            )
            resp.raise_for_status()
            data = dict(resp.json())
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Call hangup failed: {exc}") from exc
    if call_id in _calls:
        _calls[call_id]["status"] = "ended"
    return data


@router.post("/api/calls/{call_id}/mute")
async def mute_call(
    call_id: str, payload: MuteCallRequest, _: str = Depends(verify_token)
) -> dict[str, Any]:
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.post(
                _wa_calls_url("/call/mute"),
                json={"call_id": call_id, "muted": payload.muted},
            )
            resp.raise_for_status()
            data = dict(resp.json())
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Call mute failed: {exc}") from exc
    if call_id in _calls:
        _calls[call_id]["muted"] = payload.muted
    return data


@router.post("/api/calls/{call_id}/commit")
async def commit_call(call_id: str, _: str = Depends(verify_token)) -> dict[str, Any]:
    record = _calls.get(call_id)
    if not record:
        raise HTTPException(status_code=404, detail="Call not found")
    if record.get("committed"):
        return {"status": "already_committed", "call_id": call_id}
    result = await _commit_call_order(call_id)
    if result is None:
        raise HTTPException(status_code=400, detail="No caller speech transcribed yet")
    return {"status": "committed", "call_id": call_id, "result": result}


@router.post("/api/calls/simulate")
async def simulate_call(
    payload: SimulateCallRequest, _: str = Depends(verify_token)
) -> dict[str, Any]:
    wav_b64 = payload.wav_base64.strip()
    if not wav_b64 and payload.text.strip():
        wav_bytes = await _synthesize_wav_16k(payload.text.strip())
        wav_b64 = base64.b64encode(wav_bytes).decode("ascii")

    call_id = f"SIM-{uuid.uuid4().hex[:10].upper()}"
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                _wa_calls_url("/call/simulate"),
                json={"from": _digits(payload.phone), "wav_base64": wav_b64, "call_id": call_id},
            )
            resp.raise_for_status()
            return dict(resp.json())
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Simulation failed: {exc}") from exc


@router.post("/api/calls/{call_id}/inject-text")
async def inject_call_text(
    call_id: str, payload: InjectTextRequest, _: str = Depends(verify_token)
) -> dict[str, Any]:
    if not payload.text.strip():
        raise HTTPException(status_code=400, detail="text required")
    wav_bytes = await _synthesize_wav_16k(payload.text.strip())
    wav_b64 = base64.b64encode(wav_bytes).decode("ascii")
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                _wa_calls_url("/call/inject-audio"),
                json={"call_id": call_id, "wav_base64": wav_b64},
            )
            resp.raise_for_status()
            return dict(resp.json())
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Inject audio failed: {exc}") from exc
