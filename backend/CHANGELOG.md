# Changelog

## 0.2.0 - 2026-11-23

- Added live inbound WhatsApp VoIP call bridge via `@innovatorssoft/baileys` (`sock.getVoipClient()`), `werift` + `opusscript` (48 kHz Opus WebRTC), WASM `eventType === 2` postinstall patch, and VAD utterance sequencing (`in_flight` + `utterance_seq`) with automatic post-hangup order extraction.
- Added extensible NVIDIA NIM STT (`nvidia_whisper` using `openai/whisper-large-v3` and `nvidia_parakeet` using `nvidia/parakeet-1.1b-rnnt-multilingual-asr` via `nvidia-riva-client`) and Vision OCR (`nemotron_vl` using `nvidia/nemotron-3.5-super-vl-120b-a12b`) with automatic fallbacks.
- Exposed all provider parameters, `ocr_prompt`, `system_prompt`, and `overrides` in `backend/config.jsonc`, bind-mounted it into Docker, and added mtime-based `get_config()` hot-reloading.
- Made `backend/db/init.sql` self-contained (`CREATE TABLE IF NOT EXISTS client`), derived FastAPI `version` from `get_version()`, and wrapped `.decision-cell` action buttons on compact dashboard tables.
- Slimmed `backend/Dockerfile` for production deployment on the homelab PVE server with Traefik HTTPS (`stock-api.kpihx-labs.com`) and deployed the Vercel React frontend (`stock-ai.kpihx-labs.com` / `stock-ai.vercel.app`) with Cloudflare Access cleared for public API CORS/SSE/WebSocket traffic.

## 0.1.0 - 2026-11-22

- Initial uv package scaffold for the Stockline hackathon.
- Added project Makefile with sync, check, smoke, build and push targets.
- Added AGENTS.md, CONTRACT.md, config.py, a minimal Typer CLI, docs and tests.
- Added a provider registry and environment-swappable config for messaging, STT, OCR, TTS, agent LLM and decision bricks.
- Active stack: Baileys, whisper ggml turbo multilingual, Tesseract eng+fra, EdgeTTS, NVIDIA Nemotron Ultra 550B and TypeSafe Jev.
- Moved all defaults, models, URLs and paths into a structured config.jsonc; .env.example now contains secrets only. Added json5 parsing and per-provider overrides with generic parameter names.
- Removed the duplicate .env.example from src/stockline_ai: the template lives at the project root only and config.py loads only the root .env.
- Removed the duplicated version fields from config.py and config.jsonc. The version is now read dynamically from pyproject.toml by stockline_ai.version.get_version().
