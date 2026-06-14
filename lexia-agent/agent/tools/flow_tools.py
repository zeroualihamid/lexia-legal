"""Typed LangChain BaseTool wrappers around PocketFlow flows.

These wrappers are intentionally short: each one declares its arg schema,
calls the existing ``run_*`` entry point, and serializes the flow's return
value back into a string the LLM can consume.

If a flow returns large structured data (e.g. SQL rows, DataFrames), the
wrapper compresses to a markdown preview + a row-count summary so the
agent's context doesn't explode.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Optional, Type

from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

_MAX_TOOL_OUTPUT = 15_000


# ── Generic serializer ─────────────────────────────────────────────────────


def _serialize_result(result: Any) -> str:
    """Compress an arbitrary flow result into an LLM-friendly string."""
    if result is None:
        return "(no result)"
    if isinstance(result, str):
        out = result
    else:
        try:
            out = json.dumps(result, ensure_ascii=False, default=str, indent=2)
        except Exception:
            out = str(result)
    if len(out) > _MAX_TOOL_OUTPUT:
        out = out[:_MAX_TOOL_OUTPUT] + "\n... (truncated)"
    return out


# ── Per-flow tool wrappers ─────────────────────────────────────────────────


class SQLThinkingArgs(BaseModel):
    query: str = Field(..., description="Natural-language analytical question.")
    max_iterations: int = Field(5, description="Max generate→execute→evaluate loops.")


class SQLThinkingTool(BaseTool):
    """Iterative SQL: generate → execute → evaluate until the answer is solid."""

    name: str = "sql_thinking"
    description: str = (
        "Run an iterative SQL thinking loop for analytical questions backed "
        "by the datasource catalog (PostgreSQL / DuckDB). Use this for the "
        "main quantitative answer. Input: a natural-language question."
    )
    args_schema: Type[BaseModel] = SQLThinkingArgs

    def _run(self, query: str, max_iterations: int = 5, **_: Any) -> str:
        from flows.sql_thinking_flow import run_sql_thinking
        return _serialize_result(run_sql_thinking(query=query, max_iterations=max_iterations))


class ParquetQueryArgs(BaseModel):
    query: str = Field(..., description="DuckDB SQL over parquet files in data/parquet.")


class ParquetQueryTool(BaseTool):
    name: str = "parquet_query"
    description: str = (
        "Execute a DuckDB SQL query against the project's parquet cache "
        "(``data/parquet/*.parquet``). Use this for fast slice/aggregate "
        "queries when SQL Thinking isn't needed."
    )
    args_schema: Type[BaseModel] = ParquetQueryArgs

    def _run(self, query: str, **_: Any) -> str:
        from flows.parquet_query_flow import run_parquet_query
        return _serialize_result(run_parquet_query(query))


class CodeGenerationArgs(BaseModel):
    instruction: str = Field(..., description="What the generated Python code should do.")
    context: Optional[str] = Field(None, description="Optional extra context (schema, prior code).")


class CodeGenerationTool(BaseTool):
    name: str = "code_generation"
    description: str = (
        "Generate new Python code (pandas/duckdb) for a specific analytical step. "
        "Returns the generated source. Prefer ``code_reuse`` first to avoid re-generation."
    )
    args_schema: Type[BaseModel] = CodeGenerationArgs

    def _run(self, instruction: str, context: Optional[str] = None, **_: Any) -> str:
        from flows.code_generation_flow import run_code_generation_flow
        return _serialize_result(
            run_code_generation_flow(instruction=instruction, context=context or "")
        )


class CodeReuseArgs(BaseModel):
    query: str = Field(..., description="Description of the desired computation.")
    top_k: int = Field(3, description="Number of similar candidates to retrieve.")


class CodeReuseTool(BaseTool):
    name: str = "code_reuse"
    description: str = (
        "Search the project's knowledge graph for previously-generated code "
        "matching the query, ranked by FAISS similarity over embeddings."
    )
    args_schema: Type[BaseModel] = CodeReuseArgs

    def _run(self, query: str, top_k: int = 3, **_: Any) -> str:
        from flows.code_reuse_flow import run_code_reuse
        return _serialize_result(run_code_reuse(query=query, top_k=top_k))


class ChartArgs(BaseModel):
    query: str = Field(..., description="What chart to render (e.g. 'monthly revenue 2024').")
    chart_type: Optional[str] = Field(None, description="Optional: bar, line, pie …")


class ChartTool(BaseTool):
    """Charts are routed through agent/chart_async so they never block streaming."""

    name: str = "chart"
    description: str = (
        "Render a chart (PNG + JSON) for the user. The chart is generated "
        "asynchronously and the tool returns the chart id; the UI fetches "
        "the rendered artefact separately so token streaming is never blocked."
    )
    args_schema: Type[BaseModel] = ChartArgs

    def _run(self, query: str, chart_type: Optional[str] = None, **_: Any) -> str:
        from agent.chart_async import schedule_chart
        chart_id = schedule_chart(query=query, chart_type=chart_type)
        return _serialize_result({
            "chart_id": chart_id,
            "status": "scheduled",
            "note": "Chart is rendering in the background; the UI will pick it up by id.",
        })


class ReportRenderArgs(BaseModel):
    template_id: str = Field(..., description="Reporting template id.")
    params: Dict[str, Any] = Field(default_factory=dict)


class ReportRenderTool(BaseTool):
    name: str = "report_render"
    description: str = "Render a reporting template (scan → load → SQL batch → conditions → narratives → render)."
    args_schema: Type[BaseModel] = ReportRenderArgs

    def _run(self, template_id: str, params: Optional[Dict[str, Any]] = None, **_: Any) -> str:
        from flows.report_render_flow import run_report_render
        return _serialize_result(run_report_render(template_id=template_id, params=params or {}))


class ReportEditAgentArgs(BaseModel):
    template_id: str = Field(..., description="Reporting template id to edit.")
    instruction: str = Field(..., description="Natural-language editing instruction.")


class ReportEditAgentTool(BaseTool):
    name: str = "report_edit_agent"
    description: str = "Reporting-only editing sub-agent (router → dispatch → verify loop)."
    args_schema: Type[BaseModel] = ReportEditAgentArgs

    def _run(self, template_id: str, instruction: str, **_: Any) -> str:
        from flows.report_edit_agent_flow import run_report_edit_agent
        return _serialize_result(
            run_report_edit_agent(template_id=template_id, instruction=instruction)
        )


class ReportCteSaveArgs(BaseModel):
    prompt: str = Field(..., description="Natural-language brief describing the CTE to draft.")


class ReportCteSaveTool(BaseTool):
    name: str = "report_cte_save"
    description: str = (
        "Draft, validate and persist a new single-block CTE (also appends it "
        "to the NetworkX library graph under data/cte_graphs/)."
    )
    args_schema: Type[BaseModel] = ReportCteSaveArgs

    def _run(self, prompt: str, **_: Any) -> str:
        from flows.report_cte_save_flow import run_report_cte_save
        return _serialize_result(run_report_cte_save(prompt=prompt))


class DebateArgs(BaseModel):
    proposal: str = Field(..., description="Initial proposed answer / SQL / code.")
    context: Optional[str] = Field(None)
    max_rounds: int = Field(4)


class DebateTool(BaseTool):
    name: str = "debate"
    description: str = "Adversarial proposer/challenger/consensus refinement of a proposal."
    args_schema: Type[BaseModel] = DebateArgs

    def _run(self, proposal: str, context: Optional[str] = None, max_rounds: int = 4, **_: Any) -> str:
        from flows.debate_flow import run_debate
        return _serialize_result(
            run_debate(proposal=proposal, context=context or "", max_rounds=max_rounds)
        )


class LlmStreamArgs(BaseModel):
    prompt: str = Field(..., description="Prompt to stream.")
    system: Optional[str] = Field(None)


class LlmStreamTool(BaseTool):
    name: str = "llm_stream"
    description: str = "Raw LLM streaming completion (no tools). Use only when you need a plain text generation."
    args_schema: Type[BaseModel] = LlmStreamArgs

    def _run(self, prompt: str, system: Optional[str] = None, **_: Any) -> str:
        from flows.llm_stream_flow import run_llm_stream
        return _serialize_result(run_llm_stream(prompt=prompt, system=system))


class DataloaderArgs(BaseModel):
    datasource: str = Field(..., description="Datasource id from datasources.yaml.")


class DataloaderTool(BaseTool):
    name: str = "dataloader"
    description: str = "Run the datasource loader pipeline to (re)build a parquet cache."
    args_schema: Type[BaseModel] = DataloaderArgs

    def _run(self, datasource: str, **_: Any) -> str:
        from flows.dataloader_flow import run_dataloader_flow
        return _serialize_result(run_dataloader_flow(datasource=datasource))


class QvdFullPipelineArgs(BaseModel):
    qvd_path: str = Field(..., description="Path to the .qvd file.")


class QvdFullPipelineTool(BaseTool):
    name: str = "qvd_full_pipeline"
    description: str = "Run the full QVD ingest pipeline (field description + parquet + categorical distinct)."
    args_schema: Type[BaseModel] = QvdFullPipelineArgs

    def _run(self, qvd_path: str, **_: Any) -> str:
        from flows.qvd_full_pipeline_flow import run_qvd_full_pipeline
        return _serialize_result(run_qvd_full_pipeline(qvd_path))
