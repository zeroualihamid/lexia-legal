# flows/__init__.py

"""
PocketFlow Workflow Definitions

This package contains all workflow orchestrations using PocketFlow.

Main Workflows:
- main_workflow: Complete end-to-end orchestration
- code_generation_flow: New code generation pipeline
- code_reuse_flow: Code reuse from graph
- debate_flow: Adversarial validation
- execution_flow: Code execution pipeline
"""

from flows.main_workflow import create_main_workflow, run_workflow
from flows.code_generation_flow import create_code_generation_flow, run_code_generation_flow
from flows.code_reuse_flow import create_code_reuse_flow, run_code_reuse
from flows.debate_flow import create_debate_flow, run_debate
from flows.execution_flow import create_execution_flow, run_execution
from flows.dataloader_flow import create_dataloader_flow, run_dataloader_flow
from flows.qvd_pipeline_flow import create_qvd_pipeline_flow, run_qvd_pipeline
from flows.qvd_full_pipeline_flow import create_qvd_full_pipeline_flow, run_qvd_full_pipeline
from flows.xlsx_pipeline_flow import create_xlsx_pipeline_flow, run_xlsx_pipeline
from flows.parquet_query_flow import create_parquet_query_flow, run_parquet_query
from flows.llm_stream_flow import create_llm_stream_flow, run_llm_stream
from flows.sql_thinking_flow import create_sql_thinking_flow, run_sql_thinking
from flows.chart_flow import create_chart_flow, run_chart_flow
from flows.report_bootstrap_flow import (
    create_report_bootstrap_flow,
    run_report_bootstrap,
)
from flows.report_render_flow import (
    create_report_render_flow,
    run_report_render,
)
from flows.report_edit_agent_flow import (
    create_report_edit_agent_flow,
    run_report_edit_agent,
)
from flows.report_cte_save_flow import (
    create_report_cte_save_flow,
    run_contrats_audit_cte_generation,
    run_report_cte_save,
)

__all__ = [
    # Main workflow
    'create_main_workflow',
    'run_workflow',

    # Sub-flows
    'create_code_generation_flow',
    'run_code_generation_flow',
    'create_code_reuse_flow',
    'run_code_reuse',
    'create_debate_flow',
    'run_debate',
    'create_execution_flow',
    'run_execution',

    # Data loader flow
    'create_dataloader_flow',
    'run_dataloader_flow',

    # QVD pipeline flow
    'create_qvd_pipeline_flow',
    'run_qvd_pipeline',

    # QVD full pipeline flow (field description + parquet + categorical distinct)
    'create_qvd_full_pipeline_flow',
    'run_qvd_full_pipeline',

    # XLSX pipeline flow (xlsx → parquet → duckdb)
    'create_xlsx_pipeline_flow',
    'run_xlsx_pipeline',

    # Parquet query flow
    'create_parquet_query_flow',
    'run_parquet_query',

    # LLM stream flow
    'create_llm_stream_flow',
    'run_llm_stream',

    # SQL thinking flow (iterative generate → execute → evaluate)
    'create_sql_thinking_flow',
    'run_sql_thinking',

    # Chart flow (ChartSQL → ChartExecution)
    'create_chart_flow',
    'run_chart_flow',

    # Report bootstrap flow (scan → draft → validate → persist)
    'create_report_bootstrap_flow',
    'run_report_bootstrap',

    # Report render flow (scan → load → sql_batch → conditions →
    # narratives → render)
    'create_report_render_flow',
    'run_report_render',

    # Report-edit agent flow (router → dispatch → verify loop with
    # reporting-only tool registry)
    'create_report_edit_agent_flow',
    'run_report_edit_agent',

    # Prompt-driven single-block CTE save flow + contrats audit SQL generation
    'create_report_cte_save_flow',
    'run_report_cte_save',
    'run_contrats_audit_cte_generation',
]
