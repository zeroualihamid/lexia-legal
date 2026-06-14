"""
CacheSaveNode — Save fetched data to parquet cache.

Handles both single-DataFrame and dict-of-DataFrames results.
"""

from typing import Any, Dict

from nodes.base_node import BaseNode


class CacheSaveNode(BaseNode):
    """Save the fetched data to parquet via CacheManager."""

    def prep(self, shared: Dict[str, Any]) -> Dict[str, Any]:
        self.log_entry(shared)
        return {
            "fetched_data": self.require_from_shared(shared, "fetched_data"),
            "connector_manager": self.require_from_shared(shared, "connector_manager"),
            "connector": self.require_from_shared(shared, "current_connector"),
            "source_config": self.require_from_shared(shared, "current_source_config"),
        }

    def exec(self, prep_result: Dict[str, Any]) -> Dict[str, Any]:
        data = prep_result["fetched_data"]
        connector_manager = prep_result["connector_manager"]
        connector = prep_result["connector"]
        source_config = prep_result["source_config"]
        source_id = connector.source_id
        cache_manager = connector_manager.cache_manager

        if isinstance(data, dict):
            # Multi-table source
            paths = cache_manager.save_dict(source_id, data)
            total_rows = sum(len(df) for df in data.values())
            self.logger.info(
                f"Cached {len(paths)} tables ({total_rows} total rows) "
                f"for source '{source_id}'"
            )
            return {"source_id": source_id, "cache_paths": paths, "rows": total_rows}
        else:
            # Single-table source
            cache_file = source_config.cache_file
            path = cache_manager.save(source_id, data, cache_file=cache_file)
            self.logger.info(
                f"Cached {len(data)} rows for source '{source_id}' -> {path}"
            )
            return {"source_id": source_id, "cache_paths": {source_id: path}, "rows": len(data)}

    def post(self, shared: Dict[str, Any], prep_result: Any, exec_result: Dict[str, Any]) -> str:
        shared["cache_result"] = exec_result
        return "default"
