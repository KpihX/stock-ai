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

from ..config import CONFIG, Config, get_secret
from ..providers import get_spec


def _provider_param(cfg: Config, provider_key: str, name: str, default: str = "") -> str:
    override = (cfg.overrides.get("stt") or {}).get(provider_key) or {}
    if name in override:
        return str(override[name])
    settings = cfg.settings.get("stt") or {}
    if name in settings and name not in ("model", "base_url", "function_id"):
        return str(settings[name])
    spec = get_spec("stt", provider_key)
    if name == "model" and provider_key == cfg.provider("stt") and "model" in settings:
        return str(settings["model"])
    val = getattr(spec, name, None)
    return str(val) if val else default


def _provider_api_key(provider_key: str) -> str:
    spec = get_spec("stt", provider_key)
    for env_name in spec.api_key_env:
        val = get_secret(env_name, required=False)
        if val:
            return val
    return ""


def _riva_recognize_sync(
    audio_bytes: bytes,
    uri: str,
    function_id: str,
    api_key: str,
    language_code: str,
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
        sample_rate_hertz=16000,
        language_code=language_code,
        max_alternatives=1,
        enable_automatic_punctuation=True,
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
    uri = _provider_param(cfg, provider_key, "base_url", "grpc.nvcf.nvidia.com:443")
    function_id = _provider_param(cfg, provider_key, "function_id")
    model = _provider_param(cfg, provider_key, "model")
    lang_default = "multi" if provider_key == "nvidia_parakeet" else "fr"
    language = _provider_param(cfg, provider_key, "language", lang_default)
    api_key = _provider_api_key(provider_key)
    if not api_key:
        raise RuntimeError(f"Missing NVIDIA_API_KEY for STT provider '{provider_key}'")
    if not function_id:
        raise RuntimeError(f"Missing function_id for STT provider '{provider_key}'")

    audio_bytes = wav_path.read_bytes()
    transcript = await asyncio.to_thread(
        _riva_recognize_sync,
        audio_bytes,
        uri,
        function_id,
        api_key,
        language,
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
    whisper_bin = _provider_param(cfg, "whisper", "bin", "whisper-cli") or "whisper-cli"
    model_name = _provider_param(cfg, "whisper", "model", "ggml-large-v3-turbo-q5_0.bin")
    language = _provider_param(cfg, "whisper", "language", "fr") or "fr"
    model_path = cfg.stt_models_dir / model_name
    vocab = (
        ", ".join(product_names) if product_names else "pain de campagne, tomates grappe, cabillaud"
    )
    prompt = (
        f"Commande alimentaire grossiste en français. Catalogue : {vocab}. "
        "Unités : kilos, kg, pièces, unités, caisses, pour demain, lundi, mardi soir, mercredi."
    )
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
    cfg: Config = CONFIG,
) -> dict[str, Any]:
    """Transcribe a 16 kHz mono WAV file using the active STT brick (with optional fallback)."""
    if not wav_path.is_file():
        return {"text": "", "error": f"WAV file not found: {wav_path}"}

    primary = cfg.provider("stt")
    try:
        return await _dispatch_wav(wav_path, primary, product_names, cfg)
    except Exception as exc:
        fallback = cfg.fallback_for("stt")
        if fallback and fallback != primary:
            res = await _dispatch_wav(wav_path, fallback, product_names, cfg)
            res["fallback_from"] = primary
            res["primary_error"] = str(exc)
            return res
        return {"text": "", "provider": primary, "error": str(exc)}


async def convert_to_wav16k(media_path: str) -> tuple[Path | None, str]:
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
        "16000",
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
    cfg: Config = CONFIG,
) -> dict[str, Any]:
    """Convert audio media if needed, then transcribe via the active STT provider."""
    wav_path, err = await convert_to_wav16k(media_path)
    if wav_path is None:
        return {"text": "", "provider": cfg.provider("stt"), "error": err}
    return await transcribe_wav(wav_path, product_names, cfg=cfg)
