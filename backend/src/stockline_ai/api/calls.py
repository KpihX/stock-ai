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

from ..config import get_config
from . import db, stt
from .auth import verify_token
from .errors import sanitize_error
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
    speaker: str = "client"


def _digits(value: str) -> str:
    head = value.split("@", 1)[0].split(":", 1)[0]
    return "".join(ch for ch in head if ch.isdigit())


def _wa_calls_url(path: str) -> str:
    base = str(get_config().calls_settings.get("wa_url") or _base_url()).rstrip("/")
    if "localhost" in base and _base_url() != "http://localhost:3001":
        base = _base_url().rstrip("/")
    return f"{base}{path}"


async def _synthesize_wav_16k(text: str) -> bytes:
    """Synthesize French customer speech into 16 kHz mono 16-bit PCM WAV bytes."""
    voice = get_config().model_for("tts")
    with tempfile.TemporaryDirectory(prefix="stockline_tts_") as tmpdir:
        mp3_path = Path(tmpdir) / "speech.mp3"
        wav_path = Path(tmpdir) / "speech.wav"
        communicate = edge_tts.Communicate(text, voice)
        await asyncio.wait_for(communicate.save(str(mp3_path)), timeout=15.0)
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
        try:
            _, err = await asyncio.wait_for(proc.communicate(), timeout=15.0)
        except TimeoutError as exc:
            proc.kill()
            await proc.wait()
            raise TimeoutError("ffmpeg tts conversion timed out") from exc
        if proc.returncode != 0 or not wav_path.is_file():
            raise RuntimeError(f"ffmpeg tts conversion failed: {err.decode(errors='ignore')[:200]}")
        return wav_path.read_bytes()


def _format_dialogue(transcripts: list[dict[str, Any]]) -> str:
    lines: list[str] = []
    for t in sorted(transcripts, key=lambda item: int(item.get("seq", 0))):
        txt = str(t.get("text", "")).strip()
        if not txt:
            continue
        spk = "Gestionnaire" if str(t.get("speaker", "client")).lower() == "manager" else "Client"
        lines.append(f"[{spk}] {txt}")
    return "\n".join(lines).strip()


async def _persist_call(record: dict[str, Any]) -> None:
    try:
        await db.upsert_call_session(record)
    except Exception as exc:
        err = sanitize_error(exc)
        print(f"[calls] upsert_call_session failed for {record.get('call_id')}: {err}", flush=True)


async def _commit_call_order(call_id: str) -> dict[str, Any] | None:
    record = _calls.get(call_id)
    if not record or record.get("committed"):
        return None
    full_text = _format_dialogue(list(record.get("transcripts", [])))
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
    res = await handle_signal(sig)
    if isinstance(res, dict) and res.get("command_id"):
        record["command_id"] = str(res["command_id"])
    await _persist_call(record)
    return res


async def _safe_commit_call_order(call_id: str) -> None:
    try:
        await _commit_call_order(call_id)
    except Exception as exc:
        clean_err = sanitize_error(exc)
        print(f"[calls] _commit_call_order failed for {call_id}: {clean_err}", flush=True)
        await publish(
            {
                "type": "call.commit_error",
                "node": "cmd.handler",
                "call_id": call_id,
                "status": "error",
                "message": f"Order extraction failed for call {call_id}: {clean_err}",
                "error": clean_err,
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
            "mode": str(payload.get("mode", get_config().provider("calls"))),
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
        await _persist_call(record)
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
            "mode": str(payload.get("mode", get_config().provider("calls"))),
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
        await _persist_call(record)
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
            if stt_res.get("error"):
                clean_err = sanitize_error(str(stt_res["error"]))
                stt_prov = stt_res.get("provider", "stt")
                await publish(
                    {
                        "type": "stt.error",
                        "node": "stt.whisper",
                        "call_id": call_id,
                        "phone_number": record["phone_number"],
                        "client_id": record["client_id"],
                        "client_name": record["client_name"],
                        "status": "error",
                        "message": f"Call STT failed ({stt_prov}): {clean_err}",
                        "error": clean_err,
                    }
                )
            elif stt_res.get("fallback_from"):
                await publish(
                    {
                        "type": "pipeline.warning",
                        "node": "stt.whisper",
                        "call_id": call_id,
                        "phone_number": record["phone_number"],
                        "status": "warn",
                        "message": (
                            f"Call STT {stt_res['fallback_from']} failed "
                            f"({sanitize_error(str(stt_res.get('primary_error', 'error')))}), "
                            f"switched to {stt_res.get('provider')}"
                        ),
                    }
                )
            text = str(stt_res.get("text", "")).strip()
            speaker = (
                "manager"
                if str(payload.get("speaker") or "client").lower() == "manager"
                else "client"
            )
            speaker_label = "Manager" if speaker == "manager" else record["client_name"]
            if text and text not in _SILENCE_MARKERS:
                entry = {
                    "id": f"{call_id}_{utt_seq}",
                    "seq": utt_seq,
                    "speaker": speaker,
                    "text": text,
                    "duration_ms": duration_ms,
                    "ts": datetime.now(UTC).isoformat(),
                }
                record["transcripts"].append(entry)
                record["transcripts"].sort(key=lambda t: int(t.get("seq", 0)))
                await _persist_call(record)
                full_transcript = _format_dialogue(list(record["transcripts"]))
                await publish(
                    {
                        "type": "call.transcript",
                        "node": "stt.whisper",
                        "call_id": call_id,
                        "phone_number": record["phone_number"],
                        "client_id": record["client_id"],
                        "client_name": record["client_name"],
                        "speaker": speaker,
                        "status": "transcribed",
                        "text": text,
                        "full_transcript": full_transcript,
                        "duration_ms": duration_ms,
                        "message": f'[{speaker_label}] "{text}"',
                    }
                )
        except Exception as exc:
            clean_err = sanitize_error(exc)
            await publish(
                {
                    "type": "stt.error",
                    "node": "stt.whisper",
                    "call_id": call_id,
                    "phone_number": record["phone_number"],
                    "client_id": record["client_id"],
                    "client_name": record["client_name"],
                    "status": "error",
                    "message": f"Call STT error: {clean_err}",
                    "error": clean_err,
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

    if event == "call.error":
        clean_err = sanitize_error(
            str(payload.get("error") or payload.get("message") or "Call error")
        )
        await publish(
            {
                "type": "call.error",
                "node": "intake.call",
                "call_id": call_id,
                "phone_number": record["phone_number"],
                "client_id": record["client_id"],
                "client_name": record["client_name"],
                "status": "error",
                "message": f"Call {call_id} error: {clean_err}",
                "error": clean_err,
            }
        )
        return {"status": "ok"}

    if event == "call.ended":
        record["status"] = str(payload.get("status", "ended"))
        record["ended_at"] = datetime.now(UTC).isoformat()
        record["reason"] = str(payload.get("reason", "ended"))
        record["stats"] = dict(payload.get("stats") or {})
        await _persist_call(record)
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
    live_cfg = get_config()
    cfg = live_cfg.calls_settings
    ice_urls = [str(u) for u in (cfg.get("ice_servers") or ["stun:stun.l.google.com:19302"])]
    return {
        "provider": live_cfg.provider("calls"),
        "sample_rate": int(cfg.get("sample_rate", 16000)),
        "webrtc_rate": int(cfg.get("webrtc_rate", 48000)),
        "ice_servers": [{"urls": u} for u in ice_urls],
    }


@router.get("/api/calls/active")
async def get_active_calls(_: str = Depends(verify_token)) -> dict[str, Any]:
    active = [c for c in _calls.values() if c.get("status") in {"ringing", "active"}]
    db_recent = await db.fetch_call_sessions(25)
    by_id: dict[str, dict[str, Any]] = {str(c["call_id"]): dict(c) for c in db_recent}
    for cid, c in _calls.items():
        merged = dict(by_id.get(cid) or {})
        merged.update(c)
        by_id[cid] = merged
    recent = sorted(by_id.values(), key=lambda c: str(c.get("started_at", "")), reverse=True)[:25]
    for item in recent:
        item["linked_commands"] = await db.fetch_commands_by_call(str(item.get("call_id", "")))
    return {"items": active, "recent": recent}


@router.get("/api/calls/history")
async def get_call_history(limit: int = 30, _: str = Depends(verify_token)) -> dict[str, Any]:
    sessions = await db.fetch_call_sessions(max(1, min(limit, 100)))
    for item in sessions:
        cid = str(item.get("call_id", ""))
        if cid in _calls and len(_calls[cid].get("transcripts") or []) > len(
            item.get("transcripts") or []
        ):
            item["transcripts"] = list(_calls[cid]["transcripts"])
        item["linked_commands"] = await db.fetch_commands_by_call(cid)
    return {"items": sessions, "total": len(sessions)}


@router.get("/api/calls/{call_id}")
async def get_call_detail(call_id: str, _: str = Depends(verify_token)) -> dict[str, Any]:
    item = await db.fetch_call_session(call_id)
    if not item and call_id in _calls:
        item = dict(_calls[call_id])
        item["linked_commands"] = await db.fetch_commands_by_call(call_id)
    if not item:
        raise HTTPException(status_code=404, detail="Call session not found")
    return item


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
        raise HTTPException(
            status_code=502, detail=f"Call accept failed: {sanitize_error(exc)}"
        ) from exc

    if call_id in _calls:
        _calls[call_id]["status"] = "active"
        await _persist_call(_calls[call_id])
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
        raise HTTPException(
            status_code=502, detail=f"Call reject failed: {sanitize_error(exc)}"
        ) from exc
    if call_id in _calls:
        _calls[call_id]["status"] = "rejected"
        await _persist_call(_calls[call_id])
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
        raise HTTPException(
            status_code=502, detail=f"Call hangup failed: {sanitize_error(exc)}"
        ) from exc
    if call_id in _calls:
        _calls[call_id]["status"] = "ended"
        _calls[call_id]["ended_at"] = datetime.now(UTC).isoformat()
        await _persist_call(_calls[call_id])
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
        raise HTTPException(
            status_code=502, detail=f"Call mute failed: {sanitize_error(exc)}"
        ) from exc
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
        try:
            wav_bytes = await _synthesize_wav_16k(payload.text.strip())
            wav_b64 = base64.b64encode(wav_bytes).decode("ascii")
        except Exception as exc:
            raise HTTPException(
                status_code=502, detail=f"TTS synthesis failed: {sanitize_error(exc)}"
            ) from exc

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
        raise HTTPException(
            status_code=502, detail=f"Simulation failed: {sanitize_error(exc)}"
        ) from exc


@router.post("/api/calls/{call_id}/inject-text")
async def inject_call_text(
    call_id: str, payload: InjectTextRequest, _: str = Depends(verify_token)
) -> dict[str, Any]:
    if not payload.text.strip():
        raise HTTPException(status_code=400, detail="text required")
    try:
        wav_bytes = await _synthesize_wav_16k(payload.text.strip())
        wav_b64 = base64.b64encode(wav_bytes).decode("ascii")
    except Exception as exc:
        raise HTTPException(
            status_code=502, detail=f"TTS synthesis failed: {sanitize_error(exc)}"
        ) from exc
    speaker = "manager" if str(payload.speaker).lower() == "manager" else "client"
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                _wa_calls_url("/call/inject-audio"),
                json={"call_id": call_id, "wav_base64": wav_b64, "speaker": speaker},
            )
            resp.raise_for_status()
            return dict(resp.json())
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=502, detail=f"Inject audio failed: {sanitize_error(exc)}"
        ) from exc
