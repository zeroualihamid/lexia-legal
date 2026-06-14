# nodes/generation/requirements_analysis_node.py

"""
Requirements Analysis Node
Analyzes natural language task descriptions and extracts structured requirements
for code generation.

This node transforms vague or incomplete task descriptions into detailed,
structured requirements that can be used for high-quality code generation.
"""

from typing import Dict, List, Any, Optional
from dataclasses import dataclass, field, asdict
from enum import Enum

from nodes.base_node import BaseNode
from llm.llm_factory import create_llm_client
from monitoring.logger import get_logger

logger = get_logger(__name__)


# ============================================================================
# DATA STRUCTURES
# ============================================================================

class ComplexityLevel(Enum):
    """Code complexity estimation"""
    SIMPLE = "simple"          # < 20 lines, single function
    MODERATE = "moderate"      # 20-50 lines, few functions
    COMPLEX = "complex"        # 50-100 lines, multiple functions
    VERY_COMPLEX = "very_complex"  # > 100 lines, classes/modules


class DataType(Enum):
    """Common data types in requirements"""
    STRING = "str"
    INTEGER = "int"
    FLOAT = "float"
    BOOLEAN = "bool"
    LIST = "list"
    DICT = "dict"
    DATAFRAME = "DataFrame"
    ARRAY = "np.ndarray"
    PATH = "Path"
    DATETIME = "datetime"
    ANY = "Any"


@dataclass
class InputSpec:
    """Specification for a single input parameter"""
    name: str
    type: str
    description: str
    required: bool = True
    default: Optional[Any] = None
    constraints: List[str] = field(default_factory=list)
    
    def to_dict(self) -> Dict:
        return asdict(self)
    
    def __str__(self) -> str:
        type_str = f"{self.name}: {self.type}"
        if self.default is not None:
            type_str += f" = {self.default}"
        return type_str


@dataclass
class OutputSpec:
    """Specification for expected output"""
    type: str
    description: str
    schema: Optional[Dict] = None  # For DataFrames, dicts, etc.
    
    def to_dict(self) -> Dict:
        return asdict(self)


@dataclass
class AnalyzedRequirements:
    """
    Structured requirements extracted from natural language description
    """
    # Core information
    task_summary: str
    core_functionality: str
    complexity: ComplexityLevel
    
    # Input/Output specifications
    inputs: List[InputSpec] = field(default_factory=list)
    outputs: List[OutputSpec] = field(default_factory=list)
    
    # Requirements and constraints
    functional_requirements: List[str] = field(default_factory=list)
    non_functional_requirements: List[str] = field(default_factory=list)
    constraints: List[str] = field(default_factory=list)
    
    # Edge cases and error handling
    edge_cases: List[str] = field(default_factory=list)
    error_conditions: List[str] = field(default_factory=list)
    
    # Technical details
    suggested_libraries: List[str] = field(default_factory=list)
    suggested_algorithms: List[str] = field(default_factory=list)
    
    # Metadata
    estimated_lines_of_code: int = 0
    estimated_complexity_score: float = 0.0  # 0-1 scale
    
    def to_dict(self) -> Dict:
        """Convert to dictionary for serialization"""
        return {
            'task_summary': self.task_summary,
            'core_functionality': self.core_functionality,
            'complexity': self.complexity.value,
            'inputs': [inp.to_dict() for inp in self.inputs],
            'outputs': [out.to_dict() for out in self.outputs],
            'functional_requirements': self.functional_requirements,
            'non_functional_requirements': self.non_functional_requirements,
            'constraints': self.constraints,
            'edge_cases': self.edge_cases,
            'error_conditions': self.error_conditions,
            'suggested_libraries': self.suggested_libraries,
            'suggested_algorithms': self.suggested_algorithms,
            'estimated_lines_of_code': self.estimated_lines_of_code,
            'estimated_complexity_score': self.estimated_complexity_score
        }


# ============================================================================
# MAIN NODE
# ============================================================================

class RequirementsAnalysisNode(BaseNode):
    """
    Analyze task requirements before code generation
    
    This node:
    1. Takes natural language task description
    2. Extracts structured requirements
    3. Identifies inputs, outputs, constraints
    4. Determines complexity level
    5. Suggests appropriate libraries and approaches
    6. Identifies edge cases and error conditions
    
    Benefits:
    - Better code generation (more context for LLM)
    - Clearer specifications
    - Proactive edge case handling
    - Complexity-appropriate solutions
    """
    
    def __init__(self, name: Optional[str] = None):
        super().__init__(name or "RequirementsAnalysis")
        self.parser = RequirementsParser()
    
    def prep(self, shared: Dict[str, Any]) -> Dict[str, Any]:
        """Prepare data for requirements analysis"""
        
        # Get task description from various possible sources
        description = (
            shared.get('step_description') or
            shared.get('task_description') or
            shared.get('requirements', {}).get('description') or
            shared.get('step_context', {}).get('description') or
            ""
        )
        
        if not description:
            logger.warning("No task description found in shared state")
        
        # Get additional context
        context = shared.get('step_context', {})
        
        # Get any pre-existing requirements
        existing_requirements = shared.get('requirements', {})
        
        return {
            'description': description,
            'context': context,
            'existing_requirements': existing_requirements
        }
    
    def exec(self, prep_result: Dict[str, Any]) -> AnalyzedRequirements:
        """Analyze requirements using LLM and structured parsing"""
        
        description = prep_result['description']
        context = prep_result['context']
        existing_reqs = prep_result['existing_requirements']
        
        if not description:
            logger.warning("Empty description, using minimal requirements")
            return self._create_minimal_requirements()
        
        logger.info(f"Analyzing requirements: '{description[:100]}...'")
        
        # Get LLM client
        config = self.get_config(shared)
        llm = create_llm_client(config)
        
        # Build analysis prompt
        prompt = self._build_analysis_prompt(description, context, existing_reqs)
        
        # Get LLM analysis
        logger.debug(f"Sending prompt to LLM ({len(prompt)} chars)")
        response = llm.generate(prompt)
        logger.debug(f"Received response from LLM ({len(response)} chars)")
        
        # Parse LLM response into structured requirements
        requirements = self.parser.parse_llm_response(response)
        
        # Enhance with additional analysis
        requirements = self._enhance_requirements(
            requirements, 
            description, 
            context
        )
        
        # Log summary
        self._log_requirements_summary(requirements)
        
        return requirements
    
    def post(
        self, 
        shared: Dict[str, Any], 
        prep_result: Dict[str, Any], 
        exec_result: AnalyzedRequirements
    ) -> str:
        """Store analyzed requirements and route to next node"""
        
        # Store in shared state
        shared['analyzed_requirements'] = exec_result.to_dict()
        
        # Also store as object for easier access
        shared['requirements_obj'] = exec_result
        
        logger.info(
            f"Requirements analysis complete. "
            f"Complexity: {exec_result.complexity.value}, "
            f"Inputs: {len(exec_result.inputs)}, "
            f"Edge cases: {len(exec_result.edge_cases)}"
        )
        
        return 'default'
    
    # ========================================================================
    # PRIVATE METHODS
    # ========================================================================
    
    def _build_analysis_prompt(
        self, 
        description: str, 
        context: Dict, 
        existing_reqs: Dict
    ) -> str:
        """Build comprehensive analysis prompt for LLM"""
        
        context_section = ""
        if context:
            context_section = "ADDITIONAL CONTEXT:\n"
            for key, value in context.items():
                if key not in ['description'] and value:
                    context_section += f"- {key}: {value}\n"
        
        existing_section = ""
        if existing_reqs:
            existing_section = "EXISTING REQUIREMENTS (incorporate these):\n"
            for key, value in existing_reqs.items():
                if value:
                    existing_section += f"- {key}: {value}\n"
        
        from prompt_loader import render_template
        prompt = render_template(
            "generation", "requirements_analysis",
            description=description,
            context_section=context_section,
            existing_section=existing_section,
        )
        return prompt
    
    def _enhance_requirements(
        self,
        requirements: AnalyzedRequirements,
        description: str,
        context: Dict
    ) -> AnalyzedRequirements:
        """Enhance requirements with additional analysis"""
        
        # Calculate complexity score
        requirements.estimated_complexity_score = self._calculate_complexity_score(
            requirements
        )
        
        # Add implicit requirements based on context
        if 'parquet' in description.lower() or 'parquet' in str(context).lower():
            if 'pandas' not in requirements.suggested_libraries:
                requirements.suggested_libraries.append('pandas')
            if 'pyarrow' not in requirements.suggested_libraries:
                requirements.suggested_libraries.append('pyarrow')
        
        # Add common error conditions if missing
        if not requirements.error_conditions:
            requirements.error_conditions = [
                'Invalid input types',
                'Missing required parameters',
                'Unexpected errors during execution'
            ]
        
        # Add standard edge cases if missing
        if not requirements.edge_cases:
            requirements.edge_cases = [
                'Empty inputs',
                'None values',
                'Very large inputs'
            ]
        
        return requirements
    
    def _calculate_complexity_score(
        self, 
        requirements: AnalyzedRequirements
    ) -> float:
        """
        Calculate complexity score (0-1) based on requirements
        
        Factors:
        - Number of inputs/outputs
        - Number of constraints
        - Number of edge cases
        - Estimated lines of code
        - Functional requirements count
        """
        
        score = 0.0
        
        # Input/output complexity (max 0.2)
        io_count = len(requirements.inputs) + len(requirements.outputs)
        score += min(io_count / 20.0, 0.2)
        
        # Requirements complexity (max 0.3)
        req_count = len(requirements.functional_requirements)
        score += min(req_count / 15.0, 0.3)
        
        # Edge cases and constraints (max 0.2)
        edge_count = len(requirements.edge_cases) + len(requirements.constraints)
        score += min(edge_count / 20.0, 0.2)
        
        # Code size estimate (max 0.3)
        loc = requirements.estimated_lines_of_code
        if loc > 0:
            score += min(loc / 200.0, 0.3)
        
        return min(score, 1.0)
    
    def _create_minimal_requirements(self) -> AnalyzedRequirements:
        """Create minimal requirements when description is missing"""
        
        return AnalyzedRequirements(
            task_summary="No description provided",
            core_functionality="Generate basic code structure",
            complexity=ComplexityLevel.SIMPLE,
            estimated_lines_of_code=10,
            estimated_complexity_score=0.1
        )
    
    def _log_requirements_summary(self, requirements: AnalyzedRequirements):
        """Log summary of analyzed requirements"""
        
        logger.info("=" * 60)
        logger.info("REQUIREMENTS ANALYSIS SUMMARY")
        logger.info("=" * 60)
        logger.info(f"Task: {requirements.task_summary}")
        logger.info(f"Complexity: {requirements.complexity.value}")
        logger.info(f"Inputs: {len(requirements.inputs)}")
        logger.info(f"Outputs: {len(requirements.outputs)}")
        logger.info(f"Constraints: {len(requirements.constraints)}")
        logger.info(f"Edge Cases: {len(requirements.edge_cases)}")
        logger.info(f"Estimated LOC: {requirements.estimated_lines_of_code}")
        logger.info(f"Complexity Score: {requirements.estimated_complexity_score:.2f}")
        
        if requirements.suggested_libraries:
            logger.info(f"Libraries: {', '.join(requirements.suggested_libraries)}")
        
        logger.info("=" * 60)


# ============================================================================
# REQUIREMENTS PARSER
# ============================================================================

class RequirementsParser:
    """
    Parse LLM response into structured AnalyzedRequirements
    """
    
    def parse_llm_response(self, response: str) -> AnalyzedRequirements:
        """Parse LLM response into structured requirements"""
        
        logger.debug("Parsing LLM response into structured requirements")
        
        lines = response.strip().split('\n')
        
        # Initialize with defaults
        data = {
            'task_summary': '',
            'core_functionality': '',
            'complexity': ComplexityLevel.MODERATE,
            'inputs': [],
            'outputs': [],
            'functional_requirements': [],
            'non_functional_requirements': [],
            'constraints': [],
            'edge_cases': [],
            'error_conditions': [],
            'suggested_libraries': [],
            'suggested_algorithms': [],
            'estimated_lines_of_code': 50
        }
        
        current_section = None
        
        for line in lines:
            line = line.strip()
            
            # Identify sections
            if line.upper().startswith('TASK_SUMMARY:'):
                data['task_summary'] = line.split(':', 1)[1].strip()
                continue
            
            elif line.upper().startswith('CORE_FUNCTIONALITY:'):
                data['core_functionality'] = line.split(':', 1)[1].strip()
                current_section = 'core_functionality'
                continue
            
            elif line.upper().startswith('COMPLEXITY:'):
                complexity_str = line.split(':', 1)[1].strip().lower()
                data['complexity'] = self._parse_complexity(complexity_str)
                continue
            
            elif line.upper().startswith('INPUTS:'):
                current_section = 'inputs'
                continue
            
            elif line.upper().startswith('OUTPUTS:'):
                current_section = 'outputs'
                continue
            
            elif line.upper().startswith('FUNCTIONAL_REQUIREMENTS:'):
                current_section = 'functional_requirements'
                continue
            
            elif line.upper().startswith('NON_FUNCTIONAL_REQUIREMENTS:'):
                current_section = 'non_functional_requirements'
                continue
            
            elif line.upper().startswith('CONSTRAINTS:'):
                current_section = 'constraints'
                continue
            
            elif line.upper().startswith('EDGE_CASES:'):
                current_section = 'edge_cases'
                continue
            
            elif line.upper().startswith('ERROR_CONDITIONS:'):
                current_section = 'error_conditions'
                continue
            
            elif line.upper().startswith('SUGGESTED_LIBRARIES:'):
                current_section = 'suggested_libraries'
                continue
            
            elif line.upper().startswith('SUGGESTED_ALGORITHMS:'):
                current_section = 'suggested_algorithms'
                continue
            
            elif line.upper().startswith('ESTIMATED_LINES_OF_CODE:'):
                try:
                    loc_str = line.split(':', 1)[1].strip()
                    data['estimated_lines_of_code'] = int(loc_str)
                except:
                    pass
                continue
            
            # Parse content based on current section
            if line.startswith('-') and current_section:
                content = line.lstrip('-').strip()
                
                if current_section == 'inputs':
                    input_spec = self._parse_input_spec(content)
                    if input_spec:
                        data['inputs'].append(input_spec)
                
                elif current_section == 'outputs':
                    output_spec = self._parse_output_spec(content)
                    if output_spec:
                        data['outputs'].append(output_spec)
                
                elif current_section == 'suggested_libraries':
                    # Format: library_name: reason
                    lib_name = content.split(':')[0].strip()
                    data['suggested_libraries'].append(lib_name)
                
                elif current_section in data and isinstance(data[current_section], list):
                    data[current_section].append(content)
            
            # Continuation of core_functionality
            elif current_section == 'core_functionality' and line and not line.startswith('-'):
                data['core_functionality'] += ' ' + line
        
        # Create AnalyzedRequirements object
        requirements = AnalyzedRequirements(
            task_summary=data['task_summary'],
            core_functionality=data['core_functionality'].strip(),
            complexity=data['complexity'],
            inputs=data['inputs'],
            outputs=data['outputs'],
            functional_requirements=data['functional_requirements'],
            non_functional_requirements=data['non_functional_requirements'],
            constraints=data['constraints'],
            edge_cases=data['edge_cases'],
            error_conditions=data['error_conditions'],
            suggested_libraries=data['suggested_libraries'],
            suggested_algorithms=data['suggested_algorithms'],
            estimated_lines_of_code=data['estimated_lines_of_code']
        )
        
        logger.debug(f"Parsed {len(requirements.inputs)} inputs, {len(requirements.outputs)} outputs")
        
        return requirements
    
    def _parse_complexity(self, complexity_str: str) -> ComplexityLevel:
        """Parse complexity string to enum"""
        
        complexity_map = {
            'simple': ComplexityLevel.SIMPLE,
            'moderate': ComplexityLevel.MODERATE,
            'complex': ComplexityLevel.COMPLEX,
            'very_complex': ComplexityLevel.VERY_COMPLEX,
            'very complex': ComplexityLevel.VERY_COMPLEX
        }
        
        return complexity_map.get(complexity_str, ComplexityLevel.MODERATE)
    
    def _parse_input_spec(self, spec_str: str) -> Optional[InputSpec]:
        """
        Parse input specification string
        Format: name: param_name, type: str, description: desc, required: yes, default: value
        """
        
        try:
            parts = {}
            for part in spec_str.split(','):
                if ':' in part:
                    key, value = part.split(':', 1)
                    parts[key.strip().lower()] = value.strip()
            
            if 'name' not in parts or 'type' not in parts:
                return None
            
            return InputSpec(
                name=parts['name'],
                type=parts['type'],
                description=parts.get('description', ''),
                required=(parts.get('required', 'yes').lower() in ['yes', 'true']),
                default=parts.get('default')
            )
        
        except Exception as e:
            logger.warning(f"Failed to parse input spec '{spec_str}': {e}")
            return None
    
    def _parse_output_spec(self, spec_str: str) -> Optional[OutputSpec]:
        """
        Parse output specification string
        Format: type: DataFrame, description: desc, schema: {col1: type1, col2: type2}
        """
        
        try:
            parts = {}
            for part in spec_str.split(','):
                if ':' in part:
                    key, value = part.split(':', 1)
                    parts[key.strip().lower()] = value.strip()
            
            if 'type' not in parts:
                return None
            
            return OutputSpec(
                type=parts['type'],
                description=parts.get('description', ''),
                schema=None  # TODO: Parse schema if provided
            )
        
        except Exception as e:
            logger.warning(f"Failed to parse output spec '{spec_str}': {e}")
            return None


# ============================================================================
# UTILITY FUNCTIONS
# ============================================================================

def validate_requirements(requirements: AnalyzedRequirements) -> tuple[bool, List[str]]:
    """
    Validate that requirements are complete enough for code generation
    
    Returns:
        (is_valid, list_of_issues)
    """
    
    issues = []
    
    if not requirements.task_summary:
        issues.append("Missing task summary")
    
    if not requirements.core_functionality:
        issues.append("Missing core functionality description")
    
    if not requirements.inputs and not requirements.outputs:
        issues.append("No inputs or outputs specified (code might not do anything useful)")
    
    if len(requirements.functional_requirements) == 0:
        issues.append("No functional requirements specified")
    
    return (len(issues) == 0, issues)


def format_requirements_for_display(requirements: AnalyzedRequirements) -> str:
    """Format requirements as readable text"""
    
    output = []
    output.append("=" * 70)
    output.append("REQUIREMENTS ANALYSIS")
    output.append("=" * 70)
    output.append(f"\nTask: {requirements.task_summary}")
    output.append(f"Complexity: {requirements.complexity.value}")
    output.append(f"\nCore Functionality:\n{requirements.core_functionality}")
    
    if requirements.inputs:
        output.append(f"\nInputs:")
        for inp in requirements.inputs:
            output.append(f"  - {inp}")
    
    if requirements.outputs:
        output.append(f"\nOutputs:")
        for out in requirements.outputs:
            output.append(f"  - {out.type}: {out.description}")
    
    if requirements.constraints:
        output.append(f"\nConstraints:")
        for constraint in requirements.constraints:
            output.append(f"  - {constraint}")
    
    if requirements.edge_cases:
        output.append(f"\nEdge Cases:")
        for case in requirements.edge_cases:
            output.append(f"  - {case}")
    
    output.append("=" * 70)
    
    return '\n'.join(output)