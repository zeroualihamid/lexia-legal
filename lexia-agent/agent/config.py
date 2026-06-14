"""Load and access agent/langchain_config.yaml."""

from __future__ import annotations

import functools
from pathlib import Path
from typing import Any, Dict

import yaml


_CONFIG_PATH = Path(__file__).resolve().parent.parent / "config" / "langchain_config.yaml"


@functools.lru_cache(maxsize=1)
def load_langchain_config() -> Dict[str, Any]:
    """Load config/langchain_config.yaml once per process."""
    if not _CONFIG_PATH.is_file():
        return {}
    with _CONFIG_PATH.open("r", encoding="utf-8") as fh:
        data = yaml.safe_load(fh) or {}
    return data


def get_section(name: str) -> Dict[str, Any]:
    return load_langchain_config().get(name, {}) or {}
