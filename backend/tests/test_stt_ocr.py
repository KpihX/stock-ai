"""Unit tests for the extensible STT and OCR bricks (NVIDIA NIM + local fallbacks)."""

from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock, patch

from stockline_ai.api import ocr, stt
from stockline_ai.config import Config
from stockline_ai.providers import get_spec


def test_stt_and_ocr_providers_registered() -> None:
    for key in ("nvidia_whisper", "nvidia_parakeet", "whisper"):
        assert get_spec("stt", key).key == key
    for key in ("nemotron_vl", "tesseract"):
        assert get_spec("ocr", key).key == key


def test_stt_dispatch_and_fallback(tmp_path: Path) -> None:
    wav = tmp_path / "sample.wav"
    wav.write_bytes(b"RIFF0000WAVEfmt ")

    cfg_nvidia = Config.from_mapping(
        {
            "selection": {"stt": "nvidia_whisper"},
            "settings": {"stt": {"fallback": "whisper", "language": "fr"}},
        }
    )

    async def _run() -> None:
        with patch(
            "stockline_ai.api.stt._run_nvidia_riva",
            new=AsyncMock(return_value={"text": "Trois pains", "provider": "nvidia_whisper"}),
        ) as m_riva:
            res = await stt.transcribe_wav(wav, ["Pain de campagne"], cfg=cfg_nvidia)
            assert res["text"] == "Trois pains"
            assert res["provider"] == "nvidia_whisper"
            m_riva.assert_awaited_once()

        with (
            patch(
                "stockline_ai.api.stt._run_nvidia_riva",
                new=AsyncMock(side_effect=RuntimeError("nvcf down")),
            ),
            patch(
                "stockline_ai.api.stt._run_local_whisper",
                new=AsyncMock(return_value={"text": "Repli local", "provider": "whisper"}),
            ) as m_local,
        ):
            res_fb = await stt.transcribe_wav(wav, ["Pain de campagne"], cfg=cfg_nvidia)
            assert res_fb["text"] == "Repli local"
            assert res_fb["provider"] == "whisper"
            assert res_fb["fallback_from"] == "nvidia_whisper"
            m_local.assert_awaited_once()

        cfg_parakeet = Config.from_mapping({"selection": {"stt": "nvidia_parakeet"}})
        with patch(
            "stockline_ai.api.stt._run_nvidia_riva",
            new=AsyncMock(return_value={"text": "Parakeet ok", "provider": "nvidia_parakeet"}),
        ) as m_para:
            res_p = await stt.transcribe_wav(wav, [], cfg=cfg_parakeet)
            assert res_p["provider"] == "nvidia_parakeet"
            m_para.assert_awaited_once()

    asyncio.run(_run())


def test_ocr_dispatch_and_fallback(tmp_path: Path) -> None:
    img = tmp_path / "order.png"
    img.write_bytes(b"\x89PNG\r\n\x1a\nfake")

    cfg_vl = Config.from_mapping(
        {
            "selection": {"ocr": "nemotron_vl"},
            "settings": {"ocr": {"fallback": "tesseract", "languages": "eng+fra"}},
        }
    )

    async def _run() -> None:
        with patch(
            "stockline_ai.api.ocr._run_nemotron_vl",
            new=AsyncMock(return_value={"ocr_raw": "4 kg tomates", "provider": "nemotron_vl"}),
        ) as m_vl:
            res = await ocr.extract_image_text(str(img), "Urgent", ["Tomates grappe"], cfg=cfg_vl)
            assert res["provider"] == "nemotron_vl"
            assert res["text"] == "Urgent 4 kg tomates"
            m_vl.assert_awaited_once()

        with (
            patch(
                "stockline_ai.api.ocr._run_nemotron_vl",
                new=AsyncMock(side_effect=RuntimeError("vl timeout")),
            ),
            patch(
                "stockline_ai.api.ocr._run_tesseract",
                new=AsyncMock(return_value={"ocr_raw": "4 kg", "provider": "tesseract"}),
            ) as m_tess,
        ):
            res_fb = await ocr.extract_image_text(str(img), "[image]", [], cfg=cfg_vl)
            assert res_fb["provider"] == "tesseract"
            assert res_fb["fallback_from"] == "nemotron_vl"
            assert res_fb["text"] == "4 kg"
            m_tess.assert_awaited_once()

    asyncio.run(_run())
