"""
Configuration management for Servia CAN 2025 project
"""

import os
import yaml
import re
from pathlib import Path
from typing import Optional, List, Dict, Any
from pydantic_settings import BaseSettings
from pydantic import Field, ConfigDict, field_validator
import logging

logger = logging.getLogger(__name__)


def _clean_env(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    v = value.strip()
    if not v:
        return None
    if (len(v) >= 2) and ((v[0] == v[-1]) and v[0] in ("'", '"')):
        v = v[1:-1].strip()
    return v or None


def _substitute_env_vars(config_data: Any) -> Any:
    """
    Recursively substitute environment variables in configuration.

    Replaces ${VAR_NAME} patterns with the corresponding environment variable value.
    If the environment variable is not set, keeps the original value.

    Args:
        config_data: Configuration data (can be dict, list, str, or other types)

    Returns:
        Configuration data with environment variables substituted
    """
    if isinstance(config_data, dict):
        return {key: _substitute_env_vars(value) for key, value in config_data.items()}
    elif isinstance(config_data, list):
        return [_substitute_env_vars(item) for item in config_data]
    elif isinstance(config_data, str):
        # Pattern to match ${VAR_NAME}
        pattern = r'\$\{([^}]+)\}'

        def replacer(match):
            var_name = match.group(1)
            env_value = os.getenv(var_name)
            if env_value is not None:
                return env_value
            logger.warning("Environment variable '%s' not found, keeping original value", var_name)
            return match.group(0)

        return re.sub(pattern, replacer, config_data)
    else:
        return config_data


class LLMConfig(BaseSettings):
    """LLM configuration settings.

    Only ``provider``, ``temperature``, and ``max_tokens`` are expected in
    config.yaml.  Model, base_url, timeout, etc. are resolved per-provider
    from llm_config.yaml by the factory.
    """

    provider: str = "openai"
    model: Optional[str] = None
    temperature: float = 0.0
    max_tokens: int = 4096
    timeout: int = 120
    max_retries: int = 3
    base_url: Optional[str] = None

    # GPU configuration (primarily for vLLM)
    tensor_parallel_size: Optional[int] = None
    pipeline_parallel_size: Optional[int] = None
    gpu_memory_utilization: float = 0.95
    max_num_seqs: Optional[int] = None


class EmbeddingConfig(BaseSettings):
    """Embedding configuration settings"""

    provider: str = "openai"
    model: str = "text-embedding-3-small"
    dimensions: int = 1536
    base_url: Optional[str] = None
    batch_size: int = 100
    chunk_size: int = 800
    chunk_overlap: int = 100
    min_chunk_size: int = 200
    timeout: int = 60
    max_retries: int = 3


class CodegenConfig(BaseSettings):
    """Code generation model configuration settings"""

    provider: str = "openai"
    model: str = "gpt-5-mini"
    timeout: int = 120
    max_retries: int = 3
    max_output_tokens: int = 4096
    reasoning_effort: str = "low"  # low, medium, high
    base_url: Optional[str] = None  # If None, uses OpenAI default


class PerformanceConfig(BaseSettings):
    """Performance logging configuration settings"""

    enabled: bool = True  # Enable/disable performance tracing
    log_dir: str = "logs/performance"  # Directory for performance logs
    log_per_query: bool = True  # Create one log file per query (vs daily)
    console_output: bool = False  # Also print to console
    include_summary: bool = True  # Include summary at end of session


class SupabaseConfig(BaseSettings):
    """Supabase configuration settings"""

    url: Optional[str] = _clean_env(os.getenv("SUPABASE_URL"))
    anon_key: Optional[str] = _clean_env(os.getenv("SUPABASE_ANON_KEY"))
    service_role_key: Optional[str] = _clean_env(os.getenv("SUPABASE_SERVICE_ROLE_KEY"))
    project_id: Optional[str] = _clean_env(os.getenv("SUPABASE_PROJECT_ID"))


class CacheWindow(BaseSettings):
    """Rolling window configuration for parquet cache of large SQL tables."""

    model_config = ConfigDict(extra="ignore")

    months: int = 12
    date_column: str


class SQLTableConfig(BaseSettings):
    """Configuration for a single SQL table or query"""

    model_config = ConfigDict(extra="ignore")

    table_id: str  # Unique identifier for this table
    table_name: Optional[str] = None  # Physical table name (null if using custom query)
    columns_class: str  # Python path to columns class function (e.g., "qclick.classes.sql_tables.transactions:get_transactions_columns_descriptions")
    incremental_column: Optional[str] = None  # Column to use for incremental updates (e.g., "LastModified")
    query: Optional[str] = None  # Custom SQL query (overrides table_name)
    enabled: bool = True  # Whether this table is active
    description: str = ""  # Description of this table
    cache_file: Optional[str] = None  # Parquet cache filename
    embeddings_file: Optional[str] = None  # Embeddings cache filename
    foreign_keys: Optional[List[Dict[str, Any]]] = None  # Optional FK metadata for joins/lineage
    cache_window: Optional[CacheWindow] = None  # Rolling window for parquet cache (large tables)


class DataSourceConfig(BaseSettings):
    """Base configuration for a data source"""

    model_config = ConfigDict(extra="ignore")

    source_id: str  # Unique identifier for this data source
    type: str  # Connector type: qvd, sqlserver, csv, oracle, supabase, xlsx
    enabled: bool = True  # Whether this source is active
    description: str = ""  # Human-readable description
    refresh_policy: str = "manual"  # Refresh policy: manual, polling, incremental
    refresh_interval_seconds: Optional[int] = None  # Interval for polling (required if policy=polling)

    # QVD-specific fields
    path: Optional[str] = None  # Path to QVD or CSV file
    chunk_size: Optional[int] = 100000  # Chunk size for reading large files

    # SQL Server / Oracle / Supabase specific fields
    host: Optional[str] = None
    port: Optional[int] = None
    database: Optional[str] = None
    username: Optional[str] = None
    password: Optional[str] = None
    db_schema: Optional[str] = None
    table: Optional[str] = None  # For simple single-table connectors
    query: Optional[str] = None  # Custom query for single-table connectors
    incremental_column: Optional[str] = None  # Column for incremental updates

    # SQL-like multi-table configuration
    tables: Optional[List[SQLTableConfig]] = None  # Multiple tables for SQL Server / Supabase

    # CSV-specific fields
    delimiter: Optional[str] = ","
    encoding: Optional[str] = "utf-8"
    date_columns: Optional[List[str]] = None

    # Oracle-specific fields
    service_name: Optional[str] = None

    # MinIO / S3-compatible object-storage fields
    access_key: Optional[str] = None
    secret_key: Optional[str] = None
    bucket: Optional[str] = None
    secure: Optional[bool] = None
    endpoint: Optional[str] = None  # optional pre-composed "host:port" override

    # Optional columns class for non-SQL sources (e.g., CSV)
    columns_class: Optional[str] = None

    # Cache file names
    cache_file: Optional[str] = None  # Parquet cache filename
    embeddings_file: Optional[str] = None  # Embeddings cache filename

    @field_validator("refresh_policy")
    @classmethod
    def validate_refresh_policy(cls, v):
        """Validate refresh policy is one of the allowed values"""
        allowed = ["manual", "polling", "incremental"]
        if v not in allowed:
            raise ValueError(f"refresh_policy must be one of {allowed}, got: {v}")
        return v

    @field_validator("type")
    @classmethod
    def validate_type(cls, v):
        """Validate connector type is supported"""
        allowed = ["qvd", "sqlserver", "csv", "oracle", "supabase", "xlsx", "minio"]
        if v not in allowed:
            raise ValueError(f"type must be one of {allowed}, got: {v}")
        return v


def _resolve_default_model(provider: str) -> str:
    """Look up the default_model for *provider* in llm_config.yaml."""
    llm_cfg_path = Path(__file__).parent / "config" / "llm_config.yaml"
    if llm_cfg_path.exists():
        try:
            with open(llm_cfg_path, "r", encoding="utf-8") as f:
                data = yaml.safe_load(f) or {}
            dm = data.get("providers", {}).get(provider, {}).get("default_model")
            if dm:
                return dm
        except Exception:
            pass
    _hardcoded = {
        "openai": "gpt-4-turbo",
        "anthropic": "claude-sonnet-4",
        "groq": "llama-3.3-70b-versatile",
        "vllm": "openai/gpt-oss-120b",
        "deepseek": "deepseek-chat",
    }
    return _hardcoded.get(provider, "gpt-4-turbo")


def _merge_llm_provider_settings(llm: LLMConfig) -> None:
    """Merge ``providers.<provider>.settings`` from ``llm_config.yaml`` into *llm*.

    Fields populated (only when not already set in config.yaml):
      - base_url
      - timeout
      - max_retries
    """
    llm_cfg_path = Path(__file__).parent / "config" / "llm_config.yaml"
    if not llm_cfg_path.exists():
        return
    try:
        with open(llm_cfg_path, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
    except Exception as exc:
        logger.warning("Could not read llm_config.yaml for provider settings: %s", exc)
        return

    prov_key = (llm.provider or "").strip().lower()
    prov = (data.get("providers") or {}).get(prov_key)
    if not prov:
        return

    settings_block = prov.get("settings") or {}

    if not llm.base_url and settings_block.get("base_url"):
        llm.base_url = str(settings_block["base_url"]).rstrip("/")

    if settings_block.get("timeout") is not None and llm.timeout == LLMConfig.__fields__["timeout"].default:
        llm.timeout = int(settings_block["timeout"])

    if settings_block.get("max_retries") is not None and llm.max_retries == LLMConfig.__fields__["max_retries"].default:
        llm.max_retries = int(settings_block["max_retries"])


def _merge_embedding_provider_settings(emb: EmbeddingConfig) -> None:
    """Resolve embedding model, base_url, dimensions from llm_config.yaml.

    Scans the provider's models for the first entry with ``type: embedding``
    and fills in model/dimensions/base_url when not already set explicitly
    in config.yaml.
    """
    llm_cfg_path = Path(__file__).parent / "config" / "llm_config.yaml"
    if not llm_cfg_path.exists():
        return
    try:
        with open(llm_cfg_path, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
    except Exception:
        return

    prov_key = (emb.provider or "").strip().lower()
    prov = (data.get("providers") or {}).get(prov_key)
    if not prov:
        return

    settings_block = prov.get("settings") or {}

    if not emb.base_url and settings_block.get("base_url"):
        emb.base_url = str(settings_block["base_url"]).rstrip("/")

    if settings_block.get("timeout") is not None and emb.timeout == EmbeddingConfig.__fields__["timeout"].default:
        emb.timeout = int(settings_block["timeout"])

    if settings_block.get("max_retries") is not None and emb.max_retries == EmbeddingConfig.__fields__["max_retries"].default:
        emb.max_retries = int(settings_block["max_retries"])

    models = prov.get("models") or {}
    if emb.model == EmbeddingConfig.__fields__["model"].default:
        for _alias, mcfg in models.items():
            if mcfg.get("type") == "embedding":
                emb.model = mcfg["name"]
                if mcfg.get("dimensions") and emb.dimensions == EmbeddingConfig.__fields__["dimensions"].default:
                    emb.dimensions = int(mcfg["dimensions"])
                break


def _merge_codegen_provider_settings(cg: CodegenConfig) -> None:
    """Resolve codegen model, base_url from llm_config.yaml when not set."""
    llm_cfg_path = Path(__file__).parent / "config" / "llm_config.yaml"
    if not llm_cfg_path.exists():
        return
    try:
        with open(llm_cfg_path, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
    except Exception:
        return

    prov_key = (cg.provider or "").strip().lower()
    prov = (data.get("providers") or {}).get(prov_key)
    if not prov:
        return

    settings_block = prov.get("settings") or {}

    if not cg.base_url and settings_block.get("base_url"):
        cg.base_url = str(settings_block["base_url"]).rstrip("/")

    if settings_block.get("timeout") is not None and cg.timeout == CodegenConfig.__fields__["timeout"].default:
        cg.timeout = int(settings_block["timeout"])

    if settings_block.get("max_retries") is not None and cg.max_retries == CodegenConfig.__fields__["max_retries"].default:
        cg.max_retries = int(settings_block["max_retries"])

    if cg.model == CodegenConfig.__fields__["model"].default:
        dm = prov.get("default_model")
        if dm:
            cg.model = dm


class Settings(BaseSettings):
    """Main settings class that aggregates all configuration"""

    model_config = ConfigDict(env_prefix="SERVIA_", case_sensitive=False)

    llm: LLMConfig = Field(default_factory=LLMConfig)
    embedding: EmbeddingConfig = Field(default_factory=EmbeddingConfig)
    supabase: SupabaseConfig = Field(default_factory=SupabaseConfig)
    codegen: CodegenConfig = Field(default_factory=CodegenConfig)
    performance: PerformanceConfig = Field(default_factory=PerformanceConfig)
    data_sources: List[DataSourceConfig] = Field(default_factory=list)
    task_routing: Dict[str, str] = Field(default_factory=dict)

    @classmethod
    def load_from_yaml(cls, config_path: Optional[Path] = None) -> "Settings":
        """
        Load settings from YAML file with environment variable overrides.

        Args:
            config_path: Path to the main config YAML file. If None, uses default location.

        Returns:
            Settings instance with loaded configuration
        """
        config_dir = Path(__file__).parent / "config"
        config_yaml = config_dir / "config.yaml"
        datasources_yaml = config_dir / "datasources.yaml"

        # Load config.yaml for llm, embedding, codegen, performance
        config_data: Dict[str, Any] = {}
        if config_path is not None:
            config_path = Path(config_path)
            if config_path.exists():
                with open(config_path, "r", encoding="utf-8") as f:
                    config_data = yaml.safe_load(f) or {}
                logger.info(f"✅ Loaded configuration from {config_path}")
        elif config_yaml.exists():
            with open(config_yaml, "r", encoding="utf-8") as f:
                config_data = yaml.safe_load(f) or {}
            logger.info(f"✅ Loaded configuration from {config_yaml}")
        else:
            # Fallback: try legacy locations
            for path in [
                Path("config/config.yaml"),
                Path("config/datasources.yaml"),
                Path("config.yaml"),
            ]:
                if path.exists():
                    with open(path, "r", encoding="utf-8") as f:
                        config_data = yaml.safe_load(f) or {}
                    logger.info(f"✅ Loaded configuration from {path}")
                    break

        # Load datasources.yaml for data_sources (and merge if it has llm/embedding/etc.)
        if datasources_yaml.exists():
            try:
                with open(datasources_yaml, "r", encoding="utf-8") as f:
                    ds_data = yaml.safe_load(f) or {}
                ds_data = _substitute_env_vars(ds_data)
                # data_sources comes from datasources.yaml
                if "data_sources" in ds_data:
                    config_data["data_sources"] = ds_data["data_sources"]
                # If config.yaml was empty, also take llm/embedding/etc. from datasources (backward compat)
                if not config_data.get("llm") and ds_data.get("llm"):
                    config_data.setdefault("llm", ds_data["llm"])
                if not config_data.get("embedding") and ds_data.get("embedding"):
                    config_data.setdefault("embedding", ds_data["embedding"])
                if not config_data.get("codegen") and ds_data.get("codegen"):
                    config_data.setdefault("codegen", ds_data["codegen"])
                if not config_data.get("performance") and ds_data.get("performance"):
                    config_data.setdefault("performance", ds_data["performance"])
            except Exception as e:
                logger.warning("Could not load datasources.yaml: %s", e)

        config_data = _substitute_env_vars(config_data)

        try:
            settings_dict: Dict[str, Any] = {}

            if "llm" in config_data:
                llm = LLMConfig(**config_data["llm"])
                if not llm.model:
                    llm.model = _resolve_default_model(llm.provider)
                _merge_llm_provider_settings(llm)
                settings_dict["llm"] = llm

            if "embedding" in config_data:
                emb = EmbeddingConfig(**config_data["embedding"])
                _merge_embedding_provider_settings(emb)
                settings_dict["embedding"] = emb

            if "supabase" in config_data:
                settings_dict["supabase"] = SupabaseConfig(**config_data["supabase"])

            if "codegen" in config_data:
                cg = CodegenConfig(**config_data["codegen"])
                _merge_codegen_provider_settings(cg)
                settings_dict["codegen"] = cg

            if "performance" in config_data:
                settings_dict["performance"] = PerformanceConfig(**config_data["performance"])

            if "data_sources" in config_data:
                data_sources = []
                for source_config in config_data["data_sources"]:
                    sid = source_config.get("source_id", "?")
                    try:
                        if "tables" in source_config and source_config["tables"]:
                            tables = [SQLTableConfig(**table) for table in source_config["tables"]]
                            source_config["tables"] = tables
                        data_sources.append(DataSourceConfig(**source_config))
                    except Exception as src_err:
                        logger.warning(
                            "⚠️ Skipping data source '%s': %s", sid, src_err
                        )
                settings_dict["data_sources"] = data_sources

            if "task_routing" in config_data and isinstance(config_data["task_routing"], dict):
                settings_dict["task_routing"] = {
                    k: str(v) for k, v in config_data["task_routing"].items()
                }

            return cls(**settings_dict)

        except Exception as e:
            logger.error("❌ Error parsing config: %s", e)
            logger.warning("Using default settings")
            return cls()


# Global settings instance (singleton pattern)
_settings: Optional[Settings] = None


def get_settings(reload: bool = False) -> Settings:
    """
    Get the global settings instance.

    Args:
        reload: If True, reload settings from file

    Returns:
        Settings instance
    """
    global _settings

    if _settings is None or reload:
        _settings = Settings.load_from_yaml()

    return _settings


# Convenience functions to access specific configurations
def get_embedding_config() -> EmbeddingConfig:
    """Get embedding configuration"""
    return get_settings().embedding


# Example usage
if __name__ == "__main__":
    # Load settings directly from YAML
    settings = Settings.load_from_yaml()

    print("=" * 80)
    print("SERVIA CAN 2025 - Configuration")
    print("=" * 80)
    print(f"LLM Provider: {settings.llm.provider}")
    print(f"LLM Model: {settings.llm.model}")
    print(f"LLM Temperature: {settings.llm.temperature}")
    print(f"LLM Max Tokens: {settings.llm.max_tokens}")
    print(f"LLM Timeout: {settings.llm.timeout}")
    print(f"LLM Max Retries: {settings.llm.max_retries}")
    print("")
    print(f"Embedding Provider: {settings.embedding.provider}")
    print(f"Embedding Model: {settings.embedding.model}")
    print(f"Embedding Dimensions: {settings.embedding.dimensions}")
    print(f"Embedding Batch Size: {settings.embedding.batch_size}")
    print(f"Chunk Size: {settings.embedding.chunk_size}")
    print(f"Chunk Overlap: {settings.embedding.chunk_overlap}")
    print(f"Min Chunk Size: {settings.embedding.min_chunk_size}")
    print("=" * 80)
