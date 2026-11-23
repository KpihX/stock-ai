"""CommandHandler and the ingestion pipeline from Signal to NormalizedInput."""

from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

from ..config import CONFIG
from . import db, whats
from .llm import normalize
from .schemas import ClientStats, EnrichedData, OrderLine, Product, Signal

_event_bus: Any = None
_seen_events: set[str] = set()


def set_event_bus(bus: Any) -> None:
    global _event_bus
    _event_bus = bus


async def publish(event: dict[str, Any]) -> None:
    print(
        f"[pipeline] type={event.get('type')} node={event.get('node')} "
        f"phone={event.get('phone_number', '')} client={event.get('client_id', '')} "
        f"status={event.get('status', '')} msg={event.get('message', '')}",
        flush=True,
    )
    log_row: dict[str, Any] | None = None
    try:
        log_row = await db.insert_pipeline_log(
            {
                "event_type": str(event.get("type", "event")),
                "node_id": str(event.get("node", "")),
                "client_id": str(event.get("client_id", "")),
                "phone_number": str(event.get("phone_number", "")),
                "command_id": str(event.get("command_id", "")),
                "actor": str(event.get("actor", "")),
                "status": str(event.get("status", "")),
                "message": str(event.get("message", "")),
                "payload": event,
            }
        )
    except Exception:
        log_row = None
    if _event_bus is not None:
        enriched = dict(event)
        if log_row is not None:
            enriched["log_id"] = log_row["log_id"]
            enriched["created_at"] = log_row["created_at"].isoformat()
        await _event_bus.publish(enriched)


async def run_tool(name: str, args: dict[str, Any]) -> dict[str, Any]:
    """Only read-only operations are exposed to the model."""
    client_id = str(args.get("client_id", ""))
    if name == "lookup_products":
        products = await db.fetch_products()
        await publish(
            {
                "type": "tool.called",
                "node": "llm.nemotron",
                "client_id": client_id,
                "status": "ok",
                "message": f"lookup_products -> {len(products)} catalogue items",
                "tool": name,
                "count": len(products),
            }
        )
        return {"products": products}
    if name == "lookup_client_stats":
        stats = await db.fetch_client_stats(client_id)
        await publish(
            {
                "type": "tool.called",
                "node": "llm.nemotron",
                "client_id": client_id,
                "status": "ok",
                "message": (
                    f"lookup_client_stats({client_id}) -> "
                    f"{stats['order_count']} orders, usual={stats['usual_product'] or 'none'}"
                ),
                "tool": name,
                "stats": stats,
            }
        )
        return stats
    if name == "lookup_commands":
        cmds = await db.fetch_recent_commands(client_id, int(args.get("limit", 5)))
        await publish(
            {
                "type": "tool.called",
                "node": "llm.nemotron",
                "client_id": client_id,
                "status": "ok",
                "message": f"lookup_commands({client_id}) -> {len(cmds)} past orders",
                "tool": name,
                "count": len(cmds),
            }
        )
        return {"commands": cmds}
    raise ValueError(f"Unknown tool: {name}")


def _parse_dt(value: Any, fallback: datetime) -> datetime:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=UTC)
    if isinstance(value, str) and value.strip():
        try:
            parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)
        except ValueError:
            return fallback
    return fallback


def _parse_date(value: Any, fallback: date) -> date:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, str) and value.strip():
        try:
            return date.fromisoformat(value.strip()[:10])
        except ValueError:
            return fallback
    return fallback


def _base_cmd_id(command_id: str) -> str:
    parts = command_id.split("-")
    return f"{parts[0]}-{parts[1]}" if len(parts) >= 2 else command_id


def _to_order_line(row: dict[str, Any]) -> OrderLine:
    return OrderLine(
        command_id=row["command_id"],
        product_id=row["product_id"],
        client_id=row["client_id"],
        recorded_at=row["recorded_at"],
        delivery_date=datetime.combine(row["delivery_date"], datetime.min.time(), tzinfo=UTC),
        price=float(row["price"]),
        quantity=float(row["quantity"]),
    )


async def _send_auto_ack(
    phone: str, client_id: str, command_id: str, action: str, summary: str
) -> bool:
    if not phone:
        return False
    if action == "modify":
        text = (
            f"Stockline · Votre commande {command_id} a été mise à jour : "
            f"{summary} (en attente de validation)."
        )
    elif action == "cancel":
        text = f"Stockline · Votre commande {command_id} a bien été annulée. {summary}".strip()
    else:
        text = (
            f"Stockline · Commande {command_id} bien reçue : {summary} (en attente de validation)."
        )
    try:
        await whats.send_ack(phone, text)
        await publish(
            {
                "type": "whatsapp.ack",
                "node": "decision.hitl",
                "client_id": client_id,
                "phone_number": phone,
                "command_id": command_id,
                "status": "sent",
                "message": f"Auto-ack ({action}) sent to WhatsApp {phone} for {command_id}",
                "text": text,
            }
        )
        return True
    except Exception as exc:
        await publish(
            {
                "type": "whatsapp.ack",
                "node": "decision.hitl",
                "client_id": client_id,
                "phone_number": phone,
                "command_id": command_id,
                "status": "warn",
                "message": f"Auto-ack failed for {command_id}: {exc}",
            }
        )
        return False


def _digits(value: str) -> str:
    head = value.split("@", 1)[0].split(":", 1)[0]
    return "".join(ch for ch in head if ch.isdigit())


async def transcribe_wav_file(wav_path: Path, product_names: list[str]) -> dict[str, Any]:
    """Run whisper-cli directly on a 16 kHz mono WAV file using the catalogue prompt."""
    if not wav_path.is_file():
        return {"text": "", "error": f"WAV file not found: {wav_path}"}
    whisper_bin = CONFIG.bin_for("stt") or "whisper-cli"
    model_path = CONFIG.stt_models_dir / CONFIG.model_for("stt")
    vocab = (
        ", ".join(product_names) if product_names else "pain de campagne, tomates grappe, cabillaud"
    )
    prompt = (
        f"Commande alimentaire grossiste en français. Catalogue : {vocab}. "
        "Unités : kilos, kg, pièces, unités, caisses, pour demain, lundi, mardi soir, mercredi."
    )
    proc = await asyncio.create_subprocess_exec(
        whisper_bin,
        "-m",
        str(model_path),
        "-l",
        "fr",
        "--prompt",
        prompt,
        "-nt",
        "-np",
        "-f",
        str(wav_path),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out, err = await proc.communicate()
    transcript = " ".join(out.decode(errors="ignore").split()).strip()
    return {
        "text": transcript,
        "wav_path": str(wav_path),
        "bin": whisper_bin,
        "model": str(model_path),
        "prompt": prompt,
        "returncode": proc.returncode,
        "stderr": err.decode(errors="ignore")[:300],
    }


async def _transcribe_audio(media_path: str, product_names: list[str]) -> dict[str, Any]:
    path = Path(media_path)
    if not path.is_file():
        return {"text": "", "error": f"Audio file not found: {media_path}"}
    wav_path = path.with_suffix(".wav")
    ff = await asyncio.create_subprocess_exec(
        "ffmpeg",
        "-y",
        "-i",
        str(path),
        "-ar",
        "16000",
        "-ac",
        "1",
        str(wav_path),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, ff_err = await ff.communicate()
    if ff.returncode != 0 or not wav_path.is_file():
        return {
            "text": "",
            "error": f"ffmpeg failed ({ff.returncode}): {ff_err.decode(errors='ignore')[:300]}",
        }
    return await transcribe_wav_file(wav_path, product_names)


async def _extract_ocr(media_path: str, caption: str) -> dict[str, Any]:
    path = Path(media_path)
    if not path.is_file():
        return {"text": caption, "error": f"Image file not found: {media_path}"}
    ocr_bin = CONFIG.bin_for("ocr") or "tesseract"
    langs = CONFIG.model_for("ocr") or "eng+fra"
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
    clean_caption = "" if caption == "[image]" else caption.strip()
    combined = f"{clean_caption} {extracted}".strip() if clean_caption else extracted
    return {
        "text": combined,
        "ocr_raw": extracted,
        "caption": clean_caption,
        "bin": ocr_bin,
        "languages": langs,
        "returncode": proc.returncode,
        "stderr": err.decode(errors="ignore")[:300],
    }


async def handle_signal(signal: Signal) -> dict[str, Any]:
    """The CommandHandler: enrich the Data with client id, client stats and product catalogue."""
    phone = _digits(signal.cNumber or signal.actor_ref)
    event_key = (signal.evenement_id or signal.message_id or "").strip()
    if event_key:
        if event_key in _seen_events:
            await publish(
                {
                    "type": "signal.duplicate",
                    "node": "cmd.handler",
                    "phone_number": phone,
                    "status": "ignored",
                    "message": f"Skipped duplicate event {event_key} from {phone}",
                }
            )
            return {"status": "duplicate", "evenement_id": event_key}
        _seen_events.add(event_key)
        if len(_seen_events) > 2000:
            _seen_events.pop()

    channel_node = (
        "channel.call"
        if signal.canal == "call"
        else (
            "channel.voice"
            if signal.modality == "audio"
            else ("channel.image" if signal.modality == "image" else "channel.text")
        )
    )
    await publish(
        {
            "type": "signal.received",
            "node": channel_node,
            "phone_number": phone,
            "status": "received",
            "message": (
                f"Inbound {signal.modality} signal from "
                f"{phone or signal.actor_ref}: {signal.texte[:120]}"
            ),
            "signal": signal.model_dump(mode="json"),
        }
    )

    client = await db.fetch_client_by_phone(phone)
    if client is None:
        await publish(
            {
                "type": "command.rejected",
                "node": "cmd.handler",
                "phone_number": phone,
                "status": "rejected",
                "reason": "unknown_client",
                "message": (
                    f"Ignored unregistered contact {phone or signal.actor_ref} "
                    "(not in client database)"
                ),
                "signal": signal.model_dump(mode="json"),
            }
        )
        return {"status": "rejected", "reason": "unknown_client", "phone_number": phone}

    product_rows = await db.fetch_products()
    catalogue = [Product(**p) for p in product_rows]
    product_names = [str(p["product_name"]) for p in product_rows]

    if signal.modality == "audio":
        if signal.media_path:
            stt_res = await _transcribe_audio(signal.media_path, product_names)
            if stt_res.get("text"):
                signal = signal.model_copy(update={"texte": str(stt_res["text"])})
            await publish(
                {
                    "type": "stt.transcribed",
                    "node": "stt.whisper",
                    "client_id": client["client_id"],
                    "phone_number": phone,
                    "status": "ok" if stt_res.get("text") else "rejected",
                    "message": (
                        f"Whisper transcript: {signal.texte[:140]}"
                        if stt_res.get("text")
                        else f"Whisper failed: {stt_res.get('error', 'empty transcript')}"
                    ),
                    "stt": stt_res,
                }
            )
        else:
            await publish(
                {
                    "type": "stt.transcribed",
                    "node": "stt.whisper",
                    "client_id": client["client_id"],
                    "phone_number": phone,
                    "status": "ok",
                    "message": f"Whisper transcript (pre-supplied): {signal.texte[:140]}",
                }
            )
        if not signal.texte or signal.texte == "[voice]":
            return {"status": "rejected", "reason": "empty_transcript", "phone_number": phone}

    if signal.modality == "image":
        if signal.media_path:
            ocr_res = await _extract_ocr(signal.media_path, signal.texte)
            if ocr_res.get("text"):
                signal = signal.model_copy(update={"texte": str(ocr_res["text"])})
            await publish(
                {
                    "type": "ocr.extracted",
                    "node": "ocr.tesseract",
                    "client_id": client["client_id"],
                    "phone_number": phone,
                    "status": "ok" if ocr_res.get("text") else "rejected",
                    "message": (
                        f"Tesseract OCR: {signal.texte[:140]}"
                        if ocr_res.get("text")
                        else f"Tesseract failed: {ocr_res.get('error', 'empty text')}"
                    ),
                    "ocr": ocr_res,
                }
            )
        if not signal.texte or signal.texte == "[image]":
            return {"status": "rejected", "reason": "empty_ocr", "phone_number": phone}

    stats = await db.fetch_client_stats(client["client_id"])
    prior_orders = int(stats["order_count"])
    is_new_client = prior_orders == 0
    recent_rows = await db.fetch_recent_commands(client["client_id"], 20)
    active_rows = [r for r in recent_rows if str(r.get("status")) != "cancelled"]

    last_order_lines: list[OrderLine] = []
    if active_rows:
        latest_base = _base_cmd_id(str(active_rows[0]["command_id"]))
        last_order_lines = [
            _to_order_line(r)
            for r in active_rows
            if _base_cmd_id(str(r["command_id"])) == latest_base
        ]

    seen_products: set[str] = set()
    usual_lines: list[OrderLine] = []
    for row in active_rows:
        pid = str(row["product_id"])
        if pid not in seen_products:
            seen_products.add(pid)
            usual_lines.append(_to_order_line(row))

    open_commands = [
        {
            "command_id": _base_cmd_id(str(r["command_id"])),
            "line_id": str(r["command_id"]),
            "product_id": str(r["product_id"]),
            "product_name": str(r.get("product_name") or r["product_id"]),
            "quantity": float(r["quantity"]),
            "price": float(r["price"]),
            "delivery_date": str(r["delivery_date"]),
            "status": str(r["status"]),
            "summary": str(r.get("summary") or ""),
        }
        for r in active_rows[:10]
    ]

    enriched = EnrichedData(
        client_id=client["client_id"],
        cNumber=phone,
        client_stats=ClientStats(
            client_id=client["client_id"],
            client_name=client["client_name"],
            phone_number=client["phone_number"],
            order_count=prior_orders,
            last_order_lines=last_order_lines,
            usual_lines=usual_lines,
        ),
        products=catalogue,
        open_commands=open_commands,
        signal=signal,
        is_new_client=is_new_client,
    )
    tier_label = (
        "first-time order" if is_new_client else f"returning client ({prior_orders} past orders)"
    )
    await publish(
        {
            "type": "command.enriched",
            "node": "data.enriched",
            "client_id": client["client_id"],
            "phone_number": phone,
            "status": "new_client" if is_new_client else "returning_client",
            "message": (
                f"{client['client_name']} ({client['client_id']}) · {tier_label} · "
                f"{len(catalogue)} products in context"
            ),
            "data": enriched.model_dump(mode="json"),
        }
    )

    normalized = await normalize(
        enriched.model_dump(mode="json"),
        run_tool,
        event_logger=publish,
    )
    action = str(normalized.get("action") or "create").lower().strip()
    if action not in {"create", "modify", "cancel"}:
        action = "create"
    raw_target = str(normalized.get("target_command_id") or "").strip()
    if not raw_target and action in {"modify", "cancel"} and open_commands:
        raw_target = str(open_commands[0]["command_id"])
    target_id = _base_cmd_id(raw_target) if raw_target else ""
    summary = str(normalized.get("summary") or "Order processed")

    await publish(
        {
            "type": "command.normalized",
            "node": "data.normalized",
            "client_id": client["client_id"],
            "phone_number": phone,
            "status": "ok",
            "message": f"[{action.upper()}] {summary}",
            "data": normalized,
        }
    )

    if action == "cancel" and target_id:
        cancelled_ids = await db.cancel_command_group(target_id, client["client_id"], summary)
        await publish(
            {
                "type": "command.cancelled",
                "node": "db.command",
                "command_id": target_id,
                "client_id": client["client_id"],
                "phone_number": phone,
                "status": "cancelled",
                "lines": len(cancelled_ids),
                "message": (
                    f"Cancelled {target_id} ({len(cancelled_ids)} line(s)) "
                    f"for {client['client_name']}"
                ),
            }
        )
        await _send_auto_ack(phone, client["client_id"], target_id, "cancel", summary)
        return {
            "status": "ok",
            "action": "cancel",
            "command_id": target_id,
            "lines": len(cancelled_ids),
            "is_new_client": is_new_client,
            "normalized_input": normalized,
        }

    lines = normalized.get("order_lines", [])
    now = datetime.now(UTC)
    products = {p["product_id"]: p for p in product_rows}
    valid_rows: list[dict[str, Any]] = []
    for line in lines:
        product_id = str(line.get("product_id", ""))
        if product_id not in products:
            continue
        product = products[product_id]
        valid_rows.append(
            {
                "client_id": client["client_id"],
                "recorded_at": _parse_dt(line.get("recorded_at"), now),
                "delivery_date": _parse_date(line.get("delivery_date"), now.date()),
                "product_id": product_id,
                "price": float(line.get("price") or product["price"]),
                "quantity": float(line.get("quantity", 0)),
                "status": "new",
                "summary": summary,
            }
        )

    if action == "modify" and target_id and valid_rows:
        written_ids = await db.replace_command_group(target_id, client["client_id"], valid_rows)
        inserted = len(written_ids)
        line_word = "line" if inserted == 1 else "lines"
        await publish(
            {
                "type": "command.modified",
                "node": "db.command",
                "command_id": target_id,
                "client_id": client["client_id"],
                "phone_number": phone,
                "is_new_client": is_new_client,
                "status": "new",
                "lines": inserted,
                "message": (
                    f"Modified {target_id} ({inserted} {line_word}) for {client['client_name']}"
                ),
            }
        )
        await _send_auto_ack(phone, client["client_id"], target_id, "modify", summary)
        return {
            "status": "ok",
            "action": "modify",
            "command_id": target_id,
            "lines": inserted,
            "is_new_client": is_new_client,
            "normalized_input": normalized,
        }

    command_id = f"C-{uuid.uuid4().hex[:8]}"
    inserted = len(valid_rows)
    for index, row_data in enumerate(valid_rows):
        row_id = f"{command_id}-{index + 1}" if inserted > 1 else command_id
        await db.insert_command({**row_data, "command_id": row_id})
    line_word = "line" if inserted == 1 else "lines"
    await publish(
        {
            "type": "command.created",
            "node": "db.command",
            "command_id": command_id,
            "client_id": client["client_id"],
            "phone_number": phone,
            "is_new_client": is_new_client,
            "status": "new",
            "lines": inserted,
            "message": f"Created {command_id} ({inserted} {line_word}) for {client['client_name']}",
        }
    )
    if inserted > 0:
        await _send_auto_ack(phone, client["client_id"], command_id, "create", summary)
    return {
        "status": "ok",
        "action": "create",
        "command_id": command_id,
        "lines": inserted,
        "is_new_client": is_new_client,
        "normalized_input": normalized,
    }
