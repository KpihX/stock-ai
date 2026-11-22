# CONTRACT.md - stockline-ai

Source of truth for the external behavior of this package. Metadata lives in pyproject.toml.

## Purpose

Turn messy supplier orders from WhatsApp voice notes, text and photos into validated ERP lines, then suggest and supervise purchasing. The demo must show one voice order producing clean lines, a demand signal and an approval gate.

## Operations

- version: print the installed package version.
- status: print non secret runtime configuration.
- ingest (planned): fetch a WhatsApp message or media and normalize it into an OrderEvent.
- extract (planned): turn an OrderEvent into a list of typed OrderLine objects.
- forecast (planned): turn order history into demand estimates per SKU and per day.
- purchase (planned): turn a demand gap into a draft PurchaseOrder, never auto approved.

## Data types

- OrderEvent: channel, sender, raw text, optional media path, confidence.
- OrderLine: sku, quantity, unit, customer_id, delivery_date, confidence.
- PurchaseOrder: supplier, lines, total, status in draft or approved.

## Error model

- 0 success.
- 1 operation error with a message on stderr.
- 2 invalid input or missing required argument.
- Every CLI response is a JSON envelope with meta status and data, matching the whats-proxy convention.

## Transport mapping

- CLI today: Typer commands with rich output.
- Next: JSON mode with the same envelope, then a local JSON-RPC daemon if the live voice demo needs it.
- WhatsApp transport: delegated to the installed whats-proxy CLI, never reimplemented here.
