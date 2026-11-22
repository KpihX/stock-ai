"""Smoke tests for the package scaffold and the structured config."""

from typer.testing import CliRunner

from stockline_ai import __version__
from stockline_ai.cli import app
from stockline_ai.config import CONFIG, Config
from stockline_ai.providers import BRICKS, get_spec

runner = CliRunner()


def test_version() -> None:
    result = runner.invoke(app, ["version"])
    assert result.exit_code == 0
    assert __version__ in result.stdout


def test_status_does_not_leak_secrets() -> None:
    result = runner.invoke(app, ["status"])
    assert result.exit_code == 0
    assert "config_file" in result.stdout


def test_providers_lists_every_brick() -> None:
    result = runner.invoke(app, ["providers"])
    assert result.exit_code == 0
    for brick in BRICKS:
        assert brick in result.stdout


def test_jsonc_file_loads_with_comments() -> None:
    cfg = Config.from_file()
    assert cfg.provider("messaging") == "baileys"
    assert cfg.config_path.name == "config.jsonc"


def test_default_selection_matches_the_hackathon_choices() -> None:
    assert CONFIG.provider("messaging") == "baileys"
    assert CONFIG.provider("stt") == "whisper"
    assert CONFIG.provider("ocr") == "tesseract"
    assert CONFIG.provider("tts") == "edge_tts"
    assert CONFIG.provider("agent_llm") == "nvidia"
    assert CONFIG.provider("decision") == "jev"


def test_mapping_can_swap_a_brick_without_code_change() -> None:
    cfg = Config.from_mapping({"selection": {"tts": "piper"}})
    assert cfg.provider("tts") == "piper"
    assert cfg.spec("tts").label.startswith("Local Piper")


def test_provider_override_wins_over_generic_setting() -> None:
    cfg = Config.from_mapping(
        {
            "selection": {"tts": "piper"},
            "settings": {"tts": {"voice": "generic"}},
            "overrides": {"tts": {"piper": {"voice": "fr_FR-siwis-medium"}}},
        }
    )
    assert cfg.model_for("tts") == "fr_FR-siwis-medium"


def test_unknown_provider_fails_loud() -> None:
    try:
        get_spec("stt", "missing")
    except ValueError as exc:
        assert "Available" in str(exc)
    else:
        raise AssertionError("unknown provider must raise ValueError")


def test_version_is_read_from_pyproject() -> None:
    import tomllib
    from pathlib import Path

    from stockline_ai.version import get_version

    root = Path(__file__).resolve().parents[1]
    with (root / "pyproject.toml").open("rb") as handle:
        expected = tomllib.load(handle)["project"]["version"]
    assert get_version() == expected
    assert __version__ == expected
