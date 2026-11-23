# CONTRACT.md - stockline-ai

Source of truth for the external behavior of this package. Metadata lives in pyproject.toml.

## Purpose

Turn messy supplier orders from WhatsApp voice notes, text and photos into validated ERP lines, then suggest and supervise purchasing. The demo must show one voice order producing clean lines, a demand signal and an approval gate.

## Operations

- `version` (CLI): print the installed package version.
- `status` (CLI): print non-secret runtime configuration.
- `providers` (CLI): inspect active brick selection and required key presence.
- `POST /webhooks/whatsapp` (API): ingest WhatsApp text, voice note, and image signals and normalize them into client orders (`create`, `modify`, `cancel`).
- `GET /api/commands`, `GET /api/commands/stream`, `POST /api/commands/{id}/approve`: list orders, stream real-time SSE pipeline events, and apply HITL approval/rejection with stock updates and WhatsApp acks.
- `/api/calls/*` (API): bridge inbound WhatsApp VoIP calls to browser WebRTC Opus 48 kHz, transcribe caller utterances via STT, and auto-commit orders on hangup.
- `GET/POST /admin/config`, `/admin/products`, `/admin/clients`, `/admin/managers`, `/admin/whatsapp/*`: manage runtime configuration, catalogue, clients, staff, and WhatsApp pairing.
- `forecast` (planned): turn order history into demand estimates per SKU and per day.
- `purchase` (planned): turn a demand gap into a draft PurchaseOrder, never auto approved.

## Data types

- OrderEvent: channel, sender, raw text, optional media path, confidence.
- OrderLine: sku, quantity, unit, customer_id, delivery_date, confidence.
- PurchaseOrder: supplier, lines, total, status in draft or approved.

## Error model

- 0 success.
- 1 operation error with a message on stderr.
- 2 invalid input or missing required argument.
- Every CLI response is a JSON envelope with meta status and data.

## Transport mapping

- CLI: Typer commands (`stockline-ai`) with Rich output.
- HTTP / SSE / WebSocket API: FastAPI (`stockline-api`) deployed behind Traefik HTTPS at `https://stockline-ai.kpihx-labs.com`.
- WhatsApp & VoIP transport: embedded Node 22 listener (`backend/wa/`) using `@innovatorssoft/baileys` and `werift` over localhost HTTP + WebRTC.
