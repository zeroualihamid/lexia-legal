# flows/execution_flow.py

"""
Execution Flow
Complete code execution pipeline: write → execute → process results

This sub-flow:
1. Writes code to filesystem
2. Executes in sandbox
3. Processes results
4. Updates reasoning graph
5. Handles retries if needed
"""

from pocketflow import Flow
from typing import Dict, Any

from nodes.execution.code_writer_node import CodeWriterNode
from nodes.execution.sandbox_execution_node import SandboxExecutionNode
from nodes.execution.result_handler_node import ResultHandlerNode
from monitoring.logger import get_logger

logger = get_logger(__name__)


def create_execution_flow(config) -> Flow:
    """
    Create code execution sub-flow
    
    This handles the complete execution pipeline from
    writing code to processing results.
    
    Args:
        config: Configuration object
        
    Returns:
        Flow: Configured execution flow
    """
    
    logger.info("Creating execution flow")
    
    # Initialize shared state
    shared = {
        'config': config,
        
        # Input (set by calling flow)
        'approved_code': None,
        'step_context': None,
        
        # Execution state
        'code_path': None,
        'execution_result': None,
        'execution_attempts': 0,
        'max_execution_attempts': 3,
        
        # Results
        'execution_success': False,
        'processed_result': None
    }
    
    # Create flow
    flow = Flow(shared=shared)
    
    # ========================================================================
    # ADD NODES
    # ========================================================================
    
    flow.add('write_code', CodeWriterNode())
    flow.add('execute', SandboxExecutionNode())
    flow.add('process_result', ResultHandlerNode())
    
    # ========================================================================
    # CONNECT NODES
    # ========================================================================
    
    # Linear execution pipeline
    flow.connect('write_code', 'execute')
    flow.connect('execute', 'process_result')
    
    # Result handling branches
    flow.connect('process_result', 'end', condition='success')
    flow.connect('process_result', 'execute', condition='retry')  # Retry execution
    flow.connect('process_result', 'end', condition='failed')  # Give up
    
    logger.info("Execution flow created")
    
    return flow


def run_execution(
    approved_code: str,
    step_context: Dict,
    config
) -> Dict[str, Any]:
    """
    Run code execution flow
    
    Args:
        approved_code: Code to execute
        step_context: Step information
        config: Configuration
        
    Returns:
        Dict with execution results
    """
    
    logger.info("Running execution flow")
    
    # Create flow
    flow = create_execution_flow(config)
    
    # Set input
    flow.shared['approved_code'] = approved_code
    flow.shared['step_context'] = step_context
    
    # Execute
    try:
        result = flow.run(shared=flow.shared)
        
        return {
            'success': result['execution_success'],
            'code_path': result.get('code_path'),
            'execution_result': result.get('execution_result'),
            'processed_result': result.get('processed_result'),
            'attempts': result.get('execution_attempts', 1)
        }
    
    except Exception as e:
        logger.error(f"Execution flow failed: {e}")
        
        return {
            'success': False,
            'error': str(e),
            'attempts': flow.shared.get('execution_attempts', 0)
        }
