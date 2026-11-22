# Changelog

## 0.1.0 - 2026-11-22

- Initial uv package scaffold for the Stockline hackathon.
- Added project Makefile with sync, check, smoke, build and push targets.
- Added AGENTS.md, CONTRACT.md, config.py, a minimal Typer CLI, docs and tests.
- Added a provider registry and environment-swappable config for messaging, STT, OCR, TTS, agent LLM and decision bricks.
- Active stack: Baileys, whisper ggml turbo multilingual, Tesseract eng+fra, EdgeTTS, NVIDIA Nemotron Ultra 550B and TypeSafe Jev.
- Moved all defaults, models, URLs and paths into a structured config.jsonc; .env.example now contains secrets only. Added json5 parsing and per-provider overrides with generic parameter names.
- Removed the duplicate .env.example from src/stockline_ai: the template lives at the project root only and config.py loads only the root .env.
- Removed the duplicated version fields from config.py and config.jsonc. The version is now read dynamically from pyproject.toml by stockline_ai.version.get_version().
