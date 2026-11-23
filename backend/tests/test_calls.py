"""Tests for the calls brick configuration, provider specs, and call webhook state."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch

from stockline_ai.api import calls
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
    assert committed_texts == ["Trois pains de campagne pour mardi soir."]
    calls._calls.clear()
