"""
ConfigLoaderNode — Load and filter data source configurations.

Reads loader_config.yaml and the Settings.data_sources list,
then resolves which sources should be processed in this run.
"""

from pathlib import Path
from typing import Any, Dict, List

import yaml

from nodes.base_node import BaseNode
from config import DataSourceConfig


class ConfigLoaderNode(BaseNode):
    """Load refresh config and build the list of sources to process."""

    def prep(self, shared: Dict[str, Any]) -> Dict[str, Any]:
        self.log_entry(shared)

        settings = self.require_from_shared(shared, "settings")

        # Load loader_config.yaml
        loader_cfg_path = Path("config/loader_config.yaml")
        loader_config: Dict[str, Any] = {}
        if loader_cfg_path.exists():
            with open(loader_cfg_path, "r", encoding="utf-8") as f:
                loader_config = yaml.safe_load(f) or {}
            self.logger.info(f"Loaded loader config from {loader_cfg_path}")
        else:
            self.logger.warning("config/loader_config.yaml not found, using defaults")

        return {
            "settings": settings,
            "loader_config": loader_config,
            "target_source_id": shared.get("target_source_id"),
        }

    def exec(self, prep_result: Dict[str, Any]) -> List[DataSourceConfig]:
        settings = prep_result["settings"]
        target_source_id = prep_result["target_source_id"]

        # Get enabled data sources from Settings
        all_sources: List[DataSourceConfig] = settings.data_sources

        if target_source_id:
            # Single source requested
            sources = [s for s in all_sources if s.source_id == target_source_id and s.enabled]
            if not sources:
                raise ValueError(
                    f"Source '{target_source_id}' not found or disabled"
                )
            self.logger.info(f"Targeting single source: {target_source_id}")
        else:
            # All enabled sources
            sources = [s for s in all_sources if s.enabled]
            self.logger.info(f"Processing all enabled sources: {len(sources)}")

        return sources

    def post(self, shared: Dict[str, Any], prep_result: Any, exec_result: List[DataSourceConfig]) -> str:
        shared["sources_to_process"] = list(exec_result)  # mutable copy
        self.logger.info(
            f"Sources queued: {[s.source_id for s in exec_result]}"
        )
        return "default"
