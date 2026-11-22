"""Single source of truth for the package version: pyproject.toml."""

from __future__ import annotations

import tomllib
from importlib import metadata
from pathlib import Path

_PROJECT_ROOT = Path(__file__).parent.parents[1]


def get_version() -> str:
    """Read [project].version from pyproject.toml, or from installed metadata."""
    pyproject = _PROJECT_ROOT / "pyproject.toml"
    if pyproject.is_file():
        with pyproject.open("rb") as handle:
            data = tomllib.load(handle)
        return str(data["project"]["version"])
    return metadata.version("stockline-ai")
