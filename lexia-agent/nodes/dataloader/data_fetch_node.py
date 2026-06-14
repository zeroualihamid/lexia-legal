"""
DataFetchNode — Fetch data from the current connector.

Calls connector.fetch_data() and stores the result (DataFrame or dict of
DataFrames) in shared state.  When the raw source file is missing but a
parquet cache exists, loads from cache instead.  Supports retry on transient
errors and skip-source on exhausted retries.
"""

from pathlib import Path
from typing import Any, Dict

import pandas as pd

from nodes.base_node import BaseNode

MAX_RETRIES = 2


def _try_load_cache(connector_manager, source_config) -> Any:
    """Attempt to load data from parquet cache. Returns DataFrame/dict or None."""
    cache_mgr = connector_manager.cache_manager
    source_id = source_config.source_id

    # Multi-table source (e.g. sqlserver with tables list)
    if getattr(source_config, "tables", None):
        frames: Dict[str, pd.DataFrame] = {}
        for tbl in source_config.tables:
            if not tbl.enabled:
                continue
            cache_file = tbl.cache_file
            if cache_file:
                cache_path = Path(cache_mgr.base_dir) / cache_file
            else:
                cache_path = cache_mgr.get_cache_path(f"{source_id}_{tbl.table_id}")
            if cache_path.exists():
                frames[tbl.table_id] = pd.read_parquet(cache_path)
        return frames if frames else None

    # Single-table source (csv, qvd, etc.)
    cache_file = getattr(source_config, "cache_file", None)
    if cache_file:
        cache_path = Path(cache_mgr.base_dir) / cache_file
    else:
        cache_path = cache_mgr.get_cache_path(source_id)
    if cache_path.exists():
        return pd.read_parquet(cache_path)

    return None


class DataFetchNode(BaseNode):
    """Fetch data from the current connector with cache fallback."""

    def prep(self, shared: Dict[str, Any]) -> Dict[str, Any]:
        self.log_entry(shared)
        connector = self.require_from_shared(shared, "current_connector")
        incremental = shared.get("incremental", False)

        if incremental and not connector.supports_incremental():
            self.logger.info(
                f"Source '{connector.source_id}' does not support incremental, "
                "falling back to full fetch"
            )
            incremental = False

        return {
            "connector": connector,
            "incremental": incremental,
            "connector_manager": shared.get("connector_manager"),
            "source_config": shared.get("current_source_config"),
        }

    def exec(self, prep_result: Dict[str, Any]) -> Any:
        connector = prep_result["connector"]
        incremental = prep_result["incremental"]
        source_id = connector.source_id

        self.logger.info(f"Fetching data from '{source_id}' (incremental={incremental})")

        try:
            return connector.fetch_data(incremental=incremental)
        except Exception as exc:
            self.logger.warning(f"Live fetch failed for '{source_id}': {exc}")
            cached = _try_load_cache(
                prep_result["connector_manager"], prep_result["source_config"]
            )
            if cached is not None:
                rows = sum(len(df) for df in cached.values()) if isinstance(cached, dict) else len(cached)
                self.logger.info(f"Loaded {rows} rows from parquet cache for '{source_id}'")
                return cached
            raise

    def post(self, shared: Dict[str, Any], prep_result: Any, exec_result: Any) -> str:
        connector = prep_result["connector"]
        source_id = connector.source_id

        if exec_result is None:
            return self._handle_failure(shared, source_id, "exec returned None")

        shared["fetched_data"] = exec_result

        if isinstance(exec_result, dict):
            total_rows = sum(len(df) for df in exec_result.values())
            table_count = len(exec_result)
        else:
            total_rows = len(exec_result)
            table_count = 1

        self.logger.info(
            f"Fetched {total_rows} rows from {table_count} table(s) "
            f"for source '{source_id}'"
        )

        shared.pop("_fetch_retries", None)
        return "default"

    def exec_fallback(self, prep_result: Any, exc: Exception) -> None:
        connector = prep_result["connector"]
        self.logger.error(f"Fetch failed for '{connector.source_id}': {exc}")
        return None

    def _handle_failure(self, shared: Dict[str, Any], source_id: str, error_msg: str) -> str:
        retries = shared.get("_fetch_retries", 0)
        if retries < MAX_RETRIES:
            shared["_fetch_retries"] = retries + 1
            self.logger.warning(
                f"Retry {retries + 1}/{MAX_RETRIES} for source '{source_id}': {error_msg}"
            )
            return "retry"

        self.logger.error(f"Skipping source '{source_id}' after {MAX_RETRIES} retries")
        shared.pop("_fetch_retries", None)
        shared.setdefault("results", {})[source_id] = {
            "success": False,
            "error": error_msg,
        }
        return "skip_source"
