"""
Config package: re-exports from config.settings (Pydantic) and config.py (YAML loader).

The root config.py is shadowed by this package. We load it explicitly so that
`from config import get_settings, DataSourceConfig, ...` works.
"""

from config.settings import settings

# Re-export YAML-based config from root config.py (loaded by path to avoid shadowing)
import importlib.util
from pathlib import Path

_root = Path(__file__).resolve().parent.parent
_config_py = _root / "config.py"
if not _config_py.exists():
    # Compiled release: find the Cython .so variant. The build pipeline renames
    # root config.py -> _yaml_config.py before compilation so the resulting .so
    # exposes PyInit__yaml_config and can be loaded under that name.
    _so_candidates = sorted(_root.glob("_yaml_config.cpython-*.so"))
    if not _so_candidates:
        _so_candidates = sorted(_root.glob("config.cpython-*.so"))
    if _so_candidates:
        _config_py = _so_candidates[0]
    else:
        _config_py = None

if _config_py is not None and _config_py.exists():
    _spec = importlib.util.spec_from_file_location("_yaml_config", str(_config_py))
    _yaml = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(_yaml)
    get_settings = _yaml.get_settings
    DataSourceConfig = _yaml.DataSourceConfig
    SQLTableConfig = _yaml.SQLTableConfig
    CacheWindow = _yaml.CacheWindow
    Settings = _yaml.Settings
    LLMConfig = _yaml.LLMConfig
    EmbeddingConfig = _yaml.EmbeddingConfig
    CodegenConfig = _yaml.CodegenConfig
elif _config_py is None or not _config_py.exists():
    # Fallback if config.py missing (neither .py nor .so found)
    def get_settings(reload: bool = False):
        raise ImportError("config.py not found; YAML config unavailable")

    DataSourceConfig = None
    SQLTableConfig = None
    CacheWindow = None
    Settings = None
    LLMConfig = None
    EmbeddingConfig = None
    CodegenConfig = None

__all__ = [
    "settings",
    "get_settings",
    "DataSourceConfig",
    "SQLTableConfig",
    "CacheWindow",
    "Settings",
    "LLMConfig",
    "EmbeddingConfig",
    "CodegenConfig",
]
