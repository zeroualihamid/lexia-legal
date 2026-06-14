"""
Domain Workflow Factory
========================

Creates a PocketFlow pipeline identical to the main workflow but
with domain-specific context injected into the shared state.

Each domain subagent reuses all existing nodes — SchemaLoader,
QueryInput, PlanDecomposition, CodeGeneration, SandboxExecution,
ChartGeneration, ConversationUpdate, ResponseFormatter — but
receives additional keys in `shared`:

    shared['domain']               → domain ID (e.g. "banque")
    shared['domain_config']        → dict from registry
    shared['domain_system_prompt'] → persona for PlanDecompositionNode
    shared['domain_code_prompt']   → extra context for CodeGenerationNode
"""

from pathlib import Path
from typing import Dict, Any

from pocketflow import Flow

from nodes.input.schema_loader_node import SchemaLoaderNode
from nodes.input.query_input_node import QueryInputNode
from nodes.input.context_retrieval_node import ContextRetrievalNode
from nodes.processing.query_augmentation_node import QueryAugmentationNode
from nodes.processing.plan_decomposition_node import PlanDecompositionNode
from nodes.generation.code_generation_node import CodeGenerationNode
from nodes.execution.code_writer_node import CodeWriterNode
from nodes.execution.sandbox_execution_node import SandboxExecutionNode
from nodes.output.chart_generation_node import ChartGenerationNode
from nodes.output.conversation_update_node import ConversationUpdateNode
from nodes.output.response_formatter_node import ResponseFormatterNode

from agents.domain.registry import DOMAIN_AGENTS, get_domain_prompts
from conversation.history_manager import ConversationHistoryManager
from skill_registry import load_skill_definitions, build_selected_skills_context
from monitoring.logger import get_logger

logger = get_logger(__name__)


def create_domain_workflow(domain_id: str, config) -> Flow:
    """
    Build a PocketFlow pipeline scoped to a specific domain.

    Same graph topology as create_main_workflow() but with domain
    context injected into the shared store.
    """
    domain_cfg = DOMAIN_AGENTS.get(domain_id)
    if not domain_cfg:
        raise ValueError(f"Unknown domain: {domain_id!r}. Valid: {list(DOMAIN_AGENTS)}")

    logger.info(f"Creating domain workflow: {domain_id} ({domain_cfg['name']})")

    # Ensure the domain's output directory exists
    output_dir = Path(domain_cfg["output_dir"])
    output_dir.mkdir(parents=True, exist_ok=True)

    # Load domain-specific prompts (includes overrides for built-in domains)
    prompts = get_domain_prompts(domain_id) or {"system": "", "code": ""}

    # Load skills so every domain subagent has access to domain expertise
    skills = load_skill_definitions()
    skills_context = build_selected_skills_context(skills, include_full_content=True) if skills else ""
    if skills:
        logger.info(f"Loaded {len(skills)} skill(s) into domain workflow [{domain_id}]")

    conversation_manager = ConversationHistoryManager(config)

    # Pre-load schemas from DataLoaderService when available
    preloaded_schemas = {}
    preloaded_metadata = {}
    if hasattr(config, "_data_loader"):
        preloaded_schemas = config._data_loader.schemas
        preloaded_metadata = config._data_loader.datasources_metadata
        logger.info(
            f"Injecting {len(preloaded_schemas)} pre-loaded schemas for domain {domain_id}"
        )

    # Build shared state — mirrors main_workflow.py + domain extras
    shared: Dict[str, Any] = {
        "config": config,
        "conversation_manager": conversation_manager,
        "reasoning_graph": None,

        # Schema information
        "schemas": preloaded_schemas,
        "datasources_metadata": preloaded_metadata,

        # Input data (set later by API)
        "user_query": None,
        "session_id": None,

        # Processing state
        "conversation_context": None,
        "augmented_query": None,
        "plan_steps": [],
        "current_step_index": 0,

        # Execution state
        "step_results": [],
        "execution_attempts": 0,
        "execution_retries": 0,
        "generation_attempts": 0,
        "generation_feedback": None,

        # Output
        "final_response": None,

        # --- Domain-specific keys ---
        "domain": domain_id,
        "domain_config": domain_cfg,
        "domain_system_prompt": prompts["system"],
        "domain_code_prompt": prompts["code"],
        "skills_context": skills_context,
    }

    # Build nodes
    schema_loader = SchemaLoaderNode()
    query_input = QueryInputNode()
    context_retrieval = ContextRetrievalNode()
    query_augmentation = QueryAugmentationNode()
    plan_decomposition = PlanDecompositionNode()
    code_generation = CodeGenerationNode()
    code_writer = CodeWriterNode()
    sandbox_execution = SandboxExecutionNode()
    chart_generation = ChartGenerationNode()
    conversation_update = ConversationUpdateNode()
    response_formatter = ResponseFormatterNode(output_format="markdown")

    # Wire graph — identical topology to main_workflow
    schema_loader >> query_input >> context_retrieval >> query_augmentation >> plan_decomposition

    plan_decomposition - "default" >> code_generation
    plan_decomposition - "direct_answer" >> conversation_update

    code_generation - "generated" >> code_writer
    code_generation - "default" >> code_generation
    code_generation - "generation_failed" >> conversation_update

    code_writer >> sandbox_execution
    sandbox_execution - "success" >> chart_generation
    sandbox_execution - "retry" >> code_generation
    sandbox_execution - "failed" >> conversation_update

    chart_generation >> conversation_update
    conversation_update >> response_formatter

    flow = Flow(start=schema_loader)
    flow.shared = shared

    logger.info(f"Domain workflow [{domain_id}] created successfully")
    return flow


def run_domain_workflow(
    query: str,
    session_id: str,
    domain_id: str,
    config,
    **kwargs,
) -> Dict[str, Any]:
    """
    Run a domain-scoped workflow end-to-end.

    Drop-in replacement for flows.main_workflow.run_workflow() but
    with domain context.
    """
    logger.info(f"Running domain workflow [{domain_id}] for query: '{query[:50]}...'")

    flow = create_domain_workflow(domain_id, config)

    shared = dict(flow.shared)
    shared["user_query"] = query
    shared["session_id"] = session_id
    shared.update(kwargs)

    try:
        flow.run(shared)
        return {
            "success": True,
            "response": shared.get("final_response"),
            "metrics": shared.get("response_metrics"),
            "step_results": shared.get("step_results", []),
            "chart_data": shared.get("chart_data"),
            "domain": domain_id,
        }
    except Exception as e:
        logger.error(f"Domain workflow [{domain_id}] failed: {e}", exc_info=True)
        return {
            "success": False,
            "error": str(e),
            "step_results": shared.get("step_results", []),
            "domain": domain_id,
        }
