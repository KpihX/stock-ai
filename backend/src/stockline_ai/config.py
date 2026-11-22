"""Structured runtime configuration for stockline-ai.

All defaults, models, URLs and paths live in config.jsonc at the project root.
The environment holds secrets only. Every brick is resolved through the
provider registry so swapping a brick never touches calling code.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import json5
from dotenv import load_dotenv

from .providers import BRICKS, ProviderSpec, get_spec

_PKG_DIR = Path(__file__).parent
_ROOT_DIR = _PKG_DIR.parents[1]
_DEFAULT_CONFIG_PATH = _ROOT_DIR / "config.jsonc"

load_dotenv(_ROOT_DIR.parent / ".env", override=False)
load_dotenv(_ROOT_DIR / ".env", override=False)

DEFAULT_SELECTION: dict[str, str] = {
    "messaging": "baileys",
    "stt": "whisper",
    "ocr": "tesseract",
    "tts": "edge_tts",
    "agent_llm": "nvidia",
}

_MODEL_PARAM: dict[str, str] = {
    "stt": "model",
    "ocr": "languages",
    "tts": "voice",
    "agent_llm": "model",
}


class SecretsUnavailableError(RuntimeError):
    """Raised when a required secret cannot be resolved."""


def get_secret(name: str, *, required: bool = False) -> str:
    """Resolve a secret from the process environment, populated by .env or the shell."""
    value = os.environ.get(name)
    if value:
        return value
    if required:
        raise SecretsUnavailableError(
            f"Secret '{name}' is not available. Set it in {_ROOT_DIR / '.env'} or in the shell."
        )
    return ""


@dataclass(frozen=True)
class Config:
    """Structured view of config.jsonc with provider-aware parameter resolution."""

    selection: dict[str, str] = field(default_factory=lambda: dict(DEFAULT_SELECTION))
    settings: dict[str, dict[str, Any]] = field(default_factory=dict)
    overrides: dict[str, dict[str, dict[str, Any]]] = field(default_factory=dict)
    runtime: dict[str, Any] = field(default_factory=dict)
    system_prompt: str = ""
    config_path: Path = _DEFAULT_CONFIG_PATH

    @classmethod
    def from_mapping(cls, data: dict[str, Any], *, path: Path | None = None) -> Config:
        """Build a config from a parsed mapping, merging defaults into the selection."""
        raw_selection = data.get("selection") or {}
        return cls(
            selection={**DEFAULT_SELECTION, **{str(k): str(v) for k, v in raw_selection.items()}},
            settings=dict(data.get("settings") or {}),
            overrides=dict(data.get("overrides") or {}),
            runtime=dict(data.get("runtime") or {}),
            system_prompt=str(data.get("system_prompt", "")),
            config_path=path or _DEFAULT_CONFIG_PATH,
        )

    @classmethod
    def from_file(cls, path: Path | None = None) -> Config:
        """Load and parse the JSONC file. Fail loud on a malformed or missing file."""
        target = path or _DEFAULT_CONFIG_PATH
        data = json5.loads(target.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError(f"root of {target} must be an object")
        return cls.from_mapping(data, path=target)

    def provider(self, brick: str) -> str:
        """Return the selected provider id for a brick."""
        return self.selection.get(brick, DEFAULT_SELECTION[brick])

    def spec(self, brick: str) -> ProviderSpec:
        """Return the selected provider spec for a brick."""
        return get_spec(brick, self.provider(brick))

    def param(self, brick: str, name: str, default: str = "") -> Any:
        """Resolve a parameter: provider override, then brick setting, then registry."""
        selected = self.provider(brick)
        override = (self.overrides.get(brick) or {}).get(selected) or {}
        if name in override:
            return override[name]
        settings = self.settings.get(brick) or {}
        if name in settings:
            return settings[name]
        fallback = getattr(self.spec(brick), name, None)
        return fallback if fallback is not None else default

    def model_for(self, brick: str) -> str:
        """Return the active model, voice or language set for a brick."""
        key = _MODEL_PARAM.get(brick, "model")
        return str(self.param(brick, key, self.spec(brick).model))

    def base_url_for(self, brick: str) -> str:
        """Return the active base URL, empty for local bricks."""
        return str(self.param(brick, "base_url", self.spec(brick).base_url))

    def endpoint_for(self, brick: str) -> str:
        """Return the active API endpoint path when the provider declares one."""
        return str(self.param(brick, "endpoint", ""))

    def bin_for(self, brick: str) -> str:
        """Return the active executable name for a local brick."""
        return str(self.param(brick, "bin", ""))

    def path_for(self, name: str, default: str) -> Path:
        """Resolve a runtime path, expanding ~ without hardcoding a home directory."""
        return Path(str(self.runtime.get(name, default))).expanduser()

    @property
    def state_dir(self) -> Path:
        return self.path_for("state_dir", "~/.local/share/stockline-ai")

    @property
    def whats_proxy_state_dir(self) -> Path:
        settings = self.settings.get("messaging") or {}
        return Path(str(settings.get("state_dir", "~/.local/share/whats-proxy"))).expanduser()

    @property
    def stt_models_dir(self) -> Path:
        settings = self.settings.get("stt") or {}
        return Path(str(settings.get("models_dir", "~/.local/share/whisper-cpp"))).expanduser()

    @property
    def hitl_timeout_seconds(self) -> int:
        return int(self.runtime.get("hitl_timeout_seconds", 600))

    @property
    def debug(self) -> bool:
        return bool(self.runtime.get("debug", False))

    def api_key(self, brick: str, *, required: bool = False) -> str:
        """Resolve the first available key declared by the selected provider."""
        for name in self.spec(brick).api_key_env:
            value = get_secret(name)
            if value:
                return value
        if required and self.spec(brick).api_key_env:
            names = ", ".join(self.spec(brick).api_key_env)
            raise SecretsUnavailableError(
                f"Missing API key for '{brick}'. Expected one of: {names}"
            )
        return ""

    def describe(self) -> list[dict[str, str]]:
        """Describe the active stack without exposing any secret value."""
        rows: list[dict[str, str]] = []
        for brick in BRICKS:
            spec = self.spec(brick)
            rows.append(
                {
                    "brick": brick,
                    "provider": spec.key,
                    "label": spec.label,
                    "model": self.model_for(brick),
                    "base_url": self.base_url_for(brick),
                    "key_env": ",".join(spec.api_key_env) or "-",
                    "key_present": "yes" if self.api_key(brick) else "no",
                }
            )
        return rows


CONFIG = Config.from_file()


def validate_startup() -> None:
    """Fail loud in production when the JWT signing key is missing."""
    if CONFIG.debug:
        return
    if not get_secret("JWT_SECRET"):
        raise SecretsUnavailableError(
            "JWT_SECRET is required when debug is false. "
            "Generate one with `make init` or set it in the environment."
        )
