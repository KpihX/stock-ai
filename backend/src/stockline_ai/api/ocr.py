"""Extensible Image OCR / Vision adapter driven by config.jsonc + providers.py.

Supports:
- nemotron_vl (NVIDIA NIM Nemotron 3.5 Super VL 120B multimodal, handles handwritten notes)
- tesseract   (Local Tesseract OCR eng+fra offline fallback)
"""

from __future__ import annotations

import asyncio
import base64
import time
from pathlib import Path
from typing import Any

from openai import AsyncOpenAI

from ..config import Config, get_config
from .errors import sanitize_error


def _detect_mime(raw: bytes, path: Path) -> str:
    if raw.startswith(b"\x89PNG"):
        return "image/png"
    if raw.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if raw.startswith(b"RIFF") and b"WEBP" in raw[:16]:
        return "image/webp"
    ext = path.suffix.lower().lstrip(".")
    return f"image/{'jpeg' if ext in ('jpg', 'jpeg') else (ext or 'png')}"


async def _run_nemotron_vl(
    path: Path,
    product_names: list[str],
    cfg: Config,
) -> dict[str, Any]:
    t0 = time.perf_counter()
    model = str(cfg.provider_param("ocr", "nemotron_vl", "model"))
    base_url = str(cfg.provider_param("ocr", "nemotron_vl", "base_url"))
    temperature = float(cfg.provider_param("ocr", "nemotron_vl", "temperature", 0.0))
    max_tokens = int(cfg.provider_param("ocr", "nemotron_vl", "max_tokens", 512))
    enable_thinking = bool(cfg.provider_param("ocr", "nemotron_vl", "enable_thinking", False))
    timeout_s = float(cfg.provider_param("ocr", "nemotron_vl", "timeout_seconds", 60.0))
    ocr_prompt = str(
        cfg.provider_param("ocr", "nemotron_vl", "prompt", cfg.ocr_prompt) or cfg.ocr_prompt
    )
    if not ocr_prompt:
        raise RuntimeError("ocr_prompt is missing from config.jsonc")
    api_key = cfg.provider_api_key("ocr", "nemotron_vl", required=True)

    raw = path.read_bytes()
    mime = _detect_mime(raw, path)
    b64 = base64.b64encode(raw).decode("ascii")
    vocab = ", ".join(product_names)
    user_text = (
        f"Catalogue reference: {vocab}. Transcribe all text visible on this order image."
        if vocab
        else "Transcribe all text visible on this order image."
    )

    client = AsyncOpenAI(base_url=base_url, api_key=api_key, timeout=timeout_s)
    resp = await client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": ocr_prompt},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": user_text},
                    {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}},
                ],
            },
        ],
        temperature=temperature,
        max_tokens=max_tokens,
        extra_body={"chat_template_kwargs": {"enable_thinking": enable_thinking}},
    )
    extracted = (resp.choices[0].message.content or "").strip()
    return {
        "ocr_raw": extracted,
        "provider": "nemotron_vl",
        "model": model,
        "base_url": base_url,
        "elapsed_ms": round((time.perf_counter() - t0) * 1000),
    }


async def _run_tesseract(path: Path, cfg: Config) -> dict[str, Any]:
    t0 = time.perf_counter()
    ocr_bin = str(cfg.provider_param("ocr", "tesseract", "bin", "tesseract"))
    langs = str(cfg.provider_param("ocr", "tesseract", "languages", "eng+fra"))
    timeout_s = float(cfg.provider_param("ocr", "tesseract", "timeout_seconds", 30.0))
    proc = await asyncio.create_subprocess_exec(
        ocr_bin,
        str(path),
        "stdout",
        "-l",
        langs,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout_s)
    except TimeoutError as exc:
        proc.kill()
        await proc.wait()
        raise TimeoutError(f"tesseract timed out after {timeout_s:.0f}s") from exc
    extracted = " ".join(out.decode(errors="ignore").split()).strip()
    return {
        "ocr_raw": extracted,
        "provider": "tesseract",
        "bin": ocr_bin,
        "languages": langs,
        "returncode": proc.returncode,
        "stderr": err.decode(errors="ignore")[:300],
        "elapsed_ms": round((time.perf_counter() - t0) * 1000),
    }


async def _dispatch_ocr(
    path: Path,
    provider_key: str,
    product_names: list[str],
    cfg: Config,
) -> dict[str, Any]:
    if provider_key == "nemotron_vl":
        return await _run_nemotron_vl(path, product_names, cfg)
    if provider_key == "tesseract":
        return await _run_tesseract(path, cfg)
    raise ValueError(f"Unsupported OCR provider '{provider_key}'")


async def extract_image_text(
    media_path: str,
    caption: str,
    product_names: list[str] | None = None,
    *,
    cfg: Config | None = None,
) -> dict[str, Any]:
    """Extract text from a printed or handwritten image using the active OCR brick."""
    active_cfg = cfg or get_config()
    clean_caption = "" if caption == "[image]" else caption.strip()
    path = Path(media_path)
    if not path.is_file():
        return {
            "text": clean_caption,
            "provider": active_cfg.provider("ocr"),
            "error": f"Image file not found: {media_path}",
        }

    names = product_names or []
    primary = active_cfg.provider("ocr")
    try:
        res = await _dispatch_ocr(path, primary, names, active_cfg)
    except Exception as exc:
        clean_err = sanitize_error(exc)
        fallback = active_cfg.fallback_for("ocr")
        if fallback and fallback != primary:
            try:
                res = await _dispatch_ocr(path, fallback, names, active_cfg)
                res["fallback_from"] = primary
                res["primary_error"] = clean_err
            except Exception as fb_exc:
                return {
                    "text": clean_caption,
                    "provider": fallback,
                    "fallback_from": primary,
                    "primary_error": clean_err,
                    "error": f"{clean_err} | fallback {fallback}: {sanitize_error(fb_exc)}",
                }
        else:
            return {"text": clean_caption, "provider": primary, "error": clean_err}

    extracted = str(res.get("ocr_raw", "")).strip()
    combined = (
        f"{clean_caption} {extracted}".strip()
        if clean_caption and extracted
        else (extracted or clean_caption)
    )
    return {**res, "text": combined, "caption": clean_caption}
