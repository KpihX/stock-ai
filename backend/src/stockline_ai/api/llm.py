"""Nemotron client through the OpenAI-compatible NVIDIA endpoint.

The model never touches PostgreSQL. It receives EnrichedData and can request
two read-only tools which this module executes against the database.
"""

from __future__ import annotations

import json
from typing import Any, cast

from openai import OpenAI
from openai.types.chat import ChatCompletionMessageParam
from openai.types.chat.chat_completion_tool_union_param import ChatCompletionToolUnionParam

from ..config import CONFIG

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
]


def _system_prompt() -> str:
    prompt = CONFIG.system_prompt
    if not prompt:
        raise RuntimeError("system_prompt is missing from config.jsonc")
    return prompt


def _client() -> OpenAI:
    return OpenAI(
        base_url=CONFIG.base_url_for("agent_llm"),
        api_key=CONFIG.api_key("agent_llm", required=True),
    )


async def normalize(enriched: dict[str, Any], tool_runner: Any) -> dict[str, Any]:
    """Run the tool-calling loop and return the parsed NormalizedInput payload."""
    client = _client()
    messages: list[ChatCompletionMessageParam] = [
        {"role": "system", "content": _system_prompt()},
        {"role": "user", "content": json.dumps(enriched, ensure_ascii=False, default=str)},
    ]
    for _ in range(4):
        response = client.chat.completions.create(
            model=CONFIG.model_for("agent_llm"),
            messages=messages,
            tools=TOOLS,
            tool_choice="auto",
            temperature=0,
            max_tokens=1500,
        )
        message = response.choices[0].message
        if not message.tool_calls:
            content = message.content or "{}"
            return json.loads(content)
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
