"""Thin Typer entry point for stock-ai."""

from __future__ import annotations

import typer
from rich.console import Console

from . import __version__
from .config import CONFIG

app = typer.Typer(no_args_is_help=True, add_completion=False)
console = Console()


@app.command()
def version() -> None:
    """Print the package version."""
    console.print(f"stock-ai {__version__}")


@app.command()
def status() -> None:
    """Show the active configuration without exposing any secret."""
    console.print(f"config_file: {CONFIG.config_path}")
    console.print(f"state_dir: {CONFIG.state_dir}")
    console.print(f"whats_proxy_state_dir: {CONFIG.whats_proxy_state_dir}")
    console.print(f"stt_model: {CONFIG.model_for('stt')}")
    console.print(f"ocr_languages: {CONFIG.model_for('ocr')}")
    console.print(f"tts_voice: {CONFIG.model_for('tts')}")


@app.command()
def providers() -> None:
    """Show the active provider for each brick without exposing any key."""
    for row in CONFIG.describe():
        console.print(
            f"{row['brick']}: {row['provider']} | {row['model']} | "
            f"key_env={row['key_env']} | key_present={row['key_present']}"
        )


if __name__ == "__main__":
    app()
