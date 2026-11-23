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

from ..config import CONFIG, Config, get_secret
from ..providers import get_spec


def _provider_param(cfg: Config, provider_key: str, name: str, default: str = "") -> str:
    override = (cfg.overrides.get("ocr") or {}).get(provider_key) or {}
    if name in override:
        return str(override[name])
    settings = cfg.settings.get("ocr") or {}
    if name in settings and name not in ("model", "base_url"):
        return str(settings[name])
    spec = get_spec("ocr", provider_key)
    if name == "model" and provider_key == cfg.provider("ocr") and "model" in settings:
        return str(settings["model"])
    val = getattr(spec, name, None)
    return str(val) if val else default


def _provider_api_key(provider_key: str) -> str:
    spec = get_spec("ocr", provider_key)
    for env_name in spec.api_key_env:
        val = get_secret(env_name, required=False)
        if val:
            return val
    return ""


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
    model = _provider_param(cfg, "nemotron_vl", "model")
    base_url = _provider_param(cfg, "nemotron_vl", "base_url")
    api_key = _provider_api_key("nemotron_vl")
    if not api_key:
        raise RuntimeError("Missing NVIDIA_API_KEY for OCR provider 'nemotron_vl'")

    raw = path.read_bytes()
    mime = _detect_mime(raw, path)
    b64 = base64.b64encode(raw).decode("ascii")
    vocab = (
        ", ".join(product_names)
        if product_names
        else "Pain de campagne, Tomates grappe, Cabillaud 3/5"
    )

    client = AsyncOpenAI(base_url=base_url, api_key=api_key, timeout=60.0)
    resp = await client.chat.completions.create(
        model=model,
        messages=[
            {
                "role": "system",
                "content": (
                    "You are a precision OCR and handwritten order reader for a French "
                    "food wholesaler. Transcribe verbatim every product, quantity, unit, "
                    "client note, and delivery date visible on the image (handwritten, "
                    "cursive, or printed). Reply with the extracted text only."
                ),
            },
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": (
                            f"Catalogue reference: {vocab}. "
                            "Transcribe all text visible on this order image."
                        ),
                    },
                    {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}},
                ],
            },
        ],
        temperature=0.0,
        max_tokens=512,
        extra_body={"chat_template_kwargs": {"enable_thinking": False}},
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
    ocr_bin = _provider_param(cfg, "tesseract", "bin", "tesseract") or "tesseract"
    langs = _provider_param(cfg, "tesseract", "languages", "eng+fra") or "eng+fra"
    proc = await asyncio.create_subprocess_exec(
        ocr_bin,
        str(path),
        "stdout",
        "-l",
        langs,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out, err = await proc.communicate()
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
    cfg: Config = CONFIG,
) -> dict[str, Any]:
    """Extract text from a printed or handwritten image using the active OCR brick."""
    clean_caption = "" if caption == "[image]" else caption.strip()
    path = Path(media_path)
    if not path.is_file():
        return {
            "text": clean_caption,
            "provider": cfg.provider("ocr"),
            "error": f"Image file not found: {media_path}",
        }

    names = product_names or []
    primary = cfg.provider("ocr")
    try:
        res = await _dispatch_ocr(path, primary, names, cfg)
    except Exception as exc:
        fallback = cfg.fallback_for("ocr")
        if fallback and fallback != primary:
            res = await _dispatch_ocr(path, fallback, names, cfg)
            res["fallback_from"] = primary
            res["primary_error"] = str(exc)
        else:
            return {"text": clean_caption, "provider": primary, "error": str(exc)}

    extracted = str(res.get("ocr_raw", "")).strip()
    combined = (
        f"{clean_caption} {extracted}".strip()
        if clean_caption and extracted
        else (extracted or clean_caption)
    )
    return {**res, "text": combined, "caption": clean_caption}
