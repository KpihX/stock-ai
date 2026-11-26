# Live End-to-End Verification Scenarios (`stock-ai`)

This document lists the reproducible live verification scenarios for the Stock AI platform (`http://localhost:5173` / `http://localhost:8000` locally, `https://stock-ai.kpihx-labs.com` + `https://stock-api.kpihx-labs.com` in production). The backend stack (FastAPI, Node 22 Baileys + `werift` VoIP listener, `nvidia-riva-client`, `ffmpeg`, `tesseract-ocr` `eng+fra`, PostgreSQL 17) runs inside Docker and consumes NVIDIA NIM STT/OCR/LLM services with hot-reloadable configuration in `backend/config.jsonc`.

```
[ WhatsApp Client ] ──(Text / Voice .ogg / Image .png / VoIP Call)──► [ Baileys + werift (:3001) ]
                                                                                  │
                                                          (@lid -> E.164, media download, VAD)
                                                                                  ▼
[ Vercel Admin UI ] ◄──(SSE + WebRTC + pipeline_log)─── [ FastAPI CommandHandler :8000 ]
         │                                                        │
         │                                  ┌─────────────────────┼─────────────────────┐
         │                                  ▼                     ▼                     ▼
         │                        [ NVIDIA Whisper v3 ]  [ Nemotron 3.5 VL ]   [ Phone Allowlist ]
         │                        (Parakeet/whisper fb)  (Tesseract fallback)    (client table)
         │                                  └─────────────────────┼─────────────────────┘
         │                                                        ▼
         │                                      [ EnrichedData + Product Catalogue ]
         │                                      (client_stats + usual_lines + products)
         │                                                        │
         │                                                        ▼
         │                                           [ Nemotron 3 Ultra 550B ]
         │                                    (lookup_products / stats / past orders)
         │                                                        │
         ▼                                                        ▼
[ Approve / Reject + Comment ] ──(POST /send)─────────► [ PostgreSQL client.db ]
```

---

## Baseline Setup & Clean State

| Item | Canonical Value | Verification Command |
|---|---|---|
| Primary Stockline WhatsApp | `33605957785` | `GET /admin/whatsapp/status` → `status: "connected"` |
| Default seeded client (`init.sql`) | `CLI-0001` · `KpihX` · `33745717350` | `make init` / `make seed` |
| Second real test client (added live) | `CLI-0045` · `Yohann Bikele` · `33745746025` | Added via Admin UI → **Clients** |
| Reference product catalogue | `ART-PAIN-01` (`Pain de campagne`, 3.20 €), `ART-TOM-GR-01` (`Tomates grappe`, 2.45 €), `ART-CAB-35` (`Cabillaud 3/5`, 14.90 €) | Added via Admin UI → **Products** |
| Default managers list | `0 managers` (root `admin` only) | Admin UI → **Settings** → **Managers** |

To reset the database to the strict initial baseline (`CLI-0001` only, `0` products, `0` commands, `0` managers):

```bash
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "TRUNCATE TABLE command, product, manager, pipeline_log, client RESTART IDENTITY CASCADE;" && psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f /docker-entrypoint-initdb.d/init.sql'
```

---

## Scenario Matrix

| # | Scenario | Actor / Account | Modality | Input | Expected Pipeline & UI Outcome |
|---|---|---|---|---|---|
| **S1** | **Unregistered contact guard** | `33745746025` (before adding Yohann) | Text | `"Bonjour, je voudrais 2 cabillauds"` | `cmd.handler` logs `command.rejected` (`unknown_client`); LLM is not called; `0` commands created. |
| **S2** | **First-time voice order (STT)** | `CLI-0001` (`33745717350`) | Voice (`.ogg` PTT) | `"Bonjour, je voudrais quatre pains de campagne pour demain matin."` | `stt.whisper` transcribes in-container; `data.enriched` marks `first-time order`; `C-*` created for `4 × ART-PAIN-01` (`3.20 €`); badge `First order`. |
| **S3** | **Approve with manager comment** | Admin UI (`admin`) | HITL Decision | Comment: `"Voice validé : 4 pains livrés demain matin"` + **Approve** | Command status → `approved` (`processed`); `33745717350` receives WhatsApp message with order summary + comment; WhatsApp stays `Connected`. |
| **S4** | **Image purchase order (OCR)** | `CLI-0001` (`33745717350`) | Image (`.png`) | Image text: `"BON DE COMMANDE : Je voudrais 6 Tomates grappe pour demain"` | `ocr.tesseract` extracts text in-container; `data.enriched` marks `returning client`; `C-*` created for `6 × ART-TOM-GR-01` (`2.45 €`); badge `Returning · 2 orders`. |
| **S5** | **Implicit habit order ("comme la dernière fois")** | `CLI-0001` (`33745717350`) | Text | `"Salut, mets-moi comme la dernière fois pour demain"` | Nemotron reads `client_stats.usual_lines` / `lookup_commands` and repeats `6 × ART-TOM-GR-01` (`2.45 €`). |
| **S6** | **Dynamic onboarding of new client + Voice #1** | `CLI-0045` (`33745746025`, Yohann) | UI + Voice (`.ogg` PTT) | Add `CLI-0045` in **Clients**, then send voice: `"Bonjour, j'aimerais deux pains de campagne pour mardi soir, s'il vous plaît."` | `@lid` resolves to `33745746025`; Whisper transcribes (`"maldi soir"` → Tuesday); creates `2 × ART-PAIN-01` (`3.20 €`, `First order`). |
| **S7** | **Phonetic STT correction via injected product catalogue (Voice #2)** | `CLI-0045` (`33745746025`, Yohann) | Voice (`.ogg` PTT) | Voice: `"J'aimerais aussi avoir 10 kilos de tomates grappe, s'il vous plaît."` (STT: `"tomates gras"`) | `EnrichedData.products` supplies the catalogue to Nemotron; `"10 kilos de tomates gras"` maps to `10 × ART-TOM-GR-01` (`Tomates grappe`, `2.45 €`) and never falls back to past products. |
| **S8** | **Image OCR order + Reject with comment** | `CLI-0045` (`33745746025`, Yohann) | Image (`.png`) + HITL | Image: `"BON DE COMMANDE YOHANN : Merci de livrer 3 Cabillaud 3/5 pour jeudi"`, then **Reject** with comment | `ocr.tesseract` extracts `"3 Cabillaud 3/5"`; creates `3 × ART-CAB-35` (`14.90 €`); rejection sends WhatsApp notice + comment to `33745746025`. |
| **S9** | **Implicit habit order ("comme d'habitude")** | `CLI-0045` (`33745746025`, Yohann) | Text | `"Bonjour, je veux comme d'habitude pour mes tomates"` | Nemotron inspects Yohann's history (`lookup_commands` / `usual_lines`) and creates `10 × ART-TOM-GR-01` (`2.45 €`). |
| **S10** | **Client mini-dashboard & Settings Manager CRUD** | Admin UI (`admin`) | UI Interaction | Click client row in **Clients**; create/disable/delete manager in **Settings** | Client profile shows `Orders`, `Total spent (€)`, `Usual product`, `Last order` and full order table; manager CRUD returns cleanly to `0 managers`. |
| **S11** | **Follow-up order adjustment (`action: "modify"`) via Voice or Text** | `CLI-0045` (`33745746025`, Yohann) | Voice (`.ogg`) / Text | `"Finalement sur ma dernière commande de tomates, mets 15 kilos au lieu de 10."` | Nemotron detects `action="modify"` and `target_command_id`; `db.replace_command_group` updates the existing command in-place (`10 -> 15 × ART-TOM-GR-01`), resets status to `new`, and sends a WhatsApp update acknowledgement. |
| **S12** | **Order cancellation (`action: "cancel"`) & stock refund** | `CLI-0001` (`33745717350`, KpihX) | Text / Voice | `"Annule ma dernière commande s'il te plaît"` | Nemotron detects `action="cancel"` and `target_command_id`; status becomes `cancelled` (restoring stock if previously `processed`) and sends a WhatsApp cancellation notice. |
| **S13** | **Automatic stock decrementation on Approve** | Admin UI (`admin`) | HITL Decision | Approve an order of `4 × ART-PAIN-01` (initial stock `80`) | `product.stock` decrements automatically (`80 -> 76`); rejecting/cancelling a processed order restores the stock. |
| **S14** | **Automatic WhatsApp intake acknowledgement** | Any registered client | Text / Voice / Image | Any valid order creation, modification or cancellation | Client immediately receives a WhatsApp ack (`whatsapp.ack` logged on `decision.hitl`) before manager review. |
| **S15** | **Live WhatsApp VoIP call via WebRTC** | Registered client | VoIP Call | Inbound WhatsApp call answered in browser **Calls** tab | Bidirectional 48 kHz Opus audio, live STT transcript per utterance (`nvidia_whisper` / `nvidia_parakeet`), automatic post-hangup order extraction and WhatsApp ack. |
