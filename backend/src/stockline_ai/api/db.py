"""PostgreSQL access. The database is never exposed to the LLM directly."""

from __future__ import annotations

import os
from typing import Any

import asyncpg

from ..config import CONFIG

SCHEMA = """
CREATE TABLE IF NOT EXISTS client (
    client_id TEXT PRIMARY KEY,
    phone_number TEXT UNIQUE NOT NULL,
    client_name TEXT NOT NULL
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
    summary TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS command_client_idx ON command(client_id);
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


async def fetch_client_stats(client_id: str) -> dict[str, Any]:
    row = await pool().fetchrow(
        """SELECT count(*) AS order_count,
                  COALESCE(array_agg(product_id ORDER BY recorded_at DESC)[1], '') AS usual_product
           FROM command WHERE client_id = $1""",
        client_id,
    )
    return {
        "client_id": client_id,
        "order_count": int(row["order_count"]),
        "usual_product": row["usual_product"] or "",
    }


async def fetch_recent_commands(client_id: str, limit: int = 5) -> list[dict[str, Any]]:
    rows = await pool().fetch(
        """SELECT command_id, client_id, product_id, recorded_at, delivery_date,
                  price, quantity, status, summary
           FROM command WHERE client_id = $1 ORDER BY recorded_at DESC LIMIT $2""",
        client_id,
        limit,
    )
    return [dict(r) for r in rows]


async def fetch_commands(limit: int = 50, offset: int = 0) -> list[dict[str, Any]]:
    rows = await pool().fetch(
        """SELECT command_id, client_id, product_id, recorded_at, delivery_date,
                  price, quantity, status, summary
           FROM command ORDER BY recorded_at DESC LIMIT $1 OFFSET $2""",
        limit,
        offset,
    )
    return [dict(r) for r in rows]


async def fetch_command(command_id: str) -> dict[str, Any] | None:
    row = await pool().fetchrow(
        """SELECT command_id, client_id, product_id, recorded_at, delivery_date,
                  price, quantity, status, summary
           FROM command WHERE command_id = $1""",
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


async def set_command_status(command_id: str, status: str) -> bool:
    result = await pool().execute(
        "UPDATE command SET status = $2 WHERE command_id = $1", command_id, status
    )
    return result.endswith("1")


async def fetch_products() -> list[dict[str, Any]]:
    rows = await pool().fetch(
        "SELECT product_id, product_name, price, stock FROM product ORDER BY product_id"
    )
    return [dict(r) for r in rows]


async def fetch_stock(product_id: str) -> float | None:
    return await pool().fetchval("SELECT stock FROM product WHERE product_id = $1", product_id)
