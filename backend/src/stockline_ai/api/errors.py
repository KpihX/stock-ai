"""Safe error sanitization so secrets or internal credentials never leak to logs, SSE or HTTP."""

from __future__ import annotations

import re

_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"nvapi-[A-Za-z0-9_-]+"), "nvapi-[REDACTED]"),
    (re.compile(r"(Bearer\s+)[A-Za-z0-9._~+/=-]+", re.IGNORECASE), r"\1[REDACTED]"),
    (re.compile(r"(postgres(?:ql)?://[^:\s/]+:)[^@\s]+(@)"), r"\1[REDACTED]\2"),
    (
        re.compile(r"([?&](?:token|key|api_key|password|secret)=)[^&\s]+", re.IGNORECASE),
        r"\1[REDACTED]",
    ),
)


def sanitize_error(exc: BaseException | str, *, max_len: int = 280) -> str:
    """Return a concise, secret-free error message safe for HTTP responses and SSE logs."""
    raw = str(exc) if isinstance(exc, BaseException) else exc
    cleaned = " ".join(raw.split()).strip()
    for pattern, repl in _PATTERNS:
        cleaned = pattern.sub(repl, cleaned)
    if not cleaned:
        cleaned = type(exc).__name__ if isinstance(exc, BaseException) else "Unknown error"
    if len(cleaned) > max_len:
        return f"{cleaned[: max_len - 3]}..."
    return cleaned
