# flows/code_reuse_flow.py

"""
Code Reuse Flow
Handles the path when reusable code is found in the graph

This flow:
1. Retrieves best match from graph
2. Validates it meets requirements
3. Optionally adapts it
4. Sends to debate
5. On approval, executes
"""

from pocketflow import Flow
from typing import Dict, Any

from monitoring.logger import get_logger

logger = get_logger(__name__)


def create_code_reuse_flow(config) -> Flow:
    """
    Create code reuse sub-flow
    
    This handles the complete reuse path from graph retrieval
    to validated execution.
    
    Args:
        config: Configuration object
        
    Returns:
        Flow: Configured reuse flow
    """
    
    logger.info("Creating code reuse flow")
    
    # Initialize shared state
    shared = {
        'config': config,
        
        # Input (set by calling flow)
        'best_match': None,
        'step_context': None,
        
        # Processing
        'reused_code': None,
        'adapted_code': None,
        'needs_adaptation': False,
        
        # Results
        'approved_code': None,
        'reuse_successful': False
    }
    
    # Create flow
    flow = Flow(shared=shared)
    
    # ========================================================================
    # ADD NODES
    # ========================================================================
    
    flow.add('extract_code', ExtractCodeNode())
    flow.add('validate_compatibility', ValidateCompatibilityNode())
    flow.add('adapt_code', AdaptCodeNode())
    
    # Note: Debate and execution would be sub-flows added here
    
    # ========================================================================
    # CONNECT NODES
    # ========================================================================
    
    flow.connect('extract_code', 'validate_compatibility')
    
    # Compatibility branches
    flow.connect('validate_compatibility', 'end', condition='compatible')
    flow.connect('validate_compatibility', 'adapt_code', condition='needs_adaptation')
    flow.connect('validate_compatibility', 'end', condition='incompatible')
    
    # After adaptation
    flow.connect('adapt_code', 'end')
    
    logger.info("Code reuse flow created")
    
    return flow


# ============================================================================
# REUSE NODES
# ============================================================================

class ExtractCodeNode:
    """Extract code from best match"""
    
    def prep(self, shared):
        return {
            'best_match': shared['best_match'],
            'step_context': shared['step_context']
        }
    
    def exec(self, prep_result):
        best_match = prep_result['best_match']
        
        # Extract code
        code = best_match['code']
        metadata = best_match.get('metadata', {})
        
        logger.info(f"Extracted code from node {best_match['node_id']}")
        
        return {
            'code': code,
            'metadata': metadata
        }
    
    def post(self, shared, prep_result, exec_result):
        shared['reused_code'] = exec_result['code']
        
        return 'default'


class ValidateCompatibilityNode:
    """Validate code compatibility with current requirements"""
    
    def prep(self, shared):
        return {
            'code': shared['reused_code'],
            'step_context': shared['step_context']
        }
    
    def exec(self, prep_result):
        code = prep_result['code']
        step_context = prep_result['step_context']
        
        # Simple compatibility check
        # In production, this would be more sophisticated
        
        needs_adaptation = False
        compatible = True
        
        # Check if code has required inputs
        required_inputs = step_context.get('inputs', [])
        for input_param in required_inputs:
            param_name = input_param.split(':')[0].strip()
            if param_name not in code:
                needs_adaptation = True
        
        return {
            'compatible': compatible,
            'needs_adaptation': needs_adaptation
        }
    
    def post(self, shared, prep_result, exec_result):
        shared['needs_adaptation'] = exec_result['needs_adaptation']
        
        if exec_result['compatible'] and not exec_result['needs_adaptation']:
            logger.info("✓ Code is compatible, no adaptation needed")
            return 'compatible'
        
        elif exec_result['needs_adaptation']:
            logger.info("Code needs adaptation")
            return 'needs_adaptation'
        
        else:
            logger.warning("Code is incompatible")
            return 'incompatible'


class AdaptCodeNode:
    """Adapt code to meet current requirements"""
    
    def prep(self, shared):
        return {
            'code': shared['reused_code'],
            'step_context': shared['step_context']
        }
    
    def exec(self, prep_result):
        code = prep_result['code']
        
        # Simple adaptation
        # In production, this would use LLM to adapt code
        
        adapted_code = code  # Placeholder
        
        logger.info("Code adapted")
        
        return adapted_code
    
    def post(self, shared, prep_result, exec_result):
        shared['adapted_code'] = exec_result
        shared['approved_code'] = exec_result
        
        return 'default'


def run_code_reuse(
    best_match: Dict,
    step_context: Dict,
    config
) -> Dict[str, Any]:
    """
    Run code reuse flow
    
    Args:
        best_match: Best match from graph search
        step_context: Step information
        config: Configuration
        
    Returns:
        Dict with reuse results
    """
    
    # Create flow
    flow = create_code_reuse_flow(config)
    
    # Set input
    flow.shared['best_match'] = best_match
    flow.shared['step_context'] = step_context
    
    # Run
    result = flow.run(shared=flow.shared)
    
    return {
        'success': result.get('reuse_successful', False),
        'approved_code': result.get('approved_code'),
        'needed_adaptation': result.get('needs_adaptation', False)
    }
