"""PostgreSQL access. The database is never exposed to the LLM directly."""

from __future__ import annotations

import json
import os
import uuid
from datetime import UTC, date, datetime
from typing import Any

import asyncpg

from ..config import CONFIG

SCHEMA = """
CREATE TABLE IF NOT EXISTS client (
    client_id TEXT PRIMARY KEY,
    phone_number TEXT UNIQUE NOT NULL,
    client_name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS manager (
    username TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS product (
    product_id TEXT PRIMARY KEY,
    product_name TEXT NOT NULL,
    price NUMERIC(12, 2) NOT NULL,
    stock NUMERIC(12, 3) NOT NULL
);
CREATE TABLE IF NOT EXISTS command (
    command_id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES client(client_id),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    delivery_date DATE NOT NULL,
    product_id TEXT NOT NULL REFERENCES product(product_id),
    price NUMERIC(12, 2) NOT NULL,
    quantity NUMERIC(12, 3) NOT NULL,
    status TEXT NOT NULL DEFAULT 'new',
    summary TEXT NOT NULL DEFAULT '',
    decision_comment TEXT NOT NULL DEFAULT '',
    decided_by TEXT NOT NULL DEFAULT '',
    decided_at TIMESTAMPTZ
);
ALTER TABLE command ADD COLUMN IF NOT EXISTS decision_comment TEXT NOT NULL DEFAULT '';
ALTER TABLE command ADD COLUMN IF NOT EXISTS decided_by TEXT NOT NULL DEFAULT '';
ALTER TABLE command ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS command_client_idx ON command(client_id);
CREATE TABLE IF NOT EXISTS pipeline_log (
    log_id BIGSERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    event_type TEXT NOT NULL,
    node_id TEXT NOT NULL,
    client_id TEXT NOT NULL DEFAULT '',
    phone_number TEXT NOT NULL DEFAULT '',
    command_id TEXT NOT NULL DEFAULT '',
    actor TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT '',
    message TEXT NOT NULL DEFAULT '',
    payload JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS pipeline_log_created_idx ON pipeline_log(created_at DESC);
"""

_pool: asyncpg.Pool | None = None


def dsn() -> str:
    override = os.environ.get("STOCKLINE_DATABASE_URL")
    if override:
        return override
    return str(
        CONFIG.runtime.get(
            "database_url",
            "postgresql://stockline:stockline@localhost:5432/stockline",
        )
    )


async def connect() -> None:
    global _pool
    _pool = await asyncpg.create_pool(dsn=dsn(), min_size=1, max_size=10)
    async with _pool.acquire() as conn:
        await conn.execute(SCHEMA)


async def close() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


def pool() -> asyncpg.Pool:
    if _pool is None:
        raise RuntimeError("Database pool is not initialised")
    return _pool


async def fetch_client_by_phone(phone: str) -> dict[str, Any] | None:
    row = await pool().fetchrow(
        "SELECT client_id, phone_number, client_name FROM client WHERE phone_number = $1",
        phone,
    )
    return dict(row) if row else None


async def create_client(client_id: str, phone: str, name: str) -> dict[str, Any]:
    row = await pool().fetchrow(
        """INSERT INTO client(client_id, phone_number, client_name)
           VALUES($1,$2,$3)
           ON CONFLICT (phone_number) DO UPDATE SET client_name = EXCLUDED.client_name
           RETURNING client_id, phone_number, client_name""",
        client_id,
        phone,
        name,
    )
    return dict(row)


async def fetch_manager(username: str) -> dict[str, Any] | None:
    row = await pool().fetchrow(
        "SELECT username, password_hash, is_active FROM manager WHERE username = $1",
        username,
    )
    return dict(row) if row else None


async def list_managers() -> list[dict[str, Any]]:
    rows = await pool().fetch(
        "SELECT username, is_active, created_at FROM manager ORDER BY username"
    )
    return [dict(r) for r in rows]


async def upsert_manager(username: str, password_hash: str, is_active: bool = True) -> None:
    await pool().execute(
        """INSERT INTO manager(username, password_hash, is_active)
           VALUES($1,$2,$3)
           ON CONFLICT (username) DO UPDATE
           SET password_hash = EXCLUDED.password_hash, is_active = EXCLUDED.is_active""",
        username,
        password_hash,
        is_active,
    )


async def create_manual_command(
    client_id: str,
    product_id: str,
    quantity: float,
    delivery_date: date | None = None,
    summary: str = "",
) -> dict[str, Any]:
    prod = await pool().fetchrow(
        "SELECT product_id, product_name, price FROM product WHERE product_id = $1",
        product_id,
    )
    if not prod:
        raise ValueError(f"Unknown product '{product_id}'")
    cli = await pool().fetchrow(
        "SELECT client_id, client_name, phone_number FROM client WHERE client_id = $1",
        client_id,
    )
    if not cli:
        raise ValueError(f"Unknown client '{client_id}'")

    now = datetime.now(UTC)
    target_date = delivery_date or now.date()
    command_id = f"C-{uuid.uuid4().hex[:8]}"
    note = summary.strip() or f"Manual order: {quantity:g} x {prod['product_name']}"
    await insert_command(
        {
            "command_id": command_id,
            "client_id": client_id,
            "recorded_at": now,
            "delivery_date": target_date,
            "product_id": product_id,
            "price": float(prod["price"]),
            "quantity": float(quantity),
            "status": "new",
            "summary": note,
        }
    )
    row = await fetch_command(command_id)
    return row or {"command_id": command_id}


async def update_command(
    command_id: str,
    *,
    quantity: float | None = None,
    status: str | None = None,
    summary: str | None = None,
) -> dict[str, Any] | None:
    existing = await fetch_command(command_id)
    if not existing:
        return None
    prev_status = str(existing.get("status") or "new")
    prev_qty = float(existing.get("quantity") or 0)
    next_qty = float(quantity) if quantity is not None else prev_qty
    next_status = str(status).strip().lower() if status is not None else prev_status
    if next_status not in {"new", "processed", "rejected", "cancelled"}:
        raise ValueError(f"Invalid status '{next_status}'")
    next_summary = (
        str(summary).strip() if summary is not None else str(existing.get("summary") or "")
    )

    product_id = str(existing.get("product_id") or "")
    if product_id:
        if prev_status == "processed" and next_status != "processed":
            await adjust_stock(product_id, prev_qty)
        elif prev_status != "processed" and next_status == "processed":
            await adjust_stock(product_id, -next_qty)
        elif prev_status == "processed" and next_status == "processed" and next_qty != prev_qty:
            await adjust_stock(product_id, prev_qty - next_qty)

    await pool().execute(
        """UPDATE command
           SET quantity = $2, status = $3, summary = $4
           WHERE command_id = $1""",
        command_id,
        next_qty,
        next_status,
        next_summary,
    )
    return await fetch_command(command_id)


async def delete_command(command_id: str) -> bool:
    existing = await fetch_command(command_id)
    if not existing:
        return False
    if str(existing.get("status") or "") == "processed":
        product_id = str(existing.get("product_id") or "")
        qty = float(existing.get("quantity") or 0)
        if product_id and qty > 0:
            await adjust_stock(product_id, qty)
    result = await pool().execute("DELETE FROM command WHERE command_id = $1", command_id)
    return result.endswith("1")


async def delete_manager(username: str) -> bool:
    result = await pool().execute("DELETE FROM manager WHERE username = $1", username)
    return result.endswith("1")


async def delete_client(client_id: str) -> bool:
    await pool().execute("DELETE FROM command WHERE client_id = $1", client_id)
    result = await pool().execute("DELETE FROM client WHERE client_id = $1", client_id)
    return result.endswith("1")


async def delete_product(product_id: str) -> bool:
    await pool().execute("DELETE FROM command WHERE product_id = $1", product_id)
    result = await pool().execute("DELETE FROM product WHERE product_id = $1", product_id)
    return result.endswith("1")


async def fetch_client_stats(client_id: str) -> dict[str, Any]:
    row = await pool().fetchrow(
        """SELECT count(*) AS order_count,
                  COALESCE(sum(price * quantity), 0) AS total_spent,
                  COALESCE(sum(quantity), 0) AS total_quantity,
                  max(recorded_at) AS last_order_at,
                  COALESCE(
                      (array_agg(product_id ORDER BY recorded_at DESC))[1],
                      ''
                  ) AS usual_product
           FROM command WHERE client_id = $1""",
        client_id,
    )
    return {
        "client_id": client_id,
        "order_count": int(row["order_count"]),
        "total_spent": float(row["total_spent"] or 0),
        "total_quantity": float(row["total_quantity"] or 0),
        "last_order_at": row["last_order_at"],
        "usual_product": row["usual_product"] or "",
    }


async def fetch_recent_commands(client_id: str, limit: int = 5) -> list[dict[str, Any]]:
    rows = await pool().fetch(
        """SELECT c.command_id, c.client_id, c.product_id,
                  COALESCE(p.product_name, c.product_id) AS product_name,
                  c.recorded_at, c.delivery_date, c.price, c.quantity, c.status, c.summary,
                  c.decision_comment, c.decided_by, c.decided_at
           FROM command c
           LEFT JOIN product p ON p.product_id = c.product_id
           WHERE c.client_id = $1 ORDER BY c.recorded_at DESC LIMIT $2""",
        client_id,
        limit,
    )
    return [dict(r) for r in rows]


async def fetch_commands(limit: int = 50, offset: int = 0) -> list[dict[str, Any]]:
    rows = await pool().fetch(
        """SELECT c.command_id, c.client_id, c.product_id,
                  COALESCE(p.product_name, c.product_id) AS product_name,
                  c.recorded_at, c.delivery_date, c.price, c.quantity, c.status, c.summary,
                  c.decision_comment, c.decided_by, c.decided_at,
                  cl.client_name, cl.phone_number AS client_phone,
                  COUNT(*) OVER (PARTITION BY c.client_id) AS client_order_count
           FROM command c
           JOIN client cl ON cl.client_id = c.client_id
           LEFT JOIN product p ON p.product_id = c.product_id
           ORDER BY c.recorded_at DESC LIMIT $1 OFFSET $2""",
        limit,
        offset,
    )
    return [dict(r) for r in rows]


async def fetch_command(command_id: str) -> dict[str, Any] | None:
    row = await pool().fetchrow(
        """SELECT c.command_id, c.client_id, c.product_id,
                  COALESCE(p.product_name, c.product_id) AS product_name,
                  c.recorded_at, c.delivery_date, c.price, c.quantity, c.status, c.summary,
                  c.decision_comment, c.decided_by, c.decided_at,
                  cl.client_name, cl.phone_number AS client_phone,
                  (
                      SELECT COUNT(*) FROM command c2 WHERE c2.client_id = c.client_id
                  ) AS client_order_count
           FROM command c
           JOIN client cl ON cl.client_id = c.client_id
           LEFT JOIN product p ON p.product_id = c.product_id
           WHERE c.command_id = $1""",
        command_id,
    )
    return dict(row) if row else None


async def insert_command(data: dict[str, Any]) -> None:
    await pool().execute(
        """INSERT INTO command
           (command_id, client_id, recorded_at, delivery_date,
            product_id, price, quantity, status, summary)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (command_id) DO NOTHING""",
        data["command_id"],
        data["client_id"],
        data["recorded_at"],
        data["delivery_date"],
        data["product_id"],
        data["price"],
        data["quantity"],
        data.get("status", "new"),
        data.get("summary", ""),
    )


async def set_command_status(
    command_id: str, status: str, comment: str = "", actor: str = ""
) -> bool:
    result = await pool().execute(
        """UPDATE command
           SET status = $2,
               decision_comment = $3,
               decided_by = $4,
               decided_at = now()
           WHERE command_id = $1""",
        command_id,
        status,
        comment,
        actor,
    )
    return result.endswith("1")


async def insert_pipeline_log(data: dict[str, Any]) -> dict[str, Any]:
    row = await pool().fetchrow(
        """INSERT INTO pipeline_log
           (event_type, node_id, client_id, phone_number,
            command_id, actor, status, message, payload)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
           RETURNING log_id, created_at, event_type, node_id, client_id, phone_number,
                     command_id, actor, status, message, payload""",
        data.get("event_type", ""),
        data.get("node_id", ""),
        data.get("client_id", ""),
        data.get("phone_number", ""),
        data.get("command_id", ""),
        data.get("actor", ""),
        data.get("status", ""),
        data.get("message", ""),
        json.dumps(data.get("payload") or {}, ensure_ascii=False, default=str),
    )
    result = dict(row)
    raw_payload = result.get("payload")
    if isinstance(raw_payload, str):
        try:
            result["payload"] = json.loads(raw_payload)
        except json.JSONDecodeError:
            result["payload"] = {}
    return result


async def fetch_pipeline_logs(limit: int = 100) -> list[dict[str, Any]]:
    rows = await pool().fetch(
        """SELECT log_id, created_at, event_type, node_id, client_id, phone_number,
                  command_id, actor, status, message, payload
           FROM pipeline_log
           ORDER BY created_at DESC, log_id DESC
           LIMIT $1""",
        limit,
    )
    items: list[dict[str, Any]] = []
    for row in rows:
        item = dict(row)
        raw_payload = item.get("payload")
        if isinstance(raw_payload, str):
            try:
                item["payload"] = json.loads(raw_payload)
            except json.JSONDecodeError:
                item["payload"] = {}
        items.append(item)
    return items


async def fetch_products() -> list[dict[str, Any]]:
    rows = await pool().fetch(
        "SELECT product_id, product_name, price, stock FROM product ORDER BY product_id"
    )
    return [dict(r) for r in rows]


async def fetch_stock(product_id: str) -> float | None:
    return await pool().fetchval("SELECT stock FROM product WHERE product_id = $1", product_id)


async def adjust_stock(product_id: str, delta: float) -> float:
    new_val = await pool().fetchval(
        """UPDATE product
           SET stock = GREATEST(0, stock + $2)
           WHERE product_id = $1
           RETURNING stock""",
        product_id,
        delta,
    )
    return float(new_val or 0.0)


async def fetch_command_group(base_command_id: str, client_id: str) -> list[dict[str, Any]]:
    root = (
        base_command_id.split("-")[0] + "-" + base_command_id.split("-")[1]
        if "-" in base_command_id
        else base_command_id
    )
    rows = await pool().fetch(
        """SELECT command_id, client_id, product_id, recorded_at, delivery_date,
                  price, quantity, status, summary
           FROM command
           WHERE client_id = $1
             AND (command_id = $2 OR command_id LIKE $3)
           ORDER BY command_id ASC""",
        client_id,
        root,
        f"{root}-%",
    )
    return [dict(r) for r in rows]


async def replace_command_group(
    base_command_id: str, client_id: str, new_rows: list[dict[str, Any]]
) -> list[str]:
    existing = await fetch_command_group(base_command_id, client_id)
    for row in existing:
        if str(row.get("status")) == "processed":
            await adjust_stock(str(row["product_id"]), float(row["quantity"]))
    root = (
        base_command_id.split("-")[0] + "-" + base_command_id.split("-")[1]
        if "-" in base_command_id
        else base_command_id
    )
    await pool().execute(
        "DELETE FROM command WHERE client_id = $1 AND (command_id = $2 OR command_id LIKE $3)",
        client_id,
        root,
        f"{root}-%",
    )
    written: list[str] = []
    for index, line in enumerate(new_rows):
        row_id = f"{root}-{index + 1}" if len(new_rows) > 1 else root
        payload = {**line, "command_id": row_id}
        await insert_command(payload)
        written.append(row_id)
    return written


async def cancel_command_group(base_command_id: str, client_id: str, summary: str) -> list[str]:
    existing = await fetch_command_group(base_command_id, client_id)
    cancelled: list[str] = []
    for row in existing:
        if str(row.get("status")) == "processed":
            await adjust_stock(str(row["product_id"]), float(row["quantity"]))
        await pool().execute(
            """UPDATE command
               SET status = 'cancelled',
                   summary = CASE WHEN $2 <> '' THEN $2 ELSE summary END,
                   decided_at = now()
               WHERE command_id = $1""",
            row["command_id"],
            summary,
        )
        cancelled.append(str(row["command_id"]))
    return cancelled
