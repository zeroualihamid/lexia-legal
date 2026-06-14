# nodes/generation/requirements_analysis_node.py
"""
Requirements Analysis Node
Analyzes step requirements before code generation.
"""
from typing import Dict, Any, List
from dataclasses import dataclass, field
from monitoring.logger import get_logger

logger = get_logger(__name__)


@dataclass
class StepRequirements:
    """Structured requirements for a code generation step"""
    step_id: str
    description: str
    inputs: List[Dict[str, str]] = field(default_factory=list)
    outputs: List[Dict[str, str]] = field(default_factory=list)
    constraints: List[str] = field(default_factory=list)
    dependencies: List[str] = field(default_factory=list)
    libraries: List[str] = field(default_factory=list)
    complexity: str = "moderate"  # simple | moderate | complex
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict:
        return {k: v for k, v in self.__dict__.items()}


class RequirementsAnalysisNode:
    """
    Analyzes requirements before code generation.

    Extracts inputs, outputs, libraries, constraints, dependencies.

    Routes:
    - default: Requirements ready
    - insufficient: Not enough info to generate
    """

    def __init__(self):
        self.name = "RequirementsAnalysis"

    def prep(self, shared: Dict) -> Dict:
        return {
            'step': shared.get('current_step', {}),
            'all_steps': shared.get('plan_steps', []),
            'augmented_query': shared.get('augmented_query', {}),
            'completed_steps': shared.get('completed_steps', []),
            'session_id': shared.get('session_id', ''),
        }

    def exec(self, prep_result: Dict) -> StepRequirements:
        step = prep_result['step']
        all_steps = prep_result['all_steps']
        step_id = step.get('id', 'step-0')
        description = step.get('description', '')

        logger.info(f"Analyzing requirements for: {step_id}")

        inputs = self._extract_inputs(step, all_steps)
        outputs = self._extract_outputs(step)
        libraries = self._infer_libraries(description, inputs, outputs)
        constraints = self._extract_constraints(step, prep_result['augmented_query'])
        dependencies = self._find_dependencies(step, all_steps)
        complexity = self._estimate_complexity(inputs, outputs, description)

        return StepRequirements(
            step_id=step_id,
            description=description,
            inputs=inputs,
            outputs=outputs,
            constraints=constraints,
            dependencies=dependencies,
            libraries=libraries,
            complexity=complexity,
            metadata={'session_id': prep_result['session_id']}
        )

    def post(self, shared: Dict, prep_result: Dict, exec_result: StepRequirements) -> str:
        shared['step_requirements'] = exec_result.to_dict()
        if not exec_result.description:
            logger.warning("Insufficient requirements")
            return 'insufficient'
        logger.info(
            f"Requirements ready: inputs={len(exec_result.inputs)}, "
            f"outputs={len(exec_result.outputs)}, complexity={exec_result.complexity}"
        )
        return 'default'

    def _extract_inputs(self, step: Dict, all_steps: List[Dict]) -> List[Dict[str, str]]:
        inputs = []
        for inp in step.get('inputs', []):
            if isinstance(inp, str):
                name, *rest = inp.split(':')
                inputs.append({'name': name.strip(), 'type': rest[0].strip() if rest else 'Any', 'source': 'declared'})
            elif isinstance(inp, dict):
                inputs.append({**{'source': 'declared'}, **inp})

        step_idx = next((i for i, s in enumerate(all_steps) if s.get('id') == step.get('id')), -1)
        for prev in all_steps[:step_idx]:
            for out in prev.get('outputs', []):
                if isinstance(out, str):
                    name, *rest = out.split(':')
                    inputs.append({'name': name.strip(), 'type': rest[0].strip() if rest else 'Any',
                                   'source': f"step_{prev.get('id')}"})
        return inputs

    def _extract_outputs(self, step: Dict) -> List[Dict[str, str]]:
        outputs = []
        for out in step.get('outputs', []):
            if isinstance(out, str):
                name, *rest = out.split(':')
                outputs.append({'name': name.strip(), 'type': rest[0].strip() if rest else 'Any'})
            elif isinstance(out, dict):
                outputs.append(out)
        return outputs

    def _infer_libraries(self, description: str, inputs: list, outputs: list) -> List[str]:
        text = description.lower()
        libs = set()
        patterns = {
            'pandas': ['dataframe', 'csv', 'parquet', 'excel', 'groupby', 'merge'],
            'numpy': ['array', 'matrix', 'numerical', 'vector'],
            'pyarrow': ['parquet', 'arrow'],
            'pathlib': ['file', 'path', 'directory'],
            'json': ['json'],
            'datetime': ['date', 'time', 'timestamp'],
            'matplotlib': ['plot', 'chart', 'graph'],
            'sklearn': ['model', 'train', 'predict', 'classification'],
        }
        for lib, keywords in patterns.items():
            if any(kw in text for kw in keywords):
                libs.add(lib)
        return sorted(libs)

    def _extract_constraints(self, step: Dict, augmented_query: Dict) -> List[str]:
        constraints = list(step.get('constraints', []))
        reqs = augmented_query.get('requirements', {})
        if isinstance(reqs, dict):
            for key, val in reqs.items():
                if 'constraint' in key.lower() and val:
                    constraints.append(str(val))
        return constraints

    def _find_dependencies(self, step: Dict, all_steps: List[Dict]) -> List[str]:
        explicit = list(step.get('dependencies', []))
        step_idx = next((i for i, s in enumerate(all_steps) if s.get('id') == step.get('id')), -1)
        if step_idx > 0:
            prev_id = all_steps[step_idx - 1].get('id')
            if prev_id and prev_id not in explicit:
                explicit.append(prev_id)
        return explicit

    def _estimate_complexity(self, inputs: list, outputs: list, description: str) -> str:
        score = len(inputs) + len(outputs)
        if any(kw in description.lower() for kw in ['ml', 'model', 'train', 'optimize']):
            score += 5
        return 'simple' if score <= 2 else 'complex' if score > 6 else 'moderate'
