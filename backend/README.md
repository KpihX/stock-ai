# stockline-ai

Agentic AI for the food supply chain, built for the X-Forum and Stockline hackathon.

## Goal

A grossiste receives orders by WhatsApp voice note at 4am. Today someone replays them and retypes every line. This project turns that messy input into validated ERP lines, forecasts demand, drafts purchase orders and asks a human before acting.

## Install

```bash
cd backend
uv sync
```

Optional feature sets:

```bash
uv sync --extra forecast   # statsforecast and darts
uv sync --extra voice      # pipecat-ai for the live voice agent
```

Core production dependencies include `fastapi`, `uvicorn[standard]`, `asyncpg`, `openai`, `nvidia-riva-client`, `edge-tts`, `sse-starlette`, `pyjwt`, `pydantic-ai`, `json5`, `httpx`, `typer`, and `rich`. The WhatsApp/WebRTC listener in `backend/wa/` uses Node 22 with `@innovatorssoft/baileys`, `werift`, `opusscript`, `pino`, and `tsx`.

## Usage

```bash
uv run stockline-ai --help
uv run stockline-ai version
uv run stockline-ai status
uv run stockline-api
```

Configuration lives in `backend/config.jsonc`: brick selection, generic settings, per-provider overrides (`nvidia_whisper`, `nvidia_parakeet`, `whisper`, `nemotron_vl`, `tesseract`), prompts (`system_prompt`, `ocr_prompt`), and runtime values. `backend/config.jsonc` is bind-mounted into `/app/config.jsonc` in Docker and hot-reloaded automatically on `mtime` changes without restarting the API container. Everything else, meaning secrets and only secrets, lives in the root `.env`: copy `.env.example` and fill the provider keys. Never commit `.env`.

`uv run stockline-ai providers` shows the active stack and whether each required key is present. To swap a brick (`stt`, `ocr`, `calls`, `tts`, `agent_llm`), edit `selection.*` or `overrides.*` in `backend/config.jsonc`.

## Make targets

Run `make help` for the full list. Main targets: `sync`, `check`, `smoke`, `build`, `uv-link`, `push`.

## Structure

```
config.jsonc        single source of truth for stack selection, prompts and overrides
src/stockline_ai/   package, config.py, providers.py, api/, and thin CLI
wa/                 Node 22 Baileys + werift Opus 48 kHz WebRTC bridge
db/                 PostgreSQL schema/seed helpers
tests/              pytest suite
CONTRACT.md         operation surface, types and error model
```

## Runtime bricks

Active production bricks run via Docker (`backend/Dockerfile`) and NVIDIA NIM APIs: `@innovatorssoft/baileys` + `werift` for WhatsApp & VoIP calls, NVIDIA NIM `openai/whisper-large-v3` (with `nvidia/parakeet-1.1b-rnnt-multilingual-asr` or local `whisper-cli` fallback) for STT, NVIDIA NIM `nvidia/nemotron-3.5-super-vl-120b-a12b` (with `tesseract` `eng+fra` fallback) for OCR/VLM, `edge-tts` for simulated caller audio, and `nvidia/nemotron-3-ultra-550b-a55b` for order extraction.
