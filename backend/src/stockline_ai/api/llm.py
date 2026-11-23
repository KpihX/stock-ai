"""Nemotron client through the OpenAI-compatible NVIDIA endpoint.

The model never touches PostgreSQL. It receives EnrichedData and can request
two read-only tools which this module executes against the database.
"""

from __future__ import annotations

import json
from typing import Any, cast

from openai import AsyncOpenAI
from openai.types.chat import ChatCompletionMessageParam
from openai.types.chat.chat_completion_tool_union_param import ChatCompletionToolUnionParam

from ..config import get_config

TOOLS: list[ChatCompletionToolUnionParam] = [
    {
        "type": "function",
        "function": {
            "name": "lookup_client_stats",
            "description": "Return the order count and usual products of a client.",
            "parameters": {
                "type": "object",
                "properties": {"client_id": {"type": "string"}},
                "required": ["client_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "lookup_commands",
            "description": "Return past commands of a client to write an accurate summary.",
            "parameters": {
                "type": "object",
                "properties": {
                    "client_id": {"type": "string"},
                    "limit": {"type": "integer"},
                },
                "required": ["client_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "lookup_products",
            "description": (
                "Return the product catalogue with product_id, product_name, price and stock."
            ),
            "parameters": {"type": "object", "properties": {}},
        },
    },
]


def _system_prompt() -> str:
    prompt = get_config().system_prompt
    if not prompt:
        raise RuntimeError("system_prompt is missing from config.jsonc")
    return prompt


def _client() -> AsyncOpenAI:
    cfg = get_config()
    return AsyncOpenAI(
        base_url=cfg.base_url_for("agent_llm"),
        api_key=cfg.api_key("agent_llm", required=True),
    )


def _parse_json(raw: str) -> dict[str, Any]:
    text = raw.strip()
    if "</think>" in text:
        text = text.split("</think>", 1)[1].strip()
    if text.startswith("```"):
        lines = text.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines).strip()
    if not text:
        return {}
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start != -1 and end > start:
            return json.loads(text[start : end + 1])
        raise


async def normalize(
    enriched: dict[str, Any], tool_runner: Any, event_logger: Any = None
) -> dict[str, Any]:
    """Run the tool-calling loop and return the parsed NormalizedInput payload."""
    cfg = get_config()
    client = _client()
    model_name = cfg.model_for("agent_llm")
    temperature = float(cfg.param("agent_llm", "temperature", "0"))
    max_tokens = int(cfg.param("agent_llm", "max_tokens", "4000"))
    messages: list[ChatCompletionMessageParam] = [
        {"role": "system", "content": _system_prompt()},
        {"role": "user", "content": json.dumps(enriched, ensure_ascii=False, default=str)},
    ]
    if event_logger is not None:
        await event_logger(
            {
                "type": "llm.request",
                "node": "llm.nemotron",
                "client_id": str(enriched.get("client_id", "")),
                "phone_number": str(enriched.get("cNumber", "")),
                "status": "ok",
                "message": (
                    f"Calling {model_name} with text="
                    f"{str((enriched.get('signal') or {}).get('texte', ''))[:100]!r} "
                    f"and {len(enriched.get('products') or [])} catalogue products"
                ),
                "model": model_name,
                "products_count": len(enriched.get("products") or []),
                "input_text": str((enriched.get("signal") or {}).get("texte", "")),
            }
        )
    for turn in range(1, 5):
        response = await client.chat.completions.create(
            model=model_name,
            messages=messages,
            tools=TOOLS,
            tool_choice="auto",
            temperature=temperature,
            max_tokens=max_tokens,
        )
        message = response.choices[0].message
        if not message.tool_calls:
            raw_content = message.content or "{}"
            parsed = _parse_json(raw_content)
            if event_logger is not None:
                await event_logger(
                    {
                        "type": "llm.response",
                        "node": "llm.nemotron",
                        "client_id": str(enriched.get("client_id", "")),
                        "phone_number": str(enriched.get("cNumber", "")),
                        "status": "ok",
                        "message": (
                            f"{model_name} turn {turn} -> "
                            f"{len(parsed.get('order_lines') or [])} order line(s)"
                        ),
                        "turn": turn,
                        "raw_output": raw_content[:1500],
                        "parsed": parsed,
                    }
                )
            return parsed
        messages.append(
            cast(
                ChatCompletionMessageParam,
                {
                    "role": "assistant",
                    "content": message.content or "",
                    "tool_calls": [tc.model_dump() for tc in message.tool_calls],
                },
            )
        )
        for call in message.tool_calls:
            if call.type != "function":
                continue
            args = json.loads(call.function.arguments or "{}")
            result = await tool_runner(call.function.name, args)
            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": call.id,
                    "content": json.dumps(result, ensure_ascii=False, default=str),
                }
            )
    raise RuntimeError("LLM tool loop exceeded the iteration cap")
