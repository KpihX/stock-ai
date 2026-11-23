"""Tests for the calls brick configuration, provider specs, and call webhook state."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch

from stockline_ai.api import calls
from stockline_ai.api.errors import sanitize_error
from stockline_ai.config import CONFIG
from stockline_ai.providers import get_spec


def test_calls_brick_registered_and_configured() -> None:
    assert CONFIG.provider("calls") == "baileys_voip"
    assert get_spec("calls", "baileys_voip").key == "baileys_voip"
    assert get_spec("calls", "meta_calling").key == "meta_calling"
    assert get_spec("calls", "browser_webrtc").key == "browser_webrtc"
    cfg = CONFIG.calls_settings
    assert int(cfg["sample_rate"]) == 16000
    assert int(cfg["webrtc_rate"]) == 48000
    assert int(cfg["frames_per_chunk"]) == 320


def test_call_webhook_lifecycle() -> None:
    calls._calls.clear()

    async def _run() -> None:
        with (
            patch(
                "stockline_ai.api.calls.db.fetch_client_by_phone",
                new=AsyncMock(
                    return_value={
                        "client_id": "CLI-0045",
                        "client_name": "Yohann Bikele",
                        "phone_number": "33745746025",
                    }
                ),
            ),
            patch("stockline_ai.api.calls.publish", new=AsyncMock()) as pub_mock,
        ):
            res_in = await calls.call_webhook(
                {
                    "event": "call.incoming",
                    "call_id": "TESTCALL1",
                    "from": "33745746025@s.whatsapp.net",
                    "mode": "baileys_voip",
                }
            )
            assert res_in["status"] == "ok"
            assert calls._calls["TESTCALL1"]["client_id"] == "CLI-0045"
            assert calls._calls["TESTCALL1"]["status"] == "ringing"
            assert pub_mock.await_args_list[0].args[0]["type"] == "call.incoming"

            res_state = await calls.call_webhook(
                {"event": "call.state", "call_id": "TESTCALL1", "status": "active"}
            )
            assert res_state["status"] == "ok"
            assert calls._calls["TESTCALL1"]["status"] == "active"

            res_end = await calls.call_webhook(
                {
                    "event": "call.ended",
                    "call_id": "TESTCALL1",
                    "status": "ended",
                    "reason": "completed",
                }
            )
            assert res_end["status"] == "ok"
            assert calls._calls["TESTCALL1"]["status"] == "ended"

    asyncio.run(_run())
    calls._calls.clear()


def test_call_ended_before_utterance_still_commits() -> None:
    import base64

    calls._calls.clear()
    committed_texts: list[str] = []

    async def fake_transcribe(wav_path, product_names):  # type: ignore[no-untyped-def]
        await asyncio.sleep(0.05)
        return {"text": "Trois pains de campagne pour mardi soir."}

    async def fake_handle_signal(sig):  # type: ignore[no-untyped-def]
        committed_texts.append(sig.texte)
        return {"status": "ok"}

    async def _run() -> None:
        with (
            patch(
                "stockline_ai.api.calls.db.fetch_client_by_phone",
                new=AsyncMock(
                    return_value={
                        "client_id": "CLI-0045",
                        "client_name": "Yohann Bikele",
                        "phone_number": "33745746025",
                    }
                ),
            ),
            patch(
                "stockline_ai.api.calls.db.fetch_products",
                new=AsyncMock(return_value=[{"product_name": "Pain de campagne"}]),
            ),
            patch("stockline_ai.api.calls.publish", new=AsyncMock()),
            patch("stockline_ai.api.calls.stt.transcribe_wav", side_effect=fake_transcribe),
            patch("stockline_ai.api.calls.handle_signal", side_effect=fake_handle_signal),
        ):
            await calls.call_webhook(
                {"event": "call.incoming", "call_id": "RACE1", "from": "33745746025"}
            )
            wav_b64 = base64.b64encode(b"RIFF0000WAVEfmt ").decode("ascii")
            utt_task = asyncio.create_task(
                calls.call_webhook(
                    {
                        "event": "call.utterance",
                        "call_id": "RACE1",
                        "from": "33745746025",
                        "duration_ms": 2000,
                        "wav_base64": wav_b64,
                    }
                )
            )
            await asyncio.sleep(0.01)
            await calls.call_webhook(
                {"event": "call.ended", "call_id": "RACE1", "from": "33745746025"}
            )
            await utt_task
            await asyncio.sleep(0.02)

    asyncio.run(_run())
    assert committed_texts == ["[Client] Trois pains de campagne pour mardi soir."]
    calls._calls.clear()


def test_sanitize_error_redacts_secrets() -> None:
    raw = (
        "Failed calling https://integrate.api.nvidia.com with Bearer nvapi-AbCdEf1234567890 "
        "and postgresql://stockline:supersecretpass@postgres:5432/stockline"
    )
    cleaned = sanitize_error(raw)
    assert "nvapi-AbCdEf1234567890" not in cleaned
    assert "supersecretpass" not in cleaned
    assert "[REDACTED]" in cleaned


def test_bidirectional_call_dialogue_includes_manager_and_client() -> None:
    import base64

    calls._calls.clear()
    committed_texts: list[str] = []
    published_events: list[dict] = []

    async def fake_transcribe(wav_path, product_names):  # type: ignore[no-untyped-def]
        if len(published_events) == 1:
            return {"text": "Je voudrais 5 kilos de tomates grappe."}
        return {"text": "Parfait, c'est noté pour demain matin."}

    async def fake_handle_signal(sig):  # type: ignore[no-untyped-def]
        committed_texts.append(sig.texte)
        return {"status": "ok", "command_id": "C-test123"}

    async def fake_publish(event):  # type: ignore[no-untyped-def]
        published_events.append(dict(event))

    async def _run() -> None:
        with (
            patch(
                "stockline_ai.api.calls.db.fetch_client_by_phone",
                new=AsyncMock(
                    return_value={
                        "client_id": "CLI-0045",
                        "client_name": "Yohann Bikele",
                        "phone_number": "33745746025",
                    }
                ),
            ),
            patch(
                "stockline_ai.api.calls.db.fetch_products",
                new=AsyncMock(return_value=[{"product_name": "Tomates grappe"}]),
            ),
            patch("stockline_ai.api.calls.db.upsert_call_session", new=AsyncMock()),
            patch("stockline_ai.api.calls.publish", side_effect=fake_publish),
            patch("stockline_ai.api.calls.stt.transcribe_wav", side_effect=fake_transcribe),
            patch("stockline_ai.api.calls.handle_signal", side_effect=fake_handle_signal),
        ):
            await calls.call_webhook(
                {"event": "call.incoming", "call_id": "BIDIR1", "from": "33745746025"}
            )
            wav_b64 = base64.b64encode(b"RIFF0000WAVEfmt ").decode("ascii")
            await calls.call_webhook(
                {
                    "event": "call.utterance",
                    "call_id": "BIDIR1",
                    "from": "33745746025",
                    "speaker": "client",
                    "duration_ms": 1500,
                    "wav_base64": wav_b64,
                }
            )
            await calls.call_webhook(
                {
                    "event": "call.utterance",
                    "call_id": "BIDIR1",
                    "from": "33745746025",
                    "speaker": "manager",
                    "duration_ms": 1300,
                    "wav_base64": wav_b64,
                }
            )
            await calls.call_webhook(
                {
                    "event": "call.error",
                    "call_id": "BIDIR1",
                    "from": "33745746025",
                    "error": "ICE glitch Bearer nvapi-secret123",
                }
            )
            await calls.commit_call("BIDIR1", "admin")

    asyncio.run(_run())
    assert committed_texts == [
        "[Client] Je voudrais 5 kilos de tomates grappe.\n"
        "[Gestionnaire] Parfait, c'est noté pour demain matin."
    ]
    transcript_events = [e for e in published_events if e.get("type") == "call.transcript"]
    assert [e.get("speaker") for e in transcript_events] == ["client", "manager"]
    err_events = [e for e in published_events if e.get("type") == "call.error"]
    assert len(err_events) == 1
    assert "nvapi-secret123" not in err_events[0]["error"]
    calls._calls.clear()


def test_wa_boot_clears_stale_calls_and_extracts_error() -> None:
    import httpx

    calls._calls.clear()
    published_events: list[dict] = []

    async def fake_publish(event):  # type: ignore[no-untyped-def]
        published_events.append(dict(event))

    async def _run() -> None:
        with (
            patch(
                "stockline_ai.api.calls.db.fetch_client_by_phone",
                new=AsyncMock(return_value=None),
            ),
            patch("stockline_ai.api.calls.db.upsert_call_session", new=AsyncMock()),
            patch("stockline_ai.api.calls.publish", side_effect=fake_publish),
        ):
            await calls.call_webhook(
                {"event": "call.incoming", "call_id": "STALE1", "from": "23793113271"}
            )
            assert calls._calls["STALE1"]["status"] == "ringing"

            res = await calls.call_webhook({"event": "wa.boot", "call_id": "__boot__"})
            assert res["cleared"] == 1
            assert calls._calls["STALE1"]["status"] == "ended"
            assert calls._calls["STALE1"]["reason"] == "listener_restarted"
            assert published_events[-1]["type"] == "call.ended"

    asyncio.run(_run())
    resp = httpx.Response(
        404,
        json={"error": "Call not found: STALE1 Bearer nvapi-secret999"},
    )
    msg = calls._extract_wa_error(resp)
    assert "Call not found: STALE1" in msg
    assert "nvapi-secret999" not in msg
    calls._calls.clear()
