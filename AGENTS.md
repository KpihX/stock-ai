# AGENTS.md - stockline-ai

Project context for all AI agents working in this repository. Loaded automatically at the project root.

## Mantras

Problem First, Why before How, Visualization.
0 Trust and 100 percent Control. 0 Magic and 100 percent Transparency. 0 Hardcoding and 100 percent Flexibility.

## Reply Gate

Before replying, check: an ASCII diagram for the main idea, a table for comparisons, full connected sentences, then diagram, table, paragraphs.

## Purpose

Stockline AI is the hackathon project for the X-Forum and Stockline event. It builds agentic AI for the food supply chain: WhatsApp voice orders converted into ERP lines, demand forecasting, supervised purchasing and a live voice ordering agent. The deliverable is a 24 hour demo plus a pitch.

## Stack

Python 3.12 or newer, uv, package stockline_ai, CLI stockline-ai.
Core libraries from pyproject.toml: typer, rich, pydantic, pydantic-ai, httpx, python-dotenv.
Optional extras: forecast for statsforecast and darts, voice for pipecat-ai.
External runtime already installed on this machine: whats-proxy for Baileys and the WhatsApp store, whisper-cli and k-whisper for speech to text, k-piper for text to speech, tesseract for OCR.

## Hard rules

- Use uv only. Never pip, never python -m pip, never uv pip for agent work. Add a library with uv add.
- Run scripts with uv run. Use make targets for checks, builds and pushes.
- config.jsonc at the project root is the single source of truth for every default, model id, URL and path. It is structured in four sections: selection, settings, overrides and runtime.
- .env.example lists secrets only and lives at the project root, always. Never put a default, a model id, a URL or a path in it, and never create a second copy inside src/ or any subdirectory. config.py is a typed view over config.jsonc plus the provider registry, with no hardcoded values, and it loads only the root .env.
- The package version has exactly one source: the project.version field in pyproject.toml. Read it with stockline_ai.version.get_version(). Never write a version literal in code, config.jsonc, docs or the CLI. Derive it everywhere.
- No information is duplicated in two places. One source of truth per value, derive or reference it everywhere else: pyproject.toml for metadata, config.jsonc for configuration, providers.py for provider ids and defaults. Prefer a dynamic read over a copy.
- Starting 2026-11-22 the agent must never edit anything under .agents/. No file, no exception, including logs, skills, rules or context. This is a standing rule for every future session in this project.
- No hardcoded absolute paths. Use Path.home() or the paths declared in config.py.
- English for all files and comments. Match the language of the chat for replies.
- Public API explicit, internals prefixed with an underscore, no god modules.
- Fail loud at boundaries. Never silently swallow errors.
- Agent output stays in tmp/ until the user validates it. Nothing lands in src/ before validation.
- No raw sudo in agent shells. No em dashes or smart quotes in committed docs.

## Layout

config.jsonc at the root holds the structured configuration. The src/stockline_ai package holds the code. providers.py is the brick registry, config.py is the typed and provider aware view over config.jsonc, cli.py is the thin Typer entry point. Future agents/ modules will hold one agent per concern. Future tools/ modules will hold external adapters.
tests/ holds pytest tests. tmp/ is gitignored scratch. CONTRACT.md defines the operation surface and the error model before implementation grows.

## Workflow

1. Check pyproject.toml before adding a dependency.
2. Prototype in tmp/ with uv run.
3. Promote validated code into src/ with a small edit.
4. Run make check before any commit.
5. Use make push, never a raw git push.

## Docs

README.md is user facing. CHANGELOG.md is newest first. TODO.md is the active backlog. AGENTS.md is this file and is not committed.
