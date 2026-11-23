# stock-ai

Agentic AI intake, order normalization, and human-in-the-loop (HITL) approval platform for food supply chain wholesalers.

## Production URLs

| Surface | URL | Hosting |
| --- | --- | --- |
| Admin Dashboard (Frontend) | https://stock-ai.kpihx-labs.com (alias `https://stock-ai.vercel.app`) | Vercel (React + Vite + TypeScript) |
| API & WhatsApp/VoIP Bridge | https://stock-api.kpihx-labs.com | Proxmox Homelab Docker + Traefik HTTPS |
| Health Check | https://stock-api.kpihx-labs.com/health | FastAPI (`{"status":"ok"}`) |

## Architecture Overview

```
WhatsApp Client (Text / Voice .ogg / Image .png / VoIP Call)
        |
        v
[ Baileys Listener + werift 48 kHz Opus WebRTC Bridge (:3001) ]
        |
        v
[ FastAPI Pipeline & CommandHandler (:8000) ] <---> [ PostgreSQL 17 ]
   |-- STT : NVIDIA NIM Whisper Large v3 (gRPC) -> fallback NVIDIA Parakeet / local whisper
   |-- OCR : NVIDIA NIM Nemotron 3.5 Super VL 120B -> fallback Tesseract eng+fra
   |-- LLM : NVIDIA NIM Nemotron 3 Ultra 550B (create / modify / cancel + catalogue matching)
   |-- SSE : /api/commands/stream -> Live Dashboard updates
   +-- HITL: Approve / Reject + comment -> Stock update + WhatsApp acknowledgement
```

## Key Features

- **Omnichannel WhatsApp intake**: text messages, `.ogg` voice notes, handwritten/printed order photos, and live inbound WhatsApp VoIP calls.
- **Browser WebRTC live calls**: inbound WhatsApp VoIP calls (`@innovatorssoft/baileys`) are bridged via `werift` + `opusscript` (48 kHz Opus) directly to the React Calls tab with VAD utterance segmentation and automatic post-hangup order extraction.
- **Hot-reload single source of truth**: all providers, models, endpoints, NVIDIA function IDs, prompts, temperatures, and VAD/WebRTC thresholds live in `backend/config.jsonc` (bind-mounted into Docker `/app/config.jsonc` and reloaded automatically on mtime change without restarting).
- **Human-in-the-Loop approval gate**: managers approve or reject normalized orders with comments; stock decrements on approval and clients receive automatic WhatsApp confirmations.

## Stack & Dependencies

### Backend (`backend/`)
- **Runtime**: Python >= 3.12 (`uv`), Node 22 (`tsx`), PostgreSQL 17, `ffmpeg`, `tesseract-ocr` (`eng` + `fra`)
- **Python packages**: `fastapi`, `uvicorn[standard]`, `asyncpg`, `pydantic`, `pydantic-ai`, `openai`, `nvidia-riva-client`, `edge-tts`, `sse-starlette`, `pyjwt`, `json5`, `httpx`, `typer`, `rich`, `python-dotenv`
- **Node WhatsApp/VoIP bridge (`backend/wa/`)**: `@innovatorssoft/baileys`, `werift`, `opusscript`, `pino`, `tsx`

### Frontend (`frontend/`)
- **Runtime**: Node >= 20.19, React 19, Vite 7, TypeScript 5.8
- **Deployment**: Vercel (`vercel.json` SPA rewrites, `VITE_API_BASE_URL` pointing to `https://stock-api.kpihx-labs.com` in production)

## Quick Start (Local)

```bash
make setup    # creates .env, docker-compose.override.yml, installs uv + npm deps, seeds DB
make dev      # runs FastAPI (:8000) and Vite (:5173) locally against PostgreSQL
```

Or run the full Docker stack locally:

```bash
make up       # builds and starts stock-postgres + stock-api
make logs     # follows stock-api logs
```

## Verification & Deployment

```bash
make help             # lists all root Makefile targets
make init             # generates .env + docker-compose.override.yml and seeds DB
make seed             # brings stack up and runs backend/db/init.sql
make seed-random      # seeds random clients, products and commands
make setup            # init + uv sync + npm install
make db / make db-logs
make backend / make frontend / make dev
make up / make down / make logs / make ps
make check            # ruff format/lint, py_compile, pyright, pytest
make push             # pushes current branch to GitLab first, then GitHub
make deploy-frontend  # deploys frontend/ to Vercel production
```

Production backend deployment is automated on push to `main` via `.gitlab-ci.yml` (`homelab` runner -> `docker compose -p stock-ai up -d --build`).
