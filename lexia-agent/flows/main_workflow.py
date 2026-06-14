# flows/main_workflow.py

"""
Main Workflow
Complete end-to-end workflow orchestrating all system components

This is the primary workflow that:
1. Loads datasource schemas (columns, types, metadata)
2. Receives user query
3. Retrieves context
4. Augments query with datasource information
5. Decomposes into steps
6. Routes each step (reuse vs generate)
7. Executes and validates
8. Returns formatted response
"""

import sys
from pathlib import Path

# Add project root + data/ to path for direct execution (mirrors main.py)
if __name__ == '__main__':
    project_root = Path(__file__).resolve().parent.parent
    if str(project_root) not in sys.path:
        sys.path.insert(0, str(project_root))
    _data_dir = str(project_root / "data")
    if _data_dir not in sys.path:
        sys.path.insert(0, _data_dir)

from pocketflow import Flow
from typing import Dict, Any

from nodes.input.schema_loader_node import SchemaLoaderNode
from nodes.input.query_input_node import QueryInputNode
from nodes.input.context_retrieval_node import ContextRetrievalNode
from nodes.processing.query_augmentation_node import QueryAugmentationNode
from nodes.processing.plan_decomposition_node import PlanDecompositionNode
# from nodes.processing.step_router_node import StepRouterNode
# from nodes.graph.graph_search_node import GraphSearchNode
from nodes.generation.code_generation_node import CodeGenerationNode
from nodes.execution.code_writer_node import CodeWriterNode
from nodes.execution.sandbox_execution_node import SandboxExecutionNode
from nodes.execution.result_handler_node import ResultHandlerNode
from nodes.output.chart_generation_node import ChartGenerationNode
from nodes.output.conversation_update_node import ConversationUpdateNode
from nodes.output.response_formatter_node import ResponseFormatterNode
from nodes.base_node import BaseNode
from conversation.history_manager import ConversationHistoryManager
# from graph.reasoning_graph import ReasoningGraph

from monitoring.logger import get_logger

logger = get_logger(__name__)


# CodeGenerationNode now inherits from BaseNode directly, no adapter needed


def create_main_workflow(config) -> Flow:
    """
    Create the main workflow
    
    This orchestrates the complete system from query input to response.
    
    Args:
        config: Configuration object
        
    Returns:
        Flow: Configured PocketFlow workflow
    """
    
    logger.info("Creating main workflow")
    
    # Initialize conversation manager
    conversation_manager = ConversationHistoryManager(config)
    
    # Initialize reasoning graph once (loads SentenceTransformer model)
    # so all nodes reuse the same instance instead of reloading per-node
    reasoning_graph = None
    
    # Pre-load schemas from DataLoaderService if available
    preloaded_schemas = {}
    preloaded_metadata = {}
    if hasattr(config, '_data_loader'):
        preloaded_schemas = config._data_loader.schemas
        preloaded_metadata = config._data_loader.datasources_metadata
        logger.info(
            f"Injecting {len(preloaded_schemas)} pre-loaded schemas from DataLoaderService"
        )

    # Initialize shared state
    shared = {
        'config': config,
        'conversation_manager': conversation_manager,
        'reasoning_graph': reasoning_graph,

        # Schema information (pre-loaded or populated by SchemaLoaderNode)
        'schemas': preloaded_schemas,
        'datasources_metadata': preloaded_metadata,
        
        # Input data (set by API/CLI)
        'user_query': None,
        'session_id': None,
        
        # Processing state
        'conversation_context': None,
        'augmented_query': None,
        'plan_steps': [],
        'current_step_index': 0,
        
        # Execution state
        'step_results': [],
        'execution_attempts': 0,
        'execution_retries': 0,
        'generation_attempts': 0,
        'generation_feedback': None,
        
        # Output
        'final_response': None
    }
    
    # Build nodes (PocketFlow graph syntax)
    schema_loader = SchemaLoaderNode()  # FIRST NODE - loads datasource schemas
    query_input = QueryInputNode()
    context_retrieval = ContextRetrievalNode()
    query_augmentation = QueryAugmentationNode()
    plan_decomposition = PlanDecompositionNode()
    # step_router = StepRouterNode()
    # graph_search = GraphSearchNode()
    code_generation = CodeGenerationNode()
    code_writer = CodeWriterNode()
    sandbox_execution = SandboxExecutionNode()
    # result_handler = ResultHandlerNode()
    chart_generation = ChartGenerationNode()
    conversation_update = ConversationUpdateNode()
    response_formatter = ResponseFormatterNode(output_format='markdown')
    
    # Linear input processing chain (starts with schema loading)
    schema_loader >> query_input >> context_retrieval >> query_augmentation >> plan_decomposition

    # Plan decomposition routes:
    #   'default'        → has data steps → code_generation pipeline
    #   'direct_answer'  → reasoning/text answer → skip code, go to response
    plan_decomposition - 'default' >> code_generation
    plan_decomposition - 'direct_answer' >> conversation_update

    # After generation: execute the code or handle failure
    code_generation - 'generated' >> code_writer
    code_generation - 'default' >> code_generation  # retry (attempt < MAX)
    code_generation - 'generation_failed' >> conversation_update

    # Execution pipeline with retry loop on sandbox failure
    code_writer >> sandbox_execution
    sandbox_execution - 'success' >> chart_generation
    sandbox_execution - 'retry' >> code_generation
    sandbox_execution - 'failed' >> conversation_update

    # Chart generation (best-effort) then continue to conversation update
    chart_generation >> conversation_update

    # Final output (end naturally after response_formatter)
    conversation_update >> response_formatter
    
    # Create PocketFlow from start node (schema_loader runs first)
    flow = Flow(start=schema_loader)
    # Attach shared state for compatibility
    flow.shared = shared
    
    logger.info("Main workflow created successfully")
    
    return flow


def run_workflow(
    query: str,
    session_id: str,
    config,
    **kwargs
) -> Dict[str, Any]:
    """
    Run the complete workflow
    
    Args:
        query: User query
        session_id: Session identifier
        config: Configuration object
        **kwargs: Additional parameters
        
    Returns:
        Dict with workflow results
    """
    
    logger.info(f"Running workflow for query: '{query[:50]}...'")
    
    # Create workflow
    flow = create_main_workflow(config)
    
    # Set input in shared state
    shared = dict(flow.shared)
    shared['user_query'] = query
    shared['session_id'] = session_id
    shared.update(kwargs)
    
    # Execute
    try:
        flow.run(shared)
        
        return {
            'success': True,
            'response': shared.get('final_response'),
            'metrics': shared.get('response_metrics'),
            'step_results': shared.get('step_results', []),
            'chart_data': shared.get('chart_data'),
        }
    
    except Exception as e:
        logger.error(f"Workflow failed: {e}", exc_info=True)
        
        return {
            'success': False,
            'error': str(e),
            'step_results': shared.get('step_results', [])
        }


# ============================================================================
# EXAMPLE USAGE
# ============================================================================

if __name__ == '__main__':
    """
    Example of running the main workflow with revenue analysis query
    """
    
    from config import get_settings
    import json
    
    cfg = get_settings()
    
    print("=" * 80)
    print("TESTING MAIN WORKFLOW WITH REVENUE QUERY")
    print("=" * 80)
    print(f"LLM provider: {cfg.llm.provider}  model: {cfg.llm.model}")
    
    # Test query
    query = "donne un diagnostic des produits en terme d'evolution haussière et baissieère et les raisons tres bien expliquées"
    session_id = "test-zerouali-session-001"
    
    print(f"\nQuery: {query}")
    print(f"Session ID: {session_id}")
    print("\nStarting workflow...\n")
    
    # Run workflow
    result = run_workflow(
        query=query,
        session_id=session_id,
        config=cfg
    )
    
    print("\n" + "=" * 80)
    print("WORKFLOW RESULTS")
    print("=" * 80)
    
    if result['success']:
        print("✓ Workflow completed successfully!")
        
        if result.get('response'):
            print(f"\nResponse:\n{result['response']}")
        
        if result.get('metrics'):
            print(f"\nMetrics:")
            for key, value in result['metrics'].items():
                print(f"  - {key}: {value}")
        
        if result.get('step_results'):
            print(f"\nStep Results ({len(result['step_results'])} steps):")
            for i, step in enumerate(result['step_results'], 1):
                desc = step.get('description') or step.get('step_id', 'N/A')
                success = step.get('final_success', False)
                status = "✓" if success else "✗"
                print(f"  {i}. {status} {desc}")
                stdout = step.get('stdout', '').strip()
                if stdout:
                    for line in stdout.split('\n'):
                        print(f"     {line}")
    else:
        print(f"✗ Workflow failed: {result['error']}")

        if result.get('step_results'):
            print(f"\nCompleted steps before failure:")
            for i, step in enumerate(result['step_results'], 1):
                desc = step.get('description') or step.get('step_id', 'N/A')
                print(f"  {i}. {desc}")
    
    print("\n" + "=" * 80)
