"""
Tool Registry — central registry for tools the agent can invoke.

Each tool has a name, description, JSON-schema for parameters, a handler
function, and a category (read-only / write / external).

The registry exposes ``list_definitions()`` which returns a list of
``ToolDefinition`` objects ready to feed into ``BaseLLM.generate_with_tools()``.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

from llm.base_llm import ToolDefinition, ToolResult

logger = logging.getLogger(__name__)


@dataclass
class Tool:
    """A registered tool."""

    name: str
    description: str
    input_schema: Dict[str, Any]  # JSON Schema (type=object)
    handler: Callable[[Dict[str, Any], Dict[str, Any]], ToolResult]
    category: str = "read-only"  # "read-only" | "write" | "external"

    def to_definition(self) -> ToolDefinition:
        return ToolDefinition(
            name=self.name,
            description=self.description,
            input_schema=self.input_schema,
        )


class ToolRegistry:
    """Thread-safe tool registry."""

    def __init__(self) -> None:
        self._tools: Dict[str, Tool] = {}

    def register(self, tool: Tool) -> None:
        if tool.name in self._tools:
            logger.warning("Overwriting existing tool: %s", tool.name)
        self._tools[tool.name] = tool
        logger.info("Registered tool: %s [%s]", tool.name, tool.category)

    def get(self, name: str) -> Optional[Tool]:
        return self._tools.get(name)

    def list_definitions(self) -> List[ToolDefinition]:
        return [t.to_definition() for t in self._tools.values()]

    def list_names(self) -> List[str]:
        return list(self._tools.keys())

    def execute(
        self,
        name: str,
        arguments: Dict[str, Any],
        context: Dict[str, Any],
        *,
        tool_use_id: str = "",
    ) -> ToolResult:
        """Execute a tool by name with given arguments and shared context."""
        tool = self._tools.get(name)
        if tool is None:
            return ToolResult(
                tool_use_id=tool_use_id,
                content=f"Unknown tool: {name}",
                is_error=True,
            )
        try:
            result = tool.handler(arguments, context)
            # Ensure result has correct tool_use_id
            if tool_use_id:
                result.tool_use_id = tool_use_id
            return result
        except Exception as exc:
            logger.error("Tool %s failed: %s", name, exc, exc_info=True)
            return ToolResult(
                tool_use_id=tool_use_id,
                content=f"Tool '{name}' error: {exc}",
                is_error=True,
            )


# ── Singleton default registry ──────────────────────────────────────────────

_default_registry: Optional[ToolRegistry] = None


def get_default_registry() -> ToolRegistry:
    """Return (and lazily create) the default global tool registry."""
    global _default_registry
    if _default_registry is None:
        _default_registry = ToolRegistry()
        _register_builtin_tools(_default_registry)
    return _default_registry


def _register_builtin_tools(registry: ToolRegistry) -> None:
    """Register all built-in tools."""
    from tools.sql_tool import sql_query_tool
    from tools.table_tools import list_tables_tool, describe_table_tool
    from tools.web_search_tool import web_search_tool
    from tools.file_reader_tool import file_reader_tool
    from tools.semantic_tool import semantic_search_tool
    from tools.accounting_tools import (
        list_accounting_ctes_tool,
        read_accounting_cte_tool,
        execute_accounting_cte_tool,
        save_accounting_cte_tool,
    )
    from tools.system_tools import (
        write_file_tool,
        edit_file_tool,
        glob_files_tool,
        grep_files_tool,
        shell_exec_tool,
    )
    from tools.render_template_tool import render_report_template_tool

    for tool in [
        sql_query_tool,
        list_tables_tool,
        describe_table_tool,
        semantic_search_tool,
        web_search_tool,
        file_reader_tool,
        list_accounting_ctes_tool,
        read_accounting_cte_tool,
        execute_accounting_cte_tool,
        save_accounting_cte_tool,
        render_report_template_tool,
        write_file_tool,
        edit_file_tool,
        glob_files_tool,
        grep_files_tool,
        shell_exec_tool,
    ]:
        registry.register(tool)
