"""Tool whitelist → list of instantiated LangChain BaseTools.

Reads ``tools.enabled`` from ``config/langchain_config.yaml`` and returns
the matching instances. Two families of tools are supported:

* **flow tools** (:data:`AVAILABLE_TOOLS`) — thin wrappers over PocketFlow
  flows (sql_thinking, chart, report_render, …) defined in ``flow_tools``.
* **data / CTE tools** (:data:`~agent.tools.data_tools.DATA_TOOL_NAMES`) —
  adapters over the legacy ``services.tool_registry`` tools that actually
  **fire the accounting CTEs** (``execute_accounting_cte`` & friends). These
  need a per-request ``tool_context`` dict so their structured outputs
  (``sql_queries`` / ``sql_results`` / ``rendered_reports``) can be harvested.

Names in neither family are ignored with a warning so a misconfigured YAML
doesn't crash the agent.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional, Type

from langchain_core.tools import BaseTool

from agent.config import get_section
from agent.tools import flow_tools
from agent.tools.data_tools import DATA_TOOL_NAMES, build_data_tools

logger = logging.getLogger(__name__)


AVAILABLE_TOOLS: Dict[str, Type[BaseTool]] = {
    "sql_thinking":      flow_tools.SQLThinkingTool,
    "parquet_query":     flow_tools.ParquetQueryTool,
    "code_generation":   flow_tools.CodeGenerationTool,
    "code_reuse":        flow_tools.CodeReuseTool,
    "chart":             flow_tools.ChartTool,
    "report_render":     flow_tools.ReportRenderTool,
    "report_edit_agent": flow_tools.ReportEditAgentTool,
    "report_cte_save":   flow_tools.ReportCteSaveTool,
    "debate":            flow_tools.DebateTool,
    "llm_stream":        flow_tools.LlmStreamTool,
    "dataloader":        flow_tools.DataloaderTool,
    "qvd_full_pipeline": flow_tools.QvdFullPipelineTool,
}

_DATA_TOOL_SET = set(DATA_TOOL_NAMES)


def build_tool_list(
    enabled: Optional[List[str]] = None,
    *,
    tool_context: Optional[Dict[str, Any]] = None,
) -> List[BaseTool]:
    """Instantiate the whitelisted tools (data/CTE tools first, then flow tools).

    Args:
        enabled: tool names from config; defaults to ``tools.enabled`` in
            ``langchain_config.yaml`` (or every known tool when unset).
        tool_context: shared dict the data/CTE tools accumulate structured
            outputs into. A fresh dict is created when omitted.
    """
    if enabled is None:
        enabled = (get_section("tools") or {}).get("enabled") or (
            DATA_TOOL_NAMES + list(AVAILABLE_TOOLS.keys())
        )
    if tool_context is None:
        tool_context = {}

    data_names: List[str] = []
    flow_tools_out: List[BaseTool] = []
    for name in enabled:
        if name in _DATA_TOOL_SET:
            data_names.append(name)
        elif name in AVAILABLE_TOOLS:
            try:
                flow_tools_out.append(AVAILABLE_TOOLS[name]())
            except Exception as exc:
                logger.warning("Could not instantiate tool %r: %s", name, exc)
        else:
            logger.warning("Unknown tool in config.tools.enabled: %r (ignored)", name)

    tools: List[BaseTool] = build_data_tools(tool_context, enabled=data_names)
    tools.extend(flow_tools_out)

    logger.info("LangChain agent tools loaded: %s", [t.name for t in tools])
    return tools
