# flows/code_generation_flow.py

"""
Code Generation Flow
Handles the complete process of generating new code when graph search finds no suitable matches.

Flow Steps:
1. Analyze Requirements -> Understand what code needs to do
2. Generate Initial Code -> Create first version using LLM
3. Validate Syntax -> Check for Python syntax errors
4. Security Check -> Ensure code is safe to execute
5. Add Documentation -> Add docstrings and comments
6. Optimize -> Apply best practices and optimizations
7. Final Validation -> Last check before proceeding to debate

This is a sub-flow that can be called from the main workflow.
"""

from pocketflow import Flow
from typing import Dict, Any, Optional

from nodes.generation.requirements_analysis_node import RequirementsAnalysisNode
from nodes.generation.code_generation_node import CodeGenerationNode
from nodes.generation.syntax_validation_node import SyntaxValidationNode
from nodes.generation.security_check_node import SecurityCheckNode
from nodes.generation.documentation_node import DocumentationNode
from nodes.generation.optimization_node import OptimizationNode
from nodes.generation.final_validation_node import FinalValidationNode

from monitoring.logger import get_logger

logger = get_logger(__name__)


def create_code_generation_flow(config) -> Flow:
    """
    Create the code generation sub-flow
    
    This flow is triggered when:
    - No suitable code is found in the reasoning graph
    - User explicitly requests new code generation
    - Existing code is too dissimilar to be safely reused
    
    Args:
        config: Configuration object
        
    Returns:
        Flow: Configured PocketFlow workflow
    """
    
    logger.info("Creating code generation flow")
    
    # Initialize shared state for this sub-flow
    shared = {
        'config': config,
        
        # Input (set by calling flow)
        'step_description': None,
        'step_context': None,
        'requirements': None,
        
        # Generated during flow
        'analyzed_requirements': None,
        'generated_code': None,
        'syntax_errors': [],
        'security_issues': [],
        'documented_code': None,
        'optimized_code': None,
        'final_code': None,
        
        # Metadata
        'generation_attempts': 0,
        'max_attempts': 3,
        'validation_passed': False,
        'security_passed': False,
    }
    
    # Create flow
    flow = Flow(shared=shared)
    
    # ===== ADD NODES =====
    
    # Step 1: Analyze requirements
    flow.add('analyze_requirements', RequirementsAnalysisNode())
    
    # Step 2: Generate initial code
    flow.add('generate_code', CodeGenerationNode())
    
    # Step 3: Validate syntax
    flow.add('validate_syntax', SyntaxValidationNode())
    
    # Step 4: Security check
    flow.add('security_check', SecurityCheckNode())
    
    # Step 5: Add documentation
    flow.add('add_documentation', DocumentationNode())
    
    # Step 6: Optimize code
    flow.add('optimize', OptimizationNode())
    
    # Step 7: Final validation
    flow.add('final_validation', FinalValidationNode())
    
    
    # ===== CONNECT NODES =====
    
    # Linear flow with conditional loops
    flow.connect('analyze_requirements', 'generate_code')
    flow.connect('generate_code', 'validate_syntax')
    
    # Syntax validation branching
    flow.connect('validate_syntax', 'security_check', condition='syntax_valid')
    flow.connect('validate_syntax', 'generate_code', condition='syntax_invalid_retry')
    flow.connect('validate_syntax', 'end', condition='syntax_invalid_give_up')
    
    # Security check branching
    flow.connect('security_check', 'add_documentation', condition='security_passed')
    flow.connect('security_check', 'generate_code', condition='security_failed_retry')
    flow.connect('security_check', 'end', condition='security_failed_give_up')
    
    # Documentation and optimization
    flow.connect('add_documentation', 'optimize')
    flow.connect('optimize', 'final_validation')
    
    # Final validation
    flow.connect('final_validation', 'end', condition='validation_passed')
    flow.connect('final_validation', 'generate_code', condition='validation_failed_retry')
    
    logger.info("Code generation flow created successfully")
    return flow


def run_code_generation_flow(
    step_description: str,
    step_context: Dict[str, Any],
    config,
    requirements: Optional[Dict] = None
) -> Dict[str, Any]:
    """
    Convenience function to run the code generation flow
    
    Args:
        step_description: What the code should do
        step_context: Additional context about the step
        config: Configuration object
        requirements: Optional pre-analyzed requirements
        
    Returns:
        dict: {
            'success': bool,
            'code': str,
            'metadata': dict,
            'error': str (if failed)
        }
    """
    
    logger.info(f"Running code generation for: {step_description}")
    
    # Create flow
    flow = create_code_generation_flow(config)
    
    # Set input
    flow.shared['step_description'] = step_description
    flow.shared['step_context'] = step_context
    flow.shared['requirements'] = requirements
    
    # Execute
    try:
        result = flow.run(shared=flow.shared)
        
        if result.get('validation_passed'):
            return {
                'success': True,
                'code': result['final_code'],
                'metadata': {
                    'attempts': result['generation_attempts'],
                    'optimized': True,
                    'documented': True,
                    'security_checked': True
                }
            }
        else:
            return {
                'success': False,
                'error': 'Code generation failed validation',
                'attempts': result['generation_attempts']
            }
            
    except Exception as e:
        logger.error(f"Code generation flow failed: {str(e)}", exc_info=True)
        return {
            'success': False,
            'error': str(e)
        }


# ============================================================================
# ALTERNATIVE FLOW: FAST GENERATION
# ============================================================================

def create_fast_code_generation_flow(config) -> Flow:
    """
    Fast code generation flow with minimal validation
    
    Use when:
    - Speed is more important than safety
    - Code will be heavily reviewed anyway (e.g., in debate)
    - Prototyping or experimentation
    
    Skips:
    - Detailed requirements analysis
    - Optimization step
    - Only basic validation
    """
    
    logger.info("Creating fast code generation flow")
    
    shared = {
        'config': config,
        'step_description': None,
        'generated_code': None,
        'final_code': None,
    }
    
    flow = Flow(shared=shared)
    
    # Minimal nodes
    flow.add('generate', CodeGenerationNode())
    flow.add('validate', SyntaxValidationNode())
    flow.add('security', SecurityCheckNode())
    
    # Simple connections
    flow.connect('generate', 'validate')
    flow.connect('validate', 'security', condition='syntax_valid')
    flow.connect('validate', 'end', condition='syntax_invalid')
    flow.connect('security', 'end')
    
    return flow


# ============================================================================
# ALTERNATIVE FLOW: ITERATIVE REFINEMENT
# ============================================================================

def create_iterative_code_generation_flow(config, max_iterations: int = 3) -> Flow:
    """
    Iterative code generation with progressive refinement
    
    Each iteration:
    1. Generate code
    2. Evaluate quality
    3. If quality < threshold, generate again with feedback
    4. Repeat until quality is acceptable or max iterations reached
    
    Args:
        config: Configuration object
        max_iterations: Maximum refinement iterations
    """
    
    logger.info(f"Creating iterative code generation flow (max {max_iterations} iterations)")
    
    shared = {
        'config': config,
        'max_iterations': max_iterations,
        'current_iteration': 0,
        'quality_threshold': 0.8,
        'best_code': None,
        'best_quality': 0.0,
    }
    
    flow = Flow(shared=shared)
    
    # Import additional nodes
    from nodes.generation.quality_evaluator_node import QualityEvaluatorNode
    from nodes.generation.feedback_generator_node import FeedbackGeneratorNode
    
    # Nodes
    flow.add('generate', CodeGenerationNode())
    flow.add('validate', SyntaxValidationNode())
    flow.add('evaluate_quality', QualityEvaluatorNode())
    flow.add('generate_feedback', FeedbackGeneratorNode())
    
    # Connections
    flow.connect('generate', 'validate')
    flow.connect('validate', 'evaluate_quality', condition='syntax_valid')
    flow.connect('validate', 'generate_feedback', condition='syntax_invalid')
    
    # Quality-based routing
    flow.connect('evaluate_quality', 'end', condition='quality_acceptable')
    flow.connect('evaluate_quality', 'generate_feedback', condition='quality_insufficient')
    
    # Feedback loop
    flow.connect('generate_feedback', 'generate', condition='can_retry')
    flow.connect('generate_feedback', 'end', condition='max_iterations_reached')
    
    return flow


# ============================================================================
# FLOW FACTORY
# ============================================================================

def create_generation_flow(
    config,
    flow_type: str = 'standard',
    **kwargs
) -> Flow:
    """
    Factory function to create different types of code generation flows
    
    Args:
        config: Configuration object
        flow_type: Type of flow ('standard', 'fast', 'iterative')
        **kwargs: Additional arguments for specific flow types
        
    Returns:
        Flow: Configured code generation flow
    """
    
    if flow_type == 'standard':
        return create_code_generation_flow(config)
    
    elif flow_type == 'fast':
        return create_fast_code_generation_flow(config)
    
    elif flow_type == 'iterative':
        max_iterations = kwargs.get('max_iterations', 3)
        return create_iterative_code_generation_flow(config, max_iterations)
    
    else:
        raise ValueError(f"Unknown flow type: {flow_type}")


# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

def validate_generation_input(
    step_description: str,
    step_context: Dict[str, Any]
) -> tuple[bool, Optional[str]]:
    """
    Validate inputs to code generation flow
    
    Returns:
        (is_valid, error_message)
    """
    
    if not step_description or not step_description.strip():
        return False, "step_description cannot be empty"
    
    if not isinstance(step_context, dict):
        return False, "step_context must be a dictionary"
    
    # Check for minimum required context
    required_fields = ['id', 'description']
    missing_fields = [f for f in required_fields if f not in step_context]
    
    if missing_fields:
        return False, f"step_context missing required fields: {missing_fields}"
    
    return True, None


def estimate_generation_time(
    step_description: str,
    flow_type: str = 'standard'
) -> float:
    """
    Estimate how long code generation will take
    
    Returns:
        Estimated time in seconds
    """
    
    # Base time for LLM generation
    base_time = 5.0
    
    # Additional time based on complexity
    complexity_factor = len(step_description.split()) / 10.0
    
    # Flow type multipliers
    flow_multipliers = {
        'standard': 1.5,  # Full validation
        'fast': 0.7,      # Minimal validation
        'iterative': 2.5  # Multiple iterations
    }
    
    multiplier = flow_multipliers.get(flow_type, 1.0)
    
    estimated_time = (base_time + complexity_factor) * multiplier
    
    return round(estimated_time, 1)


# ============================================================================
# MONITORING AND METRICS
# ============================================================================

class CodeGenerationMetrics:
    """Track metrics for code generation flow"""
    
    def __init__(self):
        self.total_generations = 0
        self.successful_generations = 0
        self.failed_generations = 0
        self.total_attempts = 0
        self.syntax_errors = 0
        self.security_failures = 0
        self.average_attempts = 0.0
    
    def record_generation(
        self,
        success: bool,
        attempts: int,
        had_syntax_errors: bool = False,
        had_security_issues: bool = False
    ):
        """Record a generation attempt"""
        self.total_generations += 1
        self.total_attempts += attempts
        
        if success:
            self.successful_generations += 1
        else:
            self.failed_generations += 1
        
        if had_syntax_errors:
            self.syntax_errors += 1
        
        if had_security_issues:
            self.security_failures += 1
        
        self.average_attempts = self.total_attempts / self.total_generations
    
    @property
    def success_rate(self) -> float:
        """Calculate success rate"""
        if self.total_generations == 0:
            return 0.0
        return self.successful_generations / self.total_generations
    
    def to_dict(self) -> Dict[str, Any]:
        """Export metrics as dictionary"""
        return {
            'total_generations': self.total_generations,
            'successful': self.successful_generations,
            'failed': self.failed_generations,
            'success_rate': self.success_rate,
            'average_attempts': round(self.average_attempts, 2),
            'syntax_errors': self.syntax_errors,
            'security_failures': self.security_failures
        }


# Global metrics instance
_metrics = CodeGenerationMetrics()


def get_generation_metrics() -> CodeGenerationMetrics:
    """Get global code generation metrics"""
    return _metrics


# ============================================================================
# EXAMPLE USAGE
# ============================================================================

if __name__ == '__main__':
    """
    Example of how to use the code generation flow
    """
    
    from config.settings import settings
    
    # Example 1: Standard flow
    result = run_code_generation_flow(
        step_description="Load a Parquet file and calculate monthly revenue",
        step_context={
            'id': 'step-1',
            'description': 'Revenue calculation from sales data',
            'inputs': ['file_path: str'],
            'outputs': ['DataFrame with monthly revenue'],
            'constraints': ['Must handle missing data', 'Memory efficient']
        },
        config=settings
    )
    
    if result['success']:
        print("✓ Code generated successfully")
        print(f"Code:\n{result['code']}")
        print(f"Attempts: {result['metadata']['attempts']}")
    else:
        print(f"✗ Generation failed: {result['error']}")
    
    
    # Example 2: Fast flow for prototyping
    fast_flow = create_fast_code_generation_flow(settings)
    fast_flow.shared['step_description'] = "Simple data loader"
    fast_result = fast_flow.run(shared=fast_flow.shared)
    
    
    # Example 3: Iterative refinement
    iterative_result = run_code_generation_flow(
        step_description="Complex data transformation with error handling",
        step_context={
            'id': 'step-2',
            'description': 'Transform and validate data',
            'quality_requirements': ['High readability', 'Comprehensive error handling']
        },
        config=settings
    )
    
    
    # Example 4: Check metrics
    metrics = get_generation_metrics()
    print(f"\nGeneration Metrics:")
    print(f"Success Rate: {metrics.success_rate:.1%}")
    print(f"Average Attempts: {metrics.average_attempts:.1f}")
