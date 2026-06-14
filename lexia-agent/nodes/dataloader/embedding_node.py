"""
EmbeddingNode — Calculate or update embeddings for the current source.

Uses EmbeddingManager to compute embeddings for categorical columns,
supporting both full and incremental modes. After processing, checks
whether more sources remain and routes accordingly.
"""

import importlib
from typing import Any, Dict, Optional

from nodes.base_node import BaseNode
from data.classes.columns_classes import ColumnsClasses


def _resolve_columns_class(columns_class_path: str) -> Optional[ColumnsClasses]:
    """
    Dynamically import and call a columns_class function.

    Args:
        columns_class_path: Dotted path like
            "classes.dtos.commande_entete_dto:get_commande_entete_columns_descriptions"

    Returns:
        ColumnsClasses instance or None on failure.
    """
    try:
        module_path, func_name = columns_class_path.rsplit(":", 1)
        module = importlib.import_module(module_path)
        func = getattr(module, func_name)
        return func()
    except Exception:
        return None


class EmbeddingNode(BaseNode):
    """Calculate/update embeddings then decide whether to loop or finish."""

    def prep(self, shared: Dict[str, Any]) -> Dict[str, Any]:
        self.log_entry(shared)
        return {
            "fetched_data": self.require_from_shared(shared, "fetched_data"),
            "connector": self.require_from_shared(shared, "current_connector"),
            "source_config": self.require_from_shared(shared, "current_source_config"),
            "connector_manager": self.require_from_shared(shared, "connector_manager"),
            "incremental": shared.get("incremental", False),
        }

    def exec(self, prep_result: Dict[str, Any]) -> Dict[str, Any]:
        data = prep_result["fetched_data"]
        connector = prep_result["connector"]
        source_config = prep_result["source_config"]
        connector_manager = prep_result["connector_manager"]
        incremental = prep_result["incremental"]
        source_id = connector.source_id
        embedding_manager = connector_manager.embedding_manager

        embedded_ids = []

        if isinstance(data, dict):
            # Multi-table: embed each table individually
            for table_id, df in data.items():
                if table_id == "_default":
                    continue

                # Try to get columns_class for this table
                columns_classes = None
                if hasattr(connector, "get_columns_classes"):
                    columns_classes = connector.get_columns_classes(table_id)

                if columns_classes is None:
                    # Try from table config
                    if source_config.tables:
                        for tbl in source_config.tables:
                            if tbl.table_id == table_id and tbl.columns_class:
                                columns_classes = _resolve_columns_class(tbl.columns_class)
                                break

                if columns_classes is None:
                    self.logger.debug(
                        f"No columns_class for table '{table_id}', skipping embeddings"
                    )
                    continue

                compound_id = f"{source_id}_{table_id}"
                self._embed_source(
                    embedding_manager, compound_id, df, columns_classes, incremental
                )
                embedded_ids.append(compound_id)
        else:
            # Single-table source
            columns_classes = None

            # Try connector method
            if hasattr(connector, "get_columns_classes"):
                try:
                    columns_classes = connector.get_columns_classes()
                except TypeError:
                    pass

            # Fallback: resolve from config
            if columns_classes is None and source_config.columns_class:
                columns_classes = _resolve_columns_class(source_config.columns_class)

            if columns_classes is not None:
                self._embed_source(
                    embedding_manager, source_id, data, columns_classes, incremental
                )
                embedded_ids.append(source_id)
            else:
                self.logger.debug(
                    f"No columns_class for source '{source_id}', skipping embeddings"
                )

        return {
            "source_id": source_id,
            "embedded_ids": embedded_ids,
        }

    def _embed_source(
        self, embedding_manager, compound_id, df, columns_classes, incremental
    ):
        """Run embedding calculation and persist."""
        if incremental:
            embedding_manager.update_source_embeddings_incremental(
                compound_id, df, columns_classes
            )
        else:
            embedding_manager.calculate_source_embeddings(
                compound_id, df, columns_classes
            )
        embedding_manager.save_embeddings(compound_id)
        self.logger.info(f"Embeddings updated for '{compound_id}'")

    def post(self, shared: Dict[str, Any], prep_result: Any, exec_result: Dict[str, Any]) -> str:
        source_id = exec_result["source_id"]
        cache_result = shared.get("cache_result", {})

        # Record success
        shared.setdefault("results", {})[source_id] = {
            "success": True,
            "rows": cache_result.get("rows", 0),
            "embedded_ids": exec_result.get("embedded_ids", []),
        }

        # Check if more sources remain
        sources_left = shared.get("sources_to_process", [])
        if sources_left:
            self.logger.info(
                f"Finished '{source_id}', {len(sources_left)} source(s) remaining"
            )
            return "next_source"

        self.logger.info(f"Finished '{source_id}', all sources processed")
        return "done"
