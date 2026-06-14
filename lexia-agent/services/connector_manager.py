"""
Connector Manager for multi-source data architecture.

Orchestrates multiple data source connectors, manages caching,
and provides unified DataFrame interface for the agent.
"""

import logging
from pathlib import Path
from typing import Dict, List, Optional, Any
import pandas as pd

from services.connectors.base_connector import BaseConnector
from services.cache_manager import CacheManager
from services.embedding_manager import EmbeddingManager
from data.classes.columns_classes import ColumnsClasses

logger = logging.getLogger(__name__)


class ConnectorManager:
    """
    Manages multiple data source connectors and provides unified DataFrame access.

    Features:
    - Registry of active connectors
    - Parquet caching per source
    - Merged view across all sources
    - Lazy loading and refresh management
    """

    def __init__(self, cache_base_dir: str = "data", embedding_model: Optional[str] = None):
        """
        Initialize connector manager.

        Args:
            cache_base_dir: Base directory for cache files
            embedding_model: Optional embedding model name (default: multilingual MiniLM)
        """
        self.connectors: Dict[str, BaseConnector] = {}
        self.cache_manager = CacheManager(base_dir=cache_base_dir)
        self.embedding_manager = EmbeddingManager(
            cache_manager=self.cache_manager,
            model_name=embedding_model or "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
        )
        # Dictionary storage: {source_id: {table_id: DataFrame}}
        self._source_dataframes: Dict[str, Dict[str, pd.DataFrame]] = {}
        self._merged_df_cache: Optional[pd.DataFrame] = None
        self._merged_df_dirty = True  # Track if merged view needs rebuild

        logger.info(
            f"ConnectorManager initialized with cache_dir: {cache_base_dir}, "
            f"embedding_model: {self.embedding_manager.model_name}"
        )

    def register_connector(self, connector: BaseConnector):
        """
        Register a new data source connector.

        Args:
            connector: BaseConnector instance to register

        Raises:
            ValueError: If source_id already registered
        """
        if connector.source_id in self.connectors:
            raise ValueError(
                f"Connector with source_id '{connector.source_id}' already registered"
            )

        self.connectors[connector.source_id] = connector
        self._merged_df_dirty = True  # Mark merged view as needing rebuild

        logger.info(
            f"Registered connector: {connector.source_id} "
            f"(type: {connector.source_type}, policy: {connector.refresh_policy.value})"
        )

    def unregister_connector(self, source_id: str):
        """
        Unregister a connector and optionally invalidate its cache.

        Args:
            source_id: Identifier of connector to unregister
        """
        if source_id in self.connectors:
            del self.connectors[source_id]
            self._merged_df_dirty = True
            logger.info(f"Unregistered connector: {source_id}")

    def get_connector(self, source_id: str) -> Optional[BaseConnector]:
        """
        Get a registered connector by source_id.

        Args:
            source_id: Identifier of the connector

        Returns:
            BaseConnector instance or None if not found
        """
        return self.connectors.get(source_id)

    def list_connectors(self) -> List[Dict[str, Any]]:
        """
        List all registered connectors with metadata.

        Returns:
            List of connector metadata dictionaries
        """
        return [
            connector.get_metadata_dict()
            for connector in self.connectors.values()
        ]

    def refresh_source(
        self,
        source_id: str,
        incremental: bool = False,
        force: bool = False,
        update_embeddings: bool = True,
        table_id: Optional[str] = None,
    ) -> bool:
        """
        Refresh data for a specific source and cache each table separately.
        Also updates embeddings if they exist or creates them if missing.

        Args:
            source_id: Identifier of the source to refresh
            incremental: If True, attempt incremental update
            force: If True, bypass needs_refresh check
            update_embeddings: If True, update/create embeddings after data refresh

        Returns:
            True if refresh successful, False otherwise

        Raises:
            ValueError: If source_id not found
        """
        connector = self.get_connector(source_id)
        if connector is None:
            raise ValueError(f"Connector not found: {source_id}")

        # Check if refresh needed (unless forced)
        if not force and not connector.needs_refresh():
            logger.info(
                f"Skipping refresh for '{source_id}' (not needed per policy)"
            )
            return True

        try:
            logger.info(f"Refreshing source: {source_id} (incremental={incremental})")

            # Fetch data from connector (dict for multi-table, DataFrame for single)
            result = connector.fetch_data(incremental=incremental, table_id=table_id)

            if isinstance(result, dict):
                # Multi-table source — build table_configs for .meta.json
                _tc_map = {}
                for tc in getattr(connector, "tables", []) or []:
                    _tid = tc.get("table_id") if isinstance(tc, dict) else getattr(tc, "table_id", None)
                    if _tid:
                        _tc_map[_tid] = tc if isinstance(tc, dict) else tc.__dict__
                self.cache_manager.save_dict(
                    source_id, result,
                    table_configs=_tc_map,
                    source_type=connector.source_type,
                )
                self._source_dataframes[source_id] = result
                total_rows = sum(len(df) for df in result.values())
                table_count = len(result)
            else:
                # Single-table source
                cache_file = connector.config.get("cache_file")
                self.cache_manager.save(source_id, result, cache_file=cache_file)
                # Keep a consistent dict shape for in-memory cache
                self._source_dataframes[source_id] = {"_default": result}
                total_rows = len(result)
                table_count = 1

            # Mark merged view as needing rebuild
            self._merged_df_dirty = True

            logger.info(
                f"Successfully refreshed '{source_id}': "
                f"{total_rows} total rows from {table_count} table(s)"
            )

            # Update embeddings after data refresh
            if update_embeddings:
                self._update_source_embeddings(source_id, result, incremental)

            # Invalidate semantic query cache entries for this source
            try:
                from services.query_cache import get_query_cache
                qc = get_query_cache()
                if qc:
                    n = qc.invalidate(source_id=source_id)
                    if n:
                        logger.info("[query_cache] Invalidated %d entries after refresh of '%s'", n, source_id)
            except Exception as _qc_err:
                logger.debug("query_cache invalidation skipped: %s", _qc_err)

            return True

        except Exception as e:
            logger.error(f"Failed to refresh source '{source_id}': {str(e)}")
            connector.update_metadata(status="error", error=str(e))
            return False

    def _update_source_embeddings(
        self,
        source_id: str,
        data: Any,
        incremental: bool = False
    ):
        """
        Update embeddings for a source after data refresh.

        Args:
            source_id: Identifier of the source
            data: DataFrame or dict of DataFrames
            incremental: If True, only embed new values
        """
        connector = self.get_connector(source_id)
        if connector is None:
            return

        try:
            if isinstance(data, dict):
                # Multi-table source - update embeddings per table
                for table_id, df in data.items():
                    if table_id == "_default":
                        continue

                    compound_id = f"{source_id}_{table_id}"
                    columns_classes = connector.get_columns_classes(table_id) if hasattr(connector, 'get_columns_classes') else None

                    if columns_classes is None:
                        logger.debug(f"No columns_classes for table '{table_id}', skipping embeddings")
                        continue

                    if incremental:
                        # Incremental: only embed new values
                        self.embedding_manager.update_source_embeddings_incremental(
                            compound_id, df, columns_classes
                        )
                    else:
                        # Full refresh: recalculate all embeddings
                        self.embedding_manager.calculate_source_embeddings(
                            compound_id, df, columns_classes
                        )

                    # Save embeddings to cache
                    self.embedding_manager.save_embeddings(compound_id)
                    logger.info(f"Updated embeddings for table '{compound_id}'")

            else:
                # Single-table source
                columns_classes = connector.get_columns_classes() if hasattr(connector, 'get_columns_classes') else None

                if columns_classes is None:
                    logger.debug(f"No columns_classes for source '{source_id}', skipping embeddings")
                    return

                if incremental:
                    self.embedding_manager.update_source_embeddings_incremental(
                        source_id, data, columns_classes
                    )
                else:
                    self.embedding_manager.calculate_source_embeddings(
                        source_id, data, columns_classes
                    )

                # Save embeddings to cache
                self.embedding_manager.save_embeddings(source_id)
                logger.info(f"Updated embeddings for source '{source_id}'")

        except Exception as e:
            logger.error(f"Failed to update embeddings for '{source_id}': {str(e)}")
            # Don't fail the refresh if embeddings fail

    def refresh_all_sources(self, incremental: bool = False) -> Dict[str, bool]:
        """
        Refresh all registered sources.

        Args:
            incremental: If True, attempt incremental updates where supported

        Returns:
            Dictionary mapping source_id to success status
        """
        results = {}
        for source_id in self.connectors.keys():
            try:
                results[source_id] = self.refresh_source(
                    source_id,
                    incremental=incremental,
                    force=False  # Respect individual refresh policies
                )
            except Exception as e:
                logger.error(f"Error refreshing '{source_id}': {str(e)}")
                results[source_id] = False

        return results

    def get_dataframe(
        self,
        source_id: Optional[str] = None,
        use_cache: bool = True
    ) -> pd.DataFrame:
        """
        Get DataFrame for a specific source or merged view of all sources.

        Args:
            source_id: Specific source to retrieve (None for merged view)
            use_cache: Whether to use cached data

        Returns:
            DataFrame with data from source(s)

        Raises:
            ValueError: If source_id not found
            FileNotFoundError: If cache not found and refresh fails
        """
        if source_id is not None:
            # Return specific source
            return self._get_source_dataframe(source_id, use_cache)
        else:
            # Return merged view of all sources
            return self._get_merged_dataframe(use_cache)

    def _get_source_dataframe(
        self,
        source_id: str,
        use_cache: bool = True
    ) -> pd.DataFrame:
        """
        Get DataFrame for a specific source.

        Args:
            source_id: Identifier of the source
            use_cache: Whether to use cached data

        Returns:
            DataFrame with source data

        Raises:
            ValueError: If source not found
        """
        connector = self.get_connector(source_id)
        if connector is None:
            raise ValueError(f"Connector not found: {source_id}")

        # Try loading from cache first
        if use_cache:
            cache_file = connector.config.get("cache_file")
            cached_df = self.cache_manager.load(source_id, cache_file=cache_file)
            if cached_df is not None:
                logger.debug(f"Loaded '{source_id}' from cache")
                return cached_df

        # Cache miss - fetch from source
        logger.info(f"Cache miss for '{source_id}', fetching from source")
        result = connector.fetch_data()

        # Handle both dictionary (multi-table) and DataFrame (single-table) results
        if isinstance(result, dict):
            # Multi-table source - save dictionary and return concatenated view
            self.cache_manager.save_dict(source_id, result)
            self._source_dataframes[source_id] = result

            # For backward compatibility, concatenate all tables
            # NOTE: This defeats the purpose of multi-table architecture
            # Code should use get_dataframes_dict() instead
            logger.warning(
                f"Source '{source_id}' is multi-table. "
                "Use get_dataframes_dict() instead of get_dataframe() to avoid data issues."
            )
            df = pd.concat(result.values(), ignore_index=True, sort=False)
        else:
            # Single-table source - save normally
            df = result
            cache_file = connector.config.get("cache_file")
            self.cache_manager.save(source_id, df, cache_file=cache_file)

        connector.metadata.cache_path = str(
            self.cache_manager.get_cache_path(
                source_id,
                cache_file=connector.config.get("cache_file"),
            )
        )

        # Safety check: ensure we're returning a DataFrame, not a dictionary
        if isinstance(df, dict):
            raise TypeError(
                f"Internal error: _get_source_dataframe returned dict for '{source_id}'. "
                "This should not happen. Use get_dataframes_dict() for multi-table sources."
            )

        return df

    def _get_merged_dataframe(self, use_cache: bool = True) -> pd.DataFrame:
        """
        Get merged DataFrame from all sources.

        Args:
            use_cache: Whether to use cached data for sources

        Returns:
            DataFrame with union of all sources (outer join on columns)
        """
        # Return cached merged view if available and not dirty
        if not self._merged_df_dirty and self._merged_df_cache is not None:
            logger.debug("Returning cached merged DataFrame")
            return self._merged_df_cache

        if not self.connectors:
            logger.warning("No connectors registered, returning empty DataFrame")
            return pd.DataFrame()

        # Load all source DataFrames
        source_dfs = []
        for source_id in self.connectors.keys():
            try:
                df = self._get_source_dataframe(source_id, use_cache)
                source_dfs.append(df)
                logger.debug(
                    f"Added source '{source_id}' to merge: "
                    f"{len(df)} rows, {len(df.columns)} columns"
                )
            except Exception as e:
                logger.error(f"Failed to load source '{source_id}' for merge: {str(e)}")
                continue

        if not source_dfs:
            raise ValueError("No sources available for merged view")

        # Merge DataFrames (union of columns, concatenate rows)
        logger.info(f"Merging {len(source_dfs)} source DataFrames")
        merged_df = pd.concat(source_dfs, ignore_index=True, sort=False)

        # Cache the merged view
        self._merged_df_cache = merged_df
        self._merged_df_dirty = False

        logger.info(
            f"Merged DataFrame created: {len(merged_df)} rows, "
            f"{len(merged_df.columns)} columns "
            f"(from {len(source_dfs)} sources)"
        )

        return merged_df

    def invalidate_cache(
        self,
        source_id: Optional[str] = None,
        cache_type: Optional[str] = None
    ):
        """
        Invalidate cache for a source or all sources.

        Args:
            source_id: Specific source to invalidate (None for all)
            cache_type: Type of cache ("data", "embeddings", or None for both)
        """
        if source_id is not None:
            # Invalidate specific source
            self.cache_manager.invalidate(source_id, cache_type)
            self._merged_df_dirty = True
            logger.info(f"Invalidated cache for source: {source_id}")
        else:
            # Invalidate all sources
            for sid in self.connectors.keys():
                self.cache_manager.invalidate(sid, cache_type)
            self._merged_df_dirty = True
            self._merged_df_cache = None
            logger.info("Invalidated all caches")

    def validate_all_connections(self) -> Dict[str, bool]:
        """
        Validate connections for all registered connectors.

        Returns:
            Dictionary mapping source_id to validation status
        """
        results = {}
        for source_id, connector in self.connectors.items():
            try:
                results[source_id] = connector.validate_connection()
            except Exception as e:
                logger.error(f"Connection validation failed for '{source_id}': {str(e)}")
                results[source_id] = False

        return results

    def get_status(self, source_id: Optional[str] = None) -> Dict[str, Any]:
        """
        Get status information for a source or all sources.

        Args:
            source_id: Specific source (None for all sources)

        Returns:
            Status dictionary with connector metadata and cache info
        """
        if source_id is not None:
            connector = self.get_connector(source_id)
            if connector is None:
                raise ValueError(f"Connector not found: {source_id}")

            return {
                "connector": connector.get_metadata_dict(),
                "cache": self.cache_manager.get_cache_info(source_id),
                "embeddings_cache": self.cache_manager.get_cache_info(
                    source_id, "embeddings"
                ),
            }
        else:
            # Return status for all sources
            return {
                "sources": self.list_connectors(),
                "caches": self.cache_manager.list_caches(),
                "merged_df_cached": self._merged_df_cache is not None,
                "merged_df_dirty": self._merged_df_dirty,
            }

    def get_source_ids(self) -> List[str]:
        """
        Get list of all registered source IDs.

        Returns:
            List of source_id strings
        """
        return list(self.connectors.keys())

    def get_dataframes_dict(
        self,
        source_id: str,
        use_cache: bool = True
    ) -> Dict[str, pd.DataFrame]:
        """
        Get dictionary of DataFrames for a source.

        Args:
            source_id: Identifier of the source
            use_cache: Whether to use cached data

        Returns:
            Dictionary mapping table_id to DataFrame
            Example: {"commande_entete": df1, "commande_lignes": df2}

        Raises:
            ValueError: If source_id not found
        """
        connector = self.get_connector(source_id)
        if connector is None:
            raise ValueError(f"Connector not found: {source_id}")

        # Return from memory cache if available
        if use_cache and source_id in self._source_dataframes:
            logger.debug(f"Returning cached dataframes dict for '{source_id}'")
            return self._source_dataframes[source_id]

        # Load from disk cache
        if use_cache and hasattr(connector, 'tables'):
            table_ids = [
                t.get('table_id') for t in connector.tables
                if t.get('enabled', True)
            ]
            dataframes_dict = self.cache_manager.load_dict(source_id, table_ids)

            if dataframes_dict:
                logger.info(
                    f"Loaded {len(dataframes_dict)} tables from cache for '{source_id}'"
                )
                self._source_dataframes[source_id] = dataframes_dict
                return dataframes_dict

        # Cache miss - fetch from source
        logger.info(f"Cache miss for '{source_id}', fetching from source")
        dataframes_dict = connector.fetch_data()

        # Save to cache
        self.cache_manager.save_dict(source_id, dataframes_dict)

        # Store in memory
        self._source_dataframes[source_id] = dataframes_dict

        return dataframes_dict

    def calculate_embeddings(
        self,
        source_id: str,
        columns_classes: ColumnsClasses,
        force: bool = False
    ) -> bool:
        """
        Calculate embeddings for a data source.

        Args:
            source_id: Identifier of the source
            columns_classes: ColumnsClasses with column definitions
            force: Force recalculation even if cache exists

        Returns:
            True if embeddings calculated successfully
        """
        try:
            # Try loading from cache first (unless forced)
            if not force:
                cached_columns = self.embedding_manager.load_embeddings(source_id)
                if cached_columns is not None:
                    logger.info(f"Loaded embeddings from cache for '{source_id}'")
                    return True

            # Get DataFrame for this source
            df = self.get_dataframe(source_id)

            # Calculate embeddings
            logger.info(f"Calculating embeddings for source '{source_id}'")
            self.embedding_manager.calculate_source_embeddings(
                source_id, df, columns_classes
            )

            # Save to cache
            self.embedding_manager.save_embeddings(source_id)

            logger.info(f"Embeddings calculated and cached for '{source_id}'")
            return True

        except Exception as e:
            logger.error(f"Failed to calculate embeddings for '{source_id}': {str(e)}")
            return False

    def get_columns_classes(self, source_id: str) -> Optional[ColumnsClasses]:
        """
        Get ColumnsClasses for a specific source.

        Args:
            source_id: Identifier of the source

        Returns:
            ColumnsClasses if available, None otherwise
        """
        return self.embedding_manager.get_columns_classes(source_id)

    def get_all_columns_classes(self) -> Dict[str, ColumnsClasses]:
        """
        Get ColumnsClasses for all sources.

        Returns:
            Dictionary mapping source_id to ColumnsClasses
        """
        return self.embedding_manager.get_all_columns_classes()

    def search_values_across_sources(
        self,
        query: str,
        source_ids: Optional[List[str]] = None,
        column_name: Optional[str] = None,
        threshold: float = 0.6,
        top_k: int = 10
    ) -> List[Dict[str, Any]]:
        """
        Search for similar values across multiple sources.

        Args:
            query: Search query text
            source_ids: List of source IDs to search (None for all)
            column_name: Specific column name to search (None for all)
            threshold: Minimum similarity threshold (0-1)
            top_k: Maximum number of results per source

        Returns:
            List of results with similarity scores
        """
        return self.embedding_manager.search_across_sources(
            query=query,
            source_ids=source_ids,
            column_name=column_name,
            threshold=threshold,
            top_k=top_k
        )

    def get_embedding_stats(self, source_id: Optional[str] = None) -> Dict[str, Any]:
        """
        Get embedding statistics for a source or all sources.

        Args:
            source_id: Specific source (None for all sources)

        Returns:
            Statistics dictionary
        """
        if source_id is not None:
            return self.embedding_manager.get_source_stats(source_id)
        else:
            # Return stats for all sources
            return {
                source_id: self.embedding_manager.get_source_stats(source_id)
                for source_id in self.connectors.keys()
            }

    def __repr__(self) -> str:
        return (
            f"ConnectorManager(sources={len(self.connectors)}, "
            f"cache_dir='{self.cache_manager.base_dir}', "
            f"embeddings={len(self.embedding_manager.source_columns)})"
        )
