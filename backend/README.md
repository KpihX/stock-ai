# stockline-ai

Agentic AI for the food supply chain, built for the X-Forum and Stockline hackathon.

## Goal

A grossiste receives orders by WhatsApp voice note at 4am. Today someone replays them and retypes every line. This project turns that messy input into validated ERP lines, forecasts demand, drafts purchase orders and asks a human before acting.

## Install

```bash
cd ~/Labs/stockline-ai
uv sync
```

Optional feature sets:

```bash
uv sync --extra forecast   # statsforecast and darts
uv sync --extra voice      # pipecat-ai for the live voice agent
```

## Usage

```bash
uv run stockline-ai --help
uv run stockline-ai version
uv run stockline-ai status
```

Configuration lives in `config.jsonc`: brick selection, generic settings, optional per-provider overrides and runtime values. Paths use `~` so the project stays portable. Everything else, meaning secrets and only secrets, lives in `.env`: copy `.env.example` and fill the provider keys when the real agents land. Never commit that file.

`uv run stockline-ai providers` shows the active stack and whether each required key is present. To swap a brick, change one id in `config.jsonc`, or add an entry under `overrides` for provider specific parameters.

## Make targets

Run `make help` for the full list. Main targets: `sync`, `check`, `smoke`, `build`, `uv-link`, `push`.

## Structure

```
src/stockline_ai/   package, config.py and the thin CLI
tests/              pytest suite
tmp/                gitignored scratch, nothing lands in src before validation
CONTRACT.md         operation surface, types and error model
```

## External runtime

This project calls tools already installed on the machine rather than embedding them: whats-proxy for WhatsApp, whisper-cli for speech to text, k-piper for text to speech and tesseract for OCR. See AGENTS.md for the full list.
