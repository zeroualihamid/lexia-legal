"""LangChain adapters over the project's legacy ``services.tool_registry`` tools.

The legacy data + accounting-CTE tools already encapsulate DuckDB execution,
recursive CTE dependency expansion (firing the CTE chains catalogued under
``data/reporting/sql/accounting`` and the persisted graphs under
``data/cte_graphs``) and parquet resolution:

* ``list_accounting_ctes`` / ``read_accounting_cte`` — discover + ground CTEs
* ``execute_accounting_cte`` — **fire** a library CTE (or ad-hoc ``WITH … SELECT``)
* ``save_accounting_cte`` — draft + persist a new CTE then execute it
* ``render_report_template`` — render a full reporting template (cascade of CTEs)
* ``list_tables`` / ``describe_table`` / ``semantic_search`` / ``sql_query`` — generic data access

This module wraps each one in a LangChain :class:`StructuredTool` so the
``create_tool_calling_agent`` AgentExecutor in :mod:`agent.langchain_agent`
can call them directly — giving the LangChain agent the same CTE-firing
capability as the legacy PocketFlow agent, and making the agent's system
prompt (which instructs it to start with ``list_accounting_ctes`` then
``execute_accounting_cte``) actionable.

Each built tool shares a per-request ``context`` dict so structured side
outputs (``sql_queries``, ``sql_results``, ``rendered_reports``) accumulate
and can be harvested by the caller (for chart generation + the /chat payload).
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional, Type

from langchain_core.tools import BaseTool, StructuredTool
from pydantic import BaseModel, Field, create_model

logger = logging.getLogger(__name__)

_MAX_TOOL_OUTPUT = 15_000

# JSON-schema "type" → Python type for dynamic pydantic arg-model generation.
_JSON_TYPE_MAP: Dict[str, Any] = {
    "string": str,
    "integer": int,
    "number": float,
    "boolean": bool,
    "object": dict,
    "array": list,
}

# Names exposed by this module. The accounting-CTE tools come first so they
# are advertised to the LLM ahead of the generic data tools (matches the
# system prompt's "library first" orientation).
DATA_TOOL_NAMES: List[str] = [
    "list_accounting_ctes",
    "read_accounting_cte",
    "execute_accounting_cte",
    "save_accounting_cte",
    "render_report_template",
    "list_tables",
    "describe_table",
    "semantic_search",
    "sql_query",
]


def _legacy_tool_map() -> Dict[str, Any]:
    """Lazily import the legacy ``services.tool_registry.Tool`` instances.

    Imports are wrapped individually so a single missing optional dependency
    (e.g. DuckDB) only drops that one tool instead of disabling the whole agent.
    """
    out: Dict[str, Any] = {}

    try:
        from tools.accounting_tools import (
            execute_accounting_cte_tool,
            list_accounting_ctes_tool,
            read_accounting_cte_tool,
            save_accounting_cte_tool,
        )

        out.update({
            "list_accounting_ctes": list_accounting_ctes_tool,
            "read_accounting_cte": read_accounting_cte_tool,
            "execute_accounting_cte": execute_accounting_cte_tool,
            "save_accounting_cte": save_accounting_cte_tool,
        })
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("Accounting CTE tools unavailable: %s", exc)

    try:
        from tools.table_tools import describe_table_tool, list_tables_tool

        out["list_tables"] = list_tables_tool
        out["describe_table"] = describe_table_tool
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("Table tools unavailable: %s", exc)

    try:
        from tools.semantic_tool import semantic_search_tool

        out["semantic_search"] = semantic_search_tool
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("Semantic search tool unavailable: %s", exc)

    try:
        from tools.sql_tool import sql_query_tool

        out["sql_query"] = sql_query_tool
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("SQL query tool unavailable: %s", exc)

    try:
        from tools.render_template_tool import render_report_template_tool

        out["render_report_template"] = render_report_template_tool
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("Render-template tool unavailable: %s", exc)

    return out


def _args_schema_from_json(model_name: str, schema: Dict[str, Any]) -> Type[BaseModel]:
    """Build a pydantic model from a tool's JSON-schema ``input_schema``."""
    props = (schema or {}).get("properties") or {}
    required = set((schema or {}).get("required") or [])

    fields: Dict[str, Any] = {}
    for pname, pdef in props.items():
        pdef = pdef or {}
        py_type = _JSON_TYPE_MAP.get(pdef.get("type"), str)
        desc = pdef.get("description", "") or ""
        if pname in required:
            fields[pname] = (py_type, Field(..., description=desc))
        else:
            default = pdef.get("default", None)
            fields[pname] = (Optional[py_type], Field(default, description=desc))

    if not fields:
        # Tools with no parameters (e.g. list_tables) still need a model.
        return create_model(model_name)
    return create_model(model_name, **fields)


def _build_structured_tool(legacy: Any, context: Dict[str, Any]) -> BaseTool:
    """Wrap one legacy ``Tool`` into a context-bound LangChain ``StructuredTool``."""
    args_schema = _args_schema_from_json(f"{legacy.name}_args", legacy.input_schema)

    def _run(**kwargs: Any) -> str:
        # Drop unset optionals so legacy ``args.get(...)`` defaults apply.
        cleaned = {k: v for k, v in kwargs.items() if v is not None}
        result = legacy.handler(cleaned, context)
        content = getattr(result, "content", "") or ""
        if getattr(result, "is_error", False):
            content = f"[error] {content}"
        if len(content) > _MAX_TOOL_OUTPUT:
            content = content[:_MAX_TOOL_OUTPUT] + "\n... (truncated)"
        return content

    return StructuredTool.from_function(
        func=_run,
        name=legacy.name,
        description=legacy.description,
        args_schema=args_schema,
        infer_schema=False,
    )


def build_data_tools(
    context: Dict[str, Any],
    enabled: Optional[List[str]] = None,
) -> List[BaseTool]:
    """Build the CTE + data LangChain tools bound to a shared ``context`` dict.

    Args:
        context: per-request dict the tools accumulate side outputs into
            (``sql_queries`` / ``sql_results`` / ``rendered_reports``).
        enabled: subset of :data:`DATA_TOOL_NAMES` to build (defaults to all).
    """
    legacy_map = _legacy_tool_map()
    names = enabled if enabled is not None else DATA_TOOL_NAMES

    tools: List[BaseTool] = []
    for name in names:
        legacy = legacy_map.get(name)
        if legacy is None:
            logger.warning("Data tool %r not available (skipped)", name)
            continue
        try:
            tools.append(_build_structured_tool(legacy, context))
        except Exception as exc:
            logger.warning("Could not build data tool %r: %s", name, exc)
    return tools
