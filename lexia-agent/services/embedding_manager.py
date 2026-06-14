"""
Embedding Manager for multi-source semantic search.

Manages embeddings calculation, caching, and search across multiple data sources.
"""

import logging
from pathlib import Path
from typing import Dict, List, Any, Optional, TYPE_CHECKING
import pandas as pd
import unicodedata

from data.classes.columns_classes import ColumnClass, ColumnsClasses

if TYPE_CHECKING:
    from services.cache_manager import CacheManager

logger = logging.getLogger(__name__)

# Default embedding model (French-capable multilingual model)
DEFAULT_MODEL = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"


class EmbeddingManager:
    """
    Manages embeddings for multiple data sources.

    Features:
    - Per-source embeddings calculation
    - Caching of embeddings to parquet files
    - Unified semantic search across sources
    - Support for custom ColumnsClasses per source
    - Reuses existing SentenceTransformer model
    """

    def __init__(self, cache_manager: 'CacheManager', model_name: str = DEFAULT_MODEL):
        """
        Initialize embedding manager.

        Args:
            cache_manager: CacheManager instance for saving/loading embeddings
            model_name: SentenceTransformer model name (default: multilingual MiniLM)
        """
        self.cache_manager = cache_manager
        self.model_name = model_name
        self.model = None

        # Store ColumnsClasses per source
        self.source_columns: Dict[str, ColumnsClasses] = {}

        logger.info(
            f"EmbeddingManager initialized (lazy model load enabled): {model_name}"
        )

    def _ensure_model(self):
        """Lazy-load SentenceTransformer only when embeddings are actually needed."""
        if self.model is None:
            from services.embedding_model_provider import get_embedding_model
            self.model = get_embedding_model(self.model_name)
        return self.model

    @staticmethod
    def _normalize_text(text: Any) -> str:
        """
        Normalize text for case-insensitive semantic matching.

        Args:
            text: Text to normalize

        Returns:
            Normalized text (lowercase, no accents)
        """
        if text is None:
            return ""
        if not isinstance(text, str):
            text = str(text)
        text = unicodedata.normalize("NFKC", text)
        return text.strip().lower()

    def calculate_embeddings(
        self,
        values: List[str],
        definitions: Optional[List[str]] = None
    ) -> List[List[Any]]:
        """
        Calculate embeddings for a list of values.

        Args:
            values: List of values to embed
            definitions: Optional list of definitions (one per value)

        Returns:
            List of embeddings (each embedding is a list of floats)
            If definitions provided, returns paired embeddings [value_emb, definition_emb]
        """
        model = self._ensure_model()
        value_embeddings = model.encode(values).tolist()

        if definitions is None or all(d is None for d in definitions):
            return [[emb] for emb in value_embeddings]

        definition_embeddings = model.encode(definitions).tolist()
        paired: List[List[Any]] = []
        for value_emb, definition_emb, definition in zip(
            value_embeddings, definition_embeddings, definitions
        ):
            if definition:
                paired.append([value_emb, definition_emb])
            else:
                paired.append([value_emb])

        return paired

    def calculate_source_embeddings(
        self,
        source_id: str,
        df: pd.DataFrame,
        columns_classes: ColumnsClasses
    ) -> ColumnsClasses:
        """
        Calculate embeddings for a specific data source.

        Args:
            source_id: Identifier of the data source
            df: DataFrame containing the data
            columns_classes: ColumnsClasses with column definitions

        Returns:
            ColumnsClasses with embeddings populated
        """
        logger.info(f"Calculating embeddings for source '{source_id}'")

        # Get categorical columns
        categorical_columns = [
            col for col in columns_classes.columns if col.is_categorical
        ]

        if not categorical_columns:
            logger.warning(f"No categorical columns found for source '{source_id}'")
            return columns_classes

        # Calculate embeddings for each categorical column
        for column in categorical_columns:
            if column.column_name not in df.columns:
                logger.warning(
                    f"Column '{column.column_name}' not found in DataFrame for source '{source_id}'"
                )
                continue

            # Extract distinct values
            raw_values = list(df[column.column_name].dropna().unique())

            if not raw_values:
                logger.warning(
                    f"No values found in column '{column.column_name}' for source '{source_id}'"
                )
                continue

            # Normalize values for embedding
            norm_values = [self._normalize_text(v) for v in raw_values]

            # Get definitions if available (from column.definition_values or None)
            definition_values = column.definition_values if column.definition_values else [None] * len(raw_values)

            # Calculate embeddings
            column.distinct_values = raw_values
            column.definition_values = definition_values
            column.embedded_values = self.calculate_embeddings(norm_values, definition_values)

            logger.info(
                f"  Column '{column.column_name}': {len(raw_values)} distinct values, "
                f"embeddings calculated"
            )

        # Store for this source
        self.source_columns[source_id] = columns_classes

        return columns_classes

    def calculate_table_embeddings(
        self,
        source_id: str,
        table_id: str,
        df: pd.DataFrame,
        columns_classes: ColumnsClasses
    ) -> ColumnsClasses:
        """
        Calculate embeddings for a specific table within a source.

        This is a convenience method that calls calculate_source_embeddings
        with a compound source ID.

        Args:
            source_id: Data source identifier (e.g., "sql_bambinos_db")
            table_id: Table identifier (e.g., "commande_entete")
            df: DataFrame for this table
            columns_classes: ColumnsClasses with column definitions for this table

        Returns:
            ColumnsClasses with embeddings populated
        """
        # Use compound source ID for per-table embeddings
        compound_id = f"{source_id}_{table_id}"
        logger.info(f"Calculating table embeddings: {compound_id}")
        return self.calculate_source_embeddings(compound_id, df, columns_classes)

    def get_columns_classes(self, source_id: str) -> Optional[ColumnsClasses]:
        """
        Get ColumnsClasses for a specific source.

        Args:
            source_id: Identifier of the data source

        Returns:
            ColumnsClasses if available, None otherwise
        """
        return self.source_columns.get(source_id)

    def get_all_columns_classes(self) -> Dict[str, ColumnsClasses]:
        """
        Get all ColumnsClasses for all sources.

        Returns:
            Dictionary mapping source_id to ColumnsClasses
        """
        return self.source_columns.copy()

    def save_embeddings(self, source_id: str) -> Optional[Path]:
        """
        Save embeddings for a source to cache.

        Args:
            source_id: Identifier of the data source

        Returns:
            Path to cached embeddings file, or None if failed
        """
        columns_classes = self.source_columns.get(source_id)
        if columns_classes is None:
            logger.warning(f"No embeddings to save for source '{source_id}'")
            return None

        try:
            # Convert ColumnsClasses to DataFrame for caching
            rows = []
            for column in columns_classes.columns:
                if not column.is_categorical:
                    continue

                rows.append({
                    "column_name": column.column_name,
                    "description": column.description,
                    "type": column.type,
                    "is_categorical": column.is_categorical,
                    "distinct_values": column.distinct_values,
                    "embedded_values": column.embedded_values,
                    "definition_values": column.definition_values,
                })

            if not rows:
                logger.warning(f"No categorical columns with embeddings for source '{source_id}'")
                return None

            df = pd.DataFrame(rows)

            import json
            import numpy as _np

            def _json_safe(obj):
                """Recursively convert numpy scalars to native Python for JSON."""
                if isinstance(obj, (list, tuple)):
                    return [_json_safe(v) for v in obj]
                if isinstance(obj, _np.integer):
                    return int(obj)
                if isinstance(obj, _np.floating):
                    return float(obj)
                if isinstance(obj, _np.ndarray):
                    return obj.tolist()
                return obj

            def _to_json(x):
                if not x:
                    return "[]"
                return json.dumps(_json_safe(x), ensure_ascii=False)

            df['distinct_values'] = df['distinct_values'].apply(_to_json)
            df['embedded_values'] = df['embedded_values'].apply(_to_json)
            df['definition_values'] = df['definition_values'].apply(_to_json)

            from nodes.dataloader.parquet_writer_node import write_parquet

            cache_path = self.cache_manager.get_cache_path(source_id, "embeddings")
            write_parquet(df, cache_path)
            return cache_path

        except Exception as e:
            logger.error(f"Failed to save embeddings for source '{source_id}': {str(e)}")
            return None

    def load_embeddings(self, source_id: str) -> Optional[ColumnsClasses]:
        """
        Load embeddings for a source from cache.

        Args:
            source_id: Identifier of the data source

        Returns:
            ColumnsClasses if cache exists, None otherwise
        """
        cache_path = self.cache_manager.get_cache_path(source_id, "embeddings")

        if not cache_path.exists():
            logger.debug(f"No embeddings cache found for source '{source_id}'")
            return None

        try:
            df = pd.read_parquet(cache_path, engine='pyarrow')

            # Convert JSON strings back to lists
            import json
            df['distinct_values'] = df['distinct_values'].apply(json.loads)
            df['embedded_values'] = df['embedded_values'].apply(json.loads)
            df['definition_values'] = df['definition_values'].apply(json.loads)

            # Build ColumnsClasses
            columns = []
            for _, row in df.iterrows():
                columns.append(
                    ColumnClass(
                        column_name=row['column_name'],
                        description=row['description'],
                        type=row['type'],
                        is_categorical=bool(row['is_categorical']),
                        distinct_values=row['distinct_values'],
                        embedded_values=row['embedded_values'],
                        definition_values=row['definition_values'],
                    )
                )

            columns_classes = ColumnsClasses(columns=columns)
            self.source_columns[source_id] = columns_classes

            logger.info(
                f"Loaded embeddings for source '{source_id}' from cache "
                f"({len(columns)} columns)"
            )
            return columns_classes

        except Exception as e:
            logger.error(f"Failed to load embeddings for source '{source_id}': {str(e)}")
            return None

    def update_source_embeddings_incremental(
        self,
        source_id: str,
        df: pd.DataFrame,
        columns_classes: ColumnsClasses
    ) -> ColumnsClasses:
        """
        Incrementally update embeddings for a source - only embed new distinct values.

        Args:
            source_id: Identifier of the data source
            df: DataFrame containing the (possibly updated) data
            columns_classes: ColumnsClasses with column definitions

        Returns:
            ColumnsClasses with embeddings populated (including new values)
        """
        # Try to load existing embeddings
        existing = self.load_embeddings(source_id)

        if existing is None:
            # No existing embeddings - calculate all
            logger.info(f"No existing embeddings for '{source_id}', calculating all")
            return self.calculate_source_embeddings(source_id, df, columns_classes)

        logger.info(f"Checking for new values to embed in source '{source_id}'")

        # Build lookup of existing column embeddings
        existing_cols = {col.column_name: col for col in existing.columns if col.is_categorical}

        # Get categorical columns from new schema
        categorical_columns = [col for col in columns_classes.columns if col.is_categorical]

        new_values_count = 0

        for column in categorical_columns:
            if column.column_name not in df.columns:
                continue

            # Extract current distinct values from data
            raw_values = list(df[column.column_name].dropna().unique())

            if not raw_values:
                continue

            existing_col = existing_cols.get(column.column_name)

            if existing_col is None:
                # New column - embed all values
                logger.info(f"  New column '{column.column_name}': embedding {len(raw_values)} values")
                norm_values = [self._normalize_text(v) for v in raw_values]
                definitions = column.definition_values if column.definition_values else [None] * len(raw_values)
                column.distinct_values = raw_values
                column.definition_values = definitions
                column.embedded_values = self.calculate_embeddings(norm_values, definitions)
                new_values_count += len(raw_values)
            else:
                # Existing column - find new values
                existing_set = set(str(v) for v in (existing_col.distinct_values or []))
                new_raw_values = [v for v in raw_values if str(v) not in existing_set]

                if new_raw_values:
                    logger.info(
                        f"  Column '{column.column_name}': {len(new_raw_values)} new values "
                        f"(existing: {len(existing_set)})"
                    )

                    # Embed only new values
                    new_norm_values = [self._normalize_text(v) for v in new_raw_values]
                    new_definitions = [None] * len(new_raw_values)  # TODO: support definitions for new values
                    new_embeddings = self.calculate_embeddings(new_norm_values, new_definitions)

                    # Merge with existing
                    column.distinct_values = (existing_col.distinct_values or []) + new_raw_values
                    column.definition_values = (existing_col.definition_values or []) + new_definitions
                    column.embedded_values = (existing_col.embedded_values or []) + new_embeddings

                    new_values_count += len(new_raw_values)
                else:
                    # No new values - keep existing
                    column.distinct_values = existing_col.distinct_values
                    column.definition_values = existing_col.definition_values
                    column.embedded_values = existing_col.embedded_values

        if new_values_count > 0:
            logger.info(f"Embedded {new_values_count} new values for source '{source_id}'")
        else:
            logger.info(f"No new values to embed for source '{source_id}'")

        # Store updated columns
        self.source_columns[source_id] = columns_classes

        return columns_classes

    def search_across_sources(
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
            column_name: Specific column name to search (None for all categorical columns)
            threshold: Minimum similarity threshold (0-1)
            top_k: Maximum number of results per source

        Returns:
            List of results with similarity scores, sorted by similarity descending
            Each result: {
                "source_id": str,
                "column_name": str,
                "value": str,
                "similarity": float,
                "definition": str (optional)
            }
        """
        # Normalize query
        query_norm = self._normalize_text(query)
        model = self._ensure_model()
        query_embedding = model.encode([query_norm])[0]

        # Determine which sources to search
        if source_ids is None:
            source_ids = list(self.source_columns.keys())

        results = []

        for source_id in source_ids:
            columns_classes = self.source_columns.get(source_id)
            if columns_classes is None:
                continue

            # Get categorical columns
            categorical_cols = [
                col for col in columns_classes.columns if col.is_categorical
            ]

            # Filter by column name if specified
            if column_name:
                categorical_cols = [
                    col for col in categorical_cols if col.column_name == column_name
                ]

            # Search each column
            for column in categorical_cols:
                if not column.embedded_values or not column.distinct_values:
                    continue

                # Calculate similarity for each embedded value
                for i, (value, embedded) in enumerate(
                    zip(column.distinct_values, column.embedded_values)
                ):
                    if not embedded:
                        continue

                    # Get value embedding (first in list)
                    value_emb = embedded[0]

                    # Calculate cosine similarity
                    import numpy as np
                    similarity = float(
                        np.dot(query_embedding, value_emb)
                        / (np.linalg.norm(query_embedding) * np.linalg.norm(value_emb))
                    )

                    if similarity >= threshold:
                        result = {
                            "source_id": source_id,
                            "column_name": column.column_name,
                            "value": value,
                            "similarity": similarity,
                        }

                        # Add definition if available
                        if column.definition_values and i < len(column.definition_values):
                            definition = column.definition_values[i]
                            if definition:
                                result["definition"] = definition

                        results.append(result)

        # Sort by similarity descending and take top_k per source
        results.sort(key=lambda x: x['similarity'], reverse=True)

        # Limit results per source
        if top_k > 0:
            source_counts: Dict[str, int] = {}
            filtered_results = []
            for result in results:
                sid = result['source_id']
                if source_counts.get(sid, 0) < top_k:
                    filtered_results.append(result)
                    source_counts[sid] = source_counts.get(sid, 0) + 1
            results = filtered_results

        logger.info(
            f"Search for '{query}' found {len(results)} results across {len(source_ids)} sources"
        )

        return results

    def get_source_stats(self, source_id: str) -> Dict[str, Any]:
        """
        Get statistics about embeddings for a source.

        Args:
            source_id: Identifier of the data source

        Returns:
            Dictionary with statistics
        """
        columns_classes = self.source_columns.get(source_id)
        if columns_classes is None:
            return {"source_id": source_id, "error": "No embeddings available"}

        categorical_columns = [
            col for col in columns_classes.columns if col.is_categorical
        ]

        total_values = sum(
            len(col.distinct_values) if col.distinct_values else 0
            for col in categorical_columns
        )

        return {
            "source_id": source_id,
            "total_columns": len(columns_classes.columns),
            "categorical_columns": len(categorical_columns),
            "total_distinct_values": total_values,
            "columns": [
                {
                    "column_name": col.column_name,
                    "distinct_values_count": len(col.distinct_values) if col.distinct_values else 0,
                    "has_embeddings": bool(col.embedded_values),
                }
                for col in categorical_columns
            ],
        }

    def invalidate_source(self, source_id: str):
        """
        Invalidate embeddings for a source.

        Args:
            source_id: Identifier of the data source
        """
        if source_id in self.source_columns:
            del self.source_columns[source_id]
            logger.info(f"Invalidated embeddings for source '{source_id}'")

    def __repr__(self) -> str:
        return (
            f"EmbeddingManager(model='{self.model_name}', "
            f"sources={len(self.source_columns)})"
        )
