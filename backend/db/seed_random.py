"""Fill the Stockline database with random clients, products and commands.

Usage:
    cd backend && uv run python db/seed_random.py --clients 20 --products 20 --commands 120

The script reads the repo-root .env, builds the PostgreSQL DSN from the same
DB_* variables as docker-compose, and never prints a secret value.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import random
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from urllib.parse import quote

import asyncpg
from dotenv import load_dotenv

from stockline_ai.api.db import SCHEMA

ROOT = Path(__file__).resolve().parents[2]
load_dotenv(ROOT / ".env", override=False)

FIRST_NAMES = [
    "Yohann", "Alice", "Karim", "Sofia", "Mehdi", "Claire", "Lucas", "Nadia",
    "Hugo", "Ines", "Thomas", "Leila", "Paul", "Emma", "Noah", "Sarah",
]
LAST_NAMES = [
    "Bikele", "Martin", "Bernard", "Diallo", "Petit", "Robert", "Richard",
    "Durand", "Moreau", "Simon", "Laurent", "Lefebvre", "Michel", "Garcia",
]
BUSINESS_NAMES = [
    "Le Cedar Room", "Harbor Kitchen", "North Pier Grill", "Maison Verte",
    "Bistro du Port", "La Table Rase", "Cantine Solaire", "Le Comptoir",
    "Chez Nino", "Les Halles", "Le Panier Bleu", "Rive Gauche",
]
PRODUCT_NAMES = [
    "Tomates grappe", "Cabillaud 3/5", "Saumon 12", "Crevettes 30/40",
    "Pommes de terre", "Oignons jaunes", "Carottes", "Courgettes",
    "Poulet fermier", "Boeuf haché", "Mozzarella", "Parmesan",
    "Huile d'olive", "Riz basmati", "Pâtes penne", "Farine T55",
    "Beurre doux", "Crème fraîche", "Citrons", "Basilic frais",
]


def dsn() -> str:
    explicit = os.environ.get("STOCKLINE_DATABASE_URL")
    if explicit:
        return explicit
    user = os.environ.get("DB_USER", "stockline")
    password = os.environ.get("POSTGRES_PASSWORD", "stockline")
    name = os.environ.get("DB_NAME", "stockline")
    host = os.environ.get("DB_HOST", "localhost")
    port = os.environ.get("DB_PORT", "5432")
    return f"postgresql://{quote(user)}:{quote(password)}@{host}:{port}/{quote(name)}"


def phone(rng: random.Random) -> str:
    return "33" + "".join(str(rng.randint(0, 9)) for _ in range(9))


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--clients", type=int, default=20)
    parser.add_argument("--products", type=int, default=20)
    parser.add_argument("--commands", type=int, default=120)
    parser.add_argument("--seed", type=int, default=None)
    args = parser.parse_args()

    rng = random.Random(args.seed)
    conn = await asyncpg.connect(dsn())
    try:
        await conn.execute(SCHEMA)

        clients: list[tuple[str, str, str]] = []
        phones: set[str] = set()
        for index in range(args.clients):
            value = phone(rng)
            while value in phones:
                value = phone(rng)
            phones.add(value)
            name = rng.choice(BUSINESS_NAMES) if rng.random() < 0.6 else f"{rng.choice(FIRST_NAMES)} {rng.choice(LAST_NAMES)}"
            clients.append((f"CLI-R-{index + 1:03d}", value, name))
        await conn.executemany(
            "INSERT INTO client(client_id, phone_number, client_name) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
            clients,
        )

        products: list[tuple[str, str, float, float]] = []
        for index in range(args.products):
            name = rng.choice(PRODUCT_NAMES)
            price = round(rng.uniform(1.0, 35.0), 2)
            stock = round(rng.uniform(0, 120), 3)
            products.append((f"ART-R-{index + 1:03d}", name, price, stock))
        await conn.executemany(
            "INSERT INTO product(product_id, product_name, price, stock) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
            products,
        )

        commands: list[tuple[str, str, datetime, object, str, float, float, str, str]] = []
        for _ in range(args.commands):
            client_id = rng.choice(clients)[0]
            product_id, product_name, price, _stock = rng.choice(products)
            recorded_at = datetime.now(UTC) - timedelta(days=rng.randint(0, 45), hours=rng.randint(0, 23))
            quantity = float(rng.randint(1, 12))
            commands.append(
                (
                    f"C-R-{uuid.uuid4().hex[:8]}",
                    client_id,
                    recorded_at,
                    recorded_at.date(),
                    product_id,
                    price,
                    quantity,
                    rng.choice(["new", "processed", "rejected"]),
                    f"{quantity:g} x {product_name}",
                )
            )
        await conn.executemany(
            """INSERT INTO command
               (command_id, client_id, recorded_at, delivery_date, product_id, price, quantity, status, summary)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
               ON CONFLICT DO NOTHING""",
            commands,
        )
        print(f"seeded clients={len(clients)} products={len(products)} commands={len(commands)}")
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
