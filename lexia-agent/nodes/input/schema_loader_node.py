"""
Schema Loader Node

Loads ColumnsClasses definitions from DTOs and injects them into shared state.
All downstream nodes have access to real column names and types.
"""

from pathlib import Path
from typing import Any, Dict, List
import importlib
import yaml

try:
    from ..base_node import BaseNode
except ImportError:
    from nodes.base_node import BaseNode

try:
    from ...monitoring.logger import get_logger
except ImportError:
    from monitoring.logger import get_logger


logger = get_logger(__name__)


def _normalize_path(p: str | None, prefix: str = "data/parquet/") -> str | None:
    if not p:
        return None
    if str(p).startswith("data/"):
        return p
    return f"{prefix}{p}"


def _to_datasource_entry_from_data_source(source: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Convert a data_source dict into one or more datasource entries.

    For simple sources the cache_file lives at the top level.
    For database connectors (oracle, sqlserver, supabase …) each enabled
    *table* carries its own cache_file / embeddings_file / columns_class,
    so we expand each table into a separate entry.
    """
    source_id = source.get("source_id", "")
    source_enabled = source.get("enabled", True)
    tables = source.get("tables")

    if tables:
        entries: List[Dict[str, Any]] = []
        for tbl in tables:
            if not tbl.get("enabled", True) or not source_enabled:
                continue
            cache_file = tbl.get("cache_file")
            if not cache_file:
                continue
            tid = tbl.get("table_id", tbl.get("table_name", ""))
            entries.append({
                "source_id": f"{source_id}_{tid}" if tid else source_id,
                "type": "parquet",
                "enabled": True,
                "path": _normalize_path(cache_file),
                "embeddings_path": _normalize_path(tbl.get("embeddings_file")),
                "columns_class": tbl.get("columns_class"),
                "description": tbl.get("description") or source.get("description", ""),
                "business_context": source.get("business_context", ""),
                "foreign_keys": tbl.get("foreign_keys", []),
                "sql_source_id": source_id,
                "sql_table_id": tid,
            })
        return entries

    cache_file = source.get("cache_file")
    if not cache_file:
        return []

    return [{
        "source_id": source_id,
        "type": "parquet",
        "enabled": source_enabled,
        "path": _normalize_path(cache_file),
        "embeddings_path": _normalize_path(source.get("embeddings_file")),
        "columns_class": source.get("columns_class"),
        "description": source.get("description", ""),
        "business_context": source.get("business_context", ""),
        "foreign_keys": source.get("foreign_keys", []),
    }]


class SchemaLoaderNode(BaseNode):
    """
    Loads ColumnsClasses definitions and injects them into shared state.
    
    This node runs first in the workflow to populate shared['schemas'] and
    shared['datasources_metadata'] with column definitions from all configured
    data sources. This enables downstream nodes to:
    
    1. Access real column names and types
    2. Build accurate prompts with datasource context
    3. Generate correct SQL/pandas queries
    4. Validate user queries against available columns
    
    The node dynamically imports and executes DTO functions specified in
    the datasources.yaml configuration.
    """
    
    def __init__(self, **kwargs):
        """Initialize the schema loader node."""
        super().__init__(**kwargs)
        self.logger = logger
    
    def prep(self, shared: Dict[str, Any]) -> Any:
        """
        Load datasources configuration from YAML.

        If DataLoaderService already populated schemas at startup,
        returns None to signal that exec() should be skipped.

        Args:
            shared: Shared state dictionary

        Returns:
            List of datasource configurations, or None if already loaded
        """
        # If schemas were pre-loaded by DataLoaderService, skip YAML parsing
        if shared.get('schemas') and shared.get('datasources_metadata'):
            self.logger.info(
                "Schemas already pre-loaded by DataLoaderService "
                f"({len(shared['schemas'])} schemas), skipping YAML parse"
            )
            return None

        self.logger.info("Loading datasources configuration")

        # Locate datasources.yaml in config folder
        config_path = Path(__file__).resolve().parents[2] / "config" / "datasources.yaml"

        if not config_path.exists():
            self.logger.error(f"Datasources config not found: {config_path}")
            raise FileNotFoundError(f"Datasources configuration not found: {config_path}")

        with open(config_path, 'r', encoding='utf-8') as f:
            config = yaml.safe_load(f)

        datasources = config.get('datasources', [])
        data_sources = config.get('data_sources', [])

        mirrored_ids = {ds.get('source_id') for ds in datasources}
        for source in data_sources:
            for entry in _to_datasource_entry_from_data_source(source):
                if entry["source_id"] not in mirrored_ids:
                    datasources.append(entry)
                    mirrored_ids.add(entry["source_id"])

        self.logger.info(f"Found {len(datasources)} datasources in configuration")

        return datasources
    
    def exec(self, datasources_config) -> Dict[str, Any]:
        """
        Load parquet paths and descriptions from datasources.yaml, and column schemas from DTOs.

        If prep() returned None (schemas already pre-loaded), returns None
        so that post() knows to skip injection.

        For every enabled datasource we always load from YAML:
          - path: .parquet file path
          - description: short description
          - business_context, type, embeddings_path
        so plan_decomposition_node (and others) can use this info. When columns_class
        is set we also load column definitions from the DTO.
        """
        if datasources_config is None:
            return None

        schemas = {}
        metadata = {}

        for ds in datasources_config:
            source_id = ds.get('source_id')
            enabled = ds.get('enabled', True)

            if not enabled:
                self.logger.info(f"Skipping disabled datasource: {source_id}")
                continue

            # Always load parquet path and description from datasources.yaml
            metadata[source_id] = {
                'path': ds.get('path', ''),
                'description': ds.get('description', ''),
                'business_context': ds.get('business_context', ''),
                'type': ds.get('type', 'parquet'),
                'embeddings_path': ds.get('embeddings_path'),
                'enabled': ds.get('enabled', True),
                'foreign_keys': ds.get('foreign_keys', []),
                'sql_source_id': ds.get('sql_source_id'),
                'sql_table_name': ds.get('sql_table_name'),
                'sql_table_id': ds.get('sql_table_id'),
            }
            self.logger.info(f"Loaded parquet info for {source_id}: {metadata[source_id].get('path', 'N/A')}")

            # Optionally load column schema from DTO
            columns_class_ref = ds.get('columns_class')
            if not columns_class_ref:
                self.logger.debug(f"No columns_class for {source_id}; path and description are still available")
                continue

            if ':' not in columns_class_ref:
                self.logger.error(f"Invalid columns_class format for {source_id}: {columns_class_ref}")
                continue

            try:
                module_path, function_name = columns_class_ref.split(':')
                self.logger.debug(f"Importing module: {module_path}")
                module = importlib.import_module(module_path)
                get_columns_func = getattr(module, function_name)
                columns_classes = get_columns_func()

                schemas[source_id] = columns_classes
                column_count = len(columns_classes.columns)
                self.logger.info(f"Loaded schema for {source_id} with {column_count} columns")
            except ImportError as e:
                self.logger.error(f"Failed to import module for {source_id}: {e}")
            except AttributeError as e:
                self.logger.error(f"Failed to get function for {source_id}: {e}")
            except Exception as e:
                self.logger.error(f"Unexpected error loading schema for {source_id}: {e}")

        self.logger.info(
            f"Loaded {len(metadata)} parquet datasources (paths/descriptions), {len(schemas)} with column schemas"
        )
        return {'schemas': schemas, 'metadata': metadata}
    
    def post(self, shared: Dict[str, Any], prep_res, exec_res) -> str:
        """
        Inject schemas and metadata into shared state.

        If exec_res is None, schemas were already pre-loaded — nothing to do.

        Args:
            shared: Shared state dictionary
            prep_res: Result from prep() (datasources config or None)
            exec_res: Result from exec() (schemas and metadata or None)

        Returns:
            Action string ("default")
        """
        if exec_res is None:
            self.logger.info("Schemas already in shared state, skipping injection")
            return "default"

        # Inject schemas into shared state
        shared['schemas'] = exec_res['schemas']
        shared['datasources_metadata'] = exec_res['metadata']

        schema_count = len(exec_res['schemas'])
        self.logger.info(f"Injected {schema_count} schemas into shared state")

        # Log summary of loaded schemas
        for source_id in exec_res['schemas'].keys():
            self.logger.debug(f"  - {source_id}: {exec_res['metadata'][source_id].get('description', 'N/A')}")

        return "default"


if __name__ == "__main__":
    """Test the schema loader node."""
    from pprint import pprint
    
    # Create a test shared state
    shared = {
        "schemas": {},
        "datasources_metadata": {}
    }
    
    # Create and run the node
    node = SchemaLoaderNode()
    action = node.run(shared)
    
    print(f"\nAction returned: {action}")
    print(f"\nLoaded {len(shared['schemas'])} schemas")
    print("\nSchemas:")
    for source_id, schema in shared['schemas'].items():
        print(f"\n  {source_id}:")
        print(f"    Columns: {len(schema.columns)}")
        for col in schema.columns[:3]:  # Show first 3 columns
            print(f"      - {col.column_name} ({col.type}): {col.description[:50]}...")
    
    print("\n\nMetadata:")
    pprint(shared['datasources_metadata'])
