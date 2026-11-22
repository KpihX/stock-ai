"""Provider registry for every swappable brick.

Each brick has a stable id. Switching a brick means changing one value in
config.py or one STOCKLINE_<BRICK>_PROVIDER variable in the environment.
No calling code should hardcode a provider name or a model id.
"""

from __future__ import annotations

from dataclasses import dataclass

BRICKS: tuple[str, ...] = ("messaging", "stt", "ocr", "tts", "agent_llm")


@dataclass(frozen=True)
class ProviderSpec:
    key: str
    label: str
    model: str = ""
    base_url: str = ""
    api_key_env: tuple[str, ...] = ()
    install_extra: str = ""


MESSAGING: dict[str, ProviderSpec] = {
    "baileys": ProviderSpec(
        key="baileys",
        label="Baileys through the installed whats-proxy daemon",
    ),
}

STT: dict[str, ProviderSpec] = {
    "whisper": ProviderSpec(
        key="whisper",
        label="Local whisper.cpp with the multilingual ggml turbo model",
        model="ggml-large-v3-turbo-q5_0.bin",
    ),
}

OCR: dict[str, ProviderSpec] = {
    "tesseract": ProviderSpec(
        key="tesseract",
        label="Local Tesseract with English and French language data",
        model="eng+fra",
    ),
}

TTS: dict[str, ProviderSpec] = {
    "edge_tts": ProviderSpec(
        key="edge_tts",
        label="Microsoft Edge neural TTS through edge-tts, no key required",
        model="fr-FR-DeniseNeural",
        install_extra="tts",
    ),
    "piper": ProviderSpec(
        key="piper",
        label="Local Piper through the k-piper wrapper",
        model="fr_FR-siwis-medium",
        install_extra="voice",
    ),
}

AGENT_LLM: dict[str, ProviderSpec] = {
    "nvidia": ProviderSpec(
        key="nvidia",
        label="NVIDIA Build NIM, Nemotron 3 Ultra 550B",
        model="nvidia/nemotron-3-ultra-550b-a55b",
        base_url="https://integrate.api.nvidia.com/v1",
        api_key_env=("NVIDIA_API_KEY",),
    ),
}

REGISTRIES: dict[str, dict[str, ProviderSpec]] = {
    "messaging": MESSAGING,
    "stt": STT,
    "ocr": OCR,
    "tts": TTS,
    "agent_llm": AGENT_LLM,
}


def get_spec(brick: str, key: str) -> ProviderSpec:
    """Return a provider spec or fail loud with the available choices."""
    registry = REGISTRIES.get(brick)
    if registry is None:
        raise ValueError(f"Unknown brick '{brick}'. Available: {', '.join(BRICKS)}")
    spec = registry.get(key)
    if spec is None:
        raise ValueError(
            f"Unknown provider '{key}' for brick '{brick}'. "
            f"Available: {', '.join(sorted(registry))}"
        )
    return spec
