# nodes/processing/step_router_node.py

"""
Step Router Node
Routes workflow execution based on step characteristics and available options

This node decides the execution path for each step in the workflow:
- Should we search the graph for reusable code?
- Should we generate new code?
- Are there more steps to process?
- Should we skip this step based on conditions?

Acts as a decision point in the workflow, directing flow to the appropriate path.
"""

from typing import Dict, Any, Optional, List
from dataclasses import dataclass
from enum import Enum

from nodes.base_node import BaseNode
from monitoring.logger import get_logger

logger = get_logger(__name__)


# ============================================================================
# ENUMS AND DATA STRUCTURES
# ============================================================================

class RouteDecision(Enum):
    """Possible routing decisions"""
    SEARCH_GRAPH = "search_graph"           # Try to find reusable code
    GENERATE_NEW = "generate_new"           # Generate new code
    SKIP_STEP = "skip_step"                 # Skip this step
    COMPLETE = "complete"                   # All steps done
    ERROR = "error"                         # Error state


class StepType(Enum):
    """Types of steps that can be executed"""
    DATA_LOADING = "data_loading"           # Load files, fetch data
    DATA_PROCESSING = "data_processing"     # Transform, filter, clean
    COMPUTATION = "computation"             # Calculate, aggregate
    VALIDATION = "validation"               # Validate data/results
    OUTPUT = "output"                       # Save, export, display
    UNKNOWN = "unknown"                     # Cannot determine type


@dataclass
class RoutingDecision:
    """Decision about how to route the current step"""
    route: RouteDecision
    next_node: str
    step_info: Dict[str, Any]
    reasoning: str
    metadata: Dict[str, Any]
    
    def to_dict(self) -> Dict:
        return {
            'route': self.route.value,
            'next_node': self.next_node,
            'step_info': self.step_info,
            'reasoning': self.reasoning,
            'metadata': self.metadata
        }


# ============================================================================
# MAIN NODE
# ============================================================================

class StepRouterNode(BaseNode):
    """
    Step Router Node - Intelligent workflow routing
    
    Responsibilities:
    1. Check if there are more steps to process
    2. Analyze current step characteristics
    3. Decide optimal execution path:
       - Search graph for reusable code
       - Generate new code
       - Skip step if conditions met
    4. Route to appropriate next node
    
    Routing Logic:
    - If no more steps → route to completion
    - If step looks reusable → route to graph search
    - If step is novel → route to code generation
    - If step should be skipped → route to next step
    
    This is a critical decision point in the workflow.
    """
    
    def __init__(
        self,
        name: Optional[str] = None,
        prefer_reuse: bool = True,
        min_similarity_for_search: float = 0.6
    ):
        super().__init__(name or "StepRouter")
        self.prefer_reuse = prefer_reuse
        self.min_similarity_for_search = min_similarity_for_search
        self.step_classifier = StepClassifier()
        self.routing_strategy = RoutingStrategy(prefer_reuse)
    
    def prep(self, shared: Dict[str, Any]) -> Dict[str, Any]:
        """Prepare routing data"""
        self.log_entry(shared)
        
        # Get plan steps
        plan_steps = shared.get('plan_steps', [])
        
        if not plan_steps:
            self.logger.warning("No plan steps found")
            return {
                'has_steps': False,
                'current_index': 0,
                'total_steps': 0
            }
        
        # Get current step index
        current_index = shared.get('current_step_index', 0)
        
        # Check if we're done
        if current_index >= len(plan_steps):
            self.logger.info(f"All {len(plan_steps)} steps completed")
            return {
                'has_steps': False,
                'current_index': current_index,
                'total_steps': len(plan_steps),
                'all_completed': True
            }
        
        # Get current step
        current_step = plan_steps[current_index]
        
        # Get previous results for context
        step_results = shared.get('step_results', [])
        
        # Get configuration
        config = self.get_config(shared)
        
        self.logger.info(
            f"Routing step {current_index + 1}/{len(plan_steps)}: "
            f"{current_step.get('description', 'No description')[:50]}..."
        )
        
        return {
            'has_steps': True,
            'current_index': current_index,
            'total_steps': len(plan_steps),
            'current_step': current_step,
            'previous_results': step_results,
            'config': config,
            'all_completed': False
        }
    
    def exec(self, prep_result: Dict[str, Any]) -> RoutingDecision:
        """
        Decide routing for current step
        
        Decision tree:
        1. No more steps? → Complete
        2. Step should be skipped? → Skip
        3. Likely to find in graph? → Search
        4. Novel step? → Generate
        """
        
        # Check if workflow is complete
        if not prep_result['has_steps'] or prep_result.get('all_completed'):
            self.logger.info("Workflow complete - routing to finish")
            return RoutingDecision(
                route=RouteDecision.COMPLETE,
                next_node='no_more_steps',
                step_info={},
                reasoning="All steps have been processed",
                metadata={'completed': True}
            )
        
        current_step = prep_result['current_step']
        current_index = prep_result['current_index']
        config = prep_result['config']
        
        # Classify step type
        step_type = self.step_classifier.classify(current_step)
        self.logger.debug(f"Step classified as: {step_type.value}")
        
        # Check if step should be skipped
        should_skip = self._should_skip_step(current_step, prep_result['previous_results'])
        
        if should_skip:
            self.logger.info(f"Skipping step {current_index}: already completed or not needed")
            return RoutingDecision(
                route=RouteDecision.SKIP_STEP,
                next_node='skip_to_next',
                step_info=current_step,
                reasoning="Step conditions indicate it should be skipped",
                metadata={'skipped': True, 'step_type': step_type.value}
            )
        
        # Determine if we should try to reuse code
        should_search = self._should_search_graph(
            current_step,
            step_type,
            config
        )
        
        if should_search:
            self.logger.info(f"Routing to graph search for step {current_index}")
            return RoutingDecision(
                route=RouteDecision.SEARCH_GRAPH,
                next_node='has_steps_and_try_reuse',
                step_info=current_step,
                reasoning=f"Step type '{step_type.value}' is likely to have reusable code",
                metadata={
                    'step_type': step_type.value,
                    'prefer_reuse': self.prefer_reuse,
                    'step_index': current_index
                }
            )
        
        else:
            self.logger.info(f"Routing to code generation for step {current_index}")
            return RoutingDecision(
                route=RouteDecision.GENERATE_NEW,
                next_node='has_steps_and_need_generate',
                step_info=current_step,
                reasoning=f"Step type '{step_type.value}' requires new code generation",
                metadata={
                    'step_type': step_type.value,
                    'step_index': current_index
                }
            )
    
    def post(
        self,
        shared: Dict[str, Any],
        prep_result: Dict[str, Any],
        exec_result: RoutingDecision
    ) -> str:
        """Store routing decision and return next node"""
        # When routing to code generation, set step_requirements from current plan step
        # so CodeGenerationNode generates code for the step from PlanDecompositionNode
        if exec_result.next_node == 'has_steps_and_need_generate' and exec_result.step_info:
            from nodes.utils.step_requirements import plan_step_to_requirements
            current_index = prep_result.get('current_index', 0)
            shared['step_requirements'] = plan_step_to_requirements(
                exec_result.step_info, current_index
            )
            self.logger.debug(
                f"Set step_requirements from plan step {current_index + 1}: "
                f"{exec_result.step_info.get('title', '')[:50]}"
            )

        # Store routing decision
        shared['routing_decision'] = exec_result.to_dict()
        shared['current_route'] = exec_result.route.value

        # Update workflow metadata
        if 'workflow_metadata' not in shared:
            shared['workflow_metadata'] = {}

        shared['workflow_metadata']['last_routing_decision'] = {
            'route': exec_result.route.value,
            'step_index': prep_result.get('current_index', -1),
            'reasoning': exec_result.reasoning
        }

        # Log decision
        self.logger.info(
            f"Routing decision: {exec_result.route.value} → {exec_result.next_node}"
        )
        self.logger.debug(f"Reasoning: {exec_result.reasoning}")

        self.log_exit(exec_result.next_node)

        # Return the next node to execute
        return exec_result.next_node
    
    # ========================================================================
    # DECISION LOGIC
    # ========================================================================
    
    def _should_skip_step(
        self,
        step: Dict[str, Any],
        previous_results: List[Dict[str, Any]]
    ) -> bool:
        """
        Determine if step should be skipped
        
        Skip if:
        - Step is marked as optional and conditions aren't met
        - Step is already completed (based on previous results)
        - Step has skip_if condition that evaluates to True
        """
        
        # Check if step is marked as skippable
        if step.get('skip_if_exists'):
            # Check if output already exists
            for result in previous_results:
                if result.get('step_id') == step.get('id'):
                    self.logger.debug(f"Step {step.get('id')} already completed")
                    return True
        
        # Check conditional skip
        skip_condition = step.get('skip_condition')
        if skip_condition:
            # Evaluate condition (simplified - in production would be more robust)
            if skip_condition.get('type') == 'always':
                return True
            elif skip_condition.get('type') == 'if_previous_failed':
                # Skip if previous step failed
                if previous_results and not previous_results[-1].get('success'):
                    return True
        
        return False
    
    def _should_search_graph(
        self,
        step: Dict[str, Any],
        step_type: StepType,
        config: Any
    ) -> bool:
        """
        Determine if we should search the graph for reusable code
        
        Search if:
        - Reuse is enabled in config
        - Step type is commonly reusable
        - Step doesn't explicitly request new generation
        - Not in force_generate mode
        """
        
        # Check if reuse is disabled
        if not config.enable_code_reuse:
            return False
        
        # Check if step explicitly requests new code
        if step.get('force_generate'):
            self.logger.debug("Step requests forced generation")
            return False
        
        # Check if step type is reusable
        reusable_types = {
            StepType.DATA_LOADING,      # Loading patterns are very reusable
            StepType.DATA_PROCESSING,   # Common transformations
            StepType.VALIDATION,        # Validation logic is often reusable
        }
        
        if step_type in reusable_types:
            self.logger.debug(f"Step type {step_type.value} is reusable")
            return True
        
        # For computation steps, check complexity
        if step_type == StepType.COMPUTATION:
            # Simple computations are likely reusable
            complexity = step.get('complexity', 'moderate')
            if complexity in ['simple', 'low']:
                return True
        
        # Check strategy preference
        if self.prefer_reuse:
            # When preferring reuse, try to search for most step types
            if step_type != StepType.UNKNOWN:
                return True
        
        return False


# ============================================================================
# STEP CLASSIFIER
# ============================================================================

class StepClassifier:
    """
    Classify steps into types based on their description and metadata
    
    This helps routing decisions by understanding what kind of step it is.
    """
    
    # Keywords for each step type
    TYPE_KEYWORDS = {
        StepType.DATA_LOADING: [
            'load', 'read', 'import', 'fetch', 'get', 'download',
            'open', 'retrieve', 'pull', 'parquet', 'csv', 'excel',
            'file', 'database', 'api'
        ],
        StepType.DATA_PROCESSING: [
            'filter', 'transform', 'clean', 'process', 'convert',
            'merge', 'join', 'aggregate', 'group', 'sort',
            'reshape', 'pivot', 'normalize', 'standardize'
        ],
        StepType.COMPUTATION: [
            'calculate', 'compute', 'count', 'sum', 'average',
            'mean', 'median', 'std', 'min', 'max', 'total',
            'analyze', 'measure', 'determine'
        ],
        StepType.VALIDATION: [
            'validate', 'check', 'verify', 'ensure', 'confirm',
            'test', 'assert', 'inspect', 'audit'
        ],
        StepType.OUTPUT: [
            'save', 'export', 'write', 'output', 'generate',
            'create', 'produce', 'plot', 'visualize', 'chart',
            'report', 'display', 'show'
        ]
    }
    
    def classify(self, step: Dict[str, Any]) -> StepType:
        """
        Classify a step based on its description and metadata
        
        Args:
            step: Step dictionary with 'description' and optional metadata
            
        Returns:
            StepType: Classified type
        """
        
        # Check if type is explicitly provided
        if 'type' in step:
            try:
                return StepType(step['type'])
            except ValueError:
                pass
        
        # Get description
        description = step.get('description', '').lower()
        
        if not description:
            return StepType.UNKNOWN
        
        # Score each type based on keyword matches
        scores = {step_type: 0 for step_type in StepType}
        
        for step_type, keywords in self.TYPE_KEYWORDS.items():
            for keyword in keywords:
                if keyword in description:
                    scores[step_type] += 1
        
        # Return type with highest score
        max_score = max(scores.values())
        
        if max_score == 0:
            return StepType.UNKNOWN
        
        # Get type with max score
        for step_type, score in scores.items():
            if score == max_score:
                return step_type
        
        return StepType.UNKNOWN


# ============================================================================
# ROUTING STRATEGY
# ============================================================================

class RoutingStrategy:
    """
    Encapsulates routing strategy logic
    
    Different strategies for different scenarios:
    - Prefer Reuse: Try to reuse code whenever possible
    - Balanced: Mix of reuse and generation
    - Prefer Generation: Generate fresh code
    """
    
    def __init__(self, prefer_reuse: bool = True):
        self.prefer_reuse = prefer_reuse
    
    def should_try_reuse(
        self,
        step_type: StepType,
        step_complexity: str = "moderate"
    ) -> bool:
        """
        Decide if we should try to reuse code for this step
        
        Args:
            step_type: Type of step
            step_complexity: Complexity level
            
        Returns:
            bool: True if should try reuse
        """
        
        if self.prefer_reuse:
            # When preferring reuse, try for most steps
            # Only skip for very complex or unknown types
            if step_type == StepType.UNKNOWN:
                return False
            
            if step_complexity == "very_complex":
                return False
            
            return True
        
        else:
            # When not preferring reuse, only try for simple, common steps
            common_types = {
                StepType.DATA_LOADING,
                StepType.VALIDATION
            }
            
            if step_type in common_types and step_complexity in ["simple", "low"]:
                return True
            
            return False


# ============================================================================
# UTILITY FUNCTIONS
# ============================================================================

def analyze_step_complexity(step: Dict[str, Any]) -> str:
    """
    Analyze step complexity
    
    Returns:
        str: "simple", "moderate", "complex", or "very_complex"
    """
    
    # Check if complexity is provided
    if 'complexity' in step:
        return step['complexity']
    
    description = step.get('description', '')
    
    # Heuristics for complexity
    complexity_score = 0
    
    # Length of description
    if len(description) > 200:
        complexity_score += 2
    elif len(description) > 100:
        complexity_score += 1
    
    # Multiple operations (indicated by "and", "then")
    operations = description.lower().count('and') + description.lower().count('then')
    complexity_score += operations
    
    # Complex keywords
    complex_keywords = ['join', 'merge', 'pivot', 'reshape', 'correlation', 'regression']
    for keyword in complex_keywords:
        if keyword in description.lower():
            complexity_score += 1
    
    # Determine complexity level
    if complexity_score == 0:
        return "simple"
    elif complexity_score <= 2:
        return "moderate"
    elif complexity_score <= 4:
        return "complex"
    else:
        return "very_complex"


# ============================================================================
# EXAMPLE USAGE
# ============================================================================

if __name__ == '__main__':
    """
    Example usage of StepRouterNode
    """
    
    from config.settings import settings
    
    # Create router
    router = StepRouterNode(prefer_reuse=True)
    
    # Example 1: First step (data loading)
    shared = {
        'config': settings,
        'plan_steps': [
            {
                'id': 'step-1',
                'description': 'Load sales.parquet file',
                'type': 'data_loading'
            },
            {
                'id': 'step-2',
                'description': 'Calculate monthly revenue totals',
                'type': 'computation'
            }
        ],
        'current_step_index': 0,
        'step_results': []
    }
    
    prep_result = router.prep(shared)
    decision = router.exec(prep_result)
    next_node = router.post(shared, prep_result, decision)
    
    print(f"Step 1 Decision:")
    print(f"  Route: {decision.route.value}")
    print(f"  Next Node: {decision.next_node}")
    print(f"  Reasoning: {decision.reasoning}")
    print()
    
    # Example 2: Second step
    shared['current_step_index'] = 1
    shared['step_results'] = [{'step_id': 'step-1', 'success': True}]
    
    prep_result = router.prep(shared)
    decision = router.exec(prep_result)
    next_node = router.post(shared, prep_result, decision)
    
    print(f"Step 2 Decision:")
    print(f"  Route: {decision.route.value}")
    print(f"  Next Node: {decision.next_node}")
    print(f"  Reasoning: {decision.reasoning}")
    print()
    
    # Example 3: All steps complete
    shared['current_step_index'] = 2
    
    prep_result = router.prep(shared)
    decision = router.exec(prep_result)
    next_node = router.post(shared, prep_result, decision)
    
    print(f"Completion Decision:")
    print(f"  Route: {decision.route.value}")
    print(f"  Next Node: {decision.next_node}")
    print(f"  Reasoning: {decision.reasoning}")