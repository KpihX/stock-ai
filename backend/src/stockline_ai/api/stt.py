"""Extensible Speech-to-Text (STT) adapter driven by config.jsonc + providers.py.

Supports:
- nvidia_whisper  (OpenAI Whisper Large v3 on NVIDIA Riva NVCF gRPC, <1s)
- nvidia_parakeet (NVIDIA Parakeet 1.1B Multilingual ASR on Riva NVCF gRPC, <1s)
- whisper         (Local whisper.cpp offline fallback)
"""

from __future__ import annotations

import asyncio
import time
from pathlib import Path
from typing import Any

import riva.client

from ..config import Config, get_config


def _riva_recognize_sync(
    audio_bytes: bytes,
    uri: str,
    function_id: str,
    api_key: str,
    language_code: str,
    sample_rate: int,
    punctuation: bool,
) -> str:
    auth = riva.client.Auth(
        use_ssl=True,
        uri=uri,
        metadata_args=[
            ["function-id", function_id],
            ["authorization", f"Bearer {api_key}"],
        ],
    )
    asr = riva.client.ASRService(auth)
    rec_cfg = riva.client.RecognitionConfig(
        encoding=riva.client.AudioEncoding.LINEAR_PCM,
        sample_rate_hertz=sample_rate,
        language_code=language_code,
        max_alternatives=1,
        enable_automatic_punctuation=punctuation,
    )
    response = asr.offline_recognize(audio_bytes, rec_cfg)
    results = getattr(response, "results", None) or []
    return " ".join(
        alt.transcript.strip()
        for res in results
        for alt in getattr(res, "alternatives", [])[:1]
        if getattr(alt, "transcript", "") and alt.transcript.strip()
    ).strip()


async def _run_nvidia_riva(
    wav_path: Path,
    provider_key: str,
    cfg: Config,
) -> dict[str, Any]:
    t0 = time.perf_counter()
    uri = str(cfg.provider_param("stt", provider_key, "base_url"))
    function_id = str(cfg.provider_param("stt", provider_key, "function_id"))
    model = str(cfg.provider_param("stt", provider_key, "model"))
    language = str(cfg.provider_param("stt", provider_key, "language", "fr"))
    sample_rate = int(cfg.provider_param("stt", provider_key, "sample_rate", 16000))
    punctuation = bool(cfg.provider_param("stt", provider_key, "punctuation", True))
    api_key = cfg.provider_api_key("stt", provider_key, required=True)
    if not function_id or not uri:
        raise RuntimeError(f"Missing base_url/function_id for STT provider '{provider_key}'")

    audio_bytes = wav_path.read_bytes()
    transcript = await asyncio.to_thread(
        _riva_recognize_sync,
        audio_bytes,
        uri,
        function_id,
        api_key,
        language,
        sample_rate,
        punctuation,
    )
    return {
        "text": transcript,
        "provider": provider_key,
        "model": model,
        "language": language,
        "wav_path": str(wav_path),
        "elapsed_ms": round((time.perf_counter() - t0) * 1000),
    }


async def _run_local_whisper(
    wav_path: Path,
    product_names: list[str],
    cfg: Config,
) -> dict[str, Any]:
    t0 = time.perf_counter()
    whisper_bin = str(cfg.provider_param("stt", "whisper", "bin", "whisper-cli"))
    model_name = str(cfg.provider_param("stt", "whisper", "model"))
    language = str(cfg.provider_param("stt", "whisper", "language", "fr"))
    base_prompt = str(cfg.provider_param("stt", "whisper", "prompt", ""))
    model_path = cfg.stt_models_dir / model_name
    vocab = ", ".join(product_names)
    prompt = f"{base_prompt} Catalogue : {vocab}.".strip() if vocab else base_prompt
    proc = await asyncio.create_subprocess_exec(
        whisper_bin,
        "-m",
        str(model_path),
        "-l",
        language,
        "--prompt",
        prompt,
        "-nt",
        "-np",
        "-f",
        str(wav_path),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out, err = await proc.communicate()
    transcript = " ".join(out.decode(errors="ignore").split()).strip()
    return {
        "text": transcript,
        "provider": "whisper",
        "wav_path": str(wav_path),
        "bin": whisper_bin,
        "model": str(model_path),
        "prompt": prompt,
        "returncode": proc.returncode,
        "stderr": err.decode(errors="ignore")[:300],
        "elapsed_ms": round((time.perf_counter() - t0) * 1000),
    }


async def _dispatch_wav(
    wav_path: Path,
    provider_key: str,
    product_names: list[str],
    cfg: Config,
) -> dict[str, Any]:
    if provider_key in ("nvidia_whisper", "nvidia_parakeet"):
        return await _run_nvidia_riva(wav_path, provider_key, cfg)
    if provider_key == "whisper":
        return await _run_local_whisper(wav_path, product_names, cfg)
    raise ValueError(f"Unsupported STT provider '{provider_key}'")


async def transcribe_wav(
    wav_path: Path,
    product_names: list[str],
    *,
    cfg: Config | None = None,
) -> dict[str, Any]:
    """Transcribe a 16 kHz mono WAV file using the active STT brick (with optional fallback)."""
    active_cfg = cfg or get_config()
    if not wav_path.is_file():
        return {"text": "", "error": f"WAV file not found: {wav_path}"}

    primary = active_cfg.provider("stt")
    try:
        return await _dispatch_wav(wav_path, primary, product_names, active_cfg)
    except Exception as exc:
        fallback = active_cfg.fallback_for("stt")
        if fallback and fallback != primary:
            res = await _dispatch_wav(wav_path, fallback, product_names, active_cfg)
            res["fallback_from"] = primary
            res["primary_error"] = str(exc)
            return res
        return {"text": "", "provider": primary, "error": str(exc)}


async def convert_to_wav16k(
    media_path: str, *, sample_rate: int = 16000
) -> tuple[Path | None, str]:
    """Convert any audio container (.ogg, .webm, .mp3) to 16 kHz mono 16-bit PCM WAV."""
    path = Path(media_path)
    if not path.is_file():
        return None, f"Audio file not found: {media_path}"
    if path.suffix.lower() == ".wav":
        return path, ""
    wav_path = path.with_suffix(".wav")
    ff = await asyncio.create_subprocess_exec(
        "ffmpeg",
        "-y",
        "-i",
        str(path),
        "-ar",
        str(sample_rate),
        "-ac",
        "1",
        "-acodec",
        "pcm_s16le",
        str(wav_path),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, ff_err = await ff.communicate()
    if ff.returncode != 0 or not wav_path.is_file():
        return None, f"ffmpeg failed ({ff.returncode}): {ff_err.decode(errors='ignore')[:300]}"
    return wav_path, ""


async def transcribe_media(
    media_path: str,
    product_names: list[str],
    *,
    cfg: Config | None = None,
) -> dict[str, Any]:
    """Convert audio media if needed, then transcribe via the active STT provider."""
    active_cfg = cfg or get_config()
    sample_rate = int(
        active_cfg.provider_param("stt", active_cfg.provider("stt"), "sample_rate", 16000)
    )
    wav_path, err = await convert_to_wav16k(media_path, sample_rate=sample_rate)
    if wav_path is None:
        return {"text": "", "provider": active_cfg.provider("stt"), "error": err}
    return await transcribe_wav(wav_path, product_names, cfg=active_cfg)
