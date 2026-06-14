"""
Cache manager for parquet file operations.

Handles saving, loading, and invalidating cached DataFrames with
Snappy compression and mixed-type column support.

All parquet *writes* are delegated to ``write_parquet`` from
``nodes.dataloader.parquet_writer_node`` so that a single code-path
controls file creation.
"""

import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Dict, List, Any
import pandas as pd

from nodes.dataloader.parquet_writer_node import write_parquet

logger = logging.getLogger(__name__)


class CacheManager:
    """
    Manages parquet cache files for data sources.

    Provides methods to save, load, and invalidate cached DataFrames,
    handling mixed-type columns and ensuring directory structure.
    """

    def __init__(self, base_dir: str = "data/parquet"):
        """
        Initialize cache manager.

        Args:
            base_dir: Base directory for cache files (default: "data")
        """
        self.base_dir = Path(base_dir)
        self.base_dir.mkdir(parents=True, exist_ok=True)
        logger.info(f"CacheManager initialized with base_dir: {self.base_dir}")

    def get_cache_path(
        self,
        source_id: str,
        table_id: Optional[str] = None,
        cache_type: str = "data",
        cache_file: Optional[str] = None,
    ) -> Path:
        """
        Get cache file path for a source or a specific table within a source.

        Args:
            source_id: Unique identifier for the data source
            table_id: Optional table identifier (for per-table caching)
            cache_type: Type of cache ("data" or "embeddings")

        Returns:
            Path object for cache file

        Examples:
            - get_cache_path("sql_bambinos_db") → "data/sql_bambinos_db.parquet"
            - get_cache_path("sql_bambinos_db", "commande_entete") → "data/sql_bambinos_db_commande_entete.parquet"
            - get_cache_path("sql_bambinos_db", "commande_entete", "embeddings") → "data/sql_bambinos_db_commande_entete_embeddings.parquet"
        """
        if table_id:
            # Per-table cache
            if cache_type == "embeddings":
                filename = f"{source_id}_{table_id}_embeddings.parquet"
            else:
                filename = f"{source_id}_{table_id}.parquet"
        else:
            # Source-level cache (for backward compatibility)
            if cache_file:
                custom_path = Path(cache_file)
                if custom_path.is_absolute():
                    return custom_path
                if custom_path.parts[:len(self.base_dir.parts)] == self.base_dir.parts:
                    return custom_path
                return self.base_dir / custom_path

            if cache_type == "embeddings":
                filename = f"{source_id}_embeddings.parquet"
            else:
                filename = f"{source_id}.parquet"

        return self.base_dir / filename

    def save(
        self,
        source_id: str,
        df: pd.DataFrame,
        cache_type: str = "data",
        cache_file: Optional[str] = None,
    ) -> Path:
        """
        Save DataFrame to parquet cache.

        Args:
            source_id: Unique identifier for the data source
            df: DataFrame to cache
            cache_type: Type of cache ("data" or "embeddings")

        Returns:
            Path to saved cache file

        Raises:
            ValueError: If DataFrame is empty or invalid type
            IOError: If unable to write cache file
        """
        # Type check - ensure df is a DataFrame, not a dictionary
        if isinstance(df, dict):
            raise TypeError(
                f"Cannot save dictionary to cache for source '{source_id}'. "
                "Use save_dict() method instead for multi-table sources."
            )

        if not isinstance(df, pd.DataFrame):
            raise TypeError(
                f"Expected DataFrame, got {type(df).__name__} for source '{source_id}'"
            )

        if df.empty:
            raise ValueError(f"Cannot cache empty DataFrame for source: {source_id}")

        cache_path = self.get_cache_path(source_id, cache_type=cache_type, cache_file=cache_file)

        try:
            write_parquet(df, cache_path)
            return cache_path

        except Exception as e:
            logger.error(f"Failed to save cache for source '{source_id}': {str(e)}")
            raise IOError(f"Cache save failed: {str(e)}") from e

    def load(
        self,
        source_id: str,
        cache_type: str = "data",
        cache_file: Optional[str] = None,
    ) -> Optional[pd.DataFrame]:
        """
        Load DataFrame from parquet cache.

        Args:
            source_id: Unique identifier for the data source
            cache_type: Type of cache ("data" or "embeddings")

        Returns:
            Cached DataFrame if exists, None otherwise
        """
        cache_path = self.get_cache_path(source_id, cache_type=cache_type, cache_file=cache_file)

        if not cache_path.exists():
            logger.debug(f"No cache found for source '{source_id}' at {cache_path}")
            return None

        try:
            df = pd.read_parquet(cache_path, engine='pyarrow')
            logger.info(
                f"Loaded {len(df)} rows, {len(df.columns)} columns "
                f"from cache for source '{source_id}'"
            )
            return df

        except Exception as e:
            logger.error(f"Failed to load cache for source '{source_id}': {str(e)}")
            # If cache is corrupted, invalidate it
            self.invalidate(source_id, cache_type, cache_file=cache_file)
            return None

    def invalidate(
        self,
        source_id: str,
        cache_type: Optional[str] = None,
        cache_file: Optional[str] = None,
    ):
        """
        Delete cache file(s) for a source.

        Args:
            source_id: Unique identifier for the data source
            cache_type: Type of cache to invalidate ("data", "embeddings", or None for both)
        """
        if cache_type is None:
            # Invalidate both data and embeddings caches
            cache_types = ["data", "embeddings"]
        else:
            cache_types = [cache_type]

        for ctype in cache_types:
            cache_path = self.get_cache_path(source_id, cache_type=ctype, cache_file=cache_file)
            if cache_path.exists():
                try:
                    cache_path.unlink()
                    logger.info(f"Invalidated {ctype} cache for source '{source_id}'")
                except Exception as e:
                    logger.error(
                        f"Failed to invalidate {ctype} cache for source '{source_id}': {str(e)}"
                    )

    def exists(
        self,
        source_id: str,
        cache_type: str = "data",
        cache_file: Optional[str] = None,
    ) -> bool:
        """
        Check if cache exists for a source.

        Args:
            source_id: Unique identifier for the data source
            cache_type: Type of cache ("data" or "embeddings")

        Returns:
            True if cache file exists
        """
        cache_path = self.get_cache_path(source_id, cache_type=cache_type, cache_file=cache_file)
        return cache_path.exists()

    def get_cache_info(
        self,
        source_id: str,
        cache_type: str = "data",
        cache_file: Optional[str] = None,
    ) -> Optional[dict]:
        """
        Get information about a cache file.

        Args:
            source_id: Unique identifier for the data source
            cache_type: Type of cache ("data" or "embeddings")

        Returns:
            Dictionary with cache info (size, modified time) or None if not exists
        """
        cache_path = self.get_cache_path(source_id, cache_type=cache_type, cache_file=cache_file)

        if not cache_path.exists():
            return None

        stat = cache_path.stat()
        return {
            "path": str(cache_path),
            "size_bytes": stat.st_size,
            "size_mb": round(stat.st_size / (1024 * 1024), 2),
            "modified": stat.st_mtime,
        }

    def list_caches(self) -> list:
        """
        List all cache files in the base directory.

        Returns:
            List of dictionaries with cache information
        """
        caches = []
        for cache_file in self.base_dir.glob("*.parquet"):
            # Extract source_id from filename
            filename = cache_file.stem
            if filename.endswith("_embeddings"):
                source_id = filename.replace("_embeddings", "")
                cache_type = "embeddings"
            elif filename.endswith("_data"):
                # Backward-compat: legacy CSV cache naming
                source_id = filename.replace("_data", "")
                cache_type = "data"
            else:
                source_id = filename
                cache_type = "data"

            info = self.get_cache_info(source_id, cache_type)
            if info:
                info["source_id"] = source_id
                info["cache_type"] = cache_type
                caches.append(info)

        return caches

    @staticmethod
    def write_cache_meta(
        parquet_path: Path,
        df: pd.DataFrame,
        source_id: str,
        table_id: str,
        table_config: Optional[Dict[str, Any]] = None,
        source_type: Optional[str] = None,
    ) -> None:
        """Write a ``.meta.json`` sidecar alongside a parquet cache file.

        The metadata includes actual date range (when ``cache_window`` is
        configured), row/column counts, and generation timestamp.
        """
        meta: Dict[str, Any] = {
            "source_id": source_id,
            "table_id": table_id,
            "row_count": len(df),
            "column_count": len(df.columns),
            "generated_at": datetime.now(timezone.utc).isoformat(),
        }

        cache_window = (table_config or {}).get("cache_window")
        if cache_window:
            date_col = (
                cache_window.get("date_column")
                if isinstance(cache_window, dict)
                else getattr(cache_window, "date_column", None)
            )
            months = (
                cache_window.get("months", 12)
                if isinstance(cache_window, dict)
                else getattr(cache_window, "months", 12)
            )
            meta["cache_window_months"] = months
            meta["date_column"] = date_col

            if date_col and date_col in df.columns and not df.empty:
                col = df[date_col].dropna()
                if not col.empty:
                    meta["min_date"] = str(col.min())
                    meta["max_date"] = str(col.max())

        _DIALECT_MAP = {"oracle": "oracle", "sqlserver": "sqlserver", "supabase": "postgres"}
        if source_type:
            meta["dialect"] = _DIALECT_MAP.get(source_type, source_type)

        tc = table_config or {}
        if tc.get("query"):
            meta["db_table_ref"] = tc["query"].strip()
        elif tc.get("table_name"):
            meta["db_table_ref"] = tc["table_name"]

        meta_path = parquet_path.with_suffix(".meta.json")
        try:
            meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2))
            logger.debug("Wrote cache meta: %s", meta_path)
        except Exception as exc:
            logger.warning("Failed to write cache meta %s: %s", meta_path, exc)

    def save_dict(
        self,
        source_id: str,
        dataframes: Dict[str, pd.DataFrame],
        cache_type: str = "data",
        table_configs: Optional[Dict[str, Dict[str, Any]]] = None,
        source_type: Optional[str] = None,
    ) -> Dict[str, Path]:
        """
        Save dictionary of DataFrames to separate parquet files.

        Args:
            source_id: Unique identifier for the data source
            dataframes: Dictionary mapping table_id to DataFrame
            cache_type: Type of cache ("data" or "embeddings")

        Returns:
            Dictionary mapping table_id to cache Path

        Examples:
            save_dict("sql_bambinos_db", {"commande_entete": df1, "commande_lignes": df2})
            → Saves:
              - data/sql_bambinos_db_commande_entete.parquet
              - data/sql_bambinos_db_commande_lignes.parquet
        """
        cache_paths = {}
        tc_map = table_configs or {}

        for table_id, df in dataframes.items():
            if df.empty:
                logger.warning(f"Skipping empty DataFrame for table '{table_id}'")
                continue

            cache_path = self.get_cache_path(source_id, table_id, cache_type)

            try:
                write_parquet(df, cache_path)
                cache_paths[table_id] = cache_path

                if cache_type == "data":
                    self.write_cache_meta(
                        cache_path, df, source_id, table_id,
                        table_config=tc_map.get(table_id),
                        source_type=source_type,
                    )
            except Exception as e:
                logger.error(f"Failed to save cache for table '{table_id}': {str(e)}")
                continue

        return cache_paths

    def load_dict(
        self,
        source_id: str,
        table_ids: List[str],
        cache_type: str = "data"
    ) -> Dict[str, pd.DataFrame]:
        """
        Load multiple tables into a dictionary.

        Args:
            source_id: Unique identifier for the data source
            table_ids: List of table identifiers to load
            cache_type: Type of cache ("data" or "embeddings")

        Returns:
            Dictionary mapping table_id to DataFrame

        Examples:
            load_dict("sql_bambinos_db", ["commande_entete", "commande_lignes"])
            → Loads:
              - data/sql_bambinos_db_commande_entete.parquet
              - data/sql_bambinos_db_commande_lignes.parquet
            → Returns: {"commande_entete": df1, "commande_lignes": df2}
        """
        dataframes = {}

        for table_id in table_ids:
            cache_path = self.get_cache_path(source_id, table_id, cache_type)

            if not cache_path.exists():
                logger.debug(f"No cache found for table '{table_id}' at {cache_path}")
                continue

            try:
                df = pd.read_parquet(cache_path, engine='pyarrow')
                dataframes[table_id] = df
                logger.info(
                    f"Loaded table '{table_id}': {len(df)} rows, {len(df.columns)} columns "
                    f"from cache"
                )
            except Exception as e:
                logger.error(f"Failed to load cache for table '{table_id}': {str(e)}")
                # Invalidate corrupted cache
                self.invalidate(source_id, cache_type)
                continue

        return dataframes
