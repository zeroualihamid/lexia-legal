"""
LiveSQLExecutionNode — Execute native SQL on a live database via its connector.

Used when the LLM decides a query requires data beyond the parquet cache window
and targets ``live_sql`` instead of DuckDB.
"""

from __future__ import annotations

import time
from typing import Any, Dict, List, Optional

import pandas as pd

from monitoring.logger import get_logger

logger = get_logger(__name__)

_DEFAULT_MAX_ROWS = 500


def execute_live_sql(
    query_descriptor: Dict[str, Any],
    connector_manager: Any = None,
    max_rows: int = _DEFAULT_MAX_ROWS,
) -> Dict[str, Any]:
    """Execute a single live SQL query and return a result dict.

    ``query_descriptor`` must contain:
        - ``source_id`` — connector identifier (e.g. ``oracle_env``)
        - ``sql``       — native SQL for the remote database
        - ``label``     — human-readable description

    ``connector_manager`` is the ``ConnectorManager`` instance
    (passed from ``shared["connector_manager"]``).

    Returns the same shape as ``SQLExecutionNode`` results.
    """
    source_id: str = query_descriptor.get("source_id", "")
    sql: str = query_descriptor.get("sql", "")
    label: str = query_descriptor.get("label", "Live SQL query")

    if not source_id or not sql.strip():
        return {
            "label": label,
            "sql": sql,
            "columns": [],
            "rows": [],
            "row_count": 0,
            "truncated": False,
            "error": "Missing source_id or empty SQL for live_sql query",
        }

    if connector_manager is None:
        return {
            "label": label,
            "sql": sql,
            "columns": [],
            "rows": [],
            "row_count": 0,
            "truncated": False,
            "error": "No connector_manager available for live_sql execution",
        }

    start = time.time()
    try:
        connector = connector_manager.get_connector(source_id)
        if connector is None:
            raise ValueError(f"Connector not found: {source_id}")

        connection = connector._get_connection()
        df: pd.DataFrame = pd.read_sql(sql, connection)

        total_rows = len(df)
        truncated = total_rows > max_rows
        if truncated:
            df = df.head(max_rows)

        columns = list(df.columns)
        rows = [
            [
                None if pd.isna(v) else
                float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else
                str(v) if not isinstance(v, (str, int, float, bool, type(None))) else
                v
                for v in row
            ]
            for row in df.itertuples(index=False, name=None)
        ]

        duration_ms = round((time.time() - start) * 1000, 1)
        logger.info(
            "live_sql [%s] %s: %d rows in %.1fms",
            source_id, label, total_rows, duration_ms,
        )

        return {
            "label": label,
            "sql": sql,
            "columns": columns,
            "rows": rows,
            "row_count": total_rows,
            "truncated": truncated,
            "duration_ms": duration_ms,
            "target": "live_sql",
            "source_id": source_id,
        }

    except Exception as exc:
        duration_ms = round((time.time() - start) * 1000, 1)
        error_msg = str(exc)
        logger.error("live_sql [%s] %s FAILED (%.1fms): %s", source_id, label, duration_ms, error_msg)
        return {
            "label": label,
            "sql": sql,
            "columns": [],
            "rows": [],
            "row_count": 0,
            "truncated": False,
            "error": error_msg,
            "duration_ms": duration_ms,
            "target": "live_sql",
            "source_id": source_id,
        }
