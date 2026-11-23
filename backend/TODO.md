# TODO.md

## Done

- [x] A0 ingestion: WhatsApp multi-modality intake (text, `.ogg` voice notes, images, and inbound VoIP calls) via Baileys + NVIDIA NIM STT/OCR.
- [x] A2 extraction: structured order action normalization (`create`, `modify`, `cancel`) with `nvidia/nemotron-3-ultra-550b-a55b` and catalogue matching.
- [x] A3 customer memory: PostgreSQL 17 client stats, `last_order_lines`, `usual_lines`, and open command history.
- [x] Human-in-the-loop approval gate: Approve/Reject with comments, automatic stock adjustment, and WhatsApp client notifications.
- [x] Live voice lane: bidirectional 48 kHz Opus WebRTC bridge (`werift` + `opusscript` + Baileys VoIP) in the React Calls tab.
- [x] Production deployment: PVE Docker + Traefik backend (`stock-api.kpihx-labs.com`) and Vercel React dashboard (`stock-ai.kpihx-labs.com` / `stock-ai.vercel.app`).

## Active backlog

- [ ] Implement A4 demand forecasting with statsforecast and a LightGBM baseline.
- [ ] Implement A5 purchasing suggestions with draft purchase orders and human approval.
- [ ] Polish dashboard `.decision-cell` spacing on narrow 2-column cards.
